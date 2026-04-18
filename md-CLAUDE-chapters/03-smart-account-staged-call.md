# 03 · Smart-account staged call scaffold

**BLUF.** The `smart-account` contract now carries the first real
smart-account-side sequencing path:

- `stage_call(...)` stores a staged downstream `FunctionCall`
- `run_sequence(caller_id, order)` resumes the first step
- `on_stage_call_resume` dispatches the real downstream call
- `on_stage_call_settled` resumes the next step only after that downstream
  call has completed

That is the semantic upgrade we were aiming for after the inert historical
`latch(step_id)` proof. We are no longer only ordering yielded callbacks; we now
have a contract path that can order real cross-contract work.

The live testnet validation happened before this rename, so the historical tx
hashes in this chapter still correspond to the earlier experimental method
names `gated_call` and `conduct`. The current codebase now exposes that same
primitive as `stage_call` and `run_sequence`.

## 1. What landed locally

The implementation lives in `contracts/smart-account/src/lib.rs`.

New public methods:

- `stage_call(target_id, method_name, args, attached_deposit_yocto, gas_tgas, step_id, settle_policy?) -> Promise`
- `run_sequence(caller_id, order) -> u32`
- `get_authorized_executor() -> Option<AccountId>`
- `set_authorized_executor(Option<AccountId>)`
- `has_staged_call(caller_id, step_id) -> bool`
- `staged_calls_for(caller_id) -> Vec<StagedCallView>`

New private callbacks:

- `on_stage_call_resume(sequence_namespace, step_id, #[callback_result] Result<(), PromiseError>)`
- `on_stage_call_settled(sequence_namespace, step_id)`

## 2. Why this shape matters

The earlier `yield-sequencer::latch` proof showed that one multi-action tx can
manufacture multiple yielded callback receipts, and that a later `conduct`
call can wake those callbacks in a chosen order.

But the callbacks themselves were inert. They did not perform downstream work.

This new smart-account path changes that:

1. A user sends one tx with multiple `stage_call(...)` actions to the smart
   account.
2. Each action returns a yielded promise and becomes a waiting callback
   receipt.
3. `run_sequence(...)` resumes only the first step.
4. `on_stage_call_resume` dispatches the real downstream `FunctionCall`.
5. Only after that downstream call finishes does `on_stage_call_settled`
   resume the next step.

So the sequencing claim becomes:

> A completed, then B started, then B completed, then C started.

That is much closer to the intended smart-account / ERC-4337-style story.

## 3. Timeout and failure semantics

This path intentionally differs from the current inert `latch` POC in one
important way:

- `on_stage_call_resume` honors `#[callback_result]`
- if the yielded callback wakes up with `PromiseError`, the staged call is
  dropped and the active sequence queue is cleared
- if the downstream `FunctionCall` fails, the current call is removed and the
  active sequence queue is cleared
- later steps remain staged and can be run again in a fresh order

So timeout or failure stops the sequence; it does not masquerade as success.

## 4. Local verification that already passed

`cargo test -p smart-account` is green for:

- counter/status baseline still intact
- `stage_call` registers staged state
- duplicate steps are rejected
- over-max gas is rejected
- `run_sequence` rejects empty orders
- `run_sequence` rejects unknown steps
- `run_sequence` enforces owner / authorized-executor access

## 5. Validated testnet run

Validated live result on the shared rig:

- `smart-account.x.mike.testnet`
- `echo.x.mike.testnet`

The successful run on 2026-04-17 used one exact-max multi-action tx:

```bash
./scripts/send-staged-echo-demo.mjs \
  alpha:1 beta:2 gamma:3 delta:4 \
  --action-gas 250 \
  --call-gas 30 \
  --sequence-order beta,delta,alpha,gamma
```

That gives four staged actions at `250 TGas` each, for an exact
`1 PGas` total tx envelope.

## Live artifacts

- batch tx:
  `51quobuDJbeS2k7mMDRpwmjobeo1iRn1qnQDVQUeiJMk`
- sequence tx:
  `uq3mGK6H6JqJuVBZVPpTpFpEkuekEnhKwinJM4yssNT`
- batch tx block:
  `246221934`
- sequence tx block:
  `246222021`
- sequence contract receipt:
  `246222022`

The downstream `echo_log` receipts prove the declared order:

- `beta` echo receipt `DYyN9YYZgkRxDtHKvrPGBgwdiLDp9EE3QiXL3tE5Mbeo`
  executed at block `246222024`
- `delta` echo receipt `G2BpMPnhQRG5AqHaHyk8gKgnZiTVFfYvhiQvKfEbPHkC`
  executed at block `246222027`
- `alpha` echo receipt `9NUCWZ9ugMY3DFzCs2HyKgyKzdvJL5W5Fso1Q7rcyHNr`
  executed at block `246222030`
- `gamma` echo receipt `EGV17EG8BJKpSSmiFZdNoAdrPHgeBcX25CsrsnxqDe3q`
  executed at block `246222033`

That is the first real proof that the smart account can deterministically
order downstream cross-contract work, not just inert yielded callbacks.

## 6. Important gas-shape caveat

The new PV 83 `1 PGas` limit is real for the *overall* multi-action tx, but
the yielded-callback path is still sensitive to per-action gas shape:

- `Fn5tph4CuQxRCkw7c6qqqQyWXSuAaep8ckEZdPpepkWe`
  used `3 x 60 TGas` outer actions with `--call-gas 940` and failed
  `Exceeded the prepaid gas`
- `3K85KEmv8w4gZnMCKbodnVfYJ1fWCRFELo9TbMSEac2w`
  used `3 x 320 TGas` outer actions with `--call-gas 280` and also failed
  `Exceeded the prepaid gas`
- `6smJpHnQSNuBsKEFeEU8aZ7zyiW6vj6XB7xohyzeytLG`
  used `4 x 333 TGas` outer actions with `--call-gas 200`; the tx landed, but
  every yielded callback woke immediately with `PromiseError::Failed` instead
  of remaining staged for `run_sequence`

So the stable live recipe today is "spread the new `1 PGas` budget across
multiple yielded actions" rather than "push one yielded action up to
`940 TGas`".

## 7. Operational note

The validated run happened before `deploy-testnet.sh` switched to
`new_with_owner(owner_id = $MASTER)` for `smart-account`. Future deploys now
set the smart-account owner explicitly to the deploy parent, so
`set_authorized_executor(Some("mike.testnet"))` can be called from `$MASTER`
instead of the contract account.
