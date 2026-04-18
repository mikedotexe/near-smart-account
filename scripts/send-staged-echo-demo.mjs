#!/usr/bin/env node
//
// scripts/send-staged-echo-demo.mjs — submits a multi-action stage_call tx
// whose downstreams all target an echo-style method on one callee.
//
// NOTE: superseded by scripts/send-stage-call-multi.mjs for new work.
// This script is kept because chapters 03, 06, 07, and 10 reference it
// in their Recipes sections and those recipes should remain reproducible.
// New experiments should use send-stage-call-multi.mjs which takes
// per-action JSON specs instead of a single shared target/method.

import process from "node:process";
import { parseArgs } from "node:util";
import { shortHash } from "./lib/fastnear.mjs";
import { connectNearWithSigners, sendTransactionAsync } from "./lib/near-cli.mjs";
import {
  diagnoseStageTransaction,
  getMainnetStageGasGuidance,
  renderStageOutcomeSummary,
} from "./lib/staged-sequence.mjs";

const MAX_CONTRACT_GAS_TGAS = 1_000;

const { values, positionals } = parseArgs({
  options: {
    network: { type: "string", default: "testnet" },
    signer: { type: "string", default: "mike.testnet" },
    contract: { type: "string", default: "smart-account.x.mike.testnet" },
    target: { type: "string", default: "echo.x.mike.testnet" },
    method: { type: "string", default: "echo_log" },
    "action-gas": { type: "string", default: "60" },
    "call-gas": { type: "string", default: "30" },
    "call-deposit-yocto": { type: "string", default: "0" },
    "sequence-order": { type: "string" },
    "conduct-order": { type: "string" },
    "poll-ms": { type: "string", default: "1000" },
    "stage-timeout-ms": { type: "string", default: "15000" },
    dry: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
  allowPositionals: true,
});

const specs = (positionals.length ? positionals : ["alpha:1", "beta:2", "gamma:3"]).map(
  parseSpec
);
assertUniqueStepIds(specs.map((spec) => spec.step_id), "submitted actions");
const actionGasTgas = Number(values["action-gas"]);
const callGasTgas = Number(values["call-gas"]);
const pollMs = Number(values["poll-ms"]);
const stageTimeoutMs = Number(values["stage-timeout-ms"]);
const sequenceOrder = resolveSequenceOrder(values, specs);

if (!Number.isFinite(actionGasTgas) || actionGasTgas <= 0) {
  throw new Error("--action-gas must be a positive number");
}
if (!Number.isFinite(callGasTgas) || callGasTgas <= 0) {
  throw new Error("--call-gas must be a positive number");
}
if (!Number.isFinite(pollMs) || pollMs <= 0) {
  throw new Error("--poll-ms must be a positive number");
}
if (!Number.isFinite(stageTimeoutMs) || stageTimeoutMs < 0) {
  throw new Error("--stage-timeout-ms must be zero or positive");
}

const totalActionGasTgas = actionGasTgas * specs.length;
if (totalActionGasTgas > MAX_CONTRACT_GAS_TGAS) {
  throw new Error(
    `requested ${totalActionGasTgas} TGas across ${specs.length} actions; keep one transaction at or under ${MAX_CONTRACT_GAS_TGAS} TGas`
  );
}
const mainnetGasGuidance = getMainnetStageGasGuidance({
  network: values.network,
  actionCount: specs.length,
  actionGasTgas,
});
validateSequenceOrder(specs, sequenceOrder);

if (values.dry) {
  const preview = {
    network: values.network,
    signer: values.signer,
    receiver: values.contract,
    target: values.target,
    method: values.method,
    action_gas_tgas: actionGasTgas,
    total_action_gas_tgas: totalActionGasTgas,
    downstream_call_gas_tgas: callGasTgas,
    downstream_call_deposit_yocto: values["call-deposit-yocto"],
    poll_ms: pollMs,
    stage_timeout_ms: stageTimeoutMs,
    guidance: mainnetGasGuidance,
    sequence_order: sequenceOrder,
    actions: specs,
  };
  console.log(JSON.stringify(preview, null, 2));
  process.exit(0);
}
const { nearApi, accounts } = await connectNearWithSigners(values.network, [values.signer]);
const account = accounts[values.signer];
const actions = specs.map(({ step_id, n }) =>
  nearApi.transactions.functionCall(
    "stage_call",
    Buffer.from(
      JSON.stringify({
        target_id: values.target,
        method_name: values.method,
        args: Buffer.from(JSON.stringify({ n })).toString("base64"),
        attached_deposit_yocto: values["call-deposit-yocto"],
        gas_tgas: callGasTgas,
        step_id,
      })
    ),
    BigInt(actionGasTgas) * 10n ** 12n,
    0n
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

console.log(
  `network=${values.network} signer=${values.signer} receiver=${values.contract} actions=${specs.length}`
);
for (const line of mainnetGasGuidance) {
  console.log(line);
}
console.log(`tx_hash=${txHash}`);
console.log(renderStageOutcomeSummary(diagnosis.stage_outcome));
for (const { step_id, n } of specs) {
  console.log(`  ${step_id} -> ${values.target}.${values.method}({\"n\":${n}})`);
}
console.log(`trace: ./scripts/trace-tx.mjs ${txHash} ${values.signer} --wait FINAL`);
if (diagnosis.stage_outcome.classification === "pending_until_resume") {
  console.log(
    `run_sequence: near call ${values.contract} run_sequence '{\"caller_id\":\"${values.signer}\",\"order\":[${sequenceOrder
      .map((step_id) => JSON.stringify(step_id))
      .join(",")}]}' --accountId ${values.signer}`
  );
} else {
  console.log("run_sequence: skipped until stage_outcome becomes pending_until_resume");
}
console.log(`short=${shortHash(txHash)}`);

function parseSpec(raw) {
  const idx = raw.indexOf(":");
  if (idx <= 0 || idx === raw.length - 1) {
    throw new Error(`invalid action spec '${raw}' (expected step_id:number)`);
  }
  const step_id = raw.slice(0, idx);
  const n = Number(raw.slice(idx + 1));
  if (!Number.isInteger(n)) {
    throw new Error(`invalid numeric payload in '${raw}'`);
  }
  return { step_id, n };
}

function assertUniqueStepIds(stepIds, context) {
  if (new Set(stepIds).size !== stepIds.length) {
    throw new Error(`${context} contain duplicate step IDs`);
  }
}

function resolveSequenceOrder(values, specs) {
  const sequenceOrder = values["sequence-order"];
  const conductOrder = values["conduct-order"];

  if (sequenceOrder && conductOrder && sequenceOrder !== conductOrder) {
    throw new Error("--sequence-order and --conduct-order must match when both are provided");
  }

  const chosen = sequenceOrder || conductOrder;
  if (!chosen) return specs.map((spec) => spec.step_id);
  return chosen.split(",").map((step_id) => step_id.trim()).filter(Boolean);
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
