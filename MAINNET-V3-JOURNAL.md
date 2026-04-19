# Mainnet journal — `sequential-intents.mike.near` (v3)

Chronological record of every on-chain transaction landed against the v3
smart-account at `sequential-intents.mike.near`. Tx hashes are the
load-bearing archival keys; block ranges narrow an archival-node query
window. All live-run JSON artifacts (plan + signed intents + balance
snapshots + per-step tx metadata) are at `collab/artifacts/`.

## Archival-node lookup

```bash
# FastNEAR archival
curl -s -X POST https://archival-rpc.mainnet.near.org \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":"1","method":"EXPERIMENTAL_tx_status",
       "params":["<tx_hash>","<sender_account>"]}' | jq .

# Repo tooling (recommended — handles retries + classification)
./scripts/trace-tx.mjs <tx_hash> <sender> --network mainnet --wait FINAL

# Web explorer
https://www.nearblocks.io/txns/<tx_hash>
```

## 2026-04-18 — Phases 2–4: subaccount creation + v3 deploy

| Phase | Action | Tx hash | Signer |
|---|---|---|---|
| 2 | Create subaccount (5 NEAR initial balance) | `91NHSRsvn8k6wM9NJBjKJLngkmJUyxqN9xenkhL1Drxg` | `mike.near` |
| 3 | Deploy WASM + `new_with_owner({"owner_id":"mike.near"})` | `51ZaKomLZhzdL3TDYYWeMyn2CDNQyTs6eXtZm75is2bS` | `sequential-intents.mike.near` |
| 4 | Register on `wrap.near` storage (0.00125 NEAR) | `Ax74PbpMR7gMWYS4N6hHjL5K2Dwnk86PzdoK3C3rrB2i` | `mike.near` |

## 2026-04-18 — Phases 5–6: initial flagship validation

| Mode | Tx hash | Block range | Outcome |
|---|---|---|---|
| `--deposit-only` (2 steps, no signed intent) | `3sfgmiY94t9VMzBL79Dxms3bbW4CAkTzdPT1xuyuFEoD` | ~194633900 | FULL_SUCCESS; `intents.near`(mike.near) +0.01 wNEAR |
| Round-trip (3 steps, NEP-413 signed `ft_withdraw`) | `7btFS8LzGQUpHari3EnzCEvyr3dU3r4egKCsnPVZMgmJ` | 194634029–194634046 | FULL_SUCCESS; `wrap.near`(mike.near) +0.01; intents Δ0 |

## 2026-04-18 — Battletest sweep (4 kernel edge cases)

| # | Test | Tx hash | Block range | Observation |
|---|---|---|---|---|
| B1 | Poison step 2 Asserted (mismatch, mid-sequence) | `7gzutLqAjWqWfqjdDccf4hERwBcjbk8QY6PiNYuzdwHv` | 194636932–194637133 | `step_resolved_err` (step 2) + `sequence_halted` via step 3 decay @ ~122s |
| B2 | Poison step 3 Asserted (mismatch, terminal) | `AG7MwxdDRMiZKtjg1hPJpLHt8ALXuyQ9cNLyqdQNzayC` | 194637767–194637781 | `step_resolved_err` only; NO `sequence_halted` (no dangling successor); ~10s |
| B3a | Clean round-trip (baseline re-run) | `FhP2UxuWuz2MuVy1rn27ctaW1GLi2n6ftD1o5B6AQP2c` | ~194637840 | FULL_SUCCESS |
| B3b | Clean round-trip (back-to-back, within seconds) | `7vpyLVKs1ttdLE3Dyb1MdBiboymnnJ3ovPxaAPpAYjm6` | ~194637900 | FULL_SUCCESS; nonce freshness + namespace reuse confirmed |
| B4a | DCA `save_sequence_template` (battletest) | `8KA1FwXnMEN9byaZcvqLMSxx2aq2vwGFYwFkkppSrieC` | 194637964 | template `dca-intents-mo5bmbsr` stored |
| B4b | DCA `create_balance_trigger` (battletest) | `BgziDzgNudpyXVh1j7zeq9Jemr5GnVbs2C1tiKwecJMx` | 194637969 | trigger `dca-intents-trigger-mo5bmbsr` registered |
| B4c | DCA `execute_trigger` (battletest tick) | `EUZLVZjt6DHg9YyNoYqoXC3ZNuJN8BdMZmx865UZaS3F` | 194637974–194637983 | namespace `auto:dca-intents-trigger-mo5bmbsr:1`; `sequence_completed` + `run_finished`, duration 4.8s |

### Canonical DCA reference run (user-locked)

A second DCA run immediately after the battletest sweep, locked as the
reference in `CLAUDE.md` + `examples/README.md`. Template/trigger ids
use the `mo5bslc5` run-nonce; artifact at
`collab/artifacts/2026-04-19T05-28-46-853Z-dca-dca-intents-mo5bslc5-dca-intents-trigger-mo5bslc5.json`.

| Step | Tx hash |
|---|---|
| `save_sequence_template` | `5UuUtZTi3fVu6q1Kd991fTYUwe7EcmZzuweKdXLhw42j` |
| `create_balance_trigger` | `AAJSKYgSYVn7pwd5XtVWjPhfruAVTCfc1DRhPtdMaGJy` |
| `execute_trigger` (one tick) | `E9VDdwXz52VfveWvZfkWKg9QTsW6oduoA1WLB5itFByX` |
| B5 | Bogus assertion method on step 2 | `4K4jXXZMkRTdb1UH6BNNPow7zr6ZCvi1pfCin36TGwxZ` | 194638011–194638212 | `MethodResolveError::MethodNotFound` on assertion view → `assertion_checked outcome:"postcheck_failed"` → same halt path as mismatch; ~122s decay |

## Cross-contract targets exercised

- `wrap.near` — wNEAR (NEP-141). Touched on steps 1 & 2 of every run, and on step-3's `ft_withdraw` target.
- `intents.near` — Defuse Verifier. NEP-245 balance ledger (`mt_balance_of`, `mt_batch_balance_of`); NEP-413 signed-intent acceptor; `dip4` event standard. Touched on steps 2 (deposit) and 3 (withdraw).
- `mike.near` — signer, owner of smart account, receiver of withdrawn wNEAR.

## State snapshot (block 194638281, 2026-04-18 ~05:25 UTC)

| Ledger | Value |
|---|---|
| `sequential-intents.mike.near` NEAR balance | 4.9234 |
| `mike.near` wNEAR balance on `wrap.near` | 44.507823662688745231845165 |
| `mike.near` wNEAR on `intents.near` (token `nep141:wrap.near`) | **0.04 wNEAR stranded** (from battletest halts: 0.02 carry-in + 0.01 DCA tick + 0.01 B5 halt) |
| `registered_steps_for(mike.near)` | `[]` (clean) |
| DCA trigger `dca-intents-trigger-mo5bmbsr` | persisted; `last_run_outcome: "Succeeded"` |
| Sequence template `dca-intents-mo5bmbsr` | persisted |

## Cleanup — not yet executed (optional)

- **Stranded 0.04 wNEAR on `intents.near`.** The flagship's round-trip is net-zero on intents — so `sequential-intents.mjs` in its current shape can't drain the stranded balance. Cleanup paths:
  - Build and submit a NEP-413 `ft_withdraw` intent directly via `near call intents.near execute_intents '{"signed":[…]}' …` — low effort, ~30 lines of inline JS or a future `--withdraw-only` flag on the flagship.
  - Leave it; 0.04 wNEAR is negligible.
- **DCA template + trigger** can be removed via:
  ```
  near call sequential-intents.mike.near delete_balance_trigger '{"trigger_id":"dca-intents-trigger-mo5bmbsr"}' --accountId mike.near
  near call sequential-intents.mike.near delete_sequence_template '{"sequence_id":"dca-intents-mo5bmbsr"}' --accountId mike.near
  ```

## Artifact files (full JSON records)

All in `collab/artifacts/`. Filename pattern: `YYYY-MM-DDTHH-mm-ss-sssZ-<flagship>-<signer>-<runId>.json`. Representative set from this session:

- `2026-04-19T04-43-09-884Z-intent-sequence-deposit-only-mike-near-mo5a5xh8.json` — Phase 5
- `2026-04-19T04-44-03-387Z-intent-sequence-round-trip-mike-near-mo5a72rf.json` — Phase 6
- `2026-04-19T05-13-31-443Z-intent-sequence-round-trip-mike-near-mo5b8z03.json` — B1 poison-step=2
- `2026-04-19T05-21-57-242Z-intent-sequence-round-trip-mike-near-mo5bjta2.json` — B2 poison-step=3
- `2026-04-19T05-23-54-555Z-dca-dca-intents-mo5bmbsr-dca-intents-trigger-mo5bmbsr.json` — B4 DCA
- `2026-04-19T05-24-23-324Z-intent-sequence-round-trip-mike-near-mo5bmxzw.json` — B5 bogus-method

Each artifact contains the submitted plan, the signed NEP-413 envelope (for round-trip runs), pre/post balance snapshots, tx metadata, and the full follow-up command set.
