# Deploy — `sequential-intents.mike.near` (mainnet v3)

> **Historical — v3 era.** This doc describes the v3 sequencer deploy to
> the `sequential-intents.mike.near` subaccount (2026-04-18). It
> remains the canonical recipe for anyone reproducing the v3
> reference runs logged in
> [`MAINNET-V3-JOURNAL.md`](./MAINNET-V3-JOURNAL.md).
>
> **For current (v4) work, use [`DEPLOY-MIKE-NEAR.md`](./DEPLOY-MIKE-NEAR.md).**
> The v4 sequencer intentionally runs on `mike.near` itself (not a
> child account) — the "never deploy to `mike.near`" rule below
> was period-accurate for v3 but no longer applies to v4.

**Mainnet deploy of the v3 smart-account sequencer, targeted by
`examples/sequential-intents.mjs`.** Fresh subaccount; no migration
(Phase A's Borsh state break doesn't affect a new deploy). Pass 4 of
the sequential-intents reshape plan.

Safety guardrails (v3-era; see banner above for v4 update):
- **Never** deploy the contract to `mike.near` itself — always a
  sacrificial child.
- Use small stakes (0.01 NEAR per run) until the round-trip validates.
- `sequential-intents.mike.near` is a lab account; don't move
  meaningful assets into it.

## Phase 0 — prerequisites

- `mike.near` credential at `~/.near-credentials/mainnet/mike.near.json` (present ✓).
- near-cli (JS) installed globally (`which near`).
- rustup with `wasm32-unknown-unknown` target.
- `mike.near` balance ≥ 7 NEAR (5 initial + operational headroom).

```bash
export NEAR_ENV=mainnet
```

## Phase 1 — build contract WASM

```bash
./scripts/build-all.sh
ls -la res/smart_account_local.wasm   # expect ~345 KB
```

If `smart_account_local.wasm` exists from a prior build dated on or
after the Phase A rename tranche (`execute_steps` facade + `StepPolicy`
renames), it's reusable. Otherwise force a rebuild.

## Phase 2 — create the subaccount

```bash
near create-account sequential-intents.mike.near \
  --masterAccount mike.near \
  --initialBalance 5
```

- **Cost:** ~5 NEAR locked into the new account (covers ~3.5 NEAR
  contract-storage reservation + ~1.5 NEAR operating headroom).
- **Verify:**
  ```bash
  ./scripts/state.mjs sequential-intents.mike.near --method get_authorized_executor --args '{}'
  ```
  Expected: `MethodNotFound` (no contract deployed yet) — confirms the
  account exists but is empty. That's the right state entering Phase 3.

## Phase 3 — deploy the sequencer + init

```bash
near deploy sequential-intents.mike.near res/smart_account_local.wasm \
  --initFunction new_with_owner \
  --initArgs '{"owner_id":"mike.near"}'
```

- **Owner:** `mike.near` — so `mike.near` can call `execute_steps`,
  `save_sequence_template`, `create_balance_trigger`, etc. without a
  separate authorized-executor step.
- **Cost:** the 5 NEAR from Phase 2 is drawn against storage for the
  ~345 KB WASM (~3.45 NEAR locked at storage prices; rest operating).
- **Verify:**
  ```bash
  ./scripts/state.mjs sequential-intents.mike.near --method get_authorized_executor --args '{}'
  ```
  Expected: `null` (no separate executor set — owner handles all
  authorized actions).

## Phase 4 — register smart account on `wrap.near`

Step 1 of the flagship plan calls `wrap.near.near_deposit`, which
credits wNEAR to the caller — the smart account. That credit needs
storage registered on `wrap.near` for the smart account.

```bash
near call wrap.near storage_deposit \
  '{"account_id":"sequential-intents.mike.near","registration_only":true}' \
  --accountId mike.near --deposit 0.00125
```

- **Cost:** 0.00125 NEAR (paid by `mike.near`, credited to the smart
  account's storage on `wrap.near`).
- **Verify:**
  ```bash
  ./scripts/state.mjs wrap.near --method storage_balance_of --args '{"account_id":"sequential-intents.mike.near"}'
  ```
  Expected: `{"total":"1250000000000000000000","available":"0"}`.

The signer (`mike.near`) already has `wrap.near` storage registered from
prior wrap activity. If not, repeat the same command with
`"account_id":"mike.near"`.

## Phase 5 — live-validate deposit-only first (smaller surface)

Before the full round-trip, shake out the deposit half. No signed
intent yet; this validates steps 1 + 2 against live `intents.near`.

```bash
./examples/sequential-intents.mjs \
  --signer mike.near \
  --smart-account sequential-intents.mike.near \
  --amount-near 0.01 \
  --deposit-only
```

**Expected:**
- Exit code `0`.
- `mt_balance_of(mike.near, nep141:wrap.near)` on `intents.near`
  increases by exactly `10000000000000000000000` yocto (0.01 wNEAR).
- Artifact dropped in `collab/artifacts/*-intent-sequence-deposit-only-*.json` with the
  `execute_steps` tx hash.
- Reference it:
  ```bash
  ./scripts/trace-tx.mjs <tx_hash> mike.near --wait FINAL
  ```

If this fails, **stop** — the round-trip won't help. Common issues:
- smart-account not registered on wrap.near (Phase 4).
- smart-account out of balance (top up: `near send mike.near sequential-intents.mike.near 2`).
- gas too low (bump `--action-gas`, e.g. `--action-gas 350`).

## Phase 6 — live-validate the round-trip (the full flagship)

```bash
./examples/sequential-intents.mjs \
  --signer mike.near \
  --smart-account sequential-intents.mike.near \
  --amount-near 0.01
```

**Expected:**
- Exit code `0`.
- After execution: intents balance back to prior value (delta `0`)
  AND `ft_balance_of(mike.near)` on `wrap.near` up by 0.01 wNEAR.
- Each step's Asserted policy fires — `assertion_checked` event in the
  tx trace for both step 2 and step 3.

Inspect the tx:
```bash
./scripts/investigate-tx.mjs <tx_hash> mike.near --wait FINAL \
  --accounts sequential-intents.mike.near,wrap.near,intents.near
```

You should see:
- Receipt at `sequential-intents.mike.near` for `execute_steps`.
- Three child registered steps drained in order (`wrap-*`, `deposit-*`,
  `withdraw-*`).
- `assertion_checked` log after step 2 (intents balance verified) and
  step 3 (wallet wrap balance verified).
- Terminal state `drained` with zero registered steps remaining.

## Phase 7 — record the rig + reference hashes

After green round-trip:

1. Append to `CLAUDE.md` under **Mainnet lab rig**:
   ```
   - `sequential-intents.mike.near` — v3 smart account (owner
     `mike.near`); active primary for `examples/sequential-intents.mjs`
   ```
2. Save the first successful round-trip tx hash to `examples/README.md`
   under the `sequential-intents.mjs` entry ("Reference mainnet run:
   `<hash>`").
3. Optional: a second round-trip run with a different `--amount-near`
   (e.g., 0.02) to double-check that expected-balance computation
   handles varying amounts.

## DCA sanity check (optional)

Once the basic flagship is green, shake out the automation layer too:

```bash
./examples/dca.mjs \
  --signer mike.near \
  --smart-account sequential-intents.mike.near \
  --amount-near 0.01 \
  --min-balance-yocto 1000000000000000000000000   # 1 NEAR threshold
```

Fires one DCA tick and exits. Verify the same balance-delta expectations as deposit-only.

## Troubleshooting

- **`Cannot find contract code, expect at least 1 NEAR`** — subaccount
  underfunded. Top up: `near send mike.near sequential-intents.mike.near 2`.
- **`The contract is not initialized`** — `--initFunction new_with_owner`
  step was skipped or re-run after failure. Call
  `near call sequential-intents.mike.near new_with_owner '{"owner_id":"mike.near"}' --accountId mike.near` manually.
- **`ExecutionError: Exceeded the prepaid gas`** — bump `--action-gas`
  to 350 or 400. PV 83 per-tx ceiling is 1 PGas; 3 steps × 350 = 1050 TGas
  is over the cap — stay at 333 max per step for 3-step plans if you need
  headroom.
- **Step 3 Asserted mismatch** — the `ft_withdraw` signed intent may have
  expired (default deadline 5 min). If the tx took longer than that,
  bump `--intent-deadline-ms 600000` (10 min).
- **`Signer account <x> has no public key` on the withdraw intent** —
  `--credit-to` points at an account without credentials loaded. Either
  drop `--credit-to` to default to `--signer` or ensure that account's
  key is in `~/.near-credentials/mainnet/`.

## Rollback / teardown

This is a lab account — don't delete it casually. If truly needed:

```bash
near delete sequential-intents.mike.near mike.near
```

Returns remaining balance to `mike.near`. Wipes all contract state. You'd
re-run Phase 2–4 to recreate.
