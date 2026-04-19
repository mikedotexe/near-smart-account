#!/usr/bin/env node
//
// examples/dca.mjs — scheduled NEAR Intents onboarding via the smart
// account's balance-trigger automation. A recurring version of the
// deposit half of `examples/sequential-intents.mjs`.
//
// MAINNET-ONLY (NEAR Intents lives on `intents.near` mainnet).
// Test with small amounts.
//
// Shape: one sequence template, one balance trigger. Each time the
// smart account's balance rises above `--min-balance-yocto`, executing
// the trigger fires the saved template once — wrap N NEAR and deposit
// to `intents.near`, crediting the signer's trading balance. Over many
// ticks the signer dollar-cost-averages onto NEAR Intents.
//
// Template (2 steps, both Direct — recurring templates can't carry
// absolute Asserted postcheck values because the expected balance
// changes every tick):
//
//   Step 1  wrap.near.near_deposit        (mint N wNEAR to smart
//                                          account's balance)
//
//   Step 2  wrap.near.ft_transfer_call    (transfer N wNEAR to
//                                          intents.near with DepositMessage
//                                          crediting the signer)
//
// The script orchestrates: (1) preflight wrap storage on the smart
// account, (2) save the template, (3) create the balance trigger,
// (4) execute_trigger once to fire the first tick, (5) snapshot
// intents.near balance before/after so you can see the delta.
//
// Subsequent ticks are one-liners — call `execute_trigger(<trigger-id>)`
// from any authorized executor whenever balance qualifies:
//
//   near call <smart-account> execute_trigger '{"trigger_id":"<id>"}' \
//     --accountId <executor> --gas 800000000000000
//
// Usage (dry-run):
//   ./examples/dca.mjs \
//     --signer mike.near \
//     --smart-account sa-wallet.mike.near \
//     --amount-near 0.01 \
//     --min-balance-yocto 30000000000000000000000000 \
//     --max-runs 100 \
//     --dry
//
// Usage (live — fires one tick at end):
//   ./examples/dca.mjs \
//     --signer mike.near \
//     --smart-account sa-wallet.mike.near \
//     --amount-near 0.01 \
//     --min-balance-yocto 30000000000000000000000000

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import {
  decodeSuccessValue,
  REPO_ROOT,
  shortHash,
} from "../scripts/lib/fastnear.mjs";
import {
  buildTxArtifact,
  callView,
  callViewMethod,
  connectNearWithSigners,
  sendFunctionCall,
} from "../scripts/lib/near-cli.mjs";

const NETWORK = "mainnet";
const WRAP = "wrap.near";
const INTENTS = "intents.near";
const TOKEN_ID = `nep141:${WRAP}`;
const YOCTO_PER_NEAR = 10n ** 24n;

const { values } = parseArgs({
  options: {
    signer: { type: "string" },
    "smart-account": { type: "string" },
    "amount-near": { type: "string" },
    // Who gets credited on intents.near. Defaults to signer.
    "credit-to": { type: "string" },
    // Executor that fires execute_trigger. Defaults to signer (self-DCA).
    executor: { type: "string" },
    // Trigger criteria.
    "min-balance-yocto": { type: "string" },
    "max-runs": { type: "string", default: "100" },
    // Stable IDs so re-runs update the same template/trigger. If not
    // passed, per-run IDs are generated (useful for isolated demos).
    "sequence-id": { type: "string" },
    "trigger-id": { type: "string" },
    // Gas knobs.
    "action-gas": { type: "string", default: "300" },
    "wrap-gas": { type: "string", default: "30" },
    "deposit-gas": { type: "string", default: "150" },
    "owner-gas": { type: "string", default: "50" },
    "execute-gas": { type: "string", default: "750" },
    "artifacts-file": { type: "string" },
    dry: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    "skip-preflight": { type: "boolean", default: false },
    "skip-execute": { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (!values.signer) {
  throw new Error("--signer is required (owns the smart account, saves templates)");
}
if (!values["smart-account"]) {
  throw new Error("--smart-account is required (the deployed intent-executor account)");
}
if (!values["amount-near"]) {
  throw new Error("--amount-near is required (per-tick wrap+deposit amount)");
}
if (!values["min-balance-yocto"]) {
  throw new Error(
    "--min-balance-yocto is required (trigger fires only when smart account balance exceeds this)"
  );
}

const signer = values.signer;
const smartAccount = values["smart-account"];
const creditTo = values["credit-to"] || signer;
const executor = values.executor || signer;
const amountYocto = parseNearAmount(values["amount-near"]);
const minBalanceYocto = parseNonNegativeBigInt(
  values["min-balance-yocto"],
  "--min-balance-yocto"
);
const maxRuns = parsePositiveInt(values["max-runs"], "--max-runs");
const wrapGasTgas = parsePositiveInt(values["wrap-gas"], "--wrap-gas");
const depositGasTgas = parsePositiveInt(values["deposit-gas"], "--deposit-gas");
const ownerGasTgas = parsePositiveInt(values["owner-gas"], "--owner-gas");
const executeGasTgas = parsePositiveInt(values["execute-gas"], "--execute-gas");

const runId = Date.now().toString(36);
const sequenceId = values["sequence-id"] || `dca-intents-${runId}`;
const triggerId = values["trigger-id"] || `dca-intents-trigger-${runId}`;
const artifactsFile = values["artifacts-file"] || defaultArtifactsFile(sequenceId, triggerId);

// ------------------------------------------------------------ template shape
const template = [
  {
    step_id: "wrap",
    target_id: WRAP,
    method_name: "near_deposit",
    args: base64Json({}),
    attached_deposit_yocto: amountYocto.toString(),
    gas_tgas: wrapGasTgas,
    // policy omitted → Direct
  },
  {
    step_id: "deposit",
    target_id: WRAP,
    method_name: "ft_transfer_call",
    args: base64Json({
      receiver_id: INTENTS,
      amount: amountYocto.toString(),
      msg: JSON.stringify({
        receiver_id: creditTo,
        refund_if_fails: true,
      }),
    }),
    attached_deposit_yocto: "1",
    gas_tgas: depositGasTgas,
    // policy omitted → Direct. An Asserted policy with a fixed
    // expected_return doesn't work across multiple ticks because the
    // expected post-tick balance grows with each run. A future
    // "Asserted on delta" policy variant could cover this; out of
    // scope for v1 DCA.
  },
];

// ------------------------------------------------------------------ preflight
async function preflight() {
  const wrapStorage = await callView(NETWORK, WRAP, "storage_balance_of", {
    account_id: smartAccount,
  });
  return {
    wrap_storage_smart_account: wrapStorage,
    wrap_missing_smart_account: !wrapStorage,
  };
}

async function getIntentsBalance(accountId) {
  try {
    const { value } = await callViewMethod(NETWORK, INTENTS, "mt_balance_of", {
      account_id: accountId,
      token_id: TOKEN_ID,
    });
    return BigInt(value ?? "0");
  } catch {
    return 0n;
  }
}

// ------------------------------------------------------------------------ main
const preflightInfo = values["skip-preflight"]
  ? { skipped: true, wrap_missing_smart_account: false }
  : await preflight();

if (!values["skip-preflight"] && preflightInfo.wrap_missing_smart_account) {
  console.error(
    `preflight: ${smartAccount} is not registered on ${WRAP} — template would fail at step 1.`
  );
  console.error(
    `  near call ${WRAP} storage_deposit '{"account_id":"${smartAccount}","registration_only":true}' --accountId ${signer} --deposit 0.00125`
  );
  console.error(`(or pass --skip-preflight to bypass)`);
  process.exit(1);
}

const preview = {
  network: NETWORK,
  signer,
  smart_account: smartAccount,
  executor,
  credit_to: creditTo,
  wrap: WRAP,
  intents: INTENTS,
  token_id: TOKEN_ID,
  amount_near: values["amount-near"],
  amount_yocto: amountYocto.toString(),
  min_balance_yocto: minBalanceYocto.toString(),
  max_runs: maxRuns,
  sequence_id: sequenceId,
  trigger_id: triggerId,
  owner_gas_tgas: ownerGasTgas,
  execute_gas_tgas: executeGasTgas,
  preflight: preflightInfo,
  template,
  skip_execute: values["skip-execute"],
  artifacts_file: artifactsFile,
};

if (values.dry) {
  console.log(JSON.stringify(preview, null, 2));
  process.exit(0);
}

const signerSet = [signer, ...(executor !== signer ? [executor] : [])];
const { nearApi, accounts } = await connectNearWithSigners(NETWORK, signerSet);
const ownerAccount = accounts[signer];
const executorAccount = accounts[executor];

const prevIntentsBalance = await getIntentsBalance(creditTo);

const saveTemplate = await sendFunctionCall(
  nearApi,
  ownerAccount,
  smartAccount,
  "save_sequence_template",
  {
    sequence_id: sequenceId,
    calls: template,
  },
  ownerGasTgas
);
const createTrigger = await sendFunctionCall(
  nearApi,
  ownerAccount,
  smartAccount,
  "create_balance_trigger",
  {
    trigger_id: triggerId,
    sequence_id: sequenceId,
    min_balance_yocto: minBalanceYocto.toString(),
    max_runs: maxRuns,
  },
  ownerGasTgas
);

const executeTrigger = values["skip-execute"]
  ? null
  : await sendFunctionCall(
      nearApi,
      executorAccount,
      smartAccount,
      "execute_trigger",
      { trigger_id: triggerId },
      executeGasTgas
    );

const saveTemplateStatus = decodeSuccessValue(saveTemplate.status?.SuccessValue) || null;
const createTriggerStatus = decodeSuccessValue(createTrigger.status?.SuccessValue) || null;
const executeTriggerStatus = executeTrigger
  ? decodeSuccessValue(executeTrigger.status?.SuccessValue) || null
  : null;

const newIntentsBalance = await getIntentsBalance(creditTo);

const txs = [];
txs.push(
  await buildTxArtifact(NETWORK, saveTemplate, signer, "save_sequence_template")
);
txs.push(
  await buildTxArtifact(NETWORK, createTrigger, signer, "create_balance_trigger")
);
if (executeTrigger) {
  txs.push(await buildTxArtifact(NETWORK, executeTrigger, executor, "execute_trigger"));
}

const artifacts = {
  generated_at: new Date().toISOString(),
  run_id: runId,
  ...preview,
  prev_intents_balance_yocto: prevIntentsBalance.toString(),
  new_intents_balance_yocto: newIntentsBalance.toString(),
  intents_balance_delta_yocto: (newIntentsBalance - prevIntentsBalance).toString(),
  sequence_template_view: saveTemplateStatus,
  balance_trigger_view: createTriggerStatus,
  trigger_execution_view: executeTriggerStatus,
  txs,
  commands: {
    execute_one_tick:
      `near call ${smartAccount} execute_trigger '${JSON.stringify({ trigger_id: triggerId })}' ` +
      `--accountId ${executor} --gas 800000000000000`,
    trigger_state:
      `./scripts/state.mjs ${smartAccount} --method get_balance_trigger --args '${JSON.stringify({ trigger_id: triggerId })}'`,
    intents_balance_view:
      `./scripts/state.mjs ${INTENTS} --method mt_balance_of --args '${JSON.stringify({
        account_id: creditTo,
        token_id: TOKEN_ID,
      })}'`,
  },
};

fs.mkdirSync(path.dirname(artifactsFile), { recursive: true });
fs.writeFileSync(artifactsFile, `${JSON.stringify(artifacts, null, 2)}\n`);

if (values.json) {
  console.log(JSON.stringify(artifacts, null, 2));
  process.exit(0);
}

for (const tx of artifacts.txs) {
  console.log(
    `${tx.step}: tx_hash=${tx.tx_hash} block_height=${tx.block_height ?? "?"} signer=${tx.signer}`
  );
}
console.log(`sequence_id=${sequenceId}`);
console.log(`trigger_id=${triggerId}`);
console.log(
  `intents_balance(${creditTo}, ${TOKEN_ID}): ${prevIntentsBalance} → ${newIntentsBalance} (delta ${newIntentsBalance - prevIntentsBalance})`
);
console.log(`next tick: ${artifacts.commands.execute_one_tick}`);
console.log(`artifacts=${artifactsFile}`);
console.log(
  `short=${artifacts.txs.map((tx) => `${tx.step}:${shortHash(tx.tx_hash)}`).join(" ")}`
);

// ============================================================ helpers

function base64Json(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64");
}

function parsePositiveInt(raw, flag) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return value;
}

function parseNonNegativeBigInt(raw, flag) {
  const value = String(raw).trim();
  if (!/^\d+$/.test(value)) {
    throw new Error(`${flag} must be a non-negative integer (yocto)`);
  }
  return BigInt(value);
}

function parseNearAmount(raw) {
  const value = String(raw).trim();
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new Error(`invalid NEAR amount '${raw}'`);
  }
  const [wholePart, fracPart = ""] = value.split(".");
  if (fracPart.length > 24) {
    throw new Error(`NEAR amount '${raw}' has more than 24 decimal places`);
  }
  const whole = BigInt(wholePart);
  const frac = BigInt((fracPart + "0".repeat(24)).slice(0, 24));
  return whole * YOCTO_PER_NEAR + frac;
}

function defaultArtifactsFile(seqId, trigId) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(
    REPO_ROOT,
    "collab",
    "artifacts",
    `${stamp}-dca-${seqId}-${trigId}.json`
  );
}
