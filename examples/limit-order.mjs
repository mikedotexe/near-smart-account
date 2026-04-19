#!/usr/bin/env node
//
// examples/limit-order.mjs — demonstrate the `PreGate` pre-dispatch
// gate policy on a smart-account step.
//
// Mechanism: each `Step` can carry an optional `pre_gate` block that
// names a `FunctionCall` the kernel fires BEFORE dispatching the real
// target. If the gate's returned bytes sit inside `[min_bytes, max_bytes]`
// (under `comparison`), the kernel dispatches the target and chains the
// usual `on_step_resolved` callback. Out of range, or gate panic → the
// kernel halts the sequence cleanly before the target ever fires.
//
// Use case: limit orders. One signed plan says "execute this swap, but
// ONLY if the quoted price is within [min, max]." Out-of-range halts
// without market exposure.
//
// This flagship uses `pathological-router.x.mike.testnet.get_calls_completed`
// as a predictable gate view — returns a bare u32 counter. Target is
// `pathological-router.do_honest_work(label)` which increments the
// counter as a side effect.
//
// Pass scenario: gate bounds permit the current counter value → target
// fires, counter increments, sequence completes.
//
// Fail scenario: gate bounds exclude the current counter value →
// kernel halts with `pre_gate_checked.outcome != "in_range"`, target
// does NOT fire, counter does NOT increment. Verified via view call.
//
// Usage:
//   ./examples/limit-order.mjs \
//     --signer x.mike.testnet \
//     --smart-account sa-pregate.x.mike.testnet
//
//   # Force the gate to fail (current counter below a very high min):
//   ./examples/limit-order.mjs \
//     --signer x.mike.testnet \
//     --smart-account sa-pregate.x.mike.testnet \
//     --gate-min 999999999
//
//   # Dry run (print the plan, don't submit):
//   ./examples/limit-order.mjs \
//     --signer x.mike.testnet \
//     --smart-account sa-pregate.x.mike.testnet \
//     --dry

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { REPO_ROOT, shortHash, sleep } from "../scripts/lib/fastnear.mjs";
import {
  callViewMethod,
  connectNearWithSigners,
  sendTransactionAsync,
} from "../scripts/lib/near-cli.mjs";
import { flattenReceiptTree, traceTx } from "../scripts/lib/trace-rpc.mjs";
import { renderStepOutcomeSummary } from "../scripts/lib/step-sequence.mjs";

const NETWORK = "testnet";
const GATE_CONTRACT_DEFAULT = "pathological-router.x.mike.testnet";
const TARGET_CONTRACT_DEFAULT = "pathological-router.x.mike.testnet";
const { values } = parseArgs({
  options: {
    signer: { type: "string" },
    "smart-account": { type: "string" },
    // Gate surface. Defaults to a scriptable testnet oracle that
    // returns a bare u32 counter.
    "gate-contract": { type: "string", default: GATE_CONTRACT_DEFAULT },
    "gate-method": { type: "string", default: "get_calls_completed" },
    "gate-args-json": { type: "string", default: "{}" },
    // Bounds. Bare number strings (no quotes). Either may be omitted.
    "gate-min": { type: "string" },
    "gate-max": { type: "string" },
    "gate-gas-tgas": { type: "string", default: "30" },
    // Target (the "real work" the gate guards).
    "target-contract": { type: "string", default: TARGET_CONTRACT_DEFAULT },
    "target-method": { type: "string", default: "do_honest_work" },
    "target-args-json": { type: "string", default: '{"label":"limit-order-demo"}' },
    "target-gas-tgas": { type: "string", default: "40" },
    // Execution knobs.
    "action-gas-tgas": { type: "string", default: "400" },
    "poll-ms": { type: "string", default: "2000" },
    "resolve-timeout-ms": { type: "string", default: "120000" },
    // Output.
    "artifacts-file": { type: "string" },
    dry: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (!values.signer) {
  throw new Error("--signer is required (e.g. --signer x.mike.testnet)");
}
if (!values["smart-account"]) {
  throw new Error("--smart-account is required");
}
if (!values["gate-min"] && !values["gate-max"]) {
  throw new Error("at least one of --gate-min or --gate-max is required");
}

const signer = values.signer;
const smartAccount = values["smart-account"];
const gateContract = values["gate-contract"];
const gateMethod = values["gate-method"];
const gateArgsJson = values["gate-args-json"];
const gateMin = values["gate-min"] ?? null;
const gateMax = values["gate-max"] ?? null;
const gateGasTgas = parsePositiveInt(values["gate-gas-tgas"], "--gate-gas-tgas");
const targetContract = values["target-contract"];
const targetMethod = values["target-method"];
const targetArgsJson = values["target-args-json"];
const targetGasTgas = parsePositiveInt(values["target-gas-tgas"], "--target-gas-tgas");
const actionGasTgas = parsePositiveInt(values["action-gas-tgas"], "--action-gas-tgas");
const pollMs = parsePositiveInt(values["poll-ms"], "--poll-ms");
const resolveTimeoutMs = parsePositiveInt(
  values["resolve-timeout-ms"],
  "--resolve-timeout-ms"
);

const runId = new Date().toISOString().replace(/[:.-]/g, "").slice(0, 14);
const stepId = `limit-order-${runId}`;

const plan = {
  step_id: stepId,
  target_id: targetContract,
  method_name: targetMethod,
  args: base64Utf8(targetArgsJson),
  attached_deposit_yocto: "0",
  gas_tgas: targetGasTgas,
  // policy omitted → Direct (enum's `#[default]` variant). Serde
  // encodes unit variants as bare strings, so explicit `"Direct"` also
  // works; sending `{"Direct":{}}` does NOT — it hits the struct-shape
  // deserializer and panics with `invalid type: map, expected unit`.
  pre_gate: {
    gate_id: gateContract,
    gate_method: gateMethod,
    gate_args: base64Utf8(gateArgsJson),
    min_bytes: gateMin !== null ? base64Utf8(gateMin) : null,
    max_bytes: gateMax !== null ? base64Utf8(gateMax) : null,
    comparison: "U128Json",
    gate_gas_tgas: gateGasTgas,
  },
};

console.log("limit-order demo — plan");
console.log("  smart account :", smartAccount);
console.log("  signer        :", signer);
console.log("  step_id       :", stepId);
console.log("  gate          :", `${gateContract}.${gateMethod}(${gateArgsJson})`);
console.log("  gate bounds   :", `min=${gateMin ?? "-∞"} max=${gateMax ?? "+∞"}`);
console.log("  target        :", `${targetContract}.${targetMethod}(${targetArgsJson})`);

// Probe the gate before submitting so the operator sees what the kernel
// will see. This is advisory — the on-chain gate call is still the
// authoritative read.
try {
  const probe = await callViewMethod(NETWORK, gateContract, gateMethod, safeParseJson(gateArgsJson));
  const probeStr = typeof probe.value === "string" ? probe.value : JSON.stringify(probe.value);
  console.log("  gate probe    :", probeStr);
  const expectedOutcome = predictOutcome(probe.value, gateMin, gateMax);
  console.log("  predicted     :", expectedOutcome);
} catch (e) {
  console.log("  gate probe    : (view call failed:", e.message, ")");
}

if (values.dry) {
  console.log("\n(dry run — not submitting)");
  process.exit(0);
}

const { nearApi, accounts } = await connectNearWithSigners(NETWORK, [signer]);
const account = accounts[signer];

console.log("\nsubmitting execute_steps …");
const functionCall = nearApi.transactions.functionCall(
  "execute_steps",
  Buffer.from(JSON.stringify({ steps: [plan] })),
  BigInt(actionGasTgas) * 10n ** 12n,
  0n
);

const result = await sendTransactionAsync(account, smartAccount, [functionCall]);
const txHash = result.transaction.hash;
console.log("submitted:", txHash);

console.log("\npolling for resolution …");
const deadline = Date.now() + resolveTimeoutMs;
let trace = null;
let finalOutcome = null;
while (Date.now() < deadline) {
  await sleep(pollMs);
  try {
    trace = await traceTx(NETWORK, txHash, signer, "FINAL");
  } catch (e) {
    continue;
  }
  finalOutcome = deriveOutcome(trace);
  if (finalOutcome === "completed" || finalOutcome === "halted") break;
}

const counterAfter = await callViewMethod(NETWORK, gateContract, gateMethod, safeParseJson(gateArgsJson))
  .then((r) => r.value)
  .catch(() => null);

const artifact = {
  schema_version: 1,
  run_id: runId,
  short_hash: shortHash(txHash),
  tx_hash: txHash,
  network: NETWORK,
  smart_account: smartAccount,
  signer,
  plan,
  gate: {
    contract: gateContract,
    method: gateMethod,
    args_json: gateArgsJson,
    min: gateMin,
    max: gateMax,
  },
  outcome: finalOutcome,
  gate_value_after: counterAfter,
  structured_events: trace ? extractPreGateEvents(trace) : [],
  step_outcome_summary: trace
    ? renderStepOutcomeSummary({ trace, stepId, namespace: `manual:${signer}` })
    : null,
};

if (values.json) {
  process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
}

if (values["artifacts-file"]) {
  const outPath = path.isAbsolute(values["artifacts-file"])
    ? values["artifacts-file"]
    : path.join(REPO_ROOT, values["artifacts-file"]);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2));
  console.log("\nartifact written:", outPath);
}

console.log("\nresult:", finalOutcome ?? "unknown");
if (artifact.structured_events.length) {
  for (const ev of artifact.structured_events) {
    console.log(`  ${ev.event}:`, JSON.stringify(ev.data));
  }
}
if (finalOutcome === "halted") {
  process.exit(2);
}

// ---------- helpers ----------

function base64Utf8(str) {
  return Buffer.from(str, "utf8").toString("base64");
}

function safeParseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function parsePositiveInt(raw, flag) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return value;
}

function predictOutcome(actual, min, max) {
  const actualNum = Number(typeof actual === "string" ? actual.replace(/"/g, "") : actual);
  if (!Number.isFinite(actualNum)) return "unknown (gate returns non-numeric)";
  if (min !== null && actualNum < Number(min)) return `below_min (${actualNum} < ${min})`;
  if (max !== null && actualNum > Number(max)) return `above_max (${actualNum} > ${max})`;
  return `in_range (gate will pass)`;
}

function extractPreGateEvents(trace) {
  const out = [];
  if (!trace?.tree) return out;
  for (const r of flattenReceiptTree(trace.tree)) {
    for (const log of r.logs ?? []) {
      if (!log.startsWith("EVENT_JSON:")) continue;
      const body = log.slice("EVENT_JSON:".length);
      try {
        const ev = JSON.parse(body);
        if (
          ev.event === "pre_gate_checked" ||
          ev.event === "sequence_halted" ||
          ev.event === "sequence_completed" ||
          ev.event === "step_resolved_ok"
        ) {
          out.push(ev);
        }
      } catch {
        // ignore
      }
    }
  }
  return out;
}

function deriveOutcome(trace) {
  const events = extractPreGateEvents(trace);
  if (events.some((e) => e.event === "sequence_completed")) return "completed";
  if (
    events.some(
      (e) =>
        e.event === "sequence_halted" ||
        (e.event === "pre_gate_checked" && e.data?.matched === false)
    )
  )
    return "halted";
  if (events.some((e) => e.event === "step_resolved_ok")) return "completed";
  return null;
}
