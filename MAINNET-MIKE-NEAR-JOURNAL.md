# Mainnet `mike.near` journal (v4 kernel)

Every on-chain transaction landed on `mike.near` after the v4 smart-
account kernel deploy, with block heights for archival lookup.
Mirror of [`MAINNET-V3-JOURNAL.md`](./MAINNET-V3-JOURNAL.md) pattern;
matches [`DEPLOY-MIKE-NEAR.md`](./DEPLOY-MIKE-NEAR.md) recipe.

## Phase 1 — sa-v4 lab (2026-04-19)

Lab deployment on a fresh subaccount before touching `mike.near`
itself. All three new primitives validated at mainnet stakes.

| Label | Tx hash | Block | Outcome |
|---|---|---|---|
| sa-v4 create (mike.near master, 6 NEAR) | `9Wn4zbgApku47nuH971sxkYqQTfTzUTk14TrSfm1rr8w` | 194701… | ✓ |
| sa-v4 deploy+init (new_with_owner, `mike.near` owner) | `445RYzLKbAKpUqsJFPBZZuhYM8ZHnNYJsDwRebdmBYyR` | 194701… | `contract_version = v4.0.0-pregate` |
| probe-v4 create (mike.near master, 2 NEAR) | `Cknh1VzTcBNRep7WLq32P7NrCM9577cFDwpVQZZv3koE` | 194701… | ✓ |
| probe-v4 deploy (pathological-router wasm) | `Ctdecum4CDAAWPo7ntQ4GhCneKhvfgpSQG52BBA2bhna` | 194701… | `get_calls_completed = 0` |
| sa-v4 create_balance_trigger `session-trigger` | `AEKs9JGkZnEw6XetKqRSxW9K2eqzQwA8vzvtqmKJ9Neh` | 194702… | `trigger_created` event |
| T1 limit-order (in_range → dispatch) | `Ce1ym3nb7ZG8soVJR3XjoGoJNCb5vc9zh1f2cX1CQd2U` | 194702127 | `pre_gate_checked.matched=true` |
| T2 ladder-swap (counter 1→3, last_burst="1") | `EB1m3PmdBZR6jM3Py2ssfAKsYSttbnkwu6mzmLmFqGt5` | 194702161 | `result_saved.as_name=counter` |
| T3 session-dapp enroll (1 yocto) | `Fyo3YpXemgmqFi9nJSMFSvXE42k3xW4EQRFBxc5gUqho` | 194702288 | `session_enrolled` event |
| T3 session-dapp revoke | `7kYVkvQYyVbyTDyJwtUteQqikVEG4bEAB3Xeyt9MifX4` | 194702321 | `session_revoked.reason=explicit` |

Artifact snapshots:

- `collab/artifacts/sa-v4-mainnet-limit-order-20260419.json`
- `collab/artifacts/sa-v4-mainnet-ladder-swap-20260419.json`
- `collab/artifacts/sa-v4-mainnet-session-dapp-20260419.json`

## Phase 2 — `mike.near` identity deploy (2026-04-19)

v4 kernel deployed over `mike.near` itself. Zero prior contract
state (code_hash was `1111…111`); `new_with_owner({owner_id:"mike.near"})`
initialized cleanly against the ~25 KB of pre-existing access-key
bookkeeping.

| Label | Tx hash | Block | Outcome |
|---|---|---|---|
| mike.near deploy+init (new_with_owner) | `LzeekowY3vtiXrVMnfsVUfbp8wLDegh2d4SspmXBjj9` | 194702… | `contract_version = v4.0.0-pregate` |

### Primitive smoke-tests against `mike.near`

All three flagships re-run with `--smart-account mike.near`. Same
probe contract (`probe-v4.mike.near`), same CLI shapes.

| Primitive | Tx hash | Block | Event summary |
|---|---|---|---|
| T1 PreGate (limit-order) | `GV5imXfx9TPqk7yX6rwQSpcck2AY9gMCE6zYxzHvxrD5` | 194702969 | `pre_gate_checked.outcome=in_range` (gate bytes "12", max 1000); `sequence_completed` |
| T2 value threading (ladder-swap) | `EjQwStfZkce4Nr8yp2hEXduNchyzY6z6jEGMdHxkKA29` | 194702990 | counter 13→15; `result_saved.kind=u128_json`; last_burst="7" (5000bps of 14) |
| T3 session keys (session-dapp) revoke | `D7Eyf4qWQqFgyLU1srQDJ3UapYxNEx8dKWMoQQmxXGs` | 194703316 | 3 fires landed; `session_revoked.reason=explicit`; post-revoke fire rejected by NEAR runtime |

Template + trigger setup (pre-req for T3 smoke-test):

| Label | Tx hash |
|---|---|
| `save_sequence_template("session-probe", …)` | (embedded in the trigger-create tx above) |
| `create_balance_trigger("session-trigger", …)` | in T3 block range |

Hygiene: one stale session from an aborted first session-dapp run
cleaned up via `revoke_expired_sessions()`:

- `AurZcbqAvJ9PFopriTjrLMQDqSr1ivpvRxmYA7sp6idK` — removed the
  exhausted-but-unrevoked grant that a prior bug in `session-dapp.mjs`
  left behind (fire_count hit cap before the keystore-slot collision
  blocked revoke). The public `revoke_expired_sessions()` method
  (anyone can call) removes any grant whose `fire_count >= max_fire_count`
  even before expiry.

Artifact snapshots:

- `collab/artifacts/mike-near-mainnet-limit-order-20260419.json`
- `collab/artifacts/mike-near-mainnet-ladder-swap-20260419.json`
- `collab/artifacts/mike-near-mainnet-session-dapp-20260419.json`

## Key public surface (current)

After Phase 2, `mike.near` exposes the v4 smart-account surface:

- `execute_steps(steps)` — user-sequenced cross-contract plans
  (`Direct` / `Adapter` / `Asserted` × `PreGate` × value threading)
- `save_sequence_template` / `create_balance_trigger` /
  `execute_trigger` — owner-driven automation
- `enroll_session` / `revoke_session` / `revoke_expired_sessions` /
  `get_session` / `list_active_sessions` / `list_all_sessions` —
  session-key delegation
- `contract_version` / `migrate` — schema hygiene (migrate is
  `#[init(ignore_state)]`, idempotent)

Auth model on `mike.near`:

- `owner_id = mike.near` — the account owns itself. Owner-gated
  methods require signer = mike.near's FAK (one of 7 currently
  registered).
- `authorized_executor = null` — owner handles all authorized calls
  (no separate executor delegate).
- Session grants — dynamic FCAKs minted via `enroll_session`;
  each one enforced in `execute_trigger` top-check.

## Phase 3 — `v4.0.2-ops` migrate redeploy (2026-04-19)

Second deployment of the v4 kernel, landing two tranches bundled
together via `#[init(ignore_state)]` migrate:

- **prune tranche** (from the state-health audit): new public
  `prune_finished_automation_runs()` hygiene method closes the one
  monotonic-growth vector in contract state. Emits
  `automation_runs_pruned` NEP-297 event.
- **ops tranche** (retrospective inspection): new views
  `list_automation_runs(from_index, limit)` (paginated, capped at
  100), `get_automation_run(namespace)`, `automation_runs_count()`.
  New JSON-facing `AutomationRunView` carries the sequence
  namespace alongside stored fields plus a computed `duration_ms`.

### Phase 3a — `sa-v4.mike.near` lab migrate

| Label | Tx hash | Notes |
|---|---|---|
| migrate to v4.0.2-ops | `DLxLRLBmE1oNgsT5h4wMP5bGCG1NYjbWL332Fho4r5JA` | log: `migrate: read state for owner=mike.near, 0 registered steps, 1 templates` |
| `list_automation_runs(0, 10)` | (view, no tx) | 6 terminal `Succeeded` rows from Phase 1 + drive-by runs |
| `prune_finished_automation_runs()` | `CwP6BmvWHQtLPrBTKx5VGzbtHvShpEpREwVXxDmPtwrE` | pruned_count=6; `automation_runs_count = 0` after |

### Phase 3b — `mike.near` identity migrate

| Label | Tx hash | Notes |
|---|---|---|
| migrate to v4.0.2-ops | `7vpsQcvgGkFiRzZbGsngj8DXAFK5xi9dRQFzci1URqe1` | log: `migrate: read state for owner=mike.near, 0 registered steps, 1 templates` |
| `list_automation_runs(0, 10)` | (view, no tx) | 6 terminal `Succeeded` rows from Phase 2 + drive-by runs |
| `prune_finished_automation_runs()` | `ELyR6RWSpMGEcZz2vNVMWpjsV7KMDnTyAXGsvToTi9EC` | pruned_count=6; `automation_runs_count = 0` after |

Schema was purely additive — only new view methods, new JSON-facing
`AutomationRunView` struct, no field changes to stored types. Both
migrate logs confirmed state survived intact: `sequence_templates`
still holds the `session-probe` template; no in-flight sequences
mid-migrate (as expected — we ran these cold).

### What Phase 3 enables

Retrospective tooling is now end-to-end:

1. Artifacts (`collab/artifacts/*-mainnet-*.json`) carry
   `tx_hash`, `block_info.transaction_block_hash`, and per-receipt
   `block_hash`es — enough for an archival node to pin state
   slices at any point in a sequence trajectory.
2. NEP-297 event runtime blocks embed `block_height` /
   `block_timestamp_ms` / gas / balance / storage_usage at
   every event site.
3. Contract state itself is inspectable
   (`list_automation_runs` / `get_automation_run`) and self-
   prunable (`prune_finished_automation_runs`), keyed by the
   same `auto:{trigger_id}:{run_nonce}` namespace the artifacts
   reference.

Anyone can call the public hygiene + view methods — no owner
gate — so a retrospective user with just `tx_hash + signer_id`
can reconstruct a run without needing to involve the account
owner.

## Phase 4 — reference runs against `v4.0.2-ops` (2026-04-19)

Fresh flagship runs against the post-migrate kernel. Captured with
full `block_info` anchors and curated under
`collab/artifacts/reference/` for the
[`MAINNET-PROOF.md`](./MAINNET-PROOF.md) verification story.

| Primitive | Tx hash | Block hash | Reference artifact |
|---|---|---|---|
| T1 PreGate (limit-order) | `9quv5g2S1c4ZeLJQrMZmSpuGwfYM4fX4Y61GfA7vf4Cr` | `hdRtm4YTx3a5UXDNYj96hw4aGBk1HCWvqWB64DnYHcA` | `collab/artifacts/reference/mike-near-v4.0.2-limit-order.json` |
| T2 value threading (ladder-swap) | `9BQbtMwEgA6TvEaeCANbk8PoRjShUSEzhKdFLtXks2nL` | `3b3KyHu1UozT5Yax5gWhapZ58aW4xDtJUUbpNPqQptzm` | `collab/artifacts/reference/mike-near-v4.0.2-ladder-swap.json` |
| T3 session keys — enroll | `8xfeHbuSHRoX1sbG6VSTgBNMHG9ssRKhwHd9Ur5jLYDY` | `94m7qCxDTEEUkySxs1BR4DFeyZDPALaRzVzbXfzZHvis` | `collab/artifacts/reference/mike-near-v4.0.2-session-dapp.json` |
| T3 session keys — fire #1 | `C1tise22QTZ9n78u1ABXyfC3Safw4zaWmhd22wKXFgkU` | (in artifact) | ↑ |
| T3 session keys — fire #2 | `8TRodh9z7kMYRHjBGsUuxzg7VKBA33SAkFAZ3US8vRzq` | (in artifact) | ↑ |
| T3 session keys — fire #3 | `ACtiPBXRRuZL5C1Vt6SRb7KzUJxt4cBaRiuGA5okJdLs` | (in artifact) | ↑ |
| T3 session keys — revoke | `qtMAmsLzdaVPwyRNCWWR9MYZxbLzEZAbwMor7G6tVtw` | `DipZxEhqPPZMkv67qQ55FWhpxwU9JnWm1ytqKvidHFHA` | ↑ |

### Live state post-Phase-4

The three fire txs incremented `balance_triggers.session-trigger.runs_started`
to 9 and landed 3 new `automation_runs` rows (namespaces
`auto:session-trigger:7|8|9`, all status=`Succeeded`). They are
deliberately LEFT UNPRUNED as part of the proof — a verifier can
call `list_automation_runs(0, 10)` on `mike.near` right now and
cross-reference the three rows against the fire tx hashes above.
When the proof no longer needs to be live-inspectable,
`prune_finished_automation_runs()` returns state to clean.

## Session-dapp bug surfaced + fixed during Phase 2

**Symptom.** First Phase 2 run of `session-dapp.mjs` crashed at the
revoke step with:

```
ServerError: Transaction method name revoke_session isn't allowed
by the access key
```

**Root cause.** The flagship's step-2 `keyStore.setKey(NETWORK,
smartAccount, ephemeralKeyPair)` silently overwrote the owner's
FAK in the keystore when `signer === smartAccount` (previously
always different — e.g. `x.mike.testnet` signing for
`sa-session.x.mike.testnet`). The owner's subsequent
`revoke_session` call then signed with the ephemeral FCAK, which
is scoped to `execute_trigger` only.

**Fix.** `examples/session-dapp.mjs` now saves the prior
`(network, smartAccount)` keystore entry, restores it before the
revoke call, and re-applies the ephemeral key before the post-
revoke-attempt fire. Regression-safe for both
`signer === smartAccount` and `signer !== smartAccount` (the no-
overwrite branch is a no-op).

## Gas + balance observations

- 517 KB v4 wasm storage on `mike.near`: ~5.2 NEAR locked. Account
  balance dipped from ~2640.10 NEAR pre-deploy to ~2632.07 NEAR
  post-run sequence (Phase 2 txs consumed ~8 NEAR across deploy +
  smoke-tests + template+trigger + hygiene).
- Per-step default gas (40 TGas prepaid, ~1 TGas used) is more
  than sufficient for the `probe-v4.mike.near.do_honest_work`
  shape; tune upward if production targets land heavier targets.

## Phase 5 — real-dapp flagship: `intents-deposit-limit` (2026-04-19)

First composition of FOUR primitives in one live session on
`mike.near` v4.0.2-ops: `PreGate × 2` (step 1 floor guard on
`wrap.near.ft_balance_of`, step 2 limit check on
`v2.ref-finance.near.get_return`, pool `3879`) + value threading
(step 1's balance saved as `wnear_balance`, step 2 `amount`
materialized via `PercentU128 { bps: 100 }`) + session key
(2h expiry, 2 allowed triggers, 5 max fires).

Both branches of the pre-dispatch gate proved in one session:
a pass fire landed the deposit, a halt fire (identical session
key, different trigger, threshold set intentionally high)
refused at step 2 without touching `intents.near`.

| Label | Tx hash | Block | Notes |
|---|---|---|---|
| `save_sequence_template` (pass) | `8zQpETNuWp15VnmvFYXhzdyroj4iAPLK2i6sYNC69Fvq` | — | stores two-step plan under `intents-deposit-limit-pass-*` |
| `save_sequence_template` (halt) | `5e49WkcGtx1zMryn3qchjUu4NL82iKU7vUqv275Dj5uZ` | — | identical shape, higher `min_bytes` for proof-of-halt |
| `create_balance_trigger` (pass) | `7LT7PMsknCv5AoZXRcJsq3hz7AVmCbkjEbpviqa74Dzd` | — | |
| `create_balance_trigger` (halt) | `Em75Uq1QyPZnNC94ioXyGXood6CMAQu88sA6MMRtTjic` | — | |
| `enroll_session` | `J3tM59hG87rFZsgpoTj4UPH4r3w2wptWnnYYXsZMGems` | 194711851 | 1 yoctoNEAR attached; allowlist covers both triggers |
| `execute_trigger` (pass fire) | `65K4kDyd8Ab3vWnsdAB81YK5ptYLJ1Xem3ea1sRXZx9L` | 194711855–194711867 | `pre_gate_checked × 2 { in_range }`; `nep245/mt_mint` at `intents.near`; +0.445 wNEAR deposited; `sequence_completed` |
| `execute_trigger` (halt fire) | `EEC83UhpqvckEcuMnYqekQgR6jpuLMGtJJctxE23HhX` | 194711874–194711882 | step 2 `pre_gate_checked { below_min }`; `sequence_halted { reason: pre_gate_failed, error_kind: pre_gate_below_min }`; no `mt_mint`, no balance change |
| `revoke_session` | `DnYZB24ShHFz2BicgkmP1BS3GDAX79hSHCABJUoNxknD` | 194711890 | atomically deletes state + FCAK; post-revoke fire rejected by NEAR runtime |

Reference artifact:
[`collab/artifacts/reference/mike-near-v4.0.2-intents-deposit-limit.json`](./collab/artifacts/reference/mike-near-v4.0.2-intents-deposit-limit.json).

Falsifiability path (60 s): [`QUICK-VERIFY.md`](./QUICK-VERIFY.md)
(prose) or `./scripts/verify-mainnet-claims.sh` (script).
Deep dive: [`MAINNET-PROOF.md`](./MAINNET-PROOF.md) Recipe 3.

### Live state post-Phase-5

`mike.near` now has two sequence templates
(`intents-deposit-limit-pass-*` and `intents-deposit-limit-halt-*`),
two balance triggers (likewise), and two more `automation_runs`
entries at `auto:intents-deposit-limit-*:1`. Same LEFT-UNPRUNED
convention as Phase 4 — verifier can call
`list_automation_runs` and cross-reference.

## Next steps (not in this journal)

- **`intents-autosettle.mjs`** — withdrawal-leg flagship pairing
  with `intents-deposit-limit`. Session-key-fired
  `mt_balance_of(USDT)` PreGate sequence where most fires halt
  cleanly and one eventually passes after a solver fills.
  Completes the deposit/withdraw bookend story.
- **DAO-signed variant.** Any of the existing flagships re-run
  where the owner is a Sputnik2 DAO contract rather than a
  user FAK — proves the kernel works under multisig governance.
- Consider a one-line `SESSION-KEYS.md` addendum clarifying the
  keystore-slot behavior for dapp integrators who sign from the
  same account that owns the smart account.
