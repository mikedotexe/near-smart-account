# smart-account-types

Shared type definitions for the
[`smart-account-contract`](../contracts/smart-account) NEAR smart
contract. Other contracts and off-chain tooling that want to speak the
same shapes can depend on this lightweight crate instead of on the
contract itself.

## Public surface

- **`StepPolicy`** — the per-step safety policy carried on every
  `Step` (post-dispatch behavior). Three variants:
  - `Direct` — trust the target receipt
  - `Adapter { adapter_id, adapter_method }` — route through a
    protocol-specific adapter that collapses messy async into one
    honest top-level result
  - `Asserted { assertion_id, assertion_method, assertion_args,
    expected_return, assertion_gas_tgas }` — fire a postcheck
    `FunctionCall` after the target resolves and advance only on
    exact byte-match of the return value
- **`PreGate`** — optional **pre-dispatch gate** carried on a `Step`
  alongside `StepPolicy`. Before the sequencer dispatches the target, it
  fires `gate_id.gate_method(gate_args)` and compares the returned
  bytes to `[min_bytes, max_bytes]` under `comparison`. Advance-and-
  dispatch only if in range; halt the sequence with
  `pre_gate_checked.outcome != "in_range"` otherwise. Companion to
  (not replacement for) `StepPolicy`: PreGate controls whether the
  target fires at all, `StepPolicy` controls how its resolution is
  interpreted afterward.
- **`ComparisonKind`** — `U128Json` / `I128Json` / `LexBytes`. How
  `PreGate` compares the gate's returned bytes to its bounds. JSON
  integer-string variants handle both quoted and unquoted NEAR
  return shapes.
- **`evaluate_pre_gate`** — pure decision function used by the sequencer
  and by tests. Given the gate's actual bytes + bounds + comparison,
  returns a `PreGateOutcome` (`InRange` / `BelowMin` / `AboveMax` /
  `ComparisonError`).
- **`SaveResult { as_name, kind }`** — optional per-`Step` directive.
  On the step's successful resolution, the sequencer saves the
  promise-result bytes into the sequence context under `as_name`.
  `kind` is advisory (downstream `SubstitutionOp` decides how to
  parse).
- **`ArgsTemplate { template, substitutions }`** — optional per-`Step`
  field that replaces static `args`. `template` is raw bytes (typically
  JSON) containing `"${name}"` placeholders; `substitutions` describes
  how each placeholder is resolved at dispatch time from the sequence
  context.
- **`Substitution { reference, op }`** — one substitution describes
  which saved slot (`reference`) maps to which placeholder, and what
  `SubstitutionOp` to apply before splicing.
- **`SubstitutionOp`** — `Raw` (splice verbatim) / `DivU128 {
  denominator }` (integer divide; emit JSON-string-quoted u128) /
  `PercentU128 { bps }` (bps / 10_000; emit same shape). Rejects
  `bps > 10_000` and zero denominators at materialize time.
- **`MaterializeError`** — `MissingSavedResult` /
  `UnparseableSavedResult` / `NumericOverflow` / `InvalidBps` /
  `PlaceholderNotFound`. Each has a `kind_tag()` used as the
  `error_kind` suffix on `sequence_halted` events.
- **`materialize_args`** — pure function the sequencer calls at dispatch
  time; can be tested without a VM. Returns the substituted byte
  slice or a `MaterializeError`.
- **`AdapterDispatchInput`** — the canonical argument shape the smart
  account uses when dispatching an adapter call

All types derive the borsh and JSON serializers used across the
workspace (`#[near(serializers = [borsh, json])]`) so they round-trip
cleanly between contract state, RPC, and off-chain tooling.

## Why a separate crate

The split mirrors the CosmWasm convention of
[`contracts/` + `packages/`](https://github.com/CosmWasm/cw-plus): the
compiled Wasm binary lives under `contracts/`, and the consumable type
definitions live here. A consumer that only needs to construct a
`Step` or read back a `StepPolicy` does not need to pull in the full
contract crate.

## Layout

- `src/lib.rs` — re-exports the public surface
- `src/types.rs` — `StepPolicy`, `AdapterDispatchInput`, `PreGate`,
  `ComparisonKind`, `PreGateOutcome`, `evaluate_pre_gate`,
  `SaveResult`, `ArgsTemplate`, `Substitution`, `SubstitutionOp`,
  `MaterializeError`, `materialize_args`
