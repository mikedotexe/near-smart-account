#!/usr/bin/env node
//
// examples/intents-deposit-limit.mjs — composes FOUR v4 primitives in a
// single real-dapp narrative on mainnet `intents.near`:
//
//   1. Owner (main FAK) signs ONE `enroll_session` tx. Smart account
//      mints a function-call access key on itself restricted to
//      `execute_trigger`, allowlisted for two trigger ids below.
//
//   2. Dapp (the script) fires two different triggers with the
//      ephemeral session key — no wallet prompts.
//
//   - Pass trigger: sequence template whose step 2 `pre_gate`'s
//     `min_bytes` sits BELOW the current Ref quote. Gate passes, target
//     dispatches, wNEAR is transferred into `intents.near`, mt balance
//     credited.
//
//   - Halt trigger: identical template except step 2's `pre_gate`'s
//     `min_bytes` sits ABOVE the current Ref quote. Gate halts cleanly
//     at `pre_gate_checked.outcome: "below_min"`, target never fires,
//     no deposit, event stream still auditable.
//
//   3. Each sequence's step 1 reads `wrap.near.ft_balance_of` and
//      SAVES the result into `wnear_balance`, and is itself gated on
//      the same view with `min_bytes: "1"` (zero-balance guard).
//
//   4. Step 2's `args_template` substitutes
//      `PercentU128 { bps: <ladder-bps> }` of `wnear_balance` into the
//      outer `amount` field of `ft_transfer_call`. 100 bps = 1% sweep
//      per fire.
//
//   5. Owner signs `revoke_session` to delete state + AK atomically.
//      Last fire attempt from ephemeral key is rejected by the NEAR
//      runtime ("access key not found").
//
// Primitives exercised in one artifact: PreGate × 2 (balance-floor +
// Ref-price), save_result + args_template (threading), session keys +
// BalanceTrigger.
//
// MAINNET-ONLY — `intents.near` is mainnet.
//
// Usage:
//   ./examples/intents-deposit-limit.mjs \
//     --signer mike.near \
//     --smart-account mike.near
//
// Dry run (print the plan + materialized preview, don't submit):
//   ./examples/intents-deposit-limit.mjs \
//     --signer mike.near \
//     --smart-account mike.near \
//     --dry

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import {
  decodeSuccessValue,
  REPO_ROOT,
  shortHash,
  sleep,
} from "../scripts/lib/fastnear.mjs";
import {
  buildTxArtifact,
  callViewMethod,
  connectNearWithSigners,
} from "../scripts/lib/near-cli.mjs";
import {
  extractBlockInfo,
  flattenReceiptTree,
  traceTx,
} from "../scripts/lib/trace-rpc.mjs";

const NETWORK = process.env.NETWORK || "mainnet";
const WRAP = "wrap.near";
const INTENTS = "intents.near";
const REF = "v2.ref-finance.near";
const USDT = "usdt.tether-token.near";
const TOKEN_ID = `nep141:${WRAP}`;

const { values } = parseArgs({
  options: {
    signer: { type: "string" },
    "smart-account": { type: "string" },
    // Ref Finance gating surface. Pool 3879 = wrap.near / usdt.tether-token.near
    // on mainnet v2.ref-finance.near (verified 2026-04-19).
    "ref-pool-id": { type: "string", default: "3879" },
    "token-in": { type: "string", default: WRAP },
    "token-out": { type: "string", default: USDT },
    // Probe amount for the price query — 1 NEAR as a u128 yocto string.
    "probe-amount-in": { type: "string", default: "1000000000000000000000000" },
    // Gate thresholds (bare u128 strings, 6-decimal USDT scale).
    // Defaults chosen from a mainnet probe (current ~1.4 USDT/NEAR):
    //   pass  = 500000 ($0.50; guaranteed to pass at any plausible price)
    //   halt  = 5000000000 ($5000.00 per NEAR; guaranteed to halt)
    "pass-min-usdt": { type: "string", default: "500000" },
    "halt-min-usdt": { type: "string", default: "5000000000" },
    // Ladder: what percent of wNEAR balance to sweep per fire.
    // 100 bps = 1%. Default keeps demo amounts small on mainnet.
    "ladder-bps": { type: "string", default: "100" },
    // Skip the halt demo (useful for first-run sanity).
    "skip-halt": { type: "boolean", default: false },
    // Session-key knobs.
    "session-ms": { type: "string", default: "1800000" }, // 30 min
    "max-fires": { type: "string", default: "4" }, // 1 pass + 1 halt + 1 post-revoke (+ headroom)
    "allowance-near": { type: "string", default: "1.5" },
    label: { type: "string" },
    // Gas knobs.
    "balance-gas-tgas": { type: "string", default: "15" },
    "deposit-gas-tgas": { type: "string", default: "80" },
    "balance-gate-gas-tgas": { type: "string", default: "15" },
    "ref-gate-gas-tgas": { type: "string", default: "30" },
    "owner-gas-tgas": { type: "string", default: "100" },
    "execute-gas-tgas": { type: "string", default: "300" },
    "revoke-gas-tgas": { type: "string", default: "50" },
    "trigger-min-balance-yocto": { type: "string", default: "1" },
    "trigger-max-runs": { type: "string", default: "10" },
    "poll-ms": { type: "string", default: "2500" },
    "resolve-timeout-ms": { type: "string", default: "180000" },
    // Output.
    "artifacts-file": { type: "string" },
    dry: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (!values.signer) throw new Error("--signer is required");
if (!values["smart-account"]) throw new Error("--smart-account is required");

const signer = values.signer;
const smartAccount = values["smart-account"];
const refPoolId = Number(values["ref-pool-id"]);
const tokenIn = values["token-in"];
const tokenOut = values["token-out"];
const probeAmountIn = values["probe-amount-in"];
const passMinUsdt = values["pass-min-usdt"];
const haltMinUsdt = values["halt-min-usdt"];
const ladderBps = parsePositiveInt(values["ladder-bps"], "--ladder-bps");
if (ladderBps > 10000) throw new Error("--ladder-bps must be in [1, 10000]");
const skipHalt = values["skip-halt"];
const sessionMs = parsePositiveInt(values["session-ms"], "--session-ms");
const maxFires = parsePositiveInt(values["max-fires"], "--max-fires");
const allowanceYocto = nearToYocto(values["allowance-near"]);
const balanceGasTgas = parsePositiveInt(values["balance-gas-tgas"], "--balance-gas-tgas");
const depositGasTgas = parsePositiveInt(values["deposit-gas-tgas"], "--deposit-gas-tgas");
const balanceGateGasTgas = parsePositiveInt(
  values["balance-gate-gas-tgas"],
  "--balance-gate-gas-tgas"
);
const refGateGasTgas = parsePositiveInt(
  values["ref-gate-gas-tgas"],
  "--ref-gate-gas-tgas"
);
const ownerGasTgas = parsePositiveInt(values["owner-gas-tgas"], "--owner-gas-tgas");
const executeGasTgas = parsePositiveInt(values["execute-gas-tgas"], "--execute-gas-tgas");
const revokeGasTgas = parsePositiveInt(values["revoke-gas-tgas"], "--revoke-gas-tgas");
const triggerMinBalanceYocto = values["trigger-min-balance-yocto"];
const triggerMaxRuns = parsePositiveInt(
  values["trigger-max-runs"],
  "--trigger-max-runs"
);
const pollMs = parsePositiveInt(values["poll-ms"], "--poll-ms");
const resolveTimeoutMs = parsePositiveInt(
  values["resolve-timeout-ms"],
  "--resolve-timeout-ms"
);

const runId = new Date().toISOString().replace(/[:.-]/g, "").slice(0, 14);
const sequenceIdPass = `intents-deposit-limit-pass-${runId}`;
const sequenceIdHalt = `intents-deposit-limit-halt-${runId}`;
const triggerIdPass = `${sequenceIdPass}-trigger`;
const triggerIdHalt = `${sequenceIdHalt}-trigger`;
const label = values.label ?? `intents-deposit-limit-${runId}`;

// ---------- template shape -------------------------------------------

function buildTemplate(minUsdtBytes) {
  const step1 = {
    step_id: "read-wnear-balance",
    target_id: WRAP,
    method_name: "ft_balance_of",
    args: base64Json({ account_id: smartAccount }),
    attached_deposit_yocto: "0",
    gas_tgas: balanceGasTgas,
    pre_gate: {
      gate_id: WRAP,
      gate_method: "ft_balance_of",
      gate_args: base64Json({ account_id: smartAccount }),
      // Raw bytes of JSON-quoted u128; the kernel parses this under
      // U128Json and strips the outer quotes. "1" means any non-zero.
      min_bytes: base64Utf8("1"),
      max_bytes: null,
      comparison: "U128Json",
      gate_gas_tgas: balanceGateGasTgas,
    },
    save_result: {
      as_name: "wnear_balance",
      kind: "U128Json",
    },
    // policy omitted → Direct
  };

  // Step 2 template: amount field uses the substitution "${wnear_balance}"
  // WITH surrounding JSON quotes. The kernel's placeholder regex is
  // `"${<ref>}"` (types.rs:396, quotes included), and `PercentU128`
  // emits a JSON-quoted u128 (e.g. `"500"`). Quoted-in, quoted-out —
  // the net effect is a valid JSON string for NEP-141's `amount` field.
  const step2TemplateStr =
    `{"receiver_id":"${INTENTS}","amount":"\${wnear_balance}","msg":"${escapeJsonString(
      JSON.stringify({ receiver_id: signer, refund_if_fails: true })
    )}"}`;

  const step2 = {
    step_id: "deposit-into-intents",
    target_id: WRAP,
    method_name: "ft_transfer_call",
    // `args` is ignored when `args_template` is set; retain the template
    // string so callers inspecting the plan see something sensible.
    args: base64Utf8(step2TemplateStr),
    attached_deposit_yocto: "1",
    gas_tgas: depositGasTgas,
    pre_gate: {
      gate_id: REF,
      gate_method: "get_return",
      gate_args: base64Json({
        pool_id: refPoolId,
        token_in: tokenIn,
        amount_in: probeAmountIn,
        token_out: tokenOut,
      }),
      min_bytes: base64Utf8(minUsdtBytes),
      max_bytes: null,
      comparison: "U128Json",
      gate_gas_tgas: refGateGasTgas,
    },
    args_template: {
      template: base64Utf8(step2TemplateStr),
      substitutions: [
        {
          reference: "wnear_balance",
          op: { PercentU128: { bps: ladderBps } },
        },
      ],
    },
    // policy omitted → Direct. `Asserted { expected_return }` can't
    // handle a post-tick mt balance that grows each fire (same trade-off
    // as `examples/dca.mjs`); PreGate + `refund_if_fails:true` is the
    // safety surface.
  };

  return [step1, step2];
}

const templatePass = buildTemplate(passMinUsdt);
const templateHalt = buildTemplate(haltMinUsdt);

// ---------- prelude: probe current conditions ------------------------

const priorWnearBalance = await safeView(WRAP, "ft_balance_of", {
  account_id: smartAccount,
});
const priorIntentsBalance = await safeView(INTENTS, "mt_balance_of", {
  account_id: signer,
  token_id: TOKEN_ID,
});
const priorRefQuote = await safeView(REF, "get_return", {
  pool_id: refPoolId,
  token_in: tokenIn,
  amount_in: probeAmountIn,
  token_out: tokenOut,
});
const priorContractVersion = await safeView(smartAccount, "contract_version", {});

console.log("intents-deposit-limit demo — plan");
console.log("  network          :", NETWORK);
console.log("  smart account    :", smartAccount);
console.log("  signer (owner)   :", signer);
console.log("  contract version :", priorContractVersion ?? "(unknown)");
console.log("  wNEAR balance    :", priorWnearBalance, "yocto");
console.log("  intents wNEAR    :", priorIntentsBalance, `yocto (credit-to=${signer})`);
console.log("  ref pool         :", refPoolId, `(${tokenIn} → ${tokenOut})`);
console.log(
  "  ref quote        :",
  priorRefQuote ?? "(view failed)",
  `(for ${probeAmountIn} in)`
);
console.log("  pass min_usdt    :", passMinUsdt, "→ gate should pass");
console.log("  halt min_usdt    :", haltMinUsdt, "→ gate should halt");
console.log("  ladder bps       :", ladderBps, `(${(ladderBps / 100).toFixed(2)}% sweep per fire)`);
console.log("  session duration :", `${(sessionMs / 60000).toFixed(1)}m`);
console.log("  max fires        :", maxFires);
console.log("  allowance yocto  :", allowanceYocto);
console.log("  runId            :", runId);
console.log("");
console.log("  pass template    :", sequenceIdPass);
console.log("  halt template    :", sequenceIdHalt);
console.log("  pass trigger     :", triggerIdPass);
console.log("  halt trigger     :", triggerIdHalt);

// Preview materialized step-2 args for operator sanity (before --dry exit).
if (priorWnearBalance) {
  const swept =
    (BigInt(priorWnearBalance) * BigInt(ladderBps)) / 10000n;
  console.log("  preview step-2   :");
  console.log("    sweep amount   :", swept.toString(), "yocto wNEAR");
  console.log(
    "    materialized   :",
    `{"receiver_id":"${INTENTS}","amount":"${swept}","msg":"..."}`
  );
}

// Connect near-api (needed for both dry + live so ephemeral key can be
// minted to show the session_public_key before enrollment).
const { nearApi, near, keyStore, accounts } = await connectNearWithSigners(
  NETWORK,
  [signer]
);
const ownerAccount = accounts[signer];
const ephemeralKeyPair = nearApi.KeyPair.fromRandom("ed25519");
const sessionPk = ephemeralKeyPair.getPublicKey().toString();
const now = Date.now();
const expiresAtMs = now + sessionMs;

console.log("");
console.log("  session pk       :", sessionPk);
console.log("  expires at       :", new Date(expiresAtMs).toISOString());

if (values.dry) {
  console.log("\n(dry run — not submitting)");
  console.log("\npass-template step-2 args_template (raw):");
  console.log(Buffer.from(templatePass[1].args_template.template, "base64").toString("utf8"));
  process.exit(0);
}

// ---------- 1. save both templates -----------------------------------

console.log("\n[1/5] saving sequence templates (owner)");
const saveTemplatePass = await ownerAccount.signAndSendTransaction({
  receiverId: smartAccount,
  actions: [
    nearApi.transactions.functionCall(
      "save_sequence_template",
      Buffer.from(
        JSON.stringify({ sequence_id: sequenceIdPass, calls: templatePass })
      ),
      BigInt(ownerGasTgas) * 10n ** 12n,
      0n
    ),
  ],
});
console.log("  pass template tx :", saveTemplatePass.transaction.hash);

const saveTemplateHalt = skipHalt
  ? null
  : await ownerAccount.signAndSendTransaction({
      receiverId: smartAccount,
      actions: [
        nearApi.transactions.functionCall(
          "save_sequence_template",
          Buffer.from(
            JSON.stringify({ sequence_id: sequenceIdHalt, calls: templateHalt })
          ),
          BigInt(ownerGasTgas) * 10n ** 12n,
          0n
        ),
      ],
    });
if (saveTemplateHalt) {
  console.log("  halt template tx :", saveTemplateHalt.transaction.hash);
}

// ---------- 2. create balance triggers -------------------------------

console.log("\n[2/5] creating balance triggers (owner)");
const createTriggerPass = await ownerAccount.signAndSendTransaction({
  receiverId: smartAccount,
  actions: [
    nearApi.transactions.functionCall(
      "create_balance_trigger",
      Buffer.from(
        JSON.stringify({
          trigger_id: triggerIdPass,
          sequence_id: sequenceIdPass,
          min_balance_yocto: triggerMinBalanceYocto,
          max_runs: triggerMaxRuns,
        })
      ),
      BigInt(ownerGasTgas) * 10n ** 12n,
      0n
    ),
  ],
});
console.log("  pass trigger tx  :", createTriggerPass.transaction.hash);

const createTriggerHalt = skipHalt
  ? null
  : await ownerAccount.signAndSendTransaction({
      receiverId: smartAccount,
      actions: [
        nearApi.transactions.functionCall(
          "create_balance_trigger",
          Buffer.from(
            JSON.stringify({
              trigger_id: triggerIdHalt,
              sequence_id: sequenceIdHalt,
              min_balance_yocto: triggerMinBalanceYocto,
              max_runs: triggerMaxRuns,
            })
          ),
          BigInt(ownerGasTgas) * 10n ** 12n,
          0n
        ),
      ],
    });
if (createTriggerHalt) {
  console.log("  halt trigger tx  :", createTriggerHalt.transaction.hash);
}

// ---------- 3. enroll session (owner → ONE FAK tx) -------------------

console.log("\n[3/5] enrolling session key (owner)");
const allowedTriggerIds = skipHalt
  ? [triggerIdPass]
  : [triggerIdPass, triggerIdHalt];
const enrollTx = await ownerAccount.signAndSendTransaction({
  receiverId: smartAccount,
  actions: [
    nearApi.transactions.functionCall(
      "enroll_session",
      Buffer.from(
        JSON.stringify({
          session_public_key: sessionPk,
          expires_at_ms: expiresAtMs,
          allowed_trigger_ids: allowedTriggerIds,
          max_fire_count: maxFires,
          allowance_yocto: allowanceYocto,
          label,
        })
      ),
      BigInt(ownerGasTgas) * 10n ** 12n,
      1n // 1 yocto — proves FAK on owner
    ),
  ],
});
console.log("  enroll tx        :", enrollTx.transaction.hash);

// Save any existing key in the (network, smartAccount) slot so we can
// restore it before revoke. When signer === smartAccount (e.g. mike.near)
// the slot holds the owner FAK and must be restored for revoke to pass
// the FCAK method allowlist. See session-dapp.mjs for background.
const priorSmartAccountKey = await keyStore.getKey(NETWORK, smartAccount);
await keyStore.setKey(NETWORK, smartAccount, ephemeralKeyPair);
const sessionAccount = await near.account(smartAccount);

// ---------- 4. fire both triggers via the session key ----------------

console.log("\n[4/5] firing triggers via session key (ephemeral)");
const fireTxs = [];

const firePassTx = await sessionAccount.signAndSendTransaction({
  receiverId: smartAccount,
  actions: [
    nearApi.transactions.functionCall(
      "execute_trigger",
      Buffer.from(JSON.stringify({ trigger_id: triggerIdPass })),
      BigInt(executeGasTgas) * 10n ** 12n,
      0n
    ),
  ],
});
console.log("  pass fire tx     :", firePassTx.transaction.hash);
fireTxs.push({ mode: "pass", tx_hash: firePassTx.transaction.hash });
await sleep(pollMs);

let fireHaltTx = null;
if (!skipHalt) {
  fireHaltTx = await sessionAccount.signAndSendTransaction({
    receiverId: smartAccount,
    actions: [
      nearApi.transactions.functionCall(
        "execute_trigger",
        Buffer.from(JSON.stringify({ trigger_id: triggerIdHalt })),
        BigInt(executeGasTgas) * 10n ** 12n,
        0n
      ),
    ],
  });
  console.log("  halt fire tx     :", fireHaltTx.transaction.hash);
  fireTxs.push({ mode: "halt", tx_hash: fireHaltTx.transaction.hash });
  await sleep(pollMs);
}

// Grant view post-fires.
const grantAfterFires = await safeView(smartAccount, "get_session", {
  session_public_key: sessionPk,
});

// ---------- 5. revoke session + post-revoke fire attempt -------------

console.log("\n[5/5] revoking session (owner) + post-revoke attempt");
// Restore owner FAK into the keystore slot so revoke_session passes
// the FCAK method allowlist when signer === smartAccount.
if (priorSmartAccountKey) {
  await keyStore.setKey(NETWORK, smartAccount, priorSmartAccountKey);
}
const revokeTx = await ownerAccount.signAndSendTransaction({
  receiverId: smartAccount,
  actions: [
    nearApi.transactions.functionCall(
      "revoke_session",
      Buffer.from(JSON.stringify({ session_public_key: sessionPk })),
      BigInt(revokeGasTgas) * 10n ** 12n,
      0n
    ),
  ],
});
console.log("  revoke tx        :", revokeTx.transaction.hash);

// Swap the ephemeral key back in and attempt one more fire; expect
// NEAR runtime rejection.
await sleep(pollMs * 2);
await keyStore.setKey(NETWORK, smartAccount, ephemeralKeyPair);
let postRevokeAttempt = null;
try {
  const postRevokeTx = await sessionAccount.signAndSendTransaction({
    receiverId: smartAccount,
    actions: [
      nearApi.transactions.functionCall(
        "execute_trigger",
        Buffer.from(JSON.stringify({ trigger_id: triggerIdPass })),
        BigInt(executeGasTgas) * 10n ** 12n,
        0n
      ),
    ],
  });
  postRevokeAttempt = { landed_unexpectedly: postRevokeTx.transaction.hash };
  console.log(
    "  post-revoke      : unexpectedly landed",
    postRevokeTx.transaction.hash
  );
} catch (e) {
  postRevokeAttempt = { rejected: true, message: truncate(String(e.message), 200) };
  console.log("  post-revoke      : rejected (expected)");
}

// Restore owner FAK for any subsequent owner activity outside this run.
if (priorSmartAccountKey) {
  await keyStore.setKey(NETWORK, smartAccount, priorSmartAccountKey);
}

// ---------- trace + artifact ----------------------------------------

const traces = {
  enroll: await safeTrace(enrollTx.transaction.hash, signer),
  fire_pass: await safeTrace(firePassTx.transaction.hash, smartAccount),
  fire_halt: fireHaltTx
    ? await safeTrace(fireHaltTx.transaction.hash, smartAccount)
    : null,
  revoke: await safeTrace(revokeTx.transaction.hash, signer),
};

const newIntentsBalance = await safeView(INTENTS, "mt_balance_of", {
  account_id: signer,
  token_id: TOKEN_ID,
});
const newWnearBalance = await safeView(WRAP, "ft_balance_of", {
  account_id: smartAccount,
});
const grantAfterRevoke = await safeView(smartAccount, "get_session", {
  session_public_key: sessionPk,
});

const eventFilter = new Set([
  "session_enrolled",
  "session_fired",
  "session_revoked",
  "sequence_started",
  "sequence_completed",
  "sequence_halted",
  "step_registered",
  "step_resumed",
  "step_resolved_ok",
  "step_resolved_err",
  "pre_gate_checked",
  "result_saved",
  "trigger_fired",
  "trigger_created",
  "template_saved",
  "run_finished",
]);

function gatherEvents(trace) {
  return trace ? extractEvents(trace, eventFilter) : [];
}

const allEvents = {
  enroll: gatherEvents(traces.enroll),
  fire_pass: gatherEvents(traces.fire_pass),
  fire_halt: gatherEvents(traces.fire_halt),
  revoke: gatherEvents(traces.revoke),
};

const outcomes = {
  fire_pass: classifyFireOutcome(allEvents.fire_pass),
  fire_halt: fireHaltTx ? classifyFireOutcome(allEvents.fire_halt) : "skipped",
};

const artifact = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  run_id: runId,
  short_hash: shortHash(enrollTx.transaction.hash),
  network: NETWORK,
  smart_account: smartAccount,
  owner_signer: signer,
  contract_version: priorContractVersion,
  config: {
    ref_pool_id: refPoolId,
    token_in: tokenIn,
    token_out: tokenOut,
    probe_amount_in: probeAmountIn,
    pass_min_usdt: passMinUsdt,
    halt_min_usdt: haltMinUsdt,
    ladder_bps: ladderBps,
    session_ms: sessionMs,
    max_fires: maxFires,
    allowance_yocto: allowanceYocto,
    ladder_sweep_preview_yocto_wnear: priorWnearBalance
      ? (
          (BigInt(priorWnearBalance) * BigInt(ladderBps)) /
          10000n
        ).toString()
      : null,
  },
  session: {
    session_public_key: sessionPk,
    expires_at_ms: expiresAtMs,
    allowed_trigger_ids: allowedTriggerIds,
    label,
  },
  templates: {
    pass: { sequence_id: sequenceIdPass, trigger_id: triggerIdPass, calls: templatePass },
    halt: skipHalt
      ? null
      : { sequence_id: sequenceIdHalt, trigger_id: triggerIdHalt, calls: templateHalt },
  },
  setup_txs: {
    save_template_pass: saveTemplatePass.transaction.hash,
    save_template_halt: saveTemplateHalt ? saveTemplateHalt.transaction.hash : null,
    create_trigger_pass: createTriggerPass.transaction.hash,
    create_trigger_halt: createTriggerHalt ? createTriggerHalt.transaction.hash : null,
    enroll: enrollTx.transaction.hash,
  },
  fire_txs: fireTxs,
  revoke_tx: revokeTx.transaction.hash,
  post_revoke_attempt: postRevokeAttempt,
  block_info: {
    enroll: extractBlockInfo(traces.enroll),
    fire_pass: extractBlockInfo(traces.fire_pass),
    fire_halt: extractBlockInfo(traces.fire_halt),
    revoke: extractBlockInfo(traces.revoke),
  },
  structured_events: allEvents,
  outcomes,
  balances: {
    wnear_before: priorWnearBalance,
    wnear_after: newWnearBalance,
    intents_before: priorIntentsBalance,
    intents_after: newIntentsBalance,
    intents_delta:
      priorIntentsBalance && newIntentsBalance
        ? (BigInt(newIntentsBalance) - BigInt(priorIntentsBalance)).toString()
        : null,
  },
  grant_after_fires: grantAfterFires,
  grant_after_revoke: grantAfterRevoke,
};

const outPath = values["artifacts-file"]
  ? (path.isAbsolute(values["artifacts-file"])
    ? values["artifacts-file"]
    : path.join(REPO_ROOT, values["artifacts-file"]))
  : path.join(
      REPO_ROOT,
      "collab",
      "artifacts",
      `${new Date().toISOString().replace(/[:.]/g, "-")}-intents-deposit-limit-${runId}.json`
    );
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
console.log("\nartifact written:", outPath);

if (values.json) {
  process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
}

console.log("\nresult:");
console.log(`  fire_pass        : ${outcomes.fire_pass}`);
console.log(`  fire_halt        : ${outcomes.fire_halt}`);
console.log(
  `  intents delta    : ${artifact.balances.intents_delta ?? "?"} yocto wNEAR ${tokenIn}`
);
console.log(
  `  wnear delta      : ${
    priorWnearBalance && newWnearBalance
      ? (BigInt(newWnearBalance) - BigInt(priorWnearBalance)).toString()
      : "?"
  } yocto (expected negative — deposited out)`
);

// ---------- helpers -------------------------------------------------

function base64Utf8(str) {
  return Buffer.from(str, "utf8").toString("base64");
}

function base64Json(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64");
}

function parsePositiveInt(raw, flag) {
  const v = Number(raw);
  if (!Number.isInteger(v) || v <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return v;
}

function nearToYocto(nearStr) {
  const [whole, frac = ""] = String(nearStr).split(".");
  if (!/^\d+$/.test(whole) || (frac && !/^\d+$/.test(frac))) {
    throw new Error(`bad NEAR amount '${nearStr}'`);
  }
  const fracPadded = (frac + "0".repeat(24)).slice(0, 24);
  return (BigInt(whole) * 10n ** 24n + BigInt(fracPadded || "0")).toString();
}

function escapeJsonString(str) {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

async function safeView(accountId, methodName, args) {
  try {
    const { value } = await callViewMethod(NETWORK, accountId, methodName, args);
    return value;
  } catch {
    return null;
  }
}

async function safeTrace(txHash, senderId) {
  if (!txHash) return null;
  try {
    return await traceTx(NETWORK, txHash, senderId, "FINAL");
  } catch {
    return null;
  }
}

function extractEvents(trace, filter) {
  if (!trace?.tree) return [];
  const out = [];
  for (const r of flattenReceiptTree(trace.tree)) {
    for (const log of r.logs ?? []) {
      if (!log.startsWith("EVENT_JSON:")) continue;
      try {
        const ev = JSON.parse(log.slice("EVENT_JSON:".length));
        if (filter.has(ev.event)) out.push(ev);
      } catch {
        // ignore
      }
    }
  }
  return out;
}

function classifyFireOutcome(events) {
  if (events.some((e) => e.event === "sequence_completed")) return "completed";
  if (events.some((e) => e.event === "sequence_halted")) {
    const halt = events.find((e) => e.event === "sequence_halted");
    return `halted (${halt?.data?.reason ?? "unknown"})`;
  }
  if (
    events.some(
      (e) => e.event === "pre_gate_checked" && e.data?.matched === false
    )
  ) {
    return "halted_at_pre_gate";
  }
  return "unknown";
}
