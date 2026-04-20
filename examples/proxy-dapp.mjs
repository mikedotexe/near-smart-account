#!/usr/bin/env node
//
// examples/proxy-dapp.mjs — demonstrate proxy keys (Tranche v5.1.0-proxy):
// a universal FCAK-proxy pattern where the dApp-login key targets the
// smart account itself, not the dApp's contract. Policy + audit + revoke
// all live on one account.
//
// The headline mechanic demonstrated by the default invocation:
// STATE-CONTROLLED DEPOSIT. NEAR's protocol rule says function-call
// access keys cannot attach a deposit — a tx signed by an FCAK always
// carries `deposit == 0`. But the outgoing Promise built inside
// `proxy_call` attaches `attach_yocto` drawn from the smart account's
// own balance, per-grant, state-controlled. That's how the ephemeral
// key effectively pays the 1-yN toll required by `intents.near` /
// NEP-141 `ft_transfer` — something the FCAK structurally cannot do.
//
// The default target method is `require_one_yocto(label)` on
// `pathological-router`: it asserts `env::attached_deposit() == 1 yN`
// (mirrors NEP-141 semantics) and panics otherwise. Falsifiable test:
// drop `--attach-yocto 0` and re-run — the call will panic at the
// target with "expected exactly 1 yoctoNEAR attached", proving the
// mechanic is load-bearing.
//
// Flow:
//   1. Owner signs ONE tx (`enroll_proxy_key`) with 1 yoctoNEAR attached:
//      smart account writes a `ProxyGrant` and mints an FCAK pinned to
//      `method_name = "proxy_call"`. The ephemeral keypair is generated
//      BEFORE this tx and its public part goes into allowed_targets +
//      allowed_methods policy.
//   2. Script switches signing context to the ephemeral key and fires
//      N `proxy_call(target, method, args)` txs — NO wallet prompts.
//      Each dispatch validates the grant + bumps `call_count` + emits
//      `proxy_call_dispatched`.
//   3. Script reads the target's side-effect counter BEFORE and AFTER
//      the proxy_call batch, proving dispatches landed on the real
//      downstream contract with the grant-configured deposit attached.
//   4. Script reads `get_proxy_grant(pk)` to verify call_count = N.
//   5. Owner revokes: `revoke_proxy_key(pk)`. Grant state and FCAK
//      deleted atomically.
//   6. Script attempts ONE more proxy_call with the revoked key;
//      expects NEAR runtime rejection (access key is gone).
//   7. Artifact captures all tx hashes + `proxy_*` events + counter
//      delta + grant state before/after revoke + explorer links.
//
// Usage:
//   ./examples/proxy-dapp.mjs \
//     --signer x.mike.testnet \
//     --smart-account sa-proxy.x.mike.testnet
//
// Flags:
//   --target-contract <acct>        downstream receiver
//                                   (default: pathological-router.x.mike.testnet)
//   --target-method   <name>        method to proxy (default: require_one_yocto)
//   --counter-method  <name>        view method for counter proof
//                                   (default: get_calls_completed)
//   --max-calls       <n>           how many proxy_call hops before revoke (default 3)
//   --attach-yocto    <yocto>       state-controlled deposit per dispatch (default "1")
//                                   Set to "0" + --target-method do_honest_work to
//                                   exercise the zero-deposit boundary variant.
//   --session-ms      <ms>          expires_at_ms offset from now (default 900000 = 15m)
//   --allowance-near  <n>           FCAK gas allowance on the smart account (default 0.1)
//   --label           <s>           human-readable grant label
//   --skip-revoke                   leave grant alive; skip steps 5+6
//   --network-explorer <base>       explorer URL base (default: https://near.rocks)
//   --dry                           print the plan + generated pk, exit
//   --json                          dump artifact to stdout
//   --artifacts-file <path>         write artifact JSON to path

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { REPO_ROOT, shortHash, sleep } from "../scripts/lib/fastnear.mjs";
import {
  callViewMethod,
  connectNearWithSigners,
} from "../scripts/lib/near-cli.mjs";
import { extractBlockInfo, flattenReceiptTree, traceTx } from "../scripts/lib/trace-rpc.mjs";

const NETWORK = process.env.NETWORK || "testnet";
const DEFAULT_TARGET = "pathological-router.x.mike.testnet";

const { values } = parseArgs({
  options: {
    signer: { type: "string" },
    "smart-account": { type: "string" },
    "target-contract": { type: "string", default: DEFAULT_TARGET },
    "target-method": { type: "string", default: "require_one_yocto" },
    "counter-method": { type: "string", default: "get_calls_completed" },
    "max-calls": { type: "string", default: "3" },
    "attach-yocto": { type: "string", default: "1" },
    "network-explorer": { type: "string", default: "https://near.rocks" },
    "session-ms": { type: "string", default: "900000" },
    "allowance-near": { type: "string", default: "0.1" },
    "enroll-gas-tgas": { type: "string", default: "100" },
    "call-gas-tgas": { type: "string", default: "50" },
    "revoke-gas-tgas": { type: "string", default: "50" },
    "poll-ms": { type: "string", default: "1500" },
    label: { type: "string" },
    "skip-revoke": { type: "boolean", default: false },
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
const targetContract = values["target-contract"];
const targetMethod = values["target-method"];
const counterMethod = values["counter-method"];
const maxCalls = parsePositiveInt(values["max-calls"], "--max-calls");
const attachYoctoStr = values["attach-yocto"];
if (!/^\d+$/.test(attachYoctoStr)) {
  throw new Error("--attach-yocto must be a non-negative integer (yocto)");
}
const sessionMs = parsePositiveInt(values["session-ms"], "--session-ms");
const allowanceNear = values["allowance-near"];
const allowanceYocto = nearToYocto(allowanceNear);
const label = values.label ?? `proxy-dapp-${runIdStamp()}`;
const skipRevoke = values["skip-revoke"];
const enrollGasTgas = parsePositiveInt(values["enroll-gas-tgas"], "--enroll-gas-tgas");
const callGasTgas = parsePositiveInt(values["call-gas-tgas"], "--call-gas-tgas");
const revokeGasTgas = parsePositiveInt(values["revoke-gas-tgas"], "--revoke-gas-tgas");
const pollMs = parsePositiveInt(values["poll-ms"], "--poll-ms");
const explorerBase = values["network-explorer"].replace(/\/+$/, "");

const attachYoctoBig = BigInt(attachYoctoStr);
const mechanicDemonstrated =
  attachYoctoBig > 0n && targetMethod === "require_one_yocto";

const runId = runIdStamp();

// Load near-api-js first so we can mint an ephemeral keypair even in
// --dry mode. (Matches the live flow: the pk is generated BEFORE
// enroll_proxy_key runs on-chain.)
const { nearApi, accounts, near, keyStore } = await connectNearWithSigners(
  NETWORK,
  [signer]
);
const ownerAccount = accounts[signer];

const ephemeralKeyPair = nearApi.KeyPair.fromRandom("ed25519");
const proxyPk = ephemeralKeyPair.getPublicKey().toString();

const now = Date.now();
const expiresAtMs = now + sessionMs;

console.log("proxy-dapp demo");
console.log("  smart account    :", smartAccount);
console.log("  owner signer     :", signer);
console.log("  target           :", `${targetContract}.${targetMethod}`);
console.log("  counter view     :", `${targetContract}.${counterMethod}`);
console.log("  proxy pk         :", proxyPk);
console.log(
  "  expires at       :",
  new Date(expiresAtMs).toISOString(),
  `(in ${(sessionMs / 1000).toFixed(0)}s)`
);
console.log("  max calls        :", maxCalls);
console.log("  attach_yocto     :", attachYoctoStr);
console.log("  allowance        :", `${allowanceNear} NEAR (${allowanceYocto} yocto)`);
console.log("  label            :", label);
console.log("  runId            :", runId);
if (mechanicDemonstrated) {
  console.log("\n  claim under test :");
  console.log("    The FCAK minted by enroll_proxy_key carries deposit == 0");
  console.log("    (NEAR protocol rule). Yet require_one_yocto panics unless");
  console.log("    exactly 1 yN is attached. If this flagship completes with");
  console.log("    counter_delta == max_calls, the smart account's state-");
  console.log("    controlled `attach_yocto` mechanic is load-bearing — it");
  console.log("    paid a toll the FCAK structurally cannot pay.");
}

if (values.dry) {
  console.log("\n(dry run — not submitting)");
  process.exit(0);
}

const txHashes = {
  enroll: null,
  calls: [],
  revoke: null,
  post_revoke_attempt: null,
};

// Pre-read: downstream counter BEFORE any proxy_call hops.
const counterBefore = await readCounter(targetContract, counterMethod);
console.log(`\npre-batch ${counterMethod} : ${counterBefore ?? "(unreadable)"}`);

// ---------- 1. Enroll proxy key ------------------------------------
console.log("\n[1/4] owner signing enroll_proxy_key …");
const enrollTx = await ownerAccount.signAndSendTransaction({
  receiverId: smartAccount,
  actions: [
    nearApi.transactions.functionCall(
      "enroll_proxy_key",
      Buffer.from(
        JSON.stringify({
          session_public_key: proxyPk,
          expires_at_ms: expiresAtMs,
          allowed_targets: [targetContract],
          allowed_methods: [targetMethod],
          attach_yocto: attachYoctoStr,
          max_gas_tgas: callGasTgas,
          max_call_count: maxCalls,
          allowance_yocto: allowanceYocto,
          label,
        })
      ),
      BigInt(enrollGasTgas) * 10n ** 12n,
      1n // 1 yoctoNEAR — proves signer holds a FAK on the owner account
    ),
  ],
});
txHashes.enroll = enrollTx.transaction.hash;
console.log("  enroll tx:", txHashes.enroll);

const enrollOk =
  enrollTx.status?.SuccessValue !== undefined ||
  enrollTx.receipts_outcome?.every(
    (o) =>
      o.outcome.status.SuccessValue !== undefined ||
      o.outcome.status.SuccessReceiptId !== undefined
  );
if (!enrollOk) {
  console.error("  enroll did not report success; aborting");
  process.exit(1);
}

// Swap the ephemeral key into the (network, smartAccount) keystore slot.
// When signer === smartAccount this overwrites the owner's FAK in-memory;
// we restore it before revoke. When signer !== smartAccount the slot was
// empty and this is a pure write.
const priorSmartAccountKey = await keyStore.getKey(NETWORK, smartAccount);
await keyStore.setKey(NETWORK, smartAccount, ephemeralKeyPair);
const proxyAccount = await near.account(smartAccount);

// ---------- 2. Fire proxy_call N times via ephemeral key -----------
console.log(`\n[2/4] firing proxy_call ${maxCalls}× via ephemeral key …`);
for (let i = 1; i <= maxCalls; i++) {
  const dispatchLabel = `${label}#${i}`;
  const inner = { label: dispatchLabel };
  try {
    const callTx = await proxyAccount.signAndSendTransaction({
      receiverId: smartAccount,
      actions: [
        nearApi.transactions.functionCall(
          "proxy_call",
          Buffer.from(
            JSON.stringify({
              target: targetContract,
              method: targetMethod,
              args: Buffer.from(JSON.stringify(inner)).toString("base64"),
            })
          ),
          BigInt(callGasTgas + 30) * 10n ** 12n, // outer + headroom for the proxy hop itself
          0n // NEAR rule: FCAKs attach zero; the smart account adds attach_yocto from state
        ),
      ],
    });
    const hash = callTx.transaction.hash;
    txHashes.calls.push(hash);
    console.log(`  proxy_call ${i}/${maxCalls} tx:`, hash);
  } catch (e) {
    console.error(`  proxy_call ${i}/${maxCalls} failed:`, e.message);
    break;
  }
  await sleep(pollMs);
}

// ---------- 3. Verify counter delta + grant state post-calls -------
const counterAfter = await readCounter(targetContract, counterMethod);
const counterDelta =
  typeof counterBefore === "number" && typeof counterAfter === "number"
    ? counterAfter - counterBefore
    : null;
console.log(`\npost-batch ${counterMethod}: ${counterAfter ?? "(unreadable)"}`);
console.log(
  `counter delta    : ${counterDelta ?? "(unknown)"} (expected ${txHashes.calls.length})`
);

const grantAfterCalls = await callViewMethod(
  NETWORK,
  smartAccount,
  "get_proxy_grant",
  { session_public_key: proxyPk }
)
  .then((r) => r.value)
  .catch(() => null);

console.log("\n[3/4] grant after calls:");
if (grantAfterCalls) {
  console.log(
    `  call_count       : ${grantAfterCalls.call_count}/${grantAfterCalls.max_call_count}`
  );
  console.log(`  active           : ${grantAfterCalls.active}`);
  console.log(`  expires_at       : ${new Date(grantAfterCalls.expires_at_ms).toISOString()}`);
} else {
  console.log("  (no grant found — unexpected unless enroll failed silently)");
}

// ---------- 4. Owner revokes + post-revoke call fails -------------
// Restore owner FAK into the (network, smartAccount) slot if we
// overwrote it at step 2. Required when signer === smartAccount; no-op
// otherwise.
if (priorSmartAccountKey) {
  await keyStore.setKey(NETWORK, smartAccount, priorSmartAccountKey);
}
let grantAfterRevoke = null;
if (!skipRevoke) {
  console.log("\n[4/4] owner signing revoke_proxy_key …");
  const revokeTx = await ownerAccount.signAndSendTransaction({
    receiverId: smartAccount,
    actions: [
      nearApi.transactions.functionCall(
        "revoke_proxy_key",
        Buffer.from(JSON.stringify({ session_public_key: proxyPk })),
        BigInt(revokeGasTgas) * 10n ** 12n,
        0n
      ),
    ],
  });
  txHashes.revoke = revokeTx.transaction.hash;
  console.log("  revoke tx:", txHashes.revoke);

  // Wait briefly for the delete-key Promise to land + view propagation.
  await sleep(pollMs * 2);
  grantAfterRevoke = await callViewMethod(
    NETWORK,
    smartAccount,
    "get_proxy_grant",
    { session_public_key: proxyPk }
  )
    .then((r) => r.value)
    .catch(() => null);
  console.log("  get_proxy_grant (post-revoke):", grantAfterRevoke ?? "null (as expected)");

  // Swap ephemeral back in and attempt one more proxy_call. Expect NEAR
  // runtime to reject: the FCAK is gone, so the tx is unsignable from
  // the node's perspective.
  await keyStore.setKey(NETWORK, smartAccount, ephemeralKeyPair);
  console.log("  attempting one post-revoke proxy_call (should reject) …");
  try {
    const postRevokeTx = await proxyAccount.signAndSendTransaction({
      receiverId: smartAccount,
      actions: [
        nearApi.transactions.functionCall(
          "proxy_call",
          Buffer.from(
            JSON.stringify({
              target: targetContract,
              method: targetMethod,
              args: Buffer.from(JSON.stringify({ label: `${label}#post-revoke` })).toString(
                "base64"
              ),
            })
          ),
          BigInt(callGasTgas + 30) * 10n ** 12n,
          0n
        ),
      ],
    });
    txHashes.post_revoke_attempt = postRevokeTx.transaction.hash;
    console.log(
      "  post-revoke unexpectedly landed:",
      txHashes.post_revoke_attempt
    );
  } catch (e) {
    console.log("  post-revoke rejected (expected):", truncate(e.message, 120));
    txHashes.post_revoke_attempt = { rejected: true, message: String(e.message) };
  }
} else {
  console.log("\n[4/4] skipping revoke (--skip-revoke set)");
}

// ---------- trace + artifact ---------------------------------------
const enrollTrace = await safeTrace(txHashes.enroll, signer);
const callTraces = [];
// Proxy-call txs are signed by the ephemeral key whose NEAR-level owner
// is the smart account, so signer_id == smartAccount at the receipt layer.
for (const h of txHashes.calls) {
  callTraces.push(await safeTrace(h, smartAccount));
}
const revokeTrace = txHashes.revoke ? await safeTrace(txHashes.revoke, signer) : null;

const allEvents = [
  ...extractProxyEvents(enrollTrace),
  ...callTraces.flatMap(extractProxyEvents),
  ...(revokeTrace ? extractProxyEvents(revokeTrace) : []),
];

// Pull the signer_id seen at the downstream-target receipt from the
// first proxy_call trace. This is the falsifiable "signer preservation"
// claim: the FCAK-signed tx has signer_id = smartAccount, and the
// outgoing Promise from proxy_call dispatches with signer_id = smartAccount
// (not the ephemeral key), so the target sees the user's account.
const downstreamSigner = extractDownstreamSigner(callTraces[0], targetContract);

const explorerLinks = {
  enroll: txHashes.enroll ? `${explorerBase}/tx/${txHashes.enroll}` : null,
  calls: txHashes.calls.map((h) => `${explorerBase}/tx/${h}`),
  revoke: txHashes.revoke ? `${explorerBase}/tx/${txHashes.revoke}` : null,
  smart_account: `${explorerBase}/account/${smartAccount}`,
  target_contract: `${explorerBase}/account/${targetContract}`,
};

const artifact = {
  schema_version: 1,
  run_id: runId,
  short_hash: txHashes.enroll ? shortHash(txHashes.enroll) : null,
  network: NETWORK,
  smart_account: smartAccount,
  owner_signer: signer,
  target_contract: targetContract,
  target_method: targetMethod,
  counter_method: counterMethod,
  counter_before: counterBefore,
  counter_after: counterAfter,
  counter_delta: counterDelta,
  proxy_public_key: proxyPk,
  grant: {
    granted_at_approx_ms: now,
    expires_at_ms: expiresAtMs,
    allowed_targets: [targetContract],
    allowed_methods: [targetMethod],
    attach_yocto: attachYoctoStr,
    max_gas_tgas: callGasTgas,
    max_call_count: maxCalls,
    allowance_yocto: allowanceYocto,
    label,
  },
  mechanic: {
    state_controlled_deposit_demonstrated: mechanicDemonstrated,
    claim:
      "FCAK signing proxy_call carries tx-layer deposit=0; target " +
      "require_one_yocto panics unless exactly 1 yN is attached; " +
      "successful counter_delta == max_calls proves the smart account " +
      "added 1 yN from its own balance on the outgoing Promise, " +
      "per-grant state-controlled.",
  },
  signer_preserved_at_target: downstreamSigner,
  tx_hashes: txHashes,
  block_info: {
    enroll: extractBlockInfo(enrollTrace),
    calls: callTraces.map(extractBlockInfo),
    revoke: extractBlockInfo(revokeTrace),
  },
  grant_after_calls: grantAfterCalls,
  grant_after_revoke: grantAfterRevoke,
  events: allEvents,
  explorer_links: explorerLinks,
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

const successfulCalls = txHashes.calls.length;
const expectedCalls = maxCalls;
const counterOk =
  typeof counterDelta === "number" && counterDelta === successfulCalls;
const revokeOk =
  skipRevoke ||
  (Boolean(txHashes.revoke) &&
    grantAfterRevoke === null &&
    typeof txHashes.post_revoke_attempt === "object" &&
    txHashes.post_revoke_attempt?.rejected);
const overall =
  successfulCalls === expectedCalls && counterOk && revokeOk ? "ok" : "partial";

console.log("\nresult:", overall);
console.log(`  calls landed     : ${successfulCalls}/${expectedCalls}`);
console.log(
  `  counter proof    : ${counterOk ? "yes" : counterDelta === null ? "(unreadable)" : "no"}`
);
console.log(`  revoke succeeded : ${revokeOk ? "yes" : skipRevoke ? "(skipped)" : "no"}`);
if (mechanicDemonstrated && counterOk) {
  console.log(
    `  state-controlled : yes — ${successfulCalls}× 1yN attached from smart-account balance`
  );
  console.log(`                     (FCAK tx-layer deposit = 0; target requires exactly 1yN)`);
}
if (downstreamSigner && downstreamSigner.target_predecessor) {
  const preserved = downstreamSigner.target_predecessor === smartAccount;
  console.log(
    `  signer preserved : ${preserved ? "yes" : "no"} — target receipt predecessor = ${downstreamSigner.target_predecessor}`
  );
}

console.log("\nverify on explorer:");
if (explorerLinks.enroll) console.log(`  enroll    : ${explorerLinks.enroll}`);
explorerLinks.calls.forEach((url, i) => {
  console.log(`  call ${String(i + 1).padStart(2)}   : ${url}`);
});
if (explorerLinks.revoke) console.log(`  revoke    : ${explorerLinks.revoke}`);
console.log(`  sa acct   : ${explorerLinks.smart_account}`);
console.log(`  target    : ${explorerLinks.target_contract}`);

if (overall !== "ok") process.exit(2);

// ---------- helpers ----------

function parsePositiveInt(raw, flag) {
  const v = Number(raw);
  if (!Number.isInteger(v) || v <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return v;
}

function nearToYocto(nearStr) {
  const n = Number(nearStr);
  if (!Number.isFinite(n) || n <= 0) throw new Error("bad --allowance-near");
  const [whole, frac = ""] = String(nearStr).split(".");
  const fracPadded = (frac + "0".repeat(24)).slice(0, 24);
  const wholePart = BigInt(whole) * 10n ** 24n;
  const fracPart = BigInt(fracPadded || "0");
  return (wholePart + fracPart).toString();
}

function runIdStamp() {
  return new Date().toISOString().replace(/[:.-]/g, "").slice(0, 14);
}

function truncate(s, n) {
  const str = String(s ?? "");
  return str.length > n ? `${str.slice(0, n)}…` : str;
}

async function readCounter(account, method) {
  try {
    const { value } = await callViewMethod(NETWORK, account, method, {});
    if (typeof value === "number") return value;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
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

function extractDownstreamSigner(trace, target) {
  // Signer-preservation check across a proxy_call hop.
  //
  // The FCAK signs as `signer_id = smartAccount` (because the FCAK lives
  // on smartAccount). Inside proxy_call, the outgoing Promise propagates
  // that signer_id; at the target's execution receipt we expect:
  //   - top-level tx signer_id       == smartAccount
  //   - target receipt executor_id   == targetContract (code runs here)
  //   - target receipt predecessor   == smartAccount (Promise originated here)
  //
  // All three together falsify the claim. Returns null if trace is
  // missing or the target receipt isn't present.
  if (!trace?.tree) return null;
  const txSigner = trace.tree.signer ?? null;
  for (const r of flattenReceiptTree(trace.tree)) {
    if (r.executor === target && !r.isRefund) {
      return {
        tx_signer_id: txSigner,
        target_executor: r.executor,
        target_predecessor: r.predecessor,
      };
    }
  }
  return { tx_signer_id: txSigner, target_executor: null, target_predecessor: null };
}

function extractProxyEvents(trace) {
  if (!trace?.tree) return [];
  const out = [];
  for (const r of flattenReceiptTree(trace.tree)) {
    for (const log of r.logs ?? []) {
      if (!log.startsWith("EVENT_JSON:")) continue;
      try {
        const ev = JSON.parse(log.slice("EVENT_JSON:".length));
        if (
          ev.event === "proxy_key_enrolled" ||
          ev.event === "proxy_call_dispatched" ||
          ev.event === "proxy_key_revoked"
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
