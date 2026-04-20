# Proxy keys — `mike.near` as a universal dApp-login FCAK proxy

A proxy key is a NEAR function-call access key (FCAK) on your smart
account, pinned to one method: `proxy_call`. The paired on-chain
`ProxyGrant` records the key's allowed targets, method allowlist,
attached-deposit amount, per-call gas budget, call cap, and expiry.

The user-facing pitch is short: **your dApp login key lives on your
smart account, not on the dApp's contract**. Every dApp you connect
to adds one scoped FCAK + registry entry. Policy is visible on-chain
(`list_proxy_grants()`), instantly revocable (`revoke_proxy_key()`),
and the smart account itself pays the 1 yoctoNEAR toll required by
contracts like `intents.near` and NEP-141 FTs — something the FCAK
itself can't do (NEAR-level rule: FCAKs can't attach deposit).

## Three primitives

```rust
#[payable]
pub fn enroll_proxy_key(
    session_public_key: String,
    expires_at_ms: u64,
    allowed_targets: Vec<AccountId>,
    allowed_methods: Option<Vec<String>>,   // None = any method on allowed_targets
    attach_yocto: U128,                     // 0 normally, 1 for ft_transfer / intents.near
    max_gas_tgas: u64,                      // per-call gas budget
    max_call_count: u32,
    allowance_yocto: U128,                  // FCAK gas allowance on the smart account
    label: Option<String>,
) -> Promise;

pub fn proxy_call(target: AccountId, method: String, args: Base64VecU8) -> Promise;

pub fn revoke_proxy_key(session_public_key: String) -> Promise;
```

Plus `revoke_expired_proxy_keys()` for public hygiene, and views
`get_proxy_grant(pk)` and `list_proxy_grants()`.

## Login (once, signed with the user's full-access key)

```javascript
// Frontend generates an ephemeral keypair, stores the secret key in
// localStorage / IndexedDB. The public key gets enrolled here.
await near.account("mike.near").functionCall({
  contractId: "mike.near",
  methodName: "enroll_proxy_key",
  args: {
    session_public_key: ephemeral.publicKey.toString(),
    expires_at_ms: Date.now() + 7 * 24 * 60 * 60 * 1000,   // 7 days
    allowed_targets: ["my-cool-dapp.near"],
    allowed_methods: ["buy", "claim", "ft_transfer"],       // or null for any
    attach_yocto: "1",                                       // "0" for reads/writes
    max_gas_tgas: 30,
    max_call_count: 10000,
    allowance_yocto: "250000000000000000000000",             // 0.25 NEAR
    label: "my-cool-dapp login",
  },
  attachedDeposit: "1",                                      // 1 yN proves FAK caller
  gas: "50000000000000",                                     // 50 TGas
});
```

One transaction. The function writes the grant AND returns a Promise
that mints the FCAK. Atomic by construction.

## Call (many times, signed with the ephemeral key)

```javascript
await near.account("mike.near").functionCall({
  contractId: "mike.near",
  methodName: "proxy_call",
  args: {
    target: "my-cool-dapp.near",
    method: "buy",
    args: Buffer.from(JSON.stringify({ item: 42 })).toString("base64"),
  },
  gas: "30000000000000",
});
```

`mike.near.proxy_call` checks the signer's public key, validates
`target` / `method` against the grant, bumps `call_count`, and
dispatches `my-cool-dapp.near.buy({item:42})` with `1 yoctoNEAR`
attached **from mike.near's balance**. Downstream sees
`signer_id = mike.near` — the user, not the ephemeral key.

## Revoke

```javascript
await near.account("mike.near").functionCall({
  contractId: "mike.near",
  methodName: "revoke_proxy_key",
  args: { session_public_key: ephemeral.publicKey.toString() },
  gas: "30000000000000",
});
```

Deletes the `ProxyGrant` AND the paired FCAK in one Promise.

## Safety model

| Axis                      | Bounded by                                                      |
|---------------------------|------------------------------------------------------------------|
| What accounts can be hit  | `allowed_targets` (Vec&lt;AccountId&gt;, non-empty)                    |
| What methods can be hit   | `allowed_methods` (None = any; Some(Vec) = exact match)          |
| How much per-call deposit | `attach_yocto` (paid from smart-account balance)                 |
| How much per-call gas     | `max_gas_tgas` (upper bound on single dispatch)                  |
| Total gas across calls    | FCAK `allowance_yocto` (NEAR-native ceiling)                     |
| How many calls total      | `max_call_count`                                                 |
| How long                  | `expires_at_ms`                                                  |
| Kill switch               | `revoke_proxy_key(pk)` — owner-signed, synchronous state delete  |

### When to use `allowed_methods = None`

The `None` option skips the method allowlist entirely: the ephemeral
key can call any method on any of the allowed_targets. This is a
wider blast radius and we document it as such. Prefer
`Some(vec!["a", "b"])` when you can enumerate what the dApp actually
calls. `None` is defensible when:

- The dApp's method surface is large and stable
- The key's lifetime is short (a few hours)
- `max_call_count` is modest

### What an attacker gets if they steal the ephemeral key

Bounded by the grant:
- Max drain via `attach_yocto`: `max_call_count × attach_yocto` (yocto)
  — with typical values (`attach_yocto=1`, `max_call_count=10000`)
  that's **10000 yN ≈ 0 NEAR**.
- Method surface: whatever the `allowed_methods` allows, on the
  `allowed_targets` set.
- Session window: bounded by `expires_at_ms` AND `max_call_count`.

### What they can't do

- Add or delete keys on your account (FCAK is pinned to
  `method_name = "proxy_call"`).
- Call any other smart-account method (stored templates,
  `execute_trigger`, `execute_steps`, etc.).
- Dispatch to targets not in `allowed_targets`.
- Attach a deposit other than the one in the grant.
- Exceed `max_gas_tgas` or `allowance_yocto`.

## Relationship to session keys (`enroll_session`)

These are two separate primitives:

| Aspect                | `enroll_session` / `execute_trigger`  | `enroll_proxy_key` / `proxy_call` |
|-----------------------|---------------------------------------|------------------------------------|
| What does the key do? | Trigger a pre-registered automation   | Proxy an arbitrary call to a dApp  |
| Scope by              | `allowed_trigger_ids: Option<Vec<String>>` | `allowed_targets` + `allowed_methods` |
| Attached deposit      | Zero (or per-step `attached_deposit_yocto` in the template) | State-controlled `attach_yocto` per grant |
| Primary use case      | DCA, balance-triggered sequences      | Live dApp UI (buy, claim, sign)    |

Both write to the smart account's state (`session_grants` vs
`proxy_grants`, separate `IterableMap`s). Both mint FCAKs that route
through the Authorizer in v5 extension mode. The two patterns may
unify once we see them in production — the split is deliberate
iteration-speed.

## Events

NEP-297, `standard: sa-automation`:

- `proxy_key_enrolled` — on successful `enroll_proxy_key`. Data:
  full grant snapshot + `allowance_yocto`.
- `proxy_call_dispatched` — on every `proxy_call`. Data: signer pk,
  target, method, args byte length, attach_yocto, new call_count.
- `proxy_key_revoked` — on `revoke_proxy_key` or
  `revoke_expired_proxy_keys`. Data: pk, reason (`"explicit"` or
  `"expired_or_exhausted"`).

All three surface automatically in `observer stream` and
`observer trace`.

## Deferred (follow-ups, not in v1)

- **Pair-rolling** — two FCAKs per login that refresh each other's
  allowance when one depletes. Zero re-signing for refills.
- **Caller deposit override** — per-call `override_deposit_yocto`
  gated by a `grant.allow_override` flag, for rare callsites that
  need to vary the deposit within one grant's lifetime.
- **v5 mainnet cutover** — the proxy-call path works in v5 extension
  mode (`authorizer_id: Some(_)`) — tested via the existing testnet
  v5 rig — but mainnet `mike.near` stays v4-standalone this tranche.
