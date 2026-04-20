# `simple-example`

A standalone NEP-519 sequencing demo that strips the idea down to the
smallest system that still matters. One contract yields downstream promises
to park them, a second transaction releases them in a chosen order, and the proof
lives on the resulting receipt DAG and in durable downstream state.

This is intentionally **not** a smart-account product surface. It omits the
layers that make `contracts/smart-account/` interesting as an account
runtime:

- no owner / delegated executor model
- no durable templates or balance triggers
- no resolution-policy abstraction or adapters
- no external `types/` crate

## Sequencer claim

> One multi-action transaction can manufacture multiple yielded callbacks,
> and a later `run_sequence` can release real downstream cross-contract
> work in a deliberately different order than the original action order.

"Release order" here means the order in which the sequencer creates the
next real `FunctionCall` receipt. It does **not** mean global receipt
ordering, and it does **not** mean exclusive chain execution. Unrelated
receipts can still interleave elsewhere on-chain while this sequence is
in flight.

## Three tiers of proof, cheapest to most vivid

### 1. 30-second local check (no testnet required)

The unit tests encode the full sequencing state machine — yield registers
distinct yielded callbacks, `run_sequence` resumes only the first step and
queues the rest, each downstream success advances to the next step, each
downstream failure halts the saga, and caller identity is enforced.

```bash
cargo test --manifest-path ./simple-example/Cargo.toml --workspace
```

Expected: 10 tests pass. The two most load-bearing tests for the claim
are `successful_settlement_resumes_next_step_and_drains_queue` and
`downstream_failure_halts_without_resuming_next_step`. These run in the
near-sdk simulator, so they prove the state machine is correct but do
not simulate NEP-519 block-level wakeup — that's what the next tiers
are for.

### 2. 5-minute testnet round-trip (receipt DAG + on-chain state)

Deploy a fresh sequencer + recorder pair, yield three promises, release
them in a chosen order, verify the recorder's durable state matches the
release order:

```bash
MASTER=x.mike.testnet ./simple-example/scripts/deploy-testnet.sh

./simple-example/scripts/send-demo.mjs \
  --master x.mike.testnet --prefix <printed-prefix> \
  alpha:1 beta:2 gamma:3 \
  --sequence-order beta,alpha,gamma
```

Expected recorder outcome: `[beta, alpha, gamma]` — i.e., the requested
release order, not the original submission order. The script prints
`trace-tx`, `state.mjs`, and `investigate-tx.mjs` commands you can rerun
against the captured tx hashes.

### 3. Live public witnesses (clickable on real contracts)

The sequencer targets arbitrary contracts, so the same sequencer works
against `social.near` on mainnet and `v1.social08.testnet` on testnet.
Each yielded step becomes a real NEAR Social post; release order becomes
reverse-chronological feed order at `near.social/<sequencer>`.

- mainnet: <https://near.social/simple-sequencer.sa-lab.mike.near>
  - yield `9Zb7PJFEbZi7v28c61hNNaAHCP11UfMAMGNhUwuzA7mY`, run
    `ChFXaJXHbmcz6vERCS8HcZqsVMR5f57AnodfLxQ6DmFV`
  - downstream blocks `194599850 < 194599853 < 194599856`, strictly
    monotonic with release order
- testnet: <https://test.near.social/simple-sequencer-simple-mo4jdkp3.x.mike.testnet>
  - yield `DhhnGr6sb1iyMhdgDYuWLwN6erugvDJ9Y7QfBjz9dhd5`, run
    `EaLXYQ3UnrBggyUQ97UN7n5PWncKeUGdWe5H9haZdXpV`
  - downstream blocks `246371085 < 246371088 < 246371091`

Full recipe, safety notes, gas guidance, and block-pinned content-level
proof in [SOCIALDB-VARIANT.md](./SOCIALDB-VARIANT.md).

## Tiny flow

```text
tx 1: yield batch
  user -> simple-sequencer.yield_promise(alpha)
  user -> simple-sequencer.yield_promise(beta)
  user -> simple-sequencer.yield_promise(gamma)
  result: three yielded callbacks are registered and waiting

tx 2: ordered release
  user -> simple-sequencer.run_sequence(beta, alpha, gamma)
  simple-sequencer resumes beta  -> recorder.record(beta, 2)
  simple-sequencer resumes alpha -> recorder.record(alpha, 1)
  simple-sequencer resumes gamma -> recorder.record(gamma, 3)

recorder state
  [beta, alpha, gamma]
```

The yield transaction's trace is the primary forensic anchor — the
yielded callback receipts that `run_sequence` wakes up live on the
original yield tree, not on the release tx's own tree.

## Repo layout

| Path | Role |
| --- | --- |
| `contracts/simple-sequencer/` | Minimal caller-scoped `yield_promise` / `run_sequence` sequencer |
| `contracts/recorder/` | Tiny stateful leaf contract that records downstream order |
| `scripts/` | Standalone build, deploy, and demo helpers for this mini-workspace |
| `res/` | Local Wasm artifacts built for the example |

This nested workspace intentionally stays out of the repo root workspace,
so it can evolve independently without disturbing the main
`smart-account` loop.

## Two things that look like complexity but aren't

**Why `yield_promise` takes six arguments.** `target_id`, `method_name`, and
`args` are the sequencer essentials — what downstream call this step will
make. `attached_deposit_yocto` and `gas_tgas` are per-call downstream
plumbing that the sequencer passes through untouched. `step_id` is the
caller's label used later by `run_sequence` to choose the release order.
No optional resolution policy here, unlike `contracts/smart-account/`.

**Why the sequencer partitions yielded state by caller.** The sequencer
is one shared contract that many accounts can use simultaneously. Staged
entries are keyed by `{caller_id}#{step_id}`, with `caller_id =
predecessor_account_id`, so two callers staging the same `step_id`
("alpha") do not collide, and `run_sequence(caller_id = …)` only drains
that caller's namespace.

## Local loop

```bash
./simple-example/scripts/check.sh
cargo test --manifest-path ./simple-example/Cargo.toml --workspace
./simple-example/scripts/build-all.sh
```

## Next stops

- [SOCIALDB-VARIANT.md](./SOCIALDB-VARIANT.md) — mainnet-visible NEAR
  Social variant, storage-deposit helper, testnet-first recipe, and the
  validated reference runs above
- [OPERATOR-APPENDIX.md](./OPERATOR-APPENDIX.md) — forensic inspection
  surfaces, artifact schema, and the FastNEAR endpoints each step uses
- [`../contracts/smart-account/`](../contracts/smart-account/) — the
  full account runtime that adds execution rights, durable automation
  state, and per-call resolution-policy hardening on top of this sequencer
- [`../md-CLAUDE-chapters/01-near-cross-contract-tracing.md`](../md-CLAUDE-chapters/01-near-cross-contract-tracing.md)
  — receipt mechanics and why the yield tx tree is the primary forensic
  anchor
