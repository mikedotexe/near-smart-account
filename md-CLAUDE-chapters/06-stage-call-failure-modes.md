# 06 · `stage_call` failure-mode validation

Historical terminology note: this chapter records an earlier stage of the
smart-account surface and still says `label` in some tables and log discussion.
Current docs prefer `step`.

**BLUF.** A single failure-mode experiment on the renamed smart-account
(`stage_call` / `run_sequence` / `on_stage_call_settled`) surfaced **both**
of chapter 03 §3's claimed failure paths in one transaction — the
downstream-failure halt *and* the yield-timeout auto-cleanup — and both
behaved exactly as claimed. The contract has no orphan-state path on
failure: everything eventually drains to `[]`. This is the direct
counterpoint to chapter 02 §5's `latch` timeout catastrophe.

Two empirical facts worth carrying forward:

1. **When a downstream call fails, `on_stage_call_settled` cleanly removes
   the label and halts the active sequence.** Demonstrated by the log line
   `stage_call 'beta' for mike.testnet failed downstream and stopped the
   sequence: Failed`, paired with beta vanishing from `staged_calls_for`
   at exactly the block `on_stage_call_settled` ran.
2. **NEP-519's 200-block yield timeout fires in parallel for every
   unresolved callback**, each wakes `on_stage_call_resume` with
   `PromiseError::Failed`, and the callback's `Err` branch removes the
   pending entry. Three parallel labels drained in a single block on
   expiry — no stragglers, no catastrophe.

---

## 1. Reference run

Contract was redeployed with the renamed methods at block `246227390` via
`new_with_owner(owner_id="mike.testnet")` so `mike.testnet` could call
`run_sequence` as owner without needing `set_authorized_executor`.

| Artifact | Value |
|---|---|
| Deploy tx | `6S7rqLpRPwJNogkn9zkQYDKCxCud286pagPyUxnum9o2` at block `246227390` |
| Funding top-up (new wasm is ~264 KB) | `HVy8C2s8wvWveapTHoExoeDrFdXpivreEAYHuFSVFPTy` — 5 NEAR from `x.mike.testnet` |
| Batch tx (4 × `stage_call` @ 250 TGas, all targeting `echo.x.mike.testnet.not_a_method`) | `HbjJ1V61jqEjgz3P2XkQtueFUhZRNUG197mmXzriMXN9` at block `246227422` |
| `run_sequence` tx (`order = [beta, delta, alpha, gamma]`) | `9At6bdLMzW41MoKon1dXdHJhYMuVJ8NmsbzFiXNkJXqM` at block `246227603` |

The `--method not_a_method` flag is the entire trick: each `stage_call`
registers a pending downstream `FunctionCall` pointed at a method that
does not exist on echo, so the downstream is guaranteed to fail with
`MethodResolveError(MethodNotFound)` when it finally dispatches.

`run_sequence` landed at block `246227603` — **181 blocks after the
batch**, which turns out to matter: the NEP-519 yield expiry (~200
blocks) fires in this window, so the labels that `run_sequence` does not
get to before it halts end up draining through the timeout path instead.
Both code paths fire in the same transaction. That was unintended but
extremely informative.

## 2. The plot

The plan was to validate only the **downstream-failure** path: conduct
beta first, let its downstream `not_a_method` receipt fail, watch
`on_stage_call_settled` halt the sequence and leave alpha / gamma / delta
still pending for a retry.

What actually happened:

- `run_sequence` resumed beta (per declared order `[beta, delta, alpha, gamma]`).
- beta's downstream echo call failed with `MethodResolveError(MethodNotFound)`
  at block `246227606`.
- `on_stage_call_settled(beta)` at block `246227607` saw the downstream
  failure, removed beta, cleared `conduct_order`, logged `failed
  downstream and stopped the sequence: Failed`. **Halt worked exactly as
  claimed.**
- alpha / gamma / delta were left pending with no active sequence.
- 18 blocks later, NEP-519's ~200-block timer on each yielded callback
  expired and the protocol auto-resumed all three with
  `PromiseError::Failed` at blocks `246227624` / `246227625`.
- `on_stage_call_resume` for each saw the `Err` and took the chapter 03
  §3 "drop and clear" branch: removed its pending entry, logged `could
  not resume and was dropped: Failed`.

So instead of a one-path experiment, we got a two-path experiment in a
single tx tree. The trace and state time-series below show both.

## 3. Surface 2 — state time-series

`scripts/state.mjs smart-account.x.mike.testnet --block <h> --method staged_calls_for --args '{"caller_id":"mike.testnet"}'`

| Block | `staged_calls_for` labels | What just happened |
|---|---|---|
| 246227422 | `[]` | batch tx included; contract receipt not yet executed |
| 246227423 | `[alpha, beta, gamma, delta]` | batch receipt runs; four yielded callbacks allocated |
| 246227500 | `[alpha, beta, gamma, delta]` | idle wait (~78 blocks) |
| 246227603 | `[alpha, beta, gamma, delta]` | `run_sequence` tx included |
| 246227604 | `[alpha, beta, gamma, delta]` | `run_sequence` contract receipt runs; schedules beta's resume |
| 246227605 | `[alpha, beta, gamma, delta]` | beta's `on_stage_call_resume` runs; dispatches downstream + settle |
| 246227606 | `[alpha, beta, gamma, delta]` | beta's downstream `echo.not_a_method` executes and **fails** |
| 246227607 | `[alpha, delta, gamma]` | **beta's `on_stage_call_settled` sees `Err`, removes beta, halts the sequence.** Swap-remove moved delta into beta's slot |
| 246227610 | `[alpha, delta, gamma]` | steady — no active sequence, timers counting |
| 246227620 | `[alpha, delta, gamma]` | still steady |
| 246227625 | `[]` | **200-block yield timeout fires for alpha, gamma, delta in parallel** — `on_stage_call_resume` sees `PromiseError::Failed` for each and removes them |
| 246227700 | `[]` | steady state |

Two visually distinct drain events in one chart:

- the single-label removal at **block 607** is the saga-halt path
- the three-label-at-once removal at **block 625** is the yield-timeout path

Both are triggered by `PromiseError` / downstream failure, but they enter
the contract through different callbacks:

- `on_stage_call_settled(beta)` runs because `run_sequence` resumed
  beta's `on_stage_call_resume`, which dispatched the downstream +
  settle; the settle got the downstream's failed result as its
  `promise_result`.
- `on_stage_call_resume(alpha/gamma/delta)` runs because NEP-519 itself
  decided these yields were expired; it fired them with
  `Result::Err(PromiseError::Failed)` as the `#[callback_result]`.

Different entry points, equivalent behaviour, converging state.

## 4. Surface 3 — per-block receipts at the pivotal blocks

`scripts/block-window.mjs --block <h> --with-receipts --with-transactions`

### 4.1 The saga halt — blocks 603 → 607

| Block | Receipt | Predecessor → Receiver | Type | Note |
|---|---|---|---|---|
| 246227603 | — | — | — | `run_sequence` tx included (no receipts yet) |
| 246227604 | `7CpnaZ…S3ax` | mike.testnet → smart-account | Action | `run_sequence` contract receipt |
| 246227605 | `7YiVbm…87gs` | smart-account → smart-account | Data | resume payload for beta |
| 246227605 | `CBeTXx…qUZT` | smart-account → smart-account | Action | `on_stage_call_resume(beta)` — dispatches downstream + settle |
| 246227606 | `FfBbiG…A2jQ` | smart-account → **echo** | Action | `echo.not_a_method` — **success=false**, `MethodResolveError(MethodNotFound)` |
| 246227607 | `Gwczmv…s9BN` | echo → smart-account | Data | downstream failure surfaced to smart-account |
| 246227607 | `7Qhkhm…HwK7` | smart-account → smart-account | Action | **`on_stage_call_settled(beta)` — sees `Err`, removes beta, clears queue** |

### 4.2 The yield timeout — blocks 624 → 625

| Block | Receipt | Predecessor → Receiver | Type | Note |
|---|---|---|---|---|
| 246227623 | — | — | — | empty block; timeout timers about to fire |
| 246227624 | `4HDNPj…uHEs` | smart-account → smart-account | Data | system-injected resume payload for alpha |
| 246227624 | `E1Wi1y…W99J` | smart-account → smart-account | Action | `on_stage_call_resume(alpha)` — sees `Err`, drops |
| 246227624 | `Eqd65m…x7ji` | smart-account → smart-account | Data | system-injected resume payload for gamma |
| 246227624 | `3Y9fPm…ZPNW` | smart-account → smart-account | Action | `on_stage_call_resume(gamma)` — sees `Err`, drops |
| 246227624 | `Gcrjx4…sFdw` | smart-account → smart-account | Data | system-injected resume payload for delta |
| 246227624 | `CPonSH…NoTH` | smart-account → smart-account | Action | `on_stage_call_resume(delta)` — sees `Err`, drops |
| 246227625 | 3 `system → mike.testnet` refund receipts | — | Action | residual gas refunds |

Block `246227624` is the protocol firing **six receipts in parallel** for
three timed-out yields — three Data receipts (one resume payload per
label) plus three Action receipts (one callback per label). All three
drop their pending entries in one block.

## 5. Surface 1 — the receipt DAG tells both stories

`scripts/trace-tx.mjs HbjJ1V61jqEjgz3P2XkQtueFUhZRNUG197mmXzriMXN9 mike.testnet --wait FINAL`

Key log lines extracted from the tree:

```
log: stage_call 'beta' resumed for mike.testnet -> echo.x.mike.testnet.not_a_method memo=None
log: stage_call 'beta' for mike.testnet failed downstream and stopped the sequence: Failed

log: stage_call 'alpha' for mike.testnet could not resume and was dropped: Failed
log: stage_call 'gamma' for mike.testnet could not resume and was dropped: Failed
log: stage_call 'delta' for mike.testnet could not resume and was dropped: Failed
```

The log message for beta is the saga-halt message; the log messages for
alpha / gamma / delta are the timeout-drop message. The contract itself
is saying which path each label took.

## 6. Contrast — chapter 02 §5 latch catastrophe

Chapter 02 §5 described the broken behaviour of the earlier `latch` POC
under the same timeout condition:

> `on_latch_resume` ignored `#[callback_result] _sig: Result<ResumeSignal, PromiseError>`
> ... the callback still removed the latch entry and returned the label as
> though the resume had been intentional ... then a later `conduct`
> failed because the latch was already gone.

That is the exact same protocol behaviour NEP-519 triggers here — the
~200-block timeout fires and the yielded callback wakes with
`PromiseError::Failed`. The difference is entirely in the contract's
handling:

| | chapter 02 `latch` | chapter 06 `stage_call` |
|---|---|---|
| Callback sees `PromiseError` | ignored | matched on `Err` |
| Pending entry on timeout | removed as if success | removed, but logged as a drop |
| Queue state on timeout | consistent with "success" | consistent with "failure" |
| Later retry attempt | panics (`label 'x' not latched`) | no-op (entry already gone, but now for the right reason) |

The chapter 02 catastrophe wasn't that state got weird; it was that state
looked consistent with a success the contract had not actually performed.
With `stage_call` we know at any point in time which labels completed
versus were dropped, because the contract records the distinction.

## 7. What the saga semantic now looks like

The claim in chapter 03 §3 has become an empirical result:

> if the yielded callback wakes up with `PromiseError`, the pending call
> is dropped and the active conduct queue is cleared

> if the downstream `FunctionCall` fails, the current call is removed and
> the active conduct queue is cleared

Both are demonstrated by this run:

- "yielded callback wakes with `PromiseError`" → alpha / gamma / delta on
  timeout; drop-and-clear path in `on_stage_call_resume`.
- "downstream `FunctionCall` fails" → beta; drop-and-halt path in
  `on_stage_call_settled`.

The missing chapter-03 claim — "later labels remain pending and can be
conducted again in a fresh order" — was *not* directly demonstrated here
because the timeout fired before we could issue a second `run_sequence`.
A future run that conducts a shorter batch and issues a second
`run_sequence` within ~200 blocks of the original batch would close that
last corner of the saga story. Noting for the next tranche.

## 8. Pragmatic notes for the next experiment

- The ~200-block yield timeout is **~100 seconds** on testnet, not
  "~4 minutes" as CLAUDE.md says. Block times are faster than that
  benchmark assumed. Anyone relying on a yield window should empirically
  confirm rather than trust the rule-of-thumb.
- `near.testnet` RPC returned 408 Timeout when we tried
  `EXPERIMENTAL_tx_status` on the live batch while yielded children were
  still pending. The RPC server has its own timeout ceiling separate
  from the yield timeout. Trace *after* the tx finalizes, or trace a
  past tx where everything has settled.
- A batch submitted with the default near-api-js wait mode blocks the
  client until all yielded children settle. If the test requires
  `run_sequence` to happen *inside* that window, submit in the
  background (`run_in_background: true`) and fetch the tx hash via
  `scripts/account-history.mjs <signer> --limit 1` a few seconds later.
- Mike.testnet became the owner via `new_with_owner(owner_id="mike.testnet")`
  so no `set_authorized_executor` was required — owner is implicitly
  authorized. Consider making this the default deploy pattern.

## 9. Recipes

```bash
# batch (will block on FINAL); run in background so we can run_sequence inside the yield window
./scripts/send-staged-echo-demo.mjs \
  alpha:1 beta:2 gamma:3 delta:4 \
  --action-gas 250 --call-gas 30 \
  --method not_a_method \
  --sequence-order beta,delta,alpha,gamma &
BATCH_PID=$!

# wait for batch inclusion, then fetch its hash
sleep 8
./scripts/account-history.mjs mike.testnet --limit 1

# conduct within ~100 s of the batch receipt or the yields will time out first
near call smart-account.x.mike.testnet run_sequence \
  '{"caller_id":"mike.testnet","order":["beta","delta","alpha","gamma"]}' \
  --accountId mike.testnet

# watch the dual drain
for b in 246227423 246227500 246227604 246227607 246227620 246227625 246227700; do
  printf "block %s: " "$b"
  ./scripts/state.mjs smart-account.x.mike.testnet --block "$b" \
    --method staged_calls_for --args '{"caller_id":"mike.testnet"}'
done

# per-block receipts at the saga halt
./scripts/block-window.mjs --block 246227607 --with-receipts --with-transactions
# per-block receipts at the timeout auto-drain
./scripts/block-window.mjs --block 246227624 --with-receipts --with-transactions

# the full tree with both paths
./scripts/trace-tx.mjs HbjJ1V61jqEjgz3P2XkQtueFUhZRNUG197mmXzriMXN9 mike.testnet --wait FINAL
```

Every table in this chapter was generated by those commands against the
live testnet rig. Like chapter 05, the tables are the running log — block
numbers and receipt hashes, preserved so the cascade can be walked
block-by-block by a future reader.
