# `simple-example`

A standalone NEP-519 sequencing demo that strips the idea down to the smallest
system that still matters:

- one contract stages yielded downstream calls
- a second transaction releases those yielded callbacks in chosen order
- a tiny stateful leaf contract records the actual downstream order

This is intentionally **not** a smart-account product surface. It omits the
layers that make `contracts/smart-account/` interesting as an account runtime:

- no owner / delegated executor model
- no durable templates or balance triggers
- no completion-policy abstraction or adapters
- no external `types/` crate

What remains is the kernel claim:

> one multi-action transaction can manufacture multiple yielded callbacks, and a
> later `run_sequence` can release real downstream cross-contract work in a
> deliberately different order than the original action order

## Layout

| Path | Role |
| --- | --- |
| `contracts/simple-sequencer/` | Minimal caller-scoped `stage_call` / `run_sequence` kernel |
| `contracts/recorder/` | Tiny stateful leaf contract that records downstream order |
| `scripts/` | Standalone build, deploy, and demo helpers for this mini-workspace |
| `res/` | Local Wasm artifacts built for the example |

## Local loop

Run these from the repo root:

```bash
./simple-example/scripts/check.sh
cargo test --manifest-path ./simple-example/Cargo.toml --workspace
./simple-example/scripts/build-all.sh
```

This nested workspace intentionally stays out of the repo root workspace, so it
can evolve independently without disturbing the main `smart-account` loop.

## Testnet recipe

The primary workflow is now a forensic-grade two-step loop:

1. deploy a fresh prefixed pair
2. run the bundled demo wrapper
3. inspect the generated artifact JSON
4. use the printed trace/state/investigation commands for deeper analysis

Deploy the standalone pair:

```bash
MASTER=x.mike.testnet ./simple-example/scripts/deploy-testnet.sh
```

If `PREFIX` is not already set, the deploy script generates a fresh prefix and
prints it, along with the exact `send-demo` command to run next.

Because the deploy parent can only create **direct** subaccounts of itself, the
fresh prefix is folded into the leaf label. So a fresh run under
`x.mike.testnet` looks like:

- `simple-sequencer-<prefix>.x.mike.testnet`
- `simple-recorder-<prefix>.x.mike.testnet`

Run the bundled demo wrapper against that fresh deployment:

```bash
./simple-example/scripts/send-demo.mjs \
  --master x.mike.testnet \
  --prefix <printed-prefix> \
  alpha:1 beta:2 gamma:3 \
  --sequence-order beta,alpha,gamma
```

By default, `send-demo.mjs` now does all of this:

- submits the multi-action stage batch tx asynchronously
- polls `simple-sequencer.staged_calls_for(caller_id)` until the yielded steps materialize
- submits the later `run_sequence(...)` tx
- waits for `simple-recorder.get_entries()` to reflect the downstream work
- writes a run artifact under `collab/artifacts/`
- prints ready-to-rerun `trace-tx`, `state`, and `investigate-tx` commands

The artifact captures:

- network, signer, master, prefix, and deployed contract ids
- submitted action specs and requested sequence order
- both tx hashes and block heights
- recorder state before and after the run
- the new recorder entries for this run
- trace classifications and command strings for later archival work

## Evidence surfaces

These are the four proof surfaces to look at after a run:

1. Stage transaction trace

```bash
./scripts/trace-tx.mjs <stage_tx_hash> mike.testnet --wait FINAL
```

This is the primary forensic anchor. The original stage transaction's yielded
callback receipts should wake up in the declared release order, not in the
original submission order.

2. Release transaction trace

```bash
./scripts/trace-tx.mjs <run_sequence_tx_hash> mike.testnet --wait FINAL
```

This proves the explicit resume action happened and gives you the block/tx
anchor for the release step itself.

3. Recorder state

```bash
./scripts/state.mjs <simple-recorder.account> --method get_entries
```

This proves actual downstream effect order. On the canonical run, the new
entries should appear in:

- `beta`
- `alpha`
- `gamma`

4. One-command investigation report

```bash
./scripts/investigate-tx.mjs <stage_tx_hash> mike.testnet --wait FINAL \
  --accounts <simple-sequencer.account>,<simple-recorder.account> \
  --view '{"account":"<simple-recorder.account>","method":"get_entries"}'
```

This is the easiest way to reconstruct the three-surfaces story later, even
after the run has fallen out of the hot retention window and needs archival RPC
for trace recovery.

## FastNEAR endpoints this flow uses

The demo now deliberately records not just the tx hashes and blocks, but also
which FastNEAR surfaces we used to obtain them. This is meant to be useful both
for operators rerunning the flow later and for documenting the endpoints
themselves.

| Surface | Endpoint | How we use it | Why we use it |
| --- | --- | --- | --- |
| Stage/run trace capture | RPC `EXPERIMENTAL_tx_status` | `traceTx(...)` sends `{ tx_hash, sender_account_id, wait_until: "FINAL" }`, first to the hot RPC and then to archival on `UNKNOWN_TRANSACTION` | Gets the receipt DAG for the stage tx and the release tx, which is the primary proof surface for callback order |
| Stage materialization check | RPC `query(call_function)` | `callViewMethod(...)` calls `simple-sequencer.staged_calls_for({ caller_id })` with `finality: "final"` after the async stage submission until the expected yielded steps appear | Confirms the yielded handles are actually live before `run_sequence` tries to resume them |
| Tx enrichment | Tx API `POST /v0/transactions` | `buildTxArtifact(...)` sends `{ tx_hashes: [tx_hash] }` for both txs | Adds `block_height`, `block_hash`, `receiver_id`, and execution status so the artifact has durable forensic anchors |
| Recorder state snapshots | RPC `query(call_function)` | `callViewMethod(...)` calls `simple-recorder.get_entries()` with `finality: "final"` before the run and polls it after `run_sequence` until the expected new entries appear | Proves actual downstream effect order in durable contract state |
| Receipt pivot | Tx API `POST /v0/receipt` | `receipt-to-tx.mjs` sends `{ receipt_id }` when we want to pivot an interesting yielded or downstream receipt back to its tx | Useful when the DAG gives us a receipt id and we want to reconnect it to the originating transaction quickly |
| Per-block reconstruction | Tx API `POST /v0/block` | `investigate-tx.mjs` fetches the included block and cascade blocks with `with_receipts: true` | Reconstructs the block-by-block timeline of the cascade for forensic analysis |
| Account activity context | Tx API `POST /v0/account` | `investigate-tx.mjs` fetches function-call history for the sequencer and recorder accounts over the tx window | Adds the account-history surface, which is often easier for humans to correlate with the trace |
| Block-pinned state replay | RPC `query(call_function)` | `investigate-tx.mjs` reruns `get_entries()` with `block_id` pinned to interesting heights | Turns the recorder into a time series so you can see when state changed, not just the final state |

Two practical notes:

- `send-demo.mjs` writes these endpoint notes into the artifact JSON under
  `fastnear_endpoints`, so every recorded run carries its own API-usage
  documentation.
- The stage tx remains the primary forensic anchor, because the yielded
  callback receipts that `run_sequence` wakes up live on the original stage
  transaction’s tree, not on the release tx’s tree.

## What to compare against the main contract

If you want to see the delta back to the real smart-account prototype:

- `simple-sequencer` shows the bare yield/resume kernel
- `contracts/smart-account/` adds execution rights, durable automation state,
  and per-call completion-policy hardening on top of that kernel

That makes this folder the cleanest place in the repo to study the core
receipt-ordering mechanism by itself.
