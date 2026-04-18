# 17 · Multi-contract intent — register, deposit, swap on Ref Finance

**BLUF.** Chapters 11 and 13 probed `stage_call` against *one*
real protocol (`wrap.testnet`). This chapter extends to **two real
protocols we did not write**, orchestrated in one `run_sequence` with
strict ordering: register at `ref-finance-101.testnet`, deposit
`wrap.testnet` wNEAR into that protocol's internal ledger, then swap
that wNEAR for RFT via `ref-finance-101.testnet.swap`. The headline
result: end-to-end success in three saga steps against code we do not
control, leaving **3,256,629 base-units of RFT (≈ 0.033 RFT) credited
to `smart-account.x.mike.testnet`'s internal Ref ledger**, verifiable
with a single view call.

The chapter is also the most instructive *failure-then-success* run
so far. The first attempt halted at the swap step with "E21: token
not registered" because the preceding deposit step — which *looked*
like `Ok("0")` to our settle — had actually been refunded by wrap.testnet
when Ref's `ft_on_transfer` panicked with "E11: insufficient $NEAR
storage deposit." That is exactly chapter 15's regime, now manifest in
a real multi-contract flow: **the only way `Direct` settle can
distinguish "deposit landed" from "deposit bounced and refunded" is
via the returned byte count and its protocol-specific meaning**.
On the retry with 50 mNEAR of storage headroom, the deposit step
returned `"5000000000000000000000"` (24 bytes) instead of `"0"`
(3 bytes), and everything downstream worked.

## 1. Reference runs

| Artifact | Value | Block |
|---|---|---|
| **Run A** (swap halts — first attempt) | — | — |
| Batch tx (3 × `stage_call`: register, deposit, swap) | `GBBF82Kqx6v2tA7WMpML6Tn38kY46oFrFadprHLnVkoz` | `246313277` |
| `run_sequence(order=[register, deposit, swap])` | `8koUcSyPhSeENLRzAzJm6Jg41Q64mZBYtHGG6pEC6opX` | — |
| Cascade outcome | `register` Ok → `deposit` Ok but bounced → `swap` Err "E21: token not registered" → halt | — |
| **Run B** (retry with 50 mNEAR storage) | — | — |
| Batch tx | `E1sC2LVVio2iYku5Ti2ws3m8XNqb5sVJgKet367yeQGM` | `246313499` |
| `run_sequence(order=[bump_storage, deposit_v2, swap_v2])` | `TzyV23fEgaZH4kuNJu4yebtHV3u9xZVmMhAhA2LZY3f` | `246313528` |
| Cascade outcome | all three settled Ok; RFT landed at `get_deposits` | cascade drained by ~246313556 |

Each batch's 3 stage_call actions:

### Run A (failed)

| label | downstream | attached deposit | gas | purpose |
|---|---|---|---|---|
| `register` | `ref-finance-101.testnet.storage_deposit({})` | 1.02 mNEAR (= the `storage_balance_bounds.min`) | 30 TGas | register smart-account at Ref |
| `deposit` | `wrap.testnet.ft_transfer_call({receiver_id:"ref-finance-101.testnet",amount:"5000000000000000000000",msg:""})` | 1 yocto | 100 TGas | deposit 0.005 wNEAR into Ref's internal ledger for smart-account |
| `swap` | `ref-finance-101.testnet.swap({actions:[{pool_id:0,token_in:"wrap.testnet",token_out:"rft.tokenfactory.testnet",amount_in:"5000000000000000000000",min_amount_out:"0"}]})` | 1 yocto | 50 TGas | swap 0.005 wNEAR → RFT using pool 0 |

### Run B (succeeded)

| label | downstream | attached deposit | gas | change |
|---|---|---|---|---|
| `bump_storage` | `ref-finance-101.testnet.storage_deposit({registration_only:false})` | **50 mNEAR** | 30 TGas | top up storage headroom so Ref can register wNEAR as a deposited token |
| `deposit_v2` | (same as `deposit`) | 1 yocto | 100 TGas | same payload, different outcome because `ft_on_transfer` no longer panics |
| `swap_v2` | (same as `swap`) | 1 yocto | 50 TGas | wNEAR is now actually in smart-account's Ref ledger, so swap proceeds |

## 2. The shape of the failure (Run A) — chapter 15's regime in the wild

Decoded from the batch tx's receipt DAG:

| Step | settle outcome | settle byte count | what actually happened downstream |
|---|---|---|---|
| `register` | Ok (`"(50 result bytes)"`) | 50 | ref returned `{"total":"1020000000000000000000","available":"0"}` — registered with zero headroom |
| `deposit` | **Ok (`"(3 result bytes)"`)** | **3** | ref.ft_on_transfer panicked with "E11: insufficient $NEAR storage deposit"; wrap.testnet's ft_resolve_transfer refunded 0.005 wNEAR back to smart-account; `"0"` was returned |
| `swap` | **Err** (`"failed downstream … stopped the sequence: Failed"`) | — | ref.swap panicked with "E21: token not registered" because wNEAR was never actually deposited |

The `deposit` step settled `Ok` and advanced the sequence because
`Direct` settle only sees the terminal U128 from
`ft_resolve_transfer`. From settle's perspective, that U128 was `"0"`
— three bytes, perfectly valid `Ok` bytes. The *meaning* ("0 refund"
vs "full refund", which is the same literal value through
`ft_resolve_transfer` for different reasons) is protocol-specific
knowledge that `Direct` settle does not have.

The full downstream panic text is preserved on the receipt DAG,
accessible via `scripts/trace-tx.mjs --json`:

```
ref-finance-101.testnet.ft_on_transfer:
  Smart contract panicked: panicked at 'E11: insufficient $NEAR storage deposit',
  ref-exchange/src/account_deposit.rs:198:9

ref-finance-101.testnet.swap:
  Smart contract panicked: E21: token not registered
```

This is the clearest "real-world Adapter motivation" we have: any
serious orchestration of `ft_transfer_call` to a DeFi protocol should
route through an adapter that observes the *actual* ref-side deposit
change (e.g., polling `ref.get_deposits`) rather than trusting wrap.testnet's
terminal U128.

## 3. The shape of the success (Run B)

With 50 mNEAR of storage topped up, all three steps settled Ok:

| Step | settle outcome | settle byte count | downstream result |
|---|---|---|---|
| `bump_storage` | Ok | 73 | `{"total":"51020000000000000000000","available":"50000000000000000000000"}` — 50 mNEAR available for new tokens |
| `deposit_v2` | Ok | **24** | wrap.ft_resolve_transfer returned `"5000000000000000000000"` — **the full attached amount was "used" (i.e., actually deposited into Ref's internal ledger)** |
| `swap_v2` | Ok | 9 | ref.swap returned `"3256629"` — 3,256,629 base-units of RFT minted into smart-account's Ref ledger |

Two observable per-step logs from the swap's downstream:

```
Swapped 5000000000000000000000 wrap.testnet for 3256629 rft.tokenfactory.testnet
Exchange ref-finance-101.testnet got 547027805436552366 shares, No referral fee
```

The first log is the price discovery result: 0.005 wNEAR → 0.03256629
RFT. The second is Ref's own book-keeping (the LP fee, 0.04% of the
trade, credited to the pool's share pot).

### Byte-count deltas as weak signal

Comparing Run A's `deposit` (3 bytes, `"0"`) to Run B's `deposit_v2`
(24 bytes, `"5000000000000000000000"`) is evidence that the byte count
**does** carry information here — the U128 `"0"` means "receiver
returned 0 used, so wrap refunded everything," and a large U128 means
"receiver used the full amount." That's a usable but protocol-specific
signal. A general-purpose orchestrator still can't act on it without
encoding NEP-141 semantics; an `Adapter` that knows the convention
can.

## 4. State time-series across the successful run

`scripts/state.mjs ref-finance-101.testnet --method get_deposits --args '{"account_id":"smart-account.x.mike.testnet"}' --block <h>`

| Block | `get_deposits(smart-account)` at Ref | `ft_balance_of(smart-account)` at wrap | What just happened |
|---|---|---|---|
| 246313499 (batch tx included) | `{}` (from Run A: registered but no deposits) | `0.06 wNEAR` | nothing yet |
| 246313528 (run_sequence tx included) | `{}` | `0.06 wNEAR` | run_sequence tx included |
| after `bump_storage` settles | `{}` | `0.06 wNEAR` | storage topped up at Ref, no deposit change |
| after `deposit_v2` settles | `{"wrap.testnet":"5000000000000000000000"}` | **`0.055 wNEAR`** | smart-account moved 0.005 wNEAR from its wallet into Ref's ledger |
| after `swap_v2` settles | `{"wrap.testnet":"0","rft.tokenfactory.testnet":"3256629"}` | `0.055 wNEAR` | Ref swapped wNEAR → RFT inside its own ledger; smart-account's wallet wNEAR unchanged |
| 246313592 (post-cascade steady) | `{"wrap.testnet":"0","rft.tokenfactory.testnet":"3256629"}` | `0.055 wNEAR` | final state |

Two distinct state surfaces moved observably:

- **smart-account's NEP-141 wallet balance at wrap.testnet** dropped
  from `0.06 wNEAR` to `0.055 wNEAR` at deposit time and stayed.
- **smart-account's Ref internal deposit ledger** gained 0.005 wNEAR,
  then converted it to 3,256,629 RFT via the swap. The wNEAR slot
  stayed in the map at value "0" because Ref doesn't delete the entry.

This is the same three-surfaces methodology applied across *two*
external contracts: the saga semantic is visible on smart-account's
own state, the FT side is visible on wrap.testnet, and the Ref
internal ledger is visible on ref-finance-101.testnet.

## 5. Surface 1 — receipt DAG (Run B's happy path, abridged)

`scripts/trace-tx.mjs E1sC2LVVio2iYku5Ti2ws3m8XNqb5sVJgKet367yeQGM x.mike.testnet --wait FINAL`

```
✓ batch tx → 3 stage_call actions @smart-account (3 yielded callbacks allocated)

[bump_storage cascade, ~4 blocks]
  ✓ on_stage_call_resume(bump_storage) @smart-account
  ✓ ref.storage_deposit(registration_only=false) ⇒ {"total":"51020000000000000000000","available":"50000000000000000000000"}
  ✓ on_stage_call_settled(bump_storage) @smart-account  (73 result bytes)

[deposit_v2 cascade, ~5 blocks — Promise-chain, like chapter 15]
  ✓ on_stage_call_resume(deposit_v2) @smart-account
  → wrap.ft_transfer_call  @wrap.testnet
    ✓ ref.ft_on_transfer(sender=smart-account, amount=0.005, msg="") ⇒ "0"
    ✓ wrap.ft_resolve_transfer ⇒ "5000000000000000000000"
  ✓ on_stage_call_settled(deposit_v2) @smart-account  (24 result bytes)

[swap_v2 cascade, ~4 blocks]
  ✓ on_stage_call_resume(swap_v2) @smart-account
  ✓ ref.swap(actions=[{pool_id:0, token_in:wrap.testnet, token_out:rft.tokenfactory.testnet, ...}]) ⇒ "3256629"
  ✓ on_stage_call_settled(swap_v2) @smart-account  (9 result bytes)
```

Two observations about the DAG shape:

1. **`deposit_v2` is the only Promise-returning step** — its cascade
   is 5 blocks, consistent with chapter 15. The other two steps are
   synchronous-return and run in 4 blocks each. Total cascade length
   for the 3-step flow: **≈ 13 blocks cascade work** (spread over
   ~20-25 wall-clock blocks because `run_sequence`'s `.then(settle)`
   chain gates each step on the previous completing).
2. **No `fork`-style parallelism** — each step waits for the previous
   to settle. That's the whole point of the saga semantic.

## 6. Why "multi-contract" is a distinct claim

Before this chapter, every cascade lived inside a single receiver or
between our contracts and a single external one. "Cross-shard" was
tested in chapter 13 (wrap.testnet is on a different shard from
smart-account), but still one external contract.

Run B spans **three different contracts** in the single orchestration:

- `smart-account.x.mike.testnet` (the orchestrator)
- `ref-finance-101.testnet` (hit at steps 1 and 3)
- `wrap.testnet` (hit at step 2, with an internal callback chain to
  `ref-finance-101.testnet.ft_on_transfer`)

…plus the implicit dependency on `rft.tokenfactory.testnet` (which
Ref reads metadata from, though our experiment didn't require
smart-account to be registered there since we left RFT in Ref's
internal ledger). The fact that `run_sequence(order=[bump_storage,
deposit_v2, swap_v2])` gets strict ordering for free — and that a
failure in any single step halts the rest — is the essential
smart-account-shaped claim, now validated against real DeFi code.

## 7. What's still open after this chapter

The most interesting gap is scope, not correctness:

- **Withdraw step.** Run B leaves RFT in Ref's internal ledger. To
  get it out as a real FT-wallet balance, smart-account would need
  to register at `rft.tokenfactory.testnet` and then call
  `ref.withdraw(token_id="rft.tokenfactory.testnet", amount="3256629")`.
  That's a 4-action batch; the only reason it isn't in this chapter
  is the 1 PGas tx envelope (4 × 250 TGas = exactly 1 PGas, viable
  but tight) and wanting to keep the headline narrative focused.
  Queued for a future chapter.
- **Adapter for ft_transfer_call-to-Ref.** The Run A failure is
  exactly the pattern chapter 14 built `SettlePolicy::Adapter` for.
  A `compat-adapter.adapt_ft_transfer_call_to_ref(...)` that polls
  `ref.get_deposits` and reports a honest success/failure result
  would make multi-contract flows self-healing — the failed deposit
  step would settle `Err`, the next step would stay pending, and
  retrying just that step (after top-up) would complete without
  needing a fresh batch.
- **Deeper swaps.** Pool 0 is wNEAR/RFT. Multi-hop swaps
  (`actions: [{pool_id:0, ...}, {pool_id:N, ...}]`) are a single
  method call on Ref but chain multiple internal swaps. Settle
  would still see one U128; each intermediate pool update would be
  invisible from our side.
- **Failure in the swap step against real DeFi.** Run A's swap
  failed only because the deposit was missing. A swap that runs
  against a non-existent pool, or below `min_amount_out`, would be
  a different failure shape worth exercising (chapter 15's failure
  taxonomy expanded to Ref-specific errors).

## 8. Recipes

```bash
# Run A (will halt at swap step)
./scripts/send-stage-call-multi.mjs --signer x.mike.testnet \
  '{"label":"register","target":"ref-finance-101.testnet","method":"storage_deposit","args":{},"deposit_yocto":"1020000000000000000000","gas_tgas":30}' \
  '{"label":"deposit","target":"wrap.testnet","method":"ft_transfer_call","args":{"receiver_id":"ref-finance-101.testnet","amount":"5000000000000000000000","msg":""},"deposit_yocto":"1","gas_tgas":100}' \
  '{"label":"swap","target":"ref-finance-101.testnet","method":"swap","args":{"actions":[{"pool_id":0,"token_in":"wrap.testnet","token_out":"rft.tokenfactory.testnet","amount_in":"5000000000000000000000","min_amount_out":"0"}]},"deposit_yocto":"1","gas_tgas":50}' \
  --action-gas 250 &
sleep 8

NEAR_ENV=testnet NEAR_TESTNET_RPC=https://test.rpc.fastnear.com \
  near call smart-account.x.mike.testnet run_sequence \
  '{"caller_id":"x.mike.testnet","order":["register","deposit","swap"]}' \
  --accountId x.mike.testnet --gas 300000000000000

# Run B (will succeed end-to-end — assumes Run A already registered us)
./scripts/send-stage-call-multi.mjs --signer x.mike.testnet \
  '{"label":"bump_storage","target":"ref-finance-101.testnet","method":"storage_deposit","args":{"registration_only":false},"deposit_yocto":"50000000000000000000000","gas_tgas":30}' \
  '{"label":"deposit_v2","target":"wrap.testnet","method":"ft_transfer_call","args":{"receiver_id":"ref-finance-101.testnet","amount":"5000000000000000000000","msg":""},"deposit_yocto":"1","gas_tgas":100}' \
  '{"label":"swap_v2","target":"ref-finance-101.testnet","method":"swap","args":{"actions":[{"pool_id":0,"token_in":"wrap.testnet","token_out":"rft.tokenfactory.testnet","amount_in":"5000000000000000000000","min_amount_out":"0"}]},"deposit_yocto":"1","gas_tgas":50}' \
  --action-gas 250 &
sleep 8

NEAR_ENV=testnet NEAR_TESTNET_RPC=https://test.rpc.fastnear.com \
  near call smart-account.x.mike.testnet run_sequence \
  '{"caller_id":"x.mike.testnet","order":["bump_storage","deposit_v2","swap_v2"]}' \
  --accountId x.mike.testnet --gas 300000000000000

# verify the multi-contract final state
NEAR_ENV=testnet NEAR_TESTNET_RPC=https://test.rpc.fastnear.com \
  near view ref-finance-101.testnet get_deposits \
  '{"account_id":"smart-account.x.mike.testnet"}'
# → { 'wrap.testnet': '0', 'rft.tokenfactory.testnet': '3256629' }

NEAR_ENV=testnet NEAR_TESTNET_RPC=https://test.rpc.fastnear.com \
  near view wrap.testnet ft_balance_of \
  '{"account_id":"smart-account.x.mike.testnet"}'
# → '55000000000000000000000' (0.055 wNEAR, was 0.06)
```

---

*All tables generated by `scripts/state.mjs`, `scripts/trace-tx.mjs`,
`scripts/account-history.mjs`, and direct `near view` calls against
the live testnet rig on 2026-04-18. Reference batch txs
`GBBF82Kqx6v2tA7WMpML6Tn38kY46oFrFadprHLnVkoz` (Run A) and
`E1sC2LVVio2iYku5Ti2ws3m8XNqb5sVJgKet367yeQGM` (Run B).*
