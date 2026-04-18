# 2026-04-18 · FastNEAR endpoint usage in this repo

*Reference doc for the FastNEAR docs team (docs.fastnear.com). Catalogs
every RPC / API call this repo makes, how we're calling it, and why we
chose that endpoint over alternatives. Goal: concrete usage evidence
from a real testnet workflow — lift whatever is useful.*

## TL;DR — what we use and why

We built an observability toolkit for a NEAR smart-account contract that
uses NEP-519 yield/resume to release cross-contract receipts in a
deterministic order. The core mental model is a **three-surfaces
method**: every cascade is studied via receipt DAG + block-pinned state
time-series + account activity feed. FastNEAR is the ground truth
underneath all three:

| Surface | FastNEAR call | Why |
|---|---|---|
| Receipt DAG | `EXPERIMENTAL_tx_status` (JSON-RPC) | the authoritative receipts/outcomes tree, walked locally |
| Archival fallback | same, on `archival-rpc.*.fastnear.com` | 3-epoch (~21 h) retention on regular RPC — yesterday's tx needs archival |
| Per-block receipts | `POST /v0/block` with `with_receipts=true` (tx API) | filter block receipts by tx / receipt_id; RPC doesn't expose this view |
| State time-series | `query { request_type: "call_function", block_id: <h> }` (JSON-RPC) | block-pinned view calls make state changes observable frame-by-frame |
| Signer resolution | `POST /v0/transactions` (tx API) | reverse-lookup signer from tx hash; useful when user only has the hash |
| Activity feed | `POST /v0/account` (tx API) | rich flag filtering (is_signer, is_function_call, …) beyond what RPC provides |
| Receipt pivot | `POST /v0/receipt` (tx API) | given a receipt_id from a trace, find its parent tx and shard/block context |
| Chain tip | `GET /v0/last_block/{final,optimistic}` (neardata) | stream the tip for time-of-flight or freshness checks |

All code paths live in `scripts/lib/fastnear.mjs` (HTTP + auth +
network config), `scripts/lib/trace-rpc.mjs` (tx-status logic),
`scripts/lib/near-cli.mjs` (view + tx helpers), and the observability
CLIs under `scripts/`. The `scripts/investigate-tx.mjs` wrapper
composes all of these in one invocation.

## Network config

Single source of truth: `getNetworkConfig(network)` in
[`scripts/lib/fastnear.mjs:36`](../scripts/lib/fastnear.mjs).

```js
testnet:
  rpc:         https://rpc.testnet.fastnear.com
  archivalRpc: https://archival-rpc.testnet.fastnear.com
  txApi:       https://tx.test.fastnear.com
  nearData:    https://testnet.neardata.xyz
  fastApi:     https://test.api.fastnear.com

mainnet:
  rpc:         https://rpc.mainnet.fastnear.com
  archivalRpc: https://archival-rpc.mainnet.fastnear.com
  txApi:       https://tx.main.fastnear.com
  nearData:    https://mainnet.neardata.xyz
  fastApi:     https://api.fastnear.com
```

Notably the tx API is on a different short-name (`tx.test.*` vs
`rpc.testnet.*`) — worth calling out in the docs so people don't
concatenate paths against the wrong base.

## Auth

`FASTNEAR_API_KEY` env var, picked up automatically by
[`loadEnvFile()` on import](../scripts/lib/fastnear.mjs:9).

Two application modes, both implemented in
[`request()`](../scripts/lib/fastnear.mjs:106):

1. **Bearer header (default)**: `Authorization: Bearer <key>`. Used by
   all JSON-RPC and tx API calls.
2. **Query param**: `?apiKey=<key>` via
   [`withApiKey()`](../scripts/lib/fastnear.mjs:60). Used only by
   [`nearDataGet()`](../scripts/lib/fastnear.mjs:204), because
   `testnet.neardata.xyz` redirects to a CDN URL that doesn't
   preserve the bearer header. Query-param mode survives the redirect.

If docs.fastnear.com could note explicitly *which* endpoints accept
which auth form, that would save people the empirical round-trip we
did. In particular: whether bearer works on `neardata.xyz` after
redirect, or whether the query-param is the intended auth for that
surface.

## Reliability pattern we use everywhere

**Archival failover on `UNKNOWN_TRANSACTION`** — the regular RPC has a
~21 h retention window, so any tx older than yesterday returns an
error. Our pattern:

```js
// scripts/lib/trace-rpc.mjs:25-43
let raw = await rpcCall(network, "EXPERIMENTAL_tx_status", params);
if (isUnknownTransaction(raw.error)) {
  raw = await rpcCall(network, "EXPERIMENTAL_tx_status", params, {
    archival: true,
  });
}
```

`isUnknownTransaction` checks both `error.cause.name` and the
stringified error payload, because the error shape varies by error
surface:

```js
// scripts/lib/trace-rpc.mjs:17-23
function isUnknownTransaction(error) {
  if (!error) return false;
  if (error.cause?.name === "UNKNOWN_TRANSACTION") return true;
  return /UNKNOWN_TRANSACTION/.test(
    `${error.name || ""} ${error.message || ""} ${error.data || ""}`
  );
}
```

**Suggestion for docs**: a canonical "when to use archival vs.
regular" section with the exact error shape the regular RPC returns
for expired txs would be ideal. We reverse-engineered this from
stderr; a linkable doc would help.

## Endpoint-by-endpoint

### 1. `POST <rpc>` — JSON-RPC

Uniform JSON-RPC 2.0 wrapper in
[`rpcCall()`](../scripts/lib/fastnear.mjs:148):

```js
body: { jsonrpc: "2.0", id: "fastnear", method, params }
```

We exercise three `method` values.

---

#### 1a. `EXPERIMENTAL_tx_status`

**Where**: [`fetchTxStatus()` in `scripts/lib/trace-rpc.mjs:25-44`](../scripts/lib/trace-rpc.mjs), called by every `trace-tx.mjs` / `investigate-tx.mjs` run.

**Parameters**:
```json
{
  "tx_hash": "...",
  "sender_account_id": "...",
  "wait_until": "EXECUTED_OPTIMISTIC" | "FINAL"
}
```

**What we extract**:
- `result.transaction_outcome.{block_hash, outcome.gas_burnt, outcome.tokens_burnt, outcome.receipt_ids}` — the tx node.
- `result.receipts[]` — each has `{receipt_id, predecessor_id, receipt.Action.{actions, is_promise_yield, input_data_ids, output_data_receivers}}`. Needed to see per-action detail and detect yielded promises.
- `result.receipts_outcome[]` — each has `{id, block_hash, outcome.{executor_id, logs, gas_burnt, tokens_burnt, status, receipt_ids}}`. Needed for execution outcomes, logs, and — critically — **per-receipt `block_hash`**.

**How we use the pair**: `buildTree()` in `scripts/lib/trace-rpc.mjs:73-136` zips `receipts[]` with `receipts_outcome[]` into a tree with one node per receipt, walking from `transaction_outcome.receipt_ids` downward.

**Why this endpoint and not `tx`**: we need both the outcome status (for classification / logs) AND the action-level data (for `is_promise_yield` detection, input data IDs, etc.). The plain `tx` method collapses too much.

**Wait mode tradeoffs**:
- `EXECUTED_OPTIMISTIC` (our `investigate-tx.mjs --wait EXECUTED` default): returns in ~seconds. Fine for interactive debugging. May surface `PENDING` classification for cross-shard receipts that haven't all resolved yet.
- `FINAL`: can take ~100 s for yielded callbacks that haven't released (the 200-block yield timeout). Use for durable artifacts.
- We don't use `EXECUTED` or `INCLUDED` — they'd be a middle ground but haven't seemed necessary.

**What `block_hash` enrichment gives us**: `receipts_outcome[i].block_hash` is present in every response, and we recently added it to each receipt-tree node. This lets one-pass tree walks collect "which blocks does this cascade touch?" without a secondary RPC per receipt. This is load-bearing for the `investigate-tx.mjs` three-surfaces pipeline.

**Gotcha worth documenting**: the response shape includes `receipts_outcome[i].proof`, which can be very large for multi-hop cascades. We don't use it; perhaps the docs could note that it can be trimmed client-side when bandwidth matters.

---

#### 1b. `query { request_type: "call_function" }`

**Where**: [`callViewMethod()` in `scripts/lib/near-cli.mjs:91-124`](../scripts/lib/near-cli.mjs), and [`scripts/state.mjs:61-67`](../scripts/state.mjs) for the CLI path.

**Parameters**:
```json
{
  "request_type": "call_function",
  "account_id": "...",
  "method_name": "...",
  "args_base64": "<base64>",
  "block_id": 123456  // OR
  "finality": "final" | "near-final" | "optimistic"
}
```

**Exactly one of `block_id` / `finality`** — this is our usage contract, enforced in `callViewMethod`. The wrapper defaults to `finality: "final"` when the caller passes neither.

**Why block-pinning matters to us**: the whole "state time-series" surface depends on it. `scripts/investigate-tx.mjs` picks a set of interesting block heights around a cascade and calls this endpoint at each, so the returned JSON shows `staged_calls_for(caller)` drain over cascade blocks. Without `block_id`, we'd only see the tail state, not the trajectory.

**Response shape we rely on**:
```json
{
  "result": {
    "result": [bytes],      // view-method return bytes
    "block_height": 123,    // the block actually queried (may differ from requested hash)
    "block_hash": "...",
    "logs": [...]           // any near_sdk::env::log_str lines from the view
  }
}
```

We decode `result.result` as UTF-8 JSON by default, falling back to a
string when not JSON (`decodeViewBytes()`).

**Error surfacing observation**: method-level errors (MethodNotFound,
contract panic, deserialization failure) come back with HTTP 200 and
`result.error` *inside* the successful response. Tool-level errors
(malformed params, unknown account) come back with a top-level
`error`. Our `callViewMethod` treats both as throws.

**Suggestion**: a canonical "errors from view calls" table in
docs.fastnear.com would be useful. The two-level error shape is
confusing on first encounter.

---

#### 1c. `query { request_type: "view_state" }`

**Where**: [`scripts/state.mjs:69-74`](../scripts/state.mjs).

**Parameters**:
```json
{
  "request_type": "view_state",
  "account_id": "...",
  "prefix_base64": "<base64>",
  "block_id": 123  // OR
  "finality": "final"
}
```

**Response**: `{ result: { values: [{ key, value }], block_height, block_hash } }` where `key` and `value` are base64.

**Why we use this rarely**: when a contract doesn't expose a view for
the collection we want (e.g., poking at raw storage during early
development), or when we want to see every entry across every caller
at once without filtering.

**Pattern we didn't need but might**: no `prefix` means "dump
everything." For a contract with lots of keys, pagination via
`proof`-style continuation would be welcome. Not blocking us today.

---

### 2. `POST <tx-api>/v0/transactions` — hash → tx detail

**Where**: [`resolveSenderId()` in `scripts/lib/trace-rpc.mjs:10-15`](../scripts/lib/trace-rpc.mjs) and [`buildTxArtifact()` in `scripts/lib/near-cli.mjs:133-150`](../scripts/lib/near-cli.mjs).

**Parameters**:
```json
{ "tx_hashes": ["..."] }
```

**What we use**: `transactions[0].transaction.signer_id` — reverse-lookup signer from hash.

**Why we need it**: `EXPERIMENTAL_tx_status` requires `sender_account_id` as a parameter, but users commonly only have the hash (from a deploy log, a block explorer link, a chat message). We resolve the signer first, then trace. Saves users from typing something they shouldn't need to know.

**Also used**: pairing tx hashes with `execution_outcome.block_height` / `execution_outcome.block_hash` in `buildTxArtifact`, which the send-* scripts use to log "this tx landed at block X".

**Suggestion for docs**: the tx-API's `/v0/transactions` is the
cheapest way to do signer resolution. Worth calling out as the
canonical pattern, since the alternative (searching activity across
possible signers) is much worse.

**Mild wish**: single-hash convenience form `?tx_hash=...` as a GET, so
it's usable from a plain `curl` without `-d '{...}'`. Not critical.

---

### 3. `POST <tx-api>/v0/account` — activity feed

**Where**: [`fetchAccountHistory()` in `scripts/lib/fastnear.mjs:172-193`](../scripts/lib/fastnear.mjs) (new wrapper) and [`scripts/account-history.mjs:40-63`](../scripts/account-history.mjs) (CLI, still inline).

**Parameters** (body):
```json
{
  "account_id": "...",
  "limit": 50,
  "desc": false,
  "from_tx_block_height": <int>,
  "to_tx_block_height": <int>,
  "resume_token": "...",
  "is_signer": true, "is_receiver": true, "is_predecessor": true,
  "is_function_call": true, "is_real_receiver": true, "is_real_signer": true,
  "is_any_signer": true, "is_delegated_signer": true,
  "is_action_arg": true, "is_event_log": true,
  "is_explicit_refund_to": true,
  "is_success": true | false
}
```

**What we consume**: `account_txs[]` each with `{transaction_hash, tx_block_height, tx_block_timestamp, is_*: bool...}` and `resume_token` for pagination.

**Why this instead of RPC**: the filter flags (`is_signer`,
`is_function_call`, `is_explicit_refund_to`, etc.) are rich enough to
ask targeted questions like "show me only the successful function
calls where mike.testnet was the real signer inside this block
window." That's impossible via plain RPC — you'd have to walk blocks
and filter client-side, which is infeasible for a ~4000-block range.

**Pattern we rely on**: passing both `from_tx_block_height` and
`to_tx_block_height` to bound a cascade window. The returned rows are
already inside that window, so we don't filter client-side.

**Suggestion for docs**: a diagram that explains the `is_real_*`
variants vs the basic `is_signer` / `is_receiver`. We inferred the
difference (real = user-signed, non-delegated) from experimentation;
a doc section would save that effort.

**Mild wish**: `is_event_log` with a substring / regex filter (not
just presence). Let us say "activity where a log containing
`ft_transfer` was emitted."

---

### 4. `POST <tx-api>/v0/block` — block detail with receipts

**Where**: [`fetchBlock()` in `scripts/lib/fastnear.mjs:195-202`](../scripts/lib/fastnear.mjs) (new wrapper) and [`scripts/block-window.mjs:23-27`](../scripts/block-window.mjs) (CLI, still inline).

**Parameters**:
```json
{
  "block_id": 123456 | "<hash>",
  "with_receipts": true,
  "with_transactions": true
}
```

**Response** shape that matters to us:
```json
{
  "block": {
    "block_height": 123,
    "block_hash": "...",
    "author_id": "...",
    "block_timestamp": "<ns>",
    "num_transactions": ...,
    "num_receipts": ...,
    "gas_burnt": ...,
    "tokens_burnt": "..."
  },
  "block_txs": [
    { "tx_index", "transaction_hash", "signer_id", "receiver_id",
      "is_completed", "is_success" }
  ],
  "block_receipts": [
    { "receipt_index", "receipt_id", "receipt_type",
      "predecessor_id", "receiver_id", "is_success", "transaction_hash" }
  ]
}
```

**Why we use it**: `block_receipts` is the key surface. After
`EXPERIMENTAL_tx_status` tells us the tree of receipts (keyed by
receipt_id + block_hash), we hit `/v0/block` for each unique block
hash to get the per-block receipt index. That's how
`investigate-tx.mjs` answers "which cascade receipts fired in each
block?" and formats the per-block-receipts table in its report.

**Dual-keying (`block_id` accepts height or hash)**: crucial for us.
We enter with a block_hash (from receipts_outcome) and want to resolve
to height + contents in one call. Having both keys be acceptable on
the same field means we don't need a separate resolver.

**Suggestion for docs**: explicit callout that `block_id` accepts
either form. Many APIs split these into two endpoints; the unified
form is genuinely nicer.

---

### 5. `POST <tx-api>/v0/blocks` — block range

**Where**: [`scripts/block-window.mjs:69-74`](../scripts/block-window.mjs).

**Parameters**:
```json
{
  "from_block_height": <int>,
  "to_block_height": <int>,
  "limit": 10,
  "desc": false
}
```

**Response**: `{ blocks: [...] }` — same `block` shape as `/v0/block` but without receipts/txs.

**Why**: range surveys when we don't yet know the interesting blocks
(e.g., "what happened on testnet around this time?"). Less common in
our workflow than single-block lookups.

**Mild wish**: a combined "range with receipts" that returns
per-block receipts for many blocks in one call. Currently a range
survey requires one follow-up `/v0/block` per block of interest.
Would compress the `investigate-tx.mjs` trailing-tail loop from N
calls to 1.

---

### 6. `POST <tx-api>/v0/receipt` — receipt → tx pivot

**Where**: [`scripts/receipt-to-tx.mjs:22-24`](../scripts/receipt-to-tx.mjs).

**Parameters**:
```json
{ "receipt_id": "..." }
```

**Response** shape we use:
```json
{
  "receipt": {
    "receipt_id", "receipt_type", "is_success",
    "transaction_hash",
    "predecessor_id", "receiver_id", "shard_id",
    "appear_block_height", "appear_receipt_index",
    "block_height", "receipt_index",
    "tx_block_height", "tx_block_timestamp", "block_timestamp"
  },
  "transaction": {
    "transaction": { "signer_id", "receiver_id", "nonce", "actions" },
    "receipts": [...],
    "data_receipts": [...]
  }
}
```

**Why we need it**: given only a receipt_id from a log, a cascade
dump, or an explorer link, pivot back to its parent tx and
shard/block context without knowing the tx hash. Particularly useful
when debugging "which of the three batch txs this block contained is
the one that spawned this receipt?"

**Suggestion for docs**: the `appear_*` vs `block_*` vs `tx_block_*`
triple deserves a short explainer. We learned the distinction:
- `appear_*`: when the receipt was first observed in the incoming
  queue of its executor shard
- `block_*`: when it actually executed
- `tx_block_*`: the original submission tx's included-in-block

This is useful semantics and should be canonical in docs.

---

### 7. `GET <nearData>/v0/last_block/{final,optimistic}` — chain tip

**Where**: [`scripts/watch-tip.mjs:27-35`](../scripts/watch-tip.mjs) via [`nearDataGet()` in `scripts/lib/fastnear.mjs:204-210`](../scripts/lib/fastnear.mjs).

**Why**: polling the tip for "is the network responsive?" /
time-of-flight measurements / freshness checks. We run
`watch-tip.mjs --kind final` in a sidebar during long experiments
to see when our txs land relative to chain progression.

**Auth caveat** (already mentioned): we pass `?apiKey=<key>` here
because the bearer header doesn't survive the redirect to the CDN.

**Mild wish**: `text/event-stream` subscription so we don't need to
poll. Not a big deal — 2-second poll is fine — but would be cleaner.

---

### 8. `query_{sync,async,commit}` — implicit via near-api-js

Our send-* scripts (e.g., `scripts/send-stage-call-multi.mjs`) use
`near-api-js` via [`connectNearWithSigners()` in
`scripts/lib/near-cli.mjs:42-64`](../scripts/lib/near-cli.mjs). That
library hits the node URL from our config
(`cfg.rpc = rpc.testnet.fastnear.com`) for `broadcast_tx_commit` /
`broadcast_tx_async`. We don't call these directly.

**Notable**: we found that the *legacy* public testnet RPC
(`rpc.testnet.near.org`) misreports parent-account existence during
`near create-account` flows, so our deploy script forces
`NEAR_TESTNET_RPC=https://test.rpc.fastnear.com` for the old `near`
CLI. Reliability win for us that's probably worth documenting as a
known FastNEAR vs legacy difference.

## Cross-cutting observations & wishes

**1. Dual-path auth confusion.** We have a rule: bearer header
everywhere except `neardata.xyz`, which needs the query param. If
docs.fastnear.com could formalize this (per-surface auth table), new
users wouldn't have to discover it by trial.

**2. Retention policy.** "Regular RPC retains ~3 epochs (~21 h);
archival retains indefinitely" is a real operational constraint. A
canonical error shape + failover pattern in docs would save every
consumer the reinvention we did.

**3. Error surface consistency.** RPC returns errors in
`response.error` for protocol-level issues, `response.result.error`
for method-level issues (view calls), and HTTP status codes for
transport failures. A doc that enumerates which shape appears when
would prevent a class of bugs.

**4. Tx-API is underused.** Outside of `/v0/transactions`, we suspect
most people trying to build debugging tooling hit plain RPC and
stop there. The tx-API's `/v0/account`, `/v0/block`, and `/v0/receipt`
are genuinely better than the RPC equivalents for
observability/debugging use cases. A "if you're building a debugging
tool, use the tx-API" signpost would help.

**5. Archival rate limits.** We haven't hit them, but we also haven't
automated heavily. If archival has different limits than regular RPC
(which it probably should, given archival queries are more
expensive), docs specifying the tier-up path would be welcome.

**6. `with_receipts` is the feature we always want.** On `/v0/block`.
If docs could highlight it prominently, that'd match how we actually
use it — the flag is easy to miss in a long parameter list.

**7. Concrete evidence.** If any of the above is useful as
documentation, the code paths listed per section are stable and
citable. The `scripts/investigate-tx.mjs` wrapper is probably the
single best "real usage" artifact, since it composes five of these
endpoints into one flow.

## Summary table: "from this question, use this call"

| Question we're trying to answer | Call |
|---|---|
| What receipts did this tx spawn, in tree form? | `EXPERIMENTAL_tx_status` |
| Who signed this tx (given only the hash)? | `POST /v0/transactions` |
| What did this account do in block range [A,B]? | `POST /v0/account` with `from_`/`to_tx_block_height` |
| What receipts fired in block X, and which tx spawned each? | `POST /v0/block` with `with_receipts=true` |
| Given a receipt_id, what tx is it a descendant of? | `POST /v0/receipt` |
| What's the state of contract C at block X? | `query` with `request_type: "call_function"` and `block_id: X` |
| What's the current tip height? | `GET /v0/last_block/final` |
| Was tx T traceable more than 21 h ago? | Same calls, but on `archival-rpc.*.fastnear.com` |

---

*Happy to answer questions, run follow-up traces, or adapt any
section for inclusion in docs.fastnear.com. Code references are
stable at the paths above; link anywhere with line numbers.*
