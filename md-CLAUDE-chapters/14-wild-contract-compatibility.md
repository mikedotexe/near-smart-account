# 14 · Wild-contract compatibility

## BLUF

The staged smart-account kernel is now hardened for real-world protocols by
making compatibility a **per-call completion policy** (`settle_policy` in
code) instead of a silent assumption.

The core sequencing invariant stays narrow:

- a call in a sequence is allowed to advance only when the smart account sees
  one honest top-level success surface for that step

What changed is **where that truth comes from**:

- for well-behaved contracts, `Direct` policy trusts the target receipt itself
- for messy contracts, `Adapter` policy routes through a protocol-specific
  adapter that turns hidden async behavior into one truthful success/failure
  result before the smart account advances

The important conceptual correction is:

- missing or empty return values are mostly fine
- **hidden nested async work** is the real hazard in the wild
- the sequencing proof does not require a meaningful return payload; it
  requires a truthful callback-visible completion surface

This chapter captures the local hardening that landed in code:

- `SettlePolicy` on every staged/template call
- `wild-router` as the intentionally dishonest async demo protocol
- `demo-adapter` as the honest shim for that demo protocol
- `compat-adapter` as the real external-protocol adapter surface
- `send-balance-trigger-router-demo.mjs --mode direct|adapter|mixed` as the
  local workflow for probing the different regimes

## 1. The actual risk model

Until now, the smart-account sequencer already had one strong property:

- it does **not** care about a downstream contract returning a pretty typed
  payload

`on_stage_call_settled` advances on `Ok(bytes)` and halts on `Err(...)`. That
means these target behaviors are already acceptable in `Direct` mode:

- returns `u32`
- returns `String`
- returns `()`
- returns empty bytes
- returns some opaque JSON blob the smart account does not decode

Those are all still “receipt truth.”

The real danger appears when a target contract does this:

1. receives a top-level call
2. starts more cross-contract work internally
3. **does not return that promise chain**
4. returns success to its caller immediately

From the smart account’s point of view, that outer receipt now looks finished
even though the protocol’s real effect is still in flight. Sequencing on that
surface would be too optimistic.

So the wild-compatibility problem is not “we need semantic decoding.”
It is:

**we need an honest completion surface for protocols whose outer receipt does
not actually mean completion.**

The practical compatibility rubric is:

- no payload bytes or unit return: still fine in `Direct`
- a returned promise chain that truthfully covers the target's whole internal
  async path: still fine in `Direct`
- detached internal fan-out with a plain value or no value returned: the smart
  account still proves sequential release of downstream receipts, but not
  truthful protocol completion for that step
- for that last case, use `Adapter`

## 2. Per-call completion policy

The shared type now lives in `smart-account-types`:

```rust
pub enum SettlePolicy {
    Direct,
    Adapter { adapter_id: AccountId, adapter_method: String },
    Asserted,
}
```

This policy is carried per call in both:

- `stage_call(...)`
- `save_sequence_template(...)`

That is the right granularity because one sequence can mix:

- boring direct leaf calls
- protocol-specific adapter calls

without forcing a whole template into one global compatibility mode.

### `Direct`

Current behavior, preserved:

- smart account dispatches the raw target call
- `on_stage_call_settled` advances on direct receipt success
- empty/void success is acceptable

This is good enough for:

- simple leaf contracts
- honest contracts that return their promise chain properly
- many sync or single-hop NEAR methods

One implementation footnote: because `on_stage_call_settled` uses
`env::promise_result_checked(0, MAX_CALLBACK_RESULT_BYTES)`, an otherwise
successful downstream call with an oversized result is treated as failure by
the sequencer. That preserves ordering, but it narrows the implementation's
definition of successful settlement.

### `Adapter`

New behavior:

- smart account dispatches to `adapter_id.adapter_method`
- the adapter receives the raw target/method/args/deposit/gas as
  `AdapterDispatchInput`
- the adapter drives the messy protocol and returns one honest success/failure
  surface to the smart account

The sequencing kernel does **not** become protocol-aware. It still only knows:

- the adapter call succeeded
- or it failed

That is intentional. Protocol-specific truth stays in the adapter layer.

### `Asserted`

Reserved, but deliberately not implemented yet.

This keeps room for a future mode like:

- execute the call
- then perform a state assertion
- only advance if that assertion passes

For now, `Asserted` is rejected explicitly so the type surface can evolve
without pretending the behavior exists already.

This is also the next serious design frontier. `Adapter` is the right v1 answer
when the returned promise chain itself is the truthful completion surface.
`Asserted` becomes interesting for the harder cases where even a truthfully
returned promise chain is still not the surface we ultimately want to trust.

## 3. Kernel changes

The smart-account kernel in `contracts/smart-account/` did **not** change its
receipt semantics.

Still true:

- `ResumeFailed` means the yielded callback could not be resumed
- `DownstreamFailed` means the dispatched step failed at the receipt level
- `Succeeded` means the step chain completed and the next step may advance

What changed is the dispatch site inside `on_stage_call_resume`:

- `Direct` dispatches the raw `target_id.method_name(args)`
- `Adapter` dispatches the adapter call, which wraps that raw target call

Logs now also surface the dispatch mode so a trace makes the distinction
visible:

- `direct receiver.method`
- `adapter adapter.method wrapping receiver.method`

That matters because observability is part of the hardening story. Future trace
analysis should make it obvious whether a step ran directly or through a
compatibility adapter.

## 4. Repo-native dishonest async demo

To avoid hand-wavy reasoning, the repo now includes a deliberately messy
protocol contract:

- `contracts/wild-router/`

Its method:

- `route_echo_fire_and_forget(callee, n)`

does this:

1. records `last_started = Some(n)`
2. clears `last_finished`
3. starts `echo(n)` as a real cross-contract promise
4. schedules its own callback to mark `last_finished`
5. **returns immediately** with `"started:n"` instead of returning that promise

So the outer receipt lies by omission:

- it tells the caller “start succeeded”
- but it does **not** mean “the real downstream effect has settled”

This is the exact class of wild behavior that breaks naive sequencing.

## 5. The first adapter

The repo also now includes:

- `contracts/demo-adapter/`

Its first public method:

- `adapt_fire_and_forget_route_echo(call: AdapterDispatchInput)`

is intentionally narrow and explicit. It only supports the
`wild-router.route_echo_fire_and_forget` demo shape.

Its job is:

1. start the messy top-level wild-router call
2. wait for that outer receipt to succeed
3. poll `wild-router.get_last_finished()`
4. if the expected value appears, return success
5. if it never appears within the polling budget, panic and fail honestly

That means the smart account no longer sequences on:

- “wild-router said it started”

It sequences on:

- “the adapter observed the effect the wild-router call was supposed to cause”

This is the first real example of “adapter-first” hardening in the repo.

## 6. Gas posture

`Adapter` calls need more gas than `Direct` calls because the adapter itself
has to do work:

- start the messy target call
- run callbacks
- poll protocol state
- potentially repoll

So the smart-account kernel now reserves a fixed adapter overhead budget and
applies a lower max raw-target gas ceiling when `settle_policy = Adapter`.

That is the correct tradeoff:

- the call shape becomes safer
- the raw target budget becomes a little smaller

The point is not maximal gas throughput. The point is an honest completion
surface.

## 7. Local verification shape

The local test suite now covers the important compatibility invariants:

- `Direct` still behaves as before for simple leaf calls
- `Direct` accepts empty success bytes
- `Direct` still halts on downstream failure
- `Adapter` dispatches to the adapter contract rather than the raw target
- adapter success advances a sequence
- adapter failure halts a sequence as `DownstreamFailed`
- mixed-policy templates can coexist in one sequence namespace
- `Asserted` is explicitly rejected

This is a useful milestone because it means the repo no longer depends on a
verbal warning like “be careful with weird contracts.” The call itself now
declares its compatibility posture.

## 8. Demo workflow

The balance-trigger demo helper now exposes three regimes:

```bash
./scripts/send-balance-trigger-router-demo.mjs --dry --mode direct
./scripts/send-balance-trigger-router-demo.mjs --dry --mode adapter
./scripts/send-balance-trigger-router-demo.mjs --dry --mode mixed
```

Meaning:

- `direct`: every call is `router.route_echo`
- `adapter`: every call is `wild-router.route_echo_fire_and_forget`, wrapped by
  `demo-adapter`
- `mixed`: alternate direct and adapter-backed steps in one saved sequence

This is the right local workflow because it lets us compare:

- the simple honest path
- the messy path made honest by adaptation
- the mixed path that a real smart account would actually need

## 9. What this means philosophically

The smart account is becoming more than a staged execution queue.

It is turning into a **compatibility-aware receipt controller**:

- it can stage work
- it can sequence work
- and now it can express which downstream calls are safe to trust directly and
  which ones need an explicit truth-restoring layer

That feels closer to a real account-abstraction surface than the earlier echo
POCs, because real users do not only call contracts we wrote. They call
whatever exists on-chain, with all the uneven semantics that implies.

## 10. What remains open

This hardening is intentionally v1-sized.

Still open:

- generic adapter framework vs staying protocol-specific
- future `Asserted` policy shape
- whether some protocols should get first-class repo adapters
- whether traces / tooling should classify direct-vs-adapter steps visually
- live testnet validation of the `adapter` and `mixed` automation modes

The important thing is that the repo now has a clean conceptual split:

- sequencing kernel stays generic
- protocol weirdness lives in adapters

That is a strong place to continue from.
