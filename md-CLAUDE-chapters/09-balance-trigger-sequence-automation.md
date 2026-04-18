# 09 · Balance-trigger sequence automation

**BLUF.** The `smart-account` contract now has a first automation layer on top
of staged execution:

- owners save durable ordered **sequence templates**
- owners create **balance triggers** that point at those templates
- the owner or an authorized executor can call `execute_trigger(trigger_id)`
  once the smart account's native NEAR balance is high enough
- the trigger materializes a fresh `auto:{trigger_id}:{run_nonce}` staged
  namespace and starts the sequence

This is the first contract shape in the repo that says:

"When this account has enough balance, an authorized caller may spend their
own transaction gas to start a real ordered sequence of downstream
cross-contract work."

## Public surface

The existing manual path is unchanged:

- `stage_call(target_id, method_name, args, attached_deposit_yocto, gas_tgas, step_id, settle_policy?)`
- `run_sequence(caller_id, order)`
- `staged_calls_for(caller_id)`
- `has_staged_call(caller_id, step_id)`
- `get_authorized_executor()`
- `set_authorized_executor(account_id)`

The new automation surface is:

- `save_sequence_template(sequence_id, calls)`
- `delete_sequence_template(sequence_id)`
- `get_sequence_template(sequence_id)`
- `list_sequence_templates()`
- `create_balance_trigger(trigger_id, sequence_id, min_balance_yocto, max_runs)`
- `delete_balance_trigger(trigger_id)`
- `get_balance_trigger(trigger_id)`
- `list_balance_triggers()`
- `execute_trigger(trigger_id)`

`calls` uses the same function-call shape as manual staged execution:
`step_id`, `target_id`, `method_name`, `args`, `attached_deposit_yocto`,
`gas_tgas`, and optional completion policy (`settle_policy` in code).

## Internal shape

The key internal refactor is that staged execution is no longer keyed directly
by caller account id. It is keyed by a generic **sequence namespace**:

- manual runs use `manual:{caller_id}`
- automation runs use `auto:{trigger_id}:{run_nonce}`

That lets the same staged callback machinery serve both flows while keeping
their state isolated.

New durable state now lives in the smart account:

- `sequence_templates`
- `balance_triggers`
- `automation_runs`

Each automation run persists:

- which trigger launched it
- which sequence template it used
- which executor started it
- its namespace / run nonce
- whether it finished as `Succeeded`, `DownstreamFailed`, or `ResumeFailed`

## Eligibility model

The trigger model is deliberately narrower now than the earlier runner-reward
experiment.

Each trigger stores:

- a `sequence_id`
- a `min_balance_yocto`
- a `max_runs`

At execution time the contract checks:

- the trigger exists
- the trigger is not already in flight
- `runs_started < max_runs`
- the caller is the owner or authorized executor
- the smart account's native NEAR balance is at least:
  `max(min_balance_yocto, template.total_attached_deposit_yocto)`

So the economic story is simple:

- the caller pays the transaction gas
- the smart account pays any downstream attached deposits
- no on-chain reward budget or fee schedule is involved

That makes the mechanism feel much closer to "my account decides when it is
ready to execute" than to a keeper market.

## Run lifecycle

`execute_trigger(trigger_id)` does four important things in one call:

1. validates authorization, trigger state, and balance eligibility
2. materializes fresh yielded staged calls from the referenced template
3. starts the ordered sequence under a fresh `auto:{trigger_id}:{run_nonce}`
   namespace
4. records that run in durable automation metadata

After that, the existing staged callbacks take over:

- `on_stage_call_resume` dispatches the real downstream call
- `on_stage_call_settled` waits for downstream completion before resuming the
  next step

When the run finishes or fails, the automation metadata is updated and
`in_flight` is cleared on the trigger. For automation namespaces, leftover
staged entries are also cleaned up so failed runs do not leak state.

## Demo path

The helper script is:

```bash
./scripts/send-balance-trigger-router-demo.mjs --dry
./scripts/send-balance-trigger-router-demo.mjs \
  alpha:1 beta:2 gamma:3 \
  --owner-signer x.mike.testnet \
  --contract smart-account.x.mike.testnet \
  --router router.x.mike.testnet \
  --echo echo.x.mike.testnet
```

If you want to test delegated execution, set
`set_authorized_executor(Some("mike.testnet"))` first and then pass
`--executor-signer mike.testnet`.

The helper performs three signed transactions in sequence:

- `save_sequence_template`
- `create_balance_trigger`
- `execute_trigger`

And it writes a JSON artifact file in `collab/artifacts/` with:

- tx hashes
- block heights
- decoded contract return values
- ready-to-run `trace-tx` commands

That artifact file is the continuity anchor for future testnet automation
runs.

## Verification

`cargo test -p smart-account` is green for:

- sequence-template CRUD and owner-only enforcement
- balance-trigger CRUD and owner-only enforcement
- `execute_trigger` rejecting unknown triggers, low balance, exhausted runs,
  already-in-flight triggers, and unauthorized callers
- repeated runs getting fresh namespaces
- multiple triggers coexisting
- downstream failure clearing `in_flight`
- missing-next-step cleanup marking `ResumeFailed`

Live testnet signal now exists too.

Owner-funded reference run:

- `save_sequence_template`:
  `4xSDcvULr5kNyfLA4x56H6jmJZ6RKhsJcvNQCyB1Cj4S` at block `246237303`
- `create_balance_trigger`:
  `HZuMYmPZydUmhnvchDUkQ7dawzFCssDA1gfp4nUUM43b` at block `246237309`
- `execute_trigger`:
  `A9n6vFH5Z3p95PfSjw1f8CMpcGDhZ7pW974XUteMbYng` at block `246237313`
- namespace:
  `auto:balance-trigger-mo3ofylb:1`
- proven downstream values in order:
  `1 -> 2 -> 3`

Delegated-executor reference run:

- `set_authorized_executor("mike.testnet")`:
  `EqedsEmruHr3cnTUFnnTHWdsPWYvS1YoEhmg9JEi19c9` at block `246237422`
- `save_sequence_template`:
  `KpBqZqmoxHjNgN4prcgUBSPb9ZjSqvk88j8DaxkJJKj` at block `246237436`
- `create_balance_trigger`:
  `5Da7Pg2pgKAG3XM4XCCrmirvjR69H7EjweCM8ivpRJZw` at block `246237442`
- `execute_trigger`:
  `BujCoxFWMLWuQicTXwEe5Fk9s1iKYT9d52rLGtX7jyWe` at block `246237446`
- namespace:
  `auto:balance-trigger-mo3ohnar:1`
- proven downstream values in order:
  `11 -> 22 -> 33`

Gas calibration also became clear on testnet:

- `execute_trigger` at `200 TGas` failed with
  `Exceeded the prepaid gas` on
  `ByLfa9S5TTrzNp4fz9fUpuQrjtA5g3kZypupesGzdJvv` at block `246237246`
- `execute_trigger` at `500 TGas` succeeded for both live runs above

So this is no longer just a local primitive. The ordered receipt cascade now
exists on testnet for both owner-funded and delegated-executor-funded
execution.
