# Protocol Onboarding

Primary operator guide for using this smart-account sequencer against
contracts we did not write.

## Narrow theorem

The smart account creates the next real `FunctionCall` receipt only after the
previous step's trusted resolution surface resolves.

Sequential here means **receipt-release order**, not exclusive chain
execution. Unrelated receipts may still interleave elsewhere on-chain.

## Completion surface

A **resolution surface** is the callback-visible success/failure signal the
smart account chooses to trust for one step.

That surface can be:

- the target receipt itself in `Direct`
- a protocol-specific adapter receipt in `Adapter`
- a caller-specified postcheck receipt in `Asserted` (chapter 21)

The sequencer does **not** require a meaningful return payload. It requires a
truthful resolution surface.

## Quick rule

- Empty / void success is fine in `Direct`.
- A returned promise chain that truthfully covers the target's whole internal
  async path is also fine in `Direct`.
- Hidden async work that the target does not return is **not** fine in
  `Direct`; use `Adapter`.
- Cases where even a truthful promise chain is not enough to prove the effect
  we care about — and where a single postcheck call on target (or sibling) state
  distinguishes "work done" from "work claimed" — use `Asserted`.

**Choosing between `Adapter` and `Asserted`.** `Adapter` encapsulates
multi-step reconciliation (poll N times, chain M follow-ups, collapse into
one honest return) and lives in a dedicated adapter contract. `Asserted`
encapsulates a single post-resolve equality check against whatever
postcheck method the caller names. That postcheck is a real zero-deposit
`FunctionCall`, not an enforced read-only view, so the caller must choose
a trustworthy resolution surface. Pick `Asserted` when one postcheck call
makes success/failure legible in one byte-comparison (e.g., a counter that
must have incremented, a balance that must equal X, a sentinel flag that
must be set). Pick `Adapter` when the reconciliation itself is non-trivial
— multi-poll, retry, cross-contract aggregation.

## Onboarding checklist

1. Identify the exact step you want the smart account to sequence.
2. Decide the resolution policy:
   `Direct` if the target receipt is already truthful, `Adapter` if the target
   can return before the real effect is done.
3. Run the smallest probe that exercises only that step or one mixed sequence.
4. Investigate the probe tx with `scripts/investigate-tx.mjs`.
5. Record the evidence:
   tx hash, signer, included block, receipt blocks, chosen resolution surface,
   conclusion, and caveats.

## Compatibility rubric

| Situation | Completion policy | Why |
|---|---|---|
| Leaf or synchronous state change | `Direct` | The target receipt already means the step is done. |
| Returned promise chain covers the whole async path | `Direct` | The callback-visible result is truthful enough to advance on. |
| Target starts nested async work and returns plain value or nothing | `Adapter` | The outer receipt can succeed before the real effect finishes. |
| We ultimately care about resulting balances or post-state, and one postcheck call on target state proves it | `Asserted` | Completion needs a single byte-equality postcheck against a caller-specified `FunctionCall` surface. |

## Repo-seeded protocol matrix

| Target step | Recommended policy | Trusted resolution surface | Notes |
|---|---|---|---|
| `router.route_echo` | `Direct` | `router` receipt chain | Honest demo leaf-style protocol. |
| `wild-router.route_echo_fire_and_forget` | `Adapter` | `demo-adapter.adapt_fire_and_forget_route_echo` | Outer receipt returns before the real downstream effect is visible. |
| `pathological-router.do_honest_work` | `Direct` | `pathological-router.do_honest_work` receipt | Honest control probe for the broader pathological surface. |
| `pathological-router.noop_claim_success` / `return_decoy_promise` / `return_oversized_payload` | `Asserted` (see chapter 21) for noop/decoy; `Direct` already catches oversized at L2 | `pathological-router.get_calls_completed` for noop/decoy | Public research probe. Chapter 21 demonstrates `Asserted` catching noop and decoy via counter-equality check. |
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
- account activity rows for the investigated tx, with omitted unrelated
  window-row counts called out explicitly
- yield-lifecycle classification when the traced tx is part of a yielded
  `yield_promise` flow
- structured `sa-automation` receipt events and per-namespace run summaries
  when the traced tx emits `EVENT_JSON:` telemetry
- compact telemetry metrics like duration, resume/resolve latency, and max
  observed used gas when those structured events are present
- a JSON artifact with `schema_version: 1`

For account-wide telemetry rather than one transaction, use:

```bash
./scripts/aggregate-runs.mjs <smart_account_id> --with-blocks --limit 50
./scripts/aggregate-runs.mjs <smart_account_id> --with-blocks --limit 50 --format both --out collab/artifacts/aggregate-runs-example
```

That report is intentionally markdown-first for humans:

- an approachable run-summary table up top
- then transaction coverage
- then per-run event detail underneath

Artifacts under `collab/artifacts/` are local by default. The repo only keeps
two curated JSON reference examples checked in: one direct-style router run and
one adapter-backed `wrap.testnet` run.

Testnet churn rule:

- use fresh direct-child accounts for delete/recreate probe loops
- do not assume a long-lived shared rig can always be deleted and recreated,
  even if it still holds plenty of NEAR
- more balance does not bypass `DeleteAccountWithLargeState`; if a shared rig
  crosses that guard, either clean its state explicitly or move the probe to a
  fresh child account

Current mainnet yield-sequence note:

- on the current `sa-lab.mike.near` lab, single-step yielded promises stayed
  pending at `180`, `250`, and `500 TGas`
- two-step yielded batches failed at `180` and `250 TGas` per outer action, and
  stayed pending at `300` and `400 TGas`
- so the present operator baseline for **mainnet multi-step yield batches** is:
  start at `300 TGas` per outer `yield_promise` action unless you are
  intentionally probing the failure boundary

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

### Next public probe surface

When you need a stronger onboarding probe than `wild-router`, reach for
`pathological-router`. It complements the dishonest-async demo with four
distinct shapes that matter in the wild:

- `do_honest_work` — baseline honest control
- `burn_gas` — receipt-level failure from gas exhaustion
- `noop_claim_success` — false success with no real work
- `return_decoy_promise` / `return_oversized_payload` — shapes where raw
  `Direct` success becomes structurally ambiguous

The quickest way to exercise those shapes against the real smart-account kernel
is:

```bash
./scripts/probe-pathological.mjs false_success
```

The preset names are intentionally runtime-facing, not internal nicknames:

- `control`
- `gas_exhaustion`
- `false_success`
- `decoy_returned_chain`
- `oversized_result`

They name the observed execution/completion shape the smart account is probing,
not the personality of the target contract.

## What to save from every investigation

- tx hash
- signer
- included block height
- receipt block heights
- chosen resolution policy and resolution surface
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
