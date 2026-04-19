# Examples — sequential intent plans

Three runnable scripts. Each drives the smart account's `execute_steps`
entry point (direct call) or `save_sequence_template` + `execute_trigger`
entry points (scheduled), with per-step `StepPolicy` gating the next
step on the settled state of the previous one. All mainnet; the smart
account contract must be deployed at `--smart-account <id>` first.

## [`sequential-intents.mjs`](./sequential-intents.mjs) — primary flagship

Three-step round-trip on NEAR Intents (`intents.near`). Demonstrates
what the kernel uniquely enables: sequential ordering across separate
`intents.near` operations.

1. `wrap.near.near_deposit` — mint `N` wNEAR to the smart account.
2. `wrap.near.ft_transfer_call → intents.near` — credit `N` wNEAR to
   the signer's NEAR Intents balance.  Asserted on `intents.near`'s
   `mt_balance_of` — advances only when the verifier ledger reflects
   the new balance.
3. `intents.near.execute_intents` — a NEP-413 signed `ft_withdraw`
   intent pulls the `N` wNEAR back out to the signer's wallet. Asserted
   on `wrap.near`'s `ft_balance_of(signer)` — advances only when the
   wallet ledger reflects the withdrawal.

Without the kernel, step 3 would race step 2 on-chain and fail with
insufficient balance on the verifier; the `Asserted` policy guarantees
step 3 only fires after step 2's ledger credit is observed.

```bash
./examples/sequential-intents.mjs \
  --signer mike.near \
  --smart-account sequential-intents.mike.near \
  --amount-near 0.01
```

Reference mainnet runs on `sequential-intents.mike.near` (2026-04-18):
- deposit-only: [`3sfgmiY94t9VMzBL79Dxms3bbW4CAkTzdPT1xuyuFEoD`](https://www.nearblocks.io/txns/3sfgmiY94t9VMzBL79Dxms3bbW4CAkTzdPT1xuyuFEoD)
- round-trip  : [`7btFS8LzGQUpHari3EnzCEvyr3dU3r4egKCsnPVZMgmJ`](https://www.nearblocks.io/txns/7btFS8LzGQUpHari3EnzCEvyr3dU3r4egKCsnPVZMgmJ)
- battletest `--poison-step=2` — halt-on-byte-mismatch (`outcome: "mismatch"`): [`9NKmC7u7aqYT71PKqjDwSppPJ5LFZHk5z781Wvhr38Tj`](https://www.nearblocks.io/txns/9NKmC7u7aqYT71PKqjDwSppPJ5LFZHk5z781Wvhr38Tj)
- battletest `--bogus-method=2` — halt-on-view-call-error (`outcome: "postcheck_failed"`, `MethodResolveError: MethodNotFound`): [`AhmPjiNE6Jh4cpE53vMo6hYD5Ax7XP1rSByjMEbpPYEE`](https://www.nearblocks.io/txns/AhmPjiNE6Jh4cpE53vMo6hYD5Ax7XP1rSByjMEbpPYEE)

Flags:
- `--deposit-only` — collapse to steps 1+2 (original onboard flagship).
- `--credit-to <account>` — route the deposit/withdraw to a non-signer
  account (the signer still executes `execute_steps`; `--credit-to`
  signs the `ft_withdraw` intent).
- `--intent-deadline-ms <n>` — NEP-413 intent validity window from tx
  submission (default 5 min).
- `--poison-step <2|3>` — battletest: off-by-+1 yocto on that step's
  Asserted expected_return so its postcheck fails → sequence halts.
  Preceding step's on-chain effect lands and is not rolled back
  (lab accounts only).
- `--bogus-method <2|3>` — battletest: substitute that step's
  assertion_method with a nonexistent name → MethodNotFound during
  postcheck → sequence halts (error path, not mismatch).

Exit code: `0` when `intents.near` balance delta is `0` *and* signer's
`wrap.near` balance is up by `--amount-near`; `1` otherwise.

## [`wrap-and-deposit.mjs`](./wrap-and-deposit.mjs) — cross-protocol composition

Two-step atomic composition across unrelated protocols: wrap NEAR and
deposit the resulting wNEAR into Ref Finance's internal balance.
Demonstrates that the kernel's sequential guarantees extend beyond
`intents.near` — any two protocols with clean view methods can be
composed into a single sequenced plan.

1. `wrap.near.near_deposit` — `Direct` policy.
2. `wrap.near.ft_transfer_call → v2.ref-finance.near` — `Asserted`
   policy on Ref's `get_deposit`, so a receipt-level refund without
   true internal credit halts the sequence.

```bash
./examples/wrap-and-deposit.mjs \
  --network mainnet \
  --signer mike.near \
  --smart-account sa-wallet.mike.near \
  --amount-near 0.05
```

Pass `--network testnet` with a testnet smart-account and `--signer
<testnet-account>` to run against `wrap.testnet` + Ref's testnet
deployment (`ref-finance-101.testnet`).

## [`dca.mjs`](./dca.mjs) — scheduled variant

Recurring version of the `sequential-intents.mjs` deposit half. Saves a
2-step template (wrap + deposit to `intents.near`) and registers a
balance trigger that fires one tick whenever the smart account's own
balance rises above `--min-balance-yocto`. Each tick accumulates
`--amount-near` wNEAR on the signer's `intents.near` balance — that's
the dollar-cost-averaging.

Recurring templates use `Direct` policy for both steps: `Asserted` with
a fixed `expected_return` can't handle a post-tick balance that grows
each run.

```bash
./examples/dca.mjs \
  --signer mike.near \
  --smart-account sa-wallet.mike.near \
  --amount-near 0.01 \
  --min-balance-yocto 30000000000000000000000000 \
  --max-runs 100
```

The script saves the template, creates the trigger, and fires exactly
one tick before exiting. Subsequent ticks are a single `near call`:

```bash
near call sa-wallet.mike.near execute_trigger '{"trigger_id":"<id>"}' \
  --accountId <executor> --gas 800000000000000
```

Reference mainnet run on `sequential-intents.mike.near` (2026-04-18):
- `save_sequence_template`: [`5UuUtZTi3fVu6q1Kd991fTYUwe7EcmZzuweKdXLhw42j`](https://www.nearblocks.io/txns/5UuUtZTi3fVu6q1Kd991fTYUwe7EcmZzuweKdXLhw42j)
- `create_balance_trigger`: [`AAJSKYgSYVn7pwd5XtVWjPhfruAVTCfc1DRhPtdMaGJy`](https://www.nearblocks.io/txns/AAJSKYgSYVn7pwd5XtVWjPhfruAVTCfc1DRhPtdMaGJy)
- `execute_trigger` (one tick): [`E9VDdwXz52VfveWvZfkWKg9QTsW6oduoA1WLB5itFByX`](https://www.nearblocks.io/txns/E9VDdwXz52VfveWvZfkWKg9QTsW6oduoA1WLB5itFByX)

## Preflights and funding

All flagships assume:
- The smart account contract is deployed at `--smart-account`.
- The smart account is registered on `wrap.near` for storage (step 1
  mints wNEAR to it).
- For `sequential-intents.mjs` round-trip (step 3), the `--credit-to`
  account is also registered on `wrap.near` (so the `ft_withdraw`'s
  internal `ft_transfer` lands).
- The smart account is pre-funded with `>= --amount-near` NEAR; step 1
  attaches from the smart account's own balance.

Each script's preflight catches these pre-conditions and emits the
exact `near call` to fix them. Pass `--skip-preflight` to bypass.

## Dry-running and artifacts

Every script supports `--dry` to print the plan and exit before sending
anything. Live runs write a JSON artifact to `collab/artifacts/` with
the full plan, tx hashes, balance deltas, and follow-up commands
(`trace-tx.mjs`, `investigate-tx.mjs`, `state.mjs` views).

## Adding your own

The scaffolding is generic. To add another sequential-intent flagship:
1. Build your steps as `StepInput` objects (`step_id`, `target_id`,
   `method_name`, base64 `args`, `attached_deposit_yocto`, `gas_tgas`,
   optional `policy`).
2. Call `execute_steps({ steps: [...] })` on the smart account.
3. If any step involves NEAR Intents' signed payload (swap, withdraw,
   transfer, etc.), use `buildSignedIntent` from
   [`../scripts/lib/nep413-sign.mjs`](../scripts/lib/nep413-sign.mjs).
4. Pick an `Asserted` postcheck wherever "receipt succeeded" is too
   weak a signal — e.g. target-state balance checks, counter reads,
   LP-position queries.
