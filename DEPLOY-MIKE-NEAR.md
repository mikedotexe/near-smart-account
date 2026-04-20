# Deploy — `mike.near` (mainnet v4, root identity)

**Mainnet deploy of the v4 smart-account sequencer onto `mike.near`
itself** — the root identity account, not a subaccount. Carries
all three extensions landed in this round: `PreGate` (ch. 23),
value threading (ch. 24), session keys (ch. 25).

Forked from
[`DEPLOY-SEQUENTIAL-INTENTS.md`](./DEPLOY-SEQUENTIAL-INTENTS.md)
with command bodies tested live on `sa-v4.mike.near` in Phase 1.

> ⚠️ **This is the root identity account.** Contract code here
> becomes the account's public surface. Phase 2 is deliberately
> two-step (lab first, identity second) to surface bugs on a
> sacrificial child before touching `mike.near`.

## Safety guardrails

- **Phase 1 first.** Never skip straight to Phase 2. The lab
  deploy to `sa-v4.mike.near` validates the full v4 sequencer at
  mainnet stakes.
- **No redeployment-over-populated-state without `migrate()`.**
  `new_with_owner` is `#[init]`-gated; calling it on a populated
  account panics. The sequencer ships a `migrate()` safety net
  (`#[init(ignore_state)]`) for schema-evolution redeploys.
- **206 access keys on `mike.near`.** After deploy, FCAKs whose
  `receiver_id=mike.near` and `method=<anything-we-don't-expose>`
  fail with `MethodNotFound`. Harmless but surfaces in wallet
  logs; audit if any active dapp breaks.
- **`execute_steps` is public.** Any caller can submit a plan
  under their own namespace (per-caller gas cap limits griefing).
  Same posture as `sequential-intents.mike.near`.

## Phase 0 — prerequisites

- `mike.near` credential at
  `~/.near-credentials/mainnet/mike.near.json` (present ✓).
- near-cli (JS) installed globally (`which near` → v4.0.x).
- rustup with `wasm32-unknown-unknown` target.
- `mike.near` balance ≥ 20 NEAR (Phase 1 needs 6 for sa-v4 + 2
  for probe; Phase 2 needs ~6 for the wasm storage on mike.near
  itself; plus operational headroom).
- `res/smart_account_local.wasm` present (rebuild with
  `./scripts/build-all.sh` if stale — the v4 sequencer is **~517
  KB**, notably larger than v3's ~345 KB).
- `./scripts/check.sh` green (126 Rust + 46 Node tests).

## Phase 1 — lab validation at mainnet stakes (`sa-v4.mike.near`)

**Goal.** Prove all three new primitives fire correctly on a
mainnet deployment of the v4 sequencer BEFORE touching `mike.near`.

### 1a. Create sa-v4 + probe-v4 subaccounts

```bash
near create-account sa-v4.mike.near \
  --masterAccount mike.near \
  --initialBalance 6 \
  --networkId mainnet

near create-account probe-v4.mike.near \
  --masterAccount mike.near \
  --initialBalance 2 \
  --networkId mainnet
```

**Executed 2026-04-19:**
- sa-v4 create: `9Wn4zbgApku47nuH971sxkYqQTfTzUTk14TrSfm1rr8w`
- probe-v4 create: `Cknh1VzTcBNRep7WLq32P7NrCM9577cFDwpVQZZv3koE`

### 1b. Deploy v4 sequencer + pathological-router

```bash
near deploy sa-v4.mike.near res/smart_account_local.wasm \
  --initFunction new_with_owner \
  --initArgs '{"owner_id":"mike.near"}' \
  --networkId mainnet

near deploy probe-v4.mike.near res/pathological_router_local.wasm \
  --networkId mainnet
```

**Verify:**
```bash
near view sa-v4.mike.near contract_version --networkId mainnet
# Expected: the contract_version string baked into the wasm you just
# deployed (e.g., 'v4.0.0-pregate' at initial landing, 'v4.0.2-ops'
# after the ops-hygiene tranche).
near view probe-v4.mike.near get_calls_completed --networkId mainnet
# Expected: 0
```

**Executed 2026-04-19:**
- sa-v4 deploy+init: `445RYzLKbAKpUqsJFPBZZuhYM8ZHnNYJsDwRebdmBYyR`
- probe-v4 deploy: `Ctdecum4CDAAWPo7ntQ4GhCneKhvfgpSQG52BBA2bhna`

### 1c. Seed session-dapp trigger

Session-dapp requires an existing `BalanceTrigger`. Register a
trivial 1-step template and trigger:

```bash
# Template args: base64 of {"label":"session-trigger"}
# base64($(echo -n '{"label":"session-trigger"}')) = eyJsYWJlbCI6InNlc3Npb24tdHJpZ2dlciJ9

near call sa-v4.mike.near save_sequence_template \
  '{"sequence_id":"session-probe","calls":[{"step_id":"session-step-1","target_id":"probe-v4.mike.near","method_name":"do_honest_work","args":"eyJsYWJlbCI6InNlc3Npb24tdHJpZ2dlciJ9","attached_deposit_yocto":"0","gas_tgas":30}]}' \
  --accountId mike.near --networkId mainnet --gas 100000000000000

near call sa-v4.mike.near create_balance_trigger \
  '{"trigger_id":"session-trigger","sequence_id":"session-probe","min_balance_yocto":"1","max_runs":100}' \
  --accountId mike.near --networkId mainnet --gas 100000000000000
```

**Executed 2026-04-19:** create_balance_trigger
`AEKs9JGkZnEw6XetKqRSxW9K2eqzQwA8vzvtqmKJ9Neh`.

### 1d. Run all three flagships

```bash
# PreGate
NETWORK=mainnet ./examples/limit-order.mjs \
  --signer mike.near --smart-account sa-v4.mike.near \
  --gate-contract probe-v4.mike.near \
  --target-contract probe-v4.mike.near \
  --gate-max 1000 \
  --artifacts-file collab/artifacts/sa-v4-mainnet-limit-order-20260419.json

# Value threading
NETWORK=mainnet ./examples/ladder-swap.mjs \
  --signer mike.near --smart-account sa-v4.mike.near \
  --probe-contract probe-v4.mike.near \
  --artifacts-file collab/artifacts/sa-v4-mainnet-ladder-swap-20260419.json

# Session keys
NETWORK=mainnet ./examples/session-dapp.mjs \
  --signer mike.near --smart-account sa-v4.mike.near \
  --trigger-id session-trigger \
  --artifacts-file collab/artifacts/sa-v4-mainnet-session-dapp-20260419.json
```

**Executed 2026-04-19 (reference runs):**
- limit-order: `Ce1ym3nb7ZG8soVJR3XjoGoJNCb5vc9zh1f2cX1CQd2U`
  (pre_gate_checked outcome=in_range, matched=true, gate_probe=0)
- ladder-swap: `EB1m3PmdBZR6jM3Py2ssfAKsYSttbnkwu6mzmLmFqGt5`
  (result_saved as_name=counter, last_burst="1" = 5000bps of 2)
- session-dapp: enroll `Fyo3YpXemgmqFi9nJSMFSvXE42k3xW4EQRFBxc5gUqho`
  + 3 fires + revoke `7kYVkvQYyVbyTDyJwtUteQqikVEG4bEAB3Xeyt9MifX4`
  (post-revoke fire rejected by NEAR runtime)

### 1e. Gate before Phase 2

All three flagships must reach `result: ok` / `result: completed`.
Artifacts in `collab/artifacts/sa-v4-mainnet-*.json` must carry
`"network": "mainnet"` and the expected structured events. Only
then proceed to Phase 2.

## Phase 2 — identity deploy (`mike.near`)

Only after Phase 1 is GREEN.

### 2a. Deploy v4 sequencer to mike.near

```bash
near deploy mike.near res/smart_account_local.wasm \
  --initFunction new_with_owner \
  --initArgs '{"owner_id":"mike.near"}' \
  --networkId mainnet
```

- **Init form:** `owner_id: mike.near` — `mike.near` owns itself.
- **Cost:** ~5.2 NEAR locked into storage for the 517 KB wasm
  (drawn against the account's existing balance, not a transfer).
- **Gotcha:** if a prior deploy attempt populated state and init
  failed mid-way, `new_with_owner` will panic with "contract is
  already initialized" — use `migrate` instead.

**Verify:**
```bash
near view mike.near contract_version --networkId mainnet
# Expected: the contract_version string baked into the wasm you just
# deployed (e.g., 'v4.0.0-pregate' at initial landing, 'v4.0.2-ops'
# after the ops-hygiene tranche).

near view mike.near get_authorized_executor --networkId mainnet
# Expected: null  (owner handles all authorized actions)
```

### 2b. Smoke-test each primitive on mike.near

Reuse the same flagships, pointing `--smart-account mike.near`.
`probe-v4.mike.near` stays the gate/target surface (already
deployed in Phase 1).

```bash
NETWORK=mainnet ./examples/limit-order.mjs \
  --signer mike.near --smart-account mike.near \
  --gate-contract probe-v4.mike.near \
  --target-contract probe-v4.mike.near \
  --gate-max 1000 \
  --artifacts-file collab/artifacts/mike-near-mainnet-limit-order-YYYYMMDD.json
```

Repeat for `ladder-swap.mjs` and `session-dapp.mjs` with
`--smart-account mike.near` (and seed a `session-trigger` on
`mike.near` first via the Phase 1c steps retargeted at
`mike.near`).

### 2c. Record live runs

Create
[`MAINNET-MIKE-NEAR-JOURNAL.md`](./MAINNET-MIKE-NEAR-JOURNAL.md)
logging every on-chain tx, mirrored on
[`MAINNET-V3-JOURNAL.md`](./MAINNET-V3-JOURNAL.md):

- deploy tx + init tx
- each flagship's primary tx hash
- key event excerpts (`pre_gate_checked`, `result_saved`,
  `session_*`)
- block heights for archival lookup

## Troubleshooting

- **`Cannot find contract code, expect at least N NEAR`** — wasm
  storage reservation not met. For v4's 517 KB, reserve ≥ 5.2 NEAR.
- **`The contract is not initialized`** — init step skipped or
  failed mid-way. Call
  `near call <account> new_with_owner '{"owner_id":"..."}' --accountId mike.near`
  manually.
- **`The contract already has state`** when re-deploying — use
  `--initFunction migrate` instead of `new_with_owner`. The
  migrate function is `#[init(ignore_state)]` and is idempotent.
- **`ExecutionError: Exceeded the prepaid gas`** — bump per-step
  gas via `--action-gas` (default 300 TGas for multi-action
  batches on mainnet; see `CLAUDE.md` "Mainnet gas matrix").
- **`MethodNotFound` from FCAKs** — post-deploy, old FCAKs on
  `mike.near` that targeted methods outside our surface now get
  this. Audit the `near state mike.near` output before/after
  deploy to catch breakage.

## Rollback / teardown

The v4 sequencer's `migrate()` function makes roll-forward the
default path. If a true rollback is needed:

1. Cut an empty-state wasm with only `new_with_owner` and
   redeploy with `--initFunction migrate`.
2. Or delete the contract code via an admin method exposing
   `Promise::delete_key()` + `Promise::transfer()` to drain state
   — we don't ship one; write minimally if needed.

**Do not delete mike.near itself.** It's the root identity
account with 7 FAKs, 2640+ NEAR, and the canonical public key for
`intents.near` / dapp registrations.
