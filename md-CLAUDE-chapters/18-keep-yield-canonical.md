# 18 · Keep yield canonical — a design note

> **In today's vocabulary.** This chapter argues why the kernel keeps
> NEP-519 `yield_promise` / `resume` as the canonical mechanism rather
> than collapsing it into a plain state-driven queue. The external
> surface has since been renamed to `execute_steps` / `register_step`
> / `run_steps`, and the callbacks became `on_step_resumed` /
> `on_step_resolved`, but the internal NEP-519 mechanics below are
> unchanged — the argument is about *what the mechanism is*, not
> about what we call it.

## The question

Once `yield_promise` was working reliably, an obvious simplification appeared:
why not remove `yield` entirely?

Mechanically, the smart-account kernel could do this:

1. `yield_promise(...)` would only store the downstream call spec in state
2. `run_sequence(...)` or `execute_trigger(...)` would dispatch the first real
   downstream `FunctionCall` directly
3. `on_promise_resolved(...)` would dispatch the next call directly

That would still preserve the important sequencing guarantee:

> downstream step B does not start until downstream step A has resolved

So the question was not "is no-yield sequencing possible?" It is.
The real question was "what do we lose if we do that?"

## Why we are keeping yield

We are intentionally keeping `yield / resume` canonical for the smart-account
path because yield is doing something meaningful, not accidental.

### 1. The yield transaction is part of the proof

With the current shape, the original multi-action yield transaction creates
one yielded callback receipt per yielded step.

That means the trace tells a clean story:

- the **yield tx** shows the yielded receipts being created
- the **resume / execute tx** shows ordered release beginning
- the **downstream receipts** show the real work

If we removed yield, the mechanism would still sequence correctly, but the
original yield transaction would lose that visible structure. The whole
cascade would attach to `run_sequence` or `execute_trigger` instead.

That would make the kernel smaller, but it would weaken one of the most novel
and teachable parts of the repo.

### 2. "Waiting for resume" is a real state, not just bookkeeping

A yielded promise in this repo is not merely "a saved call spec." It is a saved
call spec **plus a yielded callback receipt that is waiting to be released**.

That is a stronger and more NEAR-native statement.

It matches the current contract model:

- registration creates the yielded receipt
- release resumes exactly one yielded step
- progression happens only after resolution

That three-phase model is more explicit than a purely state-driven queue, even
if the queue-only design is implementable.

### 3. The repo is making a protocol-level claim, not only a product claim

The product claim is:

> a smart account can enforce ordered downstream execution

The protocol-level claim is stronger:

> NEP-519 yield/resume gives a smart account a direct lever over sibling
> receipt release

This repo exists to explore that second claim. Keeping yield canonical makes
the code, the traces, and the docs line up with what we are actually arguing.

## What we simplified instead

We did not keep the previous "yield is doing everything at once" feeling.
Instead, the kernel was reshaped so the internal phases are explicit:

- **registration**: validate and store the call, then allocate the yielded
  callback receipt
- **release**: resume exactly one stored step by `YieldId`
- **progression**: after downstream resolution, either release the next step
  or halt/finish the sequence

That is the right compromise for now:

- keep the proof surface
- keep the original-batch yielded descendants
- keep automation on the same mechanism
- remove ambiguity in the code shape

## Observability consequence

The trace tooling now renders yielded receipts that have not been resumed yet
as `waiting_for_resume`, while still keeping the internal `pending_yield`
classification logic.

That naming matters. It makes the yield tx read like an intentional control
plane:

- not "mysteriously pending"
- not "half failed"
- simply waiting for release

## Current decision

For this repo's smart-account kernel:

- `yield` remains mandatory for yielded sequencing
- there is no parallel no-yield execution mode
- `yield_promise` is intentionally the yielded receipt creation step
- `run_sequence` and `execute_trigger` are intentionally the release steps

If the project ever pivots from "prove the NEP-519 mechanism" to "ship the
smallest possible deterministic sequencer," this decision can be revisited.
For the current research arc, keeping yield canonical is the right shape.
