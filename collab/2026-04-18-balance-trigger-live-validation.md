# 2026-04-18 · Balance-trigger live validation

This note captures the first live testnet validation of the simplified
balance-trigger automation path after removing runner rewards.

## Shared rig

- `smart-account.x.mike.testnet`
- `router.x.mike.testnet`
- `echo.x.mike.testnet`

Fresh deploy completed via:

```bash
MASTER=x.mike.testnet ./scripts/deploy-testnet.sh
```

Deploy txs:

- `smart-account.x.mike.testnet` create:
  `6HnTTo6zZU4WuRmbN6sWqWMsirYsTHzK9GutG1mWyGRi`
- `smart-account.x.mike.testnet` deploy/init:
  `8menWrpbqd5qGJP4Y9ojBQCDsaNLsBLGKch7YjNDY51z`
- `router.x.mike.testnet` deploy/init:
  `63AyDKGYWqbpREDoULVZghZkDY8ndnms3fvsXhgFKUKW`
- `echo.x.mike.testnet` deploy:
  `GDiXqtqjsLrKZW47LSqzUB3TA32d8yj85zWKNndibDcs`

## Gas calibration

The first attempt used `execute_trigger` at `200 TGas` and failed:

- `save_sequence_template`: `CwBQbKXU7PncD4j6Z31rvhHbxBUfT8czsXzbSdPDK76X`
  at block `246237235`
- `create_balance_trigger`: `AaXDReWBYzKNvCrB6jNypd2gZBFXZH4ybPy4NjwUBkU2`
  at block `246237241`
- `execute_trigger`: `ByLfa9S5TTrzNp4fz9fUpuQrjtA5g3kZypupesGzdJvv`
  at block `246237246`

Trace result:

- `execute_trigger` failed at `smart-account.x.mike.testnet` with
  `Exceeded the prepaid gas`

This gave a clean live calibration point: the simplified automation path needs
more than `200 TGas` for `execute_trigger` when staging and starting a
3-label router-backed sequence.

## Owner-funded success

Command:

```bash
node scripts/send-balance-trigger-router-demo.mjs \
  alpha:1 beta:2 gamma:3 \
  --owner-signer x.mike.testnet \
  --contract smart-account.x.mike.testnet \
  --router router.x.mike.testnet \
  --echo echo.x.mike.testnet \
  --execute-gas 500
```

Artifacts:

- `save_sequence_template`:
  `4xSDcvULr5kNyfLA4x56H6jmJZ6RKhsJcvNQCyB1Cj4S` at block `246237303`
- `create_balance_trigger`:
  `HZuMYmPZydUmhnvchDUkQ7dawzFCssDA1gfp4nUUM43b` at block `246237309`
- `execute_trigger`:
  `A9n6vFH5Z3p95PfSjw1f8CMpcGDhZ7pW974XUteMbYng` at block `246237313`
- sequence id: `router-seq-mo3ofylb`
- trigger id: `balance-trigger-mo3ofylb`
- namespace: `auto:balance-trigger-mo3ofylb:1`
- artifact JSON:
  `collab/artifacts/2026-04-18T01-47-20-159Z-router-seq-mo3ofylb-balance-trigger-mo3ofylb.json`

What the execute trace proved:

- executor: `x.mike.testnet`
- labels resumed in order: `alpha -> beta -> gamma`
- downstream router/echo values returned in order: `1 -> 2 -> 3`
- trigger state after completion:
  - `runs_started = 1`
  - `in_flight = false`
  - `last_executor_id = x.mike.testnet`
  - `last_run_outcome = Succeeded`

Useful block-by-block cascade for the owner run:

- `246237313`: top-level `execute_trigger` tx included
- `246237315`: yielded `on_stage_call_resume(alpha)` receipt lands
- `246237316`: `router.route_echo(n=1)`
- `246237317`: `echo(n=1)`
- `246237318`: `on_stage_call_settled(alpha)`
- `246237319`: yielded `on_stage_call_resume(beta)` receipt lands
- `246237320`: `router.route_echo(n=2)`
- `246237321`: `echo(n=2)`
- `246237322`: `on_stage_call_settled(beta)`
- `246237323`: yielded `on_stage_call_resume(gamma)` receipt lands
- `246237324`: `router.route_echo(n=3)`
- `246237325`: `echo(n=3)`
- `246237326`: `on_stage_call_settled(gamma)`

## Delegated executor success

First, owner authorized `mike.testnet`:

- `set_authorized_executor("mike.testnet")`:
  `EqedsEmruHr3cnTUFnnTHWdsPWYvS1YoEhmg9JEi19c9` at block `246237422`

Command:

```bash
node scripts/send-balance-trigger-router-demo.mjs \
  alpha:11 beta:22 gamma:33 \
  --owner-signer x.mike.testnet \
  --executor-signer mike.testnet \
  --contract smart-account.x.mike.testnet \
  --router router.x.mike.testnet \
  --echo echo.x.mike.testnet \
  --execute-gas 500
```

Artifacts:

- `save_sequence_template`:
  `KpBqZqmoxHjNgN4prcgUBSPb9ZjSqvk88j8DaxkJJKj` at block `246237436`
- `create_balance_trigger`:
  `5Da7Pg2pgKAG3XM4XCCrmirvjR69H7EjweCM8ivpRJZw` at block `246237442`
- `execute_trigger`:
  `BujCoxFWMLWuQicTXwEe5Fk9s1iKYT9d52rLGtX7jyWe` at block `246237446`
- sequence id: `router-seq-mo3ohnar`
- trigger id: `balance-trigger-mo3ohnar`
- namespace: `auto:balance-trigger-mo3ohnar:1`
- artifact JSON:
  `collab/artifacts/2026-04-18T01-48-38-835Z-router-seq-mo3ohnar-balance-trigger-mo3ohnar.json`

What the execute trace proved:

- executor: `mike.testnet`
- labels resumed in order: `alpha -> beta -> gamma`
- downstream router/echo values returned in order: `11 -> 22 -> 33`
- trigger state after completion:
  - `runs_started = 1`
  - `in_flight = false`
  - `last_executor_id = mike.testnet`
  - `last_run_outcome = Succeeded`

## Important current signal

The simplified automation path is now live-validated in two shapes:

1. owner-funded execution
2. delegated-executor-funded execution

In both cases, the smart account:

- checked durable trigger state
- materialized a fresh automation namespace
- resumed staged labels in strict order
- waited for each downstream router/echo call to settle before advancing

That is the strongest live evidence so far that the repo's "stateful
eligibility + authorized execution" framing is the right one.

## Tooling note

At the time of this run, `scripts/trace-tx.mjs` still classified these
successful `execute_trigger` transactions as `PENDING` because yielded callback
receipts remained tagged `pending_yield` even after their descendants had
completed.

That helper was tightened later, and the same successful automation traces now
classify as `FULL_SUCCESS`.
