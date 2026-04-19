#!/usr/bin/env node
//
// examples/ladder-swap.mjs — demonstrate value threading (Tranche 2):
// `save_result` + `args_template` let step N+1's args reference step N's
// return bytes at dispatch time.
//
// Mechanism: each `Step` may carry:
//
//   - `save_result = { as_name, kind }` — on successful resolution, the
//     kernel saves the step's promise-result bytes (as returned by
//     `promise_result_checked(0, MAX_CALLBACK_RESULT_BYTES)`) into the
//     sequence context under `as_name`.
//
//   - `args_template = { template, substitutions }` — the kernel
//     materializes the step's real args at dispatch time by running
//     each `Substitution` against the sequence context, then uses the
//     produced bytes as the `FunctionCall`'s args.
//
//   - `SubstitutionOp` — `Raw` (splice verbatim), `DivU128 {denominator}`,
//     `PercentU128 {bps}` (bps/10_000 of a u128).
//
// Ladder-swap interpretation: step N returns a balance / quote /
// allowance; step N+1 fires against the SAME protocol with an amount
// derived from step N's return. Without value threading, you'd need
// two user signatures or an off-chain read-then-sign loop.
//
// For testnet without `intents.near` we emulate the mechanism against
// `pathological-router.x.mike.testnet` — its `do_honest_work(label)`
// and `get_calls_completed()` methods give us a predictable numeric
// surface. The flagship's purpose is to prove the events trace emits
// `result_saved` + the downstream step's args end up materialized from
// that saved value.
//
// Default plan (3 steps):
//   1. do_honest_work(label="prime-<runId>")  — no save
//   2. get_calls_completed()                   — SAVE as "counter"
//   3. do_honest_work(label=<half of counter>) — args_template with
//      `PercentU128 { bps: 5000 }` on `counter`
//
// After execution:
//   - calls_completed increments by 2 (steps 1 and 3; step 2 is &self)
//   - last_burst == "<half of counter-at-step-2>" as a STRING
//   - sequence_contexts[namespace] == null (cleared on completion)
//   - structured events: step_resolved_ok x3, result_saved, sequence_completed
//
// Usage:
//   ./examples/ladder-swap.mjs --signer x.mike.testnet --smart-account sa-threading.x.mike.testnet
//
//   # Dry run (print the plan, don't submit):
//   ./examples/ladder-swap.mjs --signer x.mike.testnet --smart-account sa-threading.x.mike.testnet --dry

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
import { extractBlockInfo, flattenReceiptTree, traceTx } from "../scripts/lib/trace-rpc.mjs";

const NETWORK = process.env.NETWORK || "testnet";
const PROBE_CONTRACT_DEFAULT = "pathological-router.x.mike.testnet";

const { values } = parseArgs({
  options: {
    signer: { type: "string" },
    "smart-account": { type: "string" },
    "probe-contract": { type: "string", default: PROBE_CONTRACT_DEFAULT },
    // Ladder shape: what fraction of the captured counter to splice into
    // step 3's label. Basis points — 5000 = 50%, 10000 = 100%.
    "ladder-bps": { type: "string", default: "5000" },
    "step-gas-tgas": { type: "string", default: "40" },
    "action-gas-tgas": { type: "string", default: "400" },
    "poll-ms": { type: "string", default: "2000" },
    "resolve-timeout-ms": { type: "string", default: "120000" },
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

const signer = values.signer;
const smartAccount = values["smart-account"];
const probeContract = values["probe-contract"];
const ladderBps = parsePositiveInt(values["ladder-bps"], "--ladder-bps");
if (ladderBps > 10000) {
  throw new Error("--ladder-bps must be in [1, 10000]");
}
const stepGasTgas = parsePositiveInt(values["step-gas-tgas"], "--step-gas-tgas");
const actionGasTgas = parsePositiveInt(values["action-gas-tgas"], "--action-gas-tgas");
const pollMs = parsePositiveInt(values["poll-ms"], "--poll-ms");
const resolveTimeoutMs = parsePositiveInt(
  values["resolve-timeout-ms"],
  "--resolve-timeout-ms"
);

const runId = new Date().toISOString().replace(/[:.-]/g, "").slice(0, 14);
const primeLabel = `ladder-prime-${runId}`;

// Step 1: do_honest_work("prime-<runId>"). No save; just primes the
// counter so step 2's snapshot is non-zero on first run. `policy` is
// omitted so it defaults to Direct (the enum's `#[default]` variant —
// serde treats unit variants as bare strings, so explicit `"Direct"`
// also works, but omitting is cleanest).
const step1 = {
  step_id: `ladder-step1-${runId}`,
  target_id: probeContract,
  method_name: "do_honest_work",
  args: base64Utf8(JSON.stringify({ label: primeLabel })),
  attached_deposit_yocto: "0",
  gas_tgas: stepGasTgas,
};

// Step 2: get_calls_completed(). Save return as "counter".
// The view is `&self` — no state mutation. Returns bare u32 JSON
// (e.g., `5`), which is parseable as u128 via `strip_outer_json_quotes`.
const step2 = {
  step_id: `ladder-step2-${runId}`,
  target_id: probeContract,
  method_name: "get_calls_completed",
  args: base64Utf8("{}"),
  attached_deposit_yocto: "0",
  gas_tgas: stepGasTgas,
  save_result: {
    as_name: "counter",
    kind: "U128Json",
  },
};

// Step 3: do_honest_work(label=<bps/10000 of counter>). Template +
// substitution derive the label at dispatch time.
//
// Template is JSON with a placeholder `"${counter}"` where the STRING
// value will land. `PercentU128` emits JSON-string-quoted u128
// (e.g. "3") — which is a valid `label: String` for do_honest_work.
const step3Template = `{"label":"\${counter}"}`;
const step3 = {
  step_id: `ladder-step3-${runId}`,
  target_id: probeContract,
  method_name: "do_honest_work",
  // `args` is ignored when `args_template` is set. We still supply a
  // placeholder so the types round-trip cleanly for callers inspecting
  // the submitted plan.
  args: base64Utf8(step3Template),
  attached_deposit_yocto: "0",
  gas_tgas: stepGasTgas,
  args_template: {
    template: base64Utf8(step3Template),
    substitutions: [
      {
        reference: "counter",
        op: { PercentU128: { bps: ladderBps } },
      },
    ],
  },
};

const plan = [step1, step2, step3];

console.log("ladder-swap demo — plan (3 steps, value threading)");
console.log("  smart account :", smartAccount);
console.log("  signer        :", signer);
console.log("  probe contract:", probeContract);
console.log("  runId         :", runId);
console.log("  step 1        :", `${probeContract}.do_honest_work(label="${primeLabel}")`);
console.log("  step 2        :", `${probeContract}.get_calls_completed()  [SAVE as "counter"]`);
console.log(
  "  step 3        :",
  `${probeContract}.do_honest_work(label=<${ladderBps}bps of counter>)`
);

// Probe current counter for prediction — advisory only; the on-chain
// snapshot (taken mid-sequence) is the authoritative read.
let preCounter = null;
try {
  const probe = await callViewMethod(NETWORK, probeContract, "get_calls_completed", {});
  preCounter = probe.value;
  console.log("  counter now   :", preCounter);
  // After step 1 fires, counter will be preCounter+1.
  const snapshotPrediction = Number(preCounter) + 1;
  const derivedPrediction = Math.floor((snapshotPrediction * ladderBps) / 10000);
  console.log(
    "  predicted     :",
    `step-2 snapshot=${snapshotPrediction}, step-3 label="${derivedPrediction}"`
  );
} catch (e) {
  console.log("  counter now   : (view failed:", e.message, ")");
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
  Buffer.from(JSON.stringify({ steps: plan })),
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

const counterAfter = await callViewMethod(NETWORK, probeContract, "get_calls_completed", {})
  .then((r) => r.value)
  .catch(() => null);
const lastBurstAfter = await callViewMethod(NETWORK, probeContract, "get_last_burst", {})
  .then((r) => r.value)
  .catch(() => null);

const structuredEvents = trace ? extractThreadingEvents(trace) : [];

const artifact = {
  schema_version: 1,
  run_id: runId,
  short_hash: shortHash(txHash),
  tx_hash: txHash,
  block_info: extractBlockInfo(trace),
  network: NETWORK,
  smart_account: smartAccount,
  signer,
  ladder_bps: ladderBps,
  plan,
  pre_counter: preCounter,
  counter_after: counterAfter,
  last_burst_after: lastBurstAfter,
  outcome: finalOutcome,
  structured_events: structuredEvents,
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
console.log("  counter       :", preCounter, "→", counterAfter);
console.log("  last_burst    :", lastBurstAfter);
if (structuredEvents.length) {
  console.log("\nkey events:");
  for (const ev of structuredEvents) {
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

function parsePositiveInt(raw, flag) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return value;
}

function extractThreadingEvents(trace) {
  const out = [];
  if (!trace?.tree) return out;
  const receipts = flattenReceiptTree(trace.tree);
  for (const r of receipts) {
    for (const log of r.logs ?? []) {
      if (!log.startsWith("EVENT_JSON:")) continue;
      const body = log.slice("EVENT_JSON:".length);
      try {
        const ev = JSON.parse(body);
        if (
          ev.event === "step_resolved_ok" ||
          ev.event === "step_resolved_err" ||
          ev.event === "result_saved" ||
          ev.event === "sequence_halted" ||
          ev.event === "sequence_completed"
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
  const events = extractThreadingEvents(trace);
  if (events.some((e) => e.event === "sequence_completed")) return "completed";
  if (events.some((e) => e.event === "sequence_halted")) return "halted";
  return null;
}
