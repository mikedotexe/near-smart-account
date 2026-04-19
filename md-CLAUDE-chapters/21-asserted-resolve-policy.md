# Chapter 21 — `Asserted` resolve policy

## §1 Motivation

Chapter 20's cross-table left two pathologies (noop, decoy) visible only
at Layer 3 — target state polling. `Direct` resolve could not distinguish
them from honest work because both the NEAR receipt class (L1) and the
smart-account resolve log (L2) saw a clean SuccessValue. The chapter 20
summary was blunt: *"the kernel is blind; only an external observer
polling target state can tell work didn't happen."*

`Asserted` closes this gap by letting the kernel itself do that L3 poll
inline. After the target resolves successfully, the kernel fires a
caller-specified postcheck call against a caller-specified contract+method,
compares the returned bytes to caller-specified expected bytes, and
advances the sequence only on exact-bytes match. Mismatch halts the
sequence exactly the way any other downstream failure does.

CLAUDE.md previously described `Asserted` as *"reserved for a future
postcondition mode."* v1 ships it with deliberately narrow semantics —
one check call, one comparator (EQ), one expected value — and proves
the cascade shape with four testnet probes against
`pathological-router`.

## §2 Design

### Enum shape

`ResolutionPolicy` gains a new struct-variant (`types/src/types.rs`):

```rust
Asserted {
    assertion_id: AccountId,
    assertion_method: String,
    assertion_args: Base64VecU8,
    expected_return: Base64VecU8,
    assertion_gas_tgas: u64,
}
```

Wire shape on `yield_promise` input:

```json
"resolution_policy": {
  "Asserted": {
    "assertion_id": "pathological-router.x.mike.testnet",
    "assertion_method": "get_calls_completed",
    "assertion_args": "e30=",
    "expected_return": "Mw==",
    "assertion_gas_tgas": 30
  }
}
```

`"e30="` is base64 of `{}` (empty JSON object). `"Mw=="` is base64 of
the ASCII digit `3`, i.e. the JSON wire form of `u32(3)` returned by
`get_calls_completed` when the counter sits at 3.

Despite the `get_calls_completed` example, `Asserted` is **not** an
enforced read-only view mode. The postcheck is a real zero-deposit
`FunctionCall` receipt. v1's safety boundary is therefore explicit:
callers must choose a trustworthy postcheck surface whose return bytes are
meaningful as the resolution predicate.

### Cascade structure

A Direct step has three receipts after release:

```
resume → target → on_promise_resolved
```

An Asserted step expands into five receipts in a flat chain:

```
resume → target → on_asserted_run_postcheck → check → on_asserted_evaluate_postcheck → on_promise_resolved
```

The additions are:

- **`on_asserted_run_postcheck`** (private smart-account callback).
  Reads the target's result. If the target failed, panics so the
  outer `.then(on_promise_resolved)` observes `PromiseError::Failed`
  and halts. If the target succeeded, returns
  `postcheck.method(args).then(on_asserted_evaluate_postcheck)`. near-sdk
  flattens the returned promise into the outer chain.
- **`on_asserted_evaluate_postcheck`** (private). Reads the postcheck
  call's bytes. Match → returns `()` (empty resolve result → advance).
  Mismatch → panics with expected/actual preview → halt.

### Gas accounting

Two new constants (`contracts/smart-account/src/lib.rs`):

```rust
const ASSERTED_POSTCHECK_RUN_GAS_TGAS: u64 = 15;
const ASSERTED_POSTCHECK_EVALUATE_GAS_TGAS: u64 = 10;
```

Policy overhead (attached to the yielded resume callback) for Asserted
is `15 + 10 + assertion_gas_tgas`. The caller-visible target budget is
`MAX_YIELD_PROMISE_GAS_TGAS − policy_overhead`. With default
`assertion_gas_tgas = 30`, total Asserted overhead is 55 TGas (vs 320
for Adapter, 0 for Direct).

### What `on_promise_resolved` sees

Identical to Direct. The resolve callback reads
`promise_result_checked(0, MAX_CALLBACK_RESULT_BYTES)` and branches on
`Ok` vs `Err` exactly as before. Asserted's "postcheck mismatch"
signal lands as a PromiseError because the evaluate callback panics;
the resolve log line is `"failed downstream via asserted ... ; ordered
release stopped here: Failed"`. The underlying cause (mismatch,
target failed, check call failed, oversized return) lives in the
panic-receipt logs and the receipt tree, not in the resolve summary.

## §3 Worked examples

All four probes run against
`pathological-router.x.mike.testnet` via
`sa-asserted.x.mike.testnet` (a fresh smart-account subaccount created
for this chapter; the existing `smart-account.x.mike.testnet` has
incompatible prior state). Caller: `mike.testnet`. Owner:
`x.mike.testnet`. Counter trajectory across the run: `2 → 3 → 3 → 3 → 3`.

### §3.1 `asserted-honest` — baseline (ADVANCES)

- **target**: `do_honest_work("probe-asserted-honest-a")`
- **postcheck**: `get_calls_completed()` — expected `"3"` (pre=2, +1 from
  honest work)
- **yield tx**: `6hvm3bmZgV66qYj8MzLPxBgcNb5bAcBRHAjBe4y7zmxm`
- **run tx**: `4BXAAnk5de918f7Sqxuvq6tHEUXwHiZHhmWRkBfjHAU1`
- **artifact**: `collab/artifacts/asserted-honest.json`
- **classification**: `FULL_SUCCESS`
- **state_before**: `calls_completed=2, last_burst="probe-control-mo4nonu7"`
- **state_after**: `calls_completed=3, last_burst="probe-asserted-honest-a"`

Resolve-side log sequence (`sa-asserted.x.mike.testnet`):

```
staged and waiting for resume via asserted pathological-router.x.mike.testnet.do_honest_work postchecked by pathological-router.x.mike.testnet.get_calls_completed
resumed and is dispatching real downstream work via asserted ...
asserted step 'probe-asserted-honest-a' ... : postcheck matched (1 bytes)
settled successfully via asserted ... ; sequence completed
```

The `postcheck matched (1 bytes)` line comes from
`on_asserted_evaluate_postcheck` — 1 byte because `get_calls_completed`
returned the ASCII `"3"` on the wire.

### §3.2 `asserted-noop` — flagship proof (HALTS)

- **target**: `noop_claim_success("probe-asserted-noop-a")` (Chapter
  20's pathology 2 — pure lie)
- **postcheck**: `get_calls_completed()` — expected `"4"` (pre=3, would be
  3+1 *if* noop had done the work)
- **yield tx**: `6sgfwb7mQbVYktQiCaPpPiby5SWnkvKVuA2QBu6988bd`
- **run tx**: `FRD9ju9NQNNVkxzrao326Vw4NFpyUXBStMUdwqAtZLQC`
- **artifact**: `collab/artifacts/asserted-noop.json`
- **classification**: `PARTIAL_FAIL`
- **state_before**: `calls_completed=3, last_burst="probe-asserted-honest-a"`
- **state_after**: `calls_completed=3, last_burst="probe-asserted-honest-a"`
  (unchanged — noop did nothing, which is exactly what we caught)

Log sequence crosses three accounts:

```
[sa-asserted]           staged and waiting for resume via asserted ...
[sa-asserted]           resumed and is dispatching real downstream work via asserted ...
[pathological-router]   pathological-router: noop_claim_success(probe-asserted-noop-a); skipping real work
[sa-asserted]           failed downstream via asserted ... ; ordered release stopped here: Failed
```

The target emits its own "skipping real work" log proudly — and the
kernel halts anyway. This is the v1 proof: `Direct` on this exact
receipt tree would have logged `settled successfully`, but `Asserted`
saw the unchanged counter and panicked out. Compare chapter 20 §4.2
where the same target-side behavior advanced the sequence.

### §3.3 `asserted-decoy` — caught via counter (HALTS)

- **target**: `return_decoy_promise(echo.x.mike.testnet)` (Chapter 20's
  pathology 3 — decoy-returned chain)
- **check**: `get_calls_completed()` — expected `"4"` (wrong; decoy
  leaves counter flat)
- **yield tx**: `8JvwkAx93TuRqMeSPR1WJGnUPL4EuA6ZY1hLhpKt8fVr`
- **run tx**: `FGPdPKPfRoB4ZcC9AWJxbaaD1Ms35WVnL1rPYgjz3ut3`
- **artifact**: `collab/artifacts/asserted-decoy.json`
- **classification**: `PARTIAL_FAIL`
- **state_before**: `calls_completed=3, last_burst="probe-asserted-honest-a"`
- **state_after**: `calls_completed=3, last_burst="decoy-returned"`

Note `last_burst` *did* change — decoy's method body does a single
inline state mutation before returning the decoy promise. Chapter 20
§4.3 flagged this as a pitfall for naive "any state changed?" adapter
heuristics. v1 `Asserted` dodges the pitfall by asking the caller to
specify exactly *which* state they expect to change, not a general
"did anything happen" check. Here we ask about `calls_completed`
specifically, and the decoy path leaves that field flat.

### §3.4 `asserted-oversized` — caught at run_postcheck (HALTS)

- **target**: `return_oversized_payload(kb=20)` (Chapter 20's
  pathology 4 — 20482-byte SuccessValue)
- **check**: `get_calls_completed()` — expected `"4"` (irrelevant; the
  check call never fires)
- **yield tx**: `F4imubuZPZkVCzucjExpszhAirj74iz5hSYKoqKjcZZf`
- **run tx**: `BTEKGsiDkymiJU4D7gb3pDbQUFF2QFmPHubPy3K7oU8y`
- **artifact**: `collab/artifacts/asserted-oversized.json`
- **classification**: `PARTIAL_FAIL`
- **state_before**: `calls_completed=3, last_burst="decoy-returned"`
- **state_after**: `calls_completed=3, last_burst="decoy-returned"`

The oversized 20 KiB payload trips `on_asserted_run_postcheck`'s
`promise_result_checked(0, MAX_CALLBACK_RESULT_BYTES)` read, which
returns `Err(PromiseError::TooLong(20482))`. The callback panics with
that error in its message and the cascade halts before the check call
is ever constructed. This confirms Asserted composes correctly with
L2 failures — it doesn't swallow them, doesn't mask the TooLong size,
and doesn't waste a check-call receipt on a target that already
failed.

## §4 Cross-table (extends chapter 20 §5)

| Pathology | L1 (receipt) | L2 (Direct resolve) | L3 (target state) | Direct advances? | Asserted catches? | Asserted caught at |
|---|---|---|---|---|---|---|
| baseline (honest) | `FULL_SUCCESS` | `settled successfully` | counter +1 | yes (correctly) | advances (correctly) | — |
| gas-burn | `PARTIAL_FAIL` | `Failed` | unchanged | no (halts L1/L2) | halts at target | `run_postcheck` (target failed) |
| noop (pure lie) | `FULL_SUCCESS` | `settled successfully` | unchanged | **yes (BUG)** | **halts** | `evaluate_postcheck` (mismatch) |
| decoy-returned | `FULL_SUCCESS` | `settled successfully` | counter unchanged, last_burst="decoy-returned" | **yes (BUG)** | **halts** | `evaluate_postcheck` (mismatch) |
| oversize | `FULL_SUCCESS` | `TooLong(20482)` | unchanged | no (halts L2) | halts at target | `run_postcheck` (TooLong) |

**New column readings.**

- **noop + decoy** are the rows where Asserted adds strictly new
  detection. `Direct` on these two falsely advances the sequence;
  `Asserted` halts. This is the entire v1 reason-for-existing.
- **gas-burn + oversize** are already caught by L1/L2 under `Direct`.
  Under `Asserted` they still halt, but the halting receipt is
  `on_asserted_run_postcheck` instead of `on_promise_resolved`.
  No new detection — just a different panic location. The cost is one
  extra receipt (~15 TGas) for what would have halted anyway.
- **baseline** is the only row where `Asserted` still advances. If any
  row besides baseline showed "advances" in the Asserted column, v1
  would have a bug.

## §5 Limitations & v1.1 directions

v1 deliberately ships the narrowest shape that closes the chapter-20
noop/decoy gap. Known limits:

- **Exact-bytes EQ only.** No `GT`, `LT`, range, or JSON-path
  extraction. Catching "counter increased by at least 1" today
  requires the caller to know the absolute after-value. v1.1:
  `AssertedGt { threshold: Base64VecU8 }` and/or
  `AssertedDelta { before, delta }` (the latter also solves the
  concurrent-mutation race below).
- **No kernel pre-snapshotting.** The caller supplies the expected
  after-value at yield time. If a second actor increments the target
  counter between the yield and the resolve, the absolute value is
  wrong and `Asserted` halts a sequence that *should* have advanced.
  v1.1: kernel reads target state at dispatch time, stores the
  snapshot in the StagedCall record, and evaluates a delta at resolve.
- **Single check only.** Decoy-returned-chain motivated a conjunction
  of two checks (counter unchanged AND last_burst != "decoy-returned")
  in the original plan; v1 catches decoy with a single counter check,
  so the conjunction isn't strictly needed, but richer shapes will
  want it. v1.1: `AssertedAll { checks: Vec<CheckCondition> }`.
- **Panic location vs. resolve log.** The resolve log collapses all
  Asserted failures to `"Failed"`. Distinguishing "target failed" vs.
  "postcheck mismatch" vs. "postcheck call itself failed" requires
  reading the panic receipts. A future resolve-log refinement could
  emit a structured `SequenceHaltedAsserted { cause: ... }` event.
- **Same-receipt atomicity.** Asserted's postcheck fires in a separate
  receipt after the target resolves. A target contract could
  theoretically observe the check-call arriving and mutate state
  back. Pathological, and requires the target to participate; deferred
  as an `Atomic` policy shape if it ever matters.

## §6 Repro notes

- Smart-account: `sa-asserted.x.mike.testnet` (fresh subaccount,
  initialized with `new_with_owner({"owner_id":"x.mike.testnet"})`).
  The existing `smart-account.x.mike.testnet` is left untouched; its
  prior state was already broken from a chapter-20-era deploy.
- Executor authorization: `mike.testnet` granted via
  `set_authorized_executor` from `x.mike.testnet`.
- Probe harness: `scripts/probe-pathological.mjs` extended with a
  `--settle-policy-json '<json>'` flag. Existing presets
  (`control`, `false_success`, `decoy_returned_chain`,
  `oversized_result`) are reused as-is; Asserted wraps them without
  any target-side changes.
- Build environment: nightly rustc 1.97.0-nightly (2026-04-17) with
  `-C link-arg=--import-undefined` (unchanged since chapter 20).
- Unit tests: `cargo test -p smart-account` has 45 tests; 9 new
  Asserted-specific tests cover dispatch shape, target-fail path,
  check-call receipt construction, evaluate match/mismatch,
  config validation, and end-to-end success/failure through
  `on_promise_resolved`. All green on `./scripts/check.sh`.
- Counter trajectory during the probe run:
  `2 → 3 (honest) → 3 (noop halted) → 3 (decoy halted) → 3 (oversize halted)`.
  Inferring "counter is at N" requires either reading before each
  probe (what this chapter does) or v1.1's kernel pre-snapshotting.
