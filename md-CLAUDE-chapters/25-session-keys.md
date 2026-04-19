# Chapter 25 — Session keys: annotated function-call access keys

## §1 Motivation

NEAR natively supports **function-call access keys (FCAKs)**: a
keypair attached to an account whose signing authority is restricted
to a specific `receiver_id` and method list, with a lamport-style
allowance cap. It is one of NEAR's best features and a genuine UX
primitive — a dapp can ask for a scoped key once and then operate
without further prompts.

But the native FCAK is **stateless**. The runtime enforces only what
it was built to enforce: receiver match, method allowlist, allowance.
It doesn't know:

- when the key should *expire*,
- how many fires it has done,
- whether those fires are still sensible given out-of-band context
  (e.g., the owner wants to cap at 3 fires but revoke freely before),
- which of several recipient-specified triggers the key is allowed
  to invoke.

You can't ask the NEAR runtime to enforce "this key can fire the
`execute_trigger` method, but only for `trigger_id =
"weekly-dca-30near"`, and only 10 times total, and only for the next
4 hours." Those policies live outside the runtime's vocabulary.

The smart account is the natural place to add them. **Every
delegated call routes through the smart account's methods anyway**
(the FCAK restricts to `receiver_id = self`). If the smart account
carries an **annotation table** keyed by session public key, it can
layer arbitrary policy on top of NEAR's native model without new
crypto:

- Mint a function-call AK on itself (via
  `Promise::add_access_key_allowance`), restricted to
  `execute_trigger`.
- Record a `SessionGrant` in contract state under the key's string
  form, carrying `{expires_at_ms, max_fire_count, allowed_trigger_ids,
  label}`.
- Top of `execute_trigger`: look up `env::signer_account_pk()` in
  the grant map; if present, enforce the annotations and bump
  `fire_count`. If not, fall through to the existing
  `assert_executor()` check.
- `revoke_session(pk)` deletes both the state entry AND the AK via
  `Promise::delete_key`.

The smart account becomes a **programmable auth hub**: every call
through a session key is stateful, policied, and attributable via
events.

### Why not NEP-413?

An earlier draft of this tranche used NEP-413 — have the owner sign
an off-chain message authorizing the session, have the contract
verify the sig on every fire via an ed25519 precompile. That would
have worked, but pivoted to **AddKey + annotated state** for four
reasons:

1. **Zero new crypto.** NEP-413 verification would be ~200 LOC of
   security-critical Rust (ed25519 verify, replay-nonce handling,
   payload canonicalization). The AddKey approach reuses NEAR's
   native tx-level authentication.
2. **Enrollment is a normal tx.** It produces a `tx_hash` the owner
   can point at in an explorer. No off-chain wire format to lock
   down.
3. **Revocation is atomic.** `delete_key` is a real promise. The
   state entry and the AK are removed together.
4. **Smart account as auth hub.** Every delegated call actually
   travels through our code, so we can emit `session_fired`
   telemetry, enforce trigger allowlists, bump counters. That's the
   "programmable" part — and it's something bare NEP-413 wouldn't
   give us.

The 1-yoctoNEAR attached-deposit idiom (`env::attached_deposit() >=
1`) proves the caller used a full-access key on the owner account.
That's the only crypto we needed.

## §2 Design

### Surface

One new state field on `Contract`:

```rust
pub session_grants: IterableMap<String, SessionGrant>,
```

Keyed by `session_public_key.to_string()` (`"ed25519:<base58>"`),
matching `env::signer_account_pk().to_string()` at fire time.

One new type:

```rust
#[near(serializers = [borsh, json])]
pub struct SessionGrant {
    pub session_public_key: String,
    pub granted_at_ms: u64,
    pub expires_at_ms: u64,
    pub allowed_trigger_ids: Option<Vec<String>>,
    pub max_fire_count: u32,
    pub fire_count: u32,
    pub label: Option<String>,
}
```

`allowed_trigger_ids: None` means "any trigger" (still gated by the
native FCAK's method allowlist — currently `execute_trigger`).
`label` is a free-form owner annotation surfaced in every
`session_fired` event.

A companion `SessionGrantView` adds a computed `active: bool`
(`now <= expires_at_ms && fire_count < max_fire_count`) for view
callers. The `active` field is not persisted.

### Methods

**`enroll_session`** — owner-only, `#[payable]`, 1-yoctoNEAR required
(proves FAK).

```rust
pub fn enroll_session(
    &mut self,
    session_public_key: String,
    expires_at_ms: u64,
    allowed_trigger_ids: Option<Vec<String>>,
    max_fire_count: u32,
    allowance_yocto: U128,
    label: Option<String>,
) -> Promise { … }
```

Validates inputs (`expires_at_ms > now`, `max_fire_count > 0`,
pubkey parses), records the grant, emits `session_enrolled`, then
returns:

```rust
Promise::new(env::current_account_id()).add_access_key_allowance(
    parsed_pk,
    Allowance::limited(NearToken::from_yoctonear(allowance_yocto.0))
        .unwrap_or_else(|| panic!("allowance_yocto must be > 0")),
    env::current_account_id(),
    "execute_trigger".to_string(),
)
```

The allowance is a real NEAR-side lamport cap; it limits how much
tx-fee gas the session key can consume total before the runtime
rejects its signatures. Our fire-count cap is complementary: the
runtime's allowance is coarse (total gas), ours is semantic
(number of successful executions).

**`revoke_session`** — owner-only.

```rust
pub fn revoke_session(&mut self, session_public_key: String) -> Promise {
    self.assert_owner();
    let existed = self.session_grants.remove(&session_public_key).is_some();
    assert!(existed, "no session grant for that public key");
    let parsed_pk: PublicKey = session_public_key.parse()
        .unwrap_or_else(|_| env::panic_str("invalid session_public_key"));
    Self::emit_event("session_revoked", json!({ ... "reason": "explicit" }));
    Promise::new(env::current_account_id()).delete_key(parsed_pk)
}
```

Both the state entry and the AK are removed. A subsequent fire with
the revoked key is rejected by the NEAR runtime (not our code) with
an `InvalidAccessKeyError` — the key doesn't exist on the account
anymore. The flagship `examples/session-dapp.mjs` verifies this path
explicitly.

**`revoke_expired_sessions`** — public hygiene.

```rust
pub fn revoke_expired_sessions(&mut self) -> u32 { … }
```

Anyone can call. Prunes grants whose `expires_at_ms <= now` OR
`fire_count >= max_fire_count`. Deletes both state and AK. Emits
`session_revoked` with `reason: "expired_or_exhausted"` per pruned
grant. Returns the number pruned. No security implication since only
already-unusable grants are touched.

Composable as a `BalanceTrigger` step itself — schedule a
hygiene tick the kernel runs without any signature from the owner.

**`get_session`, `list_active_sessions`, `list_all_sessions`** —
views returning `SessionGrantView`. `list_active_sessions` filters
on the computed `active` field so dashboards can skip expired
entries without re-computing expiry.

### Fire-path enforcement

Top of `execute_trigger`:

```rust
let signer_pk = env::signer_account_pk().to_string();
let mut session_hit = false;
if let Some(grant) = self.session_grants.get(&signer_pk).cloned() {
    assert!(env::block_timestamp_ms() <= grant.expires_at_ms, "session expired");
    assert!(grant.fire_count < grant.max_fire_count, "session fire_count cap reached");
    if let Some(allowed) = &grant.allowed_trigger_ids {
        assert!(allowed.contains(&trigger_id),
                "trigger_id not in session's allowed_trigger_ids");
    }
    let mut updated = grant;
    updated.fire_count += 1;
    Self::emit_event("session_fired", json!({ … }));
    self.session_grants.insert(signer_pk, updated);
    session_hit = true;
}
if !session_hit {
    self.assert_executor();  // existing owner-or-delegate check
}
// … existing execute_trigger body
```

Two paths, one method:

- Session-key signer → grant found → policy enforced → fire_count
  bumped → `session_fired` emitted → dispatch continues.
- Non-session signer (owner / authorized_executor) → no grant → fall
  through to `assert_executor` → dispatch continues identically.

Zero overhead for non-session callers; one map lookup per fire for
session callers.

### The trust model

An enrolled session key carries the combined authority of:

- **NEAR's native FCAK model** (runtime-enforced): restricted to
  `receiver_id = self`, method `execute_trigger`, gas allowance.
- **Our annotation layer** (contract-enforced): expiry, fire-cap,
  trigger allowlist.

A session key CANNOT:

- Call any method other than `execute_trigger` (runtime rejects).
- Enroll new session keys (enrollment is owner-only).
- Deploy code, add/remove other keys, transfer funds (runtime
  rejects — FCAK has no `DeployContract` / `AddKey` / `Transfer`
  authority).
- Outlive its `expires_at_ms` (contract rejects at fire time).
- Fire more than `max_fire_count` times (contract rejects at fire
  time).
- Fire a trigger outside `allowed_trigger_ids` (contract rejects).

A session key CAN:

- Fire `execute_trigger` for any allowed trigger, however many
  times inside the bounds, within the allowance window.
- See telemetry on every fire (owner or aggregator can reconstruct
  exactly what the key did).

The **owner** can at any time:

- Revoke any session key explicitly (`revoke_session`).
- Wait for expiry (no owner action required).
- Fire `revoke_expired_sessions` to clean up stale grants (anyone
  can; owner doesn't need to be the caller).

## §3 Worked examples

### Sign once, fire many

A dapp wants the user to approve a 1-hour window during which the
dapp can fire its pre-saved DCA template up to 12 times (one per
5-minute tick).

```js
// --- dapp side ---
const sessionKeyPair = KeyPair.fromRandom("ed25519");
const sessionPk = sessionKeyPair.getPublicKey().toString();

// Prompt the user ONCE:
await ownerAccount.signAndSendTransaction({
  receiverId: "sa-wallet.alice.near",
  actions: [functionCall("enroll_session", {
    session_public_key: sessionPk,
    expires_at_ms: Date.now() + 60 * 60 * 1000,     // +1h
    allowed_trigger_ids: ["dca-weekly-eth"],
    max_fire_count: 12,
    allowance_yocto: parseNearAmount("0.5"),
    label: "dca-runner",
  }, 100 * TGAS, 1n)],  // 1 yoctoNEAR attached
});

// --- dapp background loop, NO MORE PROMPTS ---
for (let i = 0; i < 12; i++) {
  await sessionAccount.signAndSendTransaction({
    receiverId: "sa-wallet.alice.near",
    actions: [functionCall("execute_trigger",
      { trigger_id: "dca-weekly-eth" }, 300 * TGAS, 0n)],
  });
  await sleep(5 * 60 * 1000);
}
```

Each fire emits `session_fired` with label `"dca-runner"` — the
owner's dashboard shows exactly what the delegate did, when, and
how much cap remains. If the dapp tries to fire a 13th time, the
contract panics with `"session fire_count cap reached"` and the
runtime aborts the tx cleanly.

### Short-lived key for a one-shot action

Some flows don't want even that much persistence — a key that's
valid only for the next 60 seconds and one fire.

```js
await ownerAccount.signAndSendTransaction({
  receiverId: "sa-wallet.alice.near",
  actions: [functionCall("enroll_session", {
    session_public_key: sessionPk,
    expires_at_ms: Date.now() + 60 * 1000,
    allowed_trigger_ids: ["one-shot-withdraw"],
    max_fire_count: 1,
    allowance_yocto: parseNearAmount("0.05"),
    label: "one-shot-2026-04-19",
  }, 100 * TGAS, 1n)],
});
```

After the one allowed fire (or the 60-second expiry, whichever
comes first), the grant is dead: further fires return an error,
`revoke_expired_sessions` will clean it up on its next tick.

## §4 Unit tests

10 kernel unit tests in `contracts/smart-account/src/lib.rs`:

- `enroll_session_succeeds_for_owner_with_1_yocto` — happy path;
  grant recorded, event emitted.
- `enroll_session_rejects_zero_deposit` — the 1-yocto idiom is
  mandatory.
- `enroll_session_rejects_non_owner` — only the owner can enroll.
- `enroll_session_rejects_past_expiry` /
  `enroll_session_rejects_zero_cap` — input validation.
- `execute_trigger_with_session_key_enforces_expiry` —
  post-expiry fire panics with `"session expired"`.
- `execute_trigger_with_session_key_enforces_fire_cap` — fire
  count at max panics with `"session fire_count cap reached"`.
- `execute_trigger_with_session_key_enforces_allowlist` —
  disallowed trigger_id panics.
- `execute_trigger_with_owner_fallthrough_still_works` — owner
  (no grant) path still runs `assert_executor()`.
- `revoke_session_removes_state_and_key` — grant gone, delete_key
  promise returned, `session_revoked` event emitted.
- `revoke_expired_sessions_prunes_only_stale` — active grants
  survive, expired + exhausted are removed.
- `list_active_sessions_filters_inactive` — expired grants don't
  appear in the active view.

## §5 Event telemetry

Three new NEP-297 events on standard `"sa-automation"` version
`"1.1.0"`:

**`session_enrolled`** — emitted inside `enroll_session`.

```json
{
  "standard": "sa-automation",
  "version": "1.1.0",
  "event": "session_enrolled",
  "data": {
    "session_public_key": "ed25519:...",
    "granted_at_ms": <ms>,
    "expires_at_ms": <ms>,
    "allowed_trigger_ids": ["..."] | null,
    "max_fire_count": <n>,
    "allowance_yocto": "<u128>",
    "label": "..." | null
  }
}
```

**`session_fired`** — emitted on every session-key fire of
`execute_trigger`.

```json
{
  "event": "session_fired",
  "data": {
    "session_public_key": "ed25519:...",
    "trigger_id": "...",
    "fire_count_after": <n>,
    "max_fire_count": <n>,
    "label": "..." | null
  }
}
```

**`session_revoked`** — emitted on explicit revoke AND on each
pruned grant from `revoke_expired_sessions`, with `reason` tagged:

```json
{
  "event": "session_revoked",
  "data": {
    "session_public_key": "ed25519:...",
    "reason": "explicit" | "expired_or_exhausted"
  }
}
```

An aggregator watching `sa-automation` events can reconstruct the
complete lifecycle of every session key on the account without
access to contract state.

## §6 Relationship to other primitives

- **Native NEAR FCAK** — session keys are a SUPERSET, not a
  replacement. Every session key IS a native FCAK plus a state
  annotation. Without the annotation, the FCAK still works — session
  keys degrade gracefully.
- **`BalanceTrigger` automation** — session keys are the natural
  auth for dapp-driven automation. The `authorized_executor`
  pattern predates session keys and is still supported (the
  fall-through branch in `execute_trigger`).
- **Value threading (ch. 24) + PreGate (ch. 23) + Asserted (ch.
  21)** — orthogonal. A session key fires `execute_trigger`, which
  runs a template whose steps may carry any combination of
  `save_result`, `args_template`, `pre_gate`, or `Asserted`. The
  session-auth layer composes atop the execution-policy layer.
- **`execute_steps` (manual)** — session keys currently only
  authorize `execute_trigger`. Exposing `execute_steps` to session
  keys would require per-step or per-plan annotations (plan-hash
  allowlists?) — future work, not v1.

## §7 Deployment note

Session keys add one new `Contract` field (`session_grants`) plus
an unrelated-to-sequence-flow storage. This is a borsh schema
change — same chapter 22 migration ritual. Fresh-subaccount deploy
is recommended: `sa-session.x.mike.testnet` is the testnet target
for this chapter's live-validation step.

The flagship `examples/session-dapp.mjs` runs the full lifecycle
against that subaccount: enroll → fire 3x → verify → revoke → one
post-revoke fire (expected reject at the NEAR runtime level) →
artifact.

### Migration policy

Because `session_grants` is an `IterableMap`, an old contract can
accept a `migrate()` that `#[init(ignore_state)]`s and defaults the
new field to empty. For owner-populated `sequential-intents` →
`session-enabled` upgrades, that's the simplest path. But per repo
policy, the cleanest approach is still: deploy to a fresh
subaccount, validate, then swap downstream callers (dapps) to the
new address.

`mike.near` itself will carry all three tranches (`PreGate`,
threading, sessions) at first-deploy — no migration needed, because
no kernel state ever lived there before.
