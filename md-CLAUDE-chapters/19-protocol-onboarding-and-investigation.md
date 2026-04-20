# 19 · Protocol onboarding and investigation

## BLUF

The repo now has enough live signal that protocol onboarding should be a
repeatable operator workflow, not just a design instinct.

The workflow is:

1. identify the step we want to sequence
2. choose the resolution policy that gives one honest resolution surface
3. run the smallest useful probe
4. investigate that tx across the three surfaces
5. keep the resulting evidence with the conclusion

That is what [`PROTOCOL-ONBOARDING.md`](../PROTOCOL-ONBOARDING.md) is for.
This chapter explains why the guide is shaped that way, how the new
`scripts/investigate-tx.mjs` wrapper fits into the repo's existing
observability method, and why `pathological-router` now sits beside
`wild-router` and `wrap.testnet` as a public onboarding probe surface.

## 1. Why the guide exists

The smart-account claim is now narrow and stable:

> the account creates the next real `FunctionCall` receipt only after the
> previous step's trusted resolution surface resolves

That claim is easy to over-apply if we do not make the trust boundary explicit.
The boundary is not “did the target return a meaningful value?” The boundary
is “did the smart account observe a truthful resolution surface for the step it
is trying to sequence?”

So the operator problem is not just “how do I call this?” It is:

- what exactly is the step?
- what is the truthful resolution surface for that step?
- how do I prove it with receipts, block-pinned state, and activity rows?

The onboarding guide answers those questions in a short form. This chapter is
the longer rationale behind it.

## 2. Runtime truth behind the compatibility rubric

The practical compatibility rubric is:

- empty or unit success is fine in `Direct`
- a returned promise chain that truthfully covers the full async path is also
  fine in `Direct`
- detached nested async requires `Adapter`
- harder state/postcondition cases point toward future `Asserted`

That rubric comes straight from the runtime model.

### Empty success is okay

The sequencer advances on callback-visible success or failure. It does **not**
need a semantically rich payload. A target can return:

- `()`
- empty bytes
- a string
- JSON
- any other byte payload smaller than the configured callback limit

and `Direct` can still be honest enough, as long as the receipt itself means
the step is done.

### Detached async is the real danger

The real failure mode is a target that:

1. receives the top-level call
2. starts more async work
3. does **not** return that promise chain
4. returns plain success to its caller anyway

In that shape, the outer receipt can succeed before the protocol effect is
actually complete. Sequencing still holds at the receipt-release layer, but the
resolution surface is too weak to represent the protocol step honestly.

That is exactly why `Adapter` exists.

### Oversized success is an implementation boundary

One concrete implementation detail matters here too: the smart account uses
`env::promise_result_checked(0, MAX_CALLBACK_RESULT_BYTES)`. That means an
otherwise successful downstream result that exceeds the callback-size limit is
treated as failure by the sequencer.

That does not weaken the sequencing claim, but it does mean the current
implementation's definition of successful resolution is slightly narrower than
the protocol runtime's broadest notion of success.

## 3. Canonical onboarding walk-through

The most useful current walk-through is the mixed `wrap.testnet` probe:

- tx: `3MKbDCngBqKake71a8SDLtv8HvixnfeDZBt4HSKwaxaf`
- signer: `x.mike.testnet`
- included block: `246311067`

Why this is the right example:

- it uses a real external protocol we did not write
- it mixes `Direct` and `Adapter` in one sequence
- it exercises both simple and protocol-specific resolution surfaces

### Step classification

For that run:

- `register` is `Direct`
  because `wrap.testnet.storage_deposit` is already an honest leaf-style step
- `alpha` is `Direct`
  because `wrap.testnet.near_deposit` itself is the resolution surface we want
- `beta` is `Adapter`
  because the step we actually care about is
  `near_deposit -> ft_transfer back to the smart account`, and we want one
  top-level surface that only resolves after the forward is complete

### The next probe after `wild-router`

`wild-router` is still the smallest dishonest-async demo in the repo, but it
is no longer the only public probe surface.

`pathological-router` now complements it with shapes that matter when we are
onboarding unfamiliar protocols:

- `do_honest_work` gives a clean honest control
- `burn_gas` shows plain receipt failure from gas exhaustion
- `noop_claim_success` proves that a target can emit success without doing
  any real work
- `return_decoy_promise` shows how a caller can be fooled by a decoy returned
  promise while the real work detaches
- `return_oversized_payload` probes the current callback-size ceiling as part
  of the resolution predicate

That makes `pathological-router` part of the repo's public research apparatus,
not just a hidden lab stub.

The fast path for this surface is now `scripts/probe-pathological.mjs`. It is
intentionally a **Direct-pathology** probe, not a general demo runner. Its
documented preset names are runtime-facing:

- `control`
- `gas_exhaustion`
- `false_success`
- `decoy_returned_chain`
- `oversized_result`

Those names describe the observed execution/completion shape we are classifying,
which makes the output read more naturally to NEAR engineers than short internal
nicknames would.

### What the evidence should show

The conclusion we want is not merely “the tx succeeded.”
The conclusion is:

- the smart account resumed `register`
- then it resumed `alpha`
- then it resumed `beta`
- `beta` did not advance on raw `wrap.testnet` receipts alone
- `beta` advanced only after
  `compat-adapter.adapt_wrap_near_deposit_then_transfer(...)` returned its own
  honest result
- the smart account's wNEAR balance increased by the expected amount

That is exactly the sort of conclusion the onboarding guide tells operators to
write down explicitly.

## 4. `investigate-tx` and the three surfaces

Before `scripts/investigate-tx.mjs`, we already had the right observability
model:

- Surface 1: receipt DAG
- Surface 2: block-pinned contract state
- Surface 3: account activity feed

The problem was not missing capability. The problem was ergonomics: every new
investigation meant retyping the same 4–6 commands and manually reassembling
the results.

`investigate-tx` keeps the same model, but makes it one operation:

- trace the tx
- flatten its receipts and attach block/index metadata
- choose interesting blocks from the included block, receipt blocks, and
  optional trailing tail
- sample requested views at those interesting blocks
- pull activity rows for the requested accounts and separate rows for the
  investigated tx from unrelated rows that merely share the same block window
- parse structured `sa-automation` `EVENT_JSON:` logs into receipt-ordered
  events and summarize runs by namespace when that telemetry is present
- summarize yield-lifecycle and compact telemetry metrics like duration,
  resume latency, resolve latency, and max observed used gas
- emit one markdown report and one JSON artifact

The wrapper does **not** change the method. It packages the method so the
evidence becomes easier to collect and easier to compare later.

The account-wide companion is now `scripts/aggregate-runs.mjs`. It walks
FastNEAR account history, parses the same structured events, and gives one
cross-tx run summary for operators who care about automation telemetry across
time rather than one transaction at a time. The current shape is intentionally
markdown-first: summary table first, then transaction coverage, then detailed
per-run event rows.

## 5. Why JSON-first output matters

The wrapper is intentionally JSON-first internally, with markdown rendered from
that report object.

That choice matters because it keeps three future paths open:

- chapter-writing stays paste-and-annotate
- reproducible artifacts become easy to save under `collab/artifacts/`
- regression-style checks against known-good tx shapes become possible later

The important payload fields today are:

- tx summary
- receipt list with block heights and per-block receipt order
- cascade window summary
- state snapshots
- account activity rows
- rendered trace text

That is enough to support both human reading and future machine comparison
without making the wrapper overambitious.

Most JSON artifacts produced by this workflow stay local and ignored under
`collab/artifacts/`. The repo keeps only two curated checked-in examples:
one direct-style router automation report and one adapter-backed `wrap.testnet`
report.

## 6. What the guide deliberately does not promise

The onboarding guide is intentionally strict about a few things:

- it does not promise that `Direct` is good enough for every successful call
- it does not claim that sequential release means global chain ordering
- it does not treat protocol-specific truth as something the generic sequencer can
  infer automatically
- it does not collapse multi-tx saga analysis into one tool yet

Those are not missing ideas. They are deliberate boundaries so the operator
workflow stays honest.

## 7. Current recommended practice

For a new protocol, the healthiest current habit is:

1. start with the smallest single-step or mixed-step probe that exercises the
   real effect you care about
2. assume `Direct` only when the target receipt itself is clearly truthful
3. use `Adapter` as soon as the target's outer receipt looks capable of
   returning early
4. investigate the tx immediately and keep the evidence with the conclusion
5. if the conclusion depends on a protocol-specific assumption, write the
   assumption down in plain language

That last point is important. The value of the onboarding workflow is not just
that it helps us get green traces. It makes the trust boundary inspectable by
the next engineer who picks up the repo.
