# CLAUDE.md — smart-account-contract

Short continuity note for future Claude sessions.

Primary sources of truth:

- [README.md](./README.md) — public overview, repo layout, validated flows
- [PROTOCOL-ONBOARDING.md](./PROTOCOL-ONBOARDING.md) — operator guide for
  onboarding new protocols safely
- [md-CLAUDE-chapters/01-near-cross-contract-tracing.md](./md-CLAUDE-chapters/01-near-cross-contract-tracing.md)
  — receipt mechanics and tracing model
- [md-CLAUDE-chapters/14-wild-contract-compatibility.md](./md-CLAUDE-chapters/14-wild-contract-compatibility.md)
  — compatibility model (`Direct` vs `Adapter`)
- [md-CLAUDE-chapters/19-protocol-onboarding-and-investigation.md](./md-CLAUDE-chapters/19-protocol-onboarding-and-investigation.md)
  — deeper rationale behind onboarding and `investigate-tx`
- [md-CLAUDE-chapters/20-pathological-contract-probe.md](./md-CLAUDE-chapters/20-pathological-contract-probe.md)
  — wild-contract pathology taxonomy + three-layer detection cross-table
- [md-CLAUDE-chapters/21-asserted-resolve-policy.md](./md-CLAUDE-chapters/21-asserted-resolve-policy.md)
  — `Asserted` postcondition policy design + four testnet probes that catch
  noop and decoy pathologies

## Repo in one paragraph

This repo is a NEAR smart-account POC that uses **NEP-519 yield/resume** to
yield downstream promises as yielded receipts and then resume them in a chosen
order. The core claim is narrow and deliberate:

> the smart account creates the next real `FunctionCall` receipt only after
> the previous step's trusted resolution surface resolves

Sequential here means **receipt-release order**, not exclusive chain
execution. Unrelated receipts can still interleave elsewhere on-chain.

## Current public surfaces

- `contracts/smart-account/`
  Manual sequencing (`yield_promise` / `run_sequence`), per-step compatibility
  (`resolution_policy` in code), and balance-trigger automation
  (`save_sequence_template` / `create_balance_trigger` / `execute_trigger`)
- `contracts/compat-adapter/`
  Real external-protocol adapter surface; currently wrap-specific
- `contracts/demo-adapter/`
  Demo-only adapter for `wild-router`
- `contracts/wild-router/`
  Small dishonest-async demo
- `contracts/pathological-router/`
  Public wild-contract probe for pure lie, gas-burn, decoy-promise, and
  oversized-payload shapes
- `scripts/investigate-tx.mjs`
  JSON-first three-surfaces investigation wrapper
- `web/`
  Static trace viewer

## Compatibility rule

In prose, the spine is **resolution policy** and **resolution surface**;
the code exposes this as `resolution_policy` on `yield_promise` and
`save_sequence_template`.

- `Direct`
  Trust the target receipt's own resolution surface
- `Adapter { adapter_id, adapter_method }`
  Trust a protocol-specific adapter to collapse messy async into one honest
  top-level result
- `Asserted { assertion_id, assertion_method, assertion_args, expected_return, assertion_gas_tgas }`
  After the target resolves successfully, fire a caller-specified postcheck
  `FunctionCall` and advance only if the returned bytes exactly match
  `expected_return`. This is not an enforced read-only view, so callers must
  choose a trustworthy postcheck surface. Catches target-state-based
  pathologies (noop, decoy) that `Direct` is blind to. See chapter 21.

Practical rule:

- empty / void success is fine in `Direct`
- a truthful returned promise chain is also fine in `Direct`
- hidden nested async requires `Adapter`
- target-state postconditions (e.g., "counter must be N" or "balance must be X")
  point toward `Asserted`
- oversized callback results currently count as failure because
  `env::promise_result_checked(0, MAX_CALLBACK_RESULT_BYTES)` is part of the
  resolution predicate; the error variant is `PromiseError::TooLong(size)`
  (not the generic `PromiseError::Failed`) — distinction is preserved in
  the resolve log, verified live on testnet in chapter 20 §4.4

## Shared testnet rig

Canonical shared rig uses `MASTER=x.mike.testnet` and currently centers on:

- `smart-account.x.mike.testnet` (primary; state was broken during an earlier
  schema bump and is kept around for historical tx lookup only)
- `sa-probe.x.mike.testnet` (chapter 20 probe subaccount, Direct/Adapter only)
- `sa-asserted.x.mike.testnet` (chapter 21 probe subaccount, Asserted-aware)
- `compat-adapter.x.mike.testnet`
- `demo-adapter.x.mike.testnet`
- `router.x.mike.testnet`
- `wild-router.x.mike.testnet`
- `pathological-router.x.mike.testnet`
- `echo.x.mike.testnet`
- `echo-b.x.mike.testnet`
- `yield-sequencer.x.mike.testnet`

Reference live signals worth knowing:

- historical latch/conduct proof:
  `4ct5RA1d4x9efJXWGxPBQRLhsPtKxw453wGpP6F8WZ3L` →
  `BW3fmRbzZGFdFrE37uxX2cMzHj6Ur1mG7FCEmjAXKVmT`
- validated owner/delegated automation runs:
  see [README.md](./README.md)
- mixed `wrap.testnet` run used by onboarding:
  `3MKbDCngBqKake71a8SDLtv8HvixnfeDZBt4HSKwaxaf`

Shared-rig churn rule:

- use fresh direct-child accounts for delete/recreate workflows
- treat long-lived shared rigs as stateful infrastructure, not disposable demo
  accounts
- more balance does not bypass NEAR's `DeleteAccountWithLargeState` guard; if
  a shared rig crosses it, either clean state explicitly or move to a fresh
  child account

## Mainnet lab rig

Dedicated sacrificial child of `mike.near` for mainnet probes. Never
deploy the smart-account contract to `mike.near` itself.

- `sequential-intents.mike.near` — **active v3** smart-account (post-Phase-A
  `execute_steps` + `StepPolicy` rename); `owner_id = mike.near`; active
  primary target for `examples/sequential-intents.mjs`,
  `examples/dca.mjs`, and `examples/wrap-and-deposit.mjs`. Deployed
  2026-04-18 via `DEPLOY-SEQUENTIAL-INTENTS.md`.
- `sa-lab.mike.near` — older (pre-rename) smart-account deployed with
  `owner_id = mike.near`; kept around for historical tx lookup only
- `echo.sa-lab.mike.near` — trivial leaf for the mainnet echo probe
- `simple-sequencer.sa-lab.mike.near` — simple-example kernel used by the
  NEAR Social variant; see `simple-example/SOCIALDB-VARIANT.md`

Validated round-trip on `sequential-intents.mike.near` (reference runs
for `examples/sequential-intents.mjs`):

- deposit-only: `3sfgmiY94t9VMzBL79Dxms3bbW4CAkTzdPT1xuyuFEoD`
- round-trip  : `7btFS8LzGQUpHari3EnzCEvyr3dU3r4egKCsnPVZMgmJ`

DCA one-tick reference (`examples/dca.mjs`, balance-trigger automation):

- save_sequence_template : `5UuUtZTi3fVu6q1Kd991fTYUwe7EcmZzuweKdXLhw42j`
- create_balance_trigger : `AAJSKYgSYVn7pwd5XtVWjPhfruAVTCfc1DRhPtdMaGJy`
- execute_trigger        : `E9VDdwXz52VfveWvZfkWKg9QTsW6oduoA1WLB5itFByX`

Safety rules:

- treat the account as disposable infrastructure; do not move meaningful
  assets into it
- keep each probe small enough that a bad surprise is cheap
- prefer a fresh child over making the primary identity account "also a
  lab"

Mainnet gas matrix (multi-action `yield_promise` calibration on
`sa-lab.mike.near`):

- single-step yielded promises stay pending cleanly at `180`, `250`, and
  `500 TGas` per outer action
- two-step yielded batches at `180` and `250 TGas` per action yield
  successfully but their yielded callbacks wake immediately with
  `PromiseError::Failed` instead of staying pending
- two-step yielded batches at `300` and `400 TGas` per action stay
  pending and drain cleanly on `run_sequence`

Useful framing: mainnet `yield_promise` is viable in the current contract
shape, but **multi-action batches have a higher per-action gas floor
than single-step probes**. Operator baseline for mainnet multi-step
probes: start at `300 TGas` per outer `yield_promise` action; treat `180` /
`250` as deliberate boundary probes rather than reasonable defaults.
This is not a blanket "mainnet yield cannot remain pending" failure — it
is a **multi-action gas-envelope boundary** in the current smart-account
shape.

## Generated-output policy

- `res/*.wasm` and `simple-example/res/*.wasm` are rebuildable local outputs,
  not tracked source
- `collab/artifacts/*.json` are local investigation products by default
- the repo keeps only two curated checked-in JSON reference examples under
  `collab/artifacts/`

## Commands

```bash
./scripts/check.sh
cargo test --workspace
./scripts/build-all.sh
MASTER=x.mike.testnet ./scripts/deploy-testnet.sh
python3 -m http.server 8000 -d web
```

## Session-critical pitfalls

- The scripted nightly wasm build path in `scripts/build-all.sh` is the known
  good testnet-compatible path on this machine.
- Actions to a single receiver in one tx are still **one receipt**. You are
  sequencing child yielded receipts, not reordering the parent receipt's
  actions.
- Top-level `SuccessValue` can coexist with failing sibling receipts. Always
  scan all receipt outcomes, not only the tx status.
- Yield timeout is semantically real: after roughly 200 blocks, an unresumed
  yielded callback wakes with `PromiseError::Failed`.
- The legacy JS `near` CLI behaves better on testnet when pointed at FastNEAR
  RPC; `deploy-testnet.sh` already does this.

## Terminology

- prose spine: **yield · resume · resolve · decay**
- in prose: resolution policy / resolution surface
- in code: `yield_promise` / `run_sequence` / `resolution_policy` —
  code and prose are aligned; the older `stage_call` /
  `settle_policy` spellings survive only in archived chapters
- current docs: prefer `step`
- historical docs may still mention `latch`, `conduct`, `gated_call`, or
  `label`; treat those as period-accurate historical terms
