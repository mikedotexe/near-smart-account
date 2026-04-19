# CLAUDE.md — smart-account-contract

Short continuity note for future Claude sessions.

Primary sources of truth:

- [README.md](./README.md) — public overview, flagship gallery, mainnet-validated runs
- [SEQUENTIAL-INTENTS-DESIGN.md](./SEQUENTIAL-INTENTS-DESIGN.md) —
  design doc: `intents.near` surface map, flagship shape, §10 battletest findings
- [MAINNET-V3-JOURNAL.md](./MAINNET-V3-JOURNAL.md) — every on-chain
  tx landed against `sequential-intents.mike.near`, with block ranges
  for archival lookup
- [DEPLOY-SEQUENTIAL-INTENTS.md](./DEPLOY-SEQUENTIAL-INTENTS.md) —
  seven-phase mainnet deploy recipe (prereq → build → create → deploy → register → validate → record)
- [PROTOCOL-ONBOARDING.md](./PROTOCOL-ONBOARDING.md) — adding a new
  protocol as a sequential-intent step (policy decision tree)
- [INTENTS.md](./INTENTS.md) — positioning note: this smart account
  vs `intents.near`, when to use which
- [SISTER-REPOS.md](./SISTER-REPOS.md) — three-repo positioning:
  this repo (product), `near-sequencer-demo` (primitive, as
  pedagogy), `manim-visualizations` (model, as pedagogy)
- [md-CLAUDE-chapters/01-near-cross-contract-tracing.md](./md-CLAUDE-chapters/01-near-cross-contract-tracing.md)
  — receipt mechanics and tracing model
- [md-CLAUDE-chapters/14-wild-contract-compatibility.md](./md-CLAUDE-chapters/14-wild-contract-compatibility.md)
  — compatibility model (`Direct` vs `Adapter`)
- [md-CLAUDE-chapters/18-keep-yield-canonical.md](./md-CLAUDE-chapters/18-keep-yield-canonical.md)
  — canonical NEP-519 lifecycle walkthrough
- [md-CLAUDE-chapters/20-pathological-contract-probe.md](./md-CLAUDE-chapters/20-pathological-contract-probe.md)
  — wild-contract pathology taxonomy + three-layer detection cross-table
- [md-CLAUDE-chapters/21-asserted-resolve-policy.md](./md-CLAUDE-chapters/21-asserted-resolve-policy.md)
  — `Asserted` postcondition policy design + four testnet probes that catch
  noop and decoy pathologies
- [md-CLAUDE-chapters/23-pre-gate-policy.md](./md-CLAUDE-chapters/23-pre-gate-policy.md)
  — `PreGate` pre-dispatch gate design + testnet probes; six-branch
  cascade covering in-range / below_min / above_max / comparison_error
  / gate_panicked + "in_range dispatches target" happy-path
- [md-CLAUDE-chapters/24-value-threading.md](./md-CLAUDE-chapters/24-value-threading.md)
  — `save_result` + `args_template` + `Substitution` + `SubstitutionOp`
  (Raw / DivU128 / PercentU128); pure-function `materialize_args`;
  `result_saved` + `args_materialize_failed` events
- [md-CLAUDE-chapters/25-session-keys.md](./md-CLAUDE-chapters/25-session-keys.md)
  — `SessionGrant` annotation layer over NEAR's native FCAK;
  `enroll_session` / `revoke_session` / `revoke_expired_sessions`;
  `session_enrolled` / `session_fired` / `session_revoked` events
- [SESSION-KEYS.md](./SESSION-KEYS.md) — user-facing session-key
  walkthrough: enroll → fire → revoke, safety model, limitations

## Repo in one paragraph

A NEAR smart account for **cross-contract composition with explicit
trust boundaries**. Ships six composable primitives on NEP-519
yield/resume, each answering one explicit question about a
cross-contract call: `Direct` / `Adapter` / `Asserted` (execution
trust), `PreGate` (pre-dispatch gate), `save_result` + `args_template`
(value threading), session keys (per-account annotated FCAK
delegation). Every combination is legal — one step can carry `PreGate`
+ `Asserted` + `args_template` + session-key auth simultaneously.
User calls `execute_steps(steps)` in one tx; the kernel registers each
step as a yielded receipt and releases them sequentially — step N+1
only fires after step N's resolution surface settles and its policy
passes. `intents.near` is the primary target (NEP-413-signed deposits,
swaps, withdrawals), but the kernel composes any multi-protocol plan.
Mainnet-validated (`Direct` / `Adapter` / `Asserted`) on
`sequential-intents.mike.near` (2026-04-18); testnet-validated
(`PreGate` / threading / session keys) on three fresh subaccounts of
`x.mike.testnet` (2026-04-19). See `MAINNET-V3-JOURNAL.md`.

Sequential here means **receipt-release order**, not exclusive chain
execution. Unrelated receipts can still interleave elsewhere on-chain.

## Current public surfaces

- `contracts/smart-account/`
  Primary intent-executor. `execute_steps(steps)` facade, manual
  `register_step` / `run_steps`, per-step `StepPolicy` + optional
  `PreGate` + optional `save_result` / `args_template` for value
  threading, balance-trigger automation (`save_sequence_template` /
  `create_balance_trigger` / `execute_trigger`), session-key
  auth hub (`enroll_session` / `revoke_session` /
  `revoke_expired_sessions` / `get_session` / `list_active_sessions`).
- `contracts/compat-adapter/`
  Real external-protocol adapter surface; currently wrap-specific
- `contracts/demo-adapter/`
  Demo-only adapter for `wild-router`
- `contracts/wild-router/`
  Small dishonest-async demo
- `contracts/pathological-router/`
  Public wild-contract probe for pure lie, gas-burn, decoy-promise, and
  oversized-payload shapes
- `examples/`
  Runnable flagships — `sequential-intents.mjs` (primary, NEAR Intents
  round-trip), `wrap-and-deposit.mjs` (cross-protocol), `dca.mjs`
  (scheduled automation), `limit-order.mjs` (PreGate demo),
  `ladder-swap.mjs` (value threading), `session-dapp.mjs`
  (session-key lifecycle)
- `scripts/lib/nep413-sign.mjs`
  NEP-413 signing helper used by `sequential-intents.mjs`
- `scripts/investigate-tx.mjs`
  JSON-first three-surfaces investigation wrapper
- `web/`
  Static trace viewer

## Compatibility rule

In prose, the spine is **step policy** and **resolution surface**;
the code exposes this as `StepPolicy` on each `Step` passed to
`execute_steps` / `register_step` / `save_sequence_template`.

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

Optional per-step **pre-dispatch gate**, orthogonal to `StepPolicy`:

- `PreGate { gate_id, gate_method, gate_args, min_bytes, max_bytes, comparison, gate_gas_tgas }`
  Before the kernel dispatches the target, it fires the gate view and
  compares returned bytes to `[min_bytes, max_bytes]` under `comparison`
  (`U128Json` / `I128Json` / `LexBytes`). In-range → dispatch target
  as usual. Out-of-range or gate panic → halt sequence cleanly with
  `pre_gate_checked.outcome` tagged accordingly, target never fires.
  Used for limit orders, freshness checks, balance minimums, rate
  limits. See chapter 23.

Optional per-step **value threading**, orthogonal to `StepPolicy`
and `PreGate`:

- `save_result: { as_name, kind }` — on successful resolution, save
  the step's promise-result bytes into the sequence context under
  `as_name`.
- `args_template: { template, substitutions }` — at dispatch time,
  materialize the real args from `${name}` placeholders in
  `template` via each `Substitution { reference, op }`. Ops:
  `Raw`, `DivU128 { denominator }`, `PercentU128 { bps }`.
  Materialize failures halt cleanly with
  `sequence_halted.error_kind: "args_materialize_*"`. See chapter 24.

Optional per-account **session keys** layered on NEAR's native
function-call access keys:

- `enroll_session(session_public_key, expires_at_ms,
  allowed_trigger_ids, max_fire_count, allowance_yocto, label)` —
  owner-only, payable (1 yoctoNEAR). Mints a restricted FCAK on
  the smart account + records a `SessionGrant`.
- Fire-path at top of `execute_trigger` — if the signer's pk
  matches a grant, enforce `{expires, fire_cap, allowlist}`, bump
  `fire_count`, emit `session_fired`. Non-session callers fall
  through to `assert_executor()`.
- `revoke_session(pk)` — owner-only; deletes state + AK
  atomically. `revoke_expired_sessions()` — public hygiene.
  See chapter 25 + top-level [`SESSION-KEYS.md`](./SESSION-KEYS.md).

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
- `sa-pregate.x.mike.testnet` (chapter 23 probe subaccount, PreGate-aware)
- `sa-threading.x.mike.testnet` (chapter 24 target; value threading)
- `sa-session.x.mike.testnet` (chapter 25 target; session keys)
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

Battletest sweep (5 kernel edges proved on mainnet v3): full tx-level log
in [`MAINNET-V3-JOURNAL.md`](./MAINNET-V3-JOURNAL.md); design-relevant
findings (halt semantics, outcome taxonomy, halt latency bifurcation,
namespace separation, back-to-back idempotency) distilled in
[`SEQUENTIAL-INTENTS-DESIGN.md` §10](./SEQUENTIAL-INTENTS-DESIGN.md).

Safety rules:

- treat the account as disposable infrastructure; do not move meaningful
  assets into it
- keep each probe small enough that a bad surprise is cheap
- prefer a fresh child over making the primary identity account "also a
  lab"

Mainnet gas matrix (multi-action `register_step` calibration on
`sa-lab.mike.near`):

- single-step yielded registrations stay pending cleanly at `180`,
  `250`, and `500 TGas` per outer action
- two-step yielded batches at `180` and `250 TGas` per action yield
  successfully but their yielded callbacks wake immediately with
  `PromiseError::Failed` instead of staying pending
- two-step yielded batches at `300` and `400 TGas` per action stay
  pending and drain cleanly on `run_steps`

Useful framing: mainnet `register_step` is viable in the current
contract shape, but **multi-action batches have a higher per-action gas
floor than single-step probes**. Operator baseline for mainnet
multi-step probes: start at `300 TGas` per outer `register_step`
action; treat `180` / `250` as deliberate boundary probes rather than
reasonable defaults. This is not a blanket "mainnet yield cannot remain
pending" failure — it is a **multi-action gas-envelope boundary** in
the current smart-account shape.

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
- **`intents.near` key-registry gotcha:** a signer's on-chain NEAR
  full-access key is NOT auto-trusted by `intents.near`. First use
  panics with `public key '<pk>' doesn't exist for account '<signer>'`.
  Bootstrap via direct call:
  `near call intents.near add_public_key '{"public_key":"ed25519:<pk>"}' --accountId <signer> --depositYocto 1 --gas 30000000000000`.
  Inspect: `intents.near.public_keys_of({account_id})`. See
  `SEQUENTIAL-INTENTS-DESIGN.md` §10.8.

## Terminology

- **External user-facing (post-Phase-A rename, current):** `execute_steps` / `register_step` / `run_steps` / `Step` / `StepInput` / `StepView` / `StepPolicy`. This is the API surface and the flagship scripts' vocabulary.
- **Internal lifecycle (NEP-519 mechanics, unchanged):** yield · resume · resolve · decay. The prose spine for what happens *inside* the contract.
- **Callback names:** `on_step_resumed`, `on_step_resolved` (renamed from `on_promise_*` during Phase A).
- **Resolution policies (user-facing names, unchanged):** `Direct`, `Adapter`, `Asserted`.
- **Pre-dispatch gate (ch. 23):** `PreGate { gate_id, gate_method, gate_args, min_bytes, max_bytes, comparison, gate_gas_tgas }`. Comparison kinds: `U128Json` / `I128Json` / `LexBytes`.
- **Value threading (ch. 24):** `SaveResult { as_name, kind }`, `ArgsTemplate { template, substitutions }`, `Substitution { reference, op }`, `SubstitutionOp` (`Raw` / `DivU128 { denominator }` / `PercentU128 { bps }`); errors: `MaterializeError::{MissingSavedResult, UnparseableSavedResult, NumericOverflow, InvalidBps, PlaceholderNotFound}`; pure function `materialize_args(template, substitutions, saved_results)`. Terminology locked 2026-04-19: `sequence` (not "plan"), `saved_results` (not "captures"), `SaveResult` (not `CaptureSpec`), `save_result` field (not `capture_return`), `Substitution.reference` (not `.token`).
- **Session keys (ch. 25):** `SessionGrant { session_public_key, granted_at_ms, expires_at_ms, allowed_trigger_ids, max_fire_count, fire_count, label }`, `SessionGrantView` adds computed `active: bool`.
- **NEP-297 events:** `step_registered`, `step_resumed`, `step_resolved_ok`, `step_resolved_err`, `sequence_started`, `sequence_completed`, `sequence_halted`, `assertion_checked`, `run_finished` (automation only), `pre_gate_checked` (ch. 23), `result_saved` (ch. 24), `session_enrolled` / `session_fired` / `session_revoked` (ch. 25). Sequence-halted `reason` tags: `downstream_failed`, `resume_failed`, `pre_gate_failed`, `args_materialize_failed`.
- **Older spellings** — `yield_promise` / `run_sequence` / `resolution_policy` (pre-Phase-A); `stage_call` / `settle_policy` (earlier still); `latch` / `conduct` / `gated_call` / `label` (historical) — survive only in archived chapters, treat as period-accurate prose.
- historical docs may still mention `latch`, `conduct`, `gated_call`, or
  `label`; treat those as period-accurate historical terms
