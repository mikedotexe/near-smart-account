# Session keys — annotated access keys on a programmable auth hub

## What it is

A **session key** is a NEAR function-call access key that the smart
account mints on itself, plus a state annotation the smart account
enforces on every call through that key. Together they let the owner
grant a constrained delegate: *"this key can fire `execute_trigger`
for `dca-weekly-eth` up to 10 times over the next 4 hours, then
it's dead."*

The annotation layer lives in `SessionGrant` contract state. The
smart account enforces `{expires_at_ms, max_fire_count,
allowed_trigger_ids, label}` at the top of `execute_trigger` before
any downstream work. NEAR's runtime enforces the native FCAK
restrictions (receiver = self, method = `execute_trigger`,
allowance). Together they are the session key.

## Why this instead of NEAR's native FCAK alone?

Native FCAKs are powerful but **stateless** — the runtime doesn't
know about expiry, fire counts, or trigger allowlists. A standalone
FCAK can fire `execute_trigger` indefinitely until its allowance
runs out.

Session keys add four annotations native FCAKs don't have:

| Annotation | What it enforces | Where |
|---|---|---|
| `expires_at_ms` | After this timestamp, fires panic with `"session expired"` | Contract |
| `max_fire_count` | After N successful fires, further fires panic | Contract |
| `allowed_trigger_ids` | Only the listed `trigger_id` values are accepted | Contract |
| `label` | Free-form attribution surfaced in `session_fired` events | Event stream |

The native allowance cap is still there underneath — you still
can't fire through more gas than the allowance permits. The
annotations are a **semantic layer** on top: allowance is "how much
can you spend total," annotations are "how many logical
operations."

## Why this instead of NEP-413?

NEP-413 (signed off-chain messages) is the other way to implement
"pre-authorized delegated calls." We considered it and pivoted for
four reasons:

1. **Zero new crypto.** NEP-413 verification is ~200 LOC of
   security-critical ed25519 code in the contract. The AddKey
   approach reuses NEAR's native tx-level auth.
2. **Enrollment is a normal on-chain tx.** An explorer-visible
   `tx_hash` records the grant. No off-chain wire format to
   canonicalize or lock down.
3. **Revocation is atomic.** `revoke_session` deletes both state
   AND the access key in one promise.
4. **Programmable auth hub.** Every delegated call passes through
   our contract, so we emit per-key telemetry (`session_fired`),
   enforce allowlists, bump counters — things NEP-413 alone
   wouldn't give us.

## How to use it

### Enroll — owner signs one tx

The owner must attach **1 yoctoNEAR** (proves they're signing with
a full-access key on the owner account — the standard NEAR idiom
for this kind of proof).

```js
import { KeyPair, utils } from "near-api-js";

const sessionKeyPair = KeyPair.fromRandom("ed25519");
const sessionPk = sessionKeyPair.getPublicKey().toString();
// "ed25519:<base58>"

await ownerAccount.signAndSendTransaction({
  receiverId: "sa-wallet.alice.near",
  actions: [
    nearApi.transactions.functionCall(
      "enroll_session",
      Buffer.from(JSON.stringify({
        session_public_key: sessionPk,
        expires_at_ms: Date.now() + 60 * 60 * 1000,  // +1h
        allowed_trigger_ids: ["dca-weekly-eth"],
        max_fire_count: 10,
        allowance_yocto: utils.format.parseNearAmount("0.5"),
        label: "ledger-dca-runner",
      })),
      100n * 10n ** 12n,   // 100 TGas
      1n,                  // 1 yoctoNEAR
    ),
  ],
});
```

The contract mints a function-call access key on itself (restricted
to `execute_trigger`), records the `SessionGrant`, emits
`session_enrolled`, and returns. The dapp now holds
`sessionKeyPair` locally.

### Fire — delegate signs with the session key

The delegate signs txs with `signer_id = smart_account`,
`public_key = sessionPk`. Those txs land in `execute_trigger`; the
top of that method checks `env::signer_account_pk()` against
`session_grants`, enforces the annotations, and bumps `fire_count`.

```js
// Put the session key in a keystore slot keyed by the smart account.
await keyStore.setKey("mainnet", "sa-wallet.alice.near", sessionKeyPair);

// All subsequent near.account(smartAccount) calls sign with sessionKeyPair.
const sessionAccount = await near.account("sa-wallet.alice.near");

for (let i = 0; i < 10; i++) {
  await sessionAccount.signAndSendTransaction({
    receiverId: "sa-wallet.alice.near",
    actions: [
      nearApi.transactions.functionCall(
        "execute_trigger",
        Buffer.from(JSON.stringify({ trigger_id: "dca-weekly-eth" })),
        300n * 10n ** 12n,
        0n,
      ),
    ],
  });
  await sleep(5 * 60 * 1000);
}
```

Each tx emits a `session_fired` event with `{session_public_key,
trigger_id, fire_count_after, max_fire_count, label}`.

### Revoke — owner signs one tx

```js
await ownerAccount.signAndSendTransaction({
  receiverId: "sa-wallet.alice.near",
  actions: [
    nearApi.transactions.functionCall(
      "revoke_session",
      Buffer.from(JSON.stringify({ session_public_key: sessionPk })),
      50n * 10n ** 12n,
      0n,
    ),
  ],
});
```

Grant state removed, access key deleted. Subsequent fires with the
revoked key are rejected by the NEAR runtime (not our code) with
an `InvalidAccessKeyError`.

### Public hygiene

Anyone can call `revoke_expired_sessions()` — it prunes grants
whose `expires_at_ms <= now` OR `fire_count >= max_fire_count`, and
deletes the matching access keys. No security risk, since only
already-unusable grants are touched. You can even schedule this as
a `BalanceTrigger` step so the account self-hygiene-ticks.

## Flagship

`examples/session-dapp.mjs` runs the full lifecycle against
`sa-session.x.mike.testnet`: enroll → fire 3x → verify via
`get_session` → revoke → attempt one post-revoke fire (expected
runtime reject) → artifact.

```bash
./examples/session-dapp.mjs \
  --signer x.mike.testnet \
  --smart-account sa-session.x.mike.testnet \
  --trigger-id <existing-trigger-id>
```

The trigger must exist on the smart account before running — set
one up with `examples/dca.mjs` or a direct
`save_sequence_template` + `create_balance_trigger` pair.

## Safety model

A session key **cannot**:

- Call any method other than `execute_trigger` (NEAR runtime).
- Add or remove keys; deploy code; transfer balance; change
  contract state outside the grant's counter bump (NEAR runtime's
  FCAK model).
- Outlive its `expires_at_ms` (contract).
- Fire more than `max_fire_count` times (contract).
- Fire a trigger outside its `allowed_trigger_ids` allowlist
  (contract, when set).
- Enroll new session keys or revoke other grants (owner-only
  methods, gated by `assert_owner()`).

A session key **can**:

- Fire `execute_trigger` for any allowed trigger, up to its
  counter cap, inside the allowance window.
- Be observed by anyone watching the `sa-automation` event stream
  — every fire is on-chain.

The owner **can**:

- Revoke any session key at any time (`revoke_session`).
- Do nothing and wait for expiry — no action required.
- Call `revoke_expired_sessions` from any account to clean up
  stale grants.

## Limitations (v1)

- Session keys currently only authorize `execute_trigger`.
  Extending to `execute_steps` would need a per-plan or per-hash
  allowlist — future work.
- Only the owner can enroll. An "enrollment delegate" tier (trusted
  agent can enroll with constrained ranges) is a v2 extension
  without breaking v1 callers.
- The `label` is free-form; there's no schema or validation. It's
  pure telemetry.
- No per-key rate limit beyond `max_fire_count` — no "max 1 fire
  per 5 minutes" enforcement. The runtime's tx nonce ordering is
  the only pacing constraint.

## Reference

- Design note: [`md-CLAUDE-chapters/25-session-keys.md`](./md-CLAUDE-chapters/25-session-keys.md)
- Flagship: [`examples/session-dapp.mjs`](./examples/session-dapp.mjs)
- Sequencer entry points (`contracts/smart-account/src/lib.rs`):
  `enroll_session`, `revoke_session`, `revoke_expired_sessions`,
  `execute_trigger` (session-key path at top)
- State type: `SessionGrant` / `SessionGrantView`
- Events: `session_enrolled`, `session_fired`, `session_revoked`
