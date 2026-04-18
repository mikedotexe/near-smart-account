# 05 · Three-surface triangulation of the staged-call cascade

**BLUF.** Chapter 03 captured the smart-account staged-execution testnet run
via the receipt-DAG surface (block heights of resumed `echo_log` receipts).
Chapter 04 introduced the three-surfaces methodology against the earlier
`latch` cascade. This chapter applies that methodology to chapter 03's
cascade: we reconstruct the same result from the **contract-state
time-series** and the **per-block receipts** surfaces, independently of the
DAG, and use the tables below as the running log for future review.

The live run itself happened before the public rename, so the historical tx
hashes and on-chain method names still correspond to `gated_call` /
`conduct`. The current codebase now exposes that same primitive as
`stage_call` / `run_sequence`.

Two findings that only surface through this lens:

1. `staged_calls_for` is **not drained when the resume callback runs**;
   it is drained when `on_stage_call_settled` runs — one block after the
   downstream `echo_log` receipt. This is the "wait for completion"
   semantic made visible in state.
2. `IterableMap::remove` uses **swap-remove**, so the iteration order of
   `staged_calls_for` shuffles as entries drain. Not a bug, but worth
   documenting: readers expecting stable order get surprised.

---

## 1. Reference run (from chapter 03 / the collab doc)

| Artifact | Value |
|---|---|
| Deploy tx | `GP2aLJ8B5M5gMVgw8vLc5zrF4L1hzbxBegXJPRSNUHvC` at block `246221149` |
| Authorized runner set | `7p9bUnAL96eyjPn6rTLzg3oKiX8RU8PZovqryXikDBZS` at `246221264` |
| Batch tx (4 staged actions @ 250 TGas) | `51quobuDJbeS2k7mMDRpwmjobeo1iRn1qnQDVQUeiJMk` at `246221934` |
| Sequence tx (`order = [beta, delta, alpha, gamma]`) | `uq3mGK6H6JqJuVBZVPpTpFpEkuekEnhKwinJM4yssNT` at `246222021` |
| Batch tx receipt totals | `25` Action receipts + `8` Data receipts, across shard `9` |

All captures in this chapter are against the live testnet rig with the
repo-local toolkit. No new transactions were submitted to write this
chapter — every table below is a read-only query pinned to a historical
block.

## 2. Surface 2 — state time-series

`scripts/state.mjs smart-account.x.mike.testnet --block <h> --method staged_calls_for --args '{"caller_id":"mike.testnet"}'`

| Block | `staged_calls_for` labels | What just happened on chain |
|---|---|---|
| 246221934 | `[]` | batch tx included in block — smart-account's receipt not yet executed |
| 246221935 | `[alpha, beta, gamma, delta]` | batch contract receipt executes; all four historical `gated_call` actions register staged entries and allocate yielded callbacks |
| 246221978 | `[alpha, beta, gamma, delta]` | ~43 blocks of idle waiting between batch and sequence run |
| 246222021 | `[alpha, beta, gamma, delta]` | sequence tx included; its receipt not yet executed |
| 246222022 | `[alpha, beta, gamma, delta]` | sequence contract receipt runs; calls `yield_id.resume(beta)` — schedules beta's callback but does not drain state |
| 246222023 | `[alpha, beta, gamma, delta]` | beta's `on_stage_call_resume` runs; dispatches downstream `echo_log` + `on_stage_call_settled` — still does not drain |
| 246222024 | `[alpha, beta, gamma, delta]` | beta's downstream `echo_log` executes at echo contract — still does not drain |
| 246222025 | `[alpha, delta, gamma]` | beta's `on_stage_call_settled` runs — **beta removed**, delta resume scheduled. Note the order: swap-remove moved delta into beta's vacated slot |
| 246222028 | `[alpha, gamma]` | delta's settle runs — delta removed, alpha resume scheduled. Swap-remove again moved gamma into delta's slot |
| 246222031 | `[gamma]` | alpha's settle runs — alpha removed, gamma resume scheduled |
| 246222034 | `[]` | gamma's settle runs — gamma removed; cascade complete |

The idle span between blocks `246221935` and `246222021` is stable; the
staged set does not need any external upkeep.

## 3. Surface 3 — per-block receipts at each cascade tick

`scripts/block-window.mjs --block <h> --with-receipts --with-transactions`
for blocks `246222022..246222034`. Every receipt at every block, keyed
to the originating tx.

### 3.1 Sequence runs — block 246222022

| Receipt | Predecessor → Receiver | Type | tx |
|---|---|---|---|
| `CrM7Vw…mJhx` | `mike.testnet` → `smart-account.x.mike.testnet` | Action | `uq3mGK…yssNT` (historical `conduct`) |

Just one Action receipt — the sequence run itself. `yield_id.resume(beta)` has
been invoked but beta's callback has not yet executed.

### 3.2 The four cascade steps

Each step is a clean 3-block cycle: **resume → downstream → settle**.
Every step's block pattern is identical; the hashes change.

**Step 1 — `beta`**

| Block | Receipt | Predecessor → Receiver | Type | Action |
|---|---|---|---|---|
| 246222023 | `A1sWNH…9S3L` | smart-account → smart-account | **Data** | resume payload from sequence run |
| 246222023 | `5Av8G2…PQf5` | smart-account → smart-account | **Action** | `on_stage_call_resume(beta)` |
| 246222024 | `DYyN9Y…Mbeo` | smart-account → **echo** | **Action** | `echo_log({"n":2})` downstream |
| 246222025 | `3ABZ1E…EAR6` | echo → smart-account | **Data** | `echo_log` return value |
| 246222025 | `huNECG…MquX` | smart-account → smart-account | **Action** | `on_stage_call_settled(beta)` |

**Step 2 — `delta`**

| Block | Receipt | Predecessor → Receiver | Type | Action |
|---|---|---|---|---|
| 246222026 | `5TyRAc…cU7X` | smart-account → smart-account | Data | resume payload from settle(beta) |
| 246222026 | `5EHzRN…akDB` | smart-account → smart-account | Action | `on_stage_call_resume(delta)` |
| 246222027 | `G2BpMP…PHkC` | smart-account → echo | Action | `echo_log({"n":4})` downstream |
| 246222028 | `Cdtmjf…mXo7` | echo → smart-account | Data | `echo_log` return value |
| 246222028 | `BZG1EE…15z4` | smart-account → smart-account | Action | `on_stage_call_settled(delta)` |

**Step 3 — `alpha`**

| Block | Receipt | Predecessor → Receiver | Type | Action |
|---|---|---|---|---|
| 246222029 | `B7QVii…FJdm` | smart-account → smart-account | Data | resume payload from settle(delta) |
| 246222029 | `94Fuzj…QrEJ` | smart-account → smart-account | Action | `on_stage_call_resume(alpha)` |
| 246222030 | `9NUCWZ…yHNr` | smart-account → echo | Action | `echo_log({"n":1})` downstream |
| 246222031 | `DfjJtG…bPHK` | echo → smart-account | Data | `echo_log` return value |
| 246222031 | `GX4aRP…NMu8` | smart-account → smart-account | Action | `on_stage_call_settled(alpha)` |

**Step 4 — `gamma`**

| Block | Receipt | Predecessor → Receiver | Type | Action |
|---|---|---|---|---|
| 246222032 | `8j9X4F…Hkhp` | smart-account → smart-account | Data | resume payload from settle(alpha) |
| 246222032 | `D2sxRv…psHH` | smart-account → smart-account | Action | `on_stage_call_resume(gamma)` |
| 246222033 | `EGV17E…De3q` | smart-account → echo | Action | `echo_log({"n":3})` downstream |
| 246222034 | `14SLVp…mXrP` | echo → smart-account | Data | `echo_log` return value |
| 246222034 | `7t4J9A…QhkS` | smart-account → smart-account | Action | `on_stage_call_settled(gamma)` |

Refund receipts (`system → mike.testnet`) fire on every block in the cascade
and are omitted from the tables above for focus — but they are all linked
back to either the batch tx (`51quob…iJMk`) or the sequence tx
(`uq3mGK…yssNT`).

## 4. Surface 1 — receipt DAG (recap)

Chapter 03 is the source of truth for the DAG surface. The per-label
downstream `echo_log` block heights from that chapter:

| Label | Downstream `echo_log` receipt | Block |
|---|---|---|
| `beta` | `DYyN9Y…Mbeo` | 246222024 |
| `delta` | `G2BpMP…PHkC` | 246222027 |
| `alpha` | `9NUCWZ…yHNr` | 246222030 |
| `gamma` | `EGV17E…De3q` | 246222033 |

Surface 2 (state drained at 25 / 28 / 31 / 34) and surface 3 (settle
receipts at the same blocks) corroborate this order independently.

## 5. Activity feed — one place to find everything

`scripts/account-history.mjs smart-account.x.mike.testnet --limit 10 --function-call`
captures the full experiment history as a single time-ordered feed. Rows
dumped 2026-04-17 (ordered newest → oldest):

| Block | Tx | Time (UTC) | Result | Role |
|---|---|---|---|---|
| 246222021 | `uq3mGK…ssNT` | 23:21:20 | success | historical `conduct`, mike.testnet → smart-account |
| 246221934 | `51quob…iJMk` | 23:20:31 | success | batch, mike.testnet → smart-account |
| 246221465 | `6smJpH…ytLG` | 23:16:01 | success (but callbacks woke Failed) | probe 3 (333/200) |
| 246221434 | `4kNwGh…BvtD` | 23:15:42 | success | smart-account self-call |
| 246221425 | `B4K8mq…iw36` | 23:15:37 | success | smart-account self-call |
| 246221327 | `3K85KE…ac2w` | 23:14:40 | not_success | probe 2 (320/280) |
| 246221274 | `Fn5tph…pkWe` | 23:14:09 | not_success | probe 1 (60/940) |
| 246221264 | `7p9bUn…DBZS` | 23:14:03 | success | historical `set_authorized_resumer` |
| 246221235 | `8UUJ2y…64mg` | 23:13:48 | not_success | first `set_authorized_resumer` attempt |
| 246221149 | `GP2aLJ…UHvC` | 23:13:01 | success | deploy + init |

The full arc from deploy through gas-shape iteration to the successful run
is legible in ten rows of one feed. For a future session, this is how you
find the run: `account-history smart-account.x.mike.testnet --function-call`
always surfaces the last successful batch / sequence pair right at the top.

## 6. Shape contrast — `latch` vs staged call

Comparing the two cascades:

| Aspect | Chapter 02 `latch` cascade | Chapter 03 staged-call cascade |
|---|---|---|
| Labels | 3 (alpha, beta, gamma) | 4 (alpha, beta, gamma, delta) |
| Cascade span | blocks 246214776 → 246214779 | blocks 246222022 → 246222034 |
| Blocks per step | **1** | **3** |
| State drain trigger | `on_latch_resume` — entry removed immediately | `on_stage_call_settled` — entry removed **after** downstream completes |
| Downstream work | none (callback returns a string) | real `FunctionCall` on echo |
| What's proven | callbacks wake in chosen order | downstream receipts *complete* in chosen order, one at a time |

The 3x-per-step block cost buys "A's downstream has fully completed before
B's downstream starts." That is the guarantee latch alone cannot offer.

## 7. What this transfers

The three surfaces — receipt DAG, contract state, account activity —
illuminated this staged-call cascade exactly the way they illuminated the
latch cascade in chapter 04. **The methodology is contract-agnostic.**
Any contract that carries yield/resume sequencing — a SputnikDAO-style
proposal executor, an auto-compounder vault, a migrator, a guardian
wallet — can be observed and validated the same way:

- a typed view for "what is still pending" (our `staged_calls_for`)
- `scripts/state.mjs --block <h>` to pin that view at each cascade tick
- `scripts/block-window.mjs --block <h> --with-receipts` for the per-tick
  receipt detail
- `scripts/account-history.mjs` to tie the experiment into one feed

When a new contract adopts this pattern, chapter 05's tables are the
template for documenting the cascade shape.

## 8. Recipes (copy-pasteable)

```bash
# state time-series across cascade blocks
for b in 246221935 246221978 246222022 246222025 246222028 246222031 246222034; do
  printf "block %s: " "$b"
  ./scripts/state.mjs smart-account.x.mike.testnet --block "$b" \
    --method staged_calls_for --args '{"caller_id":"mike.testnet"}' \
    | tail -n +2
done

# per-block receipts across the cascade (13 blocks)
for b in $(seq 246222022 246222034); do
  echo "=== $b ==="
  ./scripts/block-window.mjs --block "$b" --with-receipts --with-transactions
done

# activity feed — finds batch + sequence pair and the gas-shape probe history
./scripts/account-history.mjs smart-account.x.mike.testnet --limit 20 --function-call

# receipt pivot back to tx and shard
./scripts/receipt-to-tx.mjs DYyN9YYZgkRxDtHKvrPGBgwdiLDp9EE3QiXL3tE5Mbeo
```

Every table in this chapter was generated from the commands above, in a
single read-only pass against live testnet. This is the running log: block
numbers and transaction hashes, laid out so a future reader can walk the
cascade block-by-block and see the state drain underneath the receipts.
