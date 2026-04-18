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
- [md-CLAUDE-chapters/21-asserted-settle-policy.md](./md-CLAUDE-chapters/21-asserted-settle-policy.md)
  — `Asserted` postcondition policy design + four testnet probes that catch
  noop and decoy pathologies

## Repo in one paragraph

This repo is a NEAR smart-account POC that uses **NEP-519 yield/resume** to
stage downstream calls as yielded receipts and then resume them in a chosen
order. The core claim is narrow and deliberate:

> the smart account creates the next real `FunctionCall` receipt only after
> the previous step's trusted completion surface resolves

Sequential here means **receipt-release order**, not exclusive chain
execution. Unrelated receipts can still interleave elsewhere on-chain.

## Current public surfaces

- `contracts/smart-account/`
  Manual sequencing (`stage_call` / `run_sequence`), per-step compatibility
  (`settle_policy` in code), and balance-trigger automation
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

Keep `settle_policy` in code. In prose, prefer **completion policy** and
**completion surface**.

- `Direct`
  Trust the target receipt's own completion surface
- `Adapter { adapter_id, adapter_method }`
  Trust a protocol-specific adapter to collapse messy async into one honest
  top-level result
- `Asserted { assertion_id, assertion_method, assertion_args, expected_return, assertion_gas_tgas }`
  After the target settles successfully, fire a caller-specified postcheck
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
  completion predicate; the error variant is `PromiseError::TooLong(size)`
  (not the generic `PromiseError::Failed`) — distinction is preserved in
  the settle log, verified live on testnet in chapter 20 §4.4

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

- in code: `settle_policy`
- in prose: completion policy / completion surface
- current docs: prefer `step`
- historical docs may still mention `latch`, `conduct`, `gated_call`, or
  `label`; treat those as period-accurate historical terms
