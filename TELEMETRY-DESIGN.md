# TELEMETRY-DESIGN.md

A design note for moving automation-run telemetry out of contract state
and into structured `env::log_str` events that we retrieve from FastNEAR
archival RPC and neardata. The goal is not to strip the contract of
useful data — the goal is to put the data where it belongs, in a place
where being data-rich does not cost us storage staking or schema
fragility.

This doc pairs with [`STATE-BREAK-INVESTIGATION.md`](./STATE-BREAK-INVESTIGATION.md).
That investigation showed that every field on `Contract` is a schema
commitment. This one shows how to keep future `Contract` shapes smaller
by default.

## Status (2026-04-18)

Phase A is now implemented:

- `contracts/smart-account/src/lib.rs` emits structured
  `EVENT_JSON:{...}` telemetry alongside the prose logs
- `scripts/lib/events.mjs` parses those NEP-297 events
- `scripts/aggregate-runs.mjs` walks account history and summarizes runs
- `scripts/investigate-tx.mjs` now surfaces those structured events beside
  the receipt DAG, state snapshots, and account-activity surfaces, including
  compact sequence telemetry metrics

Phase B remains deferred. The telemetry-only state fields still exist in
contract state, so the storage/schema simplification part of this design note
is still future work.

## 0. Motivation

On-chain state is expensive and schema-brittle. Receipt logs are cheap,
append-only, and already indexed by the NEAR tooling this repo uses.

Today, each automation run writes 9 fields into
`Contract.automation_runs` (one entry per `sequence_namespace`) and
mutates 5 telemetry fields on the matching `BalanceTrigger`. Most of
those fields are never read again by contract code — they exist so that
operators can call `get_automation_run` or `get_balance_trigger` and
inspect "what happened last time?" That is a reasonable goal, but it is
not a reason to put the data in state.

Moving pure-telemetry fields out of state lets us:

- lower storage-staking cost per trigger and per run
- reduce the number of fields we owe a migration to when we bump schema
  (the point made in `STATE-BREAK-INVESTIGATION.md` §3–§5)
- emit **richer** telemetry than state could afford — gas burned,
  attached deposit, promise-result size class, block timestamp — all of
  which are trivial in a log and expensive in an `IterableMap`

Receipt logs are retrievable from the FastNEAR archival RPC and the
neardata archive, both of which this repo already wires up in
`scripts/lib/fastnear.mjs` (lines 59–73). We do not need any new
infrastructure.

## 1. What's in the snapshot today

Sources: `contracts/smart-account/src/lib.rs`.

### `AutomationRun` (lines 152–162) — 9 fields

| Field | Type | Role |
|---|---|---|
| `trigger_id` | `String` | load-bearing — identifies the `BalanceTrigger` |
| `sequence_id` | `String` | load-bearing — identifies the template |
| `sequence_namespace` | `String` | load-bearing — state key, drives lifecycle |
| `run_nonce` | `u32` | load-bearing — distinguishes runs within a trigger |
| `status` | `AutomationRunStatus` | load-bearing — `finish_automation_run` reads it around line 1197 |
| `executor_id` | `AccountId` | telemetry-only |
| `started_at_ms` | `u64` | telemetry-only |
| `finished_at_ms` | `Option<u64>` | telemetry-only |
| `failed_step_id` | `Option<String>` | telemetry-only |

5 of 9 fields are load-bearing; 4 are pure metrics. Arguably the
load-bearing set could shrink further — the kernel really only needs to
answer "is this namespace in flight?" and "what run_nonce did we issue
for the current run?" — but this is the honest baseline split.

### `BalanceTrigger` (lines 166–178) — 11 fields

The core, all load-bearing:

| Field | Type | Role |
|---|---|---|
| `sequence_id` | `String` | load-bearing — names the template to run |
| `min_balance_yocto` | `u128` | load-bearing — firing gate |
| `max_runs` | `u32` | load-bearing — hard limit |
| `runs_started` | `u32` | load-bearing — counter vs `max_runs` |
| `in_flight` | `bool` | load-bearing — prevents concurrent runs (read around lines 651, 1208) |
| `created_at_ms` | `u64` | telemetry-but-static — one-time write, not per-run bloat |

The `last_*` mini-snapshot, all telemetry-only:

| Field | Type | Role |
|---|---|---|
| `last_executor_id` | `Option<AccountId>` | telemetry-only |
| `last_started_at_ms` | `Option<u64>` | telemetry-only |
| `last_finished_at_ms` | `Option<u64>` | telemetry-only |
| `last_run_namespace` | `Option<String>` | telemetry-only |
| `last_run_outcome` | `Option<AutomationRunStatus>` | telemetry-only |

None of the five `last_*` fields are ever read by contract code for any
behavior decision. They exist for operator inspection. Write sites:
`execute_trigger()` around lines 651–658, `finish_automation_run()`
around lines 1208–1212.

### `StagedCall` (lines 102–108) — 3 fields

| Field | Type | Role |
|---|---|---|
| `yield_id` | `YieldId` | load-bearing — identifies the yielded receipt |
| `call` | `SequenceCall` | load-bearing — the actual dispatch payload |
| `created_at_ms` | `u64` | telemetry-only |

### Current log footprint

The contract still emits human-readable prose logs, but it now also emits
paired structured `EVENT_JSON:{...}` lines for the sequencing and automation
lifecycle points described in §3. Programmatic consumers should use those
structured events rather than relying on the prose strings.

### FastNEAR retrieval already in place

The retrieval half of this design is mostly already built:

- `scripts/lib/trace-rpc.mjs:124` reads `outcome.logs` per receipt from
  `EXPERIMENTAL_tx_status`
- `scripts/lib/trace-rpc.mjs:173` preserves those logs through
  `flattenReceiptTree` so their receipt order survives flattening
- `scripts/lib/fastnear.mjs:59–60` wires up the testnet archival RPC
  (`archival-rpc.testnet.fastnear.com`), and line 62 exposes
  `testnet.neardata.xyz`
- `scripts/lib/fastnear.mjs:70–73` does the same for mainnet

Because the contract now emits `EVENT_JSON:{...}` logs, the existing
investigation pipeline already surfaces them alongside the prose logs.
The filtering/parsing helper also exists now in `scripts/lib/events.mjs`,
with `scripts/aggregate-runs.mjs` as the account-wide companion.

## 2. The NEP-297 event format

NEP-297 is the NEAR-ecosystem convention for structured log events. The
shape is:

```text
EVENT_JSON:{"standard":"<name>","version":"<semver>","event":"<event_name>","data":<object or array>}
```

The `EVENT_JSON:` prefix is all that indexers and consumers look for.
Anything after the colon is plain JSON with four required top-level keys.

For this repo, the right `standard` name is something clearly non-NEP
and scoped to this contract. Proposal: `"sa-automation"`. It tells a
reader the event came from the smart-account contract's automation
surface, and it will not collide with NEP-141/NEP-171/etc. in any
downstream aggregator.

Adopting NEP-297 has three concrete benefits for this repo:

1. The existing `outcome.logs` arrays on every receipt outcome already
   carry individual log lines as strings. Our trace pipeline surfaces
   them verbatim. A `EVENT_JSON:` prefix turns every such string into a
   parseable record with one `.startsWith()` check.
2. neardata and any other NEAR indexer will already treat these as
   first-class events if we ever want to query them outside our own
   scripts.
3. The `version` field gives us a clean way to evolve the event schema
   without breaking older consumers: bump the minor version when you
   add fields, bump the major version when you change meaning.

## 3. Event catalog (v1.1.0, as shipped)

One event per meaningful lifecycle point. Every event is self-describing:
a consumer should never need to cross-reference another event in the same
tx to interpret this one. The shipped v1.1.0 payloads are deliberately
richer than the v1.0.0 draft in the original design — see §4 for the
runtime envelope that every event carries.

| Event | Emitted at | Event-specific fields |
|---|---|---|
| `stage_call_registered` | `register_staged_yield_in_namespace` (line ~914 in lib.rs) | `step_id`, `namespace`, `staged_at_ms`, `resume_callback_gas_tgas`, `call` |
| `sequence_started` | `start_sequence_release_in_namespace` (~line 957) | `namespace`, `first_step_id`, `queued_count`, `total_steps`, `origin`, `automation_run?` |
| `step_resumed` | `on_stage_call_resume` `Ok` path (~line 305) | `step_id`, `namespace`, `staged_at_ms`, `resume_latency_ms`, `call` |
| `sequence_halted` (resume_failed) | `on_stage_call_resume` `Err` path (~line 325) | `namespace`, `failed_step_id`, `reason`, `error_kind`, `error_msg`, `staged_at_ms`, `halt_latency_ms`, `call` |
| `step_settled_ok` | `progress_sequence_after_successful_settlement` (~line 1182, 1207) | `step_id`, `namespace`, `result_bytes_len`, `next_step_id`, `staged_at_ms`, `settle_latency_ms`, `call` |
| `step_settled_err` | `on_stage_call_settled` `Err` path (~line 380) | `step_id`, `namespace`, `error_kind`, `error_msg`, `oversized_bytes?`, `staged_at_ms`, `settle_latency_ms`, `call` |
| `sequence_completed` | last step settled ok, queue empty (~line 1213) | `namespace`, `final_step_id`, `final_result_bytes_len` |
| `sequence_halted` (next resume failed) | `progress_sequence_after_successful_settlement` (~line 1196) | `namespace`, `failed_step_id`, `reason`, `error_kind`, `after_step_id`, `error_msg` |
| `assertion_checked` | `on_asserted_evaluate_postcheck` (match, mismatch, postcheck-fail) | `step_id`, `namespace`, `expected_bytes_len`, `actual_bytes_len`, `expected_return` (base64), `actual_return` (base64), `match`, `outcome`, `call` |
| `trigger_created` | `create_balance_trigger` (~line 570) | `trigger_id`, `sequence_id`, `min_balance_yocto`, `max_runs`, `created_at_ms`, `template_call_count`, `template_total_deposit_yocto` |
| `trigger_fired` | `execute_trigger` (~line 648) | `trigger_id`, `namespace`, `sequence_id`, `run_nonce`, `executor_id`, `started_at_ms`, `call_count`, `runs_started`, `max_runs`, `runs_remaining`, `min_balance_yocto`, `balance_yocto`, `required_balance_yocto`, `template_total_deposit_yocto`, `trigger_created_at_ms` |
| `run_finished` | `finish_automation_run` (~line 1243) | `trigger_id`, `namespace`, `sequence_id`, `run_nonce`, `executor_id`, `status`, `started_at_ms`, `finished_at_ms`, `duration_ms`, `failed_step_id?` |

### The `call` sub-object (shared by call-centric events)

Events that describe a single staged call (`stage_call_registered`,
`step_resumed`, `step_settled_ok`, `step_settled_err`, `sequence_halted`
on resume failure, `assertion_checked`) embed a `data.call` object with:

| Field | Notes |
|---|---|
| `target_id` | The target account id |
| `method` | The target method name |
| `args_bytes_len` | Byte length of the function-call args (not the bytes themselves) |
| `deposit_yocto` | String (yoctoNEAR is u128 — JSON would lose precision as a number) |
| `gas_tgas` | The caller-attached gas budget for the target call |
| `settle_policy` | `"direct"`, `"adapter"`, or `"asserted"` |
| `dispatch_summary` | The existing one-line prose summary, kept for humans |
| `adapter_id`, `adapter_method` | Present only when `settle_policy = "adapter"` |
| `assertion_id`, `assertion_method`, `assertion_gas_tgas` | Present only when `settle_policy = "asserted"`. Pointer-only fields; always present |
| `assertion_args_bytes_len`, `expected_return_bytes_len` | Asserted only; size footprint, always present |
| `assertion_args`, `expected_return` | Asserted only; **full base64 bytes**. Present **only** on `stage_call_registered` (the step's declaration of intent) and `assertion_checked` (the verdict, where the bytes explain the match/mismatch). Omitted from `step_resumed`, `step_settled_ok`, `step_settled_err`, and resume-failed `sequence_halted` to avoid duplicating large payloads across every event for the same step |

**Rationale for the light/heavy split.** An Asserted step can ship a
multi-kilobyte `expected_return`. Embedding it in every call-centric
event for that step would multiply log size 5–6× for no extra signal
— the bytes are identical across intermediate events. Consumers
needing the raw bytes cross-reference them from the `stage_call_registered`
event for the same `step_id` + `namespace`; intermediate events still
carry `assertion_id`/`assertion_method`/`assertion_gas_tgas` +
byte-length fields for filtering and size reasoning.

`error_kind` is a coarse enum used by aggregators to filter without
parsing the full `error_msg` string: `"downstream_failed"`,
`"result_oversized"`, `"resume_failed"`. For `result_oversized`,
`step_settled_err.oversized_bytes` carries the exact byte count from
`PromiseError::TooLong(size)`.

## 4. The runtime envelope — every event carries it

Every `sa-automation` event (v1.1.0+) carries a `data.runtime` object
with the host-observable state at emission time. This is the "ground
truth a replaying auditor can verify against archival" surface:

| Field | Source | Notes |
|---|---|---|
| `block_height` | `env::block_height()` | Block the receipt landed in |
| `block_timestamp_ms` | `env::block_timestamp_ms()` | Millisecond block timestamp |
| `epoch_height` | `env::epoch_height()` | Current epoch |
| `used_gas_tgas` | `env::used_gas().as_tgas()` | Gas consumed by this method so far |
| `prepaid_gas_tgas` | `env::prepaid_gas().as_tgas()` | Gas attached to this receipt |
| `attached_deposit_yocto` | `env::attached_deposit()` | String; 0 for internal callbacks |
| `account_balance_yocto` | `env::account_balance()` | Smart-account current balance, string |
| `account_locked_balance_yocto` | `env::account_locked_balance()` | Staked balance, string |
| `storage_usage` | `env::storage_usage()` | Total bytes this account is paying for |
| `predecessor_id` | `env::predecessor_account_id()` | Who called this receipt |
| `current_account_id` | `env::current_account_id()` | Smart-account id (self-identification) |
| `signer_id` | `env::signer_account_id()` | Original tx signer (survives cross-contract chains) |

Every one of these is a host-function call — a few million gas total
per event emission, trivially smaller than a single storage write. The
benefit is that a consumer reading a single `EVENT_JSON:` line has
enough context to reason about gas profile, balance, storage footprint,
and ordering without touching state at all. The line is verifiable by
anyone who can fetch the same tx from a FastNEAR archival RPC and
re-parse the receipt outcome.

### Per-event extras

On top of the runtime envelope and the `call` sub-object (where
applicable), individual events carry:

- Yield-resume latency — `step_resumed.resume_latency_ms` is the
  wall-clock delta between `stage_call_registered.staged_at_ms` and
  the block the resume callback landed in. Useful for detecting when
  the yield is close to its ~200-block timeout.
- Settle latency — `step_settled_ok.settle_latency_ms` /
  `step_settled_err.settle_latency_ms` is the same metric measured
  across the full stage → resume → downstream → settle path.
- Result size class — `step_settled_ok.result_bytes_len` and
  `step_settled_err.oversized_bytes` together cover the full space
  of callback-visible return shapes, including the
  `MAX_CALLBACK_RESULT_BYTES` cliff.
- Automation context on `sequence_started` — when a sequence starts
  under an `auto:*` namespace, the event embeds the full
  `automation_run` record (trigger_id, sequence_id, run_nonce,
  executor_id, started_at_ms) so a consumer does not need a second
  lookup.
- Balance accounting on `trigger_fired` — `balance_yocto` is what the
  account actually holds, `required_balance_yocto` is
  `max(min_balance_yocto, template_total_deposit_yocto)`, and
  `runs_started`/`max_runs`/`runs_remaining` describe the trigger's
  run budget after this firing.
- `duration_ms` on `run_finished` — derived from
  `finished_at_ms - started_at_ms`, included explicitly so aggregators
  do not have to compute it.

### Size discipline

A typical v1.1.0 event serializes to 700–900 bytes of JSON (runtime
envelope ~400 bytes + event-specific fields ~300–500 bytes). This is
well under the per-log-line practical ceiling. Events that can carry
variable payloads (`assertion_checked.expected_return`,
`stage_call_registered.call.args_bytes_len`) carry **byte counts**, not
the bytes themselves, except for `assertion_checked` where the
expected/actual return bytes are base64 and part of the verdict's
meaning.

## 5. Retrieval side — what FastNEAR already gives us

The existing trace pipeline produces everything we need except a
structured-event filter. Walking the pipeline:

1. `scripts/lib/fastnear.mjs:24` — `fetchTxStatus` calls
   `EXPERIMENTAL_tx_status` with an optional archival fallback.
2. `scripts/lib/trace-rpc.mjs:86` — `buildTree` turns the RPC result
   into a receipt tree.
3. `scripts/lib/trace-rpc.mjs:124` — that tree carries
   `receipts_outcome[].outcome.logs` at each node.
4. `scripts/lib/trace-rpc.mjs:153–173` — `flattenReceiptTree` flattens
   the tree to an array while preserving per-receipt logs in order.
5. `scripts/lib/trace-rpc.mjs:253` — `materializeFlattenedReceipts`
   joins each receipt to its block metadata (height, hash, timestamp,
   receipt ordinal).

The missing piece is a small helper like:

```js
// scripts/lib/events.mjs (sketch, ~20 lines)
export function parseStructuredEvents(flattenedReceipts) {
  const events = [];
  for (const r of flattenedReceipts) {
    for (const line of r.logs || []) {
      if (!line.startsWith("EVENT_JSON:")) continue;
      try {
        const body = JSON.parse(line.slice("EVENT_JSON:".length));
        events.push({
          receiptId: r.receiptId,
          receiptIndex: r.receiptIndex,
          blockHeight: r.blockHeight,
          blockTimestamp: r.blockTimestamp,
          ...body,
        });
      } catch {
        // non-JSON logs are fine — ignore
      }
    }
  }
  return events;
}
```

With that helper in place, two consumer shapes are now real:

- a per-tx structured-event view that `investigate-tx.mjs` can
  optionally print alongside its existing three surfaces
- a per-account aggregator (`scripts/aggregate-runs.mjs`) that walks
  `fetchAccountHistory(network, smartAccountId)` page by page, passes
  each tx through the same parser, and writes a single local JSON of
  every automation event that ever touched that account

Neither script needs anything more than what FastNEAR already exposes.
The aggregator is the operator-facing "give me everything this account
has ever done" tool that state currently pretends to be but is not.

## 6. Rollout in three phases

### Phase A — additive events, no state change (completed)

The safe, pure-win tranche:

- add NEP-297 `EVENT_JSON:` emissions at the sequencing/automation lifecycle
  points
- keep the prose `env::log_str` lines alongside the structured events so
  human-readable traces still work
- add `scripts/lib/events.mjs` with `parseStructuredEvents`
- add `scripts/aggregate-runs.mjs` walking `fetchAccountHistory`
- surface structured events directly in `scripts/investigate-tx.mjs`

This tranche does not change `Contract` state. It does not need a
migration. It is reversible (delete the new emission lines). It is the
right place to start because it establishes the retrieval and
aggregation path independently of any state-shape change.

### Phase B — trim telemetry-only state (schema-breaking)

Once Phase A is in production and we trust the events+aggregator path:

- remove the five `BalanceTrigger.last_*` fields
- remove the four telemetry-only `AutomationRun` fields
  (`executor_id`, `started_at_ms`, `finished_at_ms`, `failed_step_id`)
- consider removing `AutomationRun` entirely — `BalanceTrigger.in_flight`
  may be sufficient for kernel correctness, and run-level telemetry
  now lives in logs

This tranche **is a schema change** and must be treated as one.
`STATE-BREAK-INVESTIGATION.md` §5 and §7 describe the pattern: wrap
`Contract` in a versioned enum (`VersionedContract::{V1, V2}`), ship a
`#[init(ignore_state)]` migration function, and redeploy with
`--initFunction migrate`. Do not skip this. Removing a field is no
different from adding one — borsh reads the bytes strictly in the
declared order.

`deploy-testnet.sh`'s delete-and-recreate ritual is fine for Phase B on
ephemeral subaccounts like `sa-probe` and `sa-asserted`, because they
can be rebuilt from scratch. It is the wrong ritual for mainnet, and
the same is true for any shared rig that has real live sequences in
flight.

### Phase C — richer events, additive

Once Phase A's event schema is validated and Phase B has simplified the
state shape, extend events with the §4 enrichment fields. Bump the
`version` to `"1.1.0"`. Because the fields are additive, older consumers
still parse the events correctly; newer consumers get the extra signal.

## 7. Tradeoffs and risks

- **Log retention is not infinite.** A regular RPC node prunes logs
  aggressively. Archival RPC (`archival-rpc.testnet.fastnear.com`) and
  neardata retain much longer but are not a promise. Treat logs as
  authoritative for fresh queries (minutes to weeks), and harvest them
  into checked-in JSON artifacts under `collab/artifacts/` for anything
  you want to cite in a write-up months later. The aggregator script
  in Phase A is exactly the mechanism for that harvest.
- **Per-log byte budget.** NEAR bounds each log emission; in practice,
  keep events under ~1 KB of JSON. If an event grows past that, split
  it or drop enrichment fields.
- **Log order across receipts is not timestamp order.** Logs within a
  single receipt are ordered as emitted; across receipts, the
  authoritative order is the receipt DAG produced by
  `flattenReceiptTree`, not `block_timestamp()`. Aggregators that sort
  on timestamp will misorder fast-fanout traces. Sort by
  `(blockHeight, receiptIndex)` instead.
- **Events are not atomic with state transitions.** `env::log_str`
  emits against the current receipt; if that receipt panics after the
  log, the log is still recorded. This is acceptable for telemetry but
  not for anything a consumer might treat as authoritative truth about
  state. Do not emit an event whose presence would imply a state
  change the contract has not actually committed.
- **Event schema evolution.** NEP-297's `version` field is the
  contract between emitter and consumer. Rules: never rename a payload
  field; only add. If a field's semantics must change, add a new
  field and deprecate the old one across one minor version.
- **Removing state fields is a schema change.** This one is worth
  repeating because it is the single most important consequence of
  this design: a Phase B cleanup is not a free move. It requires the
  migration discipline from `STATE-BREAK-INVESTIGATION.md`. Skipping
  that step is how we got the broken
  `smart-account.x.mike.testnet` account in the first place.

## 8. Recommendation

Phase A is done. It delivered the immediate operator value this design note
was aiming for: structured events are now visible in both `investigate-tx`
and the account-wide aggregator without waiting on any schema change.

Defer Phase B until the versioned-state enum wrapper is in place.
That is pre-mainnet-readiness work anyway, so pairing the two makes
sense: if we are going to redeploy with a migration, we should do a
worthwhile migration.

Defer Phase C indefinitely; it is pure upside whenever we want more
signal.

## 9. References and evidence

Inline pointers for anything asserted above:

- `contracts/smart-account/src/lib.rs:102–108` — `StagedCall`
- `contracts/smart-account/src/lib.rs:141–148` — `AutomationRunStatus`
- `contracts/smart-account/src/lib.rs:152–162` — `AutomationRun`
- `contracts/smart-account/src/lib.rs:166–178` — `BalanceTrigger`
- `contracts/smart-account/src/lib.rs:207–217` — `Contract` state shape
- `contracts/smart-account/src/lib.rs:651–673` — `execute_trigger`
  snapshot writes (initial run creation + trigger state update)
- `contracts/smart-account/src/lib.rs:1197–1212` —
  `finish_automation_run` writes (run close + trigger final state)
- `contracts/smart-account/src/lib.rs:295–318, 362–365, 443–445,
  639–641, 900–902, 945–947, 1144–1161` — 11 existing `env::log_str`
  emissions
- `scripts/lib/trace-rpc.mjs:124` — `outcome.logs` per receipt
- `scripts/lib/trace-rpc.mjs:173` — log preservation through flatten
- `scripts/lib/fastnear.mjs:59–73` — archival RPC + neardata endpoints
- `STATE-BREAK-INVESTIGATION.md` §3 — four classes of schema break
- `STATE-BREAK-INVESTIGATION.md` §5 — avoidance patterns, versioned
  enum, migration functions
- `STATE-BREAK-INVESTIGATION.md` §7 — mainnet-readiness implications

## 10. TL;DR

- Of the 9 `AutomationRun` fields, 4 are pure telemetry.
- Of the 11 `BalanceTrigger` fields, 5 are the `last_*` mini-snapshot
  and are pure telemetry. All five are never read by contract code.
- `StagedCall.created_at_ms` is pure telemetry.
- Structured `EVENT_JSON:` events now exist alongside the prose logs.
- FastNEAR already surfaces every receipt's logs and already has
  archival + neardata endpoints wired up in
  `scripts/lib/fastnear.mjs`.
- Phase A (add NEP-297 `EVENT_JSON:` emissions + parser helper +
  aggregator) is complete and remains a pure additive win with no schema
  change.
- Phase B (remove the telemetry-only state fields) is a schema change
  and must use the versioned-enum + migration discipline from
  `STATE-BREAK-INVESTIGATION.md`.
- Phase C (richer event payloads) is additive and can land any time.
