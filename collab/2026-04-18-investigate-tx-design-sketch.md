# 2026-04-18 · Investigate-tx wrapper — design sketch

*Design sketch for an observability convenience wrapper. Sharing for
feedback before implementation — please push back on anything that's
overcooked, undercooked, or wrong-shape.*

## BLUF

A single script — `scripts/investigate-tx.mjs` — that takes one tx hash
and produces a coherent three-surfaces report without the investigator
having to hand-run `trace-tx`, `block-window`, `state`, and
`account-history` in sequence. It composes the existing observability
primitives; it does not add new ones.

Every chapter in `md-CLAUDE-chapters/` from 04 onward walks the same
ritual: receipt DAG + block-pinned state time-series + account activity
feed. The ritual is ~4-6 commands per investigation, and the same
commands are re-typed by hand in every chapter. This wrapper turns that
ritual into `./scripts/investigate-tx.mjs <hash> <signer> [--view ...]`
with an opinionated output shape that matches how we structure chapter
sections.

## The ritual today

Concretely, for any cascade we want to understand, we currently run:

```bash
# 1. The receipt DAG
./scripts/trace-tx.mjs <hash> <signer> --wait FINAL

# 2. The state time-series at 3-5 interesting block heights
for b in <block_a> <block_b> <block_c>; do
  ./scripts/state.mjs <account> --method <view_method> \
    --args '{"...":"..."}' --block "$b"
done

# 3. Per-block receipts across the cascade window
for b in $(seq <start_block> <end_block>); do
  ./scripts/block-window.mjs --block "$b" --with-receipts
done

# 4. Account activity in the window
./scripts/account-history.mjs <signer> --limit 10
```

Then we copy-paste the outputs into a chapter's three-surfaces section.
The wrapper captures that shape directly.

## Proposed interface

```bash
./scripts/investigate-tx.mjs <tx_hash> <signer> \
  [--view <account>:<method>[:<args-json>]]... \
  [--accounts <id1,id2,...>] \
  [--extend-after <N>] \
  [--format markdown|json|both] \
  [--out <path>]
```

**Required:**
- `<tx_hash>` — the tx to investigate (typically the batch tx that
  staged the work; chapter 02's proof already showed that tracing the
  batch gives the full cascade)
- `<signer>` — matches `trace-tx.mjs`'s positional argument

**Optional:**
- `--view <account>:<method>[:<args-json>]` — a state view to snapshot
  at each interesting block. Repeatable. For chapter 13's setup:
  ```
  --view smart-account.x.mike.testnet:staged_calls_for:'{"caller_id":"x.mike.testnet"}' \
  --view wrap.testnet:ft_balance_of:'{"account_id":"smart-account.x.mike.testnet"}'
  ```
- `--accounts` — extra accounts whose `account-history` rows should be
  pulled for the cascade window. Default: just `<signer>`.
- `--extend-after` — extra blocks to walk past the last observed
  cascade receipt. Default: `2`. Useful for picking up trailing
  refunds.
- `--format` — `markdown` (default), `json`, or `both`. Markdown
  matches the chapter three-surfaces template; JSON is a
  regression-testable artifact.
- `--out` — output path. Default:
  `collab/artifacts/investigate-<short-hash>.md` (and `.json` sibling
  if `--format both`).

## Internal steps

1. **Walk the DAG.** Call the existing `trace-tx.mjs` logic (via
   `lib/trace-rpc.mjs`) with `--wait FINAL`. Extract from the returned
   tree:
   - tx summary: `{ finality, classification, gas_burnt }`
   - flat list of receipts: `{ receipt_id, block_height, predecessor,
     receiver, action_type, success, logs, result_bytes }`
   - derived cascade window: `[min_block, max_block + extend_after]`
     where `min_block` is the tx's included block and `max_block` is
     the highest block height among tracked receipts.

2. **Per-block receipts.** For each block in the cascade window, call
   `lib/fastnear.mjs`'s block-window RPC and keep the receipts that
   belong to our tx. This is the same filtering `block-window.mjs`
   already does.

3. **State snapshots.** For each `--view` spec, pick the "interesting"
   block heights (first block in window, each block where any cascade
   receipt fires, last block in window). Call the state RPC (same code
   path as `state.mjs`'s `--method` mode) at each of those blocks.

4. **Account activity.** For each account in `{signer} ∪ --accounts`,
   call `account-history.mjs`'s RPC with enough pagination to cover
   `max_block`. Filter to rows inside the cascade window.

5. **Log extraction.** From step 1's receipt list, pull the `logs`
   field of each receipt outcome. Sort by `(block_height, receipt
   order)`.

6. **Assemble report.** See output shape below.

All HTTP calls go through existing helpers — no new RPC surfaces, no
new endpoints.

## Output shape (markdown)

```markdown
# Investigate tx: <short-hash>

**Tx:** `<full-hash>`
**Signer:** `<account>`
**Receiver:** `<account>`
**Included at block:** `<height>`
**Classification:** `FULL_SUCCESS | PARTIAL_FAIL | PENDING`
**Gas burnt:** `<n>`
**Cascade window:** blocks `<min>` .. `<max>` (inclusive)

## Surface 1: Receipt DAG

<verbatim output of trace-tx.mjs's text renderer>

## Surface 2: State time-series

### `<account>.<method>(<args>)`

| Block | Value |
|-------|-------|
| <h>   | <result-bytes-decoded>  |
| ...   | ...                     |

(one table per --view spec)

## Surface 3: Per-block receipts

### Block <h>

| Receipt | From → To | Type | Success | Note |
|---------|-----------|------|---------|------|
| ...     | ...       | ...  | ...     | <log lines if any> |

(one table per block in window that has cascade receipts)

## Account activity

### <account>

| Block | Tx hash | Flags |
|-------|---------|-------|
| ...   | ...     | ...   |

(one table per account)

## Logs

| Block | Account | Log |
|-------|---------|-----|
| ...   | ...     | ... |

## Raw trace

<optional JSON dump of the full trace-tx response, for reference>
```

The JSON format would be the same payload as a structured object,
suitable for `jq` queries or regression diffing.

## Scope boundaries

**Does:**
- Compose existing observability scripts into one invocation
- Produce a chapter-ready markdown artifact
- Produce a regression-testable JSON artifact
- Handle the common cascade-investigation case (one tx hash →
  downstream effects)

**Does not:**
- Interpret or judge outcomes. It does not say "this failed because
  X"; it shows you the surfaces so *you* can say that in chapter
  commentary
- Suggest next steps or "fix" anything
- Require knowledge of specific contract schemas; `--view` specs are
  passed through opaquely
- Hit RPC harder than the component tools would (same endpoints, same
  batching behaviour)
- Handle multi-tx saga sagas (halt-then-retry across transactions,
  like chapter 06 or chapter 07). For those, either run the wrapper
  once per tx and assemble manually, or write a sibling
  `investigate-saga.mjs` later.
- Replace `trace-tx`, `state`, `block-window`, `account-history`. The
  component tools still exist and are still useful for quick,
  scoped queries. The wrapper is for the "produce a full report"
  use case.

## What it unlocks

1. **Chapter-writing becomes paste-and-annotate instead of hand-run-and-paste.**
   The wrapper emits the sections chapters already contain; the
   author adds commentary.
2. **Regression debugging:** "here's a tx hash that misbehaved, show
   me the surfaces" is one command. Saves ~5-30 minutes per
   investigation.
3. **Machine-readable artifacts:** the JSON shape becomes a regression
   target. A future smoke-test can assert "investigate this known-
   good tx hash, expect this JSON shape." Chapter-as-test.

## Open questions for Codex review

1. **Location.** `scripts/investigate-tx.mjs` or
   `scripts/investigate/tx.mjs`? If we plan sibling wrappers
   (`investigate-account`, `investigate-saga`, `investigate-trigger`),
   a subdir is cleaner. If this is one tool, a flat name is friendlier.

2. **`--view` spec shape.** Current proposal is colon-separated
   (`<account>:<method>:<args-json>`). Pros: fits one line. Cons:
   args-json with colons in it breaks the split. Alternative: accept
   JSON: `--view '{"account":"...","method":"...","args":{...}}'`.
   Verbose but unambiguous. Preference?

3. **Named view bundles.** Would per-scenario config files help?
   ```
   configs/views/smart-account-staged.json
   ```
   would bundle the standard views and let us invoke
   `investigate-tx.mjs <hash> <signer> --views-from smart-account-staged`.
   Adds indirection; may or may not pay off.

4. **Markdown template strictness.** Should we match the existing
   chapter-section format exactly (so output can be pasted straight
   into a chapter), or emit a looser "here are the surfaces" format
   that the author then shapes? Exact match is more useful in the
   short term; looser format is more robust as the chapter template
   evolves.

5. **JSON schema pinning.** Should the JSON output follow a versioned
   schema we commit to? The regression-test idea depends on this. If
   yes, now's the time to pin it; if later, the schema will drift and
   retrofitting regression tests becomes harder.

6. **`trace-tx --wait FINAL` can take 200 blocks (~100 s) when a
   yielded callback is still parked.** Should the wrapper expose
   `--wait EXECUTED | FINAL`? Default to which? Propose `FINAL` as
   default because it matches chapter practice, but surface the
   `EXECUTED` escape hatch for investigations that don't need full
   finality.

7. **Output directory.** `collab/artifacts/` feels right for generated
   investigation reports. Is there a gitignore posture we want (commit
   everything? commit markdown but ignore JSON? ignore all artifacts?)

## Minimal next step (if we say yes)

Write `scripts/investigate-tx.mjs` targeting just the happy path for
one tx hash with one `--view` spec. Skip saga support, skip named
bundles, skip `--format both`. Emit markdown to stdout. One chapter's
worth of investigation as the validation target. ~150-200 lines on the
same template as the other `scripts/*.mjs` helpers.

If that lands cleanly, grow from there: add `--format both`, add JSON
schema, add bundled views.

---

*Sketch prepared for Codex feedback. Happy to revise before any code is
written; particularly want input on questions 1, 3, and 5 above.*
