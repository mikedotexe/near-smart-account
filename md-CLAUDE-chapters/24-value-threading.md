# Chapter 24 — Value threading: a step's args derived from a prior step's return

## §1 Motivation

Chapters 21 (`Asserted`) and 23 (`PreGate`) added **gating** machinery:
halt before a target fires, or halt after it resolves, based on a view
comparison. Both are binary — advance or halt. Neither lets step N's
*output* shape step N+1's *input*.

But a big class of workflow wants exactly that: step N+1's args
**depend on the result of step N**, not a value the caller knew at
submission time:

- **Ladder-swap.** Read the mid-market quote on step 1, swap 50% of
  the quoted amount on step 2, then claim the resulting LP position on
  step 3. The caller knew none of the concrete amounts when the plan
  landed on-chain.
- **Allowance-drain.** Query remaining token allowance on step 1;
  transfer exactly that much on step 2. No off-chain read-then-sign
  loop, no stale quote.
- **Self-reference chains.** Step 1 returns a nonce or handle that
  step 2 must echo back (withdrawals from some NEP-141 wrappers, for
  instance).
- **Programmable amount splits.** "Claim X; then send 25% of X
  to treasury, 25% to vault, 50% back to me." One signed plan; three
  transfers whose amounts are derived at dispatch time.

Value threading adds two orthogonal primitives to `Step`:

1. **`save_result`** — "after this step resolves successfully, save
   its return bytes in the sequence context under this name."
2. **`args_template`** — "at dispatch time for this step, materialize
   the final args by substituting `${name}` placeholders with
   previously-saved values (optionally transformed)."

Together they close the "static args" limitation of the kernel
without adopting a full scripting language. The substitution engine
is deliberately narrow: `Raw`, `DivU128 { denominator }`,
`PercentU128 { bps }`. Anything more is a future extension.

## §2 Design

### Surface

`SaveResult` and `ArgsTemplate` are optional fields on `Step` /
`StepInput` / `StepView` / `RegisteredStepView`, orthogonal to
`StepPolicy` and `PreGate`:

```rust
pub struct SaveResult {
    pub as_name: String,
    pub kind: ComparisonKind, // advisory; downstream op decides parse
}

pub struct ArgsTemplate {
    pub template: Base64VecU8,         // raw bytes, typically JSON
    pub substitutions: Vec<Substitution>,
}

pub struct Substitution {
    pub reference: String,   // must match a prior SaveResult.as_name
    pub op: SubstitutionOp,
}

pub enum SubstitutionOp {
    Raw,
    DivU128 { denominator: U128 },
    PercentU128 { bps: u32 },  // bps / 10_000 (5000 = 50%)
}
```

Template placeholders are **JSON-position-aware**: the placeholder
`"${name}"` (WITH the enclosing JSON quotes) is what `materialize_args`
looks for. The replacement bytes land in that position.

- `Raw` splices the saved bytes verbatim (no re-quoting). If saved
  bytes include quotes (e.g., `"completed:probe"` for a method
  returning `String`), the output preserves them and the surrounding
  JSON stays valid.
- `DivU128 { denominator }` parses saved bytes as a u128 (handling
  NEP-141 `"N"` quoted-string and bare-integer shapes via
  `strip_outer_json_quotes`), divides, and emits a JSON-string-quoted
  u128 (`"N"`). This is the NEP-141 / NEP-245 convention for
  amount-like args.
- `PercentU128 { bps }` parses as u128, multiplies by `bps / 10_000`,
  emits same shape as `DivU128`. Rejects `bps > 10_000` at
  materialize time (>100% is a caller error).

### Cascade shape

A step without threading has three receipts:

```
resume → target → on_step_resolved
```

A step with `save_result` has the same three receipts — save happens
**on the callback**, not as a new receipt. A step with `args_template`
also has three receipts — substitution is a pure function run during
`on_step_resumed`, no extra promise.

So the cascade count is unchanged. Value threading is a **state layer
on top of the existing kernel**, not new receipts.

### The sequence context

`Contract.sequence_contexts: IterableMap<String, SequenceContext>`
keyed by `sequence_namespace` (`"manual:<caller>"` for
`execute_steps` callers, or `"auto:<trigger_id>:<run_nonce>"` for
`execute_trigger` runs). Populated lazily:

```rust
pub struct SequenceContext {
    pub saved_results: HashMap<String, Vec<u8>>,
}
```

Write paths (in `on_step_resolved` Ok arm, `lib.rs:~625`):

```rust
if let Some(spec) = &yielded.call.save_result {
    self.save_step_result(&sequence_namespace, &step_id, spec, &bytes);
}
```

Read paths:

1. `on_step_resumed` Ok arm — `materialize_step_call` substitutes if
   the step has an `args_template`; dispatches the resulting `Step`.
2. `on_pre_gate_checked` in-range arm — same substitution, but
   dispatched after the gate passes.

Clear paths (ensures saved bytes never leak across runs):

- `finish_sequence_on_completion` — sequence completed cleanly.
- `halt_sequence_on_downstream_failure` — step failed.
- `halt_sequence_on_resume_failure` — resume went wrong.
- `halt_sequence_on_pre_gate_failure` — gate out of range or panicked.
- `halt_sequence_on_materialize_failure` — substitution itself failed.

The kernel never retains sequence context across a run boundary.
Re-running the same namespace (`manual:<same_caller>` back-to-back,
say) starts with an empty map.

### `materialize_args` — pure function

Lives in `types/src/types.rs`:

```rust
pub fn materialize_args(
    template: &[u8],
    substitutions: &[Substitution],
    saved_results: &std::collections::HashMap<String, Vec<u8>>,
) -> Result<Vec<u8>, MaterializeError> { /* … */ }
```

It's a pure function — no `env` calls, no state mutation. That means
every edge case can be exercised with plain Rust unit tests, no
VM context needed. The kernel's `materialize_step_call` is a thin
wrapper that pulls the sequence's saved results and calls this.

### Errors

`MaterializeError` captures the five failure modes:

| Variant | When |
|---|---|
| `MissingSavedResult(name)` | Substitution references a name not yet saved (usually: wrong order or step 1 failed to emit save_result). |
| `UnparseableSavedResult { reference, op }` | Saved bytes don't parse under the op's expected shape (e.g., `DivU128` on a non-numeric string). |
| `NumericOverflow { reference, op }` | `u128::checked_mul` / `checked_div` failed. |
| `InvalidBps(bps)` | `PercentU128 { bps }` with `bps > 10_000` or `bps == 0`. |
| `PlaceholderNotFound(name)` | The template doesn't contain `"${name}"` but a substitution for `name` is declared. Usually a typo. |

Each maps to an `error_kind` tag on `sequence_halted`:
`args_materialize_missing_saved_result`,
`args_materialize_unparseable_saved_result`,
`args_materialize_numeric_overflow`,
`args_materialize_invalid_bps`,
`args_materialize_placeholder_not_found`.

### Gas accounting

Value threading is free at the receipt level — no new gas reservation.
`save_step_result` and `materialize_step_call` run inside existing
callbacks (`on_step_resolved`, `on_step_resumed`,
`on_pre_gate_checked`), and the substitution engine is a pure
function over in-memory state. Saved bytes live in contract storage
only for the duration of the sequence (`sequence_contexts.remove` on
every terminal path).

## §3 Worked examples

### Raw string chain

Step 1 returns a string; step 2 echoes it as its own arg.

```js
const step1 = {
  step_id: "step1",
  target_id: "pathological-router.x.mike.testnet",
  method_name: "do_honest_work",
  args: b64('{"label":"prime"}'),
  attached_deposit_yocto: "0",
  gas_tgas: 40,
  policy: { Direct: {} },
  save_result: { as_name: "prior_label", kind: "LexBytes" },
};
const step2 = {
  step_id: "step2",
  target_id: "pathological-router.x.mike.testnet",
  method_name: "do_honest_work",
  args: b64('{"label":"${prior_label}"}'),
  attached_deposit_yocto: "0",
  gas_tgas: 40,
  policy: { Direct: {} },
  args_template: {
    template: b64('{"label":"${prior_label}"}'),
    substitutions: [{ reference: "prior_label", op: "Raw" }],
  },
};
```

Step 1 returns `"completed:prime"` (JSON string, with quotes). Saved
bytes are `"completed:prime"` (18 bytes including the outer quotes).
Step 2's placeholder `"${prior_label}"` is replaced by those 18
bytes (quotes and all), producing `{"label":"completed:prime"}` —
valid JSON for `do_honest_work(label: String)`.

### Percentage ladder (numeric)

Step 1 reads a counter; step 2 fires a call whose label encodes
half the counter value.

```js
const step1 = {
  step_id: "read_counter",
  target_id: "pathological-router.x.mike.testnet",
  method_name: "get_calls_completed",
  args: b64("{}"),
  attached_deposit_yocto: "0",
  gas_tgas: 40,
  policy: { Direct: {} },
  save_result: { as_name: "counter", kind: "U128Json" },
};
const step2 = {
  step_id: "derived_label",
  target_id: "pathological-router.x.mike.testnet",
  method_name: "do_honest_work",
  args: b64('{"label":"${counter}"}'),
  attached_deposit_yocto: "0",
  gas_tgas: 40,
  policy: { Direct: {} },
  args_template: {
    template: b64('{"label":"${counter}"}'),
    substitutions: [
      { reference: "counter", op: { PercentU128: { bps: 5000 } } },
    ],
  },
};
```

If the counter returns `8`, `PercentU128 { bps: 5000 }` emits `"4"`
(JSON-string-quoted u128), and step 2's materialized args become
`{"label":"4"}`. The flagship `examples/ladder-swap.mjs` is a
three-step variant with a prime step that guarantees a non-zero
counter on fresh deploys.

### Composition with `PreGate` + `Asserted`

Value threading, pre-gating, and post-assertion are all orthogonal:

```js
{
  step_id: "limit_ladder_swap",
  target_id: "intents.near",
  method_name: "execute_intents",
  args: b64("..."),
  pre_gate: { /* only fire if quote >= threshold */ },
  args_template: { /* amount derived from step N-1's saved balance */ },
  policy: {
    Asserted: { /* verify resulting balance matches expectation */ },
  },
}
```

Fire order per step: `pre_gate` → materialize args → dispatch target
→ `Asserted` postcheck → save result → advance. Any failure halts
cleanly with a distinct `error_kind` so aggregators can tell where
the cascade broke.

## §4 Testnet probes (unit-test level)

23 unit tests in `types/src/types.rs` cover every op × edge
combination for `materialize_args`:

- `Raw` with present / missing / empty saved bytes.
- `DivU128` with quoted / bare / non-numeric / overflow / zero
  denominator.
- `PercentU128` with 0 bps / 5000 / 10000 / 15000 (rejected) /
  overflow.
- Multi-substitution templates; placeholder-not-found.
- Every `MaterializeError` variant has its `kind_tag()` covered.

7 kernel unit tests in `contracts/smart-account/src/lib.rs`
exercise the wiring:

- `save_step_result_populates_sequence_context` and
  `…_emits_result_saved_event` — successful save, byte count + kind
  tag in event, context populated.
- `materialize_step_call_returns_unchanged_when_no_template` —
  step without `args_template` passes through untouched.
- `materialize_step_call_substitutes_saved_result` — successful
  substitution; produced args match expectation.
- `materialize_step_call_propagates_error_on_missing_saved_result`.
- `clear_sequence_context_removes_entry` —
  halt/complete paths call this.
- `halt_sequence_on_materialize_failure_emits_distinct_error_kind` —
  `sequence_halted.error_kind` starts with `args_materialize_`.

Integration-level testnet probes (against a deployed kernel) are
exercised via `examples/ladder-swap.mjs`. The artifact captures the
`result_saved` event, the next step's materialized args, and the
final target-side state so mismatches are visible.

## §5 Event telemetry

Two new events and one new halt reason join the `"sa-automation"`
standard (version `"1.1.0"`):

**`result_saved`** — emitted on every successful save.

```json
{
  "standard": "sa-automation",
  "version": "1.1.0",
  "event": "result_saved",
  "data": {
    "step_id": "...",
    "namespace": "...",
    "as_name": "counter",
    "kind": "u128_json" | "i128_json" | "lex_bytes",
    "bytes_len": 3
  }
}
```

`bytes_len` is the raw byte count — useful for detecting payloads
close to the `MAX_CALLBACK_RESULT_BYTES` 16 KiB ceiling.

**`sequence_halted` with `reason: "args_materialize_failed"`** —
emitted when substitution fails at dispatch time.

```json
{
  "standard": "sa-automation",
  "version": "1.1.0",
  "event": "sequence_halted",
  "data": {
    "namespace": "...",
    "failed_step_id": "...",
    "reason": "args_materialize_failed",
    "error_kind": "args_materialize_missing_saved_result"
                | "args_materialize_unparseable_saved_result"
                | "args_materialize_numeric_overflow"
                | "args_materialize_invalid_bps"
                | "args_materialize_placeholder_not_found",
    "error_msg": "materialize: ...",
    "registered_at_ms": <ms>,
    "halt_latency_ms": <ms>,
    "call": { /* full call metadata */ }
  }
}
```

`error_kind` carries the `args_materialize_` prefix so an
aggregator can group materialize failures separately from gate
failures (`pre_gate_*`) or downstream failures (`downstream_failed`).

No new `step_resolved_*` events — saves and materializations happen
inside the existing callbacks.

## §6 Relationship to other primitives

- **`save_result` vs `Asserted`**: different shapes. `Asserted` gates
  advance on an external view's bytes; `save_result` captures the
  target's own return for later use. A step can have both — its own
  return can be both asserted against and saved.
- **`args_template` vs `PreGate`**: also orthogonal. A step can have
  a pre-gate AND an args template — the gate fires first, then (on
  in_range) the args materialize, then the target dispatches.
- **Automation runs (`execute_trigger`)**: sequence contexts live
  under the run's auto-namespace (`"auto:<trigger_id>:<nonce>"`),
  so back-to-back trigger fires don't see each other's saved
  results. Ladder-swap templates land under `save_sequence_template`
  same as anything else.
- **Session keys (chapter 25)**: session keys can fire
  `execute_trigger`, which in turn runs templates that may carry
  `save_result` and `args_template`. The session-key authorization
  layer composes orthogonally with the value-threading layer.

## §7 Deployment note

Value threading adds three optional `Step` fields (`save_result`,
`args_template`) plus one new `Contract` field
(`sequence_contexts`). Both are borsh schema changes — redeploys
over a populated account require the chapter 22 migration ritual.
This repo's policy, consistent since chapter 22: land each tranche
on a fresh subaccount.

`sa-threading.x.mike.testnet` is the testnet target for this
chapter's live validation step. The flagship
`examples/ladder-swap.mjs` against that subaccount produces the
canonical artifact.
