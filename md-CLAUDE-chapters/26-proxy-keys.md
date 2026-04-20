# 26 — Proxy keys (`proxy_call`)

## What this primitive is

A `ProxyGrant` is a policy-bearing registry entry paired with a NEAR
function-call access key (FCAK) on the smart account. The FCAK is
pinned to `method_name = "proxy_call"`, so every call signed with the
ephemeral key routes through a single entry point on the smart
account. That entry point validates the grant and dispatches the
downstream call **from the smart account's balance**, attaching a
state-controlled `attach_yocto`.

Net effect: the dApp's local-storage key can call `intents.near.add_public_key`
(requires 1 yN), `ft_transfer` (requires 1 yN), and other deposit-
requiring methods — without breaking NEAR's hard rule that FCAKs
cannot attach any deposit.

## Why this primitive exists

NEAR dApps typically create login FCAKs that target the dApp's own
contract. That makes each dApp its own policy surface: the FCAK is
scoped to `methodName = "some_method"` on `receiverId = "dapp.near"`,
and that's it. A user auditing their active keys has to check N
dApps to understand what's running.

Proxy keys invert the pattern. Every dApp login mints an FCAK
targeting the smart account. Policy lives on-chain in
`proxy_grants: IterableMap<String, ProxyGrant>`, audit is
`list_proxy_grants()`, revoke is `revoke_proxy_key(pk)`, and the
`attach_yocto` config makes one entry point (`proxy_call`) compatible
with both zero-deposit and 1-yN-deposit downstream contracts.

## Load-bearing mechanic: state-controlled deposit

NEAR FCAKs enforce `deposit == 0` at the protocol level. An FCAK
calling `mike.near.proxy_call(...)` attaches zero deposit to that
call — fine. Inside `proxy_call`, the smart account builds a fresh
`Promise` to the downstream target and attaches
`NearToken::from_yoctonear(grant.attach_yocto.0)` drawn from
**mike.near's account balance**. The outgoing Promise is a regular
cross-contract call made by a contract, not a user tx, so the
no-deposit rule doesn't apply.

This is how the ephemeral key can effectively pay 1 yN for
`intents.near.add_public_key` without the user touching a
full-access-key-signed transaction.

## Policy surface

| Field                 | Semantics                                                               |
|-----------------------|--------------------------------------------------------------------------|
| `allowed_targets`     | `Vec<AccountId>` — non-empty list of downstream contracts                |
| `allowed_methods`     | `Option<Vec<String>>` — None = any method; Some = exact match            |
| `attach_yocto`        | `U128` — deposit attached to every outgoing dispatch                     |
| `max_gas_tgas`        | `u64` — per-call gas budget                                              |
| `max_call_count`      | `u32` — total calls allowed over the grant's lifetime                    |
| `expires_at_ms`       | `u64` — wall-clock expiry (ms since epoch)                               |
| `allowance_yocto`     | FCAK-level gas budget on mike.near (NEAR-native, not on the grant)       |

Two kill switches: `revoke_proxy_key(pk)` (owner-signed, synchronous)
and `revoke_expired_proxy_keys()` (public hygiene; only removes
already-unusable grants).

## Atomicity

`enroll_proxy_key` is `#[payable]` with a 1-yN floor (proves
full-access-key caller). The method writes the `ProxyGrant` into
state AND returns a `Promise` that mints the FCAK via the same
`build_session_*_key_promise` routing as session keys. Standalone
mode adds the key directly; v5 extension mode routes through the
Authorizer's `add_session_key` primitive.

The AddKey action happens asynchronously in the returned Promise. If
that action fails (e.g., the public key is already in use), the
registry entry is already written and becomes orphaned. Same risk as
`enroll_session`. Mitigation: user calls `revoke_proxy_key(pk)` to
clean up. Follow-up: an `on_proxy_key_added` callback that rolls
back state on failure.

## Comparison vs `execute_trigger` session keys

| Aspect                        | `execute_trigger`                          | `proxy_call`                            |
|-------------------------------|--------------------------------------------|-----------------------------------------|
| FCAK pinned method            | `execute_trigger`                          | `proxy_call`                            |
| Scope                         | `allowed_trigger_ids: Option<Vec<String>>` | `allowed_targets` + `allowed_methods`   |
| What the key triggers         | A pre-registered `SequenceTemplate`        | An ad-hoc downstream call               |
| Per-call deposit              | Zero (or per-step deposit from template)   | `attach_yocto` from the grant           |
| Fire accounting               | `fire_count` / `max_fire_count`            | `call_count` / `max_call_count`         |
| Primary use case              | DCA, balance triggers, scheduled batches   | Live dApp UI (buy, claim, sign)         |
| State map                     | `session_grants`                           | `proxy_grants`                          |

Both primitives coexist. A single user can have session keys AND
proxy keys active simultaneously; each lives in its own `IterableMap`
and is scoped to its own method on the smart account.

## Events

All three proxy-key events emit as NEP-297 `standard: sa-automation`:

- `proxy_key_enrolled` — on enroll. Data includes the full grant
  snapshot + `allowance_yocto`.
- `proxy_call_dispatched` — on every `proxy_call`. Data includes
  signer pk, target, method, args byte length, `attach_yocto`,
  new `call_count`, grant label.
- `proxy_key_revoked` — on explicit revoke (`reason: "explicit"`)
  and on expiry-prune (`reason: "expired_or_exhausted"`).

Observer tooling picks these up automatically — `observer stream`
emits them as jsonl; `observer trace` inlines them under the
emitting receipt in the ASCII walkthrough.

## Migration

New field `proxy_grants: IterableMap<String, ProxyGrant>` on
`Contract`. Required a borsh-breaking schema bump. `migrate()`
handles three shapes:

1. Current (v5.1 w/ `proxy_grants`) — fresh deploys + already-migrated.
2. v5 (`authorizer_id` present, no `proxy_grants`) — the
   v5.0.0-split shape on `x.mike.testnet` as of 2026-04-19.
   Promoted by appending an empty `proxy_grants` map.
3. v4 (no `authorizer_id`, no `proxy_grants`) — the pre-split
   mainnet shape on `mike.near`. Promoted by appending both.

`contract_version` returns `"v5.1.0-proxy"` after this tranche lands.

## Flagship probe

`examples/proxy-dapp.mjs` is the canonical live demonstration. Default
invocation enrolls a grant with `attach_yocto = "1"` and target method
`require_one_yocto` — a `#[payable]` sibling added to
`pathological-router` that asserts `env::attached_deposit() == 1 yN`
and panics otherwise. Because FCAK-signed txs carry `deposit = 0` at
the protocol level, a successful dispatch is falsifiable evidence that
the smart account's state-controlled `attach_yocto` mechanic paid the
toll from its own balance on the outgoing Promise. The flagship
captures counter-delta, grant state before/after revoke, and
`signer_preserved_at_target` (the target-receipt `predecessor` equals
the smart account, confirming signer propagation along the Promise
chain).

Falsifiable boundary variant: `--attach-yocto 0 --target-method do_honest_work`
runs the same plumbing with a zero-deposit target. Both invocations
should succeed; dropping attach_yocto to 0 while keeping the
`require_one_yocto` target panics at the downstream contract — the
mechanic is load-bearing.

## Testnet / mainnet status

- **Unit-tested:** 12 new tests in `contracts/smart-account/src/lib.rs`
  + 3 new tests in `contracts/pathological-router/src/lib.rs` covering
  the `require_one_yocto` probe.
- **Testnet validated (2026-04-20):** deployed `v5.1.0-proxy` to
  `sa-proxy.x.mike.testnet` (owner `x.mike.testnet`); pathological-router
  redeployed with `require_one_yocto`. Flagship
  `examples/proxy-dapp.mjs` run end-to-end — enroll + 3 proxy_call hops
  at `attach_yocto=1` + revoke + post-revoke rejection, all landed.
  Counter delta = 3, state-controlled deposit mechanic demonstrated,
  target-receipt predecessor = smart account (signer preserved).
  Reference artifact at
  `collab/artifacts/reference/sa-proxy-x-mike-testnet-v5.1.0-proxy-dapp.json`.
  Live tx hashes:
  - deploy         : [`9L4pNXkvQDAeothC9943pUyLdEuXLfwsfeJAb3ZtDFj5`](https://testnet.nearblocks.io/txns/9L4pNXkvQDAeothC9943pUyLdEuXLfwsfeJAb3ZtDFj5)
  - enroll         : `9wy36HvviTikVPqqy7ue4cK9N8MZPUT2EWQA8PpLY361`
  - proxy_call #1  : `2ivhfcpDG4HMDzhMGXozhMtdZBr5AyrexNzQchd4tuUC`
  - proxy_call #2  : `uUEWCKBXdJNJJFW9wGNi3Ws1x12LbaDy3XpDeb3iGaM`
  - proxy_call #3  : `CFB8FYqJgbUHXh2EaQQ8jxYyZX9SwRQbWYdWCYhijRY2`
  - revoke         : `38uzNofJFAhFJytR1a9wtT31jENXgyC1addim9VoFGYW`
- **Mainnet cutover** (`mike.near`): still at `v4.0.2-ops`, deliberately
  unchanged. `MAINNET-MIKE-NEAR-JOURNAL.md` will carry tx-level evidence
  once the v5.1.0-proxy migration runs there.

## Deferred

- Pair-rolling (double-buffered FCAKs refreshing each other's
  allowance on depletion, zero re-signing for refills).
- Per-call deposit override (`override_deposit_yocto: Option<U128>`
  gated by a `grant.allow_override: bool` flag).
- `on_proxy_key_added` callback to roll back state on async AddKey
  failure.
