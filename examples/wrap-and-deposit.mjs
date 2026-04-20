#!/usr/bin/env node
//
// examples/wrap-and-deposit.mjs — cross-protocol atomic composition
// demo: wrap NEAR and deposit to Ref Finance as one sequenced plan.
//
// Companion to `examples/sequential-intents.mjs`. That flagship shows
// sequential execution *inside* NEAR Intents (`intents.near`); this one
// shows the same sequencer working across *different* protocols, so
// `intents.near` is not a required target — our sequential sequencer
// composes any protocol with the same Asserted-policy discipline.
//
// Signs ONE multi-action tx that calls `execute_steps(plan)` on the smart
// account. The plan is two steps:
//
//   1. wrap.near.near_deposit        (attach N NEAR  → mint N wNEAR to
//                                     the smart-account's balance)
//      policy: Direct — trust the wrap contract's own success
//
//   2. wrap.near.ft_transfer_call    (transfer N wNEAR to Ref Finance
//                                     with msg="" = deposit to smart-
//                                     account's Ref internal balance)
//      policy: Asserted — post-check Ref's `get_deposit` view and
//                         advance only if the internal balance actually
//                         increased by N. Gates the step on a true
//                         state change, not just the receipt-level
//                         refund number.
//
// If step 1 fails, step 2 never fires (halt-on-failure).  If step 2's
// transfer settles at the receipt level but Ref's internal ledger did
// not credit the full amount (refund semantics, storage missing on the
// pool side, etc.), the Asserted postcheck catches it and halts the
// sequence with `step_resolved_err` + an `assertion_checked` event.
//
// Storage registration (one-time, on both wrap and Ref) is a
// pre-requisite — see the preflight section below.
//
// Usage (testnet, dry-run):
//   ./examples/wrap-and-deposit.mjs \
//     --network testnet \
//     --signer mike.testnet \
//     --smart-account sa-wallet.x.mike.testnet \
//     --amount-near 0.1 \
//     --dry
//
// Usage (mainnet, live):
//   ./examples/wrap-and-deposit.mjs \
//     --network mainnet \
//     --signer mike.near \
//     --smart-account sa-wallet.mike.near \
//     --amount-near 0.05

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { REPO_ROOT, shortHash, sleep } from "../scripts/lib/fastnear.mjs";
import {
  buildTxArtifact,
  callView,
  callViewMethod,
  connectNearWithSigners,
  sendTransactionAsync,
} from "../scripts/lib/near-cli.mjs";
import { traceTx } from "../scripts/lib/trace-rpc.mjs";
import {
  diagnoseRegisterTransaction,
  renderStepOutcomeSummary,
} from "../scripts/lib/step-sequence.mjs";

const TARGETS = {
  mainnet: { wrap: "wrap.near", ref: "v2.ref-finance.near" },
  testnet: { wrap: "wrap.testnet", ref: "ref-finance-101.testnet" },
};

const YOCTO_PER_NEAR = 10n ** 24n;
const ONE_YOCTO = "1";
const MAX_TX_GAS_TGAS = 1_000;

const { values } = parseArgs({
  options: {
    network: { type: "string", default: "testnet" },
    signer: { type: "string" },
    "smart-account": { type: "string" },
    "amount-near": { type: "string" },
    // Optional target overrides; default to network's canonical addresses.
    wrap: { type: "string" },
    ref: { type: "string" },
    // Gas knobs.
    "action-gas": { type: "string", default: "300" },
    "wrap-gas": { type: "string", default: "30" },
    "deposit-gas": { type: "string", default: "150" },
    "assertion-gas": { type: "string", default: "15" },
    // Observation knobs.
    "poll-ms": { type: "string", default: "2000" },
    "step-register-timeout-ms": { type: "string", default: "30000" },
    "resolve-timeout-ms": { type: "string", default: "180000" },
    // Output.
    "artifacts-file": { type: "string" },
    dry: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    "skip-preflight": { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (!values.signer) {
  throw new Error("--signer is required (e.g. --signer mike.testnet)");
}
if (!values["smart-account"]) {
  throw new Error("--smart-account is required (the deployed intent-executor account)");
}
if (!values["amount-near"]) {
  throw new Error("--amount-near is required (e.g. --amount-near 0.1)");
}

const network = values.network;
const canonical = TARGETS[network];
if (!canonical) {
  throw new Error(`unsupported --network '${network}' (expected mainnet or testnet)`);
}

const wrapAddr = values.wrap || canonical.wrap;
const refAddr = values.ref || canonical.ref;
const signer = values.signer;
const smartAccount = values["smart-account"];
const amountYocto = parseNearAmount(values["amount-near"]);
const actionGasTgas = parsePositiveInt(values["action-gas"], "--action-gas");
const wrapGasTgas = parsePositiveInt(values["wrap-gas"], "--wrap-gas");
const depositGasTgas = parsePositiveInt(values["deposit-gas"], "--deposit-gas");
const assertionGasTgas = parsePositiveInt(values["assertion-gas"], "--assertion-gas");
const pollMs = parsePositiveInt(values["poll-ms"], "--poll-ms");
const registerTimeoutMs = parsePositiveInt(
  values["step-register-timeout-ms"],
  "--step-register-timeout-ms"
);
const resolveTimeoutMs = parsePositiveInt(
  values["resolve-timeout-ms"],
  "--resolve-timeout-ms"
);

const totalOuterGasTgas = actionGasTgas * 2;
if (totalOuterGasTgas > MAX_TX_GAS_TGAS) {
  throw new Error(
    `2-step plan at ${actionGasTgas} TGas/action exceeds the ${MAX_TX_GAS_TGAS} TGas tx envelope`
  );
}

const runId = Date.now().toString(36);
const artifactsFile = values["artifacts-file"] || defaultArtifactsFile(signer, runId);

// ---------------------------------------------------------------- preflight
// Storage must be registered on both wrap and Ref for the smart-account,
// else the downstream calls panic. Print a clear command to fix and exit.
async function preflight() {
  const wrapStorage = await callView(network, wrapAddr, "storage_balance_of", {
    account_id: smartAccount,
  });
  const refStorage = await callView(network, refAddr, "storage_balance_of", {
    account_id: smartAccount,
  });
  const missing = [];
  if (!wrapStorage) missing.push({ target: wrapAddr, cost: "1250000000000000000000" });
  if (!refStorage) missing.push({ target: refAddr, cost: "100000000000000000000000" });
  return {
    wrap_storage: wrapStorage,
    ref_storage: refStorage,
    missing,
  };
}

// ------------------------------------------------------- read current state
async function getRefDeposit() {
  try {
    const { value } = await callViewMethod(network, refAddr, "get_deposit", {
      account_id: smartAccount,
      token_id: wrapAddr,
    });
    return BigInt(value ?? "0");
  } catch {
    return 0n;
  }
}

async function getWrapBalance() {
  const value = await callView(network, wrapAddr, "ft_balance_of", {
    account_id: smartAccount,
  });
  return BigInt(value ?? "0");
}

// ------------------------------------------------------------------- plan
function buildPlan({ prevRefDeposit }) {
  const expected = prevRefDeposit + amountYocto;
  const wrapStep = {
    step_id: `wrap-${runId}`,
    target_id: wrapAddr,
    method_name: "near_deposit",
    args: base64Json({}),
    attached_deposit_yocto: amountYocto.toString(),
    gas_tgas: wrapGasTgas,
    // policy omitted = Direct (default)
  };
  const depositStep = {
    step_id: `deposit-${runId}`,
    target_id: wrapAddr,
    method_name: "ft_transfer_call",
    args: base64Json({
      receiver_id: refAddr,
      amount: amountYocto.toString(),
      msg: "",
    }),
    attached_deposit_yocto: ONE_YOCTO,
    gas_tgas: depositGasTgas,
    policy: {
      Asserted: {
        assertion_id: refAddr,
        assertion_method: "get_deposit",
        assertion_args: base64Json({
          account_id: smartAccount,
          token_id: wrapAddr,
        }),
        expected_return: base64Utf8(JSON.stringify(expected.toString())),
        assertion_gas_tgas: assertionGasTgas,
      },
    },
  };
  return { steps: [wrapStep, depositStep], expected };
}

// ------------------------------------------------------------------- main
const preflightInfo = values["skip-preflight"] ? { missing: [], skipped: true } : await preflight();
if (!values["skip-preflight"] && preflightInfo.missing.length > 0) {
  console.error(
    `preflight: ${smartAccount} is not registered on ${preflightInfo.missing.length} target(s):`
  );
  for (const m of preflightInfo.missing) {
    console.error(
      `  near call ${m.target} storage_deposit '{"account_id":"${smartAccount}","registration_only":true}' --accountId ${signer} --deposit 0.00125`
    );
  }
  console.error(
    `(or pass --skip-preflight if you know what you're doing; defaults shown assume canonical storage costs)`
  );
  process.exit(1);
}

const wrapBalanceBefore = await getWrapBalance();
const prevRefDeposit = await getRefDeposit();
const { steps: plan, expected: expectedRefDeposit } = buildPlan({ prevRefDeposit });

if (values.dry) {
  printDry({
    plan,
    preflight: preflightInfo,
    wrapBalanceBefore,
    prevRefDeposit,
    expectedRefDeposit,
  });
  process.exit(0);
}

const { nearApi, accounts } = await connectNearWithSigners(network, [signer]);
const account = accounts[signer];

const functionCall = nearApi.transactions.functionCall(
  "execute_steps",
  Buffer.from(JSON.stringify({ steps: plan })),
  BigInt(actionGasTgas * 2) * 10n ** 12n,
  0n
);

const result = await sendTransactionAsync(account, smartAccount, [functionCall]);
const txArtifact = await buildTxArtifact(network, result, signer, "execute_steps");
const registerDiagnosis = await diagnoseRegisterTransaction({
  network,
  txHash: txArtifact.tx_hash,
  signer,
  contractId: smartAccount,
  expectedCount: plan.length,
  pollMs,
  timeoutMs: registerTimeoutMs,
});

// Poll for terminal state: wait until no registered steps remain for the
// caller's manual namespace (success) OR observe sequence_halted in logs
// via a later trace.
const terminalState = await waitForTerminalState({
  network,
  smartAccount,
  signer,
  pollMs,
  timeoutMs: resolveTimeoutMs,
  startedAfterBlock: registerDiagnosis.registered_state.block_height,
});

const wrapBalanceAfter = await getWrapBalance();
const newRefDeposit = await getRefDeposit();

const trace = await safeTrace(network, txArtifact.tx_hash, signer);

const artifacts = {
  generated_at: new Date().toISOString(),
  run_id: runId,
  network,
  signer,
  smart_account: smartAccount,
  wrap: wrapAddr,
  ref: refAddr,
  amount_near: values["amount-near"],
  amount_yocto: amountYocto.toString(),
  action_gas_tgas: actionGasTgas,
  wrap_gas_tgas: wrapGasTgas,
  deposit_gas_tgas: depositGasTgas,
  assertion_gas_tgas: assertionGasTgas,
  preflight: preflightInfo,
  plan,
  expected_ref_deposit_yocto: expectedRefDeposit.toString(),
  prev_ref_deposit_yocto: prevRefDeposit.toString(),
  wrap_balance_before_yocto: wrapBalanceBefore.toString(),
  txs: [txArtifact],
  register_diagnosis: registerDiagnosis,
  terminal_state: terminalState,
  wrap_balance_after_yocto: wrapBalanceAfter.toString(),
  new_ref_deposit_yocto: newRefDeposit.toString(),
  ref_deposit_delta_yocto: (newRefDeposit - prevRefDeposit).toString(),
  traces: {
    execute_steps: summarizeTrace(trace),
  },
  artifacts_file: artifactsFile,
  commands: commandSet({
    signer,
    smartAccount,
    refAddr,
    wrapAddr,
    executeStepsTxHash: txArtifact.tx_hash,
  }),
};

fs.mkdirSync(path.dirname(artifactsFile), { recursive: true });
fs.writeFileSync(artifactsFile, `${JSON.stringify(artifacts, null, 2)}\n`);

if (values.json) {
  console.log(JSON.stringify(artifacts, null, 2));
  process.exit(0);
}

printHumanSummary(artifacts);

// ============================================================ helpers

function base64Json(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64");
}

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

function defaultArtifactsFile(signerId, id) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(
    REPO_ROOT,
    "collab",
    "artifacts",
    `${stamp}-wrap-and-deposit-${signerId.replace(/\./g, "-")}-${id}.json`
  );
}

async function waitForTerminalState({
  network,
  smartAccount,
  signer,
  pollMs,
  timeoutMs,
  startedAfterBlock,
}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { value, block_height } = await callViewMethod(
        network,
        smartAccount,
        "registered_steps_for",
        { caller_id: signer }
      );
      const remaining = Array.isArray(value) ? value : [];
      if (remaining.length === 0) {
        return {
          reached: "drained",
          registered_step_count: 0,
          observed_at_block: block_height,
          startedAfterBlock,
          elapsed_ms: null,
        };
      }
    } catch (error) {
      return {
        reached: "error",
        error: String(error),
        startedAfterBlock,
      };
    }
    await sleep(pollMs);
  }
  return {
    reached: "timeout",
    timeout_ms: timeoutMs,
    startedAfterBlock,
    note: "some step may still be pending — check registered_steps_for and run trace-tx on the execute_steps tx",
  };
}

async function safeTrace(network, txHash, signer, { retries = 3, delayMs = 2000 } = {}) {
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const traced = await traceTx(network, txHash, signer, "FINAL");
      if (traced?.tree) return traced;
      last = traced || { error: "no tree" };
    } catch (error) {
      last = { error: String(error) };
    }
    if (attempt < retries) await sleep(delayMs);
  }
  return last ?? { error: "safeTrace exhausted retries" };
}

function summarizeTrace(trace) {
  if (!trace || trace.error) return { error: trace?.error || "no trace" };
  return {
    sender_id: trace.senderId,
    classification: trace.classification,
    error: trace.error || null,
  };
}

function commandSet({ signer, smartAccount, refAddr, wrapAddr, executeStepsTxHash }) {
  return {
    trace_execute:
      `./scripts/trace-tx.mjs ${executeStepsTxHash} ${signer} --wait FINAL`,
    investigate_execute:
      `./scripts/investigate-tx.mjs ${executeStepsTxHash} ${signer} --wait FINAL ` +
      `--accounts ${smartAccount},${wrapAddr},${refAddr}`,
    ref_deposit_view:
      `./scripts/state.mjs ${refAddr} --method get_deposit --args '${JSON.stringify({
        account_id: smartAccount,
        token_id: wrapAddr,
      })}'`,
    wrap_balance_view:
      `./scripts/state.mjs ${wrapAddr} --method ft_balance_of --args '${JSON.stringify({
        account_id: smartAccount,
      })}'`,
    registered_steps_view:
      `./scripts/state.mjs ${smartAccount} --method registered_steps_for --args '${JSON.stringify({
        caller_id: signer,
      })}'`,
  };
}

function printDry({ plan, preflight, wrapBalanceBefore, prevRefDeposit, expectedRefDeposit }) {
  console.log(
    JSON.stringify(
      {
        network,
        signer,
        smart_account: smartAccount,
        wrap: wrapAddr,
        ref: refAddr,
        amount_near: values["amount-near"],
        amount_yocto: amountYocto.toString(),
        action_gas_tgas: actionGasTgas,
        preflight,
        wrap_balance_before_yocto: wrapBalanceBefore.toString(),
        prev_ref_deposit_yocto: prevRefDeposit.toString(),
        expected_ref_deposit_yocto: expectedRefDeposit.toString(),
        plan,
      },
      null,
      2
    )
  );
}

function printHumanSummary(a) {
  console.log(
    `network=${a.network} signer=${a.signer} smart_account=${a.smart_account} amount=${a.amount_near} NEAR`
  );
  console.log(`execute_steps: tx_hash=${a.txs[0].tx_hash} block_height=${a.txs[0].block_height ?? "?"}`);
  console.log(renderStepOutcomeSummary(a.register_diagnosis.step_outcome));
  console.log(`wrap_balance: ${a.wrap_balance_before_yocto} → ${a.wrap_balance_after_yocto}`);
  console.log(
    `ref_deposit:  ${a.prev_ref_deposit_yocto} → ${a.new_ref_deposit_yocto} (expected ${a.expected_ref_deposit_yocto})`
  );
  const matched = a.new_ref_deposit_yocto === a.expected_ref_deposit_yocto;
  console.log(`match=${matched} reached=${a.terminal_state.reached}`);
  console.log(`trace: ${a.commands.trace_execute}`);
  console.log(`investigate: ${a.commands.investigate_execute}`);
  console.log(`ref_deposit_view: ${a.commands.ref_deposit_view}`);
  console.log(`artifacts=${a.artifacts_file}`);
  console.log(`short=${shortHash(a.txs[0].tx_hash)}`);
}
