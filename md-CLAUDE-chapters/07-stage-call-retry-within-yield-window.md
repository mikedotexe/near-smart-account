# 07 · `stage_call` retry proof within the yield window

**BLUF.** Chapter 06 validated the saga halt on downstream failure but
could not directly demonstrate the third chapter 03 §3 claim — *later
labels remain pending and can be conducted again in a fresh order* —
because the ~100-second yield timeout fired before a second
`run_sequence` could be issued. This chapter runs the retry experiment
tight enough to stay inside the yield window: three labels, three
successive `run_sequence` calls, three clean saga-halt drains, and
steady-state empty **64 blocks before the yield timeout would have
fired**. The claim now has direct empirical backing.

## 0. Mental model (Mike's geometry)

> *The contract is a central sphere of liquid. Each `stage_call` chucks a
> yielded callback receipt out into orbit around it — holding its own
> `YieldId`, consuming no gas, just waiting. `run_sequence` calls a
> satellite back in with a payload. If nothing calls it back within ~200
> blocks, the orbit decays and the protocol pulls it back with a
> `PromiseError::Failed`.*

Chapter 07 is three successive ground-station passes: three separate
`run_sequence` calls, each retrieving exactly one satellite. Every
pass happens well inside the orbital-decay window.

## 1. Reference run

| Artifact | Value | Block |
|---|---|---|
| Batch tx (3 × `stage_call`, all `not_a_method`) | `Dxm5VbkfSSmegWub3eEr1FMs54svfUfEVsQnHiV9LMjM` | `246228443` |
| Retry #1 (`order = [beta]`) | `GQGiGnGh8DqH88uMyeDaMFbrm8e4XZ3QzsJjuYTQd1S6` | `246228494` |
| Retry #2 (`order = [alpha]`) | `55rE9uyusFZqeG4TTsJViNpzR3mYmsZpZrxYMHYa9w4X` | `246228499` |
| Retry #3 (`order = [gamma]`) | `26WKE9AWxZbHvNmwFshuCqM3J4dp26pLWEur5dqCmFWZ` | `246228504` |
| All retries completed by | — | `246228508` |
| Yield timeout would have fired at | ~ | `246228644` (444 + 200) |

Elapsed wall-clock from batch receipt to final drain: **64 blocks ≈ 32
seconds**. Remaining margin before timeout: **136 blocks ≈ 68 seconds**.

All three retries signed and submitted synchronously via
`near call smart-account.x.mike.testnet run_sequence` from
`mike.testnet` (who is the contract's owner — `new_with_owner` made
that direct, no `set_authorized_executor` needed).

## 2. Surface 2 — state time-series across three retries

`scripts/state.mjs smart-account.x.mike.testnet --block <h> --method staged_calls_for --args '{"caller_id":"mike.testnet"}'`

| Block | `staged_calls_for` labels | What just happened |
|---|---|---|
| 246228443 | `[]` | batch tx included; contract receipt not yet executed |
| 246228444 | `[alpha, beta, gamma]` | batch receipt runs; 3 yielded callbacks allocated |
| 246228493 | `[alpha, beta, gamma]` | 49-block idle wait (~25s) |
| 246228494 | `[alpha, beta, gamma]` | retry #1 tx included |
| 246228495 | `[alpha, beta, gamma]` | run_sequence contract receipt runs; schedules beta resume |
| 246228496 | `[alpha, beta, gamma]` | beta's `on_stage_call_resume` runs; dispatches downstream + settle |
| 246228497 | `[alpha, beta, gamma]` | beta's downstream `echo.not_a_method` **fails** |
| 246228498 | `[alpha, gamma]` | **beta's `on_stage_call_settled` removes beta and halts** |
| 246228499 | `[alpha, gamma]` | retry #2 tx included |
| 246228500 | `[alpha, gamma]` | run_sequence contract receipt runs |
| 246228501 | `[alpha, gamma]` | alpha's resume runs |
| 246228502 | `[alpha, gamma]` | alpha's downstream fails |
| 246228503 | `[gamma]` | **alpha's settle removes alpha** |
| 246228504 | `[gamma]` | retry #3 tx included |
| 246228505 | `[gamma]` | run_sequence contract receipt runs |
| 246228506 | `[gamma]` | gamma's resume runs |
| 246228507 | `[gamma]` | gamma's downstream fails |
| 246228508 | `[]` | **gamma's settle removes gamma; state empty** |
| 246228513 | `[]` | steady state; yields never needed to time out |

Three identical 4-block cascade slices (494→498, 499→503, 504→508), each
removing exactly one label via the saga-halt path. No label ever
reaches the timeout fallback — the ground station collected every
satellite before its orbit decayed.

## 3. Surface 3 — per-block receipts during retry #1 (representative)

`scripts/block-window.mjs --block <h> --with-receipts --with-transactions`

| Block | Receipt | Predecessor → Receiver | Type | Note |
|---|---|---|---|---|
| 246228494 | — | — | — | retry tx `GQGiGn…d1S6` included, no receipts yet |
| 246228495 | `5SCQKC…TZqP` | mike.testnet → smart-account | Action | `run_sequence(order=[beta])` contract receipt |
| 246228496 | `22CrBV…XMUj` | smart-account → smart-account | Data | resume payload for beta |
| 246228496 | `5En8eh…BpQq` | smart-account → smart-account | Action | `on_stage_call_resume(beta)` — dispatches downstream + settle |
| 246228497 | `BLNUkQ…ejw9` | smart-account → **echo** | Action | `echo.not_a_method` — **success=false** |
| 246228498 | `6dHpbm…Ua6i` | echo → smart-account | Data | downstream failure surfaced |
| 246228498 | `DZzQhK…1VWE` | smart-account → smart-account | Action | **`on_stage_call_settled(beta)` removes beta** |

This is the same 5-receipt shape chapter 06 §4.1 documented — resume
Data → resume Action → downstream Action (failure) → settle Data →
settle Action — but now it fires three times consecutively in the same
run. Retries #2 and #3 have identical block-for-block structure with
different hashes.

## 4. Surface 1 — receipt DAG per retry

Each retry tx trace is tiny: a single `run_sequence` Action receipt plus
its refund. The interesting behaviour lives on the **original batch
tx's** tree — each retry's cascaded receipts attach there, exactly as
chapter 02 §4 described for the `latch` case.

`scripts/trace-tx.mjs Dxm5VbkfSSmegWub3eEr1FMs54svfUfEVsQnHiV9LMjM mike.testnet --wait FINAL`
shows the original batch tree **with three distinct cascaded failures**
under it — one per label, each with its own downstream-Failure leaf
plus its `on_stage_call_settled` halt log.

Key log lines from the batch tx's tree:

```
log: stage_call 'beta' resumed for mike.testnet -> echo.x.mike.testnet.not_a_method memo=None
log: stage_call 'beta' for mike.testnet failed downstream and stopped the sequence: Failed

log: stage_call 'alpha' resumed for mike.testnet -> echo.x.mike.testnet.not_a_method memo=None
log: stage_call 'alpha' for mike.testnet failed downstream and stopped the sequence: Failed

log: stage_call 'gamma' resumed for mike.testnet -> echo.x.mike.testnet.not_a_method memo=None
log: stage_call 'gamma' for mike.testnet failed downstream and stopped the sequence: Failed
```

No `could not resume and was dropped: Failed` logs anywhere — that line
would indicate the timeout path fired. Here, the retries were fast
enough that every label took the intentional saga-halt path instead.

## 5. The three chapter-03 §3 claims, all empirically backed

Between chapters 05, 06, and 07, every semantic from chapter 03 §3 now
has direct testnet evidence:

| Claim | Where demonstrated |
|---|---|
| "if the yielded callback wakes up with `PromiseError`, the pending call is dropped and the active conduct queue is cleared" | chapter 06 (timeout path at block 246227624) |
| "if the downstream `FunctionCall` fails, the current call is removed and the active conduct queue is cleared" | chapter 06 (saga halt at block 246227607) and chapter 07 (three times) |
| "later labels remain pending and can be conducted again in a fresh order" | **chapter 07** — alpha and gamma survived beta's halt, each retrievable by a fresh `run_sequence` |

The saga semantic is closed. What remains open is the positive-path
ergonomics — things like "can we conduct multiple labels in one
`run_sequence` when downstream is expected to succeed," which
chapter 03's four-label run covered, plus edge cases like mixed
success/failure within a single `run_sequence` order, which we have
not yet tested.

## 6. Why this result matters for the saga story

In distributed-systems vocabulary, a saga is a sequence of local
transactions with compensations. What chapter 06 + 07 collectively show
is a saga where:

- halt on failure is built into the callback settle path
- retry on remaining work is achieved by issuing another orchestration
  call against the same pending set
- the surviving pending entries are durable for the full yield window
  (~200 blocks / ~100 s) with no keeper required

That is a *cooperative* saga — no cron job, no watchdog, no external
process has to keep the sequence alive. The contract itself is the
state store; the user (or their agent) decides when to orchestrate the
next step. Each `run_sequence` is a cheap single-action tx that can
pick up exactly where the previous one halted.

## 7. Recipes

```bash
# small batch (3 labels) guaranteed to fail downstream
./scripts/send-staged-echo-demo.mjs \
  alpha:1 beta:2 gamma:3 \
  --action-gas 250 --call-gas 30 \
  --method not_a_method \
  --sequence-order beta,alpha,gamma &
sleep 8
./scripts/account-history.mjs mike.testnet --limit 1

# three prompt retries, each for one label
for label in beta alpha gamma; do
  near call smart-account.x.mike.testnet run_sequence \
    "{\"caller_id\":\"mike.testnet\",\"order\":[\"$label\"]}" \
    --accountId mike.testnet
done

# watch the drain
for b in 246228444 246228498 246228503 246228508 246228513; do
  printf "block %s: " "$b"
  ./scripts/state.mjs smart-account.x.mike.testnet --block "$b" \
    --method staged_calls_for --args '{"caller_id":"mike.testnet"}'
done
```

Every table here was generated by those commands against the live
testnet rig. As in chapters 05 and 06, the tables are the running log —
the orbital-retrieval pattern preserved block-by-block for future
reference.
