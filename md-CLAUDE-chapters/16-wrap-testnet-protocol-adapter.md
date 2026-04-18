# 16 · Protocol-specific adapter path against `wrap.testnet`

**BLUF.** The adapter surface is no longer just a toy compatibility shim
around `wild-router`. We now have a live testnet proof that a staged sequence
can include one **real external protocol path** on `wrap.testnet`, with the
adapter expressing a protocol-specific multi-step action:

- direct `wrap.testnet.storage_deposit(...)`
- direct `wrap.testnet.near_deposit(...)`
- adapter-backed `wrap.testnet.near_deposit(...) -> wrap.testnet.ft_transfer(...)`

The important result is not only that the sequence succeeded. It is that the
smart account advanced past the adapter-backed step **only after** the adapter
finished the full `near_deposit -> ft_transfer` chain and returned one honest
top-level completion surface.

## 1. Why this chapter matters

Chapters 11 and 12 established two useful but incomplete facts:

- chapter 13: direct staged execution works against a real external protocol
  (`wrap.testnet`) with no adapter at all
- chapter 14: the adapter-first model works, but only against a repo-local
  dishonest-async demo (`wild-router`)

This chapter is the first place those two lines meet.

We are still sequencing on receipt truth, but now one of the receipts is a
protocol-specific external action rather than a toy payload. That is a much
stronger claim:

**the smart account can stage and order a real external protocol path, not
just arbitrary calls to contracts we wrote ourselves.**

## 2. The adapter shape

The new adapter surface in `contracts/compat-adapter/` is:

- `adapt_wrap_near_deposit_then_transfer(call)`

Its contract-level behaviour is:

1. receive attached NEAR from the smart account
2. call `wrap.testnet.near_deposit()` so the adapter temporarily mints wNEAR
   to itself
3. in the adapter callback, call
   `wrap.testnet.ft_transfer(receiver_id = predecessor, amount = minted_amount)`
4. return success to the smart account only after that transfer settles

The important design choice is that the adapter uses
`env::predecessor_account_id()` as the beneficiary. In this flow, the
predecessor is `smart-account.x.mike.testnet`, so the externally visible state
still accrues to the smart account, not the adapter.

That keeps the user-facing story crisp:

- the smart account remains the owner of the resulting wNEAR
- the adapter is just a protocol-specific execution surface
- the staged engine can still treat the adapter as one honest completion point

## 3. Reference run

Successful mixed run:

| Artifact | Value | Block |
|---|---|---|
| `save_sequence_template` | `AoGCbsU7SekiZ5MAwDRFmd8LhHJ6HNQKnyLV5LaC1NS7` | `246311057` |
| `create_balance_trigger` | `DkEbAYgZttyUssQytGKQKSVXn27bdyQfwpjsN7yUA8vT` | `246311063` |
| `execute_trigger` | `3MKbDCngBqKake71a8SDLtv8HvixnfeDZBt4HSKwaxaf` | `246311067` |
| sequence namespace | `auto:balance-trigger-mo4d7wjw:1` | — |
| balance before | `0.03 wNEAR` | verified pre-run |
| balance after | `0.06 wNEAR` | verified post-run |

The sequence itself:

| step | policy | downstream path | amount |
|---|---|---|---|
| `register` | Direct | `wrap.testnet.storage_deposit(account_id = smart-account.x.mike.testnet, registration_only = true)` | `1.25 mNEAR` |
| `alpha` | Direct | `wrap.testnet.near_deposit({})` | `0.01 NEAR` |
| `beta` | Adapter | `compat-adapter.adapt_wrap_near_deposit_then_transfer(...)` wrapping `wrap.testnet.near_deposit({}) -> wrap.testnet.ft_transfer(...)` | `0.02 NEAR` |

Because `smart-account.x.mike.testnet` was already registered on `wrap.testnet`,
the `register` step simply refunded its deposit and returned the normal
`StorageBalance` JSON.

## 4. The receipt-level proof

The interesting part of the run starts after `alpha` settles.

Key blocks:

| Block | Important receipt | Meaning |
|---|---|---|
| `246311068` | `execute_trigger` contract receipt | materializes the namespace and resumes `register` |
| `246311071` | `on_stage_call_settled(register)` | direct `storage_deposit` completed |
| `246311074` | `on_stage_call_settled(alpha)` | direct `near_deposit` completed |
| `246311076` | smart-account → compat-adapter | `beta` enters the protocol-specific adapter |
| `246311077` | compat-adapter → wrap | adapter calls `near_deposit` |
| `246311078` | compat-adapter callback | `on_wrap_near_deposit_started` |
| `246311079` | compat-adapter → wrap | adapter calls `ft_transfer` |
| `246311080` | compat-adapter callback | `on_wrap_ft_transfer_finished` |
| `246311081` | smart-account callback | `on_stage_call_settled(beta)` marks the sequence complete |

That is the critical ordering fact:

- `beta` did not complete when the adapter started
- it did not complete when `wrap.near_deposit` succeeded
- it completed only after `wrap.ft_transfer` had succeeded and the adapter's
  own final callback returned success

So the smart account's sequencing boundary now spans a **multi-step external
protocol action**, not just one leaf receipt.

## 5. Logs worth preserving

From the execute trace:

```text
log: stage_call 'alpha' resumed in auto:balance-trigger-mo4d7wjw:1 via direct wrap.testnet.near_deposit memo=None
log: Deposit 10000000000000000000000 NEAR to smart-account.x.mike.testnet
log: stage_call 'alpha' in auto:balance-trigger-mo4d7wjw:1 completed successfully via direct wrap.testnet.near_deposit (0 result bytes)

log: stage_call 'beta' resumed in auto:balance-trigger-mo4d7wjw:1 via adapter compat-adapter.x.mike.testnet.adapt_wrap_near_deposit_then_transfer wrapping wrap.testnet.near_deposit memo=None
log: Deposit 20000000000000000000000 NEAR to compat-adapter.x.mike.testnet
log: Transfer 20000000000000000000000 from compat-adapter.x.mike.testnet to smart-account.x.mike.testnet
log: Memo: compat-adapter forward to smart-account.x.mike.testnet
log: compat-adapter forwarded 20000000000000000000000 wNEAR yocto to smart-account.x.mike.testnet
log: stage_call 'beta' in auto:balance-trigger-mo4d7wjw:1 completed successfully via adapter compat-adapter.x.mike.testnet.adapt_wrap_near_deposit_then_transfer wrapping wrap.testnet.near_deposit (25 result bytes)
```

The logs tell a useful story:

- the direct path deposits straight into the smart account
- the adapter path intentionally deposits into the adapter first
- the adapter then forwards the resulting wNEAR to the smart account
- only after that forwarding step does the smart-account step settle

## 6. State verification

The helper artifact recorded:

| Account | Before | After |
|---|---|---|
| `smart-account.x.mike.testnet` | `30000000000000000000000` | `60000000000000000000000` |
| `compat-adapter.x.mike.testnet` | `0` | `0` |

So the net effect is exactly:

- `+0.01 wNEAR` from the direct step
- `+0.02 wNEAR` from the adapter-backed step
- no residual token balance left stranded on the adapter

This last point matters. It means the adapter is functioning as an execution
surface, not as a custody sink.

## 7. Gas calibration

The first live attempt failed at:

- `execute_trigger` hash
  `GjrXdmHSmCz24bA2g6u7WFxceFjT1oQmqMcNu7xjWUwM`
  at block `246311000`
  with `Exceeded the prepaid gas`

That run used `500 TGas` for `execute_trigger`.

The successful run used `800 TGas`.

The practical lesson is:

- `execute_trigger` gas must cover staging the whole namespace plus resuming
  the first step
- when one of those labels carries an adapter-wrapped target, the setup cost is
  materially higher than the earlier router-only demos

This does **not** mean the downstream protocol path is intrinsically too heavy.
It means the namespace-materialization + first-resume cost should be treated as
its own gas envelope and calibrated explicitly.

## 8. Why this is a better proof than the toy echo path

The router/echo demos were valuable because they isolated sequencing.
But they still lived entirely inside contracts we controlled.

This run is qualitatively stronger:

- `wrap.testnet` is real deployed chain code we did not write
- the direct step leaves externally visible FT state behind
- the adapter-backed step is no longer a synthetic “poll until internal state says 7”
  demo, but a concrete protocol-specific transfer path
- the final truth can be checked against an external ledger:
  `wrap.testnet.ft_balance_of("smart-account.x.mike.testnet")`

That makes the claim much more legible to other NEAR and web3 engineers:

**the smart account can order real protocol actions, and the adapter surface
can express one protocol-specific path as a single sequenced unit.**

## 9. Current limitations

- the helper still depends on the adapter account already being registered on
  `wrap.testnet`; the first failed live attempt took care of that preparation,
  and the successful run reused it
- this proof uses the owner as executor; delegated execution for the wrap path
  would be a natural follow-up

## 10. Recipe

```bash
# deploy the updated adapter if needed
near deploy compat-adapter.x.mike.testnet res/compat_adapter_local.wasm --networkId testnet

# dry-run the sequence shape
./scripts/send-balance-trigger-wrap-demo.mjs --dry --mode mixed alpha:0.01 beta:0.02

# live run
./scripts/send-balance-trigger-wrap-demo.mjs --mode mixed --execute-gas 800 alpha:0.01 beta:0.02

# verify trigger state
./scripts/state.mjs smart-account.x.mike.testnet \
  --method get_balance_trigger \
  --args '{"trigger_id":"balance-trigger-mo4d7wjw"}'

# verify the resulting external FT state
./scripts/state.mjs wrap.testnet \
  --method ft_balance_of \
  --args '{"account_id":"smart-account.x.mike.testnet"}'

# inspect the execute trace
./scripts/trace-tx.mjs 3MKbDCngBqKake71a8SDLtv8HvixnfeDZBt4HSKwaxaf x.mike.testnet --wait FINAL
```

## 11. What this promotes

Promotes:

- protocol-specific adapters are now meaningful against a real external
  protocol, not only repo-local mocks
- the adapter boundary can represent a multi-step protocol action while still
  giving the smart account one truthful completion surface
- using `env::predecessor_account_id()` inside the adapter is the right way to
  preserve the smart account as the visible beneficiary

Queues:

- delegated-executor validation of the same wrap path
- a richer external protocol than wNEAR, ideally one whose internal async
  behaviour is genuinely messy rather than merely multi-step
- a cleanup pass on `trace-tx.mjs` so successful automation runs do not render
  as `PENDING`
