# Chapter 20 — Pathological contract probe

> **In today's vocabulary.** This chapter maps out the pathology
> taxonomy that `Direct` alone cannot catch. It motivates chapter 21
> (`Asserted`), which closes the Layer-3 blindspot for noop and decoy
> shapes by letting the kernel itself fire a postcheck inline. The
> probe contract (`pathological-router`) is still deployed in the
> shared testnet rig and is the canonical target for "what can
> `Direct` miss?" investigations. Surface names below (`yield_promise`,
> `on_promise_resolved`) map to today's `register_step` /
> `on_step_resolved`; the receipt-classification semantics are
> identical.

## §1 Motivation

Chapters 14–15 named the "dishonest async" risk and built one concrete
instance — `wild-router.route_echo_fire_and_forget` — plus an adapter
(`demo-adapter.adapt_fire_and_forget_route_echo`) that compensates via
state polling. Chapter 15 also enumerated four failure shapes against
real `wrap.testnet` methods and showed they all collapse to
`PromiseError::Failed` at `on_promise_resolved`.

But the taxonomy of what a "contract in the wild" can do is wider than
one fire-and-forget and four deserialization/assertion failures. This
chapter builds small probe targets for four distinct pathologies and
records what each produces across the three detection layers we care
about:

- **Layer 1 — NEAR receipt classification.** `trace-rpc.mjs`'s `classify()`
  walks the receipt DAG and tags it `FULL_SUCCESS` / `PARTIAL_FAIL` /
  `PENDING` / `HARD_FAIL`. This catches receipts that the runtime itself
  marks as `Failure`.
- **Layer 2 — smart-account log interpretation.** `on_promise_resolved`
  emits one of two log lines: "settled successfully … sequence
  completed/continuing" or "failed downstream … ordered release stopped
  here: {error:?}". This reflects what Direct policy DECIDED about the
  downstream.
- **Layer 3 — target state comparison.** The `pathological-router` crate
  increments `calls_completed` only inside its one honest method; every
  pathological method leaves it at its pre-call value. An external
  observer (or a future v1.1 adapter) polling that counter can
  distinguish "work claimed" from "work done."

The four pathologies each live at a different intersection of those
three layers, and the cross-table in §5 is what makes chapter 20 useful
to future adapter design.

## §2 The `pathological-router` crate

A new contract at `contracts/pathological-router/src/lib.rs`, deployed
as `pathological-router.x.mike.testnet` in the shared rig. State fields:

```rust
pub calls_completed: u32,         // incremented ONLY by do_honest_work
pub last_burst: Option<String>,   // set by do_honest_work + return_decoy_promise
```

Views: `get_calls_completed() -> u32`, `get_last_burst() -> Option<String>`.

### Baseline method — `do_honest_work(label: String) -> String`

Increments `calls_completed`, sets `last_burst = Some(label)`, returns
`format!("completed:{label}")`. The control probe.

### Pathology 1 — `burn_gas()` (gas-exhaustion)

```rust
pub fn burn_gas(&self) {
    let mut seed: [u8; 32] = [0; 32];
    loop { seed = env::sha256_array(&seed); }
}
```

Each `sha256_array` call is a real host-function cost. The loop exits
only when the runtime aborts with `GasExceeded`.

### Pathology 2 — `noop_claim_success(label: String) -> String`

```rust
pub fn noop_claim_success(&self, label: String) -> String {
    env::log_str(&format!("pathological-router: noop_claim_success({label}); skipping real work"));
    "ok".to_string()
}
```

Strictly `&self` — no state mutation, no promise, pure lie. Returns
`"ok"` as SuccessValue.

### Pathology 3 — `return_decoy_promise(callee: AccountId) -> Promise`

```rust
pub fn return_decoy_promise(&mut self, callee: AccountId) -> Promise {
    self.last_burst = Some("decoy-returned".to_string());
    ext_echo::ext(callee.clone()).with_static_gas(GAS_DETACHED_REAL).echo(42).detach();
    ext_echo::ext(callee).with_static_gas(GAS_DECOY).echo(0)
}
```

Detaches `echo(42)` as the "real" work; returns a separate Promise to
`echo(0)` as decoy. Smart-account's `.then(on_promise_resolved)`
chains on the decoy.

### Pathology 4 — `return_oversized_payload(kb: u32) -> String`

```rust
pub fn return_oversized_payload(&self, kb: u32) -> String {
    "x".repeat((kb as usize) * 1024)
}
```

Returns a JSON-encoded string of size `kb * 1024` bytes plus the two
surrounding quote bytes. Probe value is `kb=20`, so the wire payload is
20482 bytes — comfortably past the 16 KiB `MAX_CALLBACK_RESULT_BYTES`
ceiling in `on_promise_resolved`.

## §3 Probe method

Each probe was invoked against a fresh `sa-probe.x.mike.testnet`
(owner=`x.mike.testnet`, authorized_executor=`mike.testnet`) using
`scripts/probe-pathological.mjs`, which yields + releases in one
process — the yield tx uses `waitUntil: "INCLUDED"` so the script
doesn't block on the full yield cascade before firing run_sequence.

```bash
./scripts/probe-pathological.mjs baseline do_honest_work '{"label":"baseline"}' 100
./scripts/probe-pathological.mjs burn2    burn_gas                 '{}'                                150
./scripts/probe-pathological.mjs noop2    noop_claim_success       '{"label":"probe"}'                 100
./scripts/probe-pathological.mjs decoy    return_decoy_promise     '{"callee":"echo.x.mike.testnet"}'  100
./scripts/probe-pathological.mjs oversize return_oversized_payload '{"kb":20}'                         100
```

(Burn uses inner 150 TGas rather than 250 because the 250 TGas outer
action budget must also cover the ~50 TGas overhead for
`on_promise_resumed` and `on_promise_resolved`; inner+overhead must
fit in the outer reserve.)

Each probe's full three-surfaces report lives at
`collab/artifacts/investigate-path-<name>.json`, produced via
`scripts/investigate-tx.mjs <stage_tx_hash> mike.testnet --wait FINAL
--view '{"account":"pathological-router.x.mike.testnet","method":"get_calls_completed","args":{}}'
--view '{"account":"pathological-router.x.mike.testnet","method":"get_last_burst","args":{}}'
--format json --out collab/artifacts/investigate-path-<name>`.

The tx chosen for investigation is the YIELD tx — it's the one whose
receipt tree hosts the yielded resume callback + downstream call +
resolve callback cascade. The run_sequence tx only shows the resume
trigger action; its cascade is a single `SuccessValue` receipt.

## §4 Per-pathology probes

### §4.0 Baseline — `do_honest_work("baseline")`

- yield tx: `5EnfXYMJMzSBxsRn53osGHdFaBzoUJi8W54ZYcdVuGQn`
- run_sequence tx: `6oBxaBYQ92kUfFwZz9qGiH9n84doZiyjatrLRXiFh3it`
- artifact: `collab/artifacts/investigate-path-baseline.json`
- classification: `FULL_SUCCESS`
- gas_burnt (yield tx): 317 TGas
- cascade window: blocks 246336531..246336544 (14 blocks)
- state before → after: `calls_completed: 0 → 1`, `last_burst: null → "baseline"`
- resolve log: `settled successfully via direct pathological-router.x.mike.testnet.do_honest_work (20 result bytes); sequence completed`

All three layers agree. This is what a well-behaved call looks like.
Every other probe is read against this shape.

### §4.1 Pathology 1 — `burn_gas`

- yield tx: `FEa5Cuie2F6knyLEQ8AEJHySNUfd7zdcX2veaPrzkn6Y`
- run_sequence tx: `GeQn3Ltv7ELmjm5GFxkQhWugUPB7NdTCc6DoZjcThCy7`
- artifact: `collab/artifacts/investigate-path-burn.json`
- classification: `PARTIAL_FAIL`
- gas_burnt (yield tx): 315 TGas
- cascade window: blocks 246337252..246337265 (14 blocks)
- state before → after: unchanged (`calls_completed: 1 → 1`, `last_burst` unchanged)
- downstream outcome: `Failure @pathological-router FunctionCall(burn_gas) ⇒ ExecutionError: "Exceeded the prepaid gas."`
- resolve log: `failed downstream via direct pathological-router.x.mike.testnet.burn_gas; ordered release stopped here: Failed`

Observation: gas exhaustion is caught at Layer 1 (the runtime marks the
burn_gas receipt as Failure) AND at Layer 2 (resolve sees
`Err(PromiseError::Failed)` and halts). Layer 3 correctly reports "no
work done." **All three layers converge on failure** — but the
smart-account has no way to distinguish "malicious gas burn" from
"honest panic" because both collapse to the same `PromiseError::Failed`
variant at resolve. The gas usage is observable (~315 TGas for this
probe), but that's only visible by examining the downstream receipt's
`gas_burnt` after the fact, not by the kernel's `Direct` predicate.

### §4.2 Pathology 2 — `noop_claim_success`

- yield tx: `9GFisTDnuMvMsN28NHqxJvUAC3eVw9QB7G35FPaghQej`
- run_sequence tx: `J6rnE1SKzpZZ1ywRUyEwbGCDnYBz9YAoa7h1DXDTJM2D`
- artifact: `collab/artifacts/investigate-path-noop.json`
- classification: `FULL_SUCCESS`
- gas_burnt (yield tx): 317 TGas
- cascade window: blocks 246337268..246337280 (13 blocks)
- state before → after: unchanged (`calls_completed: 1 → 1`, `last_burst` unchanged)
- resolve log: `settled successfully via direct pathological-router.x.mike.testnet.noop_claim_success (4 result bytes); sequence completed`

Observation: **Layers 1 and 2 both report SUCCESS**. The NEAR receipt
DAG shows every receipt `SuccessValue`. The smart-account's resolve sees
`Ok(bytes)` where bytes is the JSON `"ok"` (4 bytes), logs "settled
successfully … sequence completed," and the sequence ADVANCES. A
multi-step sequence with a noop in the middle would proceed to the next
step as if the work had been done.

Only Layer 3 catches it: `calls_completed` is still 1 (unchanged by this
probe). The lie is invisible unless the observer knew to expect that
counter to advance.

This is the sharpest demonstration in the chapter that `Direct` policy
trusts the callee's word entirely.

### §4.3 Pathology 3 — `return_decoy_promise`

- yield tx: `84CjH5n9NfmtZtLQzVkEJeM21cpMHRQTn5TBLDM8xRBQ`
- run_sequence tx: `BHT8N3dMZpF3PNmX4p3NuCpdrztLJcXa94P9bzs7QDwm`
- artifact: `collab/artifacts/investigate-path-decoy.json`
- classification: `FULL_SUCCESS`
- gas_burnt (yield tx): 318 TGas
- cascade window: blocks 246336590..246336603 (14 blocks)
- state before → after: `last_burst: "baseline" → "decoy-returned"`;
  `calls_completed` unchanged (the outer method is `&mut self` so the
  `last_burst` write lands before the returned Promise)
- resolve log: `settled successfully via direct pathological-router.x.mike.testnet.return_decoy_promise (1 result bytes); sequence completed`
- the 1-byte result is the JSON-encoded `0` — the return value of the
  DECOY `echo(0)` call, not of the detached `echo(42)`

Observation: Layer 1 reports SUCCESS (every receipt in the cascade
including the two echo sibling receipts succeed). Layer 2 reports
SUCCESS (resolve chained on the decoy, decoy returned cleanly). Layer 3
is ambiguous: `last_burst` DID change ("decoy-returned" was set by the
outer method body, which runs before the Promises), but
`calls_completed` did NOT change (the method intentionally doesn't
increment it).

The receipt DAG is visually distinct from fire-and-forget (chapter 14):
fire-and-forget returns a plain SuccessValue with one detached child;
return-decoy-promise returns a chained Promise with one detached
sibling AND one chained child. A trace-viewer audit that asks "what did
resolve chain on, and did it succeed?" is fooled in both cases, but the
decoy variant adds one more layer of apparent legitimacy (a chained
return looks more honest than an immediate return).

The real `echo(42)` fired and succeeded too (visible in the receipt
tree under the detached branch). In this demo that's not harmful — but
swap `echo` for a contract that mutates critical state based on `n=42`
and the pathology becomes a real attack vector: resolve advances on the
decoy while the detached work does its damage.

### §4.4 Pathology 4 — `return_oversized_payload(20)`

- yield tx: `73xuZ8Bo7VtchwhkPpAS3Ep4ZcfFUTsWTN3gak6xwcri`
- run_sequence tx: `8CQnLdWQADAQmhdwYbPvYq7vYgcGpSCfqswEXZTSn7HL`
- artifact: `collab/artifacts/investigate-path-oversize.json`
- classification: `FULL_SUCCESS`
- gas_burnt (yield tx): 317 TGas
- cascade window: blocks 246336606..246336618 (13 blocks)
- state before → after: unchanged
- downstream outcome: `SuccessValue` (the 20 KiB string returned cleanly at the NEAR runtime level)
- resolve log: `failed downstream via direct pathological-router.x.mike.testnet.return_oversized_payload; ordered release stopped here: TooLong(20482)`

Observation: **Layer 1 reports FULL_SUCCESS** — the runtime has no
problem producing a 20 KiB SuccessValue. Only Layer 2 catches it, and
it catches it with a DISTINCT error variant: `PromiseError::TooLong(20482)`,
not the generic `PromiseError::Failed`. The 20482 is the total byte
count (20 * 1024 payload + 2 quote bytes in JSON wire form).

This empirically resolves the ambiguity flagged in the plan:
`env::promise_result_checked(index, max_len)` **does** treat oversized
results as failure (consistent with CLAUDE.md's Pitfalls claim), but it
uses a specific `TooLong(usize)` variant that carries the observed size.
The size would, in principle, let a future sophisticated callback
distinguish size-limit failures from other failures and react
differently — but `on_promise_resolved` in the current kernel
collapses both to "sequence halted."

Layer 3 correctly reports "no work done" (the method is `&self` and
does no state mutation).

## §5 Cross-table

| Pathology | L1 (NEAR receipt class) | L2 (smart-account resolve) | L3 (target state) | First detection at | Work actually done? |
|---|---|---|---|---|---|
| baseline (control) | `FULL_SUCCESS` | `settled successfully` | counter: 0→1, burst: null→"baseline" | (n/a — honest) | **YES** |
| gas-burn | `PARTIAL_FAIL` | `failed downstream: Failed` | unchanged | L1 | no |
| noop (pure lie) | `FULL_SUCCESS` | `settled successfully` | unchanged | **L3 only** | no |
| decoy-promise | `FULL_SUCCESS` | `settled successfully` | `last_burst` set (inline write), counter unchanged | L3 (partial — only if observer knew counter was the canonical signal) | no (real work detached, decoy succeeded) |
| oversize (20 KiB) | `FULL_SUCCESS` | `failed downstream: TooLong(20482)` | unchanged | L2 | no |

**Row readings.**

- **baseline** is the only probe where the target's counter
  incremented. Reading Layer 3 alone is sufficient to distinguish real
  work from every pathological shape.
- **gas-burn** is the easy case: all layers converge on failure. No
  adapter needed beyond `Direct` — the sequence halts correctly. But
  the cost of the halt (~315 TGas burned) is borne by the caller, and
  is indistinguishable from an honest panic.
- **noop** is the sharpest demonstration of `Direct`'s blindness. NEAR
  is happy, smart-account is happy, only the target's own state
  betrays the lie. An adapter that polls `get_calls_completed` before
  and after, expecting +1, catches it.
- **decoy** is the subtlest shape. Layer 2 happily advances because
  the decoy's return receipt chained back with a success value. The
  method body's inline state write (`last_burst`) DOES reach chain,
  which complicates naive "did any state change?" adapter heuristics —
  the auditor needs a precise invariant about WHICH fields should
  have changed. And the detached real work fires, so the target's
  ACTUAL semantic (whatever `echo(42)` would mean for a real target)
  happens silently in the background.
- **oversize** is the only pathology where `Direct`'s Layer 2 gives
  richer signal than `Failed`: the `TooLong(size)` variant carries the
  actual observed size. Today's `on_promise_resolved` discards that
  detail; a future kernel variant could surface it via a
  `SequenceHaltedOversize { step, size }` event.

## §6 Open questions (feeds v1.1)

- **Callback panics in resolve.** If `on_promise_resolved` itself
  panics (smart-account bug, not target bug), the yield stays in
  `yielded_promises`, the sequence queue isn't cleaned up, and the next
  `run_sequence` call at the same step_id fails with "step_id already
  staged." This is a distinct pathology with no Layer 1/2 handling
  today.
- **Multi-detach (N detached siblings + returned decoy).** Decoy with
  N ≥ 2 detached real-work promises. Strictly richer than pathology 3;
  receipt-DAG shape would show N+1 children of the target's outcome.
  Deferred.
- **Cross-shard slow (hitting the ~200-block yield timeout).** Requires
  engineering deep cross-shard chains; timing is non-deterministic.
  Deferred.
- **State-corruption pathology** (partial state writes before panic).
  Target mutates some state, then panics. Layer 1 reports failure,
  Layer 3 shows "partial work." Not built for v1.

## §7 Repro notes

- Shared-rig smart-account at `sa-probe.x.mike.testnet` (fresh
  instance created for this chapter; the existing
  `smart-account.x.mike.testnet` has incompatible prior state).
- `pathological-router` deployed at `pathological-router.x.mike.testnet`.
- Echo used for decoy: `echo.x.mike.testnet`.
- Caller: `mike.testnet`. Owner: `x.mike.testnet`. Executor
  authorization granted via `set_authorized_executor` from the owner.
- Build environment: nightly rustc 1.97.0-nightly (2026-04-17). The
  `-C link-arg=--import-undefined` flag was added to
  `scripts/build-all.sh`'s default RUSTFLAGS during this chapter
  because recent nightly otherwise fails to link near-sdk's wasm host
  imports. Earlier chapters' builds predate this change but are
  structurally unaffected (their wasm binaries are interchangeable
  with the newly flagged builds).
