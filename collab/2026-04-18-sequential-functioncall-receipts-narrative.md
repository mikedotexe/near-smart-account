# 2026-04-18 · Sequential release of downstream `FunctionCall` receipts via `yield / resume`

## The claim

This repo now has a concrete, traced proof that a NEAR smart account can
**synthesize sequential release of downstream `FunctionCall` receipts**.

That claim is intentionally narrow:

- we are **not** changing NEAR's scheduler
- we are **not** imposing global ordering on arbitrary receipts
- we **are** making the smart account decide when the next downstream receipt
  gets **created**

Sequential here means **workflow-level admission order**, not exclusive chain
execution. Unrelated receipts can still interleave, because NEAR cross-contract
execution remains asynchronous and independent.

Here, **settled** means:

> the smart account has observed callback-visible resolution of the specific
> promise chain it chose to trust

That does **not** mean global chain finality. And it does **not** imply that
arbitrary hidden downstream async effects are complete unless the completion
surface itself is truthful.

That last caveat is part of the theorem, not a footnote. It is why this repo
has both `Direct` and `Adapter` completion policies.

Another way to say the same boundary:

> the sequencing proof does not require a meaningful return payload; it
> requires a truthful callback-visible completion surface

## Why this matters on NEAR

NEAR is atomic at the **receipt** level, not at the level of "a transaction and
all of its eventual cross-contract descendants."

What NEAR gives us by default:

- one transaction to one receiver becomes one initial receipt
- batched Actions to the same receiver execute in that receipt as a unit
- a cross-contract call creates a **new receipt**

What NEAR does **not** give us by default:

- if a contract emits several downstream `FunctionCall` receipts, those
  siblings do not carry a strong user-intent guarantee like
  "A settles, then B is emitted, then C settles, then D is emitted"

So the design target here has been:

> if the user wants `A -> B -> C`, emit `B` only after `A`'s chosen completion
> surface resolves, and emit `C` only after `B`'s chosen completion surface
> resolves

That is a control-plane claim about **receipt creation**, not a claim about
exclusive occupancy of the chain.

## Why not just `A.then(B).then(C)`?

For a fixed linear workflow, plain callback chaining is already enough.

The extra thing `yield / resume` gives us is **decoupled staging and later
admission control**:

- one transaction can stage several intended steps first
- a later `run_sequence(...)` or `execute_trigger(...)` call can choose the
  order
- the smart account can refuse to emit the next real downstream call until the
  previous step's trusted completion surface resolves

So this repo is not claiming to have rediscovered callback chaining. The novel
part is:

> stage now, choose and admit later

That becomes especially useful once the same smart account also owns automation
state, compatibility policy, and delegated execution rights.

## Operational caveats up front

Readers usually look for these immediately, so they belong near the top:

- yielded continuations are not unbounded pauses; they can time out after about
  200 blocks if never resumed
- resume authority should be gatekept; in this repo,
  `run_sequence(...)` / `execute_trigger(...)` are restricted to the owner or
  an `authorized_executor`
- `env::promise_result_checked(0, MAX_CALLBACK_RESULT_BYTES)` is part of the
  completion predicate, so an otherwise-successful downstream call that returns
  an oversized payload will be treated as failed for sequencing purposes

## The abstraction we're actually building

ERC-4337 was the original inspiration, but the useful comparison is narrower
than "account abstraction" in the Ethereum sense.

What this repo is building is better described as **execution-abstraction**.
The account is not just changing how signatures are verified; it is becoming an
active runtime that stages, admits, and sequences its own downstream work.

That distinction is visible directly in the contract's roles:

- `owner_id` holds custody rights
- `authorized_executor` holds execution rights only

An authorized executor can drive already-staged work forward through
`run_sequence(...)` or `execute_trigger(...)`, but it cannot sign arbitrary
transactions as the account. That separation is part of the product shape, not
an incidental implementation detail.

## How the current code does it

The core path lives in
`contracts/smart-account/src/lib.rs`.

### 1. `stage_call(...)` stages a step by creating a yielded callback receipt

`stage_call(...)` does **not** immediately perform the downstream call.
Instead, it validates the request, stores the call metadata, allocates a
`YieldId`, and returns the yielded promise.

Current public surface:

```rust
pub fn stage_call(
    &mut self,
    target_id: AccountId,
    method_name: String,
    args: Base64VecU8,
    attached_deposit_yocto: U128,
    gas_tgas: u64,
    step_id: String,
    settle_policy: Option<SettlePolicy>,
) -> Promise {
    let caller = env::predecessor_account_id();
    let namespace = manual_namespace(&caller);
    let call = Self::sequence_call_from_raw(
        step_id,
        target_id,
        method_name,
        args.0,
        attached_deposit_yocto.0,
        gas_tgas,
        settle_policy.unwrap_or_default(),
    );
    self.register_staged_yield_in_namespace(&namespace, call)
}
```

The yielded callback is created in the internal registration helper:

```rust
fn register_staged_yield_in_namespace(
    &mut self,
    sequence_namespace: &str,
    call: SequenceCall,
) -> Promise {
    let key = staged_call_key(sequence_namespace, &call.step_id);
    assert!(
        self.staged_calls.get(&key).is_none(),
        "step_id already staged for this sequence"
    );

    let callback_args = Self::encode_callback_args(sequence_namespace, &call.step_id);
    let (yield_promise, yield_id) = Promise::new_yield(
        "on_stage_call_resume",
        callback_args,
        resume_callback_gas,
        GasWeight::default(),
    );

    self.staged_calls.insert(
        key,
        StagedCall {
            yield_id,
            call,
            created_at_ms: env::block_timestamp_ms(),
        },
    );

    yield_promise
}
```

That is the key staging act. After `stage_call(...)`, the downstream call does
not yet exist as a real outbound `FunctionCall` receipt. What exists is a
yielded callback receipt that is **waiting for resume**.

### 2. `run_sequence(...)` or `execute_trigger(...)` chooses the order

Once several steps are staged, the smart account chooses an order and resumes
**only the first step**.

Manual path:

- `run_sequence(caller_id, order)`

Automation path:

- `execute_trigger(trigger_id)`

Both converge on:

- `start_sequence_release_in_namespace(...)`

That helper validates the proposed order, stores the tail as a queue, and
resumes only the head step:

```rust
fn start_sequence_release_in_namespace(
    &mut self,
    sequence_namespace: &str,
    order: Vec<String>,
) -> u32 {
    assert!(!order.is_empty(), "order cannot be empty");
    assert!(
        self.sequence_queue.get(sequence_namespace).is_none(),
        "sequence already has a run in flight"
    );

    for step_id in &order {
        assert!(
            self.staged_calls
                .get(&staged_call_key(sequence_namespace, step_id))
                .is_some(),
            "step_id '{step_id}' not staged for this sequence"
        );
    }

    let first = order[0].clone();
    let rest = order[1..].to_vec();
    if !rest.is_empty() {
        self.sequence_queue.insert(sequence_namespace.to_owned(), rest);
    }

    self.resume_staged_step(sequence_namespace, &first)
        .unwrap_or_else(|message| env::panic_str(&message));

    order.len() as u32
}
```

This is where the smart account takes control of **admission order**. It does
not emit all downstream work. It resumes one staged step and leaves the rest
waiting.

### 3. `on_stage_call_resume(...)` emits the real downstream call

When the yielded callback wakes up, `on_stage_call_resume(...)` runs.

That callback:

1. reloads the staged step
2. handles resume failure explicitly
3. dispatches the real downstream promise
4. chains `.then(on_stage_call_settled(...))`

```rust
#[private]
pub fn on_stage_call_resume(
    &mut self,
    sequence_namespace: String,
    step_id: String,
    #[callback_result] resume_signal: Result<(), PromiseError>,
) -> PromiseOrValue<()> {
    let key = staged_call_key(&sequence_namespace, &step_id);
    let Some(staged) = self.staged_calls.get(&key).cloned() else {
        return PromiseOrValue::Value(());
    };

    if let Err(error) = resume_signal {
        self.staged_calls.remove(&key);
        self.sequence_queue.remove(&sequence_namespace);
        self.finish_automation_run(
            &sequence_namespace,
            AutomationRunStatus::ResumeFailed,
            Some(step_id.clone()),
        );
        env::log_str(&format!(
            "stage_call '{step_id}' in {sequence_namespace} could not resume: {error:?}"
        ));
        return PromiseOrValue::Value(());
    }

    let finish_args = Self::encode_callback_args(&sequence_namespace, &step_id);
    let downstream = Self::dispatch_promise_for_call(&staged.call);
    let finish = Promise::new(env::current_account_id()).function_call(
        "on_stage_call_settled",
        finish_args,
        NearToken::from_yoctonear(0),
        Gas::from_tgas(STAGE_SETTLE_CALLBACK_GAS_TGAS),
    );
    PromiseOrValue::Promise(downstream.then(finish))
}
```

This is the moment where the next real downstream `FunctionCall` receipt is
actually **created**.

### 4. `on_stage_call_settled(...)` is the sequencing gate

This is the step that turns staging plus resume into an ordered release
mechanism.

The settle callback does:

```rust
let result = env::promise_result_checked(0, MAX_CALLBACK_RESULT_BYTES);
```

and then:

- on `Ok(bytes)`: mark the current step done and resume the next waiting step
- on `Err(error)`: halt ordered release and mark the run failed

Current shape:

```rust
#[private]
pub fn on_stage_call_settled(&mut self, sequence_namespace: String, step_id: String) {
    let key = staged_call_key(&sequence_namespace, &step_id);
    let dispatch_summary = self
        .staged_calls
        .get(&key)
        .map(|staged| Self::call_dispatch_summary(&staged.call))
        .unwrap_or_else(|| "unknown dispatch".to_string());
    let result = env::promise_result_checked(0, MAX_CALLBACK_RESULT_BYTES);

    self.staged_calls.remove(&key);

    match result {
        Ok(bytes) => {
            self.progress_sequence_after_successful_settlement(
                &sequence_namespace,
                &step_id,
                &dispatch_summary,
                bytes.len(),
            );
        }
        Err(error) => {
            self.sequence_queue.remove(&sequence_namespace);
            self.finish_automation_run(
                &sequence_namespace,
                AutomationRunStatus::DownstreamFailed,
                Some(step_id.clone()),
            );
            env::log_str(&format!(
                "stage_call '{step_id}' in {sequence_namespace} failed downstream via {}; ordered release stopped here: {error:?}",
                dispatch_summary
            ));
        }
    }
}
```

This is the theorem in code form:

> the next real downstream receipt is not created until the previous step's
> trusted completion surface resolves

One subtle but important consequence: because this uses
`promise_result_checked(0, MAX_CALLBACK_RESULT_BYTES)`, the size cap is part of
the completion predicate. An oversized success payload is sequencer-failure,
not sequencer-success.

## `Direct` vs `Adapter` is part of the theorem

The sequencer can only be as truthful as the completion surface it observes.

The clean compatibility rule is:

- no payload bytes or unit return: still fine
- returned promise chain that truthfully covers the whole internal async path:
  still fine
- detached internal fan-out with a plain value or no value returned: sequencing
  still holds at the receipt-release layer, but no longer proves truthful
  protocol completion

That is exactly why the `Direct` / `Adapter` split exists.

For well-behaved targets, `Direct` is enough:

- the smart account dispatches the target directly
- `on_stage_call_settled(...)` trusts that resulting promise chain

For messy async targets, `Adapter` is the honest mode:

- the smart account dispatches to a protocol-specific adapter
- the adapter drives the real protocol path
- the adapter returns success only after the intended effect is actually
  visible

So the claim is **not** "receipt success always means the workflow step is
really done." The claim is:

> the smart account sequences against the completion surface it explicitly chose
> to trust

That is why `Direct` and `Adapter` belong in the core model, not in a side
appendix.

One implementation footnote is also worth making explicit: because
`on_stage_call_settled(...)` uses
`env::promise_result_checked(0, MAX_CALLBACK_RESULT_BYTES)`, an otherwise
successful downstream call that returns an oversized payload is treated as
sequencer failure. That preserves ordering, but it narrows the implementation's
definition of successful settlement.

## Canonical traced proof

The cleanest canonical proof in the repo is the owner-funded router/echo
automation run on 2026-04-18:

- `save_sequence_template`
  `4xSDcvULr5kNyfLA4x56H6jmJZ6RKhsJcvNQCyB1Cj4S` at block `246237303`
- `create_balance_trigger`
  `HZuMYmPZydUmhnvchDUkQ7dawzFCssDA1gfp4nUUM43b` at block `246237309`
- `execute_trigger`
  `A9n6vFH5Z3p95PfSjw1f8CMpcGDhZ7pW974XUteMbYng` at block `246237313`

The block-by-block receipt cascade is:

- `246237315` -> `on_stage_call_resume(alpha)`
- `246237316` -> `router.route_echo(n=1)`
- `246237317` -> `echo(n=1)`
- `246237318` -> `on_stage_call_settled(alpha)`
- `246237319` -> `on_stage_call_resume(beta)`
- `246237320` -> `router.route_echo(n=2)`
- `246237321` -> `echo(n=2)`
- `246237322` -> `on_stage_call_settled(beta)`
- `246237323` -> `on_stage_call_resume(gamma)`
- `246237324` -> `router.route_echo(n=3)`
- `246237325` -> `echo(n=3)`
- `246237326` -> `on_stage_call_settled(gamma)`

This is the clearest on-chain proof of the mechanism because:

- each next downstream call is emitted only after the prior step's settle
  callback runs
- the downstream work is real cross-contract work, not just a yielded callback
  demo
- the path is simple enough that the receipt order is easy to audit by eye

This is the main trace to carry in the body of the argument.

## Why yield remains canonical in this repo

In principle, we could sequence without yield:

1. store staged call specs in state
2. let `run_sequence(...)` dispatch the first downstream call directly
3. let `on_stage_call_settled(...)` dispatch the next one directly

That would still preserve ordered release.

We are intentionally **not** doing that here, for two reasons:

1. `yield / resume` is the actual NEAR-native primitive that makes "stage now,
   admit later" explicit
2. the yielded callback receipts created by `stage_call(...)` preserve the
   original staging transaction's receipt tree, which makes tracing and
   explaining the cascade much cleaner

So the repo's thesis is not "yield happens to be one way to do it." It is:

> yield is the canonical staging primitive; sequence execution is the ordered
> release of those yielded continuations

## Appendix A: Additional corroborating runs

The canonical trace above is enough to make the core argument. The runs below
are corroborating evidence.

### A1. Earliest proof: yielded callbacks can be resumed in a chosen order

This was the pre-smart-account `latch / conduct` experiment:

- latch tx
  `4ct5RA1d4x9efJXWGxPBQRLhsPtKxw453wGpP6F8WZ3L`
- conduct tx
  `BW3fmRbzZGFdFrE37uxX2cMzHj6Ur1mG7FCEmjAXKVmT`

The key ordering proof lived on the original latch tx's yielded callbacks:

- `246214777` -> resumed callback `beta`
- `246214778` -> resumed callback `alpha`
- `246214779` -> resumed callback `gamma`

That proved deliberate resume order before the current smart-account surface
existed.

### A2. Delegated execution still preserves ordered release

After setting `authorized_executor = mike.testnet`, the delegated run:

- `KpBqZqmoxHjNgN4prcgUBSPb9ZjSqvk88j8DaxkJJKj`
- `5Da7Pg2pgKAG3XM4XCCrmirvjR69H7EjweCM8ivpRJZw`
- `BujCoxFWMLWuQicTXwEe5Fk9s1iKYT9d52rLGtX7jyWe`

proved the same strict `alpha -> beta -> gamma` downstream order over real
router/echo calls. The sequencing primitive does not depend on the owner
personally submitting the release call.

### A3. Mixed `Direct` + `Adapter` sequencing

Mixed adapter run:

- `save_sequence_template`
  `E8y2c7gLYtZ8fKpWg3C8YT24WHx8r6PCCg1y9syjf4PD`
- `create_balance_trigger`
  `5jnFcKjx4knwYxcyapSEpcdbqtLjeBSUtMmFZzRXXT75`
- `execute_trigger`
  `3EJfbHjutASzsQQzdbb3WErDFMSbZZnzhxT5ZneHpiKR`

This run mattered because:

1. `alpha` ran in `Direct` mode
2. `beta` ran through an adapter
3. `gamma` did not start until the adapter-backed `beta` step returned a
   truthful top-level result

That is the proof that compatibility policy is not bolted on after the fact; it
participates directly in the sequencing theorem.

### A4. Real external protocol proof: `wrap.testnet`

The strongest external proof so far is the mixed wrap run:

- `save_sequence_template`
  `AoGCbsU7SekiZ5MAwDRFmd8LhHJ6HNQKnyLV5LaC1NS7`
- `create_balance_trigger`
  `DkEbAYgZttyUssQytGKQKSVXn27bdyQfwpjsN7yUA8vT`
- `execute_trigger`
  `3MKbDCngBqKake71a8SDLtv8HvixnfeDZBt4HSKwaxaf`

The important part of the `beta` step was:

- `246311076` -> smart account dispatches to `compat-adapter`
- `246311077` -> adapter calls `wrap.testnet.near_deposit`
- `246311078` -> adapter callback
- `246311079` -> adapter calls `wrap.testnet.ft_transfer`
- `246311080` -> adapter callback
- `246311081` -> smart account `on_stage_call_settled(beta)`

The smart account did **not** advance when the adapter started, and it did
**not** advance after the first hop. It advanced only after the full
`near_deposit -> ft_transfer` path returned a truthful final result.

## Questions and simplifications this writeup surfaced

Explaining the mechanism in this tighter form still leaves a few good questions:

1. Is the parent-receipt lineage of `yield_id.resume(...)` a spec-level
   guarantee, or just a current implementation property we should not lean on
   too hard?
2. Should the sequencing kernel eventually live in a dedicated internal module,
   separate from the broader smart-account contract file?
3. Should the queue move from front-popping `Vec<String>` to a more explicitly
   queue-shaped representation?
4. Is there a useful SDK or protocol affordance for "resume with extra gas," or
   is re-staging the right answer?

The next design frontier after `Adapter` is likely `Asserted`: cases where even
the returned promise chain is not the completion surface we actually trust, so
the sequencer should wait for an explicit post-call assertion before advancing.

The mechanism itself feels technically solid. Most of the remaining work is
about tightening terminology, compatibility boundaries, and observability
contracts.

## Bottom line

The defensible claim is:

> a NEAR smart account can stage intended downstream calls first, then emit the
> next real downstream `FunctionCall` receipt only after the previous step's
> chosen completion surface resolves

That is not global receipt ordering.
That is not a scheduler change.
That is not exclusive uninterrupted execution.

It is **deterministic admission control over downstream receipt creation**.

And in this repo, it is now backed by traced code paths and live testnet runs.
