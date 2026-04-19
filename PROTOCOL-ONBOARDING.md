# Protocol Onboarding

How to add a new protocol step to a sequential-intents plan — picking
a `StepPolicy`, probing it, and writing down enough evidence that the
next engineer can trust the trust boundary.

## Mental model in one sentence

The smart account creates the next real `FunctionCall` receipt only
after the previous step's **resolution surface** settles and its
**`StepPolicy`** passes. Adding a new protocol means picking the
resolution surface for that protocol's receipts.

Sequential here means **receipt-release order**, not exclusive chain
execution. Unrelated receipts may still interleave elsewhere on-chain.

## Resolution surface

A **resolution surface** is the callback-visible success/failure signal
the smart account chooses to trust for one step.

That surface can be:

- the target receipt itself, under `Direct`
- a protocol-specific adapter receipt, under `Adapter`
- a caller-specified postcheck receipt, under `Asserted` (chapter 21)

The sequencer does **not** require a meaningful return payload. It
requires a truthful resolution surface.

## Policy decision tree

Each step carries a `StepPolicy` (post-dispatch behavior) and
optionally a `PreGate` (pre-dispatch gate). They compose:

- **`Direct`** (StepPolicy) — trust the target's receipt. Empty / void
  success is fine. A returned promise chain that truthfully covers
  the target's whole internal async path is also fine.
- **`Adapter { adapter_id, adapter_method }`** (StepPolicy) — target's
  async is messy and doesn't surface completion honestly. Route
  through a protocol-specific adapter contract that collapses the
  mess into one honest top-level result.
- **`Asserted { assertion_id, assertion_method, assertion_args, expected_return, assertion_gas_tgas }`** (StepPolicy) —
  you want a postcondition on target state (not just "receipt
  succeeded"). The kernel fires a zero-deposit `FunctionCall` after
  the target resolves and advances only if the returned bytes match
  `expected_return` exactly.
- **`PreGate { gate_id, gate_method, gate_args, min_bytes, max_bytes, comparison, gate_gas_tgas }`** —
  optional **pre-dispatch** gate alongside any `StepPolicy`. The
  kernel fires the gate BEFORE dispatching the target, compares the
  returned bytes to `[min_bytes, max_bytes]` under `comparison`, and
  advances-and-dispatches only if in range. Out-of-range or gate
  panic → the sequence halts with `pre_gate_checked.outcome != "in_range"`
  and the target never fires. Use for limit orders, freshness checks,
  balance minimums, rate limits.

**Choosing between `Adapter` and `Asserted`.** `Adapter` encapsulates
multi-step reconciliation (poll N times, chain M follow-ups, collapse
into one honest return) and lives in a dedicated adapter contract.
`Asserted` encapsulates a single post-resolve equality check against
whatever postcheck method the caller names. That postcheck is a real
`FunctionCall`, not an enforced read-only view, so the caller must
pick a trustworthy postcheck surface. Pick `Asserted` when one
postcheck call makes success/failure legible in one byte-comparison
(a counter that must have incremented, a balance that must equal X,
a sentinel flag that must be set). Pick `Adapter` when the
reconciliation itself is non-trivial — multi-poll, retry,
cross-contract aggregation.

## Compatibility rubric

| Situation | Policy / Gate | Why |
|---|---|---|
| Leaf or synchronous state change | `Direct` | The target receipt already means the step is done. |
| Returned promise chain covers the whole async path | `Direct` | Callback-visible result is truthful enough to advance on. |
| Target starts nested async work and returns plain value or nothing | `Adapter` | Outer receipt can succeed before the real effect finishes. |
| Ultimately care about resulting balances or post-state, and one postcheck call proves it | `Asserted` | Completion needs a single byte-equality postcheck against a caller-specified `FunctionCall` surface. |
| Only fire the target if live view X sits in range [min, max] (limit order, freshness check, rate limit) | `PreGate` (+ any `StepPolicy`) | Halts BEFORE the target fires if out-of-range — no wasted side effects. |
| Need BOTH "only fire if condition" AND "advance only if post-state is X" | `PreGate` + `Asserted` | Composable: pre-gate halts without dispatching; Asserted halts after if post-state is wrong. |
| Step N+1's args depend on step N's return (ladder-swap, allowance-drain, amount splits) | `save_result` on step N + `args_template` on step N+1 | Materializes args at dispatch time from saved bytes; one signed plan, no off-chain read-then-sign loop. See chapter 24. |
| Delegate a third-party dapp / agent to fire your `BalanceTrigger` up to N times over T seconds with zero further prompts | `enroll_session` (annotated FCAK) | Owner signs once; annotated key is revocable, rate-capped, allowlist-scoped. See chapter 25 / `SESSION-KEYS.md`. |

## Worked example — adding a step against `intents.near`

The flagship (`examples/sequential-intents.mjs`) onboards three steps:

| # | Target | Method | Policy | Why |
|---|---|---|---|---|
| 1 | `wrap.near` | `near_deposit` | `Direct` | Leaf state change; receipt success = wNEAR minted. |
| 2 | `wrap.near` | `ft_transfer_call` → `intents.near` deposit | `Asserted` | An `ft_transfer_call` can succeed at the receipt level while the verifier ledger refunds the deposit; only an `mt_balance_of` postcheck catches that drift. |
| 3 | `intents.near` | `execute_intents` (signed `ft_withdraw` intent) | `Asserted` | Same shape — the signed intent can land but the downstream `ft_transfer` can still fail; an `ft_balance_of` on the destination is the honest post-state check. |

The `Asserted` wire form used in step 2 is worth studying — it's the
repeatable pattern for any NEP-245 / NEP-141 post-state check:

```json
{
  "Asserted": {
    "assertion_id": "intents.near",
    "assertion_method": "mt_balance_of",
    "assertion_args": "<base64 of {\"account_id\":\"…\",\"token_id\":\"nep141:wrap.near\"}>",
    "expected_return": "<base64 of JSON.stringify(\"<expected yocto as string>\")>",
    "assertion_gas_tgas": 30
  }
}
```

`intents.near` returns NEP-245 balances as JSON string-encoded `u128`
values; the expected bytes must be the same string shape (with
quotes) or the match will fail.

## Onboarding checklist

1. Identify the exact step you want the smart account to sequence.
2. Decide the `StepPolicy` using the rubric above.
3. If `Asserted`, pick the postcheck method and write down the exact
   expected bytes. Use `scripts/state.mjs` to confirm the view returns
   what you think it does against a live baseline.
4. If `Adapter`, write the adapter contract first and prove it
   collapses the target's async into one honest return.
5. Run the smallest probe that exercises only that step, or one mixed
   sequence that includes it.
6. Investigate the probe tx with `scripts/investigate-tx.mjs`.
7. Record the evidence: tx hash, signer, included block, receipt
   blocks, chosen policy + resolution surface, one-sentence
   conclusion, and caveats.

## Repo-seeded protocol matrix

| Target step | Policy | Resolution surface | Notes |
|---|---|---|---|
| `wrap.near.near_deposit` | `Direct` | `wrap.near.near_deposit` receipt | Honest single-step external protocol path. |
| `intents.near` deposit via `wrap.near.ft_transfer_call` | `Asserted` | `intents.near.mt_balance_of` postcheck on `nep141:wrap.near` | Catches deposit-path refunds that look like receipt success. |
| `intents.near.execute_intents` (signed `ft_withdraw`) | `Asserted` | `wrap.near.ft_balance_of` postcheck on destination | Catches withdrawal failures where the signed intent lands but the inner `ft_transfer` is a no-op. |
| `wrap.near.near_deposit → ft_transfer` via `compat-adapter` | `Adapter` | `compat-adapter.adapt_wrap_near_deposit_then_transfer` | Real external protocol path where the adapter collapses the sequence into one honest result. |
| `router.route_echo` | `Direct` | `router` receipt chain | Honest demo leaf-style protocol. |
| `wild-router.route_echo_fire_and_forget` | `Adapter` | `demo-adapter.adapt_fire_and_forget_route_echo` | Outer receipt returns before the real downstream effect is visible. |
| `pathological-router.noop_claim_success` / `return_decoy_promise` | `Asserted` | `pathological-router.get_calls_completed` | Pathology probe for noop / decoy. Chapter 21 shows the kernel catches them via counter-equality postcheck. |
| `pathological-router.do_honest_work` | `Direct` | `pathological-router.do_honest_work` receipt | Honest control probe. |

## Investigation workflow

The wrapper script turns the repo's three-surfaces ritual into one
command:

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
- account activity rows for the investigated tx, with omitted
  unrelated window-row counts called out explicitly
- yield-lifecycle classification when the traced tx is part of a
  sequential-intents flow
- structured `sa-automation` receipt events and per-namespace run
  summaries when the traced tx emits `EVENT_JSON:` telemetry
- compact telemetry metrics like duration, resume/resolve latency,
  and max observed used gas when those structured events are present
- a JSON artifact with `schema_version: 1`

For account-wide telemetry rather than one transaction, use:

```bash
./scripts/aggregate-runs.mjs <smart_account_id> --with-blocks --limit 50
./scripts/aggregate-runs.mjs <smart_account_id> --with-blocks --limit 50 --format both --out collab/artifacts/aggregate-runs-example
```

That report is intentionally markdown-first for humans — run-summary
table up top, then transaction coverage, then per-run event detail
underneath.

Artifacts under `collab/artifacts/` are local by default. The repo
keeps two curated JSON reference examples checked in: one direct-style
router run and one adapter-backed `wrap.testnet` run.

## Operator notes

**Testnet churn rule.**

- Use fresh direct-child accounts for delete/recreate probe loops.
- Long-lived shared rigs can cross NEAR's `DeleteAccountWithLargeState`
  guard even with plenty of balance — clean state explicitly or move
  to a fresh child.

**Mainnet multi-step gas floor.**

- Single-step yielded promises stay pending at `180`, `250`, and
  `500 TGas` per outer action.
- Two-step yielded batches at `180` / `250 TGas` fail with
  `PromiseError::Failed` on the yielded callback.
- Two-step yielded batches at `300` / `400 TGas` stay pending cleanly.
- Operator baseline for mainnet multi-step probes: start at
  `300 TGas` per outer action unless you are intentionally probing
  the failure boundary.

**`intents.near` key-registry gotcha.**

A signer's on-chain NEAR full-access key is **not** auto-trusted by
`intents.near`. First use of `execute_intents` panics with `public
key '<pk>' doesn't exist for account '<signer>'`. Bootstrap via a
direct call:

```bash
near call intents.near add_public_key \
  '{"public_key":"ed25519:<pk>"}' \
  --accountId <signer> --depositYocto 1 --gas 30000000000000
```

Inspect: `intents.near.public_keys_of({account_id})`. See
`SEQUENTIAL-INTENTS-DESIGN.md` §10.8.

### Canonical mainnet reference probe

The current reference run for a mixed-policy, real-protocol sequence
is the flagship round-trip on `sequential-intents.mike.near`:

```bash
./scripts/investigate-tx.mjs \
  7btFS8LzGQUpHari3EnzCEvyr3dU3r4egKCsnPVZMgmJ \
  mike.near \
  --wait FINAL \
  --view '{"account":"intents.near","method":"mt_balance_of","args":{"account_id":"mike.near","token_id":"nep141:wrap.near"}}' \
  --view '{"account":"wrap.near","method":"ft_balance_of","args":{"account_id":"mike.near"}}' \
  --accounts sequential-intents.mike.near,intents.near,wrap.near \
  --format both \
  --out collab/artifacts/investigate-sequential-intents-roundtrip
```

What that probe demonstrates:

- step 1 (`wrap.near.near_deposit`) is honest `Direct`
- step 2 (`ft_transfer_call` with DepositMessage) is `Asserted` on
  `intents.near.mt_balance_of(nep141:wrap.near)`
- step 3 (`execute_intents` with signed `ft_withdraw`) is `Asserted`
  on `wrap.near.ft_balance_of` for the withdrawal destination
- the sequence ends with exact pre/post balance equality

## What to save from every investigation

- tx hash
- signer
- included block height
- receipt block heights
- chosen `StepPolicy` + resolution surface
- one-sentence conclusion
- caveats

If the conclusion depends on a protocol-specific assumption, write
that assumption down explicitly. The point of this process is not only
to get a green trace — it is to make the trust boundary legible to
the next engineer.

## Pointers

- Deeper compatibility rationale:
  [`md-CLAUDE-chapters/14-wild-contract-compatibility.md`](./md-CLAUDE-chapters/14-wild-contract-compatibility.md)
- Deeper onboarding and investigation walkthrough:
  [`md-CLAUDE-chapters/19-protocol-onboarding-and-investigation.md`](./md-CLAUDE-chapters/19-protocol-onboarding-and-investigation.md)
- `Asserted` design and testnet probes:
  [`md-CLAUDE-chapters/21-asserted-resolve-policy.md`](./md-CLAUDE-chapters/21-asserted-resolve-policy.md)
- `PreGate` design and testnet probes:
  [`md-CLAUDE-chapters/23-pre-gate-policy.md`](./md-CLAUDE-chapters/23-pre-gate-policy.md)
- Value threading (`save_result` + `args_template`) design:
  [`md-CLAUDE-chapters/24-value-threading.md`](./md-CLAUDE-chapters/24-value-threading.md)
- Session keys (annotated FCAK) design + user walkthrough:
  [`md-CLAUDE-chapters/25-session-keys.md`](./md-CLAUDE-chapters/25-session-keys.md),
  [`SESSION-KEYS.md`](./SESSION-KEYS.md)
- `intents.near` surface map and battletest findings:
  [`SEQUENTIAL-INTENTS-DESIGN.md`](./SEQUENTIAL-INTENTS-DESIGN.md)
