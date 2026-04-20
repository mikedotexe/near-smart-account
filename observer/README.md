# observer

Two views of `sa-automation` NEP-297 events emitted by a NEAR
smart-account deployment, both sourced from FastNEAR:

- **`stream`** — live tail of events as blocks finalize. Polls
  neardata, filters receipts by `executor_id`, emits one jsonl line
  per event on stdout. Good for "what's happening right now?".
- **`trace`** — deep-mechanics walkthrough of a single transaction.
  Pulls the full receipt DAG via the TX API, correlates NEP-519
  yield/resume hops, inlines events, prints an ASCII/ANSI table
  anchored to block heights and receipt IDs that stay verifiable
  forever via FastNEAR archival. Good for "walk me through the
  sequencer's machinery".

One binary, one file per mode. Pipe through `jq`, tee to a file,
or eyeball in a terminal — no persistence, no config, no daemon.

## Setup

```bash
# One-time: put your FastNEAR key in the repo-root .env
echo 'FASTNEAR_API_KEY=your-key-here' >> .env
```

The binary loads `.env` from the current working directory via
`dotenvy` (matches the JS side's pattern at
`scripts/lib/fastnear.mjs:27`). Without a key, FastNEAR still
serves requests but on the anonymous rate-limit ladder — fine for
short demos, not for long-lived observation.

## `trace` — walk through one transaction

```bash
# The canonical mainnet limit-order reference (1 step + PreGate):
cargo run -p smart-account-observer -- trace \
  --tx 9quv5g2S1c4ZeLJQrMZmSpuGwfYM4fX4Y61GfA7vf4Cr
```

Sample rendered output (truncated):

```
╭────────────────────────────────────────────────────────────────────────────╮
│ Sequence trace                                                             │
│                                                                            │
│   smart account   mike.near                                                │
│   signer          mike.near                                                │
│   transaction     9quv5g2S1c4ZeLJQrMZmSpuGwfYM4fX4Y61GfA7vf4Cr              │
│   top-level call  execute_steps                                            │
│   block span      194,707,945 → 194,707,951  (7 blocks, Δ 3.56s)           │
│   outcome         sequence_completed  (final step limit-order-…)           │
╰────────────────────────────────────────────────────────────────────────────╯

Receipts in execution order:

 ● 194,707,945  + 0.00s  G2qtaZCf…  mike.near → mike.near    5.12 TGas
     fn:      execute_steps
       └ step_registered  step=limit-order-…  policy=direct  target=probe-v4.mike.near
       └ sequence_started ns=manual:mike.near
 ● 194,707,946  + 0.65s  2mrPD2Kh…  mike.near → mike.near    3.25 TGas
     fn(cb): on_step_resumed  ← yield-resumed by data AMFVZe4X… (null)
       └ step_resumed  step=limit-order-…
 · 194,707,946  + 0.65s  4A5R6M7S…  mike.near → mike.near
     Data (yield-resume)  data_id=AMFVZe4X…  body="null"
 ○ 194,707,947  + 1.20s  98rEAaqF…  mike.near → probe-v4.mike.near  1.11 TGas
     fn:      get_calls_completed
 ● 194,707,948  + 1.71s  E4BPmw2p…  mike.near → mike.near    3.27 TGas
     fn(cb): on_pre_gate_checked  ← fed by data 3Fb3MeHo… (22)
       └ pre_gate_checked  outcome=in_range  matched=true  cmp=u128_json
 ...
 … 5 refund receipts collapsed (1.12 TGas total)

──────────────────────────────────────────────────────────────────────────────

NEP-519 yield/resume:
   execute_steps ran register_step, which yielded and returned a DataReceipt
   placeholder. 0.65s later, that placeholder was resolved, firing the
   on_step_resumed callback. This is the core mechanic that lets step N+1
   wait for step N's resolution.

──────────────────────────────────────────────────────────────────────────────

Gas total     18.52 TGas  (tokens burnt: 1.73 mN)
Events        6 events across 4 receipts
              pre_gate_checked, sequence_completed, sequence_started,
              step_registered, step_resolved_ok, step_resumed
Receipts      11 action + 3 data receipts  (5 refund receipts collapsed)
```

Read the table as a timeline:

- `●` action receipt that emitted events (events inlined as `└` bullets).
- `○` action receipt with no events (view calls, plain targets).
- `·` DataReceipt (cross-shard promise result or yield-resume trigger).
- `←` arrow marks a callback: which data receipt fed this
  on_* handler, with the decoded body where possible.
- The NEP-519 callout points directly at the yield/resume hop and
  measures its latency. This is the core mechanic the sequencer
  is built around — everything else is composition on top.

### Flags

```
--tx <hash>            Transaction hash (required).
--network mainnet      mainnet | testnet. Default: mainnet.
--no-color             Disable ANSI colors (auto-detected for non-TTY).
--simple               "Prove the claim" view: numbered state-changing events +
                       near.rocks explorer links anyone can click to verify.
--json                 Emit a machine-readable JSON summary instead.
--show-refunds         Show gas-refund receipts individually (default: collapsed).
--verbose              Include event `runtime` blocks (noisy but complete).
```

### `--simple` — prove the claim in one screen

```bash
cargo run -p smart-account-observer -- trace \
  --tx 9quv5g2S1c4ZeLJQrMZmSpuGwfYM4fX4Y61GfA7vf4Cr --simple
```

```
execute_steps • mike.near • ✓ completed in 3.56s

  ① tx submitted                         block 194,707,945   + 0.00s  ✓ execute_steps (1 step)
  ② gate check step limit-order-202604…  block 194,707,948   + 1.71s  ✓ in_range (value=22)
  ③ step limit-order-202604… resolved    block 194,707,950   + 2.94s  ✓ do_honest_work → 28 bytes
  ④ sequence completed                   block 194,707,950   + 2.94s  ✓ final step limit-order-202604…

Verify on-chain:
  tx     https://near.rocks/tx/9quv5g2S1c4ZeLJQrMZmSpuGwfYM4fX4Y61GfA7vf4Cr
  start  https://near.rocks/block/194707945
  end    https://near.rocks/block/194707951
```

Numbered markers + monotonically increasing block heights prove on-chain
order at a glance. The `near.rocks` links turn "trust me" into "click
this" — a skeptical reader can verify every claim independently against
FastNEAR archival, which retains mainnet blocks indefinitely.

### `--json` mode

Structured output suitable for `jq` / downstream analysis:

```bash
cargo run -p smart-account-observer -- trace --tx 9quv5g2S… --json \
  | jq '{tx: .tx_hash, duration: .block_span.duration_s, yield: .summary.yield_resume_detected, events: .summary.event_counts}'
# => { "tx": "9quv5g2S…", "duration": 3.5565, "yield": true,
#      "events": { "pre_gate_checked": 1, "sequence_completed": 1, ... } }
```

Top-level keys: `tx_hash`, `signer_id`, `receiver_id`, `top_method`,
`tx_block_height`, `tx_block_timestamp_ns`, `block_span`, `summary`,
`events`, `receipts`.

### Known reference txs

Rendered walkthroughs work against any `sa-automation` tx, but the
four validated reference runs on `mike.near` are the canonical
demos:

| Flagship                | tx                                              | Primitive highlighted        |
|-------------------------|-------------------------------------------------|------------------------------|
| limit-order             | `9quv5g2S1c4ZeLJQrMZmSpuGwfYM4fX4Y61GfA7vf4Cr`   | `PreGate`                    |
| ladder-swap             | `9BQbtMwEgA6TvEaeCANbk8PoRjShUSEzhKdFLtXks2nL`   | value threading              |
| session-dapp (enroll)   | `8xfeHbuSHRoX1sbG6VSTgBNMHG9ssRKhwHd9Ur5jLYDY`   | session-key enrollment       |
| session-dapp (fire)     | `C1tise22QTZ9n78u1ABXyfC3Safw4zaWmhd22wKXFgkU`   | session-key fire             |

Full per-run artifacts with decoded arguments and top-level
trace_classification are in
`../collab/artifacts/reference/`.

## `stream` — live tail

```bash
# Tail mainnet mike.near for sa-automation events:
cargo run -p smart-account-observer -- stream --account mike.near

# Multiple accounts (e.g. v5 split: authorizer + extension sequencer):
cargo run -p smart-account-observer -- stream \
  --account mike.near \
  --account sequential-intents.x.mike.near

# Testnet, starting from a specific block:
cargo run -p smart-account-observer -- stream \
  --network testnet \
  --account sa-v4.mike.testnet \
  --from-height 194_700_000

# Bounded range (useful for re-running against a past tx):
cargo run -p smart-account-observer -- stream \
  --account mike.near \
  --from-height 194_707_940 \
  --to-height 194_707_960
```

Structured logs go to stderr; jsonl events go to stdout.

```bash
cargo run -p smart-account-observer -- stream --account mike.near \
  >events.jsonl 2>observer.log
```

### Example jsonl

```json
{"block_height":194707948,"block_timestamp_ms":1776618310403,
 "tx_hash":"9quv5g2S1c4ZeLJQrMZmSpuGwfYM4fX4Y61GfA7vf4Cr",
 "receipt_id":"G2qtaZCfn62hpLmhpNbRHJEdG5PYLuzBb2FGVbbeyhkQ",
 "executor_id":"mike.near",
 "event":{"standard":"sa-automation","version":"1.1.0",
          "event":"pre_gate_checked",
          "data":{"step_id":"limit-order-20260419T17050",
                  "outcome":"in_range","matched":true,
                  "runtime":{"block_height":194707948,"...":"..."}}}}
```

### Filtering downstream

```bash
# Only halts:
… | jq 'select(.event.event == "sequence_halted")'

# Only gate-checks for a specific step:
… | jq 'select(.event.event == "pre_gate_checked" and .event.data.step_id == "s1")'

# One tx's worth of events:
… | jq 'select(.tx_hash == "9quv5g2…")'

# Count events per type over a window:
… | jq -r '.event.event' | sort | uniq -c
```

## How it works

### `stream`

1. Connects to FastNEAR's neardata service
   (`mainnet.neardata.xyz` / `testnet.neardata.xyz`).
2. Spawns the official `fastnear-neardata-fetcher` worker with the
   configured `start_block_height` (defaults to ~10 blocks back from
   finalized tip).
3. The fetcher streams `BlockWithTxHashes` over an `mpsc::channel`.
   Each block carries every shard's receipt outcomes; neardata
   enriches each receipt with the originating `tx_hash` so events
   can be back-linked to the user-signed transaction without a
   second RPC lookup.
4. For each receipt, if `execution_outcome.outcome.executor_id`
   matches one of the `--account` values, we walk `outcome.logs[]`
   and parse each line starting with `EVENT_JSON:`.
5. Matching events are emitted as jsonl to stdout (one line each),
   wrapped with `block_height`, `block_timestamp_ms`, `tx_hash`,
   `receipt_id`, and `executor_id`.

### `trace`

1. One POST to FastNEAR's TX API
   (`https://tx.main.fastnear.com/v0/transactions` with
   `{tx_hashes: [hash]}`). The response contains the user's signed
   transaction plus **every** action and data receipt spawned by
   it, with block heights, timestamps, logs, gas burnt, and
   outcome status — no follow-up RPC calls needed.
2. Normalize into an execution-ordered row list sorted by
   `(block_height, block_timestamp_ns, receipt_id)`.
3. Correlate `on_*` callback receipts with the data receipts that
   triggered them. `on_step_resumed` + `is_promise_resume=true` is
   the NEP-519 yield/resume signature; the other `on_*` callbacks
   consume ordinary promise results.
4. Extract NEP-297 `EVENT_JSON:` envelopes from each action
   receipt's logs; render them inline under their emitting row.
5. Render an ASCII/ANSI table — header banner with tx metadata,
   one row per receipt (action + data, interleaved in time),
   an NEP-519 callout when yield/resume is detected, and a summary
   footer with gas totals and event counts.
6. `--json` bypasses rendering and emits the same structured model
   as JSON for downstream tooling.

## Relationship to other tooling

- `scripts/aggregate-runs.mjs` — retroactive: walks account
  activity history via the TX API, summarizes each detected
  automation run. Same events, different surface, one-shot.
- `scripts/investigate-tx.mjs` — JSON-first three-surfaces
  investigation wrapper. Richer than trace for one-off
  investigations; trace is more compact for pedagogy.
- `examples/*.mjs` — artifact writers: each flagship captures the
  events of its own run and writes them to
  `collab/artifacts/`. Narrow and client-authored.
- `observer/ stream` — live: streams events as blocks confirm.
  Wide (any account you allowlist) and observer-authored.
- `observer/ trace` — one tx → one walkthrough. Archival-backed,
  anchored to block heights and receipt IDs that stay verifiable
  forever.

## Scope deliberately left out

- **No watermark persistence** in `stream`. Re-pass `--from-height`
  on restart if you care about gapless coverage.
- **No SQLite / indexing.** Use `tee` + `jq` or point stdout at a
  pipeline you already trust.
- **No receipt-DAG tree rendering** in `trace`. The block-time
  execution order is already extremely revealing; causality can be
  followed via `outcome.receipt_ids[]` pointers in the TX API
  response.
- **No cross-tx chains** in `trace`. Multi-tx flagships (session-
  dapp, intents-deposit-limit) need multiple invocations.
- **No RPC fallback** for very old txs. If the TX API 404s, an
  archival RPC query against `archival-rpc.mainnet.fastnear.com`
  is a future enhancement.
- **No gas-price annotations.** Tokens-burnt is the NEAR-denominated
  fee; converting to $ requires a price oracle outside the tool's
  scope.
- **No daemon mode.** Run it under `tmux`, `systemd`, whatever.
  The binary exits cleanly on SIGINT (stream) and on render
  completion (trace).
