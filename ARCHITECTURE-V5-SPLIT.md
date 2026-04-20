# Architecture — v5 authorizer + extension split

Status: testnet-validated, mainnet migration deferred (see
[Mainnet migration](#mainnet-migration) at bottom).

## Why

The v4 sequencer runs on `mike.near` itself because `intents.near` is
account-keyed: for deposits / swaps / withdrawals through `intents.near`
to credit the user's canonical identity, the sequencer that dispatches
those calls must originate from the canonical account. That placement
solved the receiver constraint — but it fused two roles onto one account:

- **Identity** — `mike.near` is who the user is on NEAR.
- **Capability container** — the v4 sequencer carries ~5.2k lines of
  contract, long-lived state (active sessions, saved templates, balance
  triggers, saved_results, automation-run telemetry), and upgrade risk.

Fusing identity and capability costs real things:

- No surgical kill switch. Disarming the sequencer requires a full redeploy
  of a neutered binary over the user's main account.
- No parallel sequencers. An alpha / experimental sequencer can't run
  alongside the stable one because identity is a singleton.
- Upgrade risk lands on identity. A v5 rewrite has to migrate or drain
  live state on the user's main account rather than stand up cleanly
  beside it.

The v5 split keeps `mike.near` as identity and moves the sequencer
to a subaccount. They bridge via a **dispatch-back** pattern
that preserves every v4 benefit — including intents balance on root.

## Architecture

```
    User (mike.near FAK)
         │ signs tx
         ▼
    sequential-intents.x.mike.near.execute_steps(steps)    [EXTENSION]
         │ runs PreGate, materializes args, yields/resumes,
         │ emits sa-automation events, tracks saved_results,
         │ manages session grants (metadata only)
         │
         │ when dispatching a target that needs signer_id = mike.near:
         ▼
    mike.near.dispatch(target, method, args, gas_tgas)     [AUTHORIZER]
         │ env::signer_account_id() == current_account_id()?  ✓
         │ env::predecessor_account_id() ∈ extensions?        ✓
         │ forwards env::attached_deposit() through to target
         ▼
    wrap.near.ft_transfer_call(intents.near, amount, msg)
         │ predecessor = mike.near
         ▼
    intents.near.ft_on_transfer(sender_id = mike.near, …)
         │ credits intents balance to mike.near              ✓
```

`signer_id` is set by the chain at tx origination and preserved across
every receipt in the tree. So `intents.near` still sees
`signer_id = mike.near` even though the sequencer that choreographed the
call lives on a subaccount. The one extra hop (extension → authorizer
→ target) costs ~10 TGas per target dispatch.

View calls inside a step — `PreGate` checks and `Asserted` postcheck
verifications — stay direct (extension → view contract) because they
don't mutate target-keyed state, so they don't need the authorizer
hop. Only the *target* dispatch routes through root.

## Security model

Two-factor authorization on every extension-callable method on the
authorizer (`dispatch`, `add_session_key`, `delete_session_key`):

1. **Signer = self.** `env::signer_account_id() == env::current_account_id()`.
   The chain sets `signer_id` unspoofably. This proves the user
   initiated the top-level tx under their own identity (directly, or via
   a session key that `mike.near` previously minted). An attacker
   signing into the extension with their own key fails this check.

2. **Predecessor ∈ allowlist.** `env::predecessor_account_id()` is in
   `extensions: IterableSet<AccountId>`. Only accounts explicitly added
   by the authorizer's owner can call dispatch. An unarmed subaccount
   — even one named `sequential-intents.x.mike.near` — fails.

Properties:

- A compromised extension can only act when `mike.near` is signing
  anyway. That's the same attack surface as v4 — no expansion.
- An attacker who deploys a rogue subaccount cannot call `dispatch`:
  they fail the predecessor check.
- An attacker who somehow gets a transaction signed by `mike.near`
  targeting some OTHER contract (not the extension) can't leverage
  the authorizer: `env::predecessor` at the authorizer must match
  an armed extension, which they won't.

## Kill switch

Disarming an extension is one owner-signed tx:

```bash
near call mike.near remove_extension '{"account_id":"sequential-intents.x.mike.near"}' \
  --accountId mike.near
```

After that:

- The extension's own state (active sessions, saved templates, pending
  triggers, saved_results) is UNCHANGED. The extension can still
  accept reads and emit events from its own state.
- Target dispatches through the extension begin to fail at the
  authorizer with `"authorizer: predecessor '...' is not in the
  authorized extensions list"`.
- Session keys previously minted on `mike.near` with `receiver =
  extension` remain on the keyring. They'd sign tx into
  `extension.execute_trigger` → which would attempt to dispatch →
  would fail at the authorizer. No downstream effects.

Re-arming is symmetric:

```bash
near call mike.near add_extension '{"account_id":"sequential-intents.x.mike.near"}' \
  --accountId mike.near
```

## Session keys

In v4, session keys were minted on `mike.near` (the smart-account's own
account) with `receiver = mike.near`, `method = execute_trigger`. The
dapp held the private key and signed tx → `mike.near.execute_trigger`.

In v5, session keys are STILL minted on `mike.near` (root), but with
`receiver = sequential-intents.x.mike.near` (the extension),
`method = execute_trigger`. The dapp signs tx → extension.execute_trigger
with `signer_id = mike.near`. The extension validates the session grant
(expires, fire caps, allowlist) against its local `SessionGrant`
state and dispatches the sequence; downstream target calls preserve
`signer_id = mike.near` and (via the authorizer hop) `predecessor =
mike.near`.

Root holds the *capability* (raw FCAK); the extension manages the
*annotation layer* (expires, fire caps, allowed trigger IDs, labels,
fire_count bookkeeping). This is the same separation the core
architecture draws: identity at root, management at extension.

`enroll_session` on the extension records the grant metadata locally,
then returns a `Promise` that calls `authorizer.add_session_key(pk,
allowance, receiver = extension, method = "execute_trigger")`. The
authorizer's `add_session_key` is gated by the same two-factor check as
`dispatch`, then performs the actual `add_access_key_allowance` action
on its own account.

## What changes vs v4

From a user / dapp / operator perspective, almost nothing:

- Flagship scripts still call `execute_steps`, `save_sequence_template`,
  `create_balance_trigger`, `execute_trigger`, `enroll_session`,
  `revoke_session`. Same signatures, same events, same state layout
  for everything above the dispatch seam.
- Session-keyed dapps sign tx targeting the extension instead of root
  — one config change, no protocol-level change.
- `intents.near` balances land on `mike.near` exactly as before.
- All four reference artifacts remain accurate for the v4
  topology on `mike.near` (v4 stays deployed; v5 is the *next* mainnet
  deploy, covered by a separate migration plan).

What changes at the receipt level:

- Every target dispatch acquires one extra hop: extension → authorizer
  → target → callback (four receipts instead of three for a single
  Direct step).
- NEP-297 events emit from the extension's `current_account_id` (the
  subaccount), not from root. Indexers / artifact readers need to
  know which account to scan. Existing reference-artifact verification
  paths (e.g. `scripts/verify-mainnet-claims.sh`) are coupled to the
  v4 topology; they stay as-is until mainnet v5 lands and new
  reference artifacts are captured.

## Standalone mode preserved

The smart-account sequencer carries an `authorizer_id: Option<AccountId>`
field. When `None` (the default), it behaves exactly as v3/v4 did —
target dispatches go directly to the target, session keys are minted
on the smart-account's own account. This is the path `cargo test`
exercises by default and it continues to work for the existing v3
deploy at `sequential-intents.mike.near` even after redeploying the
v5-aware binary (via `migrate()`, which promotes v4 state to v5 shape
with `authorizer_id: None`).

`set_authorizer(Some(…))` switches the live sequencer into extension mode
without redeploy. `set_authorizer(None)` switches it back. Both are
owner-only. This means a single binary runs both shapes, and an
operator can flip between them for A/B comparison on testnet without
rebuilding.

## Multi-extension pattern (future)

The authorizer's `extensions` is a set, not a single pointer. Nothing
stops `mike.near` from arming more than one extension at once:

```
mike.near
├── sequential-intents.x.mike.near  (armed, stable)
├── trading-bot.x.mike.near         (armed, owned by a trading agent)
├── dao-proxy.x.mike.near           (armed, forwards DAO proposals)
└── v6-alpha.x.mike.near            (armed during testing, disarmed otherwise)
```

Each extension is authorized independently. Disarming one doesn't
affect the others. This is a forward direction, not something we're
standing up in this tranche.

## Mainnet migration

Explicitly deferred to a separate plan with explicit user sign-off.
The blocker is operational, not architectural:

- `mike.near` currently carries v4 state: active session grants, saved
  sequence templates, balance triggers, and (potentially) in-flight
  automation runs from the four reference flagships. Migrating to v5
  means either:
  - (a) draining v4 state first — revoke all sessions, delete all
    triggers, delete all templates — then `migrate()` to the
    authorizer shape (which has only `owner` + `extensions` — a very
    different struct than the v4 Contract), then deploy the extension
    sequencer to a fresh subaccount.
  - (b) skipping root migration entirely: leave v4 running on
    `mike.near`, deploy v5 authorizer + extension to a fresh account
    pair (e.g. `mike2.near` + `sequential-intents.x.mike2.near`), and
    retire `mike.near` as the smart-account identity over time.

- The four reference artifacts in `collab/artifacts/reference/` are
  tied to v4-on-mike.near event topology. A v5 deploy on new accounts
  means new artifact regeneration (testnet → mainnet flagship
  recapture).

Both paths are fine; choosing between them is a user decision with
different operational costs (user-facing identity churn vs v4 state
drain). This tranche stands up the v5 architecture, validates it on
testnet, and hands the mainnet cutover to a later decision.

## Critical files

### New
- `contracts/authorizer/` — the thin root contract
- `contracts/authorizer/src/lib.rs` — ~280 lines, 14 unit tests
- This document

### Modified
- `contracts/smart-account/src/lib.rs` — adds
  `authorizer_id: Option<AccountId>` on `Contract`, a new
  `new_with_owner_and_authorizer` init path, `set_authorizer` /
  `get_authorizer`, `build_call_promise` + `build_session_add_key_promise`
  + `build_session_delete_key_promise` helpers that route either direct
  or through the authorizer, and a `ContractV4` legacy sibling +
  `migrate()` update promoting v4 state to v5
- `Cargo.toml`, `scripts/build-all.sh`, `scripts/check.sh`,
  `scripts/deploy-testnet.sh` — workspace registration + paired
  deployment wiring
- `CLAUDE.md` — primary-sources list + current public surfaces
- `README.md` — brief pointer

## Verification

Unit tests on both crates exercise:

- **Authorizer**: two-factor auth under four scenarios (pass / unarmed
  extension / wrong signer / owner-only allowlist curation), plus
  session-key mint + delete gated by the same auth.
- **Smart-account**: `authorizer_id` round-trips through init and
  `set_authorizer`; owner-only `set_authorizer`; extension mode
  routes Direct + Adapter steps through the authorizer (receipt goes
  to authorizer, not target); standalone mode goes direct; extension
  mode routes session mint + revoke through the authorizer.

Run:

```bash
cargo test -p authorizer
cargo test -p smart-account
./scripts/check.sh           # workspace-wide: cargo check + JS tests
```

## Testnet recipe

**Design constraint surfaced during first deploy.** The authorizer
must live at the account whose FAK signs the top-level tx — because
the `signer_id == current_account_id()` check at the authorizer
only passes when the user's signer IS this account. Our initial
testnet attempt put authorizer at `authorizer.x.mike.testnet` (a
subaccount) and used `x.mike.testnet` as the signer; the first
`dispatch` panicked cleanly with exactly the expected auth failure:

> authorizer: signer_id 'x.mike.testnet' must equal current_account_id
> 'authorizer.x.mike.testnet' (user must sign the top-level tx on
> this account)

This is the architecture working correctly. The fix is to deploy
authorizer ON the user's canonical signer account, mirroring the
mainnet-direction placement (authorizer at `mike.near`, not at a
subaccount).

`scripts/deploy-testnet.sh` therefore deploys the smart-account in
*standalone mode* only (`authorizer_id: None`) — the script's
"each contract on a subaccount" model doesn't fit the v5 topology.
For the v5 pair, run this recipe by hand after a normal deploy:

```bash
MASTER=x.mike.testnet
SA=smart-account-v5.x.mike.testnet

# (0) Build + deploy the existing shared rig (echo, router, etc.)
#     and a fresh standalone smart-account to a non-colliding name
#     so we don't have to delete the v4 state on smart-account.x.MASTER:
near create-account "$SA" --masterAccount "$MASTER" --initialBalance 10 --networkId testnet
near deploy "$SA" res/smart_account_local.wasm \
  --initFunction new_with_owner_and_authorizer \
  --initArgs "{\"owner_id\":\"$MASTER\",\"authorizer_id\":\"$MASTER\"}" \
  --networkId testnet

# (1) Deploy authorizer AT $MASTER (the signer's canonical account):
near deploy "$MASTER" res/authorizer_local.wasm \
  --initFunction new_with_owner \
  --initArgs "{\"owner_id\":\"$MASTER\"}" \
  --networkId testnet

# (2) Arm the extension:
near call "$MASTER" add_extension "{\"account_id\":\"$SA\"}" \
  --accountId "$MASTER" --networkId testnet

# (3) Exercise the hop — one-step plan through echo:
ARGS_B64=$(printf '%s' '{"n":42}' | base64)
STEPS='[{"step_id":"one","target_id":"echo.x.mike.testnet","method_name":"echo","args":"'$ARGS_B64'","attached_deposit_yocto":"0","gas_tgas":30,"policy":"Direct","pre_gate":null,"save_result":null,"args_template":null}]'
near call "$SA" execute_steps "{\"steps\":$STEPS}" \
  --accountId "$MASTER" --gas 300000000000000 --networkId testnet
```

### Validated live on testnet (2026-04-19)

First full cycle landed on `x.mike.testnet` +
`smart-account-v5.x.mike.testnet`:

| Step | Tx hash | Notes |
|---|---|---|
| authorizer deploy at `x.mike.testnet` | `FgCAkSKSxUmTXodaP8knxVggfWZk6Ce9tQwEnzSmjfSt` | `contract_version = authorizer-v5.0.0` |
| smart-account-v5 deploy | `3bFDJqH8sq63ytmgvZ3zyanbpn1YnEzRuW6MgKyCn75A` | init in extension mode, `authorizer_id = x.mike.testnet` |
| `add_extension` (arm) | `EPYwyjxdzGVTaDqmzo2r2bnyJHB1rVPkN7J2c9T9DAAV` | event: `extension_added account_id=smart-account-v5.x.mike.testnet` |
| `execute_steps` through hop (pass) | `6xiTMCvkaTQTsii5ZQLAvJiotyZ1bAwxGGHZumqApe2C` | `step_resolved_ok`, `result_bytes_len: 2`, `sequence_completed` |
| `remove_extension` (disarm) | `HPDiZzQ3bjfxk3sjeFFiFSeYeZZbo73eCEqwLGUwUaSQ` | event: `extension_removed` |
| `execute_steps` after disarm (halt) | — | clean panic at authorizer: `"authorizer: predecessor 'smart-account-v5.x.mike.testnet' is not in the authorized extensions list"`; emits `step_resolved_err` + no misleading `sequence_completed` |
| `add_extension` (re-arm) | `Bpd2nueky6K3pV1riYf13ftH1sM4AQ5SepMTHDWfbdE1` | surgical restore |
| `execute_steps` after re-arm (pass) | — | `step_resolved_ok` + `sequence_completed` |

The kill switch / re-arm cycle is real and surgical: disarm freezes
the extension's ability to act through root without touching any of
its own state (templates, sessions, saved_results preserved). Re-arm
resumes cleanly.
