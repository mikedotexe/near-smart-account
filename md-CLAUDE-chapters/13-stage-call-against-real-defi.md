# 13 · `stage_call` against a real DeFi contract (`wrap.testnet`)

**BLUF.** Chapters 02–10 validated the saga semantic against
`echo.x.mike.testnet`, a contract we wrote. This chapter is the first
probe against **real chain code we did not write** — `wrap.testnet`,
the canonical NEP-141 wNEAR contract. A three-action `stage_call` batch
(`storage_deposit` + two `near_deposit` calls) ran end to end, the
cascade drained cleanly via `on_stage_call_settled`'s Ok branch three
times, and `smart-account.x.mike.testnet` ended up with **exactly
0.03 wNEAR** as expected. The four open questions from the previous
discussion now all have concrete answers.

## 1. Reference run

| Artifact | Value | Block |
|---|---|---|
| Batch tx (3 × `stage_call` to `wrap.testnet`) | `mrD3k8EGbb3vKMvq3zmtaynKnPukqhAGVU8uTFYuUrv` | `246239306` |
| `run_sequence` (`order = [register, deposit_a, deposit_b]`) | `8gef1Kq29xJDKi3gonmxY9MEFP22mTWt3SR4To91GR4j` | `246239351` |
| Cascade settled by | — | `246239361` |
| `ft_balance_of(smart-account)` | `30000000000000000000000` (0.03 wNEAR) | verified post-cascade |
| Yield timeout would have fired at | ~ | `246239507` (307 + 200) |

Margin to timeout: **146 blocks ≈ 73 s** at the moment the cascade
finished.

The three `stage_call` actions:

| label | downstream | attached deposit | gas budget | purpose |
|---|---|---|---|---|
| `register` | `wrap.testnet.storage_deposit({})` | 1.25 mNEAR (1.25 × 10²¹ yocto) | 50 TGas | NEP-145 register `smart-account.x.mike.testnet` so subsequent FT ops are accepted |
| `deposit_a` | `wrap.testnet.near_deposit({})` | 0.01 NEAR (10²² yocto) | 30 TGas | mint 0.01 wNEAR to predecessor (smart-account) |
| `deposit_b` | `wrap.testnet.near_deposit({})` | 0.02 NEAR (2 × 10²² yocto) | 30 TGas | mint 0.02 wNEAR (cumulative 0.03) |

## 2. Four-questions scorecard

The headline result for this chapter: every open question from the
previous discussion now has a concrete answer.

| Open question | Answer from this run |
|---|---|
| **Q1.** Does our 30 TGas downstream budget suffice for a real DeFi method? | **Yes for these methods.** `near_deposit` ran at exactly 30 TGas with no "exceeded prepaid gas" errors. `storage_deposit` was bumped to 50 TGas pre-emptively and used it cleanly. Refund receipts indicate substantial unused gas in both cases — actual usage was well under budget. |
| **Q2.** Does the `promise_result_checked` byte count tell us anything useful? | **Sometimes useful.** `storage_deposit` returned **50 result bytes** (the JSON `{"total":"1250000000000000000000","available":"0"}` StorageBalance struct from NEP-145). `near_deposit` returned **0 result bytes** (NEP-141 declares it as void). So a non-zero byte count signals "the contract returned structured info we could deserialize if we cared." A zero byte count is still a successful settle, just no payload. |
| **Q3.** What happens with downstreams that return a `Promise`? | **Not exercised here.** Neither `storage_deposit` nor `near_deposit` returns a `Promise` — they both terminate at `SuccessValue` on `wrap.testnet`. Chapter 15 should target a method that does (e.g. `ft_transfer_call` to an FT-aware receiver). |
| **Q4.** How much does cross-shard receipt traffic stretch the cascade? | **Negligible at this scale.** The cascade ran at exactly **3 blocks per step** — identical to the echo case in chapters 05–09. Cross-shard data receipts (smart-account → wrap.testnet → smart-account) landed in the next-block slot just as same-shard receipts did. Total cascade duration: 10 blocks (351 → 361), ≈ 5 seconds. |

The takeaway: our pattern works against an arbitrary, well-behaved
NEP-141 contract with no modification needed. The defensive choices
(opaque-bytes return, `promise_result_checked` with bounded buffer,
`Err`-branch in `on_stage_call_settled`) all just work in this regime.

## 3. Surface 2 — state time-series

`scripts/state.mjs smart-account.x.mike.testnet --block <h> --method staged_calls_for --args '{"caller_id":"mike.testnet"}'`

| Block | `staged_calls_for` labels | What just happened |
|---|---|---|
| 246239306 | `[]` | batch tx included; receipt next block |
| 246239307 | `[register, deposit_a, deposit_b]` | batch receipt runs; three yielded callbacks allocated |
| 246239350 | `[register, deposit_a, deposit_b]` | idle wait (~43 blocks, ~22 s) |
| 246239351 | `[register, deposit_a, deposit_b]` | `run_sequence` tx included |
| 246239352 | `[register, deposit_a, deposit_b]` | `run_sequence` contract receipt; conduct_order = `[deposit_a, deposit_b]`; register resumed |
| 246239353 | `[register, deposit_a, deposit_b]` | register's `on_stage_call_resume`; downstream + settle dispatched |
| 246239354 | `[register, deposit_a, deposit_b]` | register's downstream `wrap.testnet.storage_deposit` runs — **success** |
| 246239355 | `[deposit_b, deposit_a]` | **register's settle Ok**: removes register, pops deposit_a. Swap-remove moved deposit_b into register's slot |
| 246239356 | `[deposit_b, deposit_a]` | deposit_a's resume |
| 246239357 | `[deposit_b, deposit_a]` | deposit_a's downstream `near_deposit` runs |
| 246239358 | `[deposit_b]` | **deposit_a's settle Ok**: removes deposit_a, pops deposit_b |
| 246239359 | `[deposit_b]` | deposit_b's resume |
| 246239360 | `[deposit_b]` | deposit_b's downstream `near_deposit` runs |
| 246239361 | `[]` | **deposit_b's settle Ok**: removes deposit_b; conduct_order empty |

Three identical 3-block-per-step cascades back to back — identical
shape to chapter 05's success cascade against echo.

## 4. Surface 3 — per-block receipts at the cascade ticks

`scripts/block-window.mjs --block <h> --with-receipts --with-transactions`

Showing one representative cascade step (register, blocks 353–355).
Subsequent labels follow the same pattern with different hashes.

### Register cascade (blocks 353–355)

| Block | Receipt | Pred → Receiver | Type | Note |
|---|---|---|---|---|
| 246239353 | `FSM7Mu…eYZV` | smart-account → smart-account | Data | resume payload for register |
| 246239353 | `C8RDmh…cBxa` | smart-account → smart-account | Action | `on_stage_call_resume(register)` |
| 246239354 | `6FQsD7…fqSd` | smart-account → **wrap.testnet** | Action | `storage_deposit({})` — **success** |
| 246239355 | `FV8fAe…FmPk` | **wrap.testnet** → smart-account | Data | downstream return value (50 bytes of StorageBalance JSON) |
| 246239355 | `46tPHp…fWbZ` | smart-account → smart-account | Action | `on_stage_call_settled(register)` Ok branch — drains entry, pops next |

Notice the cross-contract Data receipt (`wrap.testnet → smart-account`)
at block 355: this is wrap.testnet's response value being delivered
back to settle. Lands in the next-block slot, no extra latency.

### Deposit cascade (blocks 356–358 and 359–361)

Identical block-shape to register. The only changes are:

- downstream is `wrap.testnet.near_deposit({})` (returns void, so the
  Data receipt at the settle block carries 0 bytes)
- the settle log line says `completed successfully (0 result bytes)`
  rather than 50

## 5. Surface 1 — log lines from the batch tx tree

`scripts/trace-tx.mjs mrD3k8EGbb3vKMvq3zmtaynKnPukqhAGVU8uTFYuUrv mike.testnet --wait FINAL`

Direct quotes from the receipt tree, reading top-to-bottom in
execution order:

```
log: stage_call 'register' resumed in manual:mike.testnet -> wrap.testnet.storage_deposit memo=None
log: stage_call 'register' in manual:mike.testnet completed successfully (50 result bytes)

log: stage_call 'deposit_a' resumed in manual:mike.testnet -> wrap.testnet.near_deposit memo=None
log: Deposit 10000000000000000000000 NEAR to smart-account.x.mike.testnet
log: stage_call 'deposit_a' in manual:mike.testnet completed successfully (0 result bytes)

log: stage_call 'deposit_b' resumed in manual:mike.testnet -> wrap.testnet.near_deposit memo=None
log: Deposit 20000000000000000000000 NEAR to smart-account.x.mike.testnet
log: stage_call 'deposit_b' in manual:mike.testnet completed successfully (0 result bytes)
```

Two log sources in the same tree:

- the **smart-account** logs (resumed / completed successfully) are
  ours — they confirm the cascade walked the Ok branch three times
- the **wrap.testnet** `Deposit ... NEAR to ...` logs are emitted by
  the downstream NEP-141 contract; they are visible in the trace
  because all logs land in receipt outcomes regardless of which
  contract emitted them

For the first time, our trace surface includes log output from a
contract we didn't write. That's a useful observability boost for
real-world flows — the downstream tells us, in its own words, what it
did.

## 6. Verifying the end state

The point of the experiment was to leave smart-account holding wNEAR.
Confirmed:

```bash
$ ./scripts/state.mjs wrap.testnet \
    --method ft_balance_of \
    --args '{"account_id":"smart-account.x.mike.testnet"}'
"30000000000000000000000"
```

Exactly `0.03 wNEAR`. No drift, no shortfall — the cumulative attached
deposits across the two `near_deposit` calls minted 1:1.

This is the first time in this repo that the smart-account contract
holds something **other than NEAR** as a result of our orchestration.
A new state surface (the wNEAR FT ledger maintained by `wrap.testnet`)
now reflects work the smart account did.

## 7. Sidenote — contract has evolved

Comparing this run's trace log lines to chapter 09's, the
contract's callback-args shape has changed:

- chapters 05–09: callbacks took `caller` and `label`, log lines said
  `stage_call 'X' for mike.testnet ...`
- chapter 13: callbacks take `sequence_namespace` and `label`, log
  lines say `stage_call 'X' in manual:mike.testnet ...`

The runtime behaviour is unchanged — `staged_calls_for(caller_id=...)`
still works the same way — but the contract internally now generalises
the per-caller key to a per-namespace key, with `manual:<caller>` as
the implicit namespace for direct user calls. Codex must have refactored
to make room for non-`manual:` namespaces (declared sequences? planned
sequences? the plan-based API path?). Worth tracking down once we move
on from the wild-DeFi tranche.

## 8. Recipes

```bash
# multi-target stage_call batch using the new helper
./scripts/send-stage-call-multi.mjs \
  '{"label":"register","target":"wrap.testnet","method":"storage_deposit","args":{},"deposit_yocto":"1250000000000000000000","gas_tgas":50}' \
  '{"label":"deposit_a","target":"wrap.testnet","method":"near_deposit","args":{},"deposit_yocto":"10000000000000000000000","gas_tgas":30}' \
  '{"label":"deposit_b","target":"wrap.testnet","method":"near_deposit","args":{},"deposit_yocto":"20000000000000000000000","gas_tgas":30}' \
  --action-gas 250 &
sleep 8
./scripts/account-history.mjs mike.testnet --limit 1

# conduct in dependency order
near call smart-account.x.mike.testnet run_sequence \
  '{"caller_id":"mike.testnet","order":["register","deposit_a","deposit_b"]}' \
  --accountId mike.testnet

# verify the wNEAR balance
./scripts/state.mjs wrap.testnet \
  --method ft_balance_of \
  --args '{"account_id":"smart-account.x.mike.testnet"}'

# the cascade map (state drains in 3-block ticks per label)
for b in 246239307 246239355 246239358 246239361 246239374; do
  printf "block %s: " "$b"
  ./scripts/state.mjs smart-account.x.mike.testnet --block "$b" \
    --method staged_calls_for --args '{"caller_id":"mike.testnet"}'
done
```

## 9. What this chapter promotes / queues

Promotes (now empirically backed):

- the saga semantic works against arbitrary chain code, not just our
  echo contract
- byte-count of the result lets settle distinguish "structured response"
  vs "void"
- cross-shard latency at this scale is invisible to our cascade timing
- log output from downstream contracts is automatically visible in our
  trace surface

What followed in the wild tranche:

- **chapter 15**: a `Promise`-returning method (`ft_transfer_call`)
  against `wrap.testnet` *plus* the failure-mode taxonomy against the
  same target — originally queued as two separate chapters, consolidated
  when writing revealed they shared a single regime (`Direct` settle
  opacity)
- **chapter 16**: a live protocol-specific adapter path against
  `wrap.testnet`, validating `SettlePolicy::Adapter` end-to-end
- **chapter 17**: multi-contract intent — `stage_call` across Ref
  Finance and `wrap.testnet` (register + deposit + swap) in one
  orchestration

The new helper `scripts/send-stage-call-multi.mjs` unlocks any of these
follow-ups without further script work.
