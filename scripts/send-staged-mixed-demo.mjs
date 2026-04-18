#!/usr/bin/env node
//
// Companion to scripts/send-staged-echo-demo.mjs — same shape, but lets
// individual steps target a different downstream method than the rest.
// Used by chapter 08 to prove mid-sequence halt-then-retry semantics:
// some steps get a real `echo_log` downstream, one deliberately bad
// `not_a_method` downstream sits in the middle of the declared order.
//
// NOTE: superseded by scripts/send-stage-call-multi.mjs for new work.
// Kept because chapter 08's recipe references it; the general multi
// helper expresses the same shape via per-action JSON specs.
//
// Usage:
//   scripts/send-staged-mixed-demo.mjs alpha:1 beta:2 gamma:3 delta:4 \
//     --method echo_log --fail-method not_a_method --fail-step-ids beta \
//     --action-gas 250 --call-gas 30 --sequence-order alpha,beta,gamma,delta
//
// The script calls the currently-deployed contract's `stage_call` method.
// After the rename landed on testnet it matches contracts/smart-account.

import process from "node:process";
import { parseArgs } from "node:util";
import { shortHash } from "./lib/fastnear.mjs";
import { connectNearWithSigners } from "./lib/near-cli.mjs";

const MAX_CONTRACT_GAS_TGAS = 1_000;

const { values, positionals } = parseArgs({
  options: {
    network: { type: "string", default: "testnet" },
    signer: { type: "string", default: "mike.testnet" },
    contract: { type: "string", default: "smart-account.x.mike.testnet" },
    target: { type: "string", default: "echo.x.mike.testnet" },
    method: { type: "string", default: "echo_log" },
    "fail-method": { type: "string", default: "not_a_method" },
    "fail-step-ids": { type: "string", default: "" },
    "action-gas": { type: "string", default: "250" },
    "call-gas": { type: "string", default: "30" },
    "call-deposit-yocto": { type: "string", default: "0" },
    "sequence-order": { type: "string" },
    dry: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
  allowPositionals: true,
});

const specs = (positionals.length ? positionals : ["alpha:1", "beta:2", "gamma:3", "delta:4"]).map(parseSpec);
assertUniqueStepIds(specs.map((spec) => spec.step_id), "submitted actions");
const actionGasTgas = Number(values["action-gas"]);
const callGasTgas = Number(values["call-gas"]);
const failStepIdSet = new Set(
  values["fail-step-ids"].split(",").map((value) => value.trim()).filter(Boolean)
);
const sequenceOrder = values["sequence-order"]
  ? values["sequence-order"].split(",").map((l) => l.trim()).filter(Boolean)
  : specs.map((s) => s.step_id);

if (!Number.isFinite(actionGasTgas) || actionGasTgas <= 0) throw new Error("--action-gas must be positive");
if (!Number.isFinite(callGasTgas) || callGasTgas <= 0) throw new Error("--call-gas must be positive");
const totalActionGasTgas = actionGasTgas * specs.length;
if (totalActionGasTgas > MAX_CONTRACT_GAS_TGAS) {
  throw new Error(`requested ${totalActionGasTgas} TGas across ${specs.length} actions; keep ≤ ${MAX_CONTRACT_GAS_TGAS}`);
}

for (const step_id of failStepIdSet) {
  if (!specs.some((s) => s.step_id === step_id)) {
    throw new Error(`--fail-step-ids references unknown step_id '${step_id}'`);
  }
}
validateSequenceOrder(specs, sequenceOrder);

if (values.dry) {
  const preview = {
    network: values.network, signer: values.signer, receiver: values.contract,
    target: values.target, success_method: values.method, fail_method: values["fail-method"],
    fail_step_ids: [...failStepIdSet],
    action_gas_tgas: actionGasTgas, total_action_gas_tgas: totalActionGasTgas,
    downstream_call_gas_tgas: callGasTgas,
    actions: specs.map((s) => ({
      ...s,
      downstream_method: failStepIdSet.has(s.step_id) ? values["fail-method"] : values.method,
    })),
    sequence_order: sequenceOrder,
  };
  console.log(JSON.stringify(preview, null, 2));
  process.exit(0);
}
const { nearApi, accounts } = await connectNearWithSigners(values.network, [values.signer]);
const account = accounts[values.signer];
const actions = specs.map(({ step_id, n }) => {
  const downstream = failStepIdSet.has(step_id) ? values["fail-method"] : values.method;
  return nearApi.transactions.functionCall(
    "stage_call",
    Buffer.from(JSON.stringify({
      target_id: values.target,
      method_name: downstream,
      args: Buffer.from(JSON.stringify({ n })).toString("base64"),
      attached_deposit_yocto: values["call-deposit-yocto"],
      gas_tgas: callGasTgas,
      step_id,
    })),
    BigInt(actionGasTgas) * 10n ** 12n,
    0n,
  );
});

const result = await account.signAndSendTransaction({ receiverId: values.contract, actions });

if (values.json) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

const txHash = result.transaction?.hash || result.transaction_outcome?.id || "?";
console.log(`network=${values.network} signer=${values.signer} receiver=${values.contract} actions=${specs.length}`);
console.log(`tx_hash=${txHash}`);
for (const { step_id, n } of specs) {
  const m = failStepIdSet.has(step_id) ? values["fail-method"] : values.method;
  console.log(`  ${step_id} -> ${values.target}.${m}({"n":${n}})${failStepIdSet.has(step_id) ? "  [planned failure]" : ""}`);
}
console.log(`trace: ./scripts/trace-tx.mjs ${txHash} ${values.signer} --wait FINAL`);
console.log(`run_sequence: near call ${values.contract} run_sequence '{"caller_id":"${values.signer}","order":[${sequenceOrder.map((l) => JSON.stringify(l)).join(",")}]}' --accountId ${values.signer}`);
console.log(`short=${shortHash(txHash)}`);

function parseSpec(raw) {
  const idx = raw.indexOf(":");
  if (idx <= 0 || idx === raw.length - 1) throw new Error(`invalid spec '${raw}' (expected step_id:number)`);
  const step_id = raw.slice(0, idx);
  const n = Number(raw.slice(idx + 1));
  if (!Number.isInteger(n)) throw new Error(`invalid numeric payload in '${raw}'`);
  return { step_id, n };
}

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
