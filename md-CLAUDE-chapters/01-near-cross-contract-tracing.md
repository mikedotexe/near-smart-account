# 01 · NEAR cross-contract call tracing: a FastNEAR docs foundation

**BLUF.** Cross-contract tracing on NEAR reduces to walking a DAG of `Receipt`s rooted at a `SignedTransaction`, reconstructed from `EXPERIMENTAL_tx_status`'s flat `receipts_outcome[]` via each outcome's `receipt_ids` children. Agents must handle four things the happy path hides: (1) `SuccessReceiptId` status means "the real result is downstream, recurse"; (2) yield/resume receipts (NEP-519) can stall a trace for up to ~200 blocks/~4 minutes; (3) `EXPERIMENTAL_tx_status`'s top-level `status` can report `SuccessValue` while a parallel branch fails — partial-failure detection requires scanning every outcome; (4) FastNEAR's regular RPC has a **3-epoch (~21 h)** retention window vs the 5-epoch (~2.5 day) window on `rpc.mainnet.near.org`, so stale tx lookups must route to `archival-rpc.mainnet.fastnear.com`. The fastest programmatic path from an opaque `receipt_id` back to its originating tx is **`POST https://tx.main.fastnear.com/v0/receipt`** — a FastNEAR-only helper that standard JSON-RPC cannot match. For streaming reconstruction, **neardata.xyz** beats Lake because it pre-joins `tx_hash` onto every `receipt_execution_outcome`, eliminating the single most common bug in cross-contract indexers: losing the parent-tx correlation across the delayed-receipt queue.

---

## 1. Receipt pipeline mechanics

### 1.1 Transaction → Receipt conversion

A `SignedTransaction` is never executed directly. On the **signer's shard** (the shard owning `tx.signer_id`), the runtime runs `verify_and_charge_transaction` (nearcore `runtime/runtime/src/verifier.rs`):

1. Signature, nonce, access-key, and balance checks (see §4 for error taxonomy).
2. `access_key.nonce := tx.nonce` is written — **the nonce is consumed here**, before any action runs. An `ActionError` downstream does NOT roll this back; only `InvalidTxError` leaves the nonce untouched.
3. The signer is debited `gas_to_balance(send_fees) + gas_to_balance(exec_fees + prepaid_gas) + Σ deposits`, at the **block's `gas_price`**.
4. The runtime calls `create_receipt_id_from_transaction` and emits one `ReceiptEnum::Action` whose `predecessor_id == signer_id`, `receiver_id == tx.receiver_id`, `actions == tx.actions`, `signer_id`, `signer_public_key`, `gas_price` (locked at tx-inclusion block), `input_data_ids == []`, `output_data_receivers == []`.
5. If `signer_id == receiver_id`, this is a **"local receipt"** — executed in the same chunk, and **not persisted** in the nearcore DB (hence missing from some indexer views; see §3.1). Otherwise it's written to the outgoing receipts set for routing to the receiver's shard.

The `transaction_outcome` returned by RPC describes only this conversion step; its `outcome.status` is always `SuccessReceiptId(first_receipt_id)` — the real work is downstream.

### 1.2 ReceiptEnum: Action vs Data (and PromiseYield)

From `core/primitives/src/receipt.rs` at master:

```rust
pub struct Receipt {              // ReceiptV0 on the wire; ReceiptV1 adds a 1-byte tag + `priority: u64`
    pub predecessor_id: AccountId,
    pub receiver_id:    AccountId,
    pub receipt_id:     CryptoHash,
    pub receipt:        ReceiptEnum,
}

pub enum ReceiptEnum {
    Action(ActionReceipt),
    Data(DataReceipt),
    PromiseYield(ActionReceipt),   // NEP-519, protocol v67
    PromiseResume(DataReceipt),    // NEP-519, protocol v67
    GlobalContractDistribution(GlobalContractDistributionReceipt), // NEP-491
}

pub struct ActionReceipt {
    pub signer_id:             AccountId,
    pub signer_public_key:     PublicKey,
    pub gas_price:             Balance,                // yoctoNEAR/gas, fixed at original tx inclusion
    pub output_data_receivers: Vec<DataReceiver>,      // where this receipt's return value must be delivered
    pub input_data_ids:        Vec<CryptoHash>,        // DataReceipts that must arrive before execution
    pub actions:               Vec<Action>,
}
pub struct DataReceiver { pub data_id: CryptoHash, pub receiver_id: AccountId }

pub struct DataReceipt {
    pub data_id: CryptoHash,
    pub data:    Option<Vec<u8>>,   // None ⇒ predecessor receipt Failed
}
```

**JSON wire shape** (from `EXPERIMENTAL_tx_status.receipts[]`):

```json
{"predecessor_id":"alice.near","receiver_id":"dex.near","receipt_id":"3dMf...",
 "priority":0,
 "receipt":{"Action":{"signer_id":"alice.near","signer_public_key":"ed25519:...",
   "gas_price":"103000000","input_data_ids":[],"output_data_receivers":[],
   "actions":[{"FunctionCall":{"method_name":"swap","args":"...","gas":30000000000000,"deposit":"0"}}],
   "is_promise_yield":false}}}
```

**Key field semantics**:
- `predecessor_id == "system"` ⇒ this is a **refund receipt** (gas refund or deposit refund). Created by the runtime, not by any contract.
- `signer_id == "system"` + all-zero `signer_public_key` ⇒ **deposit refund**; `signer_id == original signer` with real pubkey ⇒ **gas refund** (allowance saturating-added back to FunctionCall key if still present).
- `gas_price` is **locked at the original tx's inclusion block** — a deep receipt chain can burn at a stale price (NEP-536, v78, removed pessimistic gas pricing; before v78, the initial price was inflated and each receipt issued delta refunds).
- `is_promise_yield` (wire field on ActionReceipt.Action in view serialization): `true` marks the originating receipt of a NEP-519 yield. The child receipt it references cannot execute until `promise_yield_resume` fires OR 200 blocks (~4 min) elapse, after which the runtime auto-resumes with `PromiseError::Failed`.

### 1.3 Receipt ID generation

Deterministic; computed via `create_receipt_id_from_transaction` and `create_receipt_id_from_receipt` in `core/primitives/src/utils.rs`. The hash inputs include the source tx hash (or parent receipt_id), the prev-block hash of the chunk doing the creation, and the action/output index. **Receipt IDs are base58 `CryptoHash` strings on the wire** (32-byte hash) — not hex. This catches agent teams that assume `SuccessReceiptId` is hex-encoded.

### 1.4 Cross-shard flow, delayed queue, congestion control

Receipts produced on shard S targeting receiver on shard T land in S's outgoing set, are routed in the **next chunk**, and appear as incoming receipts on T. If T's chunk budget (nominally **1000 TGas**; see §2) can't hold them, they enter T's **delayed receipts queue** (trie-persisted, indexed by `DelayedReceiptIndices { first_index, next_available_index }`) and drain across subsequent blocks.

Since protocol v68 (NEP-539, congestion control), chunk headers carry delayed-gas totals, per-target outgoing-buffered gas, and a congestion_level ∈ [0,1]. Transactions **destined for congested shards are rejected at chunk inclusion** with `InvalidTxError::ShardCongested { shard_id, congestion_level }`; missed chunks trigger `InvalidTxError::ShardStuck { shard_id, missed_chunks }`. Neither consumes the signer's nonce (it's a verification-stage rejection) — **safe to retry**.

Protocol v74 (NEP-584) added a cross-shard bandwidth scheduler; v75/76 (resharding v3) made shard IDs arbitrary and raised num_shards to 8. These do not change receipt semantics but mean agents **must compute total chunk capacity by summing `chunk.gas_limit` across shards** rather than hard-coding `1000 TGas × N`.

### 1.5 Promise API → receipts

Promise host functions in `runtime/near-vm-logic/src/logic.rs` build an in-contract-memory promise DAG; at VM shutdown, `action_function_call` materializes it into the outcome's `new_receipts`.

| Host call | Receipt(s) produced | Wiring |
|---|---|---|
| `promise_create(account, method, args, deposit, gas)` | 1 ActionReceipt to `account` | `output_data_receivers = []` unless chained |
| `promise_then(prev, account, method, args, deposit, gas)` | 1 ActionReceipt to `account` | `input_data_ids = [new data_id]`; the prev receipt gains `output_data_receivers += {data_id, account}` |
| `promise_and([p1,p2,...])` | **No new receipt** (ephemeral handle); later `.then()` attaches multiple `input_data_ids` | Multiple `input_data_ids` on one ActionReceipt ⇒ the "joint promise" |
| `promise_batch_*` | 1 ActionReceipt collecting multiple Actions against one receiver | — |
| `promise_return(p)` | Splices the current receipt's `output_data_receivers` onto `p`'s chain | The calling receipt's outcome becomes `SuccessReceiptId(p)` |
| `promise_yield_create(method, args, gas, weight, data_id_reg)` (NEP-519, v67) | 1 `PromiseYield` receipt + slot for a `PromiseResume` data receipt | Yielded receipt waits on the returned `data_id` |
| `promise_yield_resume(data_id, payload)` | 1 `PromiseResume` data receipt carrying `payload` | Delivers input to the waiting yielded receipt |

The `promise_batch_action_function_call_weight` variant (NEP-264, v53) lets contracts attach **unused gas by weight** rather than absolute quantity — this is the primary fix for mid-chain `GasExceeded` failures in multi-hop chains.

### 1.6 Receipt matching (the core of the pipeline)

On incoming receipt arrival at the receiver shard:

- **ActionReceipt**: runtime iterates `input_data_ids`. For each missing `data_id`, it stores `(account_id, data_id) → receipt_id` in the pending-data index and bumps a pending-count. If all inputs already present, execute immediately; else store receipt as `PostponedReceipt` keyed by `(account_id, receipt_id)` in the trie.
- **DataReceipt**: runtime stores `(account_id, data_id) → (success, data)` in received-data map, decrements the counter of any postponed ActionReceipt awaiting this `data_id`. When counter hits 0, the postponed receipt executes.

After execution, `ActionResult` is produced. For each `output_data_receiver`, the runtime emits a DataReceipt carrying the last action's return value (or `None` on failure). Each `new_receipt` created during execution gets a freshly derived receipt_id and is added to outgoing receipts.

### 1.7 Cross-contract call lifecycle — canonical example

```
┌─────────────────────────────────────────────────────────────────────┐
│ Shard S_a (alice.near)    Shard S_b (dex.near)   Shard S_c (tok.near)│
│                                                                      │
│ [Tx: alice → dex.swap]                                               │
│   │ verify+charge; create_receipt_id_from_transaction                │
│   ▼                                                                  │
│  R1: Action{predecessor=alice, receiver=dex, actions=[swap(.)]}      │
│      gas_price locked, input_data_ids=[], output_data_receivers=[]   │
│   ─────────────────────────────────────►                             │
│                                     execute R1:                      │
│                                        promise_create(tok.transfer)  │
│                                          → R2 (ActionReceipt)        │
│                                        promise_then(R2, dex.cb)      │
│                                          → R3 (ActionReceipt)        │
│                                           with input_data_ids=[d1]   │
│                                        R2.output_data_receivers      │
│                                          += {d1, dex.near}           │
│                                        R1.outcome.status =           │
│                                          SuccessReceiptId(R3)        │
│                                     ──────────────────────►          │
│                                                        execute R2:   │
│                                                          transfer ok │
│                                                          produces    │
│                                                          D1: Data{   │
│                                                            data_id=d1│
│                                                            data=Some}│
│                                       ◄─────────────────             │
│                                    R3 was postponed waiting on d1    │
│                                    D1 arrives → counter=0 → exec R3  │
│                                    R3.outcome.status = SuccessValue  │
│                                                                      │
│  Refund receipts R_ref (predecessor="system") flow back to alice     │
│  for unused gas (and any deposit on a failed action).                │
└─────────────────────────────────────────────────────────────────────┘
```

`EXPERIMENTAL_tx_status` returns `transaction_outcome.outcome.receipt_ids=[R1]`, `receipts_outcome=[R1, R2, R3, R_ref…]` (flat, not tree), `receipts=[...raw bodies...]`. Walk by: start at `transaction_outcome.receipt_ids[0]=R1`; `outcomes[R1].receipt_ids=[R2,R3]`; `outcomes[R2].receipt_ids=[]` but it has an implicit DataReceipt to dex; `outcomes[R3].receipt_ids=[]` and status terminal.

### 1.8 ExecutionStatus variants

```
ExecutionStatusView =
  | Unknown                           // wait_until too low; not yet applied
  | Failure(TxExecutionError)         // see §4.3 for full error tree
  | SuccessValue(base64 bytes)        // terminal; "" = ReturnData::None (void / Transfer)
  | SuccessReceiptId(receipt_id)      // not terminal; final result comes from that receipt
```

Top-level `status: FinalExecutionStatus` collapses these into `SuccessValue | Failure | NotStarted | Started`. The critical gotcha: **top-level `SuccessValue` only follows the `SuccessReceiptId` chain of the originating receipt**. A failed sibling branch (`promise_and`, parallel `promise_batch`, or a `.then()` callback that swallowed the error) is invisible at top level. **Always scan `receipts_outcome[*].outcome.status` for any `Failure` to detect partial failure.**

### 1.9 Finality

NEAR finality has two tiers: **doomslug** (near-final, ~1 block after production, no forks in practice) and **final** (BFT-finalized, ~2 blocks further). `EXPERIMENTAL_tx_status` exposes this via `wait_until`:

| `wait_until` | Meaning | Typical latency |
|---|---|---|
| `NONE` | Hash recognized, no wait | <100 ms |
| `INCLUDED` | Landed in a (possibly non-final) block | 1–2 s |
| `EXECUTED_OPTIMISTIC` (default) | All non-refund receipts finished; blocks may not be final | 2–4 s |
| `INCLUDED_FINAL` | Tx block final, receipts may not be | 2–3 s |
| `EXECUTED` | Tx block final AND all receipts executed on (possibly optimistic) blocks | 3–5 s |
| `FINAL` | Every block containing any tx/receipt is final | 5–10 s, up to **~4 min** with yield/resume |

A multi-receipt call is "truly final" only at `wait_until=FINAL`. For UI interactivity use `EXECUTED_OPTIMISTIC`; for bridges/exchanges/audit, use `FINAL`. A recent nearcore change replaces the server-side polling loop with event notifications for lower latency.

### 1.10 Protocol-version timeline that affects traces

| PV | Change | Agent-visible effect |
|---|---|---|
| 52 | `max_gas_burnt` 200 → 300 TGas | Higher per-call ceiling |
| 83 | Contract gas limit 300 TGas → 1 PGas | Much larger per-call and per-tx gas envelope for contract execution |
| 53 | NEP-264 function_call_weight | Chains less likely to starve mid-flight |
| 63 | Delayed-receipt throttle ≥20k | TX pool pushback before NEP-539 |
| 67 | NEP-519 yield/resume | New `PromiseYield`/`PromiseResume` variants; `is_promise_yield` flag; 200-block timeout |
| 68 | NEP-539 congestion control | `ShardCongested`/`ShardStuck` tx errors |
| 69 | Stateless validation | No semantic trace change |
| 74 | NEP-584 bandwidth scheduler | Changes inter-shard receipt pacing |
| 75–76 | Resharding v3 | Shard IDs arbitrary; `num_shards=8` |
| 78 | NEP-536: pessimistic gas price **removed**; `gas_refund_penalty` field added (params=0 for now) | No more delta refunds; long chains pay stale price |

Also shipped recently per nearcore release notes: "Invalid transactions now generate execution outcomes" (indexers/RPC report outcomes for verification-rejected tx — old client code assuming failures disappear must update); "ETH implicit accounts use globally deployed contract"; yield/resume race-condition fix.

---

## 2. RPC / API surface for tracing

### 2.1 FastNEAR endpoint surface

FastNEAR exposes **four products** under one API key (Bearer or `?apiKey=`):

**JSON-RPC (protocol-native NEAR JSON-RPC):**
| Purpose | Mainnet | Testnet | GC window |
|---|---|---|---|
| Regular RPC | `https://rpc.mainnet.fastnear.com` | `https://rpc.testnet.fastnear.com` | **~3 epochs (~21 h)** |
| Free-tier | `https://free.rpc.fastnear.com` | `https://test.rpc.fastnear.com` | same |
| Archival RPC | `https://archival-rpc.mainnet.fastnear.com` | `https://archival-rpc.testnet.fastnear.com` | full history |
| "Big" RPC (paid-only, raised view limits: 3 PGas, 10 MB view_state) | `https://big.rpc.fastnear.com` | — | 21+ epochs |

**Danger:** `big.rpc.fastnear.com` hard-limits unauthenticated callers to 1 request per ~65535 s — easy to misread as an outage.

**Indexer API (`api.fastnear.com`, REST, ClickHouse-backed)**: account-centric; `/v1/account/{id}/{staking,ft,nft,full}`, `/v0/public_key/{pk}[/all]` (pubkey → accounts), `/v1/ft/{token}/top`.

**Transactions/Receipts API (`tx.main.fastnear.com`, POST JSON, `/v0`)** — most useful for tracing:
- `POST /v0/transactions {tx_hashes:[…up to 20]}` — batch fetch.
- `POST /v0/receipt {receipt_id}` → `{receipt:{…, transaction_hash, appear_block_height, shard_id, receipt_type, predecessor_id, receiver_id, is_success}, transaction:{…}}`. **This is the fastest way to pivot from a receipt_id back to its originating transaction hash** — no JSON-RPC equivalent exists.
- `POST /v0/block {block_id, with_transactions?, with_receipts?}`, `POST /v0/blocks`, `POST /v0/account` (cursor-based history with rich filters: `is_signer`, `is_real_receiver`, `is_function_call`, `is_event_log`, `is_explicit_refund_to`, …).

**Neardata (`mainnet.neardata.xyz`, free)** — block streaming (§3.2).

### 2.2 Core JSON-RPC methods for tracing

- `tx` — legacy; returns outcomes but **no raw receipt bodies**. Use `EXPERIMENTAL_tx_status` when you need receipts.
- `EXPERIMENTAL_tx_status` — **the workhorse**. Params: `{tx_hash, sender_account_id, wait_until}`. Returns `{status, final_execution_status, transaction, transaction_outcome, receipts_outcome[], receipts[]}`. The `receipts` array carries raw Receipt bodies (ActionReceipt/DataReceipt); `receipts_outcome` carries ExecutionOutcomes. **Match them by `receipt_id`.**
- `tx_status_with_receipts` — **does not exist as a wire method**. It's a near-api-js client function name (`txStatusReceipts()`) that dispatches `EXPERIMENTAL_tx_status`. Do not document as an endpoint.
- `EXPERIMENTAL_receipt` — `{receipt_id}` → Receipt body only, **no execution outcome**. Beginners get burned by this.
- `block` — by `{finality}` (`final | near-final | optimistic`) or `{block_id}` (height or hash). Returns chunk **headers only**.
- `chunk` — `{chunk_id}` or `{block_id, shard_id}`. Returns **per-shard** canonical list of transactions + receipts **processed in that chunk**. Authoritative source for shard-level state.
- `EXPERIMENTAL_changes`, `EXPERIMENTAL_changes_in_block`, `block_effects` (newer) — state-change feeds (account/access-key/data/contract-code touches); useful for reconstructing what a cross-contract call mutated without scraping logs.
- `query` with `request_type: "view_access_key"` — reads nonce (§4).
- `send_tx`, `broadcast_tx_async`, `broadcast_tx_commit` — submission. `send_tx` subsumes the broadcast_* variants with a `wait_until` knob. Tx hash-based idempotency is enforced by the protocol; safe to resubmit the identical SignedTransaction after `TIMEOUT_ERROR`.

### 2.3 Canonical response schema (EXPERIMENTAL_tx_status)

```json
{"jsonrpc":"2.0","id":"t1","result":{
  "status":{"SuccessValue":""},
  "final_execution_status":"FINAL",
  "transaction":{"signer_id":"alice.near","public_key":"ed25519:...","nonce":15,
                 "receiver_id":"dex.near","actions":[{"FunctionCall":{...}}],
                 "signature":"ed25519:...","hash":"6zgh..."},
  "transaction_outcome":{"proof":[...],"block_hash":"...",
    "id":"6zgh...","outcome":{"logs":[],"receipt_ids":["R1..."],
      "gas_burnt":2231825625000,"tokens_burnt":"22318256250000",
      "executor_id":"alice.near","status":{"SuccessReceiptId":"R1..."},
      "metadata":{"gas_profile":[...],"version":3}}},
  "receipts_outcome":[
    {"proof":[...],"block_hash":"...","id":"R1...",
     "outcome":{"logs":[...],"receipt_ids":["R2...","R3..."],
       "gas_burnt":...,"tokens_burnt":"...","executor_id":"dex.near",
       "status":{"SuccessReceiptId":"R3..."},
       "metadata":{"gas_profile":[...],"version":3}}},
    // ...R2, R3, and any refund receipts
  ],
  "receipts":[
    {"predecessor_id":"alice.near","receiver_id":"dex.near","receipt_id":"R1...",
     "priority":0,
     "receipt":{"Action":{"signer_id":"alice.near","signer_public_key":"...",
       "gas_price":"103000000","input_data_ids":[],"output_data_receivers":[],
       "actions":[{"FunctionCall":{...}}],"is_promise_yield":false}}}
    // ...
  ]}}
```

**Two fields agents commonly confuse**: `status` (= FinalExecutionStatus, the tx's aggregate outcome) vs `final_execution_status` (= TxExecutionStatus, the finality level this response reflects — important when `wait_until` timed out at a lower level). Inspect both.

### 2.4 Canonical trace reconstruction algorithm

```
1. EXPERIMENTAL_tx_status(tx_hash, sender, wait_until=FINAL)
2. byId = { ro.id: ro for ro in receipts_outcome }
3. Root = transaction_outcome.outcome.receipt_ids[0]
4. DFS from Root:
   for each outcome:
     if status == SuccessValue(v)       → terminal, v is base64 return payload
     if status == SuccessReceiptId(rid) → recurse into byId[rid]
     if status == Failure(e)            → terminal failure; siblings may still run
     if status == Unknown               → trace incomplete, re-poll
     for child in outcome.receipt_ids: recurse (dedupe — DAG not tree due to promise_and)
5. Dedupe by receipt_id (critical for promise_and / multi-input receipts)
6. Classify top-level: scan every outcome for Failure → PARTIAL_FAIL vs FULL_SUCCESS
7. Filter refund receipts (predecessor_id == "system") for user-facing views
```

### 2.5 Archival, GC, and the "UNKNOWN_*" failure mode

| Node type | Retention |
|---|---|
| FastNEAR regular RPC | **3 epochs (~21 h)** |
| `rpc.mainnet.near.org` | 5 epochs (~2.5 days) |
| FastNEAR Big | 21+ epochs |
| Archival (any) | from genesis |

Once past the window, `tx`, `EXPERIMENTAL_tx_status`, and `EXPERIMENTAL_receipt` return a structured error with `cause.name` of `UNKNOWN_TRANSACTION` or `UNKNOWN_RECEIPT`. **Client heuristic**: on `UNKNOWN_*` from regular RPC, retry on archival. FastNEAR archival uses split storage (hot NVMe + cold HDD, ~60 TB mainnet); old-block latency is higher — cache aggressively. A known operator gotcha: if the cold-head is stale (>48 h behind an RPC snapshot), old tx lookups can fail even on archival during migrations.

### 2.6 Error envelope and causes

```json
{"error":{"name":"HANDLER_ERROR",
          "cause":{"name":"UNKNOWN_RECEIPT","info":{"receipt_id":"…"}},
          "code":-32000,"message":"Server error","data":"…"}}
```

Read `error.name` + `error.cause.name`; `code`/`data`/`message` are marked legacy.

**Top-level names**: `REQUEST_VALIDATION_ERROR` (400, malformed), `HANDLER_ERROR` (200 with error envelope, data unavailable), `INTERNAL_ERROR` (500).

**Per-method causes** (abbreviated):
- tx / EXPERIMENTAL_tx_status: `UNKNOWN_TRANSACTION`, `INVALID_TRANSACTION` (do not retry), `TIMEOUT_ERROR` (safe to resubmit — tx-hash idempotent), `UNAVAILABLE_SHARD`, `INTERNAL_ERROR`.
- EXPERIMENTAL_receipt: `UNKNOWN_RECEIPT`, `PARSE_ERROR`, `INTERNAL_ERROR`.
- block / chunk: `UNKNOWN_BLOCK`, `UNKNOWN_CHUNK`, `INVALID_SHARD_ID`, `NOT_SYNCED_YET`.

Retry heuristics: `UNKNOWN_*` → archival failover; `TIMEOUT_ERROR` → resubmit identical payload; `NOT_SYNCED_YET` → different provider; `INVALID_TRANSACTION` → surface to caller; `INTERNAL_ERROR` → exp backoff.

### 2.7 Concrete curl examples

```bash
# tx_status (archival, with wait_until=FINAL)
curl -X POST https://archival-rpc.mainnet.fastnear.com \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $KEY" \
  -d '{"jsonrpc":"2.0","id":"t","method":"EXPERIMENTAL_tx_status",
       "params":{"tx_hash":"9FtH…","sender_account_id":"alice.near","wait_until":"FINAL"}}'

# Single receipt body (no outcome)
curl -X POST https://archival-rpc.mainnet.fastnear.com -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":"r","method":"EXPERIMENTAL_receipt",
       "params":{"receipt_id":"2Ebe…"}}'

# Receipt → originating tx (FastNEAR-only, one hop)
curl -X POST https://tx.main.fastnear.com/v0/receipt -H 'Content-Type: application/json' \
  -d '{"receipt_id":"H6Ro…"}'

# Chunk by (block_id, shard_id) — authoritative receipts processed
curl -X POST https://rpc.mainnet.fastnear.com -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":"c","method":"chunk",
       "params":{"block_id":187310138,"shard_id":0}}'
```

---

## 3. Ecosystem tools for receipt tracing

### 3.1 NEAR Lake and Indexer Framework

**NEAR Lake** = an archival nearcore node (`near-lake-indexer`) that writes every finalized block to S3 as plain JSON, plus consumer libraries (Rust `near-lake-framework`, JS `@near-lake/framework`, Python). Buckets: `near-lake-data-{mainnet,testnet}` in `eu-central-1` (**Requester-Pays**; ~$18–20/mo to follow tip at current shard count). Layout: `{height zero-padded to 12}/block.json` + `shard_{0..N}.json`. Latency **~2–5 s** behind tip (finalized only).

Consumer data model (`near_indexer_primitives::StreamerMessage`):

```rust
pub struct StreamerMessage { pub block: BlockView, pub shards: Vec<IndexerShard> }
pub struct IndexerShard {
    pub shard_id: ShardId,
    pub chunk: Option<IndexerChunkView>,           // Option: chunks can be skipped
    pub receipt_execution_outcomes: Vec<IndexerExecutionOutcomeWithReceipt>,
    pub state_changes: Vec<StateChangeWithCauseView>,
}
pub struct IndexerChunkView {
    pub author: AccountId, pub header: ChunkHeaderView,
    pub transactions: Vec<IndexerTransactionWithOutcome>,   // signer-shard only
    pub receipts: Vec<ReceiptView>,                         // produced in this chunk
}
```

**Local-receipt gotcha**: `IndexerTransactionWithOutcome.outcome.receipt` is `Option` — local receipts (signer==receiver) aren't persisted in nearcore DB and may be `None` on later reference. Tolerate this in consumers.

**NEAR Indexer Framework** = in-process library inside `nearcore` (`chain/indexer`). Your binary IS a nearcore node; blocks pushed via `mpsc` in the same `StreamerMessage` type. Differences vs Lake: sub-second latency, can stream optimistic blocks, heavier ops (archival node ~2 TB NVMe). Choose Indexer Framework when you need optimistic/sub-second, Lake otherwise.

### 3.2 Neardata (FastNEAR) — the recommended default

`https://mainnet.neardata.xyz/v0/`:
- `GET /block/{h}` — finalized block JSON (**blocks until produced** if near tip)
- `GET /block_opt/{h}` — optimistic block (redirects to finalized if old)
- `GET /last_block/{final,optimistic}` — latest
- `GET /first_block` — genesis+1
- `/block/{h}/headers`, `/block/{h}/chunk/{s}`, `/block/{h}/shard/{s}` — partial
- Mainnet genesis: `9820210`. Testnet genesis: `42376888`.

**Why Neardata beats Lake for tracing**: every entry in `receipt_execution_outcomes` is **enriched with `tx_hash`** — eliminating the hardest bug in cross-contract indexers (correlating a delayed receipt back to its tx across N blocks). Format is otherwise compatible with `StreamerMessage`. Free; 1 Gbps shared; 180 req/min/IP without key.

Libraries: Rust `fastnear-neardata-fetcher` (crates.io), `fastnear-primitives`; reference pipeline `fastnear/fastdata-indexer` (Neardata → ScyllaDB); self-hostable `fastnear/neardata-server`.

### 3.3 Stateful trace reconstruction across blocks (streaming)

```rust
let mut pending: HashSet<CryptoHash> = HashSet::new();
let mut tree: HashMap<CryptoHash, TxTrace> = HashMap::new();

fn on_block(msg: StreamerMessage, target_tx: CryptoHash) {
    for shard in msg.shards {
        if let Some(chunk) = shard.chunk {
            for tx in chunk.transactions {
                if tx.transaction.hash == target_tx {
                    for rid in &tx.outcome.execution_outcome.outcome.receipt_ids {
                        pending.insert(*rid);
                        tree.insert(*rid, TxTrace::root());
                    }
                }
            }
        }
        for exec in shard.receipt_execution_outcomes {
            let rid = exec.execution_outcome.id;
            if pending.remove(&rid) {
                tree.get_mut(&rid).unwrap().record(exec.clone());
                for child in &exec.execution_outcome.outcome.receipt_ids {
                    pending.insert(*child);
                    tree.insert(*child, TxTrace::child_of(rid));
                }
            }
        }
    }
    if pending.is_empty() { /* trace complete */ }
}
```

Persist `pending` (Redis/RocksDB) — restarts lose context otherwise. Never assume finite block lookahead: delayed-queue receipts can execute dozens of blocks later; yield/resume up to 200 blocks later. Production pattern: flag anomaly if pending > 1000 blocks.

### 3.4 Nearblocks, Pagoda/Explorer, BigQuery, Pikespeak

- **Nearblocks API** (`api.nearblocks.io/v1`): `/txns/{hash}/full` returns server-reconstructed receipts tree with outcomes — single-call trace for a known hash. Lake-backed TimescaleDB. Paid tiers via `nearblocks.io/apis`. Best for retrospective one-shots when you don't want to walk the DAG yourself.
- **Pagoda/Explorer**: `explorer.near.org`, `api.pagoda.co`, `near-indexer-for-explorer` Postgres DSNs, old `QueryApi` GraphQL — **all deprecated**. Nearblocks is the canonical explorer; FastNEAR Explorer API (`explorer.main.fastnear.com/v0/`, ClickHouse) is the practical programmatic replacement.
- **BigQuery** `bigquery-public-data.crypto_near_mainnet_us`: Lake-derived; join `receipt_origin_transaction` ↔ `receipts` ↔ `execution_outcomes` for SQL-based trace retrieval. NEAR pays storage; $6.25/TB queried (1 TB/mo free). Ideal for historical analytics.
- **Pikespeak** (`api.pikespeak.ai`, `x-api-key`): `/event-historic/{id}` returns token-transfer events with tx + receipt IDs. Not a raw tree API; event-level aggregations.
- Other RPC providers (QuickNode, Ankr, GetBlock, Lavanet): plain JSON-RPC proxies. **None of them expose Ethereum-style `debug_trace*` tracing — "tracing" on NEAR means walking the receipt graph.**

### 3.5 Tool selection cheat sheet

| Need | Pick |
|---|---|
| One-shot trace for a known tx_hash | `EXPERIMENTAL_tx_status` on `archival-rpc.mainnet.fastnear.com` |
| Receipt → originating tx | `POST tx.main.fastnear.com/v0/receipt` |
| Streaming indexer (new build) | **Neardata + fastnear-neardata-fetcher** |
| Sub-second / optimistic | Indexer Framework (own node) |
| Bulk historical analytics | BigQuery `crypto_near_mainnet_us` |
| Retrospective server-reconstructed tree | Nearblocks `/v1/txns/{hash}/full` |
| Existing AWS-native pipeline | Lake (S3) |

---

## 4. Parallel topics: gas, nonces, errors, code patterns

### 4.1 Gas attribution across cross-contract chains

**Definitions** (from nearcore):
- `prepaid_gas` (u64): gas attached by signer to a FunctionCall action, purchased up-front at tx gas_price.
- `gas_burnt` (per outcome): gas irreversibly consumed by **this one** receipt/tx (send fees + exec fees + wasm). Does NOT include prepaid_gas forwarded to children.
- `gas_used` (runtime-internal, `ActionResult`): `gas_burnt + Σ(prepaid_gas + exec_fee of new receipts)`.
- `tokens_burnt` (u128 yoctoNEAR, per outcome): `gas_burnt × effective_gas_price` — not always the current chunk's price (see gas_price locking in §1.2).

**Per-action fee triple**: `Fee { send_sir, send_not_sir, execution }`. `send_sir` burns at source when signer==receiver; `send_not_sir` for cross-account; `execution` prepaid on source, burned at destination when receipt runs.

**Function-call cost** ≈
```
action_receipt_creation.{send|exec}
+ function_call_cost.{send|exec}
+ function_call_cost_per_byte.{send|exec} × (|method| + |args|)
+ contract_loading_base + contract_loading_bytes × |code|
+ Σ wasm_op × regular_op_cost
+ Σ host_fn_costs     // storage_read_base, storage_write_base, …
```

**Contract reward**: 30% of the wasm-execution portion of `gas_burnt_for_function_call` (NOT receipt creation / action base fees) is credited to `receiver_id`. **Relayer risk**: relaying calls to attacker-owned contracts drains your faucet.

**Gas refunds**: unused prepaid_gas returns via auto-generated refund ActionReceipts (`predecessor_id="system"`, single Transfer action). Two kinds: deposit refund (`signer_id="system"`, zero pubkey) vs gas refund (`signer_id=original signer`, real pubkey — runtime best-effort re-adds to FunctionCall allowance). Post-NEP-536 (v78) pessimistic pricing is gone: receipts burn at the **original tx's gas_price**. The NEP-536 `gas_refund_penalty` (planned 5% + 1 TGas) is **currently 0** (PR #13579 postponed activation). Refund-transfer execution is free; refund receipts do not count against block gas.

**Limits**:
| Limit | Value |
|---|---|
| `max_total_prepaid_gas` per SignedTransaction | 1 PGas on PV 83 (`300 TGas` before) |
| `max_gas_burnt` per single function call | 1 PGas on PV 83 (`300 TGas`, `200 TGas` before PV 52) |
| Chunk gas limit (nominal) | 1000 TGas (producers may ±0.1%/chunk) |
| Max method name | 256 bytes |
| Max args | 4 MiB |
| Tx size | ~1.5 MB |

As of 2026-04-17, live `EXPERIMENTAL_protocol_config` queries against both
FastNEAR testnet and mainnet report:

- `protocol_version = 83`
- `max_total_prepaid_gas = 1_000_000_000_000_000`
- `max_gas_burnt = 1_000_000_000_000_000`

**Computing total cost from `EXPERIMENTAL_tx_status`**:
```
total_gas   = tx_outcome.gas_burnt + Σ receipts_outcome[i].gas_burnt
total_burnt = tx_outcome.tokens_burnt + Σ receipts_outcome[i].tokens_burnt
net_cost_to_signer = initial_balance − final_balance  # cleanest across affected blocks
```
Refund receipts ARE in `receipts_outcome` (`executor_id==signer`, empty logs, often tokens_burnt≈0 post-v78). The per-receipt `metadata.gas_profile` (when `metadata.version≥2`) breaks down `cost_category/cost/gas_used` — invaluable for attribution (e.g., `WASM_HOST_COST::CONTRACT_LOADING_BYTES`, `ACTION_COST::NEW_ACTION_RECEIPT`). Schema shifts at version 3; branch on `metadata.version` before parsing.

### 4.2 Nonce handling

**Nonce is per-access-key, not per-account.** `AccessKey { nonce: u64, permission: AccessKeyPermission }` keyed by `(account_id, public_key)`. Multiple access keys ⇒ **independent parallel nonce streams** — the primary knob for agent throughput.

Read current nonce:
```json
{"jsonrpc":"2.0","id":1,"method":"query","params":{
  "request_type":"view_access_key","finality":"optimistic",
  "account_id":"agent.near","public_key":"ed25519:…"}}
```

**Validation rules** (`runtime/runtime/src/verifier.rs`):
1. `tx.nonce > access_key.nonce` → else `InvalidTxError::InvalidNonce { tx_nonce, ak_nonce }` (discriminant 3).
2. `tx.nonce ≤ block_height × 1_000_000` (constant `ACCESS_KEY_NONCE_RANGE_MULTIPLIER = 1e6`) → else `InvalidTxError::NonceTooLarge { tx_nonce, upper_bound }` (discriminant 4).
3. On accept, `access_key.nonce := tx.nonce` (assignment, not increment — gaps legal).
4. On AddKey (including implicit account creation), initial nonce seeded to `(block_height − 1) × 1_000_000` — prevents replay after delete+recreate.

**Permission types**:
```rust
enum AccessKeyPermission {
    FunctionCall(FunctionCallPermission { allowance: Option<Balance>, receiver_id: String, method_names: Vec<String> }),
    FullAccess,
}
```
FunctionCall constraint errors (`InvalidAccessKeyError`): `RequiresFullAccess` (multi-action or non-FunctionCall action), `ReceiverMismatch`, `MethodNameMismatch`, `NotEnoughAllowance`, `DepositWithFunctionCall` (nonzero deposit forbidden on FunctionCall keys), `AccessKeyNotFound`.

**Nonce is consumed at tx verification (chunk application)**, before actions. `ActionError` downstream does NOT roll it back. Only `InvalidTxError` (signature, nonce, access key, Expired, InvalidChain, ShardCongested, ShardStuck, NotEnoughBalance, …) leaves the nonce intact.

**Tx block-hash window**: ~24 h; refresh `block_hash` for long-lived agents. Violations: `InvalidTxError::Expired` or `InvalidChain`.

**Agent patterns**:
- Single-key optimistic tracking: keep a local `lastNonce`, increment on submission, resync from chain only on `InvalidNonce`. On `InvalidNonce` post-submission, ALWAYS reconcile via `tx_status` (may mean "already applied") rather than blind resubmit.
- Multi-key parallelism: N FullAccess keys, worker pool leases (key, local_nonce). Scales linearly. near-api-js v5 `MultiKeySigner` does round-robin.
- Gas keys (recent, post-NEP-591): single pubkey carries `num_nonces` parallel streams indexed by `NonceIndex`. New errors: `InvalidNonceIndex`, `NotEnoughGasKeyBalance`, `NotEnoughBalanceForDeposit`.

### 4.3 Error enum taxonomy (from `core/primitives/src/errors.rs`)

```
TxExecutionError
├── InvalidTxError                                   (nonce NOT consumed)
│   ├── InvalidAccessKeyError { AccessKeyNotFound | ReceiverMismatch
│   │                           | MethodNameMismatch | RequiresFullAccess
│   │                           | NotEnoughAllowance | DepositWithFunctionCall }
│   ├── InvalidSignerId / SignerDoesNotExist
│   ├── InvalidNonce / NonceTooLarge
│   ├── InvalidReceiverId / InvalidSignature
│   ├── NotEnoughBalance / LackBalanceForState / CostOverflow
│   ├── InvalidChain / Expired
│   ├── ActionsValidation(TotalPrepaidGasExceeded | FunctionCallZeroAttachedGas | …)
│   ├── TransactionSizeExceeded / InvalidTransactionVersion / StorageError
│   ├── ShardCongested { shard_id, congestion_level }           // NEP-539, v68+
│   ├── ShardStuck { shard_id, missed_chunks }
│   ├── InvalidNonceIndex / NotEnoughGasKeyBalance / NotEnoughBalanceForDeposit  // gas keys
└── ActionError { index: Option<u64>, kind: ActionErrorKind }   (nonce consumed)
    └── ActionErrorKind
        ├── AccountDoesNotExist / AccountAlreadyExists / ActorNoPermission
        ├── CreateAccountNotAllowed / DeleteKeyDoesNotExist / AddKeyAlreadyExists
        ├── LackBalanceForState / DeleteAccountStaking / TriesToUnstake
        ├── DelegateAction{InvalidSignature, InvalidNonce, NonceTooLarge,
        │                  Expired, SenderDoesNotMatchTxReceiver, AccessKeyError}  // NEP-366
        ├── NewReceiptValidationError
        └── FunctionCallError
             ├── CompilationError (CodeDoesNotExist | PrepareError | WasmerCompileError | UnsupportedCompiler)
             ├── LinkError | MethodResolveError (MethodEmptyName | MethodNotFound | MethodInvalidSignature)
             ├── WasmTrap (Unreachable | MemoryOutOfBounds | StackOverflow | IllegalArithmetic | GenericTrap | …)
             ├── HostError (GasExceeded | GasLimitExceeded | BalanceExceeded | GuestPanic{panic_msg}
             │             | IntegerOverflow | InvalidPromise* | MemoryAccessViolation
             │             | BadUTF8/16 | NumberOfLogsExceeded | KeyLengthExceeded
             │             | ValueLengthExceeded | TotalLogLengthExceeded
             │             | NumberPromisesExceeded | ContractSizeExceeded
             │             | ProhibitedInView{method_name} | Deprecated{method_name}
             │             | ECRecoverError | AltBn128InvalidInput | Ed25519VerifyInvalidInput)
             └── WasmUnknownError { debug_message }
```

### 4.4 TypeScript: trace reconstruction with near-api-js

```ts
import { JsonRpcProvider } from "near-api-js/providers";
import type { FinalExecutionOutcome, ExecutionStatus } from "near-api-js/providers/provider";

const provider = new JsonRpcProvider({
  url: "https://archival-rpc.mainnet.fastnear.com",
  headers: { Authorization: `Bearer ${process.env.FASTNEAR_KEY}` },
});

const out: FinalExecutionOutcome = await provider.sendJsonRpc(
  "EXPERIMENTAL_tx_status",
  { tx_hash: txHash, sender_account_id: signerId, wait_until: "FINAL" }
);
// Equivalent: provider.txStatusReceipts(txHash, signerId, "FINAL") — deprecated in newer packages;
// prefer provider.viewTransactionStatusWithReceipts(...) or raw sendJsonRpc for cross-version stability.

const byId = new Map(out.receipts_outcome.map(r => [r.id, r]));

function walk(id: string): { gas: bigint; tokens: bigint; fails: {id:string; err:unknown}[] } {
  const n = byId.get(id); if (!n) return { gas: 0n, tokens: 0n, fails: [] };
  let gas = BigInt(n.outcome.gas_burnt), tok = BigInt(n.outcome.tokens_burnt);
  const fails: any[] = [];
  const s = n.outcome.status as ExecutionStatus;
  if (typeof s === "object" && "Failure" in s) fails.push({ id: n.id, err: s.Failure });
  for (const c of n.outcome.receipt_ids) {
    const sub = walk(c); gas += sub.gas; tok += sub.tokens; fails.push(...sub.fails);
  }
  return { gas, tokens: tok, fails };
}

const tx = out.transaction_outcome.outcome;
let totalGas = BigInt(tx.gas_burnt), totalTok = BigInt(tx.tokens_burnt);
const allFails: any[] = [];
for (const c of tx.receipt_ids) { const r = walk(c); totalGas += r.gas; totalTok += r.tokens; allFails.push(...r.fails); }

const overall = out.status;
const topOk = typeof overall === "object" && "SuccessValue" in overall;
const classify = !topOk ? "HARD_FAIL" : allFails.length ? "PARTIAL_FAIL" : "FULL_SUCCESS";

function decodeSuccess(s: ExecutionStatus): unknown | undefined {
  if (typeof s === "object" && "SuccessValue" in s && s.SuccessValue) {
    const buf = Buffer.from(s.SuccessValue as string, "base64");
    try { return JSON.parse(buf.toString("utf8")); } catch { return buf; }
  }
}
```

Gotchas: `SuccessValue` may be `""` (represents `ReturnData::None`, e.g. Transfer as last action) — not an error. Receipt IDs are base58 CryptoHash strings (not hex). Top-level `SuccessValue` can coexist with failing sibling receipts — always scan.

### 4.5 Rust: near-jsonrpc-client

```rust
use near_jsonrpc_client::{methods, JsonRpcClient};
use near_jsonrpc_primitives::types::transactions::TransactionInfo;
use near_primitives::hash::CryptoHash;
use near_primitives::views::{ExecutionStatusView, TxExecutionStatus,
                             FinalExecutionOutcomeWithReceiptView};
use std::collections::HashMap;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let client = JsonRpcClient::connect("https://archival-rpc.mainnet.fastnear.com");
    let req = methods::tx::RpcTransactionStatusRequest {
        transaction_info: TransactionInfo::TransactionId {
            tx_hash: "9FtH…".parse()?, sender_account_id: "alice.near".parse()?,
        },
        wait_until: TxExecutionStatus::Final,
    };
    let resp = client.call(req).await?;
    let view: FinalExecutionOutcomeWithReceiptView =
        resp.final_execution_outcome.ok_or(anyhow::anyhow!("not final"))?.into_outcome_with_receipt();

    let idx: HashMap<CryptoHash, _> =
        view.receipts_outcome.iter().map(|r| (r.id, r)).collect();

    fn walk(id: &CryptoHash, idx: &HashMap<CryptoHash, &_>, gas: &mut u64, tok: &mut u128,
            fails: &mut Vec<(CryptoHash, ExecutionStatusView)>) {
        let Some(n) = idx.get(id) else { return };
        *gas = gas.saturating_add(n.outcome.gas_burnt);
        *tok = tok.saturating_add(n.outcome.tokens_burnt);
        if let ExecutionStatusView::Failure(_) = &n.outcome.status {
            fails.push((n.id, n.outcome.status.clone()));
        }
        for c in &n.outcome.receipt_ids { walk(c, idx, gas, tok, fails); }
    }

    let mut gas = view.transaction_outcome.outcome.gas_burnt;
    let mut tok = view.transaction_outcome.outcome.tokens_burnt;
    let mut fails = Vec::new();
    for c in &view.transaction_outcome.outcome.receipt_ids {
        walk(c, &idx, &mut gas, &mut tok, &mut fails);
    }
    println!("gas={gas} tokens={tok} failures={}", fails.len());
    Ok(())
}
```

API-drift note: older versions of `near-jsonrpc-client` used `TransactionInfo::TransactionId { hash, account_id }` with no `wait_until`. Modern (≥ nearcore 2.0 / PV 68) uses `tx_hash`, `sender_account_id`, `wait_until: TxExecutionStatus`. Pin crate version to your target protocol version.

### 4.6 Partial-failure classification pattern

```ts
function classify(o: FinalExecutionOutcome) {
  const anyFail = o.receipts_outcome.some(r => typeof r.outcome.status === "object" && "Failure" in r.outcome.status);
  const topFail = typeof o.status === "object" && "Failure" in o.status;
  if (topFail) return "HARD_FAIL";
  if (anyFail) return "PARTIAL_FAIL";
  return "FULL_SUCCESS";
}
```

Sub-classifications agents care about:
- **Callback-swallowed failure**: `.then(cb)` received `PromiseResult::Failed` and returned success (e.g., logged). Semantically intended.
- **Cross-shard stale-state failure**: `ActionError::AccountDoesNotExist` or `NewReceiptValidationError` on a deep receipt.
- **Gas starvation**: `FunctionCallError(HostError(GasExceeded))` mid-chain. Fix: migrate callers to `promise_batch_action_function_call_weight` (NEP-264).
- **Refund-path failure**: refund receipt (`predecessor="system"`) with `Failure` status — amount is **burnt, not re-refunded**. Usually from deleted signer account.

---

## 5. Gotchas and surprising behaviors (flag these prominently in docs)

1. **`tx_status_with_receipts` is not a wire method.** near-api-js name only; dispatches `EXPERIMENTAL_tx_status`.
2. **FastNEAR regular RPC has a narrower (3-epoch) window than near.org (5-epoch).** Default-fallback agents miss history. Route "old" queries to archival.
3. **`sender_account_id` is mandatory on `tx`/`EXPERIMENTAL_tx_status`** — used for shard selection. Wrong value ⇒ `UNKNOWN_TRANSACTION` despite valid hash.
4. **`EXPERIMENTAL_receipt` returns no execution outcome.** Only the Receipt body. Cross-reference via chunk or tx_status.
5. **`receipts` vs `receipts_outcome`**: raw bodies vs outcomes. Both needed; match by `receipt_id`.
6. **Yield/resume can stall `wait_until=FINAL` for up to ~4 minutes.** Detect via `receipt.Action.is_promise_yield=true`; poll with `EXECUTED_OPTIMISTIC` and accept partial traces if needed.
7. **Invalid transactions now generate execution outcomes** (recent nearcore). Old client code that assumed "failures disappear" will now see them indexed.
8. **`big.rpc.fastnear.com` bricks unauthenticated callers** (1 req / ~18 h). Rate-limit signal ≠ outage.
9. **`status` (FinalExecutionStatus) ≠ `final_execution_status` (TxExecutionStatus).** Inspect both: status = tx aggregate result; final_execution_status = finality level of this response.
10. **Top-level `SuccessValue` can hide sibling failures.** Always scan `receipts_outcome`.
11. **Nonce consumed at verification, not execution.** `ActionError` does NOT free the nonce; `InvalidTxError` does.
12. **`SuccessValue` may be empty string** (base64 of zero bytes = `ReturnData::None`) — don't mistake for error.
13. **Local receipts** (signer==receiver) are not persisted in nearcore DB; indexers see `Option<Receipt>::None`.
14. **Refund receipts are in `receipts_outcome`.** Filter for user-facing views; keep for accounting.
15. **`gas_refund_penalty` (NEP-536) is currently 0 in v78** — parameters postponed via PR #13579. Agents must tolerate its future activation (~5% + 1 TGas).
16. **Promise DAG is not a tree** — `promise_and` + `.then()` produce multi-input receipts. Dedupe by `receipt_id`.
17. **Delayed receipt queue has no finite lookahead.** Streaming tracers must persist `pending` sets; flag anomalies at ~1000-block gaps.
18. **Contract reward: receivers get 30% of `gas_burnt_for_function_call`.** Relayer honeypot vector.
19. **`create_receipt_id_from_transaction` derives from prev-block hash** — receipt IDs are not predictable from `tx_hash` alone.
20. **No Ethereum-style `debug_trace*` exists** on NEAR. "Tracing" = walking the receipt graph via `EXPERIMENTAL_tx_status`.

---

## Conclusion — the agent-optimized mental model

The cleanest way to tell an LLM agent to trace a NEAR cross-contract call: **"It's a DAG of receipts. You have a flat list of outcomes and a starting receipt_id. Walk `outcome.receipt_ids` recursively until every terminal outcome is `SuccessValue` or `Failure`. If `status` is `SuccessReceiptId`, the real answer is downstream — recurse. Any `Failure` anywhere means partial failure even if top-level status shows success. Refund receipts (predecessor=`system`) are accounting-only. If the trace is older than 21 h, use FastNEAR archival; if you only have a receipt_id, pivot via `POST tx.main.fastnear.com/v0/receipt`; if you're streaming, use neardata.xyz because it pre-joins tx_hash onto every outcome."**

The three highest-leverage facts for agent docs, in order: (1) the distinction between `SuccessReceiptId` and `SuccessValue` drives all recursion; (2) FastNEAR's `/v0/receipt` + neardata's `tx_hash` enrichment eliminate the hardest indexer bug; (3) nonce is per-access-key and per-access-key parallelism is the throughput primitive. Everything else is plumbing.
