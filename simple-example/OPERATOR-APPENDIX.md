# simple-example — operator appendix

Forensic material for operators running the simple-example flow who want
to reconstruct a run or inspect its evidence surfaces in detail. The
main [README](./README.md) stays focused on the kernel claim; this file
carries the how-do-I-trace-this material.

## Four proof surfaces for any run

After a `send-demo.mjs` or `send-social-poem.mjs` run, these are the
surfaces worth looking at.

### 1. Yield transaction trace

```bash
./scripts/trace-tx.mjs <stage_tx_hash> mike.testnet --wait FINAL
```

The primary forensic anchor. The original yield transaction's yielded
callback receipts should wake up in the declared release order, not in
the original submission order. Downstream effect receipts
(`recorder.record`, `social.near.set`, etc.) live on this tree as
descendants of the yielded callbacks.

### 2. Release transaction trace

```bash
./scripts/trace-tx.mjs <run_sequence_tx_hash> mike.testnet --wait FINAL
```

Proves the explicit resume action happened and gives a block/tx anchor
for the release step itself. This tree is usually much smaller than the
yield tree — most of the interesting cascade is on the yield side.

### 3. Downstream state

For the recorder variant:

```bash
./scripts/state.mjs <simple-recorder.account> --method get_entries
```

For the SocialDB variant:

```bash
./scripts/state.mjs <social-account> --method get \
  --args '{"keys":["<sequencer>/post/main"]}'
```

Proves actual durable downstream effect — not just that receipts resolved,
but that they produced the intended contract state.

### 4. One-command investigation report

```bash
./scripts/investigate-tx.mjs <stage_tx_hash> mike.testnet --wait FINAL \
  --accounts <simple-sequencer.account>,<leaf.account> \
  --view '{"account":"<leaf.account>","method":"<method>","args":{...}}'
```

The easiest way to reconstruct the three-surfaces story later, even
after the run has fallen out of the hot retention window and needs
archival RPC for trace recovery. Produces markdown plus JSON.

## What `send-demo.mjs` does for you by default

- submits the multi-action yield batch tx asynchronously
- polls `simple-sequencer.yielded_promises_for(caller_id)` until the yielded
  steps materialize
- submits the later `run_sequence(...)` tx
- waits for `simple-recorder.get_entries()` to reflect the downstream
  work
- writes a run artifact under `collab/artifacts/`
- prints ready-to-rerun `trace-tx`, `state.mjs`, and `investigate-tx.mjs`
  commands

`send-social-poem.mjs` follows the same pattern but against
`social.near` and reads `post/main` at the downstream block heights for
a block-pinned content-level ordering proof. See
[SOCIALDB-VARIANT.md](./SOCIALDB-VARIANT.md).

## Artifact schema (recorder variant)

Each `send-demo.mjs` run writes one JSON artifact under
`collab/artifacts/` capturing:

- `network`, `signer`, `master`, `prefix`, and deployed contract ids
- `submitted_actions` and `sequence_order_requested`
- both tx hashes and their block heights
- `recorder_state_before` / `recorder_state_after` and
  `new_entries` (ordered by the actual downstream sequence)
- `stage_outcome` classification (`pending_until_resume`,
  `hard_fail_before_stage`, `immediate_resume_failed`) and reason
- `traces` with classifications for yield and run_sequence
- `fastnear_endpoints` — an inline log of which endpoints were used and
  why, for later rerun or citation
- a `commands` block with ready-to-rerun `trace-tx`, `state.mjs`, and
  `investigate-tx.mjs` invocations

The SocialDB variant artifact adds
`downstream_social_receipts.ordered`, `post_main_timeline` (block-pinned
content snapshots), and the `near.social` feed URL.

## FastNEAR endpoints this flow uses

`send-demo.mjs` and `send-social-poem.mjs` record not just tx hashes and
blocks but also which FastNEAR surfaces were used to obtain them. This
is meant to be useful for operators rerunning the flow and for
documenting the endpoints themselves.

| Surface | Endpoint | How we use it | Why we use it |
| --- | --- | --- | --- |
| Yield/run trace capture | RPC `EXPERIMENTAL_tx_status` | `traceTx(...)` sends `{ tx_hash, sender_account_id, wait_until: "FINAL" }`, first to the hot RPC and then to archival on `UNKNOWN_TRANSACTION` | Gets the receipt DAG for the yield tx and the release tx, which is the primary proof surface for callback order |
| Yield materialization check | RPC `query(call_function)` | `callViewMethod(...)` calls `simple-sequencer.yielded_promises_for({ caller_id })` with `finality: "final"` after async yield submission until the expected yielded steps appear | Confirms yielded handles are actually live before `run_sequence` tries to resume them |
| Tx enrichment | Tx API `POST /v0/transactions` | `buildTxArtifact(...)` sends `{ tx_hashes: [tx_hash] }` for each tx | Adds `block_height`, `block_hash`, `receiver_id`, and execution status so the artifact has durable forensic anchors |
| Downstream state snapshots | RPC `query(call_function)` | `callViewMethod(...)` reads the leaf contract's state before the run and polls it after `run_sequence` until the expected new entries appear | Proves actual downstream effect order in durable contract state |
| Receipt pivot | Tx API `POST /v0/receipt` | `receipt-to-tx.mjs` sends `{ receipt_id }` when we want to pivot an interesting yielded or downstream receipt back to its tx | Useful when the DAG gives us a receipt id and we want to reconnect it to the originating transaction quickly |
| Per-block reconstruction | Tx API `POST /v0/block` | `investigate-tx.mjs` fetches the included block and cascade blocks with `with_receipts: true` | Reconstructs the block-by-block timeline of the cascade for forensic analysis |
| Account activity context | Tx API `POST /v0/account` | `investigate-tx.mjs` fetches function-call history for the sequencer and leaf accounts over the tx window | Adds the account-history surface, often the fastest human-readable way to confirm participation at expected blocks |
| Block-pinned state replay | RPC `query(call_function)` | `investigate-tx.mjs` and `send-social-poem.mjs` rerun view methods with `block_id` pinned to interesting heights | Turns the leaf into a time series so you can see when state changed, not just the final state |

Two practical notes:

- the scripts write these endpoint notes into the artifact JSON under
  `fastnear_endpoints` (recorder variant), so every recorded run carries
  its own API-usage documentation
- the yield tx remains the primary forensic anchor, because the yielded
  callback receipts that `run_sequence` wakes up live on the original
  yield transaction's tree, not on the release tx's tree
