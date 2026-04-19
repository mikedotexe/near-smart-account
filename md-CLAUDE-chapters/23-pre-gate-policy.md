# Chapter 23 — `PreGate`: pre-dispatch conditional gating

## §1 Motivation

Chapter 21's `Asserted` closed the Layer-3 post-state blindspot: the
kernel can now halt a sequence AFTER a target resolves, based on a
byte-equality check against any view. Useful, but limited in one
specific way: by the time `Asserted` halts the sequence, the target's
side effects have already landed. For "fire-and-regret-on-mismatch"
this is fine — the halt just prevents step N+1.

But there is a class of workflow where the target's side effect is
what we want to prevent, not just the next step:

- **Limit orders.** Swap A→B at the market rate, but only if the
  quoted rate is ≥ my threshold. An Asserted postcheck would catch a
  bad fill *after* the swap — but we wanted the fill to never happen.
- **Freshness checks.** Only act if the last-updated timestamp on an
  oracle is within the past minute; halt otherwise. We don't want the
  action at all if the oracle is stale.
- **Balance minimums.** Only transfer out if the source balance is at
  least X. An Asserted on balance post-transfer would catch the
  opposite drift, but cheaper: don't transfer if there's nothing to
  transfer.
- **Rate limits.** Only fire if the counter is below the hourly
  quota. Halting after the fire is the opposite of what "rate limit"
  means.

`PreGate` fills this gap: a **pre-dispatch** gate on any step. Fire
a view call; compare the returned bytes to `[min, max]` under the
caller's chosen comparison kind; dispatch the target only if in
range.

It is not a replacement for `Asserted`. It is a **companion**. A step
can have both: pre-gate on market quote, Asserted on resulting
balance. Each covers a different cascade position.

## §2 Design

### Surface

`PreGate` is a new optional field on `Step` / `StepInput` /
`StepView` / `RegisteredStepView`, orthogonal to `StepPolicy`:

```rust
pub struct PreGate {
    pub gate_id: AccountId,
    pub gate_method: String,
    pub gate_args: Base64VecU8,
    pub min_bytes: Option<Base64VecU8>,
    pub max_bytes: Option<Base64VecU8>,
    pub comparison: ComparisonKind,
    pub gate_gas_tgas: u64,
}

pub enum ComparisonKind {
    U128Json,   // JSON-string or bare u128
    I128Json,   // JSON-string or bare i128
    LexBytes,   // raw byte lexicographic
}
```

Validation (`validate_step`):

- `gate_method` non-empty
- `gate_gas_tgas > 0`
- `gate_gas_tgas <= MAX_PRE_GATE_GAS_TGAS` (100 TGas ceiling)
- At least one of `min_bytes` or `max_bytes` must be set — a gate
  with both bounds `None` is a no-op and rejected at register time

### Cascade shape

A plain (non-gated) step has three receipts:

```
resume → target → on_step_resolved
```

A gated step inserts the gate + callback before the target:

```
resume → gate_call → on_pre_gate_checked →
                     ├─ in_range:      target → on_step_resolved
                     └─ out of range / gate panic: halt
```

The gate call is a real `FunctionCall` receipt (not an enforced
read-only view), so callers must choose a trustworthy gate surface
— same discipline as `Asserted`'s postcheck.

### The `on_pre_gate_checked` callback

Three branches — concretely implemented in
`contracts/smart-account/src/lib.rs`:

- **Gate panicked** (`PromiseError`): emit `pre_gate_checked` with
  outcome `"gate_panicked"`, halt the sequence (remove step + queue,
  finish automation run, emit `sequence_halted` with
  `error_kind: "pre_gate_gate_panicked"`), return `Value(())`.
- **In range**: emit `pre_gate_checked` with outcome `"in_range"`,
  matched=true, dispatch the target via `dispatch_promise_for_call`,
  chain `.then(on_step_resolved)`, return the promise chain.
- **Out of range** (`BelowMin` / `AboveMax` / `ComparisonError`):
  emit `pre_gate_checked` with the specific outcome, halt the
  sequence same as the panicked branch (distinct `error_kind` tag on
  `sequence_halted` so aggregators can tell why).

The target `Step` spec is read from `self.registered_steps` at
callback time — only `(sequence_namespace, step_id)` are passed
through callback args. Same pattern as `on_asserted_evaluate_postcheck`
(chapter 21).

### Comparison semantics

- `U128Json` / `I128Json`: strip surrounding quotes (NEP-141 and
  NEP-245 return u128 as `"123"` with quotes; older NEAR contracts
  may return bare integers), parse both bounds and actual as the
  numeric type, compare numerically. Any parse failure returns
  `ComparisonError`.
- `LexBytes`: direct `bytes.cmp(&min)` / `bytes.cmp(&max)`. For
  sentinel strings, bitmasks, or any gate whose return is not an
  integer.

Boundary equality is inclusive: `min ≤ actual ≤ max`.

### Gas accounting

- Gate's own call: `gate_gas_tgas` (capped at `MAX_PRE_GATE_GAS_TGAS = 100`)
- `on_pre_gate_checked` callback: `PRE_GATE_CHECK_CALLBACK_GAS_TGAS = 25`
- On in-range, the callback additionally reserves
  `gas_tgas + STEP_RESOLVE_CALLBACK_GAS_TGAS` for the target + its
  on_step_resolved finish

Total gas per gated step stays inside the PV-83 1 PGas ceiling for
any reasonable configuration.

## §3 Worked examples

### Limit order on intents.near (mainnet pattern)

```js
const step = {
  step_id: "sell_near",
  target_id: "intents.near",
  method_name: "execute_intents",
  args: b64(JSON.stringify([signed_token_diff])),
  attached_deposit_yocto: "1",
  gas_tgas: 120,
  policy: { Direct: {} },
  pre_gate: {
    gate_id: "intents.near",
    gate_method: "simulate_intents",
    gate_args: b64(JSON.stringify({ intents: [simulated_swap] })),
    min_bytes: b64(JSON.stringify("50000000")),  // ≥ 50 USDC
    max_bytes: null,
    comparison: "U128Json",
    gate_gas_tgas: 30,
  },
};
```

If the simulation quotes < 50 USDC → halt, no swap fires, no market
exposure. If ≥ 50 USDC → swap fires normally.

### Freshness check (oracle-last-updated pattern)

```js
pre_gate: {
  gate_id: "oracle.near",
  gate_method: "last_updated_ms",
  gate_args: b64("{}"),
  // Must be at least block_timestamp_ms - 60_000 ago — caller
  // computes and embeds this at submission time.
  min_bytes: b64(JSON.stringify(String(earliestAcceptableMs))),
  max_bytes: null,
  comparison: "U128Json",
  gate_gas_tgas: 20,
}
```

### Composing with `Asserted`

A step can carry both. PreGate halts before target on bad quote;
Asserted halts after target on wrong post-state. Useful when the
protocol is partly trusted and partly not — for example, the quote
surface is trustworthy but the swap might still refund:

```js
{
  pre_gate: { /* quote ≥ threshold */ },
  policy: {
    Asserted: {
      // Post-state check on resulting balance
      assertion_id: "intents.near",
      assertion_method: "mt_balance_of",
      assertion_args: b64(...),
      expected_return: b64(...),
      assertion_gas_tgas: 30,
    },
  },
}
```

## §4 Testnet probes (unit-test level)

Chapter 20's `pathological-router` offers an ideal testable gate
surface: `get_calls_completed()` returns a bare u32 counter, and
`do_honest_work(label)` increments it. Six unit tests in `lib.rs`
exercise the cascade:

- `register_step_accepts_pre_gate_and_surfaces_in_view` — round-trip
  through `StepInput` / `Step` / `RegisteredStepView`
- `pre_gate_rejects_empty_gate_method` / `…zero_gate_gas` /
  `…over_max_gate_gas` / `…fully_unbounded` — validation boundary
- `on_pre_gate_checked_in_range_dispatches_target` — happy path; the
  target receipt queues
- `on_pre_gate_checked_below_min_halts_sequence` /
  `…above_max_halts_sequence` — out-of-range halts; target never
  queues
- `on_pre_gate_checked_gate_panic_halts_sequence` — gate-panic
  halt; error_kind distinct
- `on_pre_gate_checked_comparison_error_halts_sequence` —
  non-numeric bytes under U128Json halt with dedicated error_kind
- `on_step_resumed_with_pre_gate_routes_through_gate_first` — resume
  step with pre_gate fires the gate receipt + on_pre_gate_checked
  callback BEFORE any target receipt

Plus 11 unit tests in the `smart-account-types` crate for
`evaluate_pre_gate` under each `ComparisonKind` and edge case.

## §5 Event telemetry

`pre_gate_checked` is a new NEP-297 event under standard
`"sa-automation"`, version `"1.1.0"`. Emission:

```json
{
  "standard": "sa-automation",
  "version": "1.1.0",
  "event": "pre_gate_checked",
  "data": {
    "step_id": "...",
    "namespace": "...",
    "outcome": "in_range" | "below_min" | "above_max" |
               "comparison_error" | "gate_panicked",
    "matched": true | false,
    "expected_min_bytes_len": <n>|null,
    "expected_max_bytes_len": <n>|null,
    "actual_bytes_len": <n>,
    "actual_return": "<base64>" | null,
    "comparison": "u128_json" | "i128_json" | "lex_bytes",
    "error_kind": "downstream_failed" | null,  // gate_panicked only
    "error_msg": "...",  // gate_panicked only
    "call": { /* full call metadata incl. pre_gate bytes */ },
    "runtime": { /* standard runtime envelope */ }
  }
}
```

When `matched=false`, a corresponding `sequence_halted` event follows
with `reason: "pre_gate_failed"` and `error_kind:
"pre_gate_{outcome}"` — aggregators can tell "we halted because the
gate returned out-of-range" from "we halted because the target
failed" by the `error_kind` prefix.

## §6 Relationship to other primitives

- **Against `Asserted`**: orthogonal (pre vs post).
  `PreGate + Asserted + Asserted` is a legal three-check cascade on
  one step.
- **Against `Adapter`**: composable. A step with `Adapter` policy
  can also carry a PreGate — the gate fires first, then the adapter
  cascade.
- **Against `BalanceTrigger`**: different layer.
  `BalanceTrigger` fires a sequence when the smart account's own
  balance crosses a threshold; `PreGate` gates an individual step on
  an arbitrary view. A `BalanceTrigger`'s template can of course
  contain steps with `PreGate`s.
- **Against future `Compensating` (roadmap)**: Compensating is a
  recovery policy (run cleanup on halt); PreGate is a prevention
  policy (don't fire at all). They address different failure modes.

## §7 Deployment note

`PreGate` adds `pre_gate: Option<PreGate>` to `Step`, which is a
borsh schema change. Redeploys over a populated account require a
migration (chapter 22). This repo's policy: land each tranche on a
fresh subaccount. `sa-pregate.x.mike.testnet` is the testnet target
for this chapter's live-validation step.

The `migrate()` safety-net function (`#[init(ignore_state)]`) lands
alongside PreGate for future tranches; for PreGate itself, migration
over an old-shape account is not attempted.
