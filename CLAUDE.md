# CLAUDE.md — smart-account-contract

Short continuity note for future Claude sessions.

Primary sources of truth:

- [README.md](./README.md) — public overview, flagship gallery, mainnet-validated runs
- [QUICK-VERIFY.md](./QUICK-VERIFY.md) — 60-second falsifiable-proof
  path: four curls against public archival RPC
  ([`docs.fastnear.com`](https://docs.fastnear.com)) confirm the
  4-primitive mainnet flagship
- [MAINNET-PROOF.md](./MAINNET-PROOF.md) — deep verification dive:
  trust-model table (three orthogonal surfaces, time-budgeted) and
  per-recipe walkthroughs for all four reference artifacts in
  `collab/artifacts/reference/`
- [SEQUENTIAL-INTENTS-DESIGN.md](./SEQUENTIAL-INTENTS-DESIGN.md) —
  design doc: `intents.near` surface map, flagship shape, §10 battletest findings
- [MAINNET-V3-JOURNAL.md](./MAINNET-V3-JOURNAL.md) — every on-chain
  tx landed against `sequential-intents.mike.near`, with block ranges
  for archival lookup
- [DEPLOY-SEQUENTIAL-INTENTS.md](./DEPLOY-SEQUENTIAL-INTENTS.md) —
  seven-phase mainnet deploy recipe (prereq → build → create → deploy → register → validate → record)
- [PROTOCOL-ONBOARDING.md](./PROTOCOL-ONBOARDING.md) — adding a new
  protocol as a sequential-intent step (policy decision tree)
- [FLAGSHIP-HOWTO.md](./FLAGSHIP-HOWTO.md) — contributor guide:
  composing primitives into a new runnable flagship. Decision
  table + common skeleton + artifact conventions + worked example.
- [ARCHITECTURE-V5-SPLIT.md](./ARCHITECTURE-V5-SPLIT.md) — v5
  architectural split: thin Authorizer on root + Extension sequencer on
  subaccount with a dispatch-back pattern that preserves `signer_id =
  root` at downstream receivers. Testnet-validated in this tranche;
  mainnet migration explicitly deferred.
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
- [md-CLAUDE-chapters/26-proxy-keys.md](./md-CLAUDE-chapters/26-proxy-keys.md)
  — `ProxyGrant` + `proxy_call`: smart-account as universal dApp-login
  FCAK proxy. FCAK pinned to `method_name = "proxy_call"`; grant carries
  `allowed_targets` + `allowed_methods` + state-controlled `attach_yocto`
  so the smart account pays the 1 yN toll for `intents.near.add_public_key`
  / NEP-141 transfers without breaking NEAR's FCAK-can't-attach-deposit
  rule. `proxy_key_enrolled` / `proxy_call_dispatched` / `proxy_key_revoked`
  events.
- [PROXY-KEYS.md](./PROXY-KEYS.md) — user-facing proxy-key walkthrough:
  login batch → proxy_call → revoke, safety model, comparison vs
  session keys.

## Repo in one paragraph

**The gap this fills.** Native NEAR `Actions` batch multiple
`FunctionCall`s in one tx, but all must target one `receiver_id`;
cross-contract workflows default to fire-and-forget async. This
sequencer ships **sequential, policy-gated, multi-receiver composition
in one signed plan** — step N+1 only fires after step N's resolution
surface settles AND its policy passes.

**Mechanic: NEP-519 yield/resume.** A step yields its callback
receipt; the receipt stays pending on-chain until the sequencer resumes
it (triggered by the target's resolution); after ~200 blocks an
unresumed callback decays with `PromiseError::Failed`. The sequencer
registers each step as a yielded receipt and releases them
sequentially. See chapter 18 for the canonical walkthrough.

**Six composable primitives,** each answering one explicit question
about a cross-contract call: `Direct` / `Adapter` / `Asserted`
(execution trust), `PreGate` (pre-dispatch gate), `save_result` +
`args_template` (value threading), session keys (per-account
annotated FCAK delegation). Every combination is legal — one step
can carry `PreGate` + `Asserted` + `args_template` + session-key
auth simultaneously. User calls `execute_steps(steps)` in one tx.
`intents.near` is the primary receiver (NEP-413-signed deposits, swaps,
withdrawals), but the sequencer composes any multi-protocol plan.

**Validation.** All six primitives mainnet-validated on `mike.near`
as sequencer version `v4.0.2-ops` (2026-04-19). Four reference
artifacts in `collab/artifacts/reference/`: three isolate one
primitive each (`limit-order` / `ladder-swap` / `session-dapp`); the
fourth (`intents-deposit-limit`) composes four primitives in one
real-dapp flow on `intents.near` — `PreGate × 2` + threading +
session key, pass+halt both proved in one session. Falsifiable from
public archival RPC in ≤ 2 minutes via `QUICK-VERIFY.md`; tx-level
detail for the `sequential-intents` / DCA / battletest sweep lives
in `MAINNET-V3-JOURNAL.md`.

Sequential here means **receipt-release order**, not exclusive chain
execution. Unrelated receipts can still interleave elsewhere on-chain.

## Current public surfaces

- `contracts/smart-account/`
  Primary intent-executor. `execute_steps(steps)` facade, manual
  `register_step` / `run_sequence`, per-step `StepPolicy` + optional
  `PreGate` + optional `save_result` / `args_template` for value
  threading, balance-trigger automation (`save_sequence_template` /
  `create_balance_trigger` / `execute_trigger` /
  `get_automation_run` / `list_automation_runs` /
  `automation_runs_count` / `prune_finished_automation_runs`),
  session-key auth hub (`enroll_session` / `revoke_session` /
  `revoke_expired_sessions` / `get_session` / `list_active_sessions`).
  As of v5.0.0-split carries an optional `authorizer_id` — when set,
  target dispatches + session-key mint/revoke route through the
  paired Authorizer contract (see next). When unset, behaves exactly
  as v3/v4 did (standalone mode, backward-compat).
- `contracts/authorizer/`
  Root-shape thin contract for the v5 split. Holds the
  owner-managed `extensions: IterableSet<AccountId>` allowlist +
  three extension-callable primitives: `dispatch(target, method,
  args, gas_tgas)`, `add_session_key(pk, allowance, receiver,
  method)`, `delete_session_key(pk)`. Every extension-callable
  method asserts two-factor: `signer_id == current_account_id`
  (user signed top-level tx) AND `predecessor ∈ extensions`
  (caller is armed). Owner can add/remove extensions for surgical
  disarm without redeploy. See `ARCHITECTURE-V5-SPLIT.md`.
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
  (session-key lifecycle), `intents-deposit-limit.mjs`
  (4-primitive real-dapp flagship: `PreGate × 2` + threading +
  session key, gating a wNEAR deposit into `intents.near` on a
  live Ref Finance quote)
- `scripts/lib/nep413-sign.mjs`
  NEP-413 signing helper used by `sequential-intents.mjs`
- `scripts/investigate-tx.mjs`
  JSON-first three-surfaces investigation wrapper
- `web/`
  Static trace viewer
- `observer/`
  Rust binary crate (`smart-account-observer`) with two modes:
  - `stream` polls FastNEAR's neardata service, filters receipt
    outcomes by `executor_id`, parses `EVENT_JSON:` log lines,
    emits one jsonl line per event on stdout. Live feed —
    complements `scripts/aggregate-runs.mjs` (retroactive) and
    the client-authored `examples/*.mjs` artifact path.
  - `trace` fetches one tx from FastNEAR's TX API
    (`tx.main.fastnear.com/v0/transactions`) and renders a
    receipt-DAG walkthrough: execution-ordered rows anchored to
    block heights, NEP-519 yield/resume correlation, event
    inlining, gas burn, refund collapsing. Pedagogical surface
    for the sequencer thesis — block heights and receipt IDs in
    the output stay verifiable forever via archival RPC. Also
    emits structured `--json` for downstream tooling.

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
  Before the sequencer dispatches the target, it fires the gate view and
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
- `sa-proxy.x.mike.testnet` (chapter 26 target; proxy keys — `v5.1.0-proxy`, standalone-mode; deployed 2026-04-20 with owner `x.mike.testnet`)
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

The stable v4 sequencer lives on `mike.near` itself; ancillary v3 +
older probes live on child accounts.

- `mike.near` — **active v4 smart-account**, sequencer version
  `v4.0.2-ops` since 2026-04-19 (redeploys use `migrate()`, not
  `new_with_owner`). Active target for `examples/limit-order.mjs`,
  `examples/ladder-swap.mjs`, `examples/session-dapp.mjs`, and
  `examples/intents-deposit-limit.mjs`. Four reference artifacts
  in `collab/artifacts/reference/`; falsifiable-proof walkthrough
  in [`QUICK-VERIFY.md`](./QUICK-VERIFY.md) /
  [`MAINNET-PROOF.md`](./MAINNET-PROOF.md).
- `sequential-intents.mike.near` — **v3** smart-account (post-Phase-A
  `execute_steps` + `StepPolicy` rename); `owner_id = mike.near`;
  primary target for `examples/sequential-intents.mjs`,
  `examples/dca.mjs`, and `examples/wrap-and-deposit.mjs`. Deployed
  2026-04-18 via `DEPLOY-SEQUENTIAL-INTENTS.md`.
- `sa-lab.mike.near` — older (pre-rename) smart-account deployed with
  `owner_id = mike.near`; kept around for historical tx lookup only
- `echo.sa-lab.mike.near` — trivial leaf for the mainnet echo probe
- `simple-sequencer.sa-lab.mike.near` — simple-example sequencer used by the
  NEAR Social variant; see `simple-example/SOCIALDB-VARIANT.md`

Validated round-trip on `sequential-intents.mike.near` (reference runs
for `examples/sequential-intents.mjs`):

- deposit-only: `3sfgmiY94t9VMzBL79Dxms3bbW4CAkTzdPT1xuyuFEoD`
- round-trip  : `7btFS8LzGQUpHari3EnzCEvyr3dU3r4egKCsnPVZMgmJ`

DCA one-tick reference (`examples/dca.mjs`, balance-trigger automation):

- save_sequence_template : `5UuUtZTi3fVu6q1Kd991fTYUwe7EcmZzuweKdXLhw42j`
- create_balance_trigger : `AAJSKYgSYVn7pwd5XtVWjPhfruAVTCfc1DRhPtdMaGJy`
- execute_trigger        : `E9VDdwXz52VfveWvZfkWKg9QTsW6oduoA1WLB5itFByX`

Battletest sweep (5 sequencer edges proved on mainnet v3): full tx-level log
in [`MAINNET-V3-JOURNAL.md`](./MAINNET-V3-JOURNAL.md); design-relevant
findings (halt semantics, outcome taxonomy, halt latency bifurcation,
namespace separation, back-to-back idempotency) distilled in
[`SEQUENTIAL-INTENTS-DESIGN.md` §10](./SEQUENTIAL-INTENTS-DESIGN.md).

Safety rules:

- treat lab accounts as disposable infrastructure; do not move
  meaningful assets into them
- keep each probe small enough that a bad surprise is cheap
- `mike.near` carries the stable v4 sequencer today; use fresh child
  accounts for *new* sequencer work (migrations, schema probes, alpha
  features) rather than redeploying over the production surface

## v5 architectural split — testnet-validated, mainnet-deferred

The local codebase is now v5-shape: the sequencer's `Contract` struct
carries an optional `authorizer_id: Option<AccountId>` and the
smart-account crate is paired with a new `contracts/authorizer/`
crate. In extension mode (`authorizer_id: Some(_)`), target dispatches
+ session-key mint/revoke route through an authorizer on the user's
canonical account, which checks `signer == self` + `predecessor ∈
extensions` then forwards. `signer_id` is preserved at downstream
receivers, so `intents.near` balance still lands on root. See
[`ARCHITECTURE-V5-SPLIT.md`](./ARCHITECTURE-V5-SPLIT.md).

**Design constraint surfaced during first testnet deploy
(2026-04-19):** the authorizer MUST live at the account whose FAK
signs the top-level tx (on mainnet: `mike.near` itself). Putting it
at a subaccount panics at `dispatch` with the auth check disagreeing
— this is the architecture working correctly. So
`scripts/deploy-testnet.sh` now only deploys standalone-mode
contracts; the v5 pair recipe (which deploys authorizer ON the
signer's account) lives in `ARCHITECTURE-V5-SPLIT.md` "Testnet
recipe" section.

Deployment state:

- **mainnet `mike.near`**: still `v4.0.2-ops` (single-contract v4
  sequencer). Not changed by this tranche.
- **mainnet `sequential-intents.mike.near`**: still v3 (post-Phase-A
  `execute_steps` rename, no authorizer concept). Not changed.
- **testnet `x.mike.testnet`**: carries the v5 authorizer contract
  (`authorizer-v5.0.0`) as of 2026-04-19, with
  `smart-account-v5.x.mike.testnet` armed in its extensions list.
  First live v5 hop: tx
  `6xiTMCvkaTQTsii5ZQLAvJiotyZ1bAwxGGHZumqApe2C`. Disarm / re-arm
  cycle validated. See ARCHITECTURE-V5-SPLIT.md "Testnet recipe"
  table.
- **testnet `smart-account-v5.x.mike.testnet`**: v5 extension
  sequencer paired with `x.mike.testnet`. Separate account from
  `smart-account.x.mike.testnet` (which has broken state from an
  earlier schema bump and can't be cleanly deleted —
  `DeleteAccountWithLargeState` guard).
- **local source `contract_version` string**: `v5.0.0-split` — reports
  this when built and queried. Does NOT match live mainnet versions
  until a deliberate mainnet-migration tranche happens.

Standalone mode (`authorizer_id: None`) preserves exact v3/v4
semantics — including for `sequential-intents.mike.near` if the v5
binary is ever `migrate()`-ed over that state (migrate promotes v4
shape to v5 shape with `authorizer_id: None`, leaving behavior
unchanged).

Mainnet gas matrix (multi-action `register_step` calibration on
`sa-lab.mike.near`):

- single-step yielded registrations stay pending cleanly at `180`,
  `250`, and `500 TGas` per outer action
- two-step yielded batches at `180` and `250 TGas` per action yield
  successfully but their yielded callbacks wake immediately with
  `PromiseError::Failed` instead of staying pending
- two-step yielded batches at `300` and `400 TGas` per action stay
  pending and drain cleanly on `run_sequence`

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
./scripts/check.sh                        # offline fast check (CI-green gate)
cargo test --workspace
./scripts/build-all.sh
MASTER=x.mike.testnet ./scripts/deploy-testnet.sh
python3 -m http.server 8000 -d web

./scripts/verify-mainnet-claims.sh        # live-RPC falsifiability check
                                          # (exits 0 iff reference artifact matches mainnet)
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

- **External user-facing (current):** `execute_steps` / `register_step` / `run_sequence` / `Step` / `StepInput` / `StepView` / `StepPolicy`. This is the API surface and the flagship scripts' vocabulary. (`execute_steps` is the one-tx facade; `register_step` + `run_sequence` is the two-tx manual path — see `contracts/smart-account/src/lib.rs:417,463,496`.)
- **Internal lifecycle (NEP-519 mechanics, unchanged):** yield · resume · resolve · decay. The prose spine for what happens *inside* the contract.
- **Callback names:** `on_step_resumed`, `on_step_resolved` (renamed from `on_promise_*` during Phase A).
- **Resolution policies (user-facing names, unchanged):** `Direct`, `Adapter`, `Asserted`.
- **Pre-dispatch gate (ch. 23):** `PreGate { gate_id, gate_method, gate_args, min_bytes, max_bytes, comparison, gate_gas_tgas }`. Comparison kinds: `U128Json` / `I128Json` / `LexBytes`.
- **Value threading (ch. 24):** `SaveResult { as_name, kind }`, `ArgsTemplate { template, substitutions }`, `Substitution { reference, op }`, `SubstitutionOp` (`Raw` / `DivU128 { denominator }` / `PercentU128 { bps }`); errors: `MaterializeError::{MissingSavedResult, UnparseableSavedResult, NumericOverflow, InvalidBps, PlaceholderNotFound}`; pure function `materialize_args(template, substitutions, saved_results)`. Terminology locked 2026-04-19: `sequence` (not "plan"), `saved_results` (not "captures"), `SaveResult` (not `CaptureSpec`), `save_result` field (not `capture_return`), `Substitution.reference` (not `.token`).
- **Session keys (ch. 25):** `SessionGrant { session_public_key, granted_at_ms, expires_at_ms, allowed_trigger_ids, max_fire_count, fire_count, label }`, `SessionGrantView` adds computed `active: bool`.
- **NEP-297 events:** `step_registered`, `step_resumed`, `step_resolved_ok`, `step_resolved_err`, `sequence_started`, `sequence_completed`, `sequence_halted`, `assertion_checked`, `run_finished` (automation only), `automation_runs_pruned` (public hygiene), `pre_gate_checked` (ch. 23), `result_saved` (ch. 24), `session_enrolled` / `session_fired` / `session_revoked` (ch. 25). Sequence-halted `reason` tags: `downstream_failed`, `resume_failed`, `pre_gate_failed`, `args_materialize_failed`.
- **Phantom Phase-A rename: `run_sequence` → ~~`run_steps`~~.**
  Pre-2026-04-19 docs sometimes named the manual runner
  `run_steps` as if Phase A renamed `run_sequence` → `run_steps`.
  That rename was never executed in code; the function is still
  `pub fn run_sequence` (lib.rs:496). Historical docs reading
  `run_steps` should be read as `run_sequence` — reconciled
  repo-wide 2026-04-19.
- **Older spellings** — `yield_promise` / `resolution_policy`
  (pre-Phase-A); `stage_call` / `settle_policy` (earlier still);
  `latch` / `conduct` / `gated_call` / `label` (historical). These
  survive in two legitimate contexts: (a) archived chapter files
  (`md-CLAUDE-chapters/archive-*.md` + `02-latch-conduct-*`), and
  (b) period-accurate historical narratives and run artifacts
  under `collab/`. Active surfaces (user-facing docs, current
  chapters, code doc-comments) should use current terminology.
