# Mainnet proof — v4.0.2-ops on `mike.near`

Four reference artifacts capture fresh live runs against the
**currently-deployed** kernel on `mike.near`. The first three isolate
a single new v4 primitive each; the fourth composes four primitives in
one real-dapp flow on `intents.near`. Every tx hash and block hash
below resolves on any public NEAR archival RPC — no coordination with
the repo maintainer required.

| Flagship | Primitives exercised | Reference artifact | Tx hash | Block hash |
|---|---|---|---|---|
| **T1 PreGate** | PreGate | [`mike-near-v4.0.2-limit-order.json`](./collab/artifacts/reference/mike-near-v4.0.2-limit-order.json) | `9quv5g2S1c4ZeLJQrMZmSpuGwfYM4fX4Y61GfA7vf4Cr` | `hdRtm4YTx3a5UXDNYj96hw4aGBk1HCWvqWB64DnYHcA` |
| **T2 value threading** | `save_result` + `args_template` | [`mike-near-v4.0.2-ladder-swap.json`](./collab/artifacts/reference/mike-near-v4.0.2-ladder-swap.json) | `9BQbtMwEgA6TvEaeCANbk8PoRjShUSEzhKdFLtXks2nL` | `3b3KyHu1UozT5Yax5gWhapZ58aW4xDtJUUbpNPqQptzm` |
| **T3 session keys** (enroll) | Session keys | [`mike-near-v4.0.2-session-dapp.json`](./collab/artifacts/reference/mike-near-v4.0.2-session-dapp.json) | `8xfeHbuSHRoX1sbG6VSTgBNMHG9ssRKhwHd9Ur5jLYDY` | `94m7qCxDTEEUkySxs1BR4DFeyZDPALaRzVzbXfzZHvis` |
| T3 session keys (fire #1) | Session keys | ↑ same | `C1tise22QTZ9n78u1ABXyfC3Safw4zaWmhd22wKXFgkU` | (in artifact) |
| T3 session keys (fire #2) | Session keys | ↑ same | `8TRodh9z7kMYRHjBGsUuxzg7VKBA33SAkFAZ3US8vRzq` | (in artifact) |
| T3 session keys (fire #3) | Session keys | ↑ same | `ACtiPBXRRuZL5C1Vt6SRb7KzUJxt4cBaRiuGA5okJdLs` | (in artifact) |
| T3 session keys (revoke) | Session keys | ↑ same | `qtMAmsLzdaVPwyRNCWWR9MYZxbLzEZAbwMor7G6tVtw` | `DipZxEhqPPZMkv67qQ55FWhpxwU9JnWm1ytqKvidHFHA` |
| **Real-dapp** — `intents-deposit-limit` (pass fire) | PreGate × 2 + threading + session key | [`mike-near-v4.0.2-intents-deposit-limit.json`](./collab/artifacts/reference/mike-near-v4.0.2-intents-deposit-limit.json) | `65K4kDyd8Ab3vWnsdAB81YK5ptYLJ1Xem3ea1sRXZx9L` | `8WWSCDqcBWusDP8SsTLLye5w42zjAm5ZuC85p5oMEY8F` |
| Real-dapp (halt fire) | PreGate × 2 + threading + session key | ↑ same | `EEC83UhpqvckEcuMnYqekQgR6jpuLMGtJJctxE23HhX` | `6nCyyuMA3j9op6vaCJH1gS6yhi3F5HoL8R1oadGhNYMX` |
| Real-dapp (enroll) | Session key | ↑ same | `J3tM59hG87rFZsgpoTj4UPH4r3w2wptWnnYYXsZMGems` | (in artifact) |
| Real-dapp (revoke) | Session key | ↑ same | `DnYZB24ShHFz2BicgkmP1BS3GDAX79hSHCABJUoNxknD` | (in artifact) |

**Archival endpoint used for every verification below:**
[`https://archival-rpc.mainnet.fastnear.com`](https://docs.fastnear.com/rpc)
— public, no-auth, documented archival RPC. Any of the recipes
below also work against the non-archival `rpc.mainnet.fastnear.com`
for recent blocks, but the archival subdomain is the correct
endpoint for historical `block_id` queries (all recipes pin a
specific block).

> Note: Pagoda's archival endpoint
> (`https://archival-rpc.mainnet.near.org`) is being deprecated as of
> 2026-04-19 and returns a warning. Use FastNEAR.

**FastNEAR surfaces this doc uses** (see
[`docs.fastnear.com`](https://docs.fastnear.com) for full specs):

| Surface | Purpose | Used in |
|---|---|---|
| `archival-rpc.mainnet.fastnear.com` (JSON-RPC) | Historical `query` + `tx` calls pinned to a block | Recipes 1–3 |
| `api.fastnear.com/v1/account/{id}/full` (REST GET) | Indexed account inventory (FT / NFT / staking / balance — not `code_hash`) | — |
| `tx.main.fastnear.com/v0/transactions` (POST, batch ≤ 20) | Fetch multiple tx hashes in one round-trip | Alternative to Recipe 2 when verifying many txs |

Authentication is optional across all three. Add `?apiKey=…` or an
`Authorization: Bearer` header to raise rate limits.

## Three orthogonal verification paths

Each recipe below exercises a different surface of the proof. A
skeptical reader who runs all three is combining independent
failure modes:

| Path | What it proves | Fails only if… | Time |
|---|---|---|---|
| **1a. `contract_version` at block** | The contract code self-reported as `v4.0.2-ops` at the tx's block | FastNEAR archival retention expires for the block | ~30 s |
| **1b. `code_hash` at block** | The actual WASM bytes the validator runs SHA-256 to `DytwYt4…kwQvy4` | Same as 1a | ~30 s |
| **2. Events list from tx** | The events the artifact claims were emitted actually landed on-chain, in that order | FastNEAR returns falsified tx data (and no other archival RPC agrees) | ~1 min per tx |
| **3. Balance delta at block** | Money actually moved: `intents.near`'s NEP-245 ledger for `mike.near` grew by the exact yocto amount recorded | Same as (2) | ~2 min |

Agreement across all three reduces residual trust in this repo
to near zero. Disagreement on any one row localizes the problem
to the archival endpoint, the artifact, or the repo — not to
the chain.

For a focused run of all three on just the 4-primitive flagship
(~2 min total), see [`QUICK-VERIFY.md`](./QUICK-VERIFY.md).

## Verification recipe 1 — confirm the kernel version at the tx's block

Two independent surfaces pin the kernel at the same block:

**1a — contract_version view (human-readable):**

This proves the contract code that emitted the artifact's events
self-identified as `v4.0.2-ops` at the exact block the tx landed in.

```bash
curl -s -X POST https://archival-rpc.mainnet.fastnear.com \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{
    "request_type":"call_function",
    "block_id":"hdRtm4YTx3a5UXDNYj96hw4aGBk1HCWvqWB64DnYHcA",
    "account_id":"mike.near",
    "method_name":"contract_version",
    "args_base64":"e30="
  }}' | jq -r '.result.result | map(.) | implode'
```

**Expected output:**

```
"v4.0.2-ops"
```

**1b — code_hash view (byte-level):**

Same block, a separate RPC surface. Returns the actual
SHA-256-hashed WASM bytes of the deployed contract — what the
validator runs, not what the contract says about itself.

```bash
curl -s -X POST https://archival-rpc.mainnet.fastnear.com \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{
    "request_type":"view_account",
    "block_id":"hdRtm4YTx3a5UXDNYj96hw4aGBk1HCWvqWB64DnYHcA",
    "account_id":"mike.near"
  }}' | jq '.result.code_hash'
```

**Expected output (base58-encoded SHA-256 of the deployed wasm):**

```
"DytwYt4tMP849QjXAQZFeEMuvMYUVq1bvyhwk8JWQvy4"
```

The base58-decoded bytes of this value are what a future
reproducible-build recipe would compare against
`sha256(res/smart_account_local.wasm)` to prove the source code
here is what produced the deployed binary (see "Trust boundaries"
below for the current state of that bridge).

1a and 1b are independent: 1a reads a contract-provided string
(trusts the contract's self-report), 1b reads a validator-computed
hash (doesn't). Agreement across both = kernel pinned.

Swap the `block_id` for any tx's `block_info.transaction_block_hash`
from the artifact — every one of them resolves to the same kernel
version. (`args_base64: "e30="` is just base64 of `{}`.)

## Verification recipe 2 — confirm events match the artifact

This proves the events the artifact claims were emitted actually
landed on-chain.

```bash
curl -s -X POST https://archival-rpc.mainnet.fastnear.com \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tx","params":[
    "9quv5g2S1c4ZeLJQrMZmSpuGwfYM4fX4Y61GfA7vf4Cr",
    "mike.near"
  ]}' | python3 -c "
import sys, json
r = json.load(sys.stdin)['result']
events = []
for ro in r['receipts_outcome']:
    for log in ro['outcome']['logs']:
        if log.startswith('EVENT_JSON:'):
            events.append(json.loads(log[11:])['event'])
print('receipts:', len(r['receipts_outcome']))
print('events :', events)
"
```

**Expected output for the PreGate tx above:**

```
receipts: 11
events : ['step_registered', 'sequence_started', 'step_resumed', 'pre_gate_checked', 'step_resolved_ok', 'sequence_completed']
```

Open `collab/artifacts/reference/mike-near-v4.0.2-limit-order.json`
and look at `structured_events[*].event` — the archival RPC returns
the same list in the same order.

## Verification recipe 3 — the 4-primitive flagship, both branches

This walks the headline claim end-to-end: the `intents-deposit-limit`
flagship ran on mainnet, moved `~0.445 wNEAR` into `intents.near`'s
NEP-245 ledger for `mike.near`, and proved both branches of the
pre-dispatch gate (deposit + refuse) in one session. Each sub-recipe
reads a different surface of the same artifact —
`collab/artifacts/reference/mike-near-v4.0.2-intents-deposit-limit.json`.

### 3a. Pass fire ended with `sequence_completed` + `mt_mint`

```bash
curl -s -X POST https://archival-rpc.mainnet.fastnear.com \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tx","params":[
    "65K4kDyd8Ab3vWnsdAB81YK5ptYLJ1Xem3ea1sRXZx9L",
    "mike.near"
  ]}' | python3 -c "
import sys, json
r = json.load(sys.stdin)['result']
for ro in r['receipts_outcome']:
    for log in ro['outcome']['logs']:
        if log.startswith('EVENT_JSON:'):
            e = json.loads(log[11:])
            print(e.get('standard','?'), '/', e['event'])
"
```

**Expected output** — 15 EVENT_JSON logs total:

```
sa-automation / session_fired
sa-automation / step_registered
sa-automation / step_registered
sa-automation / trigger_fired
sa-automation / sequence_started
sa-automation / step_resumed
sa-automation / pre_gate_checked
sa-automation / result_saved
sa-automation / step_resolved_ok
sa-automation / step_resumed
sa-automation / pre_gate_checked
nep245 / mt_mint
sa-automation / step_resolved_ok
sa-automation / sequence_completed
sa-automation / run_finished
```

Two standards:

- **`sa-automation` (14 events)** — emitted by our kernel on
  `mike.near`. Step 1's `pre_gate_checked` gates the
  `wrap.near.ft_balance_of` floor; step 2's `pre_gate_checked`
  gates the Ref Finance quote; both `in_range`; sequence
  completes. These 14 match `.structured_events.fire_pass` in
  the artifact byte-for-byte:
  `jq -r '.structured_events.fire_pass | map(.event) | .[]'`.
- **`nep245 / mt_mint` (1 event)** — emitted by `intents.near`
  itself when the deposit hit its NEP-245 ledger. This is
  *venue-side* confirmation — the destination contract
  independently logging that the balance grew. In recipe 3c
  below we confirm the same fact via a `mt_balance_of` diff
  across blocks; the `mt_mint` event and the balance diff are
  two different RPC surfaces proving the same underlying state
  change.

### 3b. Halt fire refused, pre-gate out of range, no `mt_mint`

```bash
curl -s -X POST https://archival-rpc.mainnet.fastnear.com \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tx","params":[
    "EEC83UhpqvckEcuMnYqekQgR6jpuLMGtJJctxE23HhX",
    "mike.near"
  ]}' | python3 -c "
import sys, json
r = json.load(sys.stdin)['result']
for ro in r['receipts_outcome']:
    for log in ro['outcome']['logs']:
        if log.startswith('EVENT_JSON:'):
            e = json.loads(log[11:])
            std = e.get('standard','?')
            name = e['event']
            if name == 'pre_gate_checked':
                d = e['data']
                print(f\"{std} / {name}  step={d['step_id']}  outcome={d['outcome']}  matched={d['matched']}\")
            elif name == 'sequence_halted':
                d = e['data']
                print(f\"{std} / {name}  reason={d['reason']}  error_kind={d['error_kind']}\")
            else:
                print(f\"{std} / {name}\")
"
```

**Expected output** — 13 EVENT_JSON logs, all
`sa-automation`; crucially, **no `nep245 / mt_mint`** because the
deposit never fired:

```
sa-automation / session_fired
sa-automation / step_registered
sa-automation / step_registered
sa-automation / trigger_fired
sa-automation / sequence_started
sa-automation / step_resumed
sa-automation / pre_gate_checked  step=read-wnear-balance  outcome=in_range  matched=True
sa-automation / result_saved
sa-automation / step_resolved_ok
sa-automation / step_resumed
sa-automation / pre_gate_checked  step=deposit-into-intents  outcome=below_min  matched=False
sa-automation / run_finished
sa-automation / sequence_halted  reason=pre_gate_failed  error_kind=pre_gate_below_min
```

Pass-vs-halt asymmetry across recipes 3a and 3b:

- Same session key, same step shape, different trigger.
- Pass fire (3a) shows `pre_gate_checked { outcome: in_range }` on
  step 2 followed by `nep245 / mt_mint` — gate passed, deposit
  dispatched, venue ledger updated.
- Halt fire (3b) shows `pre_gate_checked { outcome: below_min }`
  on step 2 followed by `sequence_halted { reason: pre_gate_failed }`
  and **no `mt_mint`** — gate refused, target `ft_transfer_call`
  never fired, ledger unchanged.

The absence of `mt_mint` in the halt is proof by silence: if the
gate had leaked a zero-quote deposit through, the venue would
have logged it.

### 3c. `intents.near`'s NEP-245 ledger actually grew

Call `mt_balance_of` at two blocks — the enroll tx's block (before
the pass fire) and the halt tx's block (after the pass fire, before
revoke). The difference is the deposit.

```bash
# Balance BEFORE the pass fire (at enroll-tx block):
curl -s -X POST https://archival-rpc.mainnet.fastnear.com \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{
    "request_type":"call_function",
    "block_id":"9VUDKP6vH3abxCEU99UD1VMQMwg3dDcMLJMHMdgMg2SE",
    "account_id":"intents.near",
    "method_name":"mt_balance_of",
    "args_base64":"eyJhY2NvdW50X2lkIjoibWlrZS5uZWFyIiwidG9rZW5faWQiOiJuZXAxNDE6d3JhcC5uZWFyIn0="
  }}' | jq -r '.result.result | map(.) | implode'

# Balance AFTER the pass fire (at halt-tx block):
curl -s -X POST https://archival-rpc.mainnet.fastnear.com \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{
    "request_type":"call_function",
    "block_id":"6nCyyuMA3j9op6vaCJH1gS6yhi3F5HoL8R1oadGhNYMX",
    "account_id":"intents.near",
    "method_name":"mt_balance_of",
    "args_base64":"eyJhY2NvdW50X2lkIjoibWlrZS5uZWFyIiwidG9rZW5faWQiOiJuZXAxNDE6d3JhcC5uZWFyIn0="
  }}' | jq -r '.result.result | map(.) | implode'
```

**Expected outputs:**

```
"80000000000000000000000"         # before (0.08 wNEAR)
"525078236626887452318451"        # after  (~0.525 wNEAR)
```

**Delta:** `525078236626887452318451 − 80000000000000000000000
= 445078236626887452318451` yocto wNEAR, exactly the
`balances.intents_delta` field in the artifact.

The deposit was gated by a live Ref Finance quote at the pass
fire's block; the halt fire at a higher threshold never touched
the ledger. Both facts are in the same artifact, both checkable
above.

The base64 args decode to
`{"account_id":"mike.near","token_id":"nep141:wrap.near"}`, the
NEP-245 single-asset balance query against `intents.near`'s
`mt_balance_of`.

## What each reference artifact proves

Skim surface: each row pins the smallest provable claim and the
event that carries it. Details follow as prose subsections.

| Flagship | Primitive(s) proved | Load-bearing event(s) | Proof of absence | Reference artifact |
|---|---|---|---|---|
| **T1 limit-order** | `PreGate` | `pre_gate_checked { outcome: "in_range", matched: true }` | — (happy-path only) | [`mike-near-v4.0.2-limit-order.json`](./collab/artifacts/reference/mike-near-v4.0.2-limit-order.json) |
| **T2 ladder-swap** | `save_result` + `args_template` | `result_saved { as_name: "counter", kind: "u128_json", bytes_len: 2 }` | — | [`mike-near-v4.0.2-ladder-swap.json`](./collab/artifacts/reference/mike-near-v4.0.2-ladder-swap.json) |
| **T3 session-dapp** | session keys | `session_enrolled` → 3× `session_fired` → `session_revoked { reason: "explicit" }` | post-revoke fire attempt `InvalidAccessKeyError` (NEAR runtime rejects — key atomically deleted with state) | [`mike-near-v4.0.2-session-dapp.json`](./collab/artifacts/reference/mike-near-v4.0.2-session-dapp.json) |
| **Real-dapp `intents-deposit-limit`** | 4× (`PreGate × 2` + threading + session key) | pass: `pre_gate_checked × 2 { in_range }` + `result_saved` + `nep245 / mt_mint` | halt: no `mt_mint` emitted by `intents.near`; `sequence_halted { reason: "pre_gate_failed", error_kind: "pre_gate_below_min" }` | [`mike-near-v4.0.2-intents-deposit-limit.json`](./collab/artifacts/reference/mike-near-v4.0.2-intents-deposit-limit.json) |

Every cell in the "Load-bearing event(s)" and "Proof of absence"
columns resolves to a specific log line in the relevant tx's
receipt tree — anyone can re-fetch via archival RPC (Recipes 2
and 3 above) and diff against `structured_events` in the
artifact.

### T1 — PreGate (pre-dispatch conditional gate)

`mike-near-v4.0.2-limit-order.json` carries one `pre_gate_checked`
event with `outcome: "in_range"`, `matched: true`, `comparison:
"u128_json"`, and the gate's actual return bytes
(`actual_return: "MjI="` = base64("22")) within the bounds
`[−∞, 1000]`. That gate **fired before** the target `do_honest_work`
call; the subsequent `step_resolved_ok` proves the target executed
only because the gate passed. Under `PreGate`, a `Direct` target
that panicked or was decoy-valued would still halt cleanly via the
gate branch — this run proves the happy path.

### T2 — value threading (`save_result` + `args_template`)

`mike-near-v4.0.2-ladder-swap.json` shows a 3-step plan where:

- Step 1 fires `probe-v4.mike.near.do_honest_work` (increments a
  counter as a side effect).
- Step 2 fires `probe-v4.mike.near.get_calls_completed` and the
  kernel emits `result_saved { as_name: "counter", kind:
  "u128_json", bytes_len: 2 }`. Those saved bytes are `"23"` at
  the time of capture.
- Step 3 fires `do_honest_work` with `label` derived via
  `args_template` + `SubstitutionOp::PercentU128 { bps: 5000 }`
  from the saved `counter`. Post-run: `last_burst: "12"`
  (5000 bps of 24 = 12 — 24 because step 1 already incremented
  the counter from 22→23, then step 2 read it as 23, then step 3
  fired again making it 24 at read-time of last_burst; this is
  the expected ladder effect).

The `result_saved` event is the key payload for verification:
anyone replaying this tx via archival RPC will see it in the
receipt tree's logs. No other NEAR contract emits this event.

### T3 — session keys (annotated FCAK lifecycle)

`mike-near-v4.0.2-session-dapp.json` carries five tx hashes that
chain the full lifecycle:

1. **enroll** (`8xfeHb…`) — owner signs with 1 yoctoNEAR attached;
   contract mints a function-call access key on itself restricted
   to `execute_trigger` and records `SessionGrant` state. Emits
   `session_enrolled`.
2. **fires** (`C1tise…`, `8TRodh…`, `ACtiPB…`) — ephemeral session
   key signs three `execute_trigger` txs. Each emits
   `session_fired { fire_count_after: N, max_fire_count: 3 }`. The
   signer of these three txs is `mike.near` itself (the smart
   account), not the owner — confirmed in the `transaction.signer_id`
   field returned by `tx`.
3. **revoke** (`qtMAms…`) — owner deletes the grant state and
   emits `session_revoked { reason: "explicit" }`. The kernel also
   fires a `Promise::delete_key` action in the same receipt; the
   post-revoke fire attempt captured in the artifact's
   `tx_hashes.post_revoke_attempt` was rejected by the NEAR
   runtime itself with `InvalidAccessKeyError` — that's NEAR
   enforcing that the key was atomically removed alongside the
   state.

### Real-dapp — `intents-deposit-limit` (4-primitive composition)

`mike-near-v4.0.2-intents-deposit-limit.json` is the first flagship
that composes FOUR primitives in one real-dapp narrative on
mainnet `intents.near`:

- **PreGate × 2** per fire — step 1 gates on `wrap.near.ft_balance_of`
  (floor guard) and step 2 gates on
  `v2.ref-finance.near.get_return(pool_id=3879, wrap.near → usdt.tether-token.near)`
  (the limit-order price check).
- **`save_result` + `args_template`** — step 1's `ft_balance_of`
  return is saved as `wnear_balance`; step 2's `ft_transfer_call`
  `amount` field is materialized from it via
  `PercentU128 { bps: 100 }` (1% of balance).
- **Session key** — owner signs one `enroll_session` tx (1 yocto
  attached); the ephemeral key fires two different triggers from the
  same session grant (allowlist covers both pass and halt templates).

The artifact carries **two fires** side by side:

- **Pass fire** (`65K4kD…` @ block `8WWSCD…`) — Ref quote `1401639`
  (USDT units, 6-dec) ≥ the 500000 min-bytes bound, gate passes,
  target fires, `0.445 wNEAR` lands in `intents.near`'s mt ledger
  credited to `mike.near`. Events end with `sequence_completed` +
  `run_finished { status: "Succeeded" }`.
- **Halt fire** (`EEC83U…` @ block `6nCyyu…`) — same session key,
  same kernel, different trigger. Step 2's `pre_gate_checked` emits
  `outcome: "below_min", matched: false` because `1401639 <
  5000000000` (an intentionally-impossible $5000/NEAR threshold).
  Target never fires; no deposit; sequence halts cleanly with
  `sequence_halted { reason: "pre_gate_failed", error_kind:
  "pre_gate_below_min" }`.

Both branches of the gate are proved in one session. The
`balances.intents_delta` field in the artifact shows the
`+445078236626887452318451` yocto wNEAR delta in `intents.near`'s
mt ledger — an `mt_mint` event in the pass fire's receipt tree
confirms it on-chain, also reachable via
`intents.near.mt_balance_of({account_id: "mike.near", token_id:
"nep141:wrap.near"})`.

## General verification patterns

### List all events in a tx

```bash
curl -s -X POST https://archival-rpc.mainnet.fastnear.com \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tx","params":["<tx_hash>","<signer_id>"]}' \
  | jq -r '.result.receipts_outcome[].outcome.logs[] | select(startswith("EVENT_JSON:"))'
```

### Read any view method at a historical block

```bash
curl -s -X POST https://archival-rpc.mainnet.fastnear.com \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{
    "request_type":"call_function",
    "block_id":"<block_hash>",
    "account_id":"mike.near",
    "method_name":"<view_method>",
    "args_base64":"<base64 of JSON args>"
  }}' | jq -r '.result.result | map(.) | implode'
```

Useful view methods:

- `contract_version` (args: `{}`)
- `automation_runs_count` (args: `{}`)
- `list_automation_runs` (args: `{"from_index":0,"limit":10}`)
- `get_session` (args: `{"session_public_key":"ed25519:..."}`)
- `list_all_sessions` (args: `{}`)

### Read the chain of txs in the session-dapp lifecycle

Run verification recipe 2 against each of the five tx hashes in
the T3 row above — `enroll`, three `fires`, `revoke`. The event
names in order across the five should be:

```
[session_enrolled, trigger_created_*]  (enroll)
[session_fired, step_registered, trigger_fired, sequence_started, step_resumed, step_resolved_ok, sequence_completed, run_finished]  (fire #1)
... same as fire #1 ...  (fire #2)
... same as fire #1 ...  (fire #3)
[session_revoked]  (revoke)
```

## Trust boundaries of this proof

What the proof establishes:

- Each artifact's `tx_hash` resolves to an on-chain tx with exactly
  the events recorded.
- Each artifact's `block_info.transaction_block_hash` pins the
  kernel state at execution time to `v4.0.2-ops`.
- The bridge from "our repo" to "mainnet" is a byte-for-byte hash
  match. Build `res/smart_account_local.wasm` locally under the
  pinned toolchain (`rust-toolchain.toml`: `nightly-2026-04-17`),
  compute its SHA-256, and compare against the deployed `code_hash`
  at the pass-fire block
  (`DytwYt4tMP849QjXAQZFeEMuvMYUVq1bvyhwk8JWQvy4`, hex:
  `c0df7f6c…0666f`). Recipe + host-build caveats:
  [`REPRODUCIBLE-BUILD.md`](./REPRODUCIBLE-BUILD.md).

What the proof does NOT establish:

- **Host-build bit-exactness.** The pinned toolchain reproduces
  the deployed hash on the author's host (macOS aarch64). Rust
  nightly builds can vary across host linkers / libcs. A future
  `Dockerfile.build` will freeze the full toolchain + OS for
  bit-exact reproducibility anywhere; tracked as a follow-up.
- It does not prove the owner (mike.near) cannot undo history.
  The owner can redeploy and wipe state; past txs remain in
  archival but the live contract surface can change. Verifiers
  should always record the (tx_hash, block_hash) pair at the time
  of verification to freeze the claim they're asserting. Run
  `./scripts/verify-mainnet-claims.sh` to automate this check
  against the committed reference artifact.

## Reproduce the reference runs yourself

All three flagships accept a `NETWORK=mainnet` prefix and
`--artifacts-file <path>`:

```bash
NETWORK=mainnet ./examples/limit-order.mjs \
  --signer <your-account> \
  --smart-account mike.near \
  --gate-contract probe-v4.mike.near \
  --target-contract probe-v4.mike.near \
  --gate-max 1000 \
  --artifacts-file /tmp/your-limit-order-run.json
```

Your own run will emit the same event shapes against `mike.near`
(the kernel is public; anyone can call `execute_steps` under their
own `manual:<signer>` namespace). Compare your artifact's events
to the reference's — they'll differ in timestamps and gas
amounts, but the event names + payload shapes will match exactly.

---

**Falsifiability.** If any verification path above disagrees with
the committed artifact — wrong event, missing `pre_gate_checked`,
mismatched balance delta, kernel version off — the bug is in this
repo, not on-chain. Please open an issue with the RPC output you
saw so we can fix or retract the claim.
