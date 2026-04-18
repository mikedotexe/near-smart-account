# CLAUDE.md — smart-account-contract

Context pack for Claude sessions working in this repo. Read first; details
live in `README.md` and `md-CLAUDE-chapters/`. Update as the architecture
evolves — technical continuity across sessions is the whole point of this file.

## What this repo is

A NEAR **smart-account POC** that frames the account as an active
**runtime**, not just a pluggable signer. The target account is
`mike.testnet` during development and `mike.near` eventually. It accepts
*intents* — structured descriptions of what the user wants done — as
on-chain data, and uses **NEP-519 yield/resume** to stage the resulting
cross-contract receipts into a deterministic sequence.

We use "**execution-abstraction**" for what this repo builds, as a
complement to the signing-abstraction framing that ERC-4337 inspired. The
distinction matters for how we think about delegation: the owner grants
`run_sequence` / `execute_trigger` *execution rights* to another account
without granting any *signing rights* over the account itself.
`authorized_executor` is an execution delegate, not a signer. Full custody
stays with `owner_id`; the runner gets just enough power to drive the
orchestration forward. You can rotate the runner without touching the
custody keys.

Terminology rule:

- in code, keep `settle_policy`
- in prose, prefer "completion policy" / "completion surface"
- in current docs, prefer `step`
- in historical docs, keep older terms like `latch`, `conduct`, `gated_call`,
  and `label`, but mark them as historical when the distinction matters

We're early and exploratory. Nothing here is load-bearing; every design is
a candidate to revisit. When we find a better shape, we take it — keep
discarded approaches in git history rather than comment graveyards.

## The one-paragraph vision

NEAR is atomic at the **receipt** level, not the transaction level: one tx
→ one receipt, and batched Actions to the same receiver act as a unit.
Cross-contract calls spawn *sibling* receipts that run independently — their
order relative to user intent is not guaranteed. We want determinism. When a
user sends a multi-action tx to the smart account, we want the account to
emit `B` only after `A`'s chosen completion surface resolves, then emit `C`
only after `B`'s chosen completion surface resolves. Yield/resume is the
primitive: each call becomes a yielded promise that waits for an explicit
resume signal before proceeding. The smart account orchestrates those
resumes in whatever order is declared.

## Repo at a glance

| Path | Role |
|---|---|
| `contracts/smart-account/` | Target account contract. Focused now on the sequencing/automation product surface: manual `stage_call` / `run_sequence`, per-call completion policy (`settle_policy` in code), and the balance-trigger automation surface (`save_sequence_template` / `create_balance_trigger` / `execute_trigger`). |
| `contracts/compat-adapter/` | Real external-protocol adapter layer. Today it is wrap-specific: `near_deposit -> ft_transfer` on `wrap.testnet` is collapsed into one honest top-level result. |
| `contracts/demo-adapter/` | Demo-only adapter layer for the repo's dishonest-async `wild-router` protocol. Useful for local and testnet compatibility experiments without mixing that shim into the real adapter surface. |
| `contracts/echo/` | Boring leaf callee (`echo`, `echo_log`). Stable target for trace-viewer demos. |
| `contracts/router/` | Exercises flat promise shapes — `route_echo`, `route_echo_then`, `route_echo_and`. No yields; the yield case lives in `yield-sequencer`. |
| `contracts/wild-router/` | Demo dishonest-async protocol. Starts real downstream work but does not return the resulting promise chain to its caller. |
| `types/` | `smart-account-types` — publishable, wasm-free. Other contracts / off-chain tooling depend on this, not the contract wasm. |
| `web/` | Static HTML + IIFE/ESM receipt-DAG viewer (no bundler). Walks `EXPERIMENTAL_tx_status` over FastNEAR RPC. |
| `md-CLAUDE-chapters/` | Long-form design + reference chapters. Start with `01-near-cross-contract-tracing.md`, then read forward through the live experiments and automation chapters. |
| `scripts/` | `check.sh`, `test.sh` alias, `build-all.sh`, `deploy-testnet.sh`, `send-staged-echo-demo.mjs`, `send-staged-mixed-demo.mjs`, `send-balance-trigger-router-demo.mjs` (repo-local direct / adapter / mixed modes), `send-balance-trigger-wrap-demo.mjs` (real `wrap.testnet` path), plus the internal FastNEAR observability toolkit: `trace-tx.mjs` (receipt DAG), `investigate-tx.mjs` (three-surfaces report), `state.mjs` (contract state, typed or raw, block-pinnable), `account-history.mjs` (activity feed), `receipt-to-tx.mjs` (pivot), `block-window.mjs` (block/receipt metadata), `watch-tip.mjs` (chain tip). |

## Design space still open

### When does the user dictate ordering?

For a multi-action tx where every called method auto-yields, three shapes
we're weighing — pick one once the trace-viewer gives us enough signal:

- **Pre-declare**: a prior tx writes "I'm about to send N actions, their
  intended order is `[step_a, step_c, step_b]`". Each action then checks
  the pre-declared intent. Strict, two-tx UX.
- **Post-declare** (what the `latch / conduct` POC implements): multi-action
  tx lands, each `latch(step_id)` yields. A follow-up `conduct(caller, order)`
  specifies the resume order. Relaxed; contract can't validate shape up
  front but there's no pre-commitment dance.
- **Inline preamble**: `begin_sequence(...)` is Action[0] in the same
  multi-action tx as the N target calls. Actions[1..N] find the declared
  intent in state and yield. Atomic setup + ops, single user signature.
  Requires the kick-off to still come externally (Action[0] can't see the
  YieldIds of Actions[1..N] — they don't exist yet at Action[0]'s execution).

`latch / conduct` is the concrete experiment running right now. It's not
the final answer; it's the fastest way to exercise the trace flow on
testnet and see what feels right.

### Auto-yield by default

For any new method we expose on the smart account, the default disposition
should be **"yield first, execute on resume"** — gives the sequencer a hook.
The pattern in Rust (see `smart-account::stage_call` for the current
contract-native form). A no-yield runner is feasible in principle, but we keep
yield canonical because the original staging tx's yielded descendants are part
of the proof surface, not incidental trace noise (see chapter 18):

```rust
pub fn stage_X(&mut self, args..., step_id: String) -> Promise {
    // register (caller, step_id) → yield_id in state
    let (yield_promise, yield_id) = Promise::new_yield(
        "on_stage_X_resume",
        /* args for callback */,
        Gas::from_tgas(10),
        GasWeight::default(),
    );
    /* remember yield_id */;
    yield_promise   // returned → action outcome is SuccessReceiptId(callback_receipt)
}

#[private]
pub fn on_stage_X_resume(
    &mut self,
    /* args */,
    #[callback_result] _sig: Result<(), PromiseError>,
) -> Promise {
    /* actually do the work */
}
```

### Plan-based vs latch-based

`yield-sequencer` currently hosts both:

- **Plan-based** (`create_plan / arm / resume`): user builds an explicit
  `Vec<StepInput>` of action steps (FunctionCall / Transfer / Add*Key /
  DeleteKey), then owner walks plan_id through arm-and-resume. Good when
  the user knows the full sequence up front and wants structured state.
- **Latch-based** (`latch / conduct`): individual actions (one per tx
  Action) register themselves, and a later `conduct` dictates order. Good
  for "take what came in, order it now".

They may converge (e.g., `create_plan` starts a latch sequence with
conduct already set). Don't feel married to keeping both.

## Technical contract

What's fixed (change only with explicit discussion):

- `near-sdk = "5.26.1"` across all on-chain crates
- Contracts compile only for `wasm32-unknown-unknown`; `cfg(test)` bypasses
  the host-target guard for unit tests
- `types/` uses `near-sdk = { default-features = false, features = ["non-contract-usage"] }`
  so host-side consumers (off-chain tooling, downstream crates) compile
- Types live in `types/`; nothing else exports public types meant for
  external consumption
- Frontend is static HTML + IIFE + ESM — **no bundler**, scripts from
  `unpkg.com`. Pattern comes from `/Users/mikepurvis/near/hack-fastdata/reference-static-template/`
- Workspace is pure (no root `[package]`). Scripts live in `scripts/*.sh`,
  not `cargo-run-script`

What's pliable:
- Storage layouts — nothing deployed carries state we care about yet
- Contract-method signatures — prototype freely
- Frontend UX — it's a debug tool, not a product

## Wild-contract compatibility (current shape)

Primary operator doc:
`PROTOCOL-ONBOARDING.md`

Deeper rationale:
chapter 14 and chapter 19

The smart-account kernel now treats compatibility as a **per-call** concern.
Each staged call carries a completion policy (`settle_policy` in code):

- `Direct`: trust the target receipt's own success/failure surface
- `Adapter { adapter_id, adapter_method }`: dispatch through a protocol-specific adapter that returns one honest top-level result
- `Asserted`: reserved for a future post-call assertion mode; intentionally rejected in v1

Short rule:

- empty / void success is fine in `Direct`
- a truthful returned promise chain is also fine in `Direct`
- hidden nested async requires `Adapter`
- future state/postcondition cases point toward `Asserted`
- the current implementation also treats an oversized callback result as failure, because `env::promise_result_checked(0, MAX_CALLBACK_RESULT_BYTES)` is part of the completion predicate

The repo-native demo pair is:

- `wild-router.route_echo_fire_and_forget(...)`: dishonest async shape
- `demo-adapter.adapt_fire_and_forget_route_echo(...)`: adapter that polls target state until the intended effect is truly visible
- `compat-adapter.adapt_wrap_near_deposit_then_transfer(...)`: real protocol-specific adapter path for `wrap.testnet`, returning success only after `near_deposit -> ft_transfer` has completed back to the smart account

## Pitfalls caught the hard way

- **`abi` feature breaks wasm builds.** near-sdk's `abi` feature pulls in
  `schemars`, which is gated behind `cfg(not(target_arch = "wasm32"))`.
  Leave it off on every contract Cargo.toml.
- **Current testnet-compatible Wasm needs the scripted build path.** On this
  machine, plain recent-stable `cargo build --target wasm32-unknown-unknown
  --release` produced Wasm that deployed but failed at runtime with
  `CompilationError(PrepareError(Deserialization))`. The working recipe is the
  one in `scripts/build-all.sh`: `cargo +nightly -Z build-std=std,panic_abort`
  with `RUSTFLAGS='-C link-arg=-s -C target-cpu=mvp'`. Keep the weirdness
  hidden behind the script; the repo should still feel easy to use.
- **`PromiseError` is `#[non_exhaustive]`.** Match arms must include a
  wildcard `Err(_)`. A new protocol-level variant could land and break
  you otherwise.
- **Actions in a single-receiver tx are ONE receipt, not N.** They execute
  sequentially in one wasm-invocation lifecycle, share state within the
  receipt, and revert together. You can't "reorder" actions in a single
  tx via the contract — what you can reorder is the *child* yielded
  receipts they create.
- **Multi-action receipt outcome status is the LAST action's return.** The
  receipt's `outcome.receipt_ids` still lists every child receipt, so the
  trace viewer sees all of them — but `outcome.status` only reflects the
  tail. Walk `receipt_ids`, don't trust top-level status alone. (Chapter 01 §1.8.)
- **`promise_result_checked` takes two args.** `(result_idx: u64, max_len: usize) -> Result<Vec<u8>, PromiseError>`.
  Old `promise_result` is deprecated.
- **FastNEAR regular RPC has a 3-epoch (~21 h) retention window on both
  mainnet and testnet.** Anything older needs archival failover. The
  frontend walker does this automatically on `UNKNOWN_TRANSACTION`.
- **The legacy public testnet RPC now trips up the old JS `near` CLI.** The
  default `rpc.testnet.near.org` path can rate-limit / deprecate requests badly
  enough that `near create-account` misreports parent-account existence. The
  deploy script now exports `NEAR_TESTNET_RPC=https://test.rpc.fastnear.com`
  when `NEAR_ENV=testnet`.
- **Top-level `SuccessValue` can coexist with failing sibling receipts.**
  Always scan `receipts_outcome[*]` for `Failure`. The walker classifies
  `PARTIAL_FAIL` separately from `FULL_SUCCESS`.
- **Promises can't be returned for yielded-promise side effects.** If
  `Promise::new_yield(...)` is called for a side-effect (not as the
  method's return), call `yield_promise.detach()` or `drop()` won't fire
  `env::promise_return` on it. See `YieldSequencer::arm_next_step`.
- **`broadcast_tx_commit` is the wrong tool for the latch experiment.** A
  true multi-action tx with yielded children can appear to "hang" because the
  RPC waits for completion. Submit the latch tx asynchronously, grab the hash,
  and then trace / conduct it.
- **Yield timeout matters to contract semantics, not just UX.** After roughly
  200 blocks (~4 minutes), a yielded callback auto-resumes with
  `PromiseError::Failed`. The current `on_latch_resume` ignores
  `#[callback_result]`, so timed-out latches still clear themselves and later
  `conduct` panics with `label 'x' not latched for this caller`.

## Live testnet signal (2026-04-17)

We now have a real local-to-testnet workflow for the latch / conduct POC and
the first solid proof that a single multi-action tx can be turned into a
deterministically ordered callback sequence.

- Deploy the shared `*.x.mike.testnet` rig with `MASTER=x.mike.testnet`.
  That yields:
  `smart-account.x.mike.testnet`, `compat-adapter.x.mike.testnet`,
  `demo-adapter.x.mike.testnet`, `router.x.mike.testnet`,
  `wild-router.x.mike.testnet`, `echo.x.mike.testnet`,
  `echo-b.x.mike.testnet`, `yield-sequencer.x.mike.testnet`.
- Treat that expanded set as the canonical shared test rig across sessions.
  The `near state` snapshot below predates the adapter split and records the
  original 2026-04-17 five-account baseline:
  `smart-account.x.mike.testnet` → `Ada6AYeSDUHzjDvcvRuPvX6WP25tsDZtckVm5ss61r9q`,
  `router.x.mike.testnet` → `6LygQUn9UVgf3bmuqe4iut6C7EqYTk5ZBThusEyBN15f`,
  `echo.x.mike.testnet` and `echo-b.x.mike.testnet` →
  `AnpgHYSiHtqiGjYz9eCwvaDabgydZGp7pG74oSwdAHze`,
  `yield-sequencer.x.mike.testnet` →
  `5BQuqZsrXYc8b3AbqF8cBL43hAnQbsHS1pws9CdQcxb2`.
- Because `yield-sequencer` initializes `owner_id = $MASTER`, a deploy under
  `x.mike.testnet` must follow with
  `set_authorized_resumer(Some("mike.testnet"))` from `x.mike.testnet` if we
  want `mike.testnet` to call `conduct`.
- A true latch test must originate as ONE signed transaction containing
  multiple `FunctionCall` actions to `yield-sequencer.x.mike.testnet`.
  Repeated `near call` invocations are not equivalent.
- The validated reference run used:
  - latch tx: `4ct5RA1d4x9efJXWGxPBQRLhsPtKxw453wGpP6F8WZ3L`
  - conduct tx: `BW3fmRbzZGFdFrE37uxX2cMzHj6Ur1mG7FCEmjAXKVmT`
- The important proof is in the original latch tx's yielded callback receipts,
  not the conduct tx's own tree:
  - `conduct` tx landed at block `246214775`
  - `conduct` contract receipt executed at `246214776`
  - resumed callback `beta` executed at `246214777`
  - resumed callback `alpha` executed at `246214778`
  - resumed callback `gamma` executed at `246214779`
- That `beta -> alpha -> gamma` ordering is the key result: once the user
  calls their own contract first, yield/resume gives us a real lever for
  deterministic sibling-receipt release. That is the smart-account-shaped
  opening we were looking for.
- Current shared-rig assumptions:
  `yield-sequencer.x.mike.testnet` owner is `x.mike.testnet`,
  and `authorized_resumer` was explicitly set to `mike.testnet`.
- Separately from the deployed latch POC, `contracts/smart-account/` now has a
  local, unit-tested staged-execution path:
  `stage_call(...) -> yield -> on_stage_call_resume -> downstream FunctionCall -> on_stage_call_settled`.
  The important semantic change is that `on_stage_call_settled` resumes the
  next step only after the downstream call has completed.
- That same contract now also has the first automation layer on top of staged
  execution:
  `save_sequence_template(...) -> create_balance_trigger(...) -> execute_trigger(...)`.
  The important framing is "stateful eligibility + authorized execution":
  automation does not mean the contract wakes itself up; it means the owner or
  an authorized executor can spend their own tx gas to start an eligible
  `auto:{trigger_id}:{run_nonce}` staged namespace.
- The first live external-protocol adapter proof is now also in place against
  `wrap.testnet`:
  - redeployed `compat-adapter.x.mike.testnet`:
    `GbeYrNjRNWbcEere7bYKjGtjvgtMSQgQHKwu5fgnytcA`
  - `execute_trigger` at `500 TGas` failed with
    `Exceeded the prepaid gas` on
    `GjrXdmHSmCz24bA2g6u7WFxceFjT1oQmqMcNu7xjWUwM`
    at block `246311000`
  - the successful mixed wrap run used:
    `AoGCbsU7SekiZ5MAwDRFmd8LhHJ6HNQKnyLV5LaC1NS7` →
    `DkEbAYgZttyUssQytGKQKSVXn27bdyQfwpjsN7yUA8vT` →
    `3MKbDCngBqKake71a8SDLtv8HvixnfeDZBt4HSKwaxaf`
    at blocks `246311057`, `246311063`, `246311067`
  - that sequence ran:
    `register` direct `wrap.storage_deposit`,
    `alpha` direct `wrap.near_deposit(0.01)`,
    `beta` via
    `compat-adapter.adapt_wrap_near_deposit_then_transfer(0.02)`
  - the important receipt chain was:
    smart-account → compat-adapter at `246311076`,
    compat-adapter → wrap `near_deposit` at `246311077`,
    adapter callback at `246311078`,
    compat-adapter → wrap `ft_transfer` at `246311079`,
    adapter final callback at `246311080`,
    smart-account settle at `246311081`
  - `smart-account.x.mike.testnet` wNEAR balance moved from
    `30000000000000000000000` to `60000000000000000000000`,
    while `compat-adapter.x.mike.testnet` finished at `0`
- That simplified automation path is now also validated live on testnet:
  - owner-funded run:
    `4xSDcvULr5kNyfLA4x56H6jmJZ6RKhsJcvNQCyB1Cj4S` →
    `HZuMYmPZydUmhnvchDUkQ7dawzFCssDA1gfp4nUUM43b` →
    `A9n6vFH5Z3p95PfSjw1f8CMpcGDhZ7pW974XUteMbYng`
    at blocks `246237303`, `246237309`, `246237313`
  - delegated-executor run:
    `EqedsEmruHr3cnTUFnnTHWdsPWYvS1YoEhmg9JEi19c9` sets
    `authorized_executor = mike.testnet`, then
    `KpBqZqmoxHjNgN4prcgUBSPb9ZjSqvk88j8DaxkJJKj` →
    `5Da7Pg2pgKAG3XM4XCCrmirvjR69H7EjweCM8ivpRJZw` →
    `BujCoxFWMLWuQicTXwEe5Fk9s1iKYT9d52rLGtX7jyWe`
    at blocks `246237422`, `246237436`, `246237442`, `246237446`
  - both runs proved strict `alpha -> beta -> gamma` downstream order over
    real router/echo calls
  - `execute_trigger` at `200 TGas` failed with
    `Exceeded the prepaid gas` on
    `ByLfa9S5TTrzNp4fz9fUpuQrjtA5g3kZypupesGzdJvv` at block `246237246`;
    `500 TGas` succeeded
- That smart-account path has now also been validated live on testnet:
  the live run used the earlier experimental names `gated_call` and
  `conduct`, but the current code now calls that same primitive
  `stage_call` / `run_sequence`
  - batch tx: `51quobuDJbeS2k7mMDRpwmjobeo1iRn1qnQDVQUeiJMk`
  - sequence tx: `uq3mGK6H6JqJuVBZVPpTpFpEkuekEnhKwinJM4yssNT`
  - successful resume / downstream order by block:
    `beta` at `246222024`, `delta` at `246222027`, `alpha` at `246222030`,
    `gamma` at `246222033`
  - the successful gas shape was four staged actions at `250 TGas`
    each, which hits the new PV 83 `1 PGas` total tx envelope exactly
  - higher per-action probes were useful but unstable:
    `Fn5tph4CuQxRCkw7c6qqqQyWXSuAaep8ckEZdPpepkWe` (`60 / 940`) and
    `3K85KEmv8w4gZnMCKbodnVfYJ1fWCRFELo9TbMSEac2w` (`320 / 280`) both failed
    `Exceeded the prepaid gas`, while `6smJpHnQSNuBsKEFeEU8aZ7zyiW6vj6XB7xohyzeytLG`
    (`333 / 200`) landed but its yielded callbacks woke immediately with
    `PromiseError::Failed` instead of remaining pending
  - deploy nuance: the validated run happened before the deploy script began
    using `new_with_owner(...)`; future deploys now set the smart-account
    owner explicitly to `$MASTER`

## How to work

```bash
./scripts/check.sh            # types check host-side, contracts wasm-side
cargo t                       # alias: test --workspace (cfg(test) bypass)
./scripts/build-all.sh        # wasm release → res/*_local.wasm
MASTER=x.mike.testnet ./scripts/deploy-testnet.sh   # shared test rig
python3 -m http.server 8000 -d web    # trace viewer
```

**Deploy** uses the old `near-cli` (`near` in PATH), not `near-cli-rs`.
Default `MASTER=mike.testnet`; override with `MASTER=... PREFIX=...`. For the
shared `*.x.mike.testnet` flow, use `MASTER=x.mike.testnet`. On testnet the
script exports FastNEAR RPC automatically so the old CLI stays usable.
Subaccounts are churned freely — `deploy-testnet.sh` does
`near delete` + `near create-account` on every run.

The internal `scripts/*.mjs` observability helpers auto-load `.env` from the
repo root, so `FASTNEAR_API_KEY` is picked up automatically.

## Working loop (what we do between ideas)

1. Sketch the design in the session (prose + sometimes CLAUDE.md update).
2. Ship a minimal runnable version in code, even if one corner is hand-wavy.
3. Verify: `./scripts/check.sh` + `cargo t` + `./scripts/build-all.sh`.
4. If we're getting close to a pattern landing, deploy to testnet and
   drive the frontend to see the trace.
5. If signal says the shape is wrong, rip out and try again. Don't
   backwards-compat-hack yourself into corners.
6. When a concept firms up, promote it into `md-CLAUDE-chapters/NN-...md`.

## Chapters

- `md-CLAUDE-chapters/01-near-cross-contract-tracing.md` — receipt pipeline
  mechanics, `EXPERIMENTAL_tx_status` walk, FastNEAR specifics. Read once
  per new session; this is the mental model for everything below it.
- `md-CLAUDE-chapters/02-latch-conduct-testnet-validation.md` — the first
  end-to-end proof that multi-action yielded callbacks can be resumed in a
  deliberate order on testnet, plus the timeout caveat and the smart-account
  implication.
- `md-CLAUDE-chapters/03-smart-account-staged-call.md` — the first real
  smart-account-side staged-call scaffold, now updated with the live testnet
  validation, the terminology rename, exact tx hashes, and the current
  gas-shape caveat.
- `md-CLAUDE-chapters/04-three-surfaces-observability.md` — the observability
  mental model: receipt DAG, block-pinned contract state, account activity
  feed. Explains why conduct's tx tree is *not* the ordering proof and how
  `--block <height>` on `scripts/state.mjs` turns any view into a time-series.
- `md-CLAUDE-chapters/05-staged-call-three-surfaces.md` — that same
  observability method applied to the smart-account staged run: state drain,
  per-block receipts, and the "wait for completion" semantic made visible.
- `md-CLAUDE-chapters/06-stage-call-failure-modes.md` — failure semantics of
  staged execution on testnet: downstream halt, timeout drain, and the
  observable difference between them.
- `md-CLAUDE-chapters/07-stage-call-retry-within-yield-window.md` — the live
  retry proof that surviving steps remain pending and can be re-run inside
  the same yield window.
- `md-CLAUDE-chapters/08-stage-call-mixed-outcome-sequence.md` — the mixed
  saga case: success advances, failure halts, and a later run drains the
  survivors.
- `md-CLAUDE-chapters/09-balance-trigger-sequence-automation.md` — the first
  automation layer on top of staged execution: sequence templates, balance
  triggers, authorized execution, and the router-backed demo helper, now with
  live testnet validation.
- `md-CLAUDE-chapters/10-cross-caller-isolation-and-positive-dual-retry.md`
  — cross-caller isolation for staged state, plus the positive proof that one
  caller's retries do not interfere with another caller's orbit.
- `md-CLAUDE-chapters/11-orbital-model-diagrams.md` — six diagrams that
  name the mental model: the contract as a central sphere, each
  `stage_call` ejecting a yielded callback into orbit, `run_sequence`
  as a ground-station pass, decay after ~200 blocks. Lifecycle state
  machine, single-cascade sequence, halt-retry saga timeline,
  cross-caller view, four-fates flowchart, glossary.
- `md-CLAUDE-chapters/12-deterministic-smart-account-automation.md` — the
  paper-shaped articulation of the mechanism: smart account as a
  deterministic receipt-control plane, with balance-gated eligibility,
  authorized execution, and staged downstream release.
- `md-CLAUDE-chapters/13-stage-call-against-real-defi.md` — first probe
  against a real DeFi contract we did not write (`wrap.testnet`): a
  three-action staged batch (`storage_deposit` + two `near_deposit` calls)
  ran end to end, cascade drained cleanly, smart-account ended with exactly
  0.03 wNEAR. Answers the four open questions from the prior discussion
  about gas, byte-count, Promise returns (deferred), and cross-shard latency.
- `md-CLAUDE-chapters/14-wild-contract-compatibility.md` — adapter-first
  hardening for real-world protocols: direct vs adapter completion policy,
  why hidden async is the real risk, and the repo-native `wild-router` /
  `demo-adapter` demonstration.
- `md-CLAUDE-chapters/15-stage-call-wild-contract-semantics.md` — the
  consolidated wild-contract probe: Promise-returning downstream
  (`ft_transfer_call`) makes `on_stage_call_settled` wait for the
  *full* refund chain (cascade goes from 3 to 5 blocks per step),
  AND four different failure shapes against `wrap.testnet` (`MethodNotFound`,
  runtime balance assertion, deserialization panic, precondition refusal) all
  collapse to the same opaque `PromiseError::Failed` at settle. `Direct`
  settle is structurally opaque on both sides — that opacity is the
  explicit cost motivating chapter 14's `Adapter` policy.
- `md-CLAUDE-chapters/16-wrap-testnet-protocol-adapter.md` — the first live
  external-protocol adapter proof: mixed direct + adapter sequencing against
  `wrap.testnet`, exact tx hashes, gas calibration, and the receipt-level
  proof that the smart account waits for `near_deposit -> ft_transfer` to
  finish before advancing.
- `md-CLAUDE-chapters/17-stage-call-multi-contract-intent.md` — first
  three-contract orchestration end-to-end: `register` + `deposit` +
  `swap` across `ref-finance-101.testnet` and `wrap.testnet`, strict
  ordering enforced by one `run_sequence`. Includes a teachable Run A
  where the `deposit` step settles `Ok("0")` after Ref's
  `ft_on_transfer` panicked on `E11: insufficient $NEAR storage
  deposit` and wrap refunded — and the `swap` then halts with
  `E21: token not registered`. Run B (50 mNEAR storage head-room)
  completes; smart-account ends with 3,256,629 base-units of RFT
  (0.033 RFT) credited to its Ref internal ledger, 0.005 wNEAR
  consumed from its wrap wallet.
- `md-CLAUDE-chapters/18-keep-yield-canonical.md` — the design note on why
  the smart-account kernel intentionally keeps yield/resume canonical even
  though a no-yield runner is mechanically possible. Responds to the
  M3 question raised in the collab narrative.
- `md-CLAUDE-chapters/19-protocol-onboarding-and-investigation.md` — the
  deeper companion to `PROTOCOL-ONBOARDING.md`: why the operator guide is
  shaped the way it is, and how `investigate-tx.mjs` packages the repo's
  three-surfaces method into one report.

## Collaboration posture

The `collab/` folder is the rolling handoff for what we're sharing with
the broader team. Keep rigor; don't hold a hypothesis too strongly —
we're probing the solution space, looking for signal, not defending
positions. The point of a novel codebase is to learn what it wants to be.
