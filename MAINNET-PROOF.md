# Mainnet proof — v4.0.2-ops on `mike.near`

Three reference artifacts capture fresh live runs of each new v4
primitive against the **currently-deployed** kernel on `mike.near`.
Every tx hash and block hash below resolves on any public NEAR
archival RPC — no coordination with the repo maintainer required.

| Primitive | Reference artifact | Tx hash | Block hash |
|---|---|---|---|
| **T1 PreGate** | [`collab/artifacts/reference/mike-near-v4.0.2-limit-order.json`](./collab/artifacts/reference/mike-near-v4.0.2-limit-order.json) | `9quv5g2S1c4ZeLJQrMZmSpuGwfYM4fX4Y61GfA7vf4Cr` | `hdRtm4YTx3a5UXDNYj96hw4aGBk1HCWvqWB64DnYHcA` |
| **T2 value threading** | [`mike-near-v4.0.2-ladder-swap.json`](./collab/artifacts/reference/mike-near-v4.0.2-ladder-swap.json) | `9BQbtMwEgA6TvEaeCANbk8PoRjShUSEzhKdFLtXks2nL` | `3b3KyHu1UozT5Yax5gWhapZ58aW4xDtJUUbpNPqQptzm` |
| **T3 session keys** (enroll) | [`mike-near-v4.0.2-session-dapp.json`](./collab/artifacts/reference/mike-near-v4.0.2-session-dapp.json) | `8xfeHbuSHRoX1sbG6VSTgBNMHG9ssRKhwHd9Ur5jLYDY` | `94m7qCxDTEEUkySxs1BR4DFeyZDPALaRzVzbXfzZHvis` |
| T3 session keys (fire #1) | ↑ same | `C1tise22QTZ9n78u1ABXyfC3Safw4zaWmhd22wKXFgkU` | (in artifact) |
| T3 session keys (fire #2) | ↑ same | `8TRodh9z7kMYRHjBGsUuxzg7VKBA33SAkFAZ3US8vRzq` | (in artifact) |
| T3 session keys (fire #3) | ↑ same | `ACtiPBXRRuZL5C1Vt6SRb7KzUJxt4cBaRiuGA5okJdLs` | (in artifact) |
| T3 session keys (revoke) | ↑ same | `qtMAmsLzdaVPwyRNCWWR9MYZxbLzEZAbwMor7G6tVtw` | `DipZxEhqPPZMkv67qQ55FWhpxwU9JnWm1ytqKvidHFHA` |

**Archival endpoint used for every verification below:**
`https://rpc.mainnet.fastnear.com` (public, free, archival).

> Note: Pagoda's archival endpoint
> (`https://archival-rpc.mainnet.near.org`) is being deprecated as of
> 2026-04-19 and returns a warning. Use FastNEAR.

## Verification recipe 1 — confirm the kernel version at the tx's block

This proves the contract code that emitted the artifact's events
was `v4.0.2-ops` at the exact block the tx landed in.

```bash
curl -s -X POST https://rpc.mainnet.fastnear.com \
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

Swap the `block_id` for any tx's `block_info.transaction_block_hash`
from the artifact — every one of them resolves to the same kernel
version. (`args_base64: "e30="` is just base64 of `{}`.)

## Verification recipe 2 — confirm events match the artifact

This proves the events the artifact claims were emitted actually
landed on-chain.

```bash
curl -s -X POST https://rpc.mainnet.fastnear.com \
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

## What each reference artifact proves

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

## General verification patterns

### List all events in a tx

```bash
curl -s -X POST https://rpc.mainnet.fastnear.com \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tx","params":["<tx_hash>","<signer_id>"]}' \
  | jq -r '.result.receipts_outcome[].outcome.logs[] | select(startswith("EVENT_JSON:"))'
```

### Read any view method at a historical block

```bash
curl -s -X POST https://rpc.mainnet.fastnear.com \
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
- The bridge from "our repo" to "mainnet" is provable: build
  `res/smart_account_local.wasm` locally, compute its sha256, and
  compare against what the deployed contract carries — the deploy
  tx in `MAINNET-MIKE-NEAR-JOURNAL.md` (`7vpsQcvgGkFiRzZbGsngj8DXAFK5xi9dRQFzci1URqe1`
  for the initial v4.0.0-pregate, `DLxLRLBmE1oNgsT5h4wMP5bGCG1NYjbWL332Fho4r5JA`
  for the v4.0.2-ops migrate) captures the wasm bytes in its
  receipts.

What the proof does NOT establish:

- It does not prove the *source* code is what produced
  `smart_account_local.wasm`. That requires a reproducible build
  (pinned rustc, known flags) plus a hash match. We don't ship a
  reproducible build today — reviewers should treat the hash as
  an artifact fingerprint, not a source attestation.
- It does not prove the owner (mike.near) cannot undo history.
  The owner can redeploy and wipe state; past txs remain in
  archival but the live contract surface can change. Verifiers
  should always record the (tx_hash, block_hash) pair at the time
  of verification to freeze the claim they're asserting.

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
