# 15 · Wild-contract semantics — Promise chains and failure opacity

**BLUF.** Chapters 11 and 12 set up the wild-contract probe (real DeFi
target plus the per-call `SettlePolicy` framework). This chapter answers
the two follow-on questions in one experiment pair against `wrap.testnet`:

1. **Promise-chain probe** — when the downstream returns a `Promise`
   instead of a value, does our `.then(on_stage_call_settled)` wait for
   the *full* chain to resolve? **Yes.** `ft_transfer_call` to a
   non-`ft_on_transfer` receiver runs through `ft_resolve_transfer`
   before settle fires. The cascade stretches from echo's 3 blocks per
   step to **5 blocks per step**, the smart-account's wNEAR briefly
   debits and is refunded (visible at the FT-balance level), and settle
   sees `Ok("0")` — the U128 the FT contract returns when the receiver
   bounces.
2. **Failure-shape probe** — four meaningfully-different failures
   against `wrap.testnet` (a missing method, a balance assertion panic,
   a deserialization panic, a precondition refusal) all collapse to the
   *same* `PromiseError::Failed` at settle. The settle log line is
   byte-for-byte identical except for the label and method-name slots.
   Cascade length is unchanged from success (4 blocks). Attached
   `1` yocto deposits are auto-refunded by NEAR's protocol-level refund
   logic.

Together these answer the open Q3 from chapter 13 in full and pin down
the structural cost of `Direct` settle: **the orchestrator can see
*that* a downstream succeeded or failed, never *why* or *how
deeply.*** That's the precise motivation for chapter 14's
`SettlePolicy::Adapter`.

## 1. Reference runs

| Probe | Batch tx | Block | Run-sequence tx |
|---|---|---|---|
| Promise chain (single `transfer` to mike.testnet) | `5ztxs7tDqiKCfuNR4phxBC3HNLNX8AtKjHcT6cNB82Br` | `246311710` | `EU3kuzXDqatta42oZeKyeQ2cDQeRorHmBfGE4jDuZkQR` |
| Four failures (alpha, beta, gamma, delta) | `EARZWHSjGr3eRzjVhHbGgTiMRvc7Sn9gAsy329zrVmhM` | `246312389` | `6LR4QH…B7s8` (alpha), `F163VN…uJTM` (beta), `HF6Fjk…Hx2z` (gamma), `3kq3EB…vGcZ` (delta) |

Both ran end-to-end inside the 200-block yield window with comfortable
margin.

## 2. Promise chain — `ft_transfer_call` to a no-`ft_on_transfer` receiver

Single `stage_call`:

| label | downstream | attached deposit | gas | what happens |
|---|---|---|---|---|
| `transfer` | `wrap.testnet.ft_transfer_call({receiver_id:"mike.testnet",amount:"10000000000000000000000",msg:""})` | 1 yocto | 100 TGas | wrap transfers 0.01 wNEAR to mike.testnet, calls `mike.ft_on_transfer` (no contract code → MethodNotFound), then `wrap.ft_resolve_transfer` refunds everything |

`mike.testnet` is storage-registered at wrap.testnet but has no
deployed wasm. NEP-141's defensive design says: if the receiver call
fails, refund. So the FT-side ledger goes `−0.01` then `+0.01`, net
zero, and `ft_resolve_transfer` returns `"0"` (zero used by receiver).

### Receipt DAG (abridged, `scripts/trace-tx.mjs`)

```
✓ stage_call action  @smart-account
   → yielded callback (waiting for resume)
✓ on_stage_call_resume  @smart-account
   → ft_transfer_call  @wrap.testnet
        log: Transfer 10000... from smart-account to mike.testnet
      ✗ ft_on_transfer  @mike.testnet  Failure (CompilationError: CodeDoesNotExist)
      ✓ ft_resolve_transfer  @wrap.testnet  ⇒ "0"
           log: Refund 10000... from mike.testnet to smart-account
✓ on_stage_call_settled  @smart-account  ⇒ "transfer"
   log: stage_call 'transfer' completed successfully via direct wrap.testnet.ft_transfer_call (3 result bytes)
```

### State time-series (FT balance + staged set)

| Block | `staged_calls_for(x.mike.testnet)` | `ft_balance_of(smart-account)` | What just happened |
|---|---|---|---|
| 246311710 | `[]` | `60000000000000000000000` | batch tx included |
| 246311711 | `[transfer]` | `60000000000000000000000` | yielded callback registered |
| 246311751 | `[transfer]` | `60000000000000000000000` | resume runs (run_sequence cascade) |
| 246311752 | `[transfer]` | **`50000000000000000000000`** | `ft_transfer_call` debited 0.01 wNEAR |
| 246311753 | `[transfer]` | `50000000000000000000000` | `mike.ft_on_transfer` failed |
| 246311754 | `[transfer]` | `50000000000000000000000` | `ft_resolve_transfer` ran |
| 246311755 | `[]` | **`60000000000000000000000`** | settle fired; refund applied |

The two-block FT-balance dip is the part chapters 05–11 didn't yet
have: a **user-visible state surface that lives outside our contract**
and can be pinned at any block.

### Cascade-length finding

5 blocks of cascade work for `ft_transfer_call` versus 3 for echo. The
two extra blocks are exactly `ft_on_transfer` + `ft_resolve_transfer`
— the chain that `ft_transfer_call`'s returned `Promise` resolves
through. The general rule: **cascade length = 3 + depth of the
Promise chain returned by the downstream.** NEAR's runtime substitutes
the eventual chain value for the function's "return," so
`.then(settle)` sees the *final* result, not the immediate `Promise`
handle.

## 3. Failure taxonomy — four shapes against `wrap.testnet`

One batch, four `stage_call` actions, designed to fail in distinct
ways. Each ran via its own single-label `run_sequence`:

| label | downstream | designed-to-fail because | wrap.testnet's actual error |
|---|---|---|---|
| `alpha` | `wrap.testnet.not_a_method({})` | the method does not exist | `MethodResolveError: MethodNotFound` |
| `beta`  | `wrap.testnet.ft_transfer({receiver_id:"mike.testnet", amount:"1000000000000000000000000000000"})` | smart-account holds 0.06 wNEAR; we ask to send 10²⁹ wNEAR | `Smart contract panicked: The account doesn't have enough balance` |
| `gamma` | `wrap.testnet.ft_transfer({receiver_id:"mike.testnet", amount:1})` | `amount` should be a JSON string (`U128`) but we pass an integer | `Smart contract panicked: panicked at 'Failed to deserialize input from JSON.: Error("invalid type: integer 1, expected a string", ...)` |
| `delta` | `wrap.testnet.storage_unregister({force:false})` | smart-account has positive wNEAR balance; without `force=true`, NEP-145 refuses | `Smart contract panicked: Can't unregister the account with the positive balance without force` |

These four cover the four fundamentally different ways a real DeFi
call can fail:

- **resolve-time** failure (the method isn't there)
- **execution-time** assertion failure (a runtime check inside the
  method panics)
- **deserialize-time** failure (the args don't match the method's
  declared types)
- **precondition** refusal (args parse, balance check fails)

### What the smart-account saw at settle

The settle log lines, side by side:

```
stage_call 'alpha' … failed downstream via direct wrap.testnet.not_a_method        … : Failed
stage_call 'beta'  … failed downstream via direct wrap.testnet.ft_transfer          … : Failed
stage_call 'gamma' … failed downstream via direct wrap.testnet.ft_transfer          … : Failed
stage_call 'delta' … failed downstream via direct wrap.testnet.storage_unregister … : Failed
```

Byte-for-byte identical except for label and method slots. The
contract code can do nothing else — `PromiseError` is `#[non_exhaustive]`
and only exposes `Failed` and `NotReady`. Neither carries the panic
text, the failure category, or any downstream-specific information.

### Where the actual panic lives

The full error sits on the receipt outcome's `Failure` payload one hop
upstream, accessible at trace time:

| Surface | Sees panic text? |
|---|---|
| `scripts/trace-tx.mjs --json` (or `EXPERIMENTAL_tx_status`) | **Yes** — raw `{"FunctionCallError":{...}}` |
| `on_stage_call_settled` in the contract | **No** — only `Err(PromiseError::Failed)` |
| `scripts/account-history.mjs` indexer feed | **Partially** — flags `not_success` but does not inline the panic text |

`gamma`'s payload is a particularly good observability artifact — it
contains wrap.testnet's own `src/lib.rs:43:1` source location and the
exact JSON parse error. None of that survives the hop into
`PromiseError::Failed`.

### Cascade length is unchanged by failure

All four failures ran in exactly **4 blocks** per cascade (run_seq
contract receipt + resume Data/Action + downstream Action with
success=false + settle Data/Action) — identical to a successful echo
cascade. The only structural difference is the `success=false` flag
on the third hop's receipt outcome.

### 1-yocto refund is a free property

Three of the four labels (`beta`, `gamma`, `delta`) attach `1` yocto
to satisfy NEP-141's `assert_one_yocto`. NEAR's protocol-level refund
logic returns the attached deposit automatically when the call fails,
*whether before or after `assert_one_yocto` ran*:

```
✓ HfH75C…kJbb  SuccessValue [refund]  @smart-account.x.mike.testnet  Transfer(1)   ⇒ null   (beta)
✓ DAnP9s…YExx  SuccessValue [refund]  @smart-account.x.mike.testnet  Transfer(1)   ⇒ null   (gamma)
✓ BxKAhR…bAGH  SuccessValue [refund]  @smart-account.x.mike.testnet  Transfer(1)   ⇒ null   (delta)
```

Failed calls don't leak value. We don't have to write any refund
logic.

## 4. The unifying insight — `Direct` settle is structurally opaque

Chapter 14 introduced `SettlePolicy::Direct` vs `Adapter` as a
choice. This chapter measures the cost of `Direct`:

- **On the success side**, settle sees the U128/JSON the downstream
  Promise chain resolves to. For `ft_transfer_call`, that's the
  refund-amount convention — but only an orchestrator that knows
  NEP-141 can interpret it. A general orchestrator can't.
- **On the failure side**, settle sees only `Err(PromiseError::Failed)`.
  All four failure shapes are indistinguishable.

Both observations point at the same architectural conclusion:
**meaningful interpretation of downstream behavior is protocol-aware
work that does not belong in the kernel.** Either route through an
`Adapter` that encodes the protocol's conventions, or read the trace
off-chain.

The good news that bounds the cost: **saga halt is robust to all five
modes** (the four failures plus a Promise-chain failure). Whatever the
cause, the label gets removed from the pending set and the queue
clears. Surviving labels remain pending and can be re-orchestrated.
State never wedges. Informational opacity is a tradeoff, not a wedge.

## 5. The four-fates flowchart, refined

Chapter 11's "four fates of a label" identified `OkDone`, `OkAdvance`,
`Halt`, `Decay`. This chapter fills in *Halt* with a finer-grained
sub-taxonomy:

| Cause of Halt | Where it surfaces in the receipt DAG | Visible to settle? |
|---|---|---|
| Method doesn't exist on target | `MethodResolveError` on downstream Action | No (looks like `PromiseError::Failed`) |
| Runtime assertion in target | `ExecutionError` with custom panic message | No |
| Deserialization rejection | `ExecutionError` with serde panic message | No |
| Precondition refusal in target | `ExecutionError` with custom message | No |
| Inner Promise chain failure (Promise-returning target) | `PromiseError::Failed` propagated through the chain | No |

All five funnel into the same on-chain settle behavior. The
distinction matters off-chain (for diagnostics) and would matter
on-chain only if the smart-account wanted conditional routing on
failure category. Today it does not, and we have no mechanism by
which it could without an Adapter.

## 6. Recipes

```bash
# Promise-chain probe
./scripts/send-stage-call-multi.mjs --signer x.mike.testnet \
  '{"label":"transfer","target":"wrap.testnet","method":"ft_transfer_call","args":{"receiver_id":"mike.testnet","amount":"10000000000000000000000","msg":""},"deposit_yocto":"1","gas_tgas":100}' \
  --action-gas 250 &
sleep 6

NEAR_ENV=testnet NEAR_TESTNET_RPC=https://test.rpc.fastnear.com \
  near call smart-account.x.mike.testnet run_sequence \
  '{"caller_id":"x.mike.testnet","order":["transfer"]}' \
  --accountId x.mike.testnet --gas 300000000000000

# state across the cascade (fill in your blocks)
for b in <run_seq_block> ... <settle_block>; do
  printf "block %s: " "$b"
  ./scripts/state.mjs wrap.testnet --method ft_balance_of \
    --args '{"account_id":"smart-account.x.mike.testnet"}' --block "$b" | tail -1
done

# Failure-mode probe (4 labels in one batch)
./scripts/send-stage-call-multi.mjs --signer x.mike.testnet \
  '{"label":"alpha","target":"wrap.testnet","method":"not_a_method","args":{},"deposit_yocto":"0","gas_tgas":30}' \
  '{"label":"beta","target":"wrap.testnet","method":"ft_transfer","args":{"receiver_id":"mike.testnet","amount":"1000000000000000000000000000000"},"deposit_yocto":"1","gas_tgas":30}' \
  '{"label":"gamma","target":"wrap.testnet","method":"ft_transfer","args":{"receiver_id":"mike.testnet","amount":1},"deposit_yocto":"1","gas_tgas":30}' \
  '{"label":"delta","target":"wrap.testnet","method":"storage_unregister","args":{"force":false},"deposit_yocto":"1","gas_tgas":30}' \
  --action-gas 250 &
sleep 8
for label in alpha beta gamma delta; do
  NEAR_ENV=testnet NEAR_TESTNET_RPC=https://test.rpc.fastnear.com \
    near call smart-account.x.mike.testnet run_sequence \
    "{\"caller_id\":\"x.mike.testnet\",\"order\":[\"$label\"]}" \
    --accountId x.mike.testnet --gas 300000000000000
  sleep 6
done

# Pull panic messages from the receipt DAG
./scripts/trace-tx.mjs <batch-hash> x.mike.testnet --wait FINAL --json \
  | grep -E 'MethodResolveError|ExecutionError'
```

---

*All tables generated by `scripts/state.mjs`, `scripts/trace-tx.mjs`,
`scripts/block-window.mjs`, `scripts/account-history.mjs` against the
live testnet rig on 2026-04-18.*
