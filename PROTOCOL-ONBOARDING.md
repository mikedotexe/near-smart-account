# Protocol Onboarding

Primary operator guide for using this smart-account sequencer against
contracts we did not write.

## Narrow theorem

The smart account creates the next real `FunctionCall` receipt only after the
previous step's trusted completion surface resolves.

Sequential here means **receipt-release order**, not exclusive chain
execution. Unrelated receipts may still interleave elsewhere on-chain.

## Completion surface

A **completion surface** is the callback-visible success/failure signal the
smart account chooses to trust for one step.

That surface can be:

- the target receipt itself in `Direct`
- a protocol-specific adapter receipt in `Adapter`
- a future postcondition check in `Asserted`

The sequencer does **not** require a meaningful return payload. It requires a
truthful completion surface.

## Quick rule

- Empty / void success is fine in `Direct`.
- A returned promise chain that truthfully covers the target's whole internal
  async path is also fine in `Direct`.
- Hidden async work that the target does not return is **not** fine in
  `Direct`; use `Adapter`.
- Cases where even a truthful promise chain is not enough to prove the effect
  we care about point toward future `Asserted` support.

## Onboarding checklist

1. Identify the exact step you want the smart account to sequence.
2. Decide the completion policy:
   `Direct` if the target receipt is already truthful, `Adapter` if the target
   can return before the real effect is done.
3. Run the smallest probe that exercises only that step or one mixed sequence.
4. Investigate the probe tx with `scripts/investigate-tx.mjs`.
5. Record the evidence:
   tx hash, signer, included block, receipt blocks, chosen completion surface,
   conclusion, and caveats.

## Compatibility rubric

| Situation | Completion policy | Why |
|---|---|---|
| Leaf or synchronous state change | `Direct` | The target receipt already means the step is done. |
| Returned promise chain covers the whole async path | `Direct` | The callback-visible result is truthful enough to advance on. |
| Target starts nested async work and returns plain value or nothing | `Adapter` | The outer receipt can succeed before the real effect finishes. |
| We ultimately care about resulting balances or post-state, not just promise completion | `Asserted` later | Completion needs a postcondition, not only receipt success. |

## Repo-seeded protocol matrix

| Target step | Recommended policy | Trusted completion surface | Notes |
|---|---|---|---|
| `router.route_echo` | `Direct` | `router` receipt chain | Honest demo leaf-style protocol. |
| `wild-router.route_echo_fire_and_forget` | `Adapter` | `demo-adapter.adapt_fire_and_forget_route_echo` | Outer receipt returns before the real downstream effect is visible. |
| `wrap.testnet.near_deposit` | `Direct` | `wrap.testnet.near_deposit` receipt | Honest single-step external protocol path. |
| `wrap.testnet.near_deposit -> ft_transfer` via `compat-adapter` | `Adapter` | `compat-adapter.adapt_wrap_near_deposit_then_transfer` | Real external protocol path where the adapter collapses the sequence into one honest result. |

## Investigation workflow

The wrapper script turns the repo's three-surfaces ritual into one command:

```bash
./scripts/investigate-tx.mjs <tx_hash> <signer> \
  --wait FINAL \
  --view '{"account":"...","method":"...","args":{...}}' \
  --accounts account_a,account_b \
  --format both \
  --out collab/artifacts/investigate-example
```

What it gives you:

- Surface 1: traced receipt DAG
- Surface 2: block-pinned state snapshots at interesting blocks
- Surface 3: per-block receipt ordering for the investigated tx
- account activity rows inside the cascade window
- a JSON artifact with `schema_version: 1`

### Canonical example

This live mixed `wrap.testnet` run is a good reference probe because it mixes
`Direct` and `Adapter` in one real external protocol flow:

```bash
./scripts/investigate-tx.mjs \
  3MKbDCngBqKake71a8SDLtv8HvixnfeDZBt4HSKwaxaf \
  x.mike.testnet \
  --wait FINAL \
  --view '{"account":"smart-account.x.mike.testnet","method":"get_balance_trigger","args":{"trigger_id":"balance-trigger-mo4d7wjw"}}' \
  --view '{"account":"wrap.testnet","method":"ft_balance_of","args":{"account_id":"smart-account.x.mike.testnet"}}' \
  --accounts smart-account.x.mike.testnet,wrap.testnet,compat-adapter.x.mike.testnet \
  --format both \
  --out collab/artifacts/investigate-wrap-mixed
```

What that probe demonstrates:

- `register` and `alpha` are honest `Direct` steps against `wrap.testnet`
- `beta` is adapter-backed and only advances after
  `compat-adapter.adapt_wrap_near_deposit_then_transfer(...)` finishes
- the account ends with the expected wNEAR increase and the adapter finishes at
  zero balance

## What to save from every investigation

- tx hash
- signer
- included block height
- receipt block heights
- chosen completion policy and completion surface
- one-sentence conclusion
- caveats

If the conclusion depends on a protocol-specific assumption, write that
assumption down explicitly. The point of this process is not only to get a
green trace; it is to make the trust boundary legible to the next engineer.

## Pointers

- Deeper compatibility rationale:
  [`md-CLAUDE-chapters/14-wild-contract-compatibility.md`](./md-CLAUDE-chapters/14-wild-contract-compatibility.md)
- Deeper onboarding and investigation walkthrough:
  [`md-CLAUDE-chapters/19-protocol-onboarding-and-investigation.md`](./md-CLAUDE-chapters/19-protocol-onboarding-and-investigation.md)
