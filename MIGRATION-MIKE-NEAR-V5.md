# Migration — `mike.near` v4 → v5

Mainnet cutover plan for `mike.near` from the standalone v4 sequencer
(`v4.0.2-ops`) to the v5 split: thin authorizer on `mike.near` + sequencer on
`sequential-intents.x.mike.near` (or equivalent subaccount). Drafted 2026-04-19, after the v5 shape landed testnet-green.

Companion reading: [`ARCHITECTURE-V5-SPLIT.md`](./ARCHITECTURE-V5-SPLIT.md)
for the architecture itself; this doc is the operational cutover.

## Target end state

- `mike.near`: authorizer contract (`authorizer-v5.0.0`), `owner_id
  = mike.near`, `extensions = [sequential-intents.x.mike.near]`.
- `sequential-intents.x.mike.near`: v5 smart-account sequencer
  (`v5.0.0-split`), `owner_id = mike.near`, `authorizer_id = mike.near`.
- `mike.near`'s `intents.near` balance (~0.445 wNEAR from the
  reference runs) remains on the intents ledger under `mike.near`;
  future v5 flagships consume it as-is.
- Prior four reference artifacts in `collab/artifacts/reference/`
  retain block-hash anchors for historical verification — they
  prove what v4 did, not what v5 will do.

## Non-goals (deferred)

- **Carrying v4 state forward.** Active session grants, saved
  templates, balance triggers, and automation-run rows all drain
  during Phase 1. Keeping them would require a schema-aware
  migrator between two structurally-different contracts (sequencer vs
  authorizer) — not worth the scope vs a clean cutover.
- **Preserving v4 session-key dapps.** Any session key on
  `mike.near` with `receiver = mike.near, method = "execute_trigger"`
  (v4 shape) becomes inert after cutover — `execute_trigger` moves
  to the extension. Dapps rotate to v5 session keys
  (`receiver = extension, method = "execute_trigger"`).
- **Retiring `sequential-intents.mike.near` (v3).** Standalone mode
  continues to function; v3 can stay as-is indefinitely. Not urgent.
- **Multi-extension setup at cutover.** Arm one extension to start.
  Adding more (trading bot, DAO proxy, alpha sequencer) is a
  post-cutover operation.

## Phase order

1. **Phase 0** — pre-flight (docs + wasm + one code addition).
2. **Phase 1** — drain v4 state on `mike.near`.
3. **Phase 2** — deploy authorizer at `mike.near` + extension at subaccount, wire.
4. **Phase 3** — validate on mainnet (one flagship end-to-end + disarm/re-arm).
5. **Phase 4** — update docs, reference artifacts, verification scripts.

All phases require explicit user sign-off before starting. Phase 2
is the point of no return for the v4 sequencer state.

## Phase 0 — pre-flight

**One code change required.** Authorizer currently offers `new`,
`new_with_owner`, and `migrate()`. None of those can cleanly
overwrite an existing account with v4-sequencer state (`migrate()`
reads `Authorizer` shape, fails on v4 `Contract` shape; `new_*` init
methods panic when state already exists).

Add a one-shot migration entry to the authorizer:

```rust
/// Migration entry: overwrite any prior state with a fresh Authorizer.
/// Used ONCE during v4→v5 cutover on an existing-state account.
/// Restricted via `expected_prior_owner` to prevent drive-by replacement.
#[init(ignore_state)]
pub fn migrate_from_sequencer(
    owner_id: AccountId,
    expected_prior_owner: AccountId,
) -> Self {
    assert_eq!(
        env::predecessor_account_id(), expected_prior_owner,
        "migrate_from_sequencer: caller must be the prior sequencer's owner"
    );
    Self {
        owner_id,
        extensions: IterableSet::new(StorageKey::Extensions),
    }
}
```

Testnet rehearsal before mainnet:

1. Deploy v4 sequencer to throwaway subaccount, populate with sessions +
   triggers (one of each).
2. Run the Phase 1 drain steps against it; verify all view methods
   return empty.
3. Deploy authorizer wasm over it with
   `--initFunction migrate_from_sequencer`; verify contract_version is
   `authorizer-v5.0.0`, extensions is empty.
4. Wire to a fresh extension subaccount + run a one-step flagship.
5. Commit that tranche + new unit tests for `migrate_from_sequencer`.

Also:

- Reproducible-build: rebuild authorizer + smart-account wasm under
  pinned toolchain; record sha256 + base58 in
  [`REPRODUCIBLE-BUILD.md`](./REPRODUCIBLE-BUILD.md).
- Snapshot `mike.near`'s live v4 state via view RPC. Save to
  `collab/artifacts/migration/mike-near-v4-predrain-snapshot.json`:
  `list_active_sessions`, `list_sequence_templates`,
  `list_balance_triggers`, `automation_runs_count`,
  `contract_version`. Use for rollback sanity-check.
- Save the current v4 wasm locally as
  `res/smart_account_v4.0.2-ops.wasm` for rollback.

## Phase 1 — drain v4 state on `mike.near`

Each step is a mainnet tx signed by `mike.near` (the v4 owner). Run
serially.

1. **Revoke active sessions.** For each `pk` returned by
   `list_active_sessions`:
   ```bash
   near call mike.near revoke_session \
     '{"session_public_key":"<pk>"}' \
     --accountId mike.near
   ```
   Each tx returns a `delete_key` Promise that atomically removes
   both the grant metadata and the AccessKey.

2. **Delete balance triggers.** For each `trigger_id` in
   `list_balance_triggers`:
   ```bash
   near call mike.near delete_balance_trigger \
     '{"trigger_id":"<trigger_id>"}' \
     --accountId mike.near
   ```

3. **Delete sequence templates.** For each `sequence_id` in
   `list_sequence_templates`:
   ```bash
   near call mike.near delete_sequence_template \
     '{"sequence_id":"<sequence_id>"}' \
     --accountId mike.near
   ```

4. **Prune finished automation runs.**
   ```bash
   near call mike.near prune_finished_automation_runs '{}' \
     --accountId mike.near
   ```

5. **Verify empty.** All four view methods return empty; no in-flight
   runs.
   ```bash
   near view mike.near list_active_sessions '{}'
   near view mike.near list_balance_triggers '{}'
   near view mike.near list_sequence_templates '{}'
   near view mike.near automation_runs_count '{}'
   ```

Pre-existing `registered_steps` entries from partially-completed
sequences would block cleanup; they're expected to be empty on a
quiescent `mike.near` since the reference runs all completed. If
any remain, resolve or drop manually before Phase 2.

## Phase 2 — deploy v5 pair and wire

1. **Deploy authorizer AT `mike.near`.** This overwrites the v4
   sequencer contract with the authorizer, calling `migrate_from_sequencer`
   to cleanly replace state.
   ```bash
   near deploy mike.near res/authorizer_local.wasm \
     --initFunction migrate_from_sequencer \
     --initArgs '{"owner_id":"mike.near","expected_prior_owner":"mike.near"}' \
     --accountId mike.near
   ```
   Verify:
   ```bash
   near view mike.near contract_version '{}'   # → "authorizer-v5.0.0"
   near view mike.near list_extensions '{}'    # → []
   ```

2. **Create extension subaccount.**
   ```bash
   near create-account sequential-intents.x.mike.near \
     --masterAccount mike.near --initialBalance 10
   ```

3. **Deploy v5 extension sequencer there, paired with `mike.near`.**
   ```bash
   near deploy sequential-intents.x.mike.near res/smart_account_local.wasm \
     --initFunction new_with_owner_and_authorizer \
     --initArgs '{"owner_id":"mike.near","authorizer_id":"mike.near"}' \
     --accountId mike.near
   ```
   Verify:
   ```bash
   near view sequential-intents.x.mike.near contract_version '{}'
   near view sequential-intents.x.mike.near get_authorizer '{}'
   ```

4. **Arm the extension.**
   ```bash
   near call mike.near add_extension \
     '{"account_id":"sequential-intents.x.mike.near"}' \
     --accountId mike.near
   ```
   Verify:
   ```bash
   near view mike.near list_extensions '{}'
   # → ["sequential-intents.x.mike.near"]
   ```

## Phase 3 — validate v5 on mainnet

1. Run one canonical flagship through the v5 pair. Start with
   `limit-order.mjs` (lowest deposit, PreGate-only):
   ```bash
   NETWORK=mainnet ./examples/limit-order.mjs \
     --signer mike.near \
     --smart-account sequential-intents.x.mike.near \
     ...
   ```

2. Inspect the tx via
   [`scripts/investigate-tx.mjs`](./scripts/investigate-tx.mjs).
   Expected receipt chain for each Direct step:
   `user → extension → authorizer → target → on_step_resolved`
   (four-receipt chain; the authorizer hop is observable).
   `step_resolved_ok` emits from the extension's account.

3. Capture the v5 reference artifact:
   `collab/artifacts/reference/mike-near-v5.0.0-limit-order.json`.

4. Exercise the kill switch live, once:
   ```bash
   near call mike.near remove_extension \
     '{"account_id":"sequential-intents.x.mike.near"}' \
     --accountId mike.near
   # Re-run flagship; expect clean panic at authorizer
   near call mike.near add_extension \
     '{"account_id":"sequential-intents.x.mike.near"}' \
     --accountId mike.near
   # Re-run flagship; expect success
   ```
   Record the three tx hashes + halt/resume diff in a new journal
   section.

## Phase 4 — documentation + reference artifacts

1. **Mark v4 artifacts as historical** in
   [`MAINNET-PROOF.md`](./MAINNET-PROOF.md): note the cutover date
   and clarify that the four `mike-near-v4.0.2-*` artifacts anchor
   what v4 did on `mike.near` — all blocks still resolvable via
   archival RPC, but live-view of current contract no longer matches.
2. **Add v5 reference artifact** to `MAINNET-PROOF.md` alongside a
   new Recipe section for verifying the v5 hop chain.
3. **Update `QUICK-VERIFY.md`** to describe v5 verification (four
   curls still plausible; event names unchanged; `code_hash` of
   `mike.near` now pins the authorizer, not the sequencer).
4. **Update `scripts/verify-mainnet-claims.sh`** to check the v5
   artifact instead of the v4 one. Keep the v4 check-path callable
   via a flag for archival continuity.
5. **Update `CLAUDE.md`** Mainnet Lab Rig section: `mike.near` is
   now authorizer; `sequential-intents.x.mike.near` is the live
   extension; previous v4 entry moves to "historical."
6. **Update `README.md`**'s "Validated on mainnet" section with the
   new topology.
7. **New deploy recipe**: [`DEPLOY-V5.md`](./DEPLOY-V5.md) captures
   the authorizer + extension deploy sequence for future users
   (testnet + mainnet). Archive the old
   [`DEPLOY-MIKE-NEAR.md`](./DEPLOY-MIKE-NEAR.md) as v4-specific.
8. **Archive this plan** — move to
   `collab/history/MIGRATION-MIKE-NEAR-V5-<YYYY-MM-DD>.md` once
   executed.

## Rollback

If Phase 3 surfaces a blocker, rollback to v4 is possible but
lossy (v4 state is already drained in Phase 1):

1. Redeploy v4 wasm over `mike.near`:
   ```bash
   near deploy mike.near res/smart_account_v4.0.2-ops.wasm \
     --initFunction migrate \
     --accountId mike.near
   ```
   `migrate()` will find no prior Contract state (drained),
   initial state construction needs `new_with_owner` instead — use
   `--initFunction new_with_owner --initArgs
   '{"owner_id":"mike.near"}'`.

2. Delete `sequential-intents.x.mike.near` if the subaccount fits
   under the `DeleteAccountWithLargeState` threshold (it should,
   it's fresh).

3. Recapture any drained state that's still needed by re-running
   the flagships that populated it.

This is a **fresh-state rollback**, not a point-in-time restore.
Reference artifact block-hash anchors stay valid regardless —
they're immutable on-chain history.

## Go/no-go checklist

Before running Phase 2:

- [ ] Phase 0 code change landed: `migrate_from_sequencer` on
      authorizer, with unit tests.
- [ ] Testnet rehearsal of full Phase 1 → Phase 3 cycle completed
      against a throwaway subaccount seeded with v4 state.
- [ ] Reproducible-build hashes for both wasm committed.
- [ ] V4 wasm saved locally as rollback artifact.
- [ ] `mike.near` v4 state snapshot captured to
      `collab/artifacts/migration/`.
- [ ] All four reference artifact verifications still pass against
      current mainnet (sanity: cutover hasn't happened yet).
- [ ] New docs ready in draft form (Phase 4 content pre-composed).
- [ ] User explicit sign-off to proceed.

## Risks

- **`migrate_from_sequencer` is a new, load-bearing code path.** First
  real use is on `mike.near`. Testnet rehearsal is mandatory before
  mainnet. The guard (`expected_prior_owner` check) prevents a
  hostile account from triggering the migration, but can't prevent
  an owner-side mistake (wrong wasm, wrong args). Double-check
  init args before signing.
- **Gas budget on the extra hop.** Every v5 target dispatch has one
  more receipt than v4. Current operator baseline for mainnet
  multi-step probes is 300 TGas per outer action; the authorizer
  hop adds ~10 TGas overhead. Comfortable at 300 TGas; calibrate
  against testnet if new flagships push the gas envelope.
- **Session-key dapp dead-key hazard.** Any third party holding a v4
  session key pointing at `mike.near.execute_trigger` silently
  becomes inert after cutover. If there are live dapps in that
  state, coordinate rotation windows.
- **Path of no return at Phase 2.** After authorizer deploys over
  `mike.near`, the v4 sequencer binary is gone. Rollback requires
  re-deploying v4 and accepts fresh state (no restore). Treat
  Phase 2 as a commit gate.
- **FastNEAR archival retention for v4 reference artifacts.**
  Already flagged elsewhere; cutover doesn't introduce new
  retention risk, but does make the historical-verification claim
  more operationally important. Reasonable to capture curl
  transcripts now while archival is fresh.

## Timeline (tentative)

Not dated — gating is review, not calendar:

1. Land Phase 0 code (authorizer `migrate_from_sequencer` + tests) as
   its own PR/commit. Review + merge.
2. Testnet rehearsal of full cycle. Review the test tx log.
3. Snapshot + drain Phase 1 (single PR's worth of tooling + one
   mainnet session executing the drain). Verify.
4. Phase 2 in a single deliberate sitting — fresh terminal, saved
   rollback wasm, explicit user sign-off inline. Record tx hashes
   in real time.
5. Phase 3 validation: run flagship, capture artifact, run
   disarm/re-arm once.
6. Phase 4 doc sweep as a follow-up PR.

The whole sequence is a weekend's focused work *after* Phase 0 is
merged. The commit gate is Phase 2.
