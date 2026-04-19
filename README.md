# smart-account-contract

A NEAR smart account that treats the account as an active **runtime**, not
just a pluggable signer. Calls land on the account's own contract, which
uses **yield / resume** (NEP-519) to turn a multi-action transaction into
a deterministically-ordered sequence of cross-contract receipts — gated
step-by-step, saga-halt on failure, re-orchestrable within the yield
window.

We frame this as **execution-abstraction**, complementary to the
signing-abstraction familiar from ERC-4337. The user defines a sub-program
(multi-action tx with steps + an intended order); the account's own
contract executes it; and the owner can delegate *execution rights* (the
ability to call `run_sequence` / `execute_trigger`) to another account
without handing over any *signing rights*. `authorized_executor` is an
execution delegate, not a signer.

Paired with a static-HTML viewer that walks the resulting receipt DAG via
FastNEAR RPC so the pattern is easy to reason about as it develops.

We're early in the dev cycle — probing the solution space for signal,
not shipping. Nothing in this repo is load-bearing yet.

## New here?

- **Fastest way to understand the kernel:**
  [`simple-example/README.md`](./simple-example/README.md) — the bare
  `yield_promise` + `run_sequence` loop with three tiers of proof (30-sec
  `cargo test`, 5-min testnet receipt-DAG, live `near.social` feed).
- **Shortest reading path for the whole repo:**
  [`START-HERE.md`](./START-HERE.md).
- **Chapter status map (current reference vs historical proof archive):**
  [`md-CLAUDE-chapters/README.md`](./md-CLAUDE-chapters/README.md).
- **Candid repo-shape critique:**
  [`HARDENING-REVIEW.md`](./HARDENING-REVIEW.md).

## Layout

| Path | What lives here |
|---|---|
| `contracts/smart-account/` | The main account contract: manual `yield_promise` / `run_sequence`, per-call resolution policy (`resolution_policy` in code), balance-trigger automation (`save_sequence_template` / `create_balance_trigger` / `execute_trigger`). |
| `contracts/compat-adapter/` | Real external-protocol adapter surface. Today wrap-specific: collapses `near_deposit -> ft_transfer` on `wrap.testnet` into one honest top-level result. |
| `contracts/demo-adapter/` | Demo-only adapter for the repo's dishonest-async `wild-router` protocol. Kept separate from the real adapter surface. |
| `contracts/echo/` | Trivial callee — downstream leaf in every trace demo. |
| `contracts/router/` | Flat promise-shape demo contract (single-hop, `.then()`, `promise_and`). |
| `contracts/wild-router/` | Dishonest-async demo: starts real downstream work but doesn't return the resulting promise chain. |
| `contracts/pathological-router/` | Public probe for wild-contract taxonomy: pure lie, gas-burn, decoy-promise, oversized-payload. |
| `types/` | `smart-account-types` — lightweight, publishable crate with shared shapes. |
| `web/` | Static-HTML frontend (no bundler). Walks `EXPERIMENTAL_tx_status` into a receipt DAG and renders it. |
| `simple-example/` | Nested standalone mini-workspace — the bare kernel, isolated from the main product surface. |
| `collab/` | Team-facing handoff notes plus a small curated set of tracked reference artifacts. |
| `md-CLAUDE-chapters/` | Long-form design + reference chapters. See the chapter index for current vs archive classification. |
| `scripts/` | Build/deploy scripts plus the FastNEAR observability toolkit. See [`scripts/README.md`](./scripts/README.md). |
| `res/` | Generated local Wasm outputs from `build-all.sh`. Rebuildable; not tracked. |

## Quickstart

```bash
cp .env.example .env          # paste FASTNEAR_API_KEY; stays out of git
./scripts/check.sh            # host check types + wasm check all contracts
cargo t                       # alias for `cargo test --workspace`
./scripts/build-all.sh        # release wasm → res/*_local.wasm
MASTER=x.mike.testnet ./scripts/deploy-testnet.sh   # shared test rig
python3 -m http.server 8000 -d web   # serve the trace viewer
```

The frontend defaults to testnet. `deploy-testnet.sh` exports FastNEAR
RPC automatically so the legacy JS `near` CLI keeps working. The
internal `scripts/*.mjs` helpers auto-load `.env` from the repo root for
`FASTNEAR_API_KEY` (optional — shared rate-limit applies without it).

**Testnet churn rule:** use fresh direct-child accounts for delete /
recreate workflows. Long-lived shared rigs that accumulate state may
cross NEAR's `DeleteAccountWithLargeState` guard and become non-
deletable; funding with more NEAR does not bypass that guard.

## What the demo traces look like

The `router` contract exposes methods that produce distinct receipt
shapes the viewer renders differently:

| Button | Target · method | Tree shape |
|---|---|---|
| `single-hop`    | `router.route_echo(callee, n)`      | `tx → router → echo` — terminal `SuccessValue(n)` |
| `then-callback` | `router.route_echo_then(callee, n)` | `tx → router → echo → router.on_echo` with populated `input_data_ids` |
| `promise_and`   | `router.route_echo_and([A,B], n)`   | DAG — two parallel echoes converging on one callback (walker dedupes by receipt_id) |

## Smart-account shape at a glance

Three semantic surfaces on `contracts/smart-account/`, in order of depth:

1. **Manual sequencing.** `yield_promise(target, method, args, deposit,
   gas, step_id, resolution_policy?)` stores a yielded downstream receipt and
   returns a yielded promise. `run_sequence(caller_id, order)` releases
   them one at a time, advancing only after each downstream resolves.
2. **Per-call resolution policy** (`resolution_policy` in code):
   - `Direct` — trust the target receipt's own success/failure surface.
   - `Adapter { adapter_id, adapter_method }` — dispatch through a
     protocol-specific adapter that collapses messy async into one
     honest top-level result.
   - `Asserted { assertion_id, assertion_method, assertion_args,
     expected_return, assertion_gas_tgas }` — after the target resolves,
     fire a caller-specified postcheck `FunctionCall` and advance only
     if its return bytes exactly match `expected_return`. See chapter
     21 for semantics and pitfalls.
3. **Balance-trigger automation.** `save_sequence_template` stores a
   durable ordered call template; `create_balance_trigger` gates it on
   the contract's own NEAR balance; `execute_trigger` lets the owner or
   an authorized executor materialize one run and pay the tx gas. The
   contract never wakes itself up — automation here means stateful
   eligibility plus authorized execution, not a scheduler.

See [`PROTOCOL-ONBOARDING.md`](./PROTOCOL-ONBOARDING.md) for the primary
operator guide (how to choose `Direct` vs `Adapter`, how to probe a new
protocol, what to record) and
[`TELEMETRY-DESIGN.md`](./TELEMETRY-DESIGN.md) for the structured-event
telemetry model.

## Validated live milestones

Chronological, with the one most-important tx hash per milestone:

- **2026-04-18 · mainnet `simple-example` kernel on NEAR Social.**
  Fresh `simple-sequencer.sa-lab.mike.near` writes three ordered posts
  to `social.near`. Run tx
  `ChFXaJXHbmcz6vERCS8HcZqsVMR5f57AnodfLxQ6DmFV`, downstream blocks
  `194599850 < 194599853 < 194599856` strictly monotonic with release
  order. See
  [`simple-example/SOCIALDB-VARIANT.md`](./simple-example/SOCIALDB-VARIANT.md).
- **2026-04-18 · balance-trigger automation on testnet.** Owner-funded
  and delegated-executor-funded paths both green at 500 TGas. Owner run
  `A9n6vFH5Z3p95PfSjw1f8CMpcGDhZ7pW974XUteMbYng`; executor run
  `BujCoxFWMLWuQicTXwEe5Fk9s1iKYT9d52rLGtX7jyWe`. See
  [`collab/2026-04-18-balance-trigger-live-validation.md`](./collab/2026-04-18-balance-trigger-live-validation.md).
- **2026-04-17 · smart-account `yield_promise` / `run_sequence` on
  testnet.** Four yielded actions at 250 TGas (exact 1 PGas envelope);
  downstream `echo_log` receipts executed block-by-block in the chosen
  order. Sequence tx `uq3mGK6H6JqJuVBZVPpTpFpEkuekEnhKwinJM4yssNT`. See
  [`archive-staged-call-lineage.md`](./md-CLAUDE-chapters/archive-staged-call-lineage.md).
- **Earlier · latch / conduct testnet POC.** Reference latch tx
  `4ct5RA1d4x9efJXWGxPBQRLhsPtKxw453wGpP6F8WZ3L`, conduct tx
  `BW3fmRbzZGFdFrE37uxX2cMzHj6Ur1mG7FCEmjAXKVmT`, proven resumed order
  `beta → alpha → gamma`. See chapter 02.
- **Mainnet lab calibration on `sa-lab.mike.near`.** Multi-action
  `yield_promise` is viable but has a higher per-action gas floor than
  single-step probes: 300 TGas per action stays pending; 180–250 TGas
  per action immediately resume-fails. Full matrix and operator
  baseline in [`CLAUDE.md`](./CLAUDE.md#mainnet-lab-rig).

The surprising-but-useful nuance across all of these: the ordering proof
lives on the **original yield tx's yielded callback descendants**, not
on the release tx's own tree.

## Tooling

[`scripts/README.md`](./scripts/README.md) catalogs the FastNEAR-backed
observability toolkit (`trace-tx`, `investigate-tx`, `state`,
`receipt-to-tx`, `account-history`, `watch-tip`, `block-window`,
`aggregate-runs`, `probe-pathological`). Scripts default to testnet,
auto-load `.env`, emit human-readable summaries with `--json` available.

Demo wrappers for the smart-account surface live under `scripts/`:

- `send-staged-echo-demo.mjs` / `send-staged-mixed-demo.mjs` — manual
  sequencing experiments
- `send-balance-trigger-router-demo.mjs` — automation against the
  repo-local router, with `--mode direct|adapter|mixed`
- `send-balance-trigger-wrap-demo.mjs` — automation against the real
  `wrap.testnet` path via `compat-adapter`

## Shared testnet rig

The canonical subaccounts used across the current testnet experiments
are churnable and can be recreated by `deploy-testnet.sh`:

`smart-account.x.mike.testnet`, `router.x.mike.testnet`,
`echo.x.mike.testnet`, `echo-b.x.mike.testnet`,
`yield-sequencer.x.mike.testnet`, plus the adapter / wild / pathological
/ probe contracts listed in [`CLAUDE.md`](./CLAUDE.md).

## Terminology

Current prose uses the **yield · resume · resolve · decay** spine —
"resolution policy" / "resolution surface" — plus `step` as the unit
identifier. The Rust code and scripts are aligned with that spine: the
sequencing entrypoints are `yield_promise` / `run_sequence`, and every
call carries a `resolution_policy`. Archived chapters that document
earlier runs keep period-accurate terms (`stage_call`, `settle_policy`,
`latch`, `conduct`, `gated_call`, `label`) inside their original
context — treat those as historical.

## Status

Alpha-ish. Everything builds clean on `near-sdk = 5.26.1`. The trace
viewer renders flat promise shapes from a tx hash. The latch / conduct
POC, the smart-account `yield_promise` / `run_sequence` path, and the
balance-trigger automation are all green on testnet. The
`simple-example` kernel is also green on mainnet against `social.near`.
Mainnet `smart-account` itself is still in gas-calibration on
`sa-lab.mike.near`, not yet production-shaped.

See [`CLAUDE.md`](./CLAUDE.md) for the architectural through-line
(vision, open design questions, session-critical pitfalls) and
[`collab/`](./collab/) for anything being shared with collaborators.
