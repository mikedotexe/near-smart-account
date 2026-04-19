# Archive — Real-world adapter lineage

Consolidated archive of four historical chapters that together
validated the smart-account's kernel against real external protocols
we did not write, surfaced the structural opacity of `Direct` settle,
proved the first live `Adapter` path, and landed the first
three-contract orchestration. Superseded by the current reference
chapters 14 (compatibility model), 19 (onboarding rationale), 20
(pathology taxonomy), and 21 (Asserted policy); preserved here
because the tx hashes, panic-text samples, and the
`Direct`-opacity / byte-count-signal observations are the evidence
behind those reference claims.

Original chapters, now merged:

- `13-stage-call-against-real-defi.md` — first probe against
  `wrap.testnet` (register + near_deposit × 2); cascade parity with
  echo
- `15-stage-call-wild-contract-semantics.md` — Promise-chain cost
  (`ft_transfer_call` extends cascade from 3 to 5 blocks per step)
  and the four-shape failure taxonomy that all collapse to
  `PromiseError::Failed`
- `16-wrap-testnet-protocol-adapter.md` — first live
  protocol-specific adapter path (`compat-adapter.adapt_wrap_near_deposit_then_transfer`)
- `17-stage-call-multi-contract-intent.md` — first three-contract
  orchestration (Ref Finance + wrap) producing RFT in Ref's internal
  ledger

Period-accurate terminology preserved. These chapters all ran after
the `stage_call` / `run_sequence` rename, so current method names
appear throughout. The contract's internal callback keying shifted
from `caller_id` to `sequence_namespace` during this era — a note
documented in §3.5.

## 1. The arc

The four runs compose a deliberate progression:

1. **Ch 13 — first contact.** Does the saga semantic work against a
   real external NEP-141 contract (`wrap.testnet`) we did not write?
   Yes. Three `stage_call` actions (`storage_deposit` + two
   `near_deposit`) drain cleanly, cascade shape is identical to the
   echo runs, smart-account ends with exactly `0.03 wNEAR`.
2. **Ch 15 — wild semantics.** What happens when a downstream returns
   a `Promise` chain, or when it fails in different ways? Cascade
   stretches to `3 + depth` blocks; four meaningfully-different
   failure shapes collapse to the same `PromiseError::Failed` at
   settle. `Direct` settle is structurally opaque — the exact
   motivation for chapter 14's `Adapter` policy.
3. **Ch 16 — first live adapter.** The adapter surface works against
   a real external protocol. A mixed run's `beta` step (Adapter) waits
   for `compat-adapter`'s internal `near_deposit → ft_transfer` chain
   to finish before settling — smart-account advances only after the
   full protocol action completes.
4. **Ch 17 — multi-contract orchestration.** Three contracts in one
   `run_sequence` (`ref-finance-101.testnet` + `wrap.testnet`). Run A
   halts exactly where §4 predicts (byte count `"0"`
   meant full refund, not zero used). Run B with 50 mNEAR storage
   headroom succeeds; smart-account's Ref internal ledger ends with
   3,256,629 base-units of RFT.

Together, these runs are the empirical base for the adapter-first
hardening model that chapter 14 documents as current reference.

## 2. Evidence index

| Run | Scenario | Batch tx | Release tx(s) | Block span |
|---|---|---|---|---|
| wrap first contact (ch 13) | register + 2 × `near_deposit`, all Direct, all succeed | `mrD3k8EGbb3vKMvq3zmtaynKnPukqhAGVU8uTFYuUrv` at `246239306` | `8gef1Kq29xJDKi3gonmxY9MEFP22mTWt3SR4To91GR4j` at `246239351` | 246239352–246239361 |
| Promise-chain probe (ch 15) | single `ft_transfer_call` → unreachable receiver → wrap refunds | `5ztxs7tDqiKCfuNR4phxBC3HNLNX8AtKjHcT6cNB82Br` at `246311710` | `EU3kuzXDqatta42oZeKyeQ2cDQeRorHmBfGE4jDuZkQR` | 246311751–246311755 |
| Four-failure probe (ch 15) | 4 distinct wrap failures, one single-label run each | `EARZWHSjGr3eRzjVhHbGgTiMRvc7Sn9gAsy329zrVmhM` at `246312389` | `6LR4QH…B7s8` (alpha), `F163VN…uJTM` (beta), `HF6Fjk…Hx2z` (gamma), `3kq3EB…vGcZ` (delta) | — |
| First live adapter (ch 16) | mixed: register (Direct) + alpha (Direct) + beta (Adapter wrap.near_deposit→ft_transfer) | `save_sequence_template` `AoGCbsU7SekiZ5MAwDRFmd8LhHJ6HNQKnyLV5LaC1NS7` at `246311057`; `create_balance_trigger` `DkEbAYgZttyUssQytGKQKSVXn27bdyQfwpjsN7yUA8vT` at `246311063` | `execute_trigger` `3MKbDCngBqKake71a8SDLtv8HvixnfeDZBt4HSKwaxaf` at `246311067` | 246311068–246311081 |
| Multi-contract run A (ch 17) | register (ref) + deposit (wrap→ref) + swap (ref) — halts at swap due to refunded deposit | `GBBF82Kqx6v2tA7WMpML6Tn38kY46oFrFadprHLnVkoz` at `246313277` | `8koUcSyPhSeENLRzAzJm6Jg41Q64mZBYtHGG6pEC6opX` | — |
| Multi-contract run B (ch 17) | bump_storage (50 mNEAR) + deposit_v2 + swap_v2 — all Ok | `E1sC2LVVio2iYku5Ti2ws3m8XNqb5sVJgKet367yeQGM` at `246313499` | `TzyV23fEgaZH4kuNJu4yebtHV3u9xZVmMhAhA2LZY3f` at `246313528` | cascade drained by ~246313556 |

All runs used `smart-account.x.mike.testnet` as the orchestrator.
External protocols: `wrap.testnet` (NEP-141 wNEAR),
`ref-finance-101.testnet` (Ref Finance testnet),
`rft.tokenfactory.testnet` (RFT token), and
`compat-adapter.x.mike.testnet` (the repo's real adapter).

## 3. First probe against a real protocol (ch 13)

### 3.1 The three actions

| label | downstream | attached deposit | gas | purpose |
|---|---|---|---|---|
| `register` | `wrap.testnet.storage_deposit({})` | 1.25 mNEAR | 50 TGas | NEP-145 register smart-account so later FT ops are accepted |
| `deposit_a` | `wrap.testnet.near_deposit({})` | 0.01 NEAR | 30 TGas | mint 0.01 wNEAR to predecessor (smart-account) |
| `deposit_b` | `wrap.testnet.near_deposit({})` | 0.02 NEAR | 30 TGas | mint another 0.02 wNEAR; cumulative 0.03 |

### 3.2 Four-questions scorecard

The four open questions at the start of the wild tranche:

| Question | Answer from this run |
|---|---|
| **Q1.** Is 30 TGas enough for a real DeFi method? | **Yes** for these methods. `near_deposit` ran at exactly 30 TGas with no "exceeded prepaid gas." `storage_deposit` was bumped to 50 TGas pre-emptively and used it cleanly. Actual usage was well under budget. |
| **Q2.** Does `promise_result_checked`'s byte count tell us anything useful? | **Sometimes.** `storage_deposit` returned 50 bytes (NEP-145 `StorageBalance` JSON). `near_deposit` returned 0 bytes (NEP-141 declares it as void). A non-zero byte count signals "structured payload available if you know the protocol." A zero is still a successful settle. |
| **Q3.** What happens with downstreams that return a `Promise`? | **Deferred to ch 15.** Neither `storage_deposit` nor `near_deposit` returns a `Promise`. See §4 for the `ft_transfer_call` probe. |
| **Q4.** How much does cross-shard receipt traffic stretch the cascade? | **Negligible.** Same 3-block-per-step cascade as echo. Cross-shard Data receipts land in the next-block slot just as same-shard receipts do. |

### 3.3 Cascade shape

Three identical 3-block cascade slices back to back, same shape as
the echo success cascade in
[`archive-staged-call-lineage.md`](./archive-staged-call-lineage.md)
§4. The resume → downstream → settle triplet per step is unchanged;
only the downstream contract identity changes.

The register cascade at blocks 353–355, as an example:

- `246239353`: resume Data + `on_stage_call_resume(register)` Action
- `246239354`: `wrap.testnet.storage_deposit({})` Action — success
- `246239355`: wrap-to-smart-account Data (50 bytes) + `on_stage_call_settled(register)` Ok branch

### 3.4 End state — exactly 0.03 wNEAR

```
$ scripts/state.mjs wrap.testnet --method ft_balance_of \
    --args '{"account_id":"smart-account.x.mike.testnet"}'
"30000000000000000000000"
```

First time in the repo the smart-account contract holds something
other than NEAR as a result of our orchestration.

### 3.5 Callback-args shape evolution note

The contract's internal callback keying had changed by this era:
earlier lineage callbacks took `caller_id` and `step_id`; from this
chapter onward callbacks take `sequence_namespace` and `step_id`,
with `manual:{caller_id}` as the implicit namespace for direct user
calls. Runtime behaviour unchanged; the per-caller key was
generalised to a per-namespace key to make room for
`auto:{trigger_id}:{run_nonce}` automation namespaces (see
[`archive-automation-lineage.md`](./archive-automation-lineage.md)
§3).

## 4. Wild-contract semantics — Promise chains and failure opacity (ch 15)

### 4.1 Promise-chain probe — `ft_transfer_call`

Single `stage_call`:

| label | downstream | attached | gas | expected outcome |
|---|---|---|---|---|
| `transfer` | `wrap.testnet.ft_transfer_call({receiver_id:"mike.testnet", amount:"10000000000000000000000", msg:""})` | 1 yocto | 100 TGas | wrap transfers 0.01 wNEAR → mike.testnet, calls `mike.ft_on_transfer` (no wasm → fails), wrap's `ft_resolve_transfer` refunds in full |

The receiver (`mike.testnet`) is storage-registered at wrap.testnet
but has no deployed wasm. NEP-141's defensive design: if the
receiver call fails, refund everything. The FT ledger shows a
two-block dip (0.06 → 0.05 wNEAR) then a full refund back to 0.06.

Settle saw `Ok("0")` — 3 bytes — the U128 wrap returns when the
receiver bounces.

### 4.2 Cascade length = 3 + Promise chain depth

Echo downstreams run in 3 blocks per step. `ft_transfer_call` runs
in 5. The two extra blocks are exactly `ft_on_transfer` +
`ft_resolve_transfer` — the chain that `ft_transfer_call`'s
returned `Promise` resolves through. NEAR's runtime substitutes the
eventual chain value for the function's return, so `.then(settle)`
sees the final result, not the immediate `Promise` handle.

### 4.3 Failure taxonomy — four shapes, one PromiseError::Failed

One batch, four `stage_call` actions designed to fail in distinct
ways against `wrap.testnet`:

| label | downstream | reason | wrap's actual error |
|---|---|---|---|
| `alpha` | `wrap.testnet.not_a_method({})` | method doesn't exist | `MethodResolveError: MethodNotFound` |
| `beta`  | `wrap.testnet.ft_transfer({receiver_id:"mike.testnet", amount:"1000000000000000000000000000000"})` | amount far exceeds smart-account's wNEAR balance | `Smart contract panicked: The account doesn't have enough balance` |
| `gamma` | `wrap.testnet.ft_transfer({receiver_id:"mike.testnet", amount:1})` | amount should be U128 string, not integer | `Smart contract panicked: Failed to deserialize input from JSON.: Error("invalid type: integer 1, expected a string", ...)` |
| `delta` | `wrap.testnet.storage_unregister({force:false})` | positive balance + no force → NEP-145 refuses | `Smart contract panicked: Can't unregister the account with the positive balance without force` |

The four cover the fundamentally different ways a real DeFi call can
fail: resolve-time (method not there), execution-time assertion,
deserialization, precondition refusal.

Settle log lines, side by side:

```
stage_call 'alpha' … failed downstream via direct wrap.testnet.not_a_method        … : Failed
stage_call 'beta'  … failed downstream via direct wrap.testnet.ft_transfer          … : Failed
stage_call 'gamma' … failed downstream via direct wrap.testnet.ft_transfer          … : Failed
stage_call 'delta' … failed downstream via direct wrap.testnet.storage_unregister … : Failed
```

Byte-for-byte identical except for label and method slots. The
contract code can do nothing else — `PromiseError` is
`#[non_exhaustive]` and only exposes `Failed` and `NotReady`.
Neither variant carries the panic text, the failure category, or
any downstream-specific information.

### 4.4 Where the panic text lives

The full error sits on the receipt outcome's `Failure` payload one
hop upstream, accessible at trace time:

| Surface | Sees panic text? |
|---|---|
| `scripts/trace-tx.mjs --json` (or raw `EXPERIMENTAL_tx_status`) | **Yes** — raw `{"FunctionCallError":{...}}` |
| `on_stage_call_settled` inside the contract | **No** — only `Err(PromiseError::Failed)` |
| `scripts/account-history.mjs` indexer feed | **Partial** — flags `not_success` but does not inline the panic text |

The deserialize-failure case is a particularly rich observability
artifact — it contains wrap.testnet's own source location
(`src/lib.rs:43:1`) and the exact serde parse error. None of that
survives the hop into `PromiseError::Failed`.

Cascade length is unchanged by failure: exactly 4 blocks per
single-label failure run (run_sequence contract receipt + resume
Data/Action + downstream Action with success=false + settle
Data/Action). Same shape as a successful echo cascade plus the
downstream's failure flag.

### 4.5 1-yocto refund is a free property

Three of the four labels (`beta`, `gamma`, `delta`) attach 1 yocto
to satisfy NEP-141's `assert_one_yocto`. NEAR's protocol-level
refund logic returns the attached deposit automatically when the
call fails, whether before or after `assert_one_yocto` ran:

```
✓ [refund]  Transfer(1)   (beta)
✓ [refund]  Transfer(1)   (gamma)
✓ [refund]  Transfer(1)   (delta)
```

Failed calls don't leak value. No refund logic required on our
side.

### 4.6 Direct settle is structurally opaque

The chapter's unifying insight:

- **On the success side**, settle sees the U128/JSON the downstream
  Promise chain resolves to. For `ft_transfer_call`, that's the
  refund-amount convention — interpretable only by an orchestrator
  that knows NEP-141. A general orchestrator cannot.
- **On the failure side**, settle sees only
  `Err(PromiseError::Failed)`. All four failure shapes are
  indistinguishable.

Both observations point at the same architectural conclusion:
**meaningful interpretation of downstream behaviour is
protocol-aware work that does not belong in the kernel.** Either
route through an `Adapter` that encodes the protocol's conventions,
or read the trace off-chain. This is the direct motivation for
chapter 14's `Adapter` policy.

The good news that bounds the cost: **saga halt is robust to all
five modes** (the four failures plus a Promise-chain failure).
Whatever the cause, the label gets removed and the queue clears.
Surviving labels remain pending, re-orchestrable. State never
wedges. Informational opacity is a tradeoff, not a wedge.

### 4.7 Refined Halt sub-taxonomy

Adding detail to the four-fates flowchart in chapter 11:

| Cause of Halt | Where it surfaces in the receipt DAG | Visible to settle? |
|---|---|---|
| Method doesn't exist on target | `MethodResolveError` on downstream Action | No |
| Runtime assertion in target | `ExecutionError` with custom panic message | No |
| Deserialization rejection | `ExecutionError` with serde panic message | No |
| Precondition refusal in target | `ExecutionError` with custom message | No |
| Inner Promise chain failure | `PromiseError::Failed` propagated through the chain | No |

All five funnel to the same on-chain settle behaviour.

## 5. First live adapter (ch 16)

### 5.1 The adapter shape

New adapter surface in `contracts/compat-adapter/`:

- `adapt_wrap_near_deposit_then_transfer(call)`

Behaviour:

1. receive attached NEAR from the smart account
2. call `wrap.testnet.near_deposit()` so the adapter temporarily
   mints wNEAR to itself
3. in the adapter callback, call
   `wrap.testnet.ft_transfer(receiver_id = predecessor, amount = minted_amount)`
4. return success to the smart account only after that transfer
   settles

The design choice that keeps the user-facing story crisp: the
adapter uses `env::predecessor_account_id()` as the beneficiary. In
this flow, the predecessor is `smart-account.x.mike.testnet`, so
externally visible state accrues to the smart account, not the
adapter. The adapter functions as an execution surface, not a
custody sink.

### 5.2 The reference run

Mixed sequence stored as a template and fired via a balance
trigger. Three steps:

| step | policy | downstream path |
|---|---|---|
| `register` | Direct | `wrap.testnet.storage_deposit(account_id = smart-account, registration_only = true)` |
| `alpha` | Direct | `wrap.testnet.near_deposit({})` (0.01 NEAR) |
| `beta` | Adapter | `compat-adapter.adapt_wrap_near_deposit_then_transfer(...)` wrapping `wrap.testnet.near_deposit({}) → wrap.testnet.ft_transfer(...)` (0.02 NEAR) |

Balance before: 0.03 wNEAR. After: 0.06 wNEAR. Adapter residual: 0.

### 5.3 The receipt-level proof

The critical ordering fact (blocks 076–081):

| Block | Receipt | Meaning |
|---|---|---|
| 246311076 | smart-account → compat-adapter | `beta` enters the adapter |
| 246311077 | compat-adapter → wrap | adapter calls `near_deposit` |
| 246311078 | compat-adapter callback | `on_wrap_near_deposit_started` |
| 246311079 | compat-adapter → wrap | adapter calls `ft_transfer` |
| 246311080 | compat-adapter callback | `on_wrap_ft_transfer_finished` |
| 246311081 | smart-account callback | `on_stage_call_settled(beta)` marks the sequence complete |

`beta` did not complete when the adapter started. It did not
complete when `wrap.near_deposit` succeeded. It completed **only
after** `wrap.ft_transfer` had succeeded and the adapter's final
callback returned success. The smart-account's sequencing boundary
now spans a multi-step external protocol action, not just one leaf
receipt.

### 5.4 Gas calibration

- `execute_trigger` at `500 TGas` failed (`Exceeded the prepaid gas`)
  on `GjrXdmHSmCz24bA2g6u7WFxceFjT1oQmqMcNu7xjWUwM` at block `246311000`
- `execute_trigger` at `800 TGas` succeeded for the reference run
  above

Namespace-materialization plus first-resume cost a material amount
when one of the labels carries an adapter-wrapped target. Treat the
setup cost as its own gas envelope and calibrate explicitly.

## 6. Multi-contract intent — register + deposit + swap (ch 17)

### 6.1 Run A — halt at swap (§4's regime in the wild)

The three Run A steps:

| label | downstream | attached | gas | purpose |
|---|---|---|---|---|
| `register` | `ref-finance-101.testnet.storage_deposit({})` | 1.02 mNEAR | 30 TGas | register smart-account at Ref |
| `deposit` | `wrap.testnet.ft_transfer_call({receiver_id:"ref-finance-101.testnet", amount:"5000000000000000000000", msg:""})` | 1 yocto | 100 TGas | deposit 0.005 wNEAR into Ref's ledger |
| `swap` | `ref-finance-101.testnet.swap({actions:[{pool_id:0, token_in:"wrap.testnet", token_out:"rft.tokenfactory.testnet", amount_in:"5000000000000000000000", min_amount_out:"0"}]})` | 1 yocto | 50 TGas | swap 0.005 wNEAR → RFT |

What happened:

| Step | Settle outcome | Bytes | What actually happened downstream |
|---|---|---|---|
| `register` | Ok | 50 | Ref returned `{"total":"1020000000000000000000","available":"0"}` — registered with zero headroom |
| `deposit` | **Ok** | **3** | ref.ft_on_transfer panicked with "E11: insufficient $NEAR storage deposit"; wrap's ft_resolve_transfer refunded 0.005 wNEAR back; `"0"` returned |
| `swap` | **Err** | — | ref.swap panicked with "E21: token not registered" because wNEAR was never actually deposited |

The `deposit` step settled `Ok` and advanced the sequence because
`Direct` settle only sees the terminal U128 from
`ft_resolve_transfer`. From settle's perspective, that U128 was
`"0"` — three bytes, perfectly valid `Ok` bytes. The meaning ("0
refund" vs "full refund" — the same literal through
`ft_resolve_transfer` for different reasons) is protocol-specific
knowledge that `Direct` settle does not have. **This is
§4.6's opacity manifest in a real multi-contract flow.**

Full panic text is preserved on the receipt DAG:

```
ref-finance-101.testnet.ft_on_transfer:
  Smart contract panicked: panicked at 'E11: insufficient $NEAR storage deposit',
  ref-exchange/src/account_deposit.rs:198:9

ref-finance-101.testnet.swap:
  Smart contract panicked: E21: token not registered
```

This is the clearest "real-world Adapter motivation" we have. An
`adapt_ft_transfer_call_to_ref(...)` that observes the actual
Ref-side deposit change (polling `ref.get_deposits`) rather than
trusting wrap's terminal U128 would let multi-contract flows
self-heal.

### 6.2 Run B — success with 50 mNEAR storage headroom

| label | downstream | attached | gas | change |
|---|---|---|---|---|
| `bump_storage` | `ref-finance-101.testnet.storage_deposit({registration_only:false})` | **50 mNEAR** | 30 TGas | top up storage so Ref can register wNEAR as a deposited token |
| `deposit_v2` | (same as `deposit`) | 1 yocto | 100 TGas | same payload, different outcome because `ft_on_transfer` no longer panics |
| `swap_v2` | (same as `swap`) | 1 yocto | 50 TGas | wNEAR now actually in Ref ledger, swap proceeds |

Outcomes:

| Step | Settle outcome | Bytes | Downstream result |
|---|---|---|---|
| `bump_storage` | Ok | 73 | `{"total":"51020000000000000000000","available":"50000000000000000000000"}` |
| `deposit_v2` | Ok | **24** | wrap's `ft_resolve_transfer` returned `"5000000000000000000000"` — full amount actually deposited |
| `swap_v2` | Ok | 9 | ref.swap returned `"3256629"` — 3,256,629 base-units of RFT minted into smart-account's Ref ledger |

Downstream swap logs from the receipt tree:

```
Swapped 5000000000000000000000 wrap.testnet for 3256629 rft.tokenfactory.testnet
Exchange ref-finance-101.testnet got 547027805436552366 shares, No referral fee
```

Price discovery: 0.005 wNEAR → 0.03256629 RFT, and Ref's LP fee
(0.04% of the trade) credited to the pool's share pot.

### 6.3 Byte-count deltas as weak protocol-specific signal

Comparing Run A's `deposit` (3 bytes, `"0"`) to Run B's
`deposit_v2` (24 bytes, `"5000000000000000000000"`) is evidence
that the byte count carries information here — `"0"` means "receiver
returned 0 used, so wrap refunded everything," and a large U128
means "receiver used the full amount." Usable but
**protocol-specific**: a general-purpose orchestrator still can't
act on it without encoding NEP-141 semantics. An `Adapter` that
knows the convention can.

### 6.4 Three external contracts, one `run_sequence`

Run B spans three different contracts:

- `smart-account.x.mike.testnet` (orchestrator)
- `ref-finance-101.testnet` (steps 1 and 3)
- `wrap.testnet` (step 2, with internal callback chain to
  `ref-finance-101.testnet.ft_on_transfer`)

…plus the implicit dependency on `rft.tokenfactory.testnet` (read
for metadata by Ref). State time-series across the cascade:

| Block | `get_deposits(smart-account)` at Ref | `ft_balance_of(smart-account)` at wrap |
|---|---|---|
| 246313499 (batch tx) | `{}` | `0.06 wNEAR` |
| 246313528 (run_sequence tx) | `{}` | `0.06 wNEAR` |
| after `bump_storage` settles | `{}` | `0.06 wNEAR` |
| after `deposit_v2` settles | `{"wrap.testnet":"5000000000000000000000"}` | **`0.055 wNEAR`** |
| after `swap_v2` settles | `{"wrap.testnet":"0","rft.tokenfactory.testnet":"3256629"}` | `0.055 wNEAR` |

Two distinct external state surfaces moved observably — the NEP-141
wallet on wrap.testnet and the internal deposit ledger on
ref-finance-101.testnet. The same three-surfaces methodology
(receipt DAG + smart-account state + per-block receipts) now spans
two external contracts.

## 7. Threads across the lineage

**Cascade length formula.** `3 + depth_of_returned_promise_chain`
blocks per step. Synchronous-return downstreams are 3 (wrap's
`storage_deposit` and `near_deposit`, Ref's `storage_deposit` and
`swap`). Promise-returning downstreams are 5 (`ft_transfer_call`).
Failures don't extend the cascade — they just flip `success=false`
on the downstream Action receipt.

**Byte counts carry protocol-specific signal.** 50 bytes signals a
StorageBalance JSON from NEP-145. 0 bytes signals void-return
(`near_deposit`). 3 bytes `"0"` vs 24 bytes `"5000...000"` for
`ft_resolve_transfer` is the NEP-141 convention distinguishing
"receiver bounced" from "receiver used all." None of this is
visible to a protocol-agnostic orchestrator.

**`Direct` is structurally opaque; `Adapter` is the answer.** The
kernel's success-or-failure signal is truthful but not
interpretable across protocols. An adapter that encodes one
protocol's conventions and returns one honest top-level completion
surface is how multi-step protocol actions become sequencable
atomically. Chapter 14 documents the current model; chapter 21
adds the `Asserted` option for target-state postconditions.

**Saga halt is robust to every failure mode observed.** Four wild
failure shapes plus a Promise-chain bounce plus a refunded-deposit
misread (Run A) all halt the sequence cleanly without wedging
state. Surviving labels remain pending. `state never leaks` across
all real-protocol flows this lineage exercised.

**Real external state surfaces make the proof legible.** The first
chapter's 0.03 wNEAR, the adapter chapter's 0.03 → 0.06 wNEAR, and
the multi-contract chapter's 3,256,629 RFT in Ref's ledger are all
externally verifiable by anyone with an RPC client. The repo stops
being a closed-loop demo from here forward.

## 8. Canonical recipes

Multi-target stage_call batch against wrap.testnet:

```bash
./scripts/send-stage-call-multi.mjs \
  '{"label":"register","target":"wrap.testnet","method":"storage_deposit","args":{},"deposit_yocto":"1250000000000000000000","gas_tgas":50}' \
  '{"label":"deposit_a","target":"wrap.testnet","method":"near_deposit","args":{},"deposit_yocto":"10000000000000000000000","gas_tgas":30}' \
  '{"label":"deposit_b","target":"wrap.testnet","method":"near_deposit","args":{},"deposit_yocto":"20000000000000000000000","gas_tgas":30}' \
  --action-gas 250
```

Wild-semantic failure probe (four distinct failure shapes):

```bash
./scripts/send-stage-call-multi.mjs --signer x.mike.testnet \
  '{"label":"alpha","target":"wrap.testnet","method":"not_a_method","args":{},"deposit_yocto":"0","gas_tgas":30}' \
  '{"label":"beta","target":"wrap.testnet","method":"ft_transfer","args":{"receiver_id":"mike.testnet","amount":"1000000000000000000000000000000"},"deposit_yocto":"1","gas_tgas":30}' \
  '{"label":"gamma","target":"wrap.testnet","method":"ft_transfer","args":{"receiver_id":"mike.testnet","amount":1},"deposit_yocto":"1","gas_tgas":30}' \
  '{"label":"delta","target":"wrap.testnet","method":"storage_unregister","args":{"force":false},"deposit_yocto":"1","gas_tgas":30}' \
  --action-gas 250
```

First live adapter run:

```bash
near deploy compat-adapter.x.mike.testnet res/compat_adapter_local.wasm --networkId testnet
./scripts/send-balance-trigger-wrap-demo.mjs --dry --mode mixed alpha:0.01 beta:0.02
./scripts/send-balance-trigger-wrap-demo.mjs --mode mixed --execute-gas 800 alpha:0.01 beta:0.02
```

Multi-contract intent (Ref + wrap, success path):

```bash
./scripts/send-stage-call-multi.mjs --signer x.mike.testnet \
  '{"label":"bump_storage","target":"ref-finance-101.testnet","method":"storage_deposit","args":{"registration_only":false},"deposit_yocto":"50000000000000000000000","gas_tgas":30}' \
  '{"label":"deposit_v2","target":"wrap.testnet","method":"ft_transfer_call","args":{"receiver_id":"ref-finance-101.testnet","amount":"5000000000000000000000","msg":""},"deposit_yocto":"1","gas_tgas":100}' \
  '{"label":"swap_v2","target":"ref-finance-101.testnet","method":"swap","args":{"actions":[{"pool_id":0,"token_in":"wrap.testnet","token_out":"rft.tokenfactory.testnet","amount_in":"5000000000000000000000","min_amount_out":"0"}]},"deposit_yocto":"1","gas_tgas":50}' \
  --action-gas 250
```

Verify the multi-contract final state:

```bash
near view ref-finance-101.testnet get_deposits \
  '{"account_id":"smart-account.x.mike.testnet"}'
# → { 'wrap.testnet': '0', 'rft.tokenfactory.testnet': '3256629' }

near view wrap.testnet ft_balance_of \
  '{"account_id":"smart-account.x.mike.testnet"}'
```

## 9. Pointers forward

- [chapter 14](./14-wild-contract-compatibility.md) — the current
  `Direct` vs `Adapter` compatibility model, distilled from the
  empirical findings above
- [chapter 18](./18-keep-yield-canonical.md) — why the kernel keeps
  yield/resume canonical
- [chapter 19](./19-protocol-onboarding-and-investigation.md) —
  operator rationale for onboarding a new protocol safely
- [chapter 20](./20-pathological-contract-probe.md) — pathology
  taxonomy and three-layer detection, extending §4.7's Halt
  sub-taxonomy into a public probe surface
- [chapter 21](./21-asserted-resolve-policy.md) — the `Asserted`
  policy that catches target-state pathologies (noop, decoy)
  invisible to `Direct`, mentioned here as the natural third option
  alongside `Direct` and `Adapter`
