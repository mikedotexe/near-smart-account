# smart-account-contract

A NEAR smart account that treats the account as an active **runtime**, not
just a pluggable signer. Calls land on the account's own contract
(`mike.near` during development), which uses **yield / resume** (NEP-519)
to turn a multi-action transaction into a deterministically-ordered
sequence of cross-contract receipts — gated step-by-step, saga-halt on
failure, re-orchestrable within the yield window.

We frame this as **execution-abstraction**, complementary to the
signing-abstraction familiar from ERC-4337. The user defines a sub-program
(multi-action tx with steps + an intended order); the account's own
contract executes it; and the owner can delegate *execution rights* (the
ability to call `run_sequence` / `execute_trigger`) to another account
without handing over any *signing rights* over the account itself.
`authorized_executor` is an execution delegate, not a signer.

Paired with a static-HTML viewer that walks the resulting receipt DAG via
FastNEAR RPC so the pattern is easy to reason about as it develops.

We're early in the dev cycle — probing the solution space for signal, not
shipping. Nothing in this repo is load-bearing yet.

## Layout

| Path | What lives here |
|---|---|
| `contracts/smart-account/` | The main account contract. Focused now on the sequencing/automation product surface: manual `stage_call` / `run_sequence`, per-call completion policy (`settle_policy` in code), and the balance-trigger automation surface (`save_sequence_template` / `create_balance_trigger` / `execute_trigger`). |
| `contracts/compat-adapter/` | The real external-protocol adapter surface. Today it is wrap-specific: `near_deposit -> ft_transfer` on `wrap.testnet` is collapsed into one honest top-level result. |
| `contracts/demo-adapter/` | Demo-only adapter for the repo's dishonest-async `wild-router` protocol. Useful for local and testnet compatibility experiments without mixing that shim into the real adapter surface. |
| `contracts/echo/` | Trivial callee — used as the downstream leaf in every trace demo. |
| `contracts/router/` | Exercises flat promise shapes the trace viewer distinguishes: single-hop, `.then()` callback, `promise_and` fan-out. |
| `contracts/wild-router/` | Demo “dishonest async” contract: starts real downstream work but does not return the resulting promise chain to its caller. |
| `types/` | `smart-account-types` — lightweight, publishable crate with shared shapes. Other contracts / off-chain tooling depend on this instead of the contract Wasm. |
| `web/` | Static-HTML frontend (no bundler). Walks `EXPERIMENTAL_tx_status` into a receipt DAG and renders it. |
| `simple-example/` | Nested standalone mini-workspace that isolates the bare `stage_call` / `run_sequence` kernel with a tiny stateful recorder leaf. |
| `md-CLAUDE-chapters/` | Long-form design + reference chapters. Start with `01-near-cross-contract-tracing.md`. |
| `scripts/` | Build/deploy shell scripts, the internal FastNear observability toolkit (`trace-tx`, `investigate-tx`, `receipt-to-tx`, `account-history`, `watch-tip`, `block-window`, `state`), `send-staged-echo-demo.mjs` and `send-staged-mixed-demo.mjs` for manual sequencing experiments, `send-balance-trigger-router-demo.mjs` for repo-local direct / adapter / mixed automation demos, and `send-balance-trigger-wrap-demo.mjs` for the real `wrap.testnet` path. |
| `res/` | Built Wasm artifacts (`*_local.wasm`, `*_release.wasm`). |

## Quickstart

```bash
cp .env.example .env          # paste FASTNEAR_API_KEY; stays out of git
./scripts/check.sh            # host check types + wasm check all contracts
cargo t                       # alias for `cargo test --workspace`
./scripts/build-all.sh        # release wasm → res/*_local.wasm
MASTER=x.mike.testnet ./scripts/deploy-testnet.sh   # shared test rig
python3 -m http.server 8000 -d web   # serve the trace viewer
```

Frontend defaults to **testnet** (`rpc.testnet.fastnear.com`, archival
failover on `UNKNOWN_*`). Router / echo account IDs are editable on the page.
On testnet, `deploy-testnet.sh` now exports FastNEAR RPC automatically so the
legacy JS `near` CLI keeps working.
The internal `scripts/*.mjs` helpers also auto-load `.env`, so they will pick
up `FASTNEAR_API_KEY` without needing a separate `source .env` step.

The FastNEAR API key is optional; without it the viewer works but falls
onto the shared rate-limit. Paste it into the **FastNEAR API key** field
(stored in `localStorage`) or copy `web/config.example.js` →
`web/config.local.js` and set `window.FASTNEAR_API_KEY` there.

## What the demo traces look like

The `router` contract exposes four methods, each producing a receipt shape
the viewer renders differently:

| Button | Target · method | What the tree looks like |
|---|---|---|
| `single-hop`    | `router.route_echo(callee, n)`                | `tx → router → echo` — terminal `SuccessValue(n)` |
| `then-callback` | `router.route_echo_then(callee, n)`           | `tx → router → echo → router.on_echo` with populated `input_data_ids` |
| `promise_and`   | `router.route_echo_and([A,B], n)`             | DAG — two parallel echoes converging on one callback (walker dedupes by receipt_id) |

## Docs

Historical terminology note: chapters that document earlier runs keep the
period-accurate terms that were live at the time, including `latch`,
`conduct`, `gated_call`, and `label`. Current code and current prose prefer
`step`, `run_sequence`, and "completion policy" / "completion surface".

- [`PROTOCOL-ONBOARDING.md`](./PROTOCOL-ONBOARDING.md) — the primary operator guide for onboarding a new protocol safely: how to choose `Direct` vs `Adapter`, how to probe a step, what to record, and how to use `investigate-tx`.
- [`md-CLAUDE-chapters/01-near-cross-contract-tracing.md`](./md-CLAUDE-chapters/01-near-cross-contract-tracing.md) — deep-dive on NEAR receipt mechanics and how to reconstruct cross-contract call traces from `EXPERIMENTAL_tx_status`, with FastNEAR specifics (retention windows, the `/v0/receipt` pivot, neardata streaming vs Lake).
- [`md-CLAUDE-chapters/02-latch-conduct-testnet-validation.md`](./md-CLAUDE-chapters/02-latch-conduct-testnet-validation.md) — the first end-to-end live validation of the historical `latch / conduct` POC on testnet, including the exact tx hashes, ordering proof, timeout caveat, and smart-account implication.
- [`md-CLAUDE-chapters/03-smart-account-staged-call.md`](./md-CLAUDE-chapters/03-smart-account-staged-call.md) — the first real smart-account-side staged-call scaffold: what landed locally, why it resumes only after downstream completion, and how the renamed primitive maps onto the validated testnet run.
- [`md-CLAUDE-chapters/04-three-surfaces-observability.md`](./md-CLAUDE-chapters/04-three-surfaces-observability.md) — the mental model for looking at a cascade end-to-end: receipt DAG, block-pinned contract state, account activity feed. Reconstructs the reference latch/conduct cascade from all three surfaces, block by block.
- [`md-CLAUDE-chapters/05-staged-call-three-surfaces.md`](./md-CLAUDE-chapters/05-staged-call-three-surfaces.md) — the same three-surface method applied to the smart-account staged-call run: state drain, per-block receipts, and the exact way completion gates the next step.
- [`md-CLAUDE-chapters/06-stage-call-failure-modes.md`](./md-CLAUDE-chapters/06-stage-call-failure-modes.md) — the failure semantics of staged execution on testnet: downstream halt, yield timeout, and the observable difference between the two.
- [`md-CLAUDE-chapters/07-stage-call-retry-within-yield-window.md`](./md-CLAUDE-chapters/07-stage-call-retry-within-yield-window.md) — a live retry proof showing that surviving steps remain pending and can be re-run in a fresh order inside the yield window.
- [`md-CLAUDE-chapters/08-stage-call-mixed-outcome-sequence.md`](./md-CLAUDE-chapters/08-stage-call-mixed-outcome-sequence.md) — the mixed-outcome saga case: one `run_sequence` advances through success, halts on failure, and then a later run drains the survivors.
- [`md-CLAUDE-chapters/09-balance-trigger-sequence-automation.md`](./md-CLAUDE-chapters/09-balance-trigger-sequence-automation.md) — the first automation layer on top of staged execution: durable sequence templates, balance triggers, authorized execution, and the router-backed demo flow, now with live testnet validation.
- [`md-CLAUDE-chapters/10-cross-caller-isolation-and-positive-dual-retry.md`](./md-CLAUDE-chapters/10-cross-caller-isolation-and-positive-dual-retry.md) — cross-caller isolation for staged state, plus the positive proof that one caller's retries do not interfere with another caller's orbit.
- [`md-CLAUDE-chapters/11-orbital-model-diagrams.md`](./md-CLAUDE-chapters/11-orbital-model-diagrams.md) — the mental-model chapter: six diagrams of the sphere-and-satellites picture (hub/spoke, lifecycle state machine, single cascade, halt-retry saga timeline, cross-caller, four-fates flowchart) plus a glossary.
- [`md-CLAUDE-chapters/12-deterministic-smart-account-automation.md`](./md-CLAUDE-chapters/12-deterministic-smart-account-automation.md) — a technical-paper treatment of the current mechanism: smart account as receipt-control plane, balance-gated eligibility, authorized execution, and the invariants that make the design interesting.
- [`md-CLAUDE-chapters/13-stage-call-against-real-defi.md`](./md-CLAUDE-chapters/13-stage-call-against-real-defi.md) — first live probe against a real DeFi contract we did not write (`wrap.testnet`): three-action staged batch runs end to end, smart-account ends with exactly 0.03 wNEAR.
- [`md-CLAUDE-chapters/14-wild-contract-compatibility.md`](./md-CLAUDE-chapters/14-wild-contract-compatibility.md) — the adapter-first hardening model for real-world protocols: per-call completion policy, why hidden nested async is the real danger, and the repo-native dishonest async demo pair (`wild-router` + `demo-adapter`).
- [`md-CLAUDE-chapters/15-stage-call-wild-contract-semantics.md`](./md-CLAUDE-chapters/15-stage-call-wild-contract-semantics.md) — the consolidated wild-contract probe: `ft_transfer_call` extends the cascade from 3 to 5 blocks per step; four different failure shapes all collapse to `PromiseError::Failed`. Direct settle is structurally opaque on both sides.
- [`md-CLAUDE-chapters/16-wrap-testnet-protocol-adapter.md`](./md-CLAUDE-chapters/16-wrap-testnet-protocol-adapter.md) — the first live external-protocol adapter proof: a mixed `wrap.testnet` sequence where the smart account advances only after the adapter-backed `near_deposit -> ft_transfer` path has actually completed.
- [`md-CLAUDE-chapters/17-stage-call-multi-contract-intent.md`](./md-CLAUDE-chapters/17-stage-call-multi-contract-intent.md) — first three-contract orchestration: register + deposit + swap across `ref-finance-101.testnet` and `wrap.testnet` in one `run_sequence`, ending with RFT in smart-account's Ref internal ledger.
- [`md-CLAUDE-chapters/18-keep-yield-canonical.md`](./md-CLAUDE-chapters/18-keep-yield-canonical.md) — the design note on why the smart-account kernel intentionally keeps yield/resume canonical even though a no-yield sequence runner is feasible in principle.
- [`md-CLAUDE-chapters/19-protocol-onboarding-and-investigation.md`](./md-CLAUDE-chapters/19-protocol-onboarding-and-investigation.md) — the deeper rationale behind the onboarding guide and the `investigate-tx` wrapper: completion surfaces, evidence discipline, and one canonical real-protocol walk-through.

## Internal observability toolkit

These repo-local scripts are the first pass at an internal FastNear-backed
toolkit for understanding the shape of cross-contract execution and
yield/resume behavior.

```bash
./scripts/trace-tx.mjs 4ct5RA1d4x9efJXWGxPBQRLhsPtKxw453wGpP6F8WZ3L
./scripts/investigate-tx.mjs 3MKbDCngBqKake71a8SDLtv8HvixnfeDZBt4HSKwaxaf x.mike.testnet --wait FINAL
./scripts/receipt-to-tx.mjs 6XN7grXUE2KuCGrKyjBCAgSJHvS5DKCjqkxjAh7kskUE
./scripts/account-history.mjs yield-sequencer.x.mike.testnet --limit 20 --function-call
./scripts/watch-tip.mjs --once
./scripts/block-window.mjs --from 246214775 --to 246214780
./scripts/block-window.mjs --block 246214777 --with-receipts --with-transactions
./scripts/state.mjs yield-sequencer.x.mike.testnet --method pending_latches_for --args '{"caller_id":"mike.testnet"}'
./scripts/state.mjs yield-sequencer.x.mike.testnet --block 246214777 --method pending_latches_for --args '{"caller_id":"mike.testnet"}'
```

What each script wraps:

- `trace-tx.mjs` — canonical RPC `EXPERIMENTAL_tx_status`, with sender auto-resolution via the Transactions API when omitted
- `investigate-tx.mjs` — one-command three-surfaces report: traced receipt DAG, block-pinned views, per-block receipt order, activity rows, and JSON/markdown artifacts
- `receipt-to-tx.mjs` — Transactions API `POST /v0/receipt`
- `account-history.mjs` — Transactions API `POST /v0/account`
- `watch-tip.mjs` — NEAR Data `GET /v0/last_block/final` or optimistic tip polling
- `block-window.mjs` — Transactions API `POST /v0/blocks` and `POST /v0/block`
- `state.mjs` — RPC `query view_state` (raw) or `call_function` (typed view); pass `--block <h>` to pin any recent block and turn a view into a state time-series (chapter 04)

Current defaults:

- network defaults to `testnet`
- scripts auto-load `.env` from the repo root
- scripts emit human-readable summaries by default and support `--json`

## Smart-account staged execution path

The `smart-account` contract now carries the first real account-shaped
sequencing surface:

- `stage_call(target_id, method_name, args, attached_deposit_yocto, gas_tgas, step_id, settle_policy?)` stores a staged downstream `FunctionCall` and returns a yielded promise
- `run_sequence(caller_id, order)` starts the ordered release by resuming the first step
- `on_stage_call_resume` dispatches the actual downstream call
- `on_stage_call_settled` resumes the next step only after that downstream call has completed

That last point is the important semantic upgrade over inert `latch(step_id)`.
The sequence is now "resume A, run A's real downstream receipt, wait for A to
finish, then start B" rather than "wake all the callbacks in a chosen order
and stop there".

The staging transaction is intentionally the **yielded receipt creation** step,
while `run_sequence` or `execute_trigger` is the **release** step. That is why
the original batch transaction's yielded descendants are part of the proof
story, not incidental trace noise.

For the canonical smart-account batch that targets `echo_log`, use:

```bash
./scripts/send-staged-echo-demo.mjs --dry
./scripts/send-staged-echo-demo.mjs \
  alpha:1 beta:2 gamma:3 delta:4 \
  --action-gas 250 \
  --call-gas 30 \
  --sequence-order beta,delta,alpha,gamma
```

That helper reuses the locally installed JS `near` CLI's bundled
`near-api-js`, loads `~/.near-credentials/<network>/<signer>.json`, and sends
one multi-action tx to `smart-account.x.mike.testnet`.

The most useful live gas result so far is that the new PV 83 `1 PGas` limit is
real for the *total* multi-action tx envelope, but the stable yielded-callback
shape is still below that on a per-action basis. The successful smart-account
run used `4 x 250 TGas = 1000 TGas` exactly. By contrast:

- `3 x 60 TGas` outer actions with `--call-gas 940` failed immediately with
  `Exceeded the prepaid gas`
- `4 x 333 TGas` outer actions with `--call-gas 200` landed, but each yielded
  callback woke immediately with `PromiseError::Failed` instead of remaining
  pending

So the current practical recipe is "use the new `1 PGas` budget across several
yielded actions" rather than "push a single yielded action up to `940 TGas`".

## Wild-contract compatibility

The primary operator workflow now lives in
[`PROTOCOL-ONBOARDING.md`](./PROTOCOL-ONBOARDING.md). The deeper rationale
behind that guide lives in chapter 14 and chapter 19.

At the kernel level, each downstream step still carries a **per-call
completion policy** (`settle_policy` in code):

- `Direct` means "trust the target receipt's own success/failure surface"
- `Adapter { adapter_id, adapter_method }` means "dispatch through a protocol-specific adapter that returns one honest top-level result"
- `Asserted` is reserved for a future post-call assertion mode and is not implemented yet

Short rule:

- empty / void success is fine in `Direct`
- a truthful returned promise chain is also fine in `Direct`
- hidden nested async requires `Adapter`
- future state/postcondition cases point toward `Asserted`

The repo-native demo pair is:

- `wild-router.route_echo_fire_and_forget(...)` — starts a real downstream echo call but returns before that echo has settled
- `demo-adapter.adapt_fire_and_forget_route_echo(...)` — starts the same messy protocol call, then polls `wild-router.get_last_finished()` until the intended effect is actually visible, and only then returns success to the smart account
- `compat-adapter.adapt_wrap_near_deposit_then_transfer(...)` — the real protocol-specific external path that wraps `wrap.testnet.near_deposit()` and only returns success after the resulting `ft_transfer` back to the smart account has settled

That keeps the sequencing kernel narrow and stable: it still advances on
receipt truth, but now the truth can come either directly from the target or
from a protocol-specific compatibility layer.

## Balance-trigger automation path

The `smart-account` contract now also carries the first automation primitive
on top of that staged engine:

- `save_sequence_template(sequence_id, calls)` stores a durable ordered call template
- `create_balance_trigger(trigger_id, sequence_id, min_balance_yocto, max_runs)` stores a balance gate over that template
- `execute_trigger(trigger_id)` lets the owner or authorized executor spend their own transaction gas to materialize a fresh `auto:{trigger_id}:{run_nonce}` staged namespace and start the sequence

The important framing is that "automation" here means **stateful eligibility +
authorized execution**. The contract never wakes itself up. Instead, the owner
or a delegated executor calls `execute_trigger`, pays the transaction gas, and
the contract checks whether its own NEAR balance makes the trigger eligible
before sequencing the real downstream work.

For the canonical router-backed demo, use:

```bash
./scripts/send-balance-trigger-router-demo.mjs --dry
./scripts/send-balance-trigger-router-demo.mjs \
  alpha:1 beta:2 gamma:3 \
  --owner-signer x.mike.testnet \
  --min-balance-yocto 1000000000000000000000000
```

For compatibility demos, the same helper now supports:

```bash
./scripts/send-balance-trigger-router-demo.mjs --dry --mode direct
./scripts/send-balance-trigger-router-demo.mjs --dry --mode adapter
./scripts/send-balance-trigger-router-demo.mjs --dry --mode mixed
```

Mode semantics:

- `direct` — every call is `router.route_echo`, so `Direct` completion policy is enough
- `adapter` — every call targets `wild-router.route_echo_fire_and_forget`, wrapped by `demo-adapter`
- `mixed` — alternates direct router steps with adapter-wrapped wild-router steps in one saved sequence

For the first real external-protocol path, use:

```bash
./scripts/send-balance-trigger-wrap-demo.mjs --dry --mode mixed alpha:0.01 beta:0.02
./scripts/send-balance-trigger-wrap-demo.mjs --mode mixed --execute-gas 800 alpha:0.01 beta:0.02
```

That helper:

- uses `wrap.testnet` instead of the local router/echo pair
- keeps `register` and one deposit as direct `wrap` calls
- uses `compat-adapter.adapt_wrap_near_deposit_then_transfer(...)` for the
  adapter-backed step_id
- records pre/post wNEAR balances so the external protocol effect is easy to
  verify later
- saves a router-based sequence template owned by `x.mike.testnet`
- creates a balance trigger that reuses that template
- executes the trigger from the owner account by default, or from
  `--executor-signer` if you want a delegated executor flow
- writes a JSON artifact file under `collab/artifacts/` with the tx hashes,
  block heights, decoded return values, and ready-made trace commands

## Validated automation testnet flow

As of 2026-04-18, the simplified no-reward automation path has now been
validated live on testnet in both owner-funded and delegated-executor-funded
forms.

Owner-funded reference run:

- `save_sequence_template`:
  `4xSDcvULr5kNyfLA4x56H6jmJZ6RKhsJcvNQCyB1Cj4S` at `246237303`
- `create_balance_trigger`:
  `HZuMYmPZydUmhnvchDUkQ7dawzFCssDA1gfp4nUUM43b` at `246237309`
- `execute_trigger`:
  `A9n6vFH5Z3p95PfSjw1f8CMpcGDhZ7pW974XUteMbYng` at `246237313`
- sequence namespace:
  `auto:balance-trigger-mo3ofylb:1`
- proven downstream order:
  `alpha -> beta -> gamma`
- proven downstream values:
  `1 -> 2 -> 3`

Delegated-executor reference run:

- authorization tx:
  `EqedsEmruHr3cnTUFnnTHWdsPWYvS1YoEhmg9JEi19c9` at `246237422`
- `save_sequence_template`:
  `KpBqZqmoxHjNgN4prcgUBSPb9ZjSqvk88j8DaxkJJKj` at `246237436`
- `create_balance_trigger`:
  `5Da7Pg2pgKAG3XM4XCCrmirvjR69H7EjweCM8ivpRJZw` at `246237442`
- `execute_trigger`:
  `BujCoxFWMLWuQicTXwEe5Fk9s1iKYT9d52rLGtX7jyWe` at `246237446`
- sequence namespace:
  `auto:balance-trigger-mo3ohnar:1`
- proven downstream order:
  `alpha -> beta -> gamma`
- proven downstream values:
  `11 -> 22 -> 33`

Gas calibration note:

- `execute_trigger` at `200 TGas` failed with
  `Exceeded the prepaid gas` on
  `ByLfa9S5TTrzNp4fz9fUpuQrjtA5g3kZypupesGzdJvv` at `246237246`
- `execute_trigger` at `500 TGas` succeeded for both live runs above

Full run note:

- [`collab/2026-04-18-balance-trigger-live-validation.md`](./collab/2026-04-18-balance-trigger-live-validation.md)

## Validated testnet flow

The repo has a working local workflow for the latch / conduct experiment.
The current shared deploy shape is:

- Shared deploy target: `smart-account.x.mike.testnet`,
  `compat-adapter.x.mike.testnet`, `demo-adapter.x.mike.testnet`,
  `router.x.mike.testnet`,
  `wild-router.x.mike.testnet`, `echo.x.mike.testnet`,
  `echo-b.x.mike.testnet`, `yield-sequencer.x.mike.testnet`
- Reference latch tx:
  `4ct5RA1d4x9efJXWGxPBQRLhsPtKxw453wGpP6F8WZ3L`
- Reference conduct tx:
  `BW3fmRbzZGFdFrE37uxX2cMzHj6Ur1mG7FCEmjAXKVmT`
- Proven resumed callback order on the original latch tx:
  `beta -> alpha -> gamma`

The surprising but useful nuance is that the ordering proof is visible on the
original latch transaction's yielded callback receipts, not on the conduct
transaction's own tree. See chapter 02 for the exact block-by-block evidence.

## Validated smart-account testnet flow

As of 2026-04-17, the first real smart-account-side staged-execution flow has
also been driven end to end on testnet.

The live run used the earlier experimental method names `gated_call` and
`conduct`. The current codebase now exposes that same primitive as
`stage_call` and `run_sequence`.

- Shared accounts: `smart-account.x.mike.testnet` and `echo.x.mike.testnet`
- Reference batch tx:
  `51quobuDJbeS2k7mMDRpwmjobeo1iRn1qnQDVQUeiJMk`
- Reference sequence tx:
  `uq3mGK6H6JqJuVBZVPpTpFpEkuekEnhKwinJM4yssNT`
- Batch tx landed at block `246221934`
- Conduct tx landed at block `246222021`; its contract receipt executed at
  `246222022`
- Exact downstream `echo_log` order, proven by the echoed receipt blocks:
  - `beta` at `246222024`
  - `delta` at `246222027`
  - `alpha` at `246222030`
  - `gamma` at `246222033`

That run used four staged actions at `250 TGas` each, which is an exact
`1 PGas` total tx envelope. The important proof still lives on the original
batch tx's yielded callback descendants, not on the sequence tx's own tree.
See [`collab/2026-04-17-smart-account-gated-call-run.md`](./collab/2026-04-17-smart-account-gated-call-run.md)
and chapter 03 for the block-by-block details.

## Shared testnet rig

These are the canonical shared subaccounts we are currently using for the
ongoing testnet experiments. They are churnable and can be recreated by
`deploy-testnet.sh`, but these names are the continuity anchor across sessions.

Last verified on 2026-04-17 via `near state` against FastNear testnet RPC:

- `smart-account.x.mike.testnet` — smart-account sequencing / automation entrypoint
  (`code_hash = Ada6AYeSDUHzjDvcvRuPvX6WP25tsDZtckVm5ss61r9q`)
- `router.x.mike.testnet` — flat promise-shape demo contract
  (`code_hash = 6LygQUn9UVgf3bmuqe4iut6C7EqYTk5ZBThusEyBN15f`)
- `echo.x.mike.testnet` — leaf callee A
  (`code_hash = AnpgHYSiHtqiGjYz9eCwvaDabgydZGp7pG74oSwdAHze`)
- `echo-b.x.mike.testnet` — leaf callee B
  (`code_hash = AnpgHYSiHtqiGjYz9eCwvaDabgydZGp7pG74oSwdAHze`)
- `yield-sequencer.x.mike.testnet` — latch / conduct and plan-based sequencer
  (`code_hash = 5BQuqZsrXYc8b3AbqF8cBL43hAnQbsHS1pws9CdQcxb2`)

Current shared-rig assumptions from the validated run:

- deploy parent is `x.mike.testnet`
- `yield-sequencer.x.mike.testnet` owner is `x.mike.testnet`
- `yield-sequencer.x.mike.testnet` authorized resumer was set to `mike.testnet`
- the 2026-04-17 smart-account run used the earlier deploy path where
  `new()` made `smart-account.x.mike.testnet` its own owner
- future deploys now initialize `smart-account` with
  `new_with_owner(owner_id = $MASTER)`, so owner-only admin calls line up with
  the deploy parent

## Status

Alpha-ish: everything builds clean on `near-sdk = 5.26.1`, the trace viewer
renders the flat promise shapes from a tx hash, and the yield-sequencer plan
lifecycle covers FunctionCall / Transfer / AddFullAccessKey /
AddFunctionCallAccessKey / DeleteKey. The latch / conduct POC has been driven
end to end on testnet, including a real multi-action transaction whose yielded
callbacks resumed in a deliberately shuffled order. The smart-account
`stage_call` / `run_sequence` path has now also been driven end to end on
testnet:
one multi-action `1 PGas` batch created four pending yielded calls, a later
sequence tx chose a nontrivial order, and the downstream `echo_log` receipts
executed in exactly that block-by-block sequence.

See `CLAUDE.md` for the architectural through-line (vision, open design
questions, pitfalls) and `collab/` for anything we're sharing with
collaborators.
