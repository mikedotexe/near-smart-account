# 04 · Three surfaces for observing a NEAR cascade

Historical terminology note: this chapter reconstructs the earlier
`latch / conduct` experiment, so it intentionally keeps that older vocabulary.
Current docs and current code use `step` and `run_sequence`.

**BLUF.** `EXPERIMENTAL_tx_status` alone does not fully explain a yield/resume
cascade. Every execution has three orthogonal data surfaces: (1) the **receipt
DAG** via the status RPC, (2) the **contract state** via `query view_state` /
`call_function` pinned at any block, and (3) the **account activity feed** via
the FastNEAR Transactions API. Triangulating all three turns an opaque cascade
into a legible time-series. This chapter works the already-validated
`4ct5RA.../BW3fmR...` latch/conduct cascade end-to-end using the repo-local
`scripts/*.mjs` toolkit, and introduces the missing third surface as a new
`scripts/state.mjs`.

---

## 1. What each surface answers

| Surface | Answers | Endpoint (FastNEAR) | Repo script |
|---|---|---|---|
| Receipt DAG | "What receipts ran, in what tree, with which statuses / logs / yield flags?" | RPC `EXPERIMENTAL_tx_status` | `scripts/trace-tx.mjs` |
| Contract state | "What is the contract's internal map / counter / flag **right now** or **at block H**?" | RPC `query view_state` / `call_function` | `scripts/state.mjs` |
| Account activity | "Which txs involved this account, in what time-order, and in what role?" | Tx API `POST /v0/account` | `scripts/account-history.mjs` |
| (supporting) Per-block / block-range | "What receipts and txs live in this block or range?" | Tx API `POST /v0/block`, `/v0/blocks` | `scripts/block-window.mjs` |
| (supporting) Receipt pivot | "Given an opaque receipt_id, which tx produced it?" | Tx API `POST /v0/receipt` | `scripts/receipt-to-tx.mjs` |
| (supporting) Chain tip | "Where is finality right now?" | NEAR Data `GET /v0/last_block/final` | `scripts/watch-tip.mjs` |

The receipt DAG is the surface the repo has been using since chapter 01.
Chapter 02 used it for the first real ordering proof. Surface (2) is the new
one: `call_function` and `view_state` both take a `finality` *or* a
`block_id`, so the same view method gives you the state as of any recent
block. That is what turns a snapshot into a time-series.

## 2. The cascade, reconstructed from three surfaces

Reference run (chapter 02 is the source of truth for the experiment itself):

- latch tx `4ct5RA1d4x9efJXWGxPBQRLhsPtKxw453wGpP6F8WZ3L` lands at block `246214732`
- conduct tx `BW3fmRbzZGFdFrE37uxX2cMzHj6Ur1mG7FCEmjAXKVmT` lands at block `246214775` with `order = ["beta", "alpha", "gamma"]`
- blocks `246214775..246214780` contain the whole cascade

### 2.1 Surface 1 — receipt DAG on the **latch** tx

```bash
./scripts/trace-tx.mjs 4ct5RA1d4x9efJXWGxPBQRLhsPtKxw453wGpP6F8WZ3L --wait FINAL
```

Two interesting features of the output:

- the parent yield-sequencer receipt carries three `FunctionCall(latch, …)`
  actions in one receipt — proof that multi-Action txs execute as **one
  receipt**, not N (CLAUDE.md pitfall)
- three yielded callback receipts hang off it, each marked `[yield]`, each
  ending `SuccessValue "alpha" / "beta" / "gamma"` — **that** is where the
  resumed callback order is visible on chain

Conduct's own trace, by contrast, is a single receipt returning `3`. The
ordering proof is **not** in conduct's tree; attempting to read it there is
the most common confusion with this shape.

### 2.2 Surface 2 — contract state, pinned at each cascade block

```bash
for b in 246214775 246214776 246214777 246214778 246214779 246214780; do
  printf "block %s: " "$b"
  ./scripts/state.mjs yield-sequencer.x.mike.testnet --block $b \
      --method pending_latches_for --args '{"caller_id":"mike.testnet"}' \
      | tail -n +2
done
```

Actual output captured 2026-04-17:

| Block | `pending_latches_for("mike.testnet")` | What just happened on chain |
|---|---|---|
| 246214775 | `["alpha", "beta", "gamma"]` | conduct tx included in block (not yet executed) |
| 246214776 | `["alpha", "beta", "gamma"]` | conduct contract receipt runs; initiates first resume |
| 246214777 | `["alpha", "gamma"]` | `on_latch_resume(beta)` runs |
| 246214778 | `["gamma"]` | `on_latch_resume(alpha)` runs |
| 246214779 | `[]` | `on_latch_resume(gamma)` runs |
| 246214780 | `[]` | steady state |

Notice two things:

- state is flat across blocks 775 and 776 even though conduct touched chain:
  conduct's contract receipt only **schedules** the first resume. The
  yielded callback itself travels as a data receipt and does not execute
  until the next block.
- each subsequent cascade step is a single-block tick. Each
  `on_latch_resume` both (a) removes its own latch entry and (b) calls
  `yield_id.resume(...)` for the next label — which will land as a data
  receipt and run the following block.

### 2.3 Surface 3 — account activity on both endpoints

```bash
./scripts/account-history.mjs mike.testnet --limit 4
./scripts/account-history.mjs yield-sequencer.x.mike.testnet --limit 10 --function-call
```

From `mike.testnet` (signer side) we see the `conduct` tx above the `latch`
tx at `246214775` / `246214732`, plus a prior failed conduct at `246214553`
that flags `not_success` — the timed-out run documented in chapter 02 §5.

From `yield-sequencer.x.mike.testnet` (receiver side) we see the full life
of the account: initial deploy/init tx, `set_authorized_resumer`, two latch
attempts and two conduct attempts. This is how we find related tx hashes
when we have lost them — no manual bookkeeping required.

### 2.4 Per-block receipts confirm the cascade tick-by-tick

```bash
./scripts/block-window.mjs --from 246214775 --to 246214780 --desc
```

yields the block-metadata row for each block (receipt counts, gas, hash).
Drilling into a specific block:

```bash
./scripts/block-window.mjs --block 246214777 --with-receipts --with-transactions
```

shows the exact three receipts at block `246214777`:

- `Gx6DWi…izFB`   system → mike.testnet   type=Action  (refund from the conduct tx)
- `8qA2ar…3JvK`   yield-sequencer → yield-sequencer   type=Data   (the resume payload)
- `6XN7gr…skUE`   yield-sequencer → yield-sequencer   type=Action (beta's callback)

All three belong to the latch tx `4ct5RA…` (not conduct), confirming once
more that the resumed callbacks live on the original tx's tree.

### 2.5 Receipt pivot closes the loop

```bash
./scripts/receipt-to-tx.mjs 6XN7grXUE2KuCGrKyjBCAgSJHvS5DKCjqkxjAh7kskUE
```

returns both the appearance block (`246214733#2`) and the execution block
(`246214777#2`) for beta's callback, plus the originating tx and shard id.
For any receipt we happen to be staring at, this is the one-call path back
to full context.

## 3. Why this mental model matters

Before this chapter, the proof of ordering lived in the subtle corner of
"per-receipt block heights on the latch tx's resumed callbacks." Convincing
but requires careful reading. With the state time-series, "alpha, beta,
gamma" draining to "gamma" on the exact block chapter 02 says beta's
callback ran is directly interpretable to anyone glancing at the table.

It also opens the door to **block-by-block assertions** in future tests
("state at block N must contain X") rather than only terminal assertions
("cascade eventually completes").

## 4. Gotchas

- **`query view_state` collapses the contract struct to one `STATE` blob.**
  `#[near(contract_state)]` serializes the whole `Contract` struct as a single
  borsh value under key `STATE` (first byte `0x53` = `'S'`). `IterableMap` and
  `LookupMap` entries live under their `BorshStorageKey` discriminant bytes
  (`0x01`, `0x02`, …). Raw state of yield-sequencer mid-cascade shows nine
  entries: one `STATE`, three `0x01…` keys (the latches), one `0x02…` key
  (the conduct-order head), three 32-byte hash keys (IterableMap's
  hash→index reverse map), and the two short `0x017600…` per-index entries.
  Use typed `call_function` views whenever the contract exposes them; reserve
  raw `view_state` for when the typed view does not exist yet.
  [Chapter 22](./22-state-break-investigation.md) extends this picture
  into the pre-mainnet implication: because every field of `Contract` is
  a positional borsh commitment, adding or removing a field without a
  versioned-state migration is how `smart-account.x.mike.testnet` got
  its "Cannot deserialize the contract state" break.
- **`--block` is what unlocks time-series.** Without it, `query` runs against
  `finality=final`, i.e. the tip. Always pin when reconstructing a cascade.
- **Regular RPC retention is ~3 epochs (~21 h).** Historical queries older
  than that will fail with `UNKNOWN_*`. `scripts/state.mjs` does not yet fall
  over to archival; `scripts/trace-tx.mjs` does. Obvious follow-up.
- **Method-level errors hide inside `result.error`.** The RPC returns 200 OK
  with `result = { block_hash, block_height, error, logs }` when a view
  call panics or the method does not exist. `scripts/state.mjs` surfaces
  that case; hand-rolled curl will silently "succeed" otherwise.
- **Conduct's tx tree is not the ordering proof.** Pin the trace viewer on
  the latch tx; never on conduct.
- **Testnet deploy can lag local code.** When this chapter was written,
  `smart-account.x.mike.testnet` was still running the earlier stub (no
  staged-call path yet); `state.mjs ... --method staged_calls_for`
  returned `MethodResolveError(MethodNotFound)`. Redeploy before driving a
  staged-call experiment — see
  [`archive-staged-call-lineage.md`](./archive-staged-call-lineage.md) §7
  for the exact recipe.

## 5. Recipes

```bash
# Surface 1 — receipt DAG
./scripts/trace-tx.mjs <tx_hash> [sender] --wait FINAL

# Surface 2 — contract state, typed (preferred)
./scripts/state.mjs <account> --method <view> --args '{"k":"v"}'
./scripts/state.mjs <account> --method <view> --args '{"k":"v"}' --block <h>

# Surface 2 — contract state, raw (when no typed view exists)
./scripts/state.mjs <account> [--prefix <base64>] [--block <h>]

# Surface 3 — account activity
./scripts/account-history.mjs <account> --limit 20
./scripts/account-history.mjs <account> --function-call --success

# Per-block receipts / txs
./scripts/block-window.mjs --block <h> --with-receipts --with-transactions
./scripts/block-window.mjs --from <h> --to <h> --limit 20 --desc

# Receipt → tx pivot
./scripts/receipt-to-tx.mjs <receipt_id>

# Tip
./scripts/watch-tip.mjs --once
./scripts/watch-tip.mjs --kind optimistic
```

---

One script, one new mental model. The scripts themselves are almost
incidental: the real move was realizing that every view is already a
time-series, as long as you remember to pass `--block`.
