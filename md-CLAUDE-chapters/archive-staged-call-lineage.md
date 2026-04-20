# Archive — Staged-call lineage

Consolidated archive of five historical chapters that together
validated the smart-account-side `stage_call` / `run_sequence` saga
semantics on testnet over 2026-04-17 / 2026-04-18. Superseded by the
current reference chapters (14, 18, 19) for ongoing work; preserved
here because the tx hashes and block-by-block proofs are still the
evidence behind those reference claims.

Original chapters, now merged:

- `03-smart-account-staged-call.md` — first smart-account-side
  validation
- `05-staged-call-three-surfaces.md` — three-surfaces method applied
- `06-stage-call-failure-modes.md` — dual failure path (halt + timeout)
- `07-stage-call-retry-within-yield-window.md` — live retry proof
- `08-stage-call-mixed-outcome-sequence.md` — mixed-outcome saga

Period-accurate terminology preserved. The earliest runs (2026-04-17)
used on-chain method names `gated_call` / `conduct`; the current
codebase renamed those to `stage_call` / `run_sequence`. Tx hashes and
the log excerpts in §5 retain the historical names where they actually
landed on-chain.

## 1. Evidence index

| Run | Scenario | Batch tx | Release tx(s) | Block span |
|---|---|---|---|---|
| 4-label success | All succeed, chosen release order `[beta, delta, alpha, gamma]` | `51quobuDJbeS2k7mMDRpwmjobeo1iRn1qnQDVQUeiJMk` at `246221934` | `uq3mGK6H6JqJuVBZVPpTpFpEkuekEnhKwinJM4yssNT` at `246222021` | 246222022–246222034 |
| 4-label dual failure | 1 halt + 3 timeout in one tx tree | `HbjJ1V61jqEjgz3P2XkQtueFUhZRNUG197mmXzriMXN9` at `246227422` | `9At6bdLMzW41MoKon1dXdHJhYMuVJ8NmsbzFiXNkJXqM` at `246227603` | 246227604–246227625 |
| 3-label retry | Three successive single-label retries inside yield window | `Dxm5VbkfSSmegWub3eEr1FMs54svfUfEVsQnHiV9LMjM` at `246228443` | `GQGiGnGh8DqH88uMyeDaMFbrm8e4XZ3QzsJjuYTQd1S6`, `55rE9uyusFZqeG4TTsJViNpzR3mYmsZpZrxYMHYa9w4X`, `26WKE9AWxZbHvNmwFshuCqM3J4dp26pLWEur5dqCmFWZ` at 246228494/499/504 | 246228494–246228508 |
| 4-label mixed outcome | alpha OK → beta halt → gamma + delta retried OK | `9uEY27DFH1KCvsG7xsBAzAmE78ZgzJ5MwPy3TwCUULCh` at `246228934` | `8ke5F4wFuidxDvM1MEZ16neyf6BC1QsdehypEDPJaQxz` at `246228979`; `EuLNhXbmtcyuCuiAdjpamWrgEMyucpiqgCkWpSvpb9nY` at `246228986` | 246228980–246228993 |

All runs used a `4 × 250 TGas = 1 PGas` tx envelope. Shared accounts:
`smart-account.x.mike.testnet` and `echo.x.mike.testnet`, both owned
through `mike.testnet` after redeploy with
`new_with_owner(owner_id = "mike.testnet")` at block `246227390`.
Failure runs use `--method not_a_method` to guarantee downstream
`MethodResolveError(MethodNotFound)`.

### 1.1 Downstream echo receipts for the 4-label success run

| Step | Echo receipt | Block |
|---|---|---|
| `beta`  | `DYyN9YYZgkRxDtHKvrPGBgwdiLDp9EE3QiXL3tE5Mbeo` | 246222024 |
| `delta` | `G2BpMPnhQRG5AqHaHyk8gKgnZiTVFfYvhiQvKfEbPHkC` | 246222027 |
| `alpha` | `9NUCWZ9ugMY3DFzCs2HyKgyKzdvJL5W5Fso1Q7rcyHNr` | 246222030 |
| `gamma` | `EGV17EG8BJKpSSmiFZdNoAdrPHgeBcX25CsrsnxqDe3q` | 246222033 |

First real proof of the smart-account sequencer ordering downstream
cross-contract work, not just inert yielded callbacks.

## 2. Saga semantics, empirically closed

Chapter 03 §3 claimed three semantics. Every one is now directly
backed:

| Claim | Run | Direct evidence |
|---|---|---|
| Downstream failure halts the active sequence | dual-failure, retry, mixed | `on_stage_call_settled(beta)` on Err branch at 246227607 / 246228498 / 246228986 |
| Yield timeout auto-drains (~200 blocks → `PromiseError::Failed`) | dual-failure | alpha + gamma + delta `on_stage_call_resume` on Err branch at 246227624 (parallel) |
| Surviving steps remain pending, retry-able in fresh order | retry, mixed | three successive retries drained in 64 blocks; mixed-outcome survivors (gamma, delta) cleanly drained by a second `run_sequence` |

Additionally, `run_sequence` with a multi-step `order` correctly
advances past each **successful** step and stops at the **first
failing** step — it does not skip past a failure to attempt later
steps. Demonstrated in the mixed-outcome run at blocks 246228983
(alpha success → beta resume) and 246228986 (beta failure → halt).

## 3. The three canonical log messages

Each step's termination path produces a distinct log-line shape, so
log-only inspection is enough to reconstruct what happened:

- **Success advance**:
  `stage_call '<step>' for <caller> completed successfully (…)`
- **Downstream-failure halt**:
  `stage_call '<step>' for <caller> failed downstream and stopped the sequence: Failed`
- **Yield-timeout drop**:
  `stage_call '<step>' for <caller> could not resume and was dropped: Failed`

## 4. Canonical cascade shapes

### Successful step — 3 blocks per step

For an advancing step, every cascade tick produces the same five
receipts spread across three blocks:

- **block N**: resume Data + resume Action (`on_stage_call_resume(step)`)
- **block N+1**: downstream Action (e.g., `echo.echo_log`)
- **block N+2**: downstream Data + settle Action (`on_stage_call_settled(step)` on Ok branch)

That 3× block cost per step is the price of the guarantee "A's
downstream fully completes before B's starts." The 4-label success
run's cascade from 246222022 → 246222034 is exactly four of these
slices end to end.

### Downstream-failure halt — same shape, Err branch

Identical receipt shape; the downstream Action returns failure and
`on_stage_call_settled` takes the Err branch, removes the step, and
clears `conduct_order`.

### Yield-timeout drain — one block, N parallel resumes

When NEP-519's 200-block timer fires, every remaining yielded callback
wakes in the same block with `PromiseError::Failed` and removes itself
via `on_stage_call_resume`'s Err branch. The dual-failure run drained
three labels in block `246227624` via six receipts (three Data + three
Action) in parallel.

## 5. Structural observations

### IterableMap swap-remove shuffles pending order

`staged_calls_for` is drained by `on_stage_call_settled`, not by
`on_stage_call_resume`. Visible in the state time-series: the pending
set persists through resume → downstream → settle; removal lands at
settle. Because `IterableMap::remove` uses swap-remove, removed slots
are backfilled by the last entry, so the iteration order of
`staged_calls_for` shuffles as entries drain. Not a bug; worth knowing
if a reader expects stable order.

### Yield-timeout wall-clock is ~100 s on testnet

The NEP-519 ~200-block yield timeout was observed firing ~100 seconds
after batch inclusion on testnet, not the "~4 minutes" earlier
rule-of-thumb. Block times are faster than that benchmark assumed.
Anyone relying on the yield window for retry timing should empirically
confirm rather than trust the old value.

### Retry-race rule: 3 × step_count blocks between `run_sequence` calls

`run_sequence` rejects when `conduct_order[caller].is_some()`. A new
`run_sequence` must land **at least 3 × step_count blocks** after the
previous one — one step per in-flight label, three blocks per step.
The mixed-outcome run squeaked through at exactly 6 blocks (beta halt
at 986, retry #2's contract receipt at 987).

## 6. Contrast — latch catastrophe

The earlier `yield-sequencer::latch` POC (chapter 02) shared the same
protocol-level yield timeout but its callback **ignored** the
`PromiseError` signal. On timeout, latch removed its entry as if the
resume had succeeded, and later `conduct` panicked. The saga-halt runs
above show `stage_call` handling the exact same protocol event
cleanly — state remains consistent with what actually happened:

| Aspect | latch (chapter 02) | stage_call (this archive) |
|---|---|---|
| Callback on `PromiseError` | ignored | matched on Err |
| Pending entry on timeout | removed as if success | removed and logged as a drop |
| Queue state on timeout | consistent with a success that never happened | consistent with failure |
| Later retry attempt | panicked (`label 'x' not latched`) | no-op (entry already gone, for the right reason) |

The protocol-level behaviour is identical; the difference is entirely
in how the contract handles the signal.

## 7. Canonical recipes

All runs above were produced with:

```bash
# successful cascade
./scripts/send-staged-echo-demo.mjs \
  alpha:1 beta:2 gamma:3 delta:4 \
  --action-gas 250 --call-gas 30 \
  --sequence-order beta,delta,alpha,gamma

# all-failure cascade (retry experiments)
./scripts/send-staged-echo-demo.mjs \
  alpha:1 beta:2 gamma:3 \
  --action-gas 250 --call-gas 30 \
  --method not_a_method \
  --sequence-order beta,alpha,gamma &

# mixed-outcome cascade
./scripts/send-staged-mixed-demo.mjs \
  alpha:1 beta:2 gamma:3 delta:4 \
  --method echo_log --fail-labels beta \
  --action-gas 250 --call-gas 30 \
  --sequence-order alpha,beta,gamma,delta
```

State time-series and per-block receipts at any cascade block:

```bash
./scripts/state.mjs smart-account.x.mike.testnet \
  --block <h> --method staged_calls_for \
  --args '{"caller_id":"mike.testnet"}'

./scripts/block-window.mjs --block <h> --with-receipts --with-transactions
```

## 8. Operator notes preserved from source

- `near.testnet` RPC returns 408 Timeout on `EXPERIMENTAL_tx_status`
  when yielded children are still pending. Trace *after* finalization
- near-api-js's default wait mode blocks the client until all yielded
  children settle. If you need `run_sequence` inside the yield window,
  submit the batch in the background (`run_in_background: true`) and
  fetch the hash via `scripts/account-history.mjs`
- `new_with_owner(owner_id = $MASTER)` makes the deploy parent call
  `run_sequence` directly as owner, removing the need for an explicit
  `set_authorized_executor` step
- mainnet gas-shape matrix (why `300 TGas` per action is the multi-step
  floor, why `250 TGas` auto-resume-fails) lives in `CLAUDE.md` under
  "Mainnet lab rig"

## 9. Methodology pointer

The three-surfaces inspection method (receipt DAG, contract state
time-series, per-block receipts) used to produce every table above is
documented in [chapter 04](./04-three-surfaces-observability.md). That
chapter's latch cascade is the canonical worked example; the tables in
this archive apply the same method to the stage_call cascade.
