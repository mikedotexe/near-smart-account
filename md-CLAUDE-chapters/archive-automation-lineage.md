# Archive — Automation lineage

Consolidated archive of three historical chapters that together validated
the first automation layer on top of the staged-call sequencer: sequence
templates, balance triggers, authorized execution, cross-caller
isolation, and positive dual-retry. Superseded by the current reference
chapters (14, 18, 19) and by `TELEMETRY-DESIGN.md` for the telemetry
model; preserved here because the tx hashes and the specific IterableMap
cross-caller surprise are the evidence behind those reference claims.

Original chapters, now merged:

- `09-balance-trigger-sequence-automation.md` — first automation layer
  landing
- `10-cross-caller-isolation-and-positive-dual-retry.md` — cross-caller
  isolation + second-retry-without-halt
- `12-deterministic-smart-account-automation.md` — paper-shaped
  articulation of the mechanism

## 1. Durable thesis

> On NEAR, a smart account can use yield/resume not just to defer
> execution, but to become an explicit control plane for cross-contract
> receipt release. If that control plane also carries durable
> eligibility rules and authorized execution, it starts to look like a
> programmable automation layer for ordered on-chain intent execution.

The automation layer decides **when a sequence may begin**. The staged
execution sequencer (documented in
[`archive-staged-call-lineage.md`](./archive-staged-call-lineage.md))
decides **how the sequence is released**. That separation is the
point.

## 2. Public surface

The existing manual sequencing path is unchanged:

- `stage_call(target_id, method_name, args, attached_deposit_yocto, gas_tgas, step_id, settle_policy?)`
- `run_sequence(caller_id, order)`
- `staged_calls_for(caller_id)` / `has_staged_call(caller_id, step_id)`
- `get_authorized_executor()` / `set_authorized_executor(account_id)`

The automation layer adds:

- `save_sequence_template(sequence_id, calls)` /
  `delete_sequence_template(sequence_id)` /
  `get_sequence_template(sequence_id)` /
  `list_sequence_templates()`
- `create_balance_trigger(trigger_id, sequence_id, min_balance_yocto, max_runs)` /
  `delete_balance_trigger(trigger_id)` /
  `get_balance_trigger(trigger_id)` /
  `list_balance_triggers()`
- `execute_trigger(trigger_id)`

`calls` in `save_sequence_template` uses the same shape as
`stage_call`: `step_id`, `target_id`, `method_name`, `args`,
`attached_deposit_yocto`, `gas_tgas`, optional completion policy.

## 3. Internal mechanism

### 3.1 Sequence namespaces

The key refactor: staged execution is no longer keyed by caller
account id. It is keyed by a generic **sequence namespace**, so the
same sequencer serves both flows while keeping their state isolated.

- manual runs: `manual:{caller_id}`
- automation runs: `auto:{trigger_id}:{run_nonce}`

Durable state carried by the smart account:
`sequence_templates`, `balance_triggers`, `automation_runs`,
`staged_calls`, `sequence_queue`.

### 3.2 Two-layer model of `execute_trigger`

**Layer A — rule admission.** On `execute_trigger(trigger_id)`:
- is the caller authorized (owner or set executor)?
- is the trigger known?
- is it already in flight?
- has it exhausted `max_runs`?
- is the account balance at least
  `max(min_balance_yocto, template.total_attached_deposit_yocto)`?

If all yes, the contract manufactures a fresh staged sequence from the
template under `auto:{trigger_id}:{run_nonce}`.

**Layer B — deterministic release.** The same staged-call sequencer takes
over: `on_stage_call_resume` dispatches the downstream; the next step
is resumed only after `on_stage_call_settled` sees the previous
downstream's result. Identical semantics to the manual path, just
under a different namespace prefix.

### 3.3 "Balance-gated authorized execution" — the precise phrase

"Sufficient balance available" for a trigger does **not** mean:

- ambient unused protocol gas exists somewhere
- the contract can wake itself and consume that gas
- the chain is providing a free execution opportunity

It means:

- an authorized caller is willing to prepay tx gas
- the smart account's own balance makes the run eligible
- the contract has enough balance for any attached deposits in the
  template

The correct phrase is **balance-gated authorized execution**, not
protocol-native spare gas. The contract never wakes itself; automation
here is stateful eligibility plus authorized execution, not a
scheduler. This is the point where intuitive language most easily
drifts away from protocol reality, so the repo keeps this framing
explicit.

## 4. Validated live runs

### 4.1 Owner-funded and delegated-executor automation

Owner-funded reference run:

| Step | Tx | Block |
|---|---|---|
| `save_sequence_template` | `4xSDcvULr5kNyfLA4x56H6jmJZ6RKhsJcvNQCyB1Cj4S` | `246237303` |
| `create_balance_trigger` | `HZuMYmPZydUmhnvchDUkQ7dawzFCssDA1gfp4nUUM43b` | `246237309` |
| `execute_trigger` | `A9n6vFH5Z3p95PfSjw1f8CMpcGDhZ7pW974XUteMbYng` | `246237313` |

Namespace `auto:balance-trigger-mo3ofylb:1`. Downstream values in
declared order: `1 → 2 → 3`.

Delegated-executor reference run:

| Step | Tx | Block |
|---|---|---|
| `set_authorized_executor("mike.testnet")` | `EqedsEmruHr3cnTUFnnTHWdsPWYvS1YoEhmg9JEi19c9` | `246237422` |
| `save_sequence_template` | `KpBqZqmoxHjNgN4prcgUBSPb9ZjSqvk88j8DaxkJJKj` | `246237436` |
| `create_balance_trigger` | `5Da7Pg2pgKAG3XM4XCCrmirvjR69H7EjweCM8ivpRJZw` | `246237442` |
| `execute_trigger` | `BujCoxFWMLWuQicTXwEe5Fk9s1iKYT9d52rLGtX7jyWe` | `246237446` |

Namespace `auto:balance-trigger-mo3ohnar:1`. Downstream values in
declared order: `11 → 22 → 33`.

Gas calibration from these runs:

- `execute_trigger` at `200 TGas` failed with `Exceeded the prepaid gas`
  on `ByLfa9S5TTrzNp4fz9fUpuQrjtA5g3kZypupesGzdJvv` at block `246237246`
- `execute_trigger` at `500 TGas` succeeded for both runs above

### 4.2 Cross-caller isolation + positive dual-retry

Two distinct callers staged same-named labels at the same smart
account, and the owner drained each caller's set independently:

| Step | Tx | Block |
|---|---|---|
| `x.mike.testnet` stages `alpha:11` | `Fwemx5UrZ66sqAQXLjLN61fnZE9gprE3BtXeGKqMaESy` | `246229521` |
| `mike.testnet` stages `alpha:1 beta:2` | `3AuT7f7QdD8cJE9biSzfeyPiHQXkg2i6NBm6WqEWaxfe` | `246229531` |
| `run_sequence(caller_id=x.mike.testnet, order=[alpha])` signed by owner | `44dJSdZ99uTQufUnsWozETLuuREWoQhwx9tGGpuDXt7d` | `246229573` |
| `run_sequence(caller_id=mike.testnet, order=[alpha])` | `B51CDETKobH5em7EH8dpdLchPkuSpBoVfiWeQBrrHT8z` | `246229638` |
| `run_sequence(caller_id=mike.testnet, order=[beta])` | `HaZkk8GR6Z6oLsLTavFV2ZFMG92RJbkH9athBXXnvFSu` | `246229653` |

Side-by-side state at the pivotal blocks:

| Block | `staged_calls_for(x.mike.testnet)` | `staged_calls_for(mike.testnet)` | Event |
|---|---|---|---|
| 246229522 | `[alpha]` | `[]` | `x.mike.testnet`'s batch receipt runs |
| 246229532 | `[alpha]` | `[alpha, beta]` | `mike.testnet`'s batch receipt runs; two distinct `alpha`s live at one contract, keyed `{caller}#{label}` |
| 246229577 | `[]` | `[beta, alpha]` | `x.mike.testnet`'s alpha drained; `mike.testnet`'s set preserved but iteration order flipped (see §5.1) |
| 246229642 | `[]` | `[beta]` | `mike.testnet`'s `alpha` drained |
| 246229657 | `[]` | `[]` | `mike.testnet`'s `beta` drained; both callers' sets empty |

Two `run_sequence` calls against `mike.testnet`'s pending set (blocks
246229638 and 246229653), each succeeding without halt between — the
simplest saga case, proved.

Asymmetry worth naming: `x.mike.testnet` can stage but cannot call
`run_sequence` on its own set under the current authorization. Only
the contract's owner (mike.testnet) or an authorized executor can
actually release. **The caller puts labels on orbit; the executor
retrieves them.** That asymmetry is the account-abstraction lever —
a smart account can let anyone stage calls that only the owner (or a
delegated MFA/automation service) decides when to execute.

## 5. Structural observations

### 5.1 IterableMap cross-caller swap-remove

`IterableMap` in near-sdk 5.x stores entries under `(prefix, u32_index)`
keys. `remove()` uses swap-remove: the removed entry's slot is
overwritten by the *last* entry, which may belong to any caller.

Concretely: at block 246229532 the map was

- idx 0 → `x.mike.testnet#alpha`
- idx 1 → `mike.testnet#alpha`
- idx 2 → `mike.testnet#beta`

Removing `x.mike.testnet#alpha` at idx 0 moved the last entry
(`mike.testnet#beta`, idx 2) into idx 0. The map became

- idx 0 → `mike.testnet#beta`
- idx 1 → `mike.testnet#alpha`

So `staged_calls_for(mike.testnet)` now returns `[beta, alpha]`
rather than `[alpha, beta]` — without `mike.testnet` ever performing
an action.

**Display-layer surprise, not a correctness bug.** The set of pending
labels is still right. Consumers of `staged_calls_for` must not rely
on stable iteration order across cross-caller operations; if order
matters (picking a default run order), the tool should sort by
`created_at_ms` or by label name.

### 5.2 Automation-run lifecycle records

Each automation run persists:

- which trigger launched it
- which sequence template it used
- which executor started it
- its namespace / run nonce
- final status: `Succeeded`, `DownstreamFailed`, or `ResumeFailed`

When a run finishes or fails, the automation metadata is updated and
`in_flight` is cleared on the trigger. For automation namespaces,
leftover staged entries are cleaned up so failed runs do not leak
state. (The telemetry-only subset of these fields is a Phase B trim
candidate — see `TELEMETRY-DESIGN.md`.)

## 6. Saga semantic, empirically closed

Combining evidence from the staged-call lineage archive and the
automation runs above:

| Claim | Evidence |
|---|---|
| Multi-action tx creates N independent yielded callbacks | latch POC (ch 02), staged-call lineage archive |
| `run_sequence` picks the wake-up order deterministically | ch 02, staged-call lineage archive |
| Downstream work executes in the declared order | staged-call lineage archive §1.1 |
| Contract-state time-series corroborates the receipt DAG | staged-call lineage archive §3 |
| Downstream failure halts the sequence cleanly | staged-call lineage archive §2 |
| Yield timeout auto-cleans unresolved labels | staged-call lineage archive §2 |
| Post-halt labels remain pending for retry | staged-call lineage archive §2 |
| Retry can pick any order, not just the original | staged-call lineage archive §2 |
| Mixed success/halt inside one `run_sequence` | staged-call lineage archive §2 |
| Cross-caller isolation | this archive §4.2 |
| Iteration order is not stable across cross-caller ops | this archive §5.1 |
| Positive dual-retry (no halt between) | this archive §4.2 |
| Balance-gated automation end-to-end | this archive §4.1 |
| Delegated-executor automation end-to-end | this archive §4.1 |

What remains substantively is either (a) contract changes (e.g.,
compensation hooks) or (b) a different surface (signed user-ops,
multi-account flows). The sequencer saga semantic itself is closed.

## 7. Current limits and honest caveats

- **Balance trigger only.** Current trigger model keys on the smart
  account's own native NEAR balance. No price oracles, external state,
  time windows, or hybrid guards yet.
- **Function-call templates only.** Automation templates currently use
  the function-call shape, not the richer action-set supported by
  `yield-sequencer` plans.
- **Authorized wakeup only.** The contract still needs an external tx
  to wake it up. Protocol constraint, not a design shortcoming.
- **Telemetry fields still in state.** Several `AutomationRun` and
  `BalanceTrigger.last_*` fields are pure operator-inspection data and
  should eventually move to structured events.
  `TELEMETRY-DESIGN.md` tracks this as Phase B, blocked on versioned-
  state migration discipline ([chapter 22](./22-state-break-investigation.md)).
- **Trace classification note.** Earlier `trace-tx.mjs` classified
  successful `execute_trigger` transactions as `PENDING` because the
  tree preserves `pending_yield` nodes even after resumed descendants
  complete. The helper was tightened to treat a yielded receipt as
  still pending only when it remains an unresolved leaf; current
  traces classify these runs as `FULL_SUCCESS` while still preserving
  the yield nodes in the rendered tree.

## 8. Relation to earlier vernacular

Historical path in this repo:
`latch → conduct → gated_call → stage_call → run_sequence`.

Current vocabulary:

- **sequence template** — durable intent shape
- **balance trigger** — eligibility rule
- **authorized executor** — authorized starter
- **execute trigger** — the admission call
- **staged call** — deferred downstream action

Protocol-level `yield` and `resume` still matter but sit underneath a
more legible smart-account surface. Historical terms inside this
archive and other archived chapters are preserved verbatim.

## 9. Recipes

Automation flow (owner-funded, router-backed demo):

```bash
./scripts/send-balance-trigger-router-demo.mjs --dry
./scripts/send-balance-trigger-router-demo.mjs \
  alpha:1 beta:2 gamma:3 \
  --owner-signer x.mike.testnet \
  --contract smart-account.x.mike.testnet \
  --router router.x.mike.testnet \
  --echo echo.x.mike.testnet
```

For delegated execution, call
`set_authorized_executor(Some("mike.testnet"))` first and pass
`--executor-signer mike.testnet`.

Cross-caller isolation experiment:

```bash
# two callers stage the same label at the same smart-account
./scripts/send-staged-echo-demo.mjs alpha:11 --signer x.mike.testnet \
  --method echo_log --action-gas 250 --call-gas 30 &
sleep 5
./scripts/send-staged-echo-demo.mjs alpha:1 beta:2 --signer mike.testnet \
  --method echo_log --action-gas 250 --call-gas 30 &
sleep 12

# verify isolation — each caller sees only its own entries
./scripts/state.mjs smart-account.x.mike.testnet \
  --method staged_calls_for --args '{"caller_id":"x.mike.testnet"}'
./scripts/state.mjs smart-account.x.mike.testnet \
  --method staged_calls_for --args '{"caller_id":"mike.testnet"}'

# owner drains x.mike.testnet's set
near call smart-account.x.mike.testnet run_sequence \
  '{"caller_id":"x.mike.testnet","order":["alpha"]}' --accountId mike.testnet

# then owner drains its own set, one label at a time
near call smart-account.x.mike.testnet run_sequence \
  '{"caller_id":"mike.testnet","order":["alpha"]}' --accountId mike.testnet
near call smart-account.x.mike.testnet run_sequence \
  '{"caller_id":"mike.testnet","order":["beta"]}' --accountId mike.testnet
```

All runs above were produced on the shared testnet rig; tables in §4
were generated by those commands in read-only passes against live
state.
