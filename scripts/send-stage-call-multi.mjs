#!/usr/bin/env node
//
// scripts/send-stage-call-multi.mjs — generic multi-target stage_call helper.
// Each positional argument is a JSON object describing one stage_call action.
// Submits a single multi-action tx so all yielded callbacks land on the same
// receipt tree (per chapters 02–08).
//
// This is the canonical helper for submitting staged batches in new work.
// It supersedes the narrower send-staged-echo-demo.mjs / send-staged-mixed-demo.mjs
// (which are kept only so their chapter recipes remain reproducible).
//
// Spec shape:
//   {
//     "step_id":         "register",                       // required
//     "target":        "wrap.testnet",                   // required
//     "method":        "storage_deposit",                // required
//     "args":          {},                               // optional, defaults to {}
//     "deposit_yocto": "1250000000000000000000",         // optional, defaults to "0"
//     "gas_tgas":      50                                // optional, defaults to --call-gas
//   }
//
// Usage:
//   ./scripts/send-stage-call-multi.mjs \
//     '{"step_id":"register","target":"wrap.testnet","method":"storage_deposit","args":{},"deposit_yocto":"1250000000000000000000","gas_tgas":50}' \
//     '{"step_id":"deposit_a","target":"wrap.testnet","method":"near_deposit","args":{},"deposit_yocto":"10000000000000000000000","gas_tgas":30}' \
//     --action-gas 250

import process from "node:process";
import { parseArgs } from "node:util";
import { shortHash } from "./lib/fastnear.mjs";
import { connectNearWithSigners, sendTransactionAsync } from "./lib/near-cli.mjs";
import {
  diagnoseStageTransaction,
  getMainnetStageGasGuidance,
  renderStageOutcomeSummary,
} from "./lib/staged-sequence.mjs";

const MAX_TX_GAS_TGAS = 1_000;

const { values, positionals } = parseArgs({
  options: {
    network: { type: "string", default: "testnet" },
    signer: { type: "string", default: "mike.testnet" },
    contract: { type: "string", default: "smart-account.x.mike.testnet" },
    "action-gas": { type: "string", default: "250" },
    "call-gas": { type: "string", default: "30" },
    "sequence-order": { type: "string" },
    "poll-ms": { type: "string", default: "1000" },
    "stage-timeout-ms": { type: "string", default: "15000" },
    dry: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
  allowPositionals: true,
});

if (!positionals.length) {
  console.error("usage: send-stage-call-multi.mjs '<spec-json>' '<spec-json>' ... [--action-gas 250] [--call-gas 30] [--dry]");
  console.error("each spec must be a JSON object with step_id/target/method, plus optional args/deposit_yocto/gas_tgas");
  process.exit(1);
}

const actionGasTgas = Number(values["action-gas"]);
const defaultCallGasTgas = Number(values["call-gas"]);
const pollMs = Number(values["poll-ms"]);
const stageTimeoutMs = Number(values["stage-timeout-ms"]);
if (!Number.isFinite(actionGasTgas) || actionGasTgas <= 0) throw new Error("--action-gas must be positive");
if (!Number.isFinite(defaultCallGasTgas) || defaultCallGasTgas <= 0) throw new Error("--call-gas must be positive");
if (!Number.isFinite(pollMs) || pollMs <= 0) throw new Error("--poll-ms must be positive");
if (!Number.isFinite(stageTimeoutMs) || stageTimeoutMs < 0) throw new Error("--stage-timeout-ms must be zero or positive");

const specs = positionals.map((raw, i) => {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`spec #${i} is not valid JSON: ${e.message}`);
  }
  if (typeof parsed !== "object" || parsed === null) throw new Error(`spec #${i} must be a JSON object`);
  for (const k of ["step_id", "target", "method"]) {
    if (typeof parsed[k] !== "string" || !parsed[k]) throw new Error(`spec #${i} missing required string '${k}'`);
  }
  return {
    step_id: parsed.step_id,
    target: parsed.target,
    method: parsed.method,
    args: parsed.args ?? {},
    deposit_yocto: parsed.deposit_yocto ?? "0",
    gas_tgas: Number(parsed.gas_tgas ?? defaultCallGasTgas),
  };
});
assertUniqueStepIds(specs.map((spec) => spec.step_id), "submitted actions");

const totalActionGasTgas = actionGasTgas * specs.length;
if (totalActionGasTgas > MAX_TX_GAS_TGAS) {
  throw new Error(`requested ${totalActionGasTgas} TGas across ${specs.length} actions; keep ≤ ${MAX_TX_GAS_TGAS}`);
}
const mainnetGasGuidance = getMainnetStageGasGuidance({
  network: values.network,
  actionCount: specs.length,
  actionGasTgas,
});

const sequenceOrder = values["sequence-order"]
  ? values["sequence-order"].split(",").map((l) => l.trim()).filter(Boolean)
  : specs.map((s) => s.step_id);
validateSequenceOrder(specs, sequenceOrder);

if (values.dry) {
  console.log(JSON.stringify({
    network: values.network, signer: values.signer, receiver: values.contract,
    action_gas_tgas: actionGasTgas, total_action_gas_tgas: totalActionGasTgas,
    poll_ms: pollMs, stage_timeout_ms: stageTimeoutMs,
    guidance: mainnetGasGuidance,
    sequence_order: sequenceOrder,
    actions: specs,
  }, null, 2));
  process.exit(0);
}
const { nearApi, accounts } = await connectNearWithSigners(values.network, [values.signer]);
const account = accounts[values.signer];
const actions = specs.map((s) =>
  nearApi.transactions.functionCall(
    "stage_call",
    Buffer.from(JSON.stringify({
      target_id: s.target,
      method_name: s.method,
      args: Buffer.from(JSON.stringify(s.args)).toString("base64"),
      attached_deposit_yocto: s.deposit_yocto,
      gas_tgas: s.gas_tgas,
      step_id: s.step_id,
    })),
    BigInt(actionGasTgas) * 10n ** 12n,
    0n,
  )
);

const result = await sendTransactionAsync(account, values.contract, actions);
const txHash = result.transaction?.hash || "?";
const diagnosis = await diagnoseStageTransaction({
  network: values.network,
  txHash,
  signer: values.signer,
  contractId: values.contract,
  expectedCount: specs.length,
  pollMs,
  timeoutMs: stageTimeoutMs,
});

if (values.json) {
  console.log(
    JSON.stringify(
      {
        network: values.network,
        signer: values.signer,
        receiver: values.contract,
        tx_hash: txHash,
        sequence_order: sequenceOrder,
        actions: specs,
        diagnosis,
      },
      null,
      2
    )
  );
  process.exit(0);
}

console.log(`network=${values.network} signer=${values.signer} receiver=${values.contract} actions=${specs.length}`);
for (const line of mainnetGasGuidance) {
  console.log(line);
}
console.log(`tx_hash=${txHash}`);
console.log(renderStageOutcomeSummary(diagnosis.stage_outcome));
for (const s of specs) {
  console.log(`  ${s.step_id} -> ${s.target}.${s.method} args=${JSON.stringify(s.args)} deposit=${s.deposit_yocto} gas=${s.gas_tgas}TGas`);
}
console.log(`trace: ./scripts/trace-tx.mjs ${txHash} ${values.signer} --wait FINAL`);
if (diagnosis.stage_outcome.classification === "pending_until_resume") {
  console.log(`run_sequence: near call ${values.contract} run_sequence '{"caller_id":"${values.signer}","order":[${sequenceOrder.map((l) => JSON.stringify(l)).join(",")}]}' --accountId ${values.signer}`);
} else {
  console.log(`run_sequence: skipped until stage_outcome becomes pending_until_resume`);
}
console.log(`short=${shortHash(txHash)}`);

function assertUniqueStepIds(stepIds, context) {
  if (new Set(stepIds).size !== stepIds.length) {
    throw new Error(`${context} contain duplicate step IDs`);
  }
}

function validateSequenceOrder(specs, sequenceOrder) {
  const submitted = new Set(specs.map((spec) => spec.step_id));
  if (sequenceOrder.length !== specs.length) {
    throw new Error("--sequence-order must list exactly one step_id for each submitted action");
  }
  for (const step_id of sequenceOrder) {
    if (!submitted.delete(step_id)) {
      throw new Error(`--sequence-order contains an unknown or duplicate step_id '${step_id}'`);
    }
  }
}
