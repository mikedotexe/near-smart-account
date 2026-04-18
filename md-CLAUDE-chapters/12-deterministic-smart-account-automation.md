# 12 · Deterministic smart-account automation

**Abstract.** This repo now has the first end-to-end shape for a
smart-account-native automation primitive on NEAR: the account stores durable
sequence templates, stores balance-trigger rules that point at those
templates, and lets the owner or an authorized executor start an eligible
trigger by spending their own transaction gas. The important claim is not
"the contract executes itself later." The claim is stronger and more precise:

> A smart account can act as a deterministic receipt-control plane.
> It can decide when downstream cross-contract work becomes eligible,
> who is allowed to start it, and in what exact order the resulting work is
> released.

This chapter memorializes the current mechanism, why it matters, what has
actually landed in code, and what remains research rather than settled
architecture.

## 1. The problem this mechanism is solving

NEAR gives strong semantics inside one receiver's receipt and much weaker
semantics across sibling receipts.

- One transaction to one receiver becomes one receipt.
- Multiple `Action`s in that receipt execute sequentially in one wasm
  lifecycle and revert together.
- Cross-contract calls create child receipts, and sibling children are not a
  user-facing sequencing primitive.

That means "I want B to start only after A has actually completed" is not a
native property of a general multi-step cross-contract intent.

The earlier historical `latch / conduct` work, followed by the current
`stage_call / run_sequence` path,
proved that NEP-519 yield/resume gives us a lever here: instead of letting all
downstream work begin immediately, the smart account can convert each intended
step into a yielded callback receipt and release those callbacks one by one.

That solved the sequencing problem.

The new automation layer solves the next problem:

> How can the smart account decide when such an ordered sequence should become
> runnable, while keeping execution aligned with the account owner's own
> authority and balance?

## 2. The key conceptual move

The intuition behind the current mechanism is:

> "Under these conditions, my account should be able to start the next staged
> sequence when I call into it."

The precise contract-level translation is:

- the smart account stores an **eligibility rule** in state
- the rule names a reusable ordered sequence of downstream calls
- the rule says when the account is sufficiently funded to run that sequence
- the owner or authorized executor prepays the transaction gas
- if the rule is eligible, the contract starts the sequence

So the operative model is **stateful eligibility plus authorized execution**.

This is not cron, and it is not spontaneous self-wakeup. Contracts on NEAR do
not autonomously wake up. The innovation lives in making the *right to start
deterministic receipt release* an on-chain, inspectable, authorization-aware
mechanism.

## 3. The mechanism in one paragraph

The smart account stores:

- a **sequence template**: an ordered list of downstream `FunctionCall`s
- a **balance trigger**: a rule that points at that template and becomes
  executable once the account balance is high enough

When an authorized caller invokes `execute_trigger(trigger_id)`:

1. the contract checks that the trigger is eligible and not already in flight
2. the template is materialized into a fresh staged namespace
3. the first step is resumed
4. each later step is resumed only after the previous downstream call settles

The result is not just "automation" in the abstract. It is:

> automated admission into an explicitly ordered cross-contract execution path

## 4. Current contract surface

The current implementation in `contracts/smart-account/src/lib.rs` has two
related surfaces.

### 4.1 Manual staged execution

This remains the base sequencing primitive:

- `stage_call(target_id, method_name, args, attached_deposit_yocto, gas_tgas, step_id, settle_policy?)`
- `run_sequence(caller_id, order)`
- `staged_calls_for(caller_id)`
- `has_staged_call(caller_id, step_id)`
- `get_authorized_executor()`
- `set_authorized_executor(account_id)`

This is the direct "user stages calls, then the account or its delegate starts
them in order" path.

### 4.2 Automation on top of staged execution

This is the new reusable layer:

- `save_sequence_template(sequence_id, calls)`
- `delete_sequence_template(sequence_id)`
- `get_sequence_template(sequence_id)`
- `list_sequence_templates()`
- `create_balance_trigger(trigger_id, sequence_id, min_balance_yocto, max_runs)`
- `delete_balance_trigger(trigger_id)`
- `get_balance_trigger(trigger_id)`
- `list_balance_triggers()`
- `execute_trigger(trigger_id)`

The important design choice is that automation does **not** bypass the staged
execution engine. It reuses it.

## 5. Internal execution model

The key refactor that made automation possible is the move from
caller-keyed staged state to a generic **sequence namespace**.

- manual runs live under `manual:{caller_id}`
- automation runs live under `auto:{trigger_id}:{run_nonce}`

That gives the contract a shared sequencing kernel with isolated run state.

### 5.1 Durable state now carried by the smart account

- `sequence_templates`
- `balance_triggers`
- `automation_runs`
- `staged_calls`
- `sequence_queue`

### 5.2 Why this is the right factoring

Without templates, repeated automation would just be a disguised one-shot
manual batch.

Without namespaces, repeated automation runs would collide with prior steps
and queues.

Without run records, we would lose the continuity needed to understand whether
automation succeeded, failed downstream, or failed before a later step could
resume.

## 6. A precise receipt-level reading of the mechanism

The mechanism is easiest to understand as two stacked layers.

### Layer A: rule admission

`execute_trigger(trigger_id)` does admission control:

- Is the caller authorized?
- Is the trigger known?
- Is it already in flight?
- Has it exhausted `max_runs`?
- Is the account balance high enough?

If yes, the contract manufactures a fresh staged sequence from the template.

### Layer B: deterministic release

Once the template has been materialized, the older staged-call semantics take
over:

- `on_stage_call_resume` dispatches the actual downstream call
- `on_stage_call_settled` looks at the callback result
- only then does the next step resume

This is the exact point of the construction:

> automation decides **when a sequence may begin**
>
> staged execution decides **how the sequence is released**

That separation is why this feels more like a smart-account control plane than
just another helper method.

## 7. What "sufficient gas available" means here

This needs to be stated carefully because it is the place where intuitive
language can drift away from protocol reality.

In the current mechanism, "sufficient gas available" does **not** mean:

- ambient unused protocol gas exists somewhere
- the contract can wake itself and consume that gas
- the chain is providing a free execution opportunity

It means:

- an authorized caller is willing to prepay gas for the transaction
- the smart account's balance makes the run eligible
- the contract has enough balance to cover any attached deposits in the
  sequence template

So the correct phrase is **balance-gated authorized execution**, not
protocol-native spare gas.

That is the salience worth keeping across sessions, because it keeps the
innovation grounded in what NEAR actually allows.

## 8. Why this is interesting in blockchain-native terms

The mechanism is novel for this repo because it combines four usually separate
ideas into one account-level primitive:

### 8.1 Account abstraction

The user calls their own contract first, not the final destination contract.
The smart account becomes the entrypoint for intent interpretation and release
control.

### 8.2 Stateful eligibility

The account does not simply expose imperative methods. It stores durable rules
that say when a reusable downstream sequence is allowed to begin.

### 8.3 Deterministic downstream sequencing

The account does not merely approve work. It determines the exact order in
which the downstream cross-contract calls are allowed to begin.

### 8.4 Durable reusable intent fragments

A sequence template is not a one-shot tx shape. It is a reusable on-chain
object that can be invoked by rules multiple times.

Put differently:

> the smart account is becoming a programmable scheduler for receipt release

That feels like the meaningful shift here.

## 9. Relation to earlier vernacular

Historically the repo walked through:

- `latch`
- `conduct`
- `gated_call`
- `stage_call`
- `run_sequence`

The more natural current vocabulary is:

- **sequence template**
- **balance trigger**
- **authorized executor**
- **execute trigger**
- **staged call**

That language is closer to how intelligent NEAR and web3 readers already
think:

- templates are durable intent shapes
- triggers are eligibility rules
- executors are authorized starters
- staged calls are deferred downstream actions

The lower-level protocol words `yield` and `resume` still matter, but they now
sit underneath a more legible smart-account surface.

## 10. What has actually been validated

The automation layer is now validated both **locally** and via **live testnet
runs**.

What is already solid:

- sequence-template CRUD
- trigger CRUD
- owner-only enforcement
- authorized-executor enforcement
- repeated runs with fresh namespaces
- coexistence of multiple triggers
- downstream-failure cleanup semantics
- resume-failure cleanup semantics
- owner-funded live execution on testnet
- delegated-executor live execution on testnet

What was already validated on testnet before this automation layer:

- yielded callback ordering in the earlier `latch / conduct` path
- real downstream ordered execution in the later `stage_call / run_sequence`
  path

So the repo is standing on proven sequencing mechanics and has now added
automation policy above them.

The new live automation reference runs are:

- owner-funded:
  `4xSDcvULr5kNyfLA4x56H6jmJZ6RKhsJcvNQCyB1Cj4S` →
  `HZuMYmPZydUmhnvchDUkQ7dawzFCssDA1gfp4nUUM43b` →
  `A9n6vFH5Z3p95PfSjw1f8CMpcGDhZ7pW974XUteMbYng`
  at blocks `246237303`, `246237309`, `246237313`
- delegated executor:
  `EqedsEmruHr3cnTUFnnTHWdsPWYvS1YoEhmg9JEi19c9` authorizes
  `mike.testnet`, then
  `KpBqZqmoxHjNgN4prcgUBSPb9ZjSqvk88j8DaxkJJKj` →
  `5Da7Pg2pgKAG3XM4XCCrmirvjR69H7EjweCM8ivpRJZw` →
  `BujCoxFWMLWuQicTXwEe5Fk9s1iKYT9d52rLGtX7jyWe`
  at blocks `246237422`, `246237436`, `246237442`, `246237446`

In both runs, the downstream router/echo values resolved in strict declared
order across real receipts.

## 11. Current limits and honest caveats

This is still a v1 research primitive.

### 11.1 Balance trigger only

The current trigger model keys on the smart account's own native NEAR balance.
No price oracles, external state conditions, time windows, or hybrid guards
yet.

### 11.2 Function-call templates only

The automation template surface currently reuses the function-call shape, not
the richer action-set supported by `yield-sequencer` plans.

### 11.3 Authorized wakeup only

The contract still needs an external transaction to wake it up. That is a
protocol constraint, not a shortcoming of the design.

### 11.4 Trace classification note

Historically, `scripts/trace-tx.mjs` classified successful `execute_trigger`
transactions as `PENDING` because the tree preserves `pending_yield` nodes even
after their resumed descendants have completed.

That helper was tightened later to treat a yielded receipt as still pending
only when it remains an unresolved leaf. So current traces now classify these
successful automation runs as `FULL_SUCCESS`, while still preserving the yield
nodes in the rendered tree.

## 12. The right way to think about the next experiment

The next live experiment is not merely "does `execute_trigger` succeed."

The meaningful question is:

> once an owner or authorized executor starts a balance trigger on testnet, how
> far can we push the downstream call shapes while preserving the same ordered
> receipt cascade we have now proved for router-backed calls?

That is the path from "credible on-chain mechanism" to "genuinely novel smart
account primitive."

The helper for that experiment already exists:

```bash
./scripts/send-balance-trigger-router-demo.mjs \
  alpha:1 beta:2 gamma:3 \
  --owner-signer x.mike.testnet \
  --contract smart-account.x.mike.testnet \
  --router router.x.mike.testnet \
  --echo echo.x.mike.testnet
```

If a delegated executor is part of the experiment, call
`set_authorized_executor(Some("mike.testnet"))` first and add
`--executor-signer mike.testnet`.

Its JSON artifact output is now the continuity anchor for the first live runs,
and the next step is to use the same flow with richer downstream actions than
`router.route_echo`.

## 13. The durable thesis

The most important thing to carry forward from this moment in the repo is not
any single method name.

It is this thesis:

> On NEAR, a smart account can use yield/resume not just to defer execution,
> but to become an explicit control plane for cross-contract receipt release.
> If that control plane also carries durable eligibility rules and authorized
> execution, it starts to look like a programmable automation layer for
> ordered on-chain intent execution.

That is the current saliency. Everything else is implementation detail in
service of that claim.
