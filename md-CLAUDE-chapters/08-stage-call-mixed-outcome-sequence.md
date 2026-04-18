# 08 · `stage_call` mixed-outcome sequence — halt inside a multi-label run

**BLUF.** Chapter 07 proved the retry mechanism using three single-label
`run_sequence` calls against an all-failing batch. Chapter 08 closes the
last open corner of the saga semantic: a **single** `run_sequence`
carries a mixed order where **alpha succeeds** (advancing the sequence),
**beta halts** (downstream failure), and **gamma + delta are left
pending** for a follow-up `run_sequence` that completes them cleanly.
This is the full picture — sequencing, halt, and retry composed in one
observed run.

Two qualitative findings:

1. `run_sequence` with order `[alpha, beta, gamma, delta]` correctly
   advanced past the **successful** alpha step and stopped at the
   **failing** beta step — it did **not** skip past beta's failure to
   attempt gamma or delta. Failure halts the sequence; it does not just
   drop the failed label and continue.
2. A second `run_sequence` issued six blocks after the first (while the
   first's cascade was still mid-flight) was accepted because the
   contract's `assert_no_conduct_in_flight` cleared the moment beta's
   settle landed. The timing is tight but sound.

## 1. Mental-model continuation

Chapter 07 introduced the orbital metaphor. Chapter 08 is the
compound-pass version: one ground-station call retrieves two satellites
(alpha successfully, beta with a satellite that disintegrates on
retrieval and aborts the retrieval chain); a second pass retrieves the
remaining two (gamma, delta) cleanly. The contract sphere is the
retrieval controller; the orbits outlive the first pass and are
available on the second.

## 2. Reference run

| Artifact | Value | Block |
|---|---|---|
| Mixed batch (alpha/gamma/delta = `echo_log`, beta = `not_a_method`) | `9uEY27DFH1KCvsG7xsBAzAmE78ZgzJ5MwPy3TwCUULCh` | `246228934` |
| `run_sequence` #1 (`order = [alpha, beta, gamma, delta]`) | `8ke5F4wFuidxDvM1MEZ16neyf6BC1QsdehypEDPJaQxz` | `246228979` |
| `run_sequence` #2 (`order = [gamma, delta]`) | `EuLNhXbmtcyuCuiAdjpamWrgEMyucpiqgCkWpSvpb9nY` | `246228986` |
| All cascades settled by | — | `246228993` |
| Yield timeout would have fired at | ~ | `246229135` (935 + 200) |

Elapsed: **59 blocks ≈ 30 s** batch-to-empty. Remaining yield-window
margin: **142 blocks ≈ 71 s**.

The mixed batch is assembled by a new helper,
`scripts/send-staged-mixed-demo.mjs`, which extends the staged-echo
pattern with a `--fail-labels <list>` flag. Labels in that list target
`--fail-method` (default `not_a_method`); all others target `--method`
(default `echo_log`).

## 3. Surface 2 — state time-series across the mixed cascade

`scripts/state.mjs smart-account.x.mike.testnet --block <h> --method staged_calls_for --args '{"caller_id":"mike.testnet"}'`

| Block | `staged_calls_for` labels | What just happened |
|---|---|---|
| 246228934 | `[]` | batch tx included; contract receipt pending |
| 246228935 | `[alpha, beta, gamma, delta]` | batch receipt runs; 4 yielded callbacks allocated |
| 246228979 | `[alpha, beta, gamma, delta]` | `run_sequence` #1 tx included |
| 246228980 | `[alpha, beta, gamma, delta]` | `run_sequence` #1 contract receipt runs; conduct_order = `[beta, gamma, delta]`; alpha resumed |
| 246228981 | `[alpha, beta, gamma, delta]` | alpha's `on_stage_call_resume`; dispatches downstream + settle |
| 246228982 | `[alpha, beta, gamma, delta]` | alpha's downstream `echo_log` runs — **success** |
| 246228983 | `[delta, beta, gamma]` | **alpha's `on_stage_call_settled` runs the Ok branch: removes alpha, pops `beta` from queue, resumes beta.** Swap-remove put delta into alpha's slot |
| 246228984 | `[delta, beta, gamma]` | beta's `on_stage_call_resume`; dispatches downstream + settle |
| 246228985 | `[delta, beta, gamma]` | beta's downstream `echo.not_a_method` — **failure** |
| 246228986 | `[delta, gamma]` | **beta's `on_stage_call_settled` runs the Err branch: removes beta, clears conduct_order, halts.** `run_sequence` #2 tx included in the same block |
| 246228987 | `[delta, gamma]` | `run_sequence` #2 contract receipt runs; conduct_order = `[delta]`; gamma resumed |
| 246228988 | `[delta, gamma]` | gamma's resume; dispatches downstream + settle |
| 246228989 | `[delta, gamma]` | gamma's downstream `echo_log` — **success** |
| 246228990 | `[delta]` | gamma's settled Ok: removes gamma, pops delta, resumes delta |
| 246228991 | `[delta]` | delta's resume |
| 246228992 | `[delta]` | delta's downstream `echo_log` — **success** |
| 246228993 | `[]` | delta's settled Ok; conduct_order empty; cascade complete |

Four labels, three removal mechanisms on display:

- **alpha, gamma, delta** — removed by `on_stage_call_settled` taking the
  Ok branch, advancing the sequence
- **beta** — removed by `on_stage_call_settled` taking the Err branch,
  halting the sequence

The only removal mechanism *not* observed in this run is the timeout
path (chapter 06 §3.2). By the time the cascade fully drained at block
993, the yield window had 142 blocks of margin remaining — no yield
ever decayed.

## 4. Surface 3 — per-block receipt detail at the two key transitions

### 4.1 Alpha succeeds, sequence advances — blocks 981–983

| Block | Receipt | Pred → Receiver | Type | Note |
|---|---|---|---|---|
| 246228981 | `4BnSv5…6ABr` | smart-account → smart-account | Data | resume payload for alpha |
| 246228981 | `AGavrK…t7x9` | smart-account → smart-account | Action | `on_stage_call_resume(alpha)` — dispatches downstream + settle |
| 246228982 | `DfmbeM…EGn9` | smart-account → **echo** | Action | `echo.echo_log({"n":1})` — **success=true** |
| 246228983 | `GGH2kP…ShwR` | echo → smart-account | Data | `echo_log` return value |
| 246228983 | `6qGbLY…of5T` | smart-account → smart-account | Action | **`on_stage_call_settled(alpha)` — Ok branch; pops beta from queue; resumes beta** |

### 4.2 Beta fails, sequence halts — blocks 984–986

| Block | Receipt | Pred → Receiver | Type | Note |
|---|---|---|---|---|
| 246228984 | `GMQtdr…saPC` | smart-account → smart-account | Data | resume payload for beta |
| 246228984 | `5cQRRr…7PXH` | smart-account → smart-account | Action | `on_stage_call_resume(beta)` |
| 246228985 | `2ENtrm…MLGN` | smart-account → **echo** | Action | `echo.not_a_method({"n":2})` — **success=false** |
| 246228986 | `BpRTpL…PTiv` | echo → smart-account | Data | downstream failure surfaced |
| 246228986 | `Gny4ZK…VVKK` | smart-account → smart-account | Action | **`on_stage_call_settled(beta)` — Err branch; removes beta; clears queue; halts** |
| 246228986 | — | — | Tx | **run_sequence #2 tx included in the *same* block as beta's settle** |

The adjacency at block 986 is the interesting pragmatic signal: the
halt and the retry cleared / reused the same `conduct_order` slot with
one block of separation (halt at 986, #2's contract receipt at 987).

### 4.3 Retry cascade — blocks 988–993

Gamma's cascade at 988–990 and delta's at 991–993 have the same
resume-Data / resume-Action / downstream-Action (success) /
settle-Data / settle-Action shape documented in chapter 05 §3.
Nothing new — but they confirm that the second `run_sequence` executes
a full success cascade starting from a half-drained state.

## 5. Surface 1 — log lines from the batch tx tree

`scripts/trace-tx.mjs 9uEY27DFH1KCvsG7xsBAzAmE78ZgzJ5MwPy3TwCUULCh mike.testnet --wait FINAL`

Key log messages in execution order:

```
log: stage_call 'alpha' resumed for mike.testnet -> echo.x.mike.testnet.echo_log memo=None
log: stage_call 'alpha' for mike.testnet completed successfully (...)

log: stage_call 'beta' resumed for mike.testnet -> echo.x.mike.testnet.not_a_method memo=None
log: stage_call 'beta' for mike.testnet failed downstream and stopped the sequence: Failed

log: stage_call 'gamma' resumed for mike.testnet -> echo.x.mike.testnet.echo_log memo=None
log: stage_call 'gamma' for mike.testnet completed successfully (...)

log: stage_call 'delta' resumed for mike.testnet -> echo.x.mike.testnet.echo_log memo=None
log: stage_call 'delta' for mike.testnet completed successfully (...)
```

Three "completed successfully" messages, one "failed downstream and
stopped the sequence" — the contract narrates each label's fate in its
own logs. This is already enough evidence to reconstruct what happened
without ever looking at state.

## 6. Timing nuance — the retry race

`run_sequence` #1 was a `near call`, which returns once its own tx
finalizes (not when the cascade completes). #1's tx finalized around
block 980, and #2 was fired immediately after. #2's tx landed at
block 986 — **the same block beta's halt cleared `conduct_order`**.

`run_sequence` rejects when `conduct_order[caller].is_some()`. #2's
contract receipt did not run until block 987, so it saw the cleared
slot and succeeded. Had #2 been issued a few blocks earlier — during
alpha's or beta's cascade — it would have panicked with *caller
already has a pending conduct in flight*.

Operational rule-of-thumb: wait at least **3 × `step_count` blocks**
(one step per in-flight label, 3 blocks per step) after the previous
`run_sequence` before firing the next. For this run that's
3 × 2 = 6 blocks; we squeaked through at exactly 6 blocks.

## 7. The saga semantic is now empirically closed

Between chapters 05–08:

| Scenario | Chapter | Evidence |
|---|---|---|
| Successful in-order cascade | 05 | Codex's 4-label success run |
| Downstream failure halts the sequence | 06 | beta at block 246227607 |
| Yield timeout auto-drains unresolved labels | 06 | alpha/gamma/delta at block 246227624 |
| Survivors retry-able after halt (single-label retries) | 07 | three successive retries |
| Mixed success + halt within a single `run_sequence` | 08 | alpha OK → beta halt |
| Retry after mid-sequence halt (multi-label retry) | 08 | gamma + delta retrieved cleanly |

What chapter 08 does not yet cover, and remains as a potential future
tranche:

- the **`gated_call_finished` / `on_stage_call_settled` compensation
  hook** a classical saga would include — we do nothing to undo alpha
  when beta fails. Today's semantic is "halt and leave, do not unwind."
  Adding compensation is a contract change, not an experiment.
- **cross-caller isolation** — two distinct callers with the same label
  names. Chapter 03 §1 claims caller-id-prefixed keys isolate them, but
  no live run has verified.
- **positive-path retries without failure in between** — we've
  repeatedly tested halt-then-retry but not "two separate
  `run_sequence` calls on the same pending set, both successful." This
  is a minor semantic detail.

## 8. Recipes

```bash
# mixed batch: one deliberate-failure label among successes
./scripts/send-staged-mixed-demo.mjs \
  alpha:1 beta:2 gamma:3 delta:4 \
  --method echo_log --fail-labels beta \
  --action-gas 250 --call-gas 30 \
  --sequence-order alpha,beta,gamma,delta &
sleep 8
./scripts/account-history.mjs mike.testnet --limit 1

# first run_sequence: expect alpha OK, beta halt, gamma+delta remain
near call smart-account.x.mike.testnet run_sequence \
  '{"caller_id":"mike.testnet","order":["alpha","beta","gamma","delta"]}' \
  --accountId mike.testnet

# ≥ 6 blocks later, retry the remaining labels
near call smart-account.x.mike.testnet run_sequence \
  '{"caller_id":"mike.testnet","order":["gamma","delta"]}' \
  --accountId mike.testnet

# verify the drain
for b in 246228935 246228983 246228986 246228990 246228993; do
  printf "block %s: " "$b"
  ./scripts/state.mjs smart-account.x.mike.testnet --block "$b" \
    --method staged_calls_for --args '{"caller_id":"mike.testnet"}'
done
```

One new companion script (`send-staged-mixed-demo.mjs`) unlocks every
mixed experiment going forward; everything else used the already-canonical
toolkit.
