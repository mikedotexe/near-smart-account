# 2026-04-18 · `wrap.testnet` protocol-specific adapter live validation

## Summary

We replaced the toy `echo` payloads with one **real external protocol path**
against `wrap.testnet` and validated it live through the smart-account
automation surface.

The important outcome is:

- one label ran **directly** against `wrap.testnet.near_deposit`
- one label ran through the **protocol-specific adapter**
  `compat-adapter.adapt_wrap_near_deposit_then_transfer`
- the smart account only advanced after the adapter finished the full
  `near_deposit -> ft_transfer` chain
- `smart-account.x.mike.testnet`'s wNEAR balance moved from
  `0.03` to `0.06`
- `compat-adapter.x.mike.testnet` ended the run with `0 wNEAR`

This is the first live proof in this repo that the adapter surface is not just
for a repo-local dishonest-async toy. It can now express one concrete,
protocol-specific external path on testnet.

## Contract deploy

- redeployed `compat-adapter.x.mike.testnet`:
  `GbeYrNjRNWbcEere7bYKjGtjvgtMSQgQHKwu5fgnytcA`

## Gas calibration

The first live attempt showed that `execute_trigger` needed more headroom for
the three-step `register + direct + adapter` sequence:

- failed `execute_trigger` at `500 TGas`:
  `GjrXdmHSmCz24bA2g6u7WFxceFjT1oQmqMcNu7xjWUwM`
  at block `246311000`
  with `Exceeded the prepaid gas`

The successful retry used `800 TGas` for `execute_trigger`.

## Successful mixed run

Artifact:

- `collab/artifacts/2026-04-18T13-20-54-668Z-wrap-seq-mo4d7wjw-balance-trigger-mo4d7wjw.json`

Transactions:

- `save_sequence_template`:
  `AoGCbsU7SekiZ5MAwDRFmd8LhHJ6HNQKnyLV5LaC1NS7`
  at block `246311057`
- `create_balance_trigger`:
  `DkEbAYgZttyUssQytGKQKSVXn27bdyQfwpjsN7yUA8vT`
  at block `246311063`
- `execute_trigger`:
  `3MKbDCngBqKake71a8SDLtv8HvixnfeDZBt4HSKwaxaf`
  at block `246311067`

Sequence:

- `register`
  direct `wrap.testnet.storage_deposit(account_id = smart-account.x.mike.testnet, registration_only = true)`
- `alpha`
  direct `wrap.testnet.near_deposit({})` for `0.01 NEAR`
- `beta`
  adapter `compat-adapter.x.mike.testnet.adapt_wrap_near_deposit_then_transfer(...)`
  wrapping `wrap.testnet.near_deposit({})` for `0.02 NEAR`,
  then `wrap.testnet.ft_transfer(receiver_id = smart-account.x.mike.testnet, amount = 0.02 wNEAR)`

## Receipt-level shape

The execute tx's important receipt ticks:

- `246311068`
  `execute_trigger` contract receipt on `smart-account.x.mike.testnet`
- `246311071`
  `register` settle completes on smart-account
- `246311074`
  `alpha` settle completes on smart-account
- `246311076`
  smart-account dispatches `beta` to `compat-adapter.x.mike.testnet`
- `246311077`
  adapter calls `wrap.testnet.near_deposit`
- `246311078`
  adapter callback `on_wrap_near_deposit_started`
- `246311079`
  adapter calls `wrap.testnet.ft_transfer`
- `246311080`
  adapter callback `on_wrap_ft_transfer_finished`
- `246311081`
  smart-account `on_stage_call_settled(beta)` marks the sequence complete

This is the real signal:
the smart account did **not** advance on the adapter label when the adapter
started. It advanced only after the adapter had observed the full protocol path
and returned success.

## Balance verification

Before:

- `smart-account.x.mike.testnet`
  `30000000000000000000000` wNEAR
- `compat-adapter.x.mike.testnet`
  `0` wNEAR

After:

- `smart-account.x.mike.testnet`
  `60000000000000000000000` wNEAR
- `compat-adapter.x.mike.testnet`
  `0` wNEAR

So the run added exactly:

- `+0.01 wNEAR` from the direct `near_deposit`
- `+0.02 wNEAR` from the adapter-backed `near_deposit -> ft_transfer`

## Practical takeaways

- the protocol-specific adapter surface is now meaningful against a real
  external contract, not just the `wild-router` toy
- using `env::predecessor_account_id()` inside the adapter as the beneficiary
  is the right shape: the smart-account remains the visible owner of the
  resulting external state
- `execute_trigger` gas needs to be calibrated to the *sequence namespace
  materialization cost*, not just the downstream call cost
- `scripts/trace-tx.mjs` was later tightened so this same successful execute
  tx now classifies as `FULL_SUCCESS`
