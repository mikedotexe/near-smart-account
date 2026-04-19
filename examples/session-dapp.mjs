#!/usr/bin/env node
//
// examples/session-dapp.mjs — demonstrate session keys (Tranche 3):
// annotated function-call access keys minted by the smart account
// itself, with on-chain policy (expiry, fire-count cap, trigger
// allowlist) enforced in `execute_trigger`.
//
// Flow:
//   1. Owner signs ONE tx (`enroll_session`) with 1 yoctoNEAR attached:
//      smart account mints a NEAR function-call access key on itself,
//      restricted to `execute_trigger`, and records the grant metadata.
//   2. Script generates an ephemeral ed25519 keypair BEFORE step 1
//      and passes the public part to enroll_session.
//   3. Script switches signing context to the ephemeral key and fires
//      N `execute_trigger` txs — NO main-wallet prompts.
//   4. Script reads `get_session(session_pk)` to verify fire_count = N.
//   5. Owner revokes: `revoke_session(session_pk)`. Grant state and
//      access key deleted atomically.
//   6. Script attempts ONE more fire with the revoked key; expects
//      `InvalidAccessKeyError` at the NEAR runtime level (key is gone).
//   7. Artifact captures all 5 tx hashes + `session_*` events.
//
// Prereq: the smart account must already have a `BalanceTrigger` under
// the `trigger_id` you pass. Set one up via `examples/dca.mjs` or a
// direct `save_sequence_template` + `create_balance_trigger` call pair.
// The trigger's template can be any 1-step plan; this demo fires it
// exclusively through the session key so its internal work doesn't
// have to be meaningful — only the auth path matters.
//
// Usage:
//   ./examples/session-dapp.mjs \
//     --signer x.mike.testnet \
//     --smart-account sa-session.x.mike.testnet \
//     --trigger-id <existing-trigger-id>
//
// Flags:
//   --max-fires <n>       how many session fires before revoke (default 3)
//   --session-ms <ms>     expires_at_ms offset from now (default 900000 = 15m)
//   --allowance-near <n>  function-call AK allowance (default 0.1)
//   --skip-revoke         leave the session alive; skips steps 5+6
//   --dry                 print the plan + generated session_pk, exit

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

const NETWORK = "testnet";

const { values } = parseArgs({
  options: {
    signer: { type: "string" },
    "smart-account": { type: "string" },
    "trigger-id": { type: "string" },
    "max-fires": { type: "string", default: "3" },
    "session-ms": { type: "string", default: "900000" },
    "allowance-near": { type: "string", default: "0.1" },
    label: { type: "string" },
    "skip-revoke": { type: "boolean", default: false },
    "enroll-gas-tgas": { type: "string", default: "100" },
    "fire-gas-tgas": { type: "string", default: "300" },
    "revoke-gas-tgas": { type: "string", default: "50" },
    "poll-ms": { type: "string", default: "1500" },
    "artifacts-file": { type: "string" },
    dry: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (!values.signer) throw new Error("--signer is required");
if (!values["smart-account"]) throw new Error("--smart-account is required");
if (!values["trigger-id"]) {
  throw new Error(
    "--trigger-id is required (the balance trigger the session key will fire)"
  );
}

const signer = values.signer;
const smartAccount = values["smart-account"];
const triggerId = values["trigger-id"];
const maxFires = parsePositiveInt(values["max-fires"], "--max-fires");
const sessionMs = parsePositiveInt(values["session-ms"], "--session-ms");
const allowanceNear = values["allowance-near"];
const allowanceYocto = nearToYocto(allowanceNear);
const label = values.label ?? `session-dapp-${runIdStamp()}`;
const skipRevoke = values["skip-revoke"];
const enrollGasTgas = parsePositiveInt(values["enroll-gas-tgas"], "--enroll-gas-tgas");
const fireGasTgas = parsePositiveInt(values["fire-gas-tgas"], "--fire-gas-tgas");
const revokeGasTgas = parsePositiveInt(values["revoke-gas-tgas"], "--revoke-gas-tgas");
const pollMs = parsePositiveInt(values["poll-ms"], "--poll-ms");

const runId = runIdStamp();

// Load near-api-js first so we can mint an ephemeral keypair even in
// --dry mode. (This matches the live flow: the pk is generated BEFORE
// enroll_session runs on-chain.)
const { nearApi, accounts, near, keyStore, cfg } = await connectNearWithSigners(
  NETWORK,
  [signer]
);
const ownerAccount = accounts[signer];

const ephemeralKeyPair = nearApi.KeyPair.fromRandom("ed25519");
const sessionPk = ephemeralKeyPair.getPublicKey().toString();

const now = Date.now();
const expiresAtMs = now + sessionMs;

console.log("session-dapp demo");
console.log("  smart account    :", smartAccount);
console.log("  owner signer     :", signer);
console.log("  trigger id       :", triggerId);
console.log("  session pk       :", sessionPk);
console.log(
  "  expires at       :",
  new Date(expiresAtMs).toISOString(),
  `(in ${(sessionMs / 1000).toFixed(0)}s)`
);
console.log("  max fires        :", maxFires);
console.log("  allowance        :", `${allowanceNear} NEAR (${allowanceYocto} yocto)`);
console.log("  label            :", label);
console.log("  runId            :", runId);

if (values.dry) {
  console.log("\n(dry run — not submitting)");
  process.exit(0);
}

const txHashes = {
  enroll: null,
  fires: [],
  revoke: null,
  post_revoke_attempt: null,
};

// ---------- 1. Enroll session ---------------------------------------
console.log("\n[1/4] owner signing enroll_session …");
const enrollTx = await ownerAccount.signAndSendTransaction({
  receiverId: smartAccount,
  actions: [
    nearApi.transactions.functionCall(
      "enroll_session",
      Buffer.from(
        JSON.stringify({
          session_public_key: sessionPk,
          expires_at_ms: expiresAtMs,
          allowed_trigger_ids: [triggerId],
          max_fire_count: maxFires,
          allowance_yocto: allowanceYocto,
          label,
        })
      ),
      BigInt(enrollGasTgas) * 10n ** 12n,
      1n // 1 yoctoNEAR — proves signer has a FAK on the owner account
    ),
  ],
});
txHashes.enroll = enrollTx.transaction.hash;
console.log("  enroll tx:", txHashes.enroll);

const enrollOk = enrollTx.status?.SuccessValue !== undefined ||
  enrollTx.receipts_outcome?.every((o) => o.outcome.status.SuccessValue !== undefined ||
    o.outcome.status.SuccessReceiptId !== undefined);
if (!enrollOk) {
  console.error("  enroll did not report success; aborting");
  process.exit(1);
}

// Add the ephemeral key to the keystore under the SMART ACCOUNT's
// (network, accountId) slot. Subsequent `near.account(smartAccount)`
// calls will sign with this key. The owner's FAK remains stored under
// (network, owner) so the owner can still sign revoke at step 3.
await keyStore.setKey(NETWORK, smartAccount, ephemeralKeyPair);
const sessionAccount = await near.account(smartAccount);

// ---------- 2. Fire execute_trigger N times via session key ---------
console.log(`\n[2/4] firing execute_trigger ${maxFires}x via session key …`);
for (let i = 1; i <= maxFires; i++) {
  try {
    const fireTx = await sessionAccount.signAndSendTransaction({
      receiverId: smartAccount,
      actions: [
        nearApi.transactions.functionCall(
          "execute_trigger",
          Buffer.from(JSON.stringify({ trigger_id: triggerId })),
          BigInt(fireGasTgas) * 10n ** 12n,
          0n
        ),
      ],
    });
    const hash = fireTx.transaction.hash;
    txHashes.fires.push(hash);
    console.log(`  fire ${i}/${maxFires} tx:`, hash);
  } catch (e) {
    console.error(`  fire ${i}/${maxFires} failed:`, e.message);
    break;
  }
  await sleep(pollMs);
}

// ---------- 3. Verify grant state post-fires ------------------------
const grantAfterFires = await callViewMethod(
  NETWORK,
  smartAccount,
  "get_session",
  { session_public_key: sessionPk }
).then((r) => r.value).catch(() => null);

console.log("\n[3/4] grant after fires:");
if (grantAfterFires) {
  console.log(`  fire_count       : ${grantAfterFires.fire_count}/${grantAfterFires.max_fire_count}`);
  console.log(`  active           : ${grantAfterFires.active}`);
  console.log(`  expires_at       : ${new Date(grantAfterFires.expires_at_ms).toISOString()}`);
} else {
  console.log("  (no grant found — unexpected unless enroll failed silently)");
}

// ---------- 4. Owner revokes + post-revoke fire fails ---------------
let grantAfterRevoke = null;
if (!skipRevoke) {
  console.log("\n[4/4] owner signing revoke_session …");
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
  txHashes.revoke = revokeTx.transaction.hash;
  console.log("  revoke tx:", txHashes.revoke);

  // Wait briefly for the revoke state commit to propagate to the view
  // RPC. Without this, get_session can return stale bytes even though
  // the delete_key Promise has landed and the access key is gone.
  await sleep(pollMs * 2);
  grantAfterRevoke = await callViewMethod(
    NETWORK,
    smartAccount,
    "get_session",
    { session_public_key: sessionPk }
  ).then((r) => r.value).catch(() => null);
  console.log("  get_session (post-revoke):", grantAfterRevoke ?? "null (as expected)");

  // Try one more fire with the (now-revoked) key. Expect NEAR runtime
  // to reject: "access key <pk> does not exist" or similar.
  console.log("  attempting one post-revoke fire (should reject) …");
  try {
    const postRevokeTx = await sessionAccount.signAndSendTransaction({
      receiverId: smartAccount,
      actions: [
        nearApi.transactions.functionCall(
          "execute_trigger",
          Buffer.from(JSON.stringify({ trigger_id: triggerId })),
          BigInt(fireGasTgas) * 10n ** 12n,
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
    // Expected path: NEAR runtime rejects the tx with an access-key error.
    console.log("  post-revoke rejected (expected):", truncate(e.message, 120));
    txHashes.post_revoke_attempt = { rejected: true, message: String(e.message) };
  }
} else {
  console.log("\n[4/4] skipping revoke (--skip-revoke set)");
}

// ---------- trace + artifact ----------------------------------------
const enrollTrace = await safeTrace(txHashes.enroll, signer);
const fireTraces = [];
// Fire txs have signer_id = smartAccount (signed by the ephemeral session key).
for (const h of txHashes.fires) {
  fireTraces.push(await safeTrace(h, smartAccount));
}
const revokeTrace = txHashes.revoke ? await safeTrace(txHashes.revoke, signer) : null;

const allEvents = [
  ...extractSessionEvents(enrollTrace),
  ...fireTraces.flatMap(extractSessionEvents),
  ...(revokeTrace ? extractSessionEvents(revokeTrace) : []),
];

const artifact = {
  schema_version: 1,
  run_id: runId,
  short_hash: txHashes.enroll ? shortHash(txHashes.enroll) : null,
  network: NETWORK,
  smart_account: smartAccount,
  owner_signer: signer,
  trigger_id: triggerId,
  session_public_key: sessionPk,
  session: {
    granted_at_approx_ms: now,
    expires_at_ms: expiresAtMs,
    max_fires: maxFires,
    allowance_yocto: allowanceYocto,
    label,
  },
  tx_hashes: txHashes,
  grant_after_fires: grantAfterFires,
  grant_after_revoke: grantAfterRevoke,
  events: allEvents,
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

const successfulFires = txHashes.fires.length;
const expectedFires = maxFires;
const revokeSuccess =
  skipRevoke ||
  (Boolean(txHashes.revoke) &&
    grantAfterRevoke === null &&
    (typeof txHashes.post_revoke_attempt === "object" &&
      txHashes.post_revoke_attempt?.rejected));
const overall = successfulFires === expectedFires && revokeSuccess ? "ok" : "partial";
console.log("\nresult:", overall);
console.log(`  fires landed     : ${successfulFires}/${expectedFires}`);
console.log(`  revoke succeeded : ${revokeSuccess ? "yes" : skipRevoke ? "(skipped)" : "no"}`);
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
  // Use BigInt math to avoid float precision loss on fractional NEAR.
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

async function safeTrace(txHash, senderId) {
  if (!txHash) return null;
  try {
    return await traceTx(NETWORK, txHash, senderId, "FINAL");
  } catch {
    return null;
  }
}

function extractSessionEvents(trace) {
  if (!trace?.tree) return [];
  const out = [];
  for (const r of flattenReceiptTree(trace.tree)) {
    for (const log of r.logs ?? []) {
      if (!log.startsWith("EVENT_JSON:")) continue;
      try {
        const ev = JSON.parse(log.slice("EVENT_JSON:".length));
        if (
          ev.event === "session_enrolled" ||
          ev.event === "session_fired" ||
          ev.event === "session_revoked"
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
