# 2026-04-18 · Adapter policy live validation

## Summary

The adapter-first compatibility path is now validated live on testnet in two
useful shapes:

- a **mixed** sequence with one direct step, one adapter-wrapped dishonest
  async step, and one final direct step
- a **pure adapter** sequence with two adapter-wrapped dishonest async steps

The key live fix was **inside `compat-adapter`**, not the smart-account
sequencer:

- the adapter had been allocating all of its prepaid gas to the outbound
  protocol call plus the callback budget, leaving no slack for its own
  execution overhead
- after adding explicit adapter-local slack in
  `contracts/compat-adapter/src/lib.rs`, the live testnet runs stopped failing
  with `Exceeded the prepaid gas`

## Code changes behind this run

- smart-account redeploy:
  `F7QNK9ZtNBTFuSoZPULxYANPFX64D3LzsBg6y6Fqn3df`
- compat-adapter redeploy:
  `Gj74KupCZceBX57xv8ta55pPC2z2Jwk8pWNJeCP8SeDS`

Behavioral fix:

- `contracts/compat-adapter/src/lib.rs`
  - reserve `ADAPTER_START_OVERHEAD_TGAS = 30`
  - compute callback budget as
    `prepaid_gas - call.gas_tgas - ADAPTER_START_OVERHEAD_TGAS`

This was the missing margin in the live environment.

## Mixed run: success

Artifact:

- `collab/artifacts/2026-04-18T03-45-16-626Z-router-seq-mo3snmtu-balance-trigger-mo3snmtu.json`

Transactions:

| Step | Tx hash | Block |
|---|---|---|
| `save_sequence_template` | `E8y2c7gLYtZ8fKpWg3C8YT24WHx8r6PCCg1y9syjf4PD` | `246249806` |
| `create_balance_trigger` | `5jnFcKjx4knwYxcyapSEpcdbqtLjeBSUtMmFZzRXXT75` | `246249812` |
| `execute_trigger` | `3EJfbHjutASzsQQzdbb3WErDFMSbZZnzhxT5ZneHpiKR` | `246249816` |

Trigger:

- `trigger_id = balance-trigger-mo3snmtu`
- `sequence_id = router-seq-mo3snmtu`
- `sequence_namespace = auto:balance-trigger-mo3snmtu:1`

Final trigger state:

- `runs_started = 1`
- `last_run_outcome = Succeeded`
- `last_finished_at_ms = 1776483934359`

What the sequence actually did:

1. `alpha` ran as a direct `router.route_echo(..., n=111)` step
2. `beta` ran through
   `compat-adapter.adapt_fire_and_forget_route_echo(...)`
3. inside that adapter step, the trace showed:
   - `wild-router.route_echo_fire_and_forget(..., n=222)`
   - `echo(222)`
   - `wild-router.on_echo_finished`
   - `compat-adapter.on_route_echo_started`
   - `wild-router.get_last_finished`
   - `compat-adapter.on_last_finished_polled`
   - one more `wild-router.get_last_finished`
   - final `compat-adapter.on_last_finished_polled => 222`
4. only after that adapter-backed step settled did `gamma` run as direct
   `router.route_echo(..., n=333)`

That is the important proof: the smart account now waits for the adapter’s
truthful completion surface before advancing back into the next staged label.

## Pure adapter run: success

Artifact:

- `collab/artifacts/2026-04-18T03-46-04-477Z-router-seq-mo3sonr1-balance-trigger-mo3sonr1.json`

Transactions:

| Step | Tx hash | Block |
|---|---|---|
| `save_sequence_template` | `6QmXRW8PdTAqxtHKkg6nwxmtPrBZL76pE7yMXVZV5rPf` | `246249887` |
| `create_balance_trigger` | `GXkE7XFcv6A6TTFdupRcMKca8BjNo6UYJdwPBPcUBvDY` | `246249893` |
| `execute_trigger` | `87NS2komjXvHPPMdn28xA7LGxP6szHEUnNZ8Mt345DxL` | `246249897` |

Trigger:

- `trigger_id = balance-trigger-mo3sonr1`
- `sequence_id = router-seq-mo3sonr1`
- `sequence_namespace = auto:balance-trigger-mo3sonr1:1`

Final trigger state:

- `runs_started = 1`
- `last_run_outcome = Succeeded`
- `last_finished_at_ms = 1776483980764`

What the live logs showed:

- `alpha` resumed and completed successfully via the adapter
- `beta` resumed and completed successfully via the adapter

This is the first clean proof that a sequence made entirely of
adapter-wrapped dishonest-async calls can still drain to `Succeeded`.

## Important failed probes we should keep

These failures were useful signal and directly motivated the fix:

- pre-fix mixed run:
  `8LpNmneMb9aZXzTuMEH9sodYo88AKJ1KbVZrjoH7JAc2`
  (`execute_trigger` at block `246249316`) ended
  `last_run_outcome = DownstreamFailed`
- pre-fix pure-adapter run:
  `FgZwiprnh7ppijMZ5zNSWQJdUtsz6NNrDxecSE72ZN8z`
  (`execute_trigger` at block `246249577`) ended
  `last_run_outcome = DownstreamFailed`

The consistent live signature was:

- smart-account resumed the adapter-backed label
- `compat-adapter` was entered
- the step failed with `Exceeded the prepaid gas`

That narrowed the root cause to the adapter’s own gas budgeting.

## Current conclusion

The adapter-first design is now doing what it is supposed to do in the wild:

- `Direct` is good enough for honest leaf-style calls
- `Adapter` can turn a dishonest async protocol shape into an honest
  completion surface
- the smart-account sequencer can mix the two in one ordered sequence and
  advance only on truthful settlement

This is a much stronger claim than the earlier echo-only proofs.
