# 60-second verify — `intents-deposit-limit` on mainnet

**Headline claim.** A 4-primitive smart-account flagship
(`PreGate × 2` + value-threading + session key) ran on NEAR
mainnet, deposited **~0.445 wNEAR** into `intents.near`'s NEP-245
ledger for `mike.near`, via an ephemeral session key gated by a
live Ref Finance price quote. Both branches of the gate — deposit
*and* refuse — proved in one session.

Four curls against public archival RPC
([`https://archival-rpc.mainnet.fastnear.com`](https://docs.fastnear.com/rpc),
free, no auth required) confirm the claim end-to-end: event list
on the pass fire, event list on the halt fire, balance diff in
`intents.near`'s NEP-245 ledger, and the `code_hash` of the
WASM that produced it.

Full reference artifact:
[`collab/artifacts/reference/mike-near-v4.0.2-intents-deposit-limit.json`](./collab/artifacts/reference/mike-near-v4.0.2-intents-deposit-limit.json).
Deep verification dive: [`MAINNET-PROOF.md`](./MAINNET-PROOF.md).

## 1. Pass fire: kernel sequence + venue-side `mt_mint`  (~30 s)

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

**Expected** — 15 EVENT_JSON logs, ending with:

```
…
sa-automation / pre_gate_checked   ← step 2 gate passed (Ref quote ≥ threshold)
nep245 / mt_mint                   ← intents.near credited the deposit
sa-automation / step_resolved_ok
sa-automation / sequence_completed
sa-automation / run_finished
```

Two independent log sources confirm the deposit: our kernel's
`step_resolved_ok` + `sequence_completed`, and `intents.near`'s
own `nep245 / mt_mint` event.

## 2. Halt fire: gate refused, no `mt_mint`  (~30 s)

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
            if e['event'] == 'pre_gate_checked' and e['data']['step_id'] == 'deposit-into-intents':
                print(std, '/', e['event'], e['data']['outcome'], e['data']['matched'])
            elif e['event'] == 'sequence_halted':
                print(std, '/', e['event'], e['data']['reason'], e['data']['error_kind'])
"
```

**Expected** — exactly these two lines, in order:

```
sa-automation / pre_gate_checked below_min False
sa-automation / sequence_halted pre_gate_failed pre_gate_below_min
```

Same session key as (1), same step shape, different trigger →
one committed, one refused. `ft_transfer_call` never fired on
the halt branch, so `intents.near` never emitted `mt_mint`.

## 3. The money actually moved  (~60 s)

`mt_balance_of` at two blocks — the enroll tx's block (before pass)
and the halt tx's block (after pass):

```bash
# BEFORE the pass fire (enroll-tx block):
curl -s -X POST https://archival-rpc.mainnet.fastnear.com \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{
    "request_type":"call_function",
    "block_id":"9VUDKP6vH3abxCEU99UD1VMQMwg3dDcMLJMHMdgMg2SE",
    "account_id":"intents.near",
    "method_name":"mt_balance_of",
    "args_base64":"eyJhY2NvdW50X2lkIjoibWlrZS5uZWFyIiwidG9rZW5faWQiOiJuZXAxNDE6d3JhcC5uZWFyIn0="
  }}' | jq -r '.result.result | map(.) | implode'

# AFTER the pass fire (halt-tx block):
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

**Expected** — two U128 strings:

```
"80000000000000000000000"    # before
"525078236626887452318451"   # after
```

**Diff:** `525078236626887452318451 − 80000000000000000000000
= 445078236626887452318451` yocto wNEAR — byte-exact match to
`balances.intents_delta` in the artifact.

## 4. The kernel was actually v4.0.2-ops  (~10 s)

One more curl pins the WASM bytes the validator ran at the pass
fire's block:

```bash
curl -s -X POST https://archival-rpc.mainnet.fastnear.com \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{
    "request_type":"view_account",
    "block_id":"8WWSCDqcBWusDP8SsTLLye5w42zjAm5ZuC85p5oMEY8F",
    "account_id":"mike.near"
  }}' | jq '.result.code_hash'
```

**Expected:**

```
"DytwYt4tMP849QjXAQZFeEMuvMYUVq1bvyhwk8JWQvy4"
```

This is the base58 SHA-256 of the deployed WASM — independent of
the contract's self-reported `contract_version` string.

---

All four agree → the run is real.

Any disagreement → bug in this repo, not on-chain. Open an
issue with the RPC output you saw.

## Scripted version

Run all four paths as one command:

```bash
./scripts/verify-mainnet-claims.sh
```

Exits 0 iff all four agree with the committed artifact;
non-zero with a specific "saw X, expected Y" diagnostic
otherwise. The script uses only `python3` stdlib + a public
HTTPS endpoint — no repo dependencies beyond the artifact.

## Other reference flagships

The other three reference artifacts (`limit-order`,
`ladder-swap`, `session-dapp`) have their own per-artifact
recipes in [`MAINNET-PROOF.md`](./MAINNET-PROOF.md).
