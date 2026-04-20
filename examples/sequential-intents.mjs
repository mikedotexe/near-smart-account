#!/usr/bin/env node
//
// examples/sequential-intents.mjs — sequential NEAR Intents round-trip via
// the smart-account intent executor.
//
// MAINNET-ONLY. NEAR Intents (`intents.near`) has no testnet deploy.
// Test with small amounts.
//
// Default plan is a three-step round-trip that demonstrates what the
// smart account uniquely enables: sequential execution across separate
// `intents.near` operations, each gated by the previous step's settled
// state on the verifier ledger. Without this sequencer, step 3 would race
// step 2 and fail with insufficient balance on `intents.near`.
//
//   Step 1  wrap.near.near_deposit        (mint N wNEAR to the smart-
//     policy = Direct                      account by attaching N NEAR)
//
//   Step 2  wrap.near.ft_transfer_call    (transfer N wNEAR to
//     policy = Asserted                    intents.near crediting the
//                                          signer's NEAR Intents balance)
//       assertion = intents.near.mt_balance_of({
//                     account_id: signer, token_id: "nep141:wrap.near"
//                   }) == prev + N
//
//   Step 3  intents.near.execute_intents  (signed ft_withdraw intent:
//     policy = Asserted                    signer pulls N wNEAR back
//                                          out of intents.near to their
//                                          wallet)
//       assertion = wrap.near.ft_balance_of({
//                     account_id: signer
//                   }) == prev_signer_wrap + N
//
// Step 2 asserts on `intents.near`'s ledger; step 3 asserts on the
// wallet-side wrap ledger — both sides of the round-trip are
// independently confirmed before the plan reports match.
//
// The signed intent in step 3 is built in-script via the NEP-413 helper
// in `scripts/lib/nep413-sign.mjs`. The signer's full-access key from
// `~/.near-credentials` signs the intent; the smart account just
// submits it as the relayer.
//
// With `--deposit-only` the plan collapses to steps 1+2 (the original
// onboard-only flagship) — useful when you want to seed a NEAR Intents
// trading balance without immediately pulling it back out.
//
// Assumes the smart account is pre-funded with >= amount_near NEAR
// (step 1 attaches from the smart account's own balance).
//
// Usage (dry-run, round-trip):
//   ./examples/sequential-intents.mjs \
//     --signer mike.near \
//     --smart-account sa-wallet.mike.near \
//     --amount-near 0.01 \
//     --dry
//
// Usage (live round-trip):
//   ./examples/sequential-intents.mjs \
//     --signer mike.near \
//     --smart-account sa-wallet.mike.near \
//     --amount-near 0.01
//
// Usage (deposit-only, original onboard flow):
//   ./examples/sequential-intents.mjs \
//     --signer mike.near \
//     --smart-account sa-wallet.mike.near \
//     --amount-near 0.01 \
//     --deposit-only

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
import { buildSignedIntent } from "../scripts/lib/nep413-sign.mjs";

const NETWORK = "mainnet";
const WRAP = "wrap.near";
const INTENTS = "intents.near";
const TOKEN_ID = `nep141:${WRAP}`;

const YOCTO_PER_NEAR = 10n ** 24n;
const ONE_YOCTO = "1";
const MAX_TX_GAS_TGAS = 1_000;
const DEFAULT_DEADLINE_MS = 5 * 60 * 1000; // 5 min from tx submission

const { values } = parseArgs({
  options: {
    signer: { type: "string" },
    "smart-account": { type: "string" },
    "amount-near": { type: "string" },
    // Who gets credited on intents.near between steps 2 and 3, and who
    // signs the ft_withdraw intent in step 3. Defaults to --signer.
    "credit-to": { type: "string" },
    // Collapses the plan to 2 steps (near_deposit + ft_transfer_call),
    // matching the original onboard-only flagship. No signed intent,
    // no round-trip withdraw.
    "deposit-only": { type: "boolean", default: false },
    // Overrides (rare — keep defaults in practice).
    wrap: { type: "string", default: WRAP },
    intents: { type: "string", default: INTENTS },
    "token-id": { type: "string", default: TOKEN_ID },
    // Gas knobs. Per-outer-action floor observed on mainnet is 300
    // TGas/step for multi-step plans; the PV 83 ceiling is 1 PGas
    // (1000 TGas) per tx total. 3 steps at 300 TGas leaves 100 TGas
    // headroom.
    "action-gas": { type: "string", default: "300" },
    "wrap-gas": { type: "string", default: "30" },
    "deposit-gas": { type: "string", default: "150" },
    "withdraw-gas": { type: "string", default: "150" },
    "assertion-gas": { type: "string", default: "15" },
    // Signed intent deadline window from tx submission.
    "intent-deadline-ms": { type: "string", default: String(DEFAULT_DEADLINE_MS) },
    // Observation knobs.
    "poll-ms": { type: "string", default: "2000" },
    "step-register-timeout-ms": { type: "string", default: "30000" },
    "resolve-timeout-ms": { type: "string", default: "180000" },
    // Battletest: deliberately poison a step's Asserted expected_return
    // so its postcheck will fail the byte-match, forcing the sequencer to
    // halt the sequence before subsequent steps fire. --poison-step=2
    // makes step 2's expected off by +1 yocto; --poison-step=3 poisons
    // step 3's withdraw postcheck. Use only on a dev/lab account — the
    // preceding step's on-chain effect DOES land and is not rolled back.
    "poison-step": { type: "string" },
    // Battletest: substitute the Asserted policy's assertion_method with
    // a non-existent method name on the target contract. Probes how the
    // sequencer handles *view-call errors* (MethodNotFound) during the
    // postcheck phase, versus --poison-step which probes byte mismatch.
    //   --bogus-method=2  → step 2's assertion_method becomes bogus
    //   --bogus-method=3  → step 3's assertion_method becomes bogus
    "bogus-method": { type: "string" },
    // Battletest: make step 1 (Direct) fail by substituting its
    // method_name with a method that does not exist on wrap.near.
    // Probes whether a Direct-policy step halts the sequence on a
    // primary-call failure (vs Asserted where postcheck is the halt
    // surface).
    "fail-step1-method": { type: "boolean", default: false },
    // Output.
    "artifacts-file": { type: "string" },
    dry: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    "skip-preflight": { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (!values.signer) {
  throw new Error("--signer is required (e.g. --signer mike.near)");
}
if (!values["smart-account"]) {
  throw new Error("--smart-account is required (the deployed intent-executor account)");
}
if (!values["amount-near"]) {
  throw new Error("--amount-near is required (e.g. --amount-near 0.01)");
}

const signer = values.signer;
const smartAccount = values["smart-account"];
const creditTo = values["credit-to"] || signer;
const depositOnly = values["deposit-only"];
const wrapAddr = values.wrap;
const intentsAddr = values.intents;
const tokenId = values["token-id"];
const amountYocto = parseNearAmount(values["amount-near"]);
const actionGasTgas = parsePositiveInt(values["action-gas"], "--action-gas");
const wrapGasTgas = parsePositiveInt(values["wrap-gas"], "--wrap-gas");
const depositGasTgas = parsePositiveInt(values["deposit-gas"], "--deposit-gas");
const withdrawGasTgas = parsePositiveInt(values["withdraw-gas"], "--withdraw-gas");
const assertionGasTgas = parsePositiveInt(values["assertion-gas"], "--assertion-gas");
const intentDeadlineMs = parsePositiveInt(
  values["intent-deadline-ms"],
  "--intent-deadline-ms"
);
const pollMs = parsePositiveInt(values["poll-ms"], "--poll-ms");
const registerTimeoutMs = parsePositiveInt(
  values["step-register-timeout-ms"],
  "--step-register-timeout-ms"
);
const resolveTimeoutMs = parsePositiveInt(
  values["resolve-timeout-ms"],
  "--resolve-timeout-ms"
);

// Battletest poison parser. Only "2" and "3" are meaningful targets;
// "1" is a Direct step with no Asserted postcheck to poison.
let poisonStep = null;
if (values["poison-step"]) {
  if (values["poison-step"] !== "2" && values["poison-step"] !== "3") {
    throw new Error("--poison-step must be '2' or '3' (step 1 is Direct)");
  }
  if (depositOnly && values["poison-step"] === "3") {
    throw new Error("--poison-step=3 is incompatible with --deposit-only (no step 3)");
  }
  poisonStep = values["poison-step"];
}
let bogusMethodStep = null;
if (values["bogus-method"]) {
  if (values["bogus-method"] !== "2" && values["bogus-method"] !== "3") {
    throw new Error("--bogus-method must be '2' or '3' (step 1 is Direct)");
  }
  if (depositOnly && values["bogus-method"] === "3") {
    throw new Error("--bogus-method=3 is incompatible with --deposit-only (no step 3)");
  }
  bogusMethodStep = values["bogus-method"];
}
const BOGUS_METHOD_NAME = "bogus_method_does_not_exist";

const stepCount = depositOnly ? 2 : 3;
const totalOuterGasTgas = actionGasTgas * stepCount;
if (totalOuterGasTgas > MAX_TX_GAS_TGAS) {
  throw new Error(
    `${stepCount}-step plan at ${actionGasTgas} TGas/action exceeds the ${MAX_TX_GAS_TGAS} TGas tx envelope`
  );
}

// The ft_withdraw intent is signed now at script start, but executes
// inside step 3 after steps 1+2 settle. We anchor its deadline here
// (default 5 min) to give enough headroom for the preceding steps
// plus verifier latency.
const intentDeadlineIso = new Date(Date.now() + intentDeadlineMs).toISOString();

const runId = Date.now().toString(36);
const artifactsFile = values["artifacts-file"] || defaultArtifactsFile(signer, runId);

// ---------------------------------------------------------------- preflight
async function preflight() {
  const wrapStorage = await callView(NETWORK, wrapAddr, "storage_balance_of", {
    account_id: smartAccount,
  });
  // For the ft_withdraw in step 3 to land, the signer's wrap.near
  // storage must also be registered (the verifier's internal
  // ft_transfer fails otherwise). It's almost always already
  // registered (signer wrapped NEAR before), but we check anyway.
  const signerWrapStorage = await callView(NETWORK, wrapAddr, "storage_balance_of", {
    account_id: creditTo,
  });
  return {
    wrap_storage_smart_account: wrapStorage,
    wrap_storage_signer: signerWrapStorage,
    wrap_missing_smart_account: !wrapStorage,
    wrap_missing_signer: !signerWrapStorage && !depositOnly,
  };
}

// ------------------------------------------------------- read current state
async function getIntentsBalance(accountId) {
  try {
    const { value } = await callViewMethod(NETWORK, intentsAddr, "mt_balance_of", {
      account_id: accountId,
      token_id: tokenId,
    });
    return BigInt(value ?? "0");
  } catch {
    return 0n;
  }
}

async function getWrapBalance(accountId) {
  const value = await callView(NETWORK, wrapAddr, "ft_balance_of", {
    account_id: accountId,
  });
  return BigInt(value ?? "0");
}

// ------------------------------------------------------------------- plan
function buildPlan({ prevIntentsBalance, prevSignerWrapBalance, signedWithdrawIntent }) {
  const expectedIntentsBalance = prevIntentsBalance + amountYocto;
  const expectedSignerWrapBalance = prevSignerWrapBalance + amountYocto;
  // Battletest poisoning: off by +1 yocto on the target step's expected.
  // The actual on-chain state lands normally; only the Asserted byte-match
  // diverges, so we can observe the halt-on-mismatch behaviour cleanly.
  const intentsExpectedForAssertion =
    poisonStep === "2" ? expectedIntentsBalance + 1n : expectedIntentsBalance;
  const signerWrapExpectedForAssertion =
    poisonStep === "3" ? expectedSignerWrapBalance + 1n : expectedSignerWrapBalance;

  const wrapStep = {
    step_id: `wrap-${runId}`,
    target_id: wrapAddr,
    method_name: values["fail-step1-method"]
      ? "bogus_method_does_not_exist"
      : "near_deposit",
    args: base64Json({}),
    attached_deposit_yocto: amountYocto.toString(),
    gas_tgas: wrapGasTgas,
    // policy omitted → Direct (default)
  };
  const depositStep = {
    step_id: `deposit-${runId}`,
    target_id: wrapAddr,
    method_name: "ft_transfer_call",
    args: base64Json({
      receiver_id: intentsAddr,
      amount: amountYocto.toString(),
      // DepositMessage JSON object form. `refund_if_fails: true` refunds
      // the deposit on any inline-intent error (we pass no inline
      // intents here — step 3 is a separate execute_intents call).
      msg: JSON.stringify({
        receiver_id: creditTo,
        refund_if_fails: true,
      }),
    }),
    attached_deposit_yocto: ONE_YOCTO,
    gas_tgas: depositGasTgas,
    policy: {
      Asserted: {
        assertion_id: intentsAddr,
        assertion_method: bogusMethodStep === "2" ? BOGUS_METHOD_NAME : "mt_balance_of",
        assertion_args: base64Json({
          account_id: creditTo,
          token_id: tokenId,
        }),
        // mt_balance_of returns U128 (JSON-encoded as a string).
        expected_return: base64Utf8(JSON.stringify(intentsExpectedForAssertion.toString())),
        assertion_gas_tgas: assertionGasTgas,
      },
    },
  };

  const steps = [wrapStep, depositStep];
  let expectedSignerWrapBalanceAfterWithdraw = null;

  if (!depositOnly) {
    const withdrawStep = {
      step_id: `withdraw-${runId}`,
      target_id: intentsAddr,
      method_name: "execute_intents",
      args: base64Json({
        signed: [signedWithdrawIntent],
      }),
      attached_deposit_yocto: "0",
      gas_tgas: withdrawGasTgas,
      policy: {
        Asserted: {
          assertion_id: wrapAddr,
          assertion_method: bogusMethodStep === "3" ? BOGUS_METHOD_NAME : "ft_balance_of",
          assertion_args: base64Json({
            account_id: creditTo,
          }),
          expected_return: base64Utf8(
            JSON.stringify(signerWrapExpectedForAssertion.toString())
          ),
          assertion_gas_tgas: assertionGasTgas,
        },
      },
    };
    steps.push(withdrawStep);
    expectedSignerWrapBalanceAfterWithdraw = expectedSignerWrapBalance;
  }

  return {
    steps,
    expected_intents_balance_yocto: expectedIntentsBalance,
    expected_signer_wrap_balance_after_withdraw_yocto: expectedSignerWrapBalanceAfterWithdraw,
  };
}

function buildWithdrawIntent({ nearApi, keyPair }) {
  const intent = {
    intent: "ft_withdraw",
    token: wrapAddr,
    receiver_id: creditTo,
    amount: amountYocto.toString(),
  };
  return buildSignedIntent({
    nearApi,
    keyPair,
    signerId: creditTo,
    intents: [intent],
    recipient: intentsAddr,
    deadline: intentDeadlineIso,
  });
}

// ------------------------------------------------------------------- main
const preflightInfo = values["skip-preflight"]
  ? { skipped: true, wrap_missing_smart_account: false, wrap_missing_signer: false }
  : await preflight();

if (!values["skip-preflight"]) {
  if (preflightInfo.wrap_missing_smart_account) {
    console.error(
      `preflight: ${smartAccount} is not registered on ${wrapAddr} (needed to hold wNEAR during step 1/2).`
    );
    console.error(
      `  near call ${wrapAddr} storage_deposit '{"account_id":"${smartAccount}","registration_only":true}' --accountId ${signer} --deposit 0.00125`
    );
    console.error(`(or pass --skip-preflight to bypass)`);
    process.exit(1);
  }
  if (preflightInfo.wrap_missing_signer) {
    console.error(
      `preflight: ${creditTo} is not registered on ${wrapAddr} — ft_withdraw in step 3 would fail.`
    );
    console.error(
      `  near call ${wrapAddr} storage_deposit '{"account_id":"${creditTo}","registration_only":true}' --accountId ${signer} --deposit 0.00125`
    );
    console.error(`(or pass --deposit-only to skip the withdraw step, or --skip-preflight to bypass)`);
    process.exit(1);
  }
}

const { nearApi, keyStore, accounts } = await connectNearWithSigners(NETWORK, [
  signer,
  ...(creditTo !== signer ? [creditTo] : []),
]);
const account = accounts[signer];
// The ft_withdraw intent must be signed by the account that owns the
// balance on intents.near — that's `creditTo`, which defaults to the
// signer but can be overridden. We loaded both credentials above.
const withdrawKeyPair = depositOnly ? null : await keyStore.getKey(NETWORK, creditTo);
if (!depositOnly && !withdrawKeyPair) {
  throw new Error(
    `no KeyPair for ${creditTo} in keystore — intent-sequence needs it to sign ft_withdraw`
  );
}

const wrapBalanceBeforeSmartAccount = await getWrapBalance(smartAccount);
const wrapBalanceBeforeSigner = await getWrapBalance(creditTo);
const prevIntentsBalance = await getIntentsBalance(creditTo);

const signedWithdrawIntent = depositOnly
  ? null
  : buildWithdrawIntent({ nearApi, keyPair: withdrawKeyPair });

const {
  steps: plan,
  expected_intents_balance_yocto: expectedIntentsBalance,
  expected_signer_wrap_balance_after_withdraw_yocto: expectedSignerWrapBalance,
} = buildPlan({
  prevIntentsBalance,
  prevSignerWrapBalance: wrapBalanceBeforeSigner,
  signedWithdrawIntent,
});

if (values.dry) {
  printDry({
    plan,
    preflight: preflightInfo,
    wrapBalanceBeforeSmartAccount,
    wrapBalanceBeforeSigner,
    prevIntentsBalance,
    expectedIntentsBalance,
    expectedSignerWrapBalance,
    signedWithdrawIntent,
  });
  process.exit(0);
}

const functionCall = nearApi.transactions.functionCall(
  "execute_steps",
  Buffer.from(JSON.stringify({ steps: plan })),
  BigInt(totalOuterGasTgas) * 10n ** 12n,
  0n
);

const result = await sendTransactionAsync(account, smartAccount, [functionCall]);
const txArtifact = await buildTxArtifact(NETWORK, result, signer, "execute_steps");
const registerDiagnosis = await diagnoseRegisterTransaction({
  network: NETWORK,
  txHash: txArtifact.tx_hash,
  signer,
  contractId: smartAccount,
  expectedCount: plan.length,
  pollMs,
  timeoutMs: registerTimeoutMs,
});

const terminalState = await waitForTerminalState({
  smartAccount,
  signer,
  pollMs,
  timeoutMs: resolveTimeoutMs,
  startedAfterBlock: registerDiagnosis.registered_state.block_height,
});

const wrapBalanceAfterSmartAccount = await getWrapBalance(smartAccount);
const wrapBalanceAfterSigner = await getWrapBalance(creditTo);
const newIntentsBalance = await getIntentsBalance(creditTo);
const trace = await safeTrace(txArtifact.tx_hash, signer);

const artifacts = {
  generated_at: new Date().toISOString(),
  run_id: runId,
  network: NETWORK,
  mode: depositOnly ? "deposit-only" : "round-trip",
  step_count: plan.length,
  signer,
  smart_account: smartAccount,
  credit_to: creditTo,
  wrap: wrapAddr,
  intents: intentsAddr,
  token_id: tokenId,
  amount_near: values["amount-near"],
  amount_yocto: amountYocto.toString(),
  action_gas_tgas: actionGasTgas,
  wrap_gas_tgas: wrapGasTgas,
  deposit_gas_tgas: depositGasTgas,
  withdraw_gas_tgas: depositOnly ? null : withdrawGasTgas,
  assertion_gas_tgas: assertionGasTgas,
  intent_deadline_iso: depositOnly ? null : intentDeadlineIso,
  preflight: preflightInfo,
  plan,
  signed_withdraw_intent: signedWithdrawIntent,
  wrap_balance_before_smart_account_yocto: wrapBalanceBeforeSmartAccount.toString(),
  wrap_balance_before_signer_yocto: wrapBalanceBeforeSigner.toString(),
  prev_intents_balance_yocto: prevIntentsBalance.toString(),
  expected_intents_balance_yocto: expectedIntentsBalance.toString(),
  expected_signer_wrap_balance_after_withdraw_yocto:
    expectedSignerWrapBalance !== null ? expectedSignerWrapBalance.toString() : null,
  txs: [txArtifact],
  register_diagnosis: registerDiagnosis,
  terminal_state: terminalState,
  wrap_balance_after_smart_account_yocto: wrapBalanceAfterSmartAccount.toString(),
  wrap_balance_after_signer_yocto: wrapBalanceAfterSigner.toString(),
  new_intents_balance_yocto: newIntentsBalance.toString(),
  intents_balance_delta_yocto: (newIntentsBalance - prevIntentsBalance).toString(),
  signer_wrap_balance_delta_yocto: (wrapBalanceAfterSigner - wrapBalanceBeforeSigner).toString(),
  traces: {
    execute_steps: summarizeTrace(trace),
  },
  artifacts_file: artifactsFile,
  commands: commandSet({
    signer,
    smartAccount,
    intentsAddr,
    wrapAddr,
    tokenId,
    creditTo,
    executeStepsTxHash: txArtifact.tx_hash,
  }),
};

fs.mkdirSync(path.dirname(artifactsFile), { recursive: true });
fs.writeFileSync(artifactsFile, `${JSON.stringify(artifacts, null, 2)}\n`);

if (values.json) {
  console.log(JSON.stringify(artifacts, null, 2));
  process.exit(matchedExitCode(artifacts));
}

printHumanSummary(artifacts);
process.exit(matchedExitCode(artifacts));

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
  const tag = depositOnly ? "intent-sequence-deposit-only" : "intent-sequence-round-trip";
  return path.join(
    REPO_ROOT,
    "collab",
    "artifacts",
    `${stamp}-${tag}-${signerId.replace(/\./g, "-")}-${id}.json`
  );
}

async function waitForTerminalState({
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
        NETWORK,
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
    note: "a step may still be pending — check registered_steps_for and run trace-tx on the execute_steps tx",
  };
}

async function safeTrace(txHash, signer, { retries = 3, delayMs = 2000 } = {}) {
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const traced = await traceTx(NETWORK, txHash, signer, "FINAL");
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

function commandSet({ signer, smartAccount, intentsAddr, wrapAddr, tokenId, creditTo, executeStepsTxHash }) {
  return {
    trace_execute:
      `./scripts/trace-tx.mjs ${executeStepsTxHash} ${signer} --wait FINAL`,
    investigate_execute:
      `./scripts/investigate-tx.mjs ${executeStepsTxHash} ${signer} --wait FINAL ` +
      `--accounts ${smartAccount},${wrapAddr},${intentsAddr}`,
    intents_balance_view:
      `./scripts/state.mjs ${intentsAddr} --method mt_balance_of --args '${JSON.stringify({
        account_id: creditTo,
        token_id: tokenId,
      })}'`,
    signer_wrap_balance_view:
      `./scripts/state.mjs ${wrapAddr} --method ft_balance_of --args '${JSON.stringify({
        account_id: creditTo,
      })}'`,
    registered_steps_view:
      `./scripts/state.mjs ${smartAccount} --method registered_steps_for --args '${JSON.stringify({
        caller_id: signer,
      })}'`,
  };
}

function matchedExitCode(a) {
  const intentsMatch =
    a.new_intents_balance_yocto === a.expected_intents_balance_yocto;
  if (a.mode === "deposit-only") {
    return intentsMatch ? 0 : 1;
  }
  // Round-trip: intents_balance returns to prev (delta 0) AND signer
  // wrap balance up by amount.
  const roundTripIntentsMatch = a.intents_balance_delta_yocto === "0";
  const signerWrapMatch =
    a.wrap_balance_after_signer_yocto ===
    a.expected_signer_wrap_balance_after_withdraw_yocto;
  return roundTripIntentsMatch && signerWrapMatch ? 0 : 1;
}

function printDry({
  plan,
  preflight,
  wrapBalanceBeforeSmartAccount,
  wrapBalanceBeforeSigner,
  prevIntentsBalance,
  expectedIntentsBalance,
  expectedSignerWrapBalance,
  signedWithdrawIntent,
}) {
  console.log(
    JSON.stringify(
      {
        network: NETWORK,
        mode: depositOnly ? "deposit-only" : "round-trip",
        step_count: plan.length,
        signer,
        smart_account: smartAccount,
        credit_to: creditTo,
        wrap: wrapAddr,
        intents: intentsAddr,
        token_id: tokenId,
        amount_near: values["amount-near"],
        amount_yocto: amountYocto.toString(),
        action_gas_tgas: actionGasTgas,
        intent_deadline_iso: depositOnly ? null : intentDeadlineIso,
        preflight,
        wrap_balance_before_smart_account_yocto: wrapBalanceBeforeSmartAccount.toString(),
        wrap_balance_before_signer_yocto: wrapBalanceBeforeSigner.toString(),
        prev_intents_balance_yocto: prevIntentsBalance.toString(),
        expected_intents_balance_yocto: expectedIntentsBalance.toString(),
        expected_signer_wrap_balance_after_withdraw_yocto:
          expectedSignerWrapBalance !== null ? expectedSignerWrapBalance.toString() : null,
        plan,
        signed_withdraw_intent: signedWithdrawIntent,
      },
      null,
      2
    )
  );
}

function printHumanSummary(a) {
  console.log(
    `network=${a.network} mode=${a.mode} signer=${a.signer} smart_account=${a.smart_account} credit_to=${a.credit_to} amount=${a.amount_near} NEAR`
  );
  console.log(
    `execute_steps: tx_hash=${a.txs[0].tx_hash} block_height=${a.txs[0].block_height ?? "?"}`
  );
  console.log(renderStepOutcomeSummary(a.register_diagnosis.step_outcome));
  console.log(
    `wrap_balance(signer ${a.credit_to}): ${a.wrap_balance_before_signer_yocto} → ${a.wrap_balance_after_signer_yocto} (delta ${a.signer_wrap_balance_delta_yocto})`
  );
  console.log(
    `intents_balance(${a.credit_to}, ${a.token_id}): ${a.prev_intents_balance_yocto} → ${a.new_intents_balance_yocto} (delta ${a.intents_balance_delta_yocto})`
  );
  if (a.mode === "round-trip") {
    console.log(
      `round-trip expectation: intents_delta=0 AND signer_wrap=${a.expected_signer_wrap_balance_after_withdraw_yocto}`
    );
  } else {
    console.log(
      `deposit-only expectation: intents_balance=${a.expected_intents_balance_yocto}`
    );
  }
  console.log(`reached=${a.terminal_state.reached}`);
  console.log(`trace: ${a.commands.trace_execute}`);
  console.log(`investigate: ${a.commands.investigate_execute}`);
  console.log(`intents_balance_view: ${a.commands.intents_balance_view}`);
  console.log(`signer_wrap_balance_view: ${a.commands.signer_wrap_balance_view}`);
  console.log(`artifacts=${a.artifacts_file}`);
  console.log(`short=${shortHash(a.txs[0].tx_hash)}`);
}
