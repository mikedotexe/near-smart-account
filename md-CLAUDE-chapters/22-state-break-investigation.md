# Chapter 22 — State-break investigation

Forensic write-up of why `smart-account.x.mike.testnet` returns
"Cannot deserialize the contract state" and why chapters 20 and 21
both worked around it by creating fresh subaccounts
(`sa-probe.x.mike.testnet`, `sa-asserted.x.mike.testnet`) instead of
redeploying over the original.

Written for a reader who already knows Rust-on-NEAR — borsh, `IterableMap`,
`#[init]`, state prefixes, `DeleteAccountWithLargeState`. No re-teaching
from first principles.

## 0. The symptom

Any state-reading method on `smart-account.x.mike.testnet` panics:

```
$ near view smart-account.x.mike.testnet list_sequence_templates '{}'
Error: Cannot deserialize the contract state.
```

The WASM is still deployed. Storage bytes still live on chain. What
broke is **the match between the new WASM's borsh schema and the state
bytes that were written under an earlier schema**. Every view method
that reads any field of `Contract` hits the same panic. Every call
method hits it too, because the SDK deserializes `Contract` from
storage before dispatching.

## 1. What we can verify vs what we have to reconstruct

Up front, two caveats:

- **Git is not useful here.** `git log --all --oneline` shows a single
  commit: `f3ec804 Initial import of smart-account-contract`. Every
  schema change happened in the working tree before or after that
  import without being committed. There is no diffable trail of "the
  moment `Contract` grew a new field."
- **No pre-break / post-break artifact exists.** We did not capture the
  on-chain state at the moment it became unreadable, and no investigation
  JSON under `collab/artifacts/` spans the break.

What we can do, and what this doc does:

1. Read the current schema (ground truth as of today).
2. Enumerate the classes of change that would have broken borsh on
   redeploy.
3. Rank the likely triggers against what we know was added to the
   kernel over time.
4. Explain why the delete-and-recreate ritual in `deploy-testnet.sh`
   did not prevent the break.
5. Document the recovery path we chose not to walk, and the patterns a
   seasoned NEAR dev uses to avoid this trap in the first place.

## 2. The current state shape

Short forensic map, anchored to line numbers, so the "what does borsh
expect today" question is a lookup, not a reread.

| Surface | Where | Notes |
|---|---|---|
| `Contract` struct | `contracts/smart-account/src/lib.rs:207-217` | 7 fields: 2 primitives + 5 `IterableMap` collections |
| `StorageKey` enum | `contracts/smart-account/src/lib.rs:57-65` | 5 variants, one prefix per collection |
| `YieldedPromise` | `contracts/smart-account/src/lib.rs:102-108` | 3 fields |
| `SequenceCall` | `contracts/smart-account/src/lib.rs:67-77` | 7 fields, includes `ResolutionPolicy` |
| `SequenceTemplate` | `contracts/smart-account/src/lib.rs:122-128` | 3 fields |
| `BalanceTrigger` | `contracts/smart-account/src/lib.rs:164-178` | 11 fields, several `Option<T>` |
| `AutomationRun` | `contracts/smart-account/src/lib.rs:150-162` | 9 fields |
| `AutomationRunStatus` | `contracts/smart-account/src/lib.rs:141-148` | 4 variants |
| `ResolutionPolicy` | `types/src/types.rs:12-48` | 3 variants: `Direct`, `Adapter{..}`, `Asserted{..}` |

The contract derives `PanicOnDefault`. There is **no** migration
function anywhere in the crate — no `#[init(ignore_state)]` handler,
no versioned-enum wrapper. The `Contract` type is the only shape the
SDK knows how to read.

The deployment ritual at `scripts/deploy-testnet.sh:47-48` is
delete-and-recreate:

```bash
printf 'y\n' | near delete "$acct" "$MASTER" --force --networkId "$NETWORK_ID" >/dev/null 2>&1 || true
near create-account "$acct" --masterAccount "$MASTER" --initialBalance "$INITIAL_BALANCE" --networkId "$NETWORK_ID"
```

`near-sdk` is pinned at `5.26.1`
(`contracts/smart-account/Cargo.toml:11`). This matters for class 4
below.

## 3. What would have broken borsh, and which is the likely culprit

Four classes of schema-breaking change, ordered by likelihood for
this repo.

### Class 1 — Adding a required field to `Contract`

Most likely culprit.

The current `Contract` has 5 collections. Several of them — specifically
`balance_triggers` and `automation_runs` — belong to the automation
product layer that landed across chapters 09 and 12 (balance-trigger
automation). Almost certainly, earlier iterations of `Contract` had
fewer collections. Something like:

```rust
pub struct Contract {
    pub owner_id: AccountId,
    pub yielded_promises: IterableMap<String, YieldedPromise>,
    pub sequence_queue: IterableMap<String, Vec<String>>,
}
```

When the automation layer added `sequence_templates`,
`balance_triggers`, `automation_runs`, and `authorized_executor`, the
new `Contract` grew from 3 fields to 7.

Borsh is positional and strict. On redeploy over existing state, the
SDK calls `env::state_read::<Contract>()` and walks the old bytes
looking for field 1 (`owner_id`), field 2 (`authorized_executor` —
new, missing in old bytes), field 3 (`yielded_promises` — used to be field 2
in the old layout), and so on. The reader falls off the end of the
stored bytes long before hitting the new collection headers.
`state_read` returns `None` (or a read error in modern SDKs), and
`PanicOnDefault` fires the panic we observe.

### Class 2 — Reordering enum variants

Unlikely for this repo, but worth flagging because it is the most
insidious class.

Borsh writes an enum variant as a 1-byte discriminant equal to the
variant's position. If you reorder `ResolutionPolicy` from
`[Direct, Adapter, Asserted]` to `[Adapter, Direct, Asserted]`, every
stored `Direct=0` byte now deserializes as `Adapter` (wrong body
length) and the reader either fails or silently misinterprets. Same
story for `AutomationRunStatus`.

The surviving evidence suggests positions have been stable:
- `ResolutionPolicy` has always enumerated `Direct → Adapter → Asserted`
  in that order across chapters 14, 20, 21.
- `AutomationRunStatus::{InFlight, Succeeded, DownstreamFailed,
  ResumeFailed}` ordering appears in unit tests and artifact JSON that
  match the current ordering.

So class 2 is probably not what happened.

### Class 3 — Changing a variant body

The chapter-21 tranche reshaped `ResolutionPolicy::Asserted` from a
unit variant to a struct variant with five fields
(`types/src/types.rs:33-48`). That is a real wire-shape change.

But: borsh's discriminant for `Asserted` stays at position 2. Stored
`Direct` and `Adapter` entries still deserialize correctly — their
bytes and their reader haven't changed. Only a stored `Asserted`
entry would break, and since `validate_sequence_call` rejected
`Asserted` yield attempts while it was a unit variant (panic:
`"asserted settle policy is reserved but not implemented"`), no
legitimate `Asserted` entry ever made it into state.

This class of change was safe for this repo. It is not the trigger.

### Class 4 — Collection-type swap

Real candidate, probably ranks second after class 1.

`near-sdk` 5.x renamed and restructured the collection types. In
particular, `UnorderedMap` and `LookupMap` were reshaped and a new
`IterableMap` (the one used throughout `Contract` today) was added.
The on-disk key layout — key prefix byte schemes, internal counter
keys, value serialization — differs between the v4 collections and
the v5 ones. A contract that was once built against
`near-sdk = "4.x"` and later against `5.x` will fail to read its own
state after redeploy, even if the Rust-visible field types look the
same.

We cannot confirm from git whether this repo ever rode that upgrade,
but the current pin of `near-sdk = "5.26.1"` means it's 5.x today,
and the project predates that. Plausible but unverified.

### Ranked guess

1. **Class 1** — adding required fields to `Contract` during the
   chapter-09/12 automation build-out. Matches the shape of the
   growth we can see in the code today.
2. **Class 4** — `near-sdk` 4.x → 5.x collection rename, if this repo
   ever lived on the 4.x series.
3. **Class 3** — enum-variant body change. Chapter-21 `Asserted`
   reshape. Technically a breaking change but harmless in practice
   because no `Asserted` entries existed.
4. **Class 2** — enum-variant reordering. No evidence this happened.

The common pattern between 1 and 4 is "we added real product surface
between deploys without a migration." That is the normal trap a NEAR
dev falls into during rapid iteration.

## 4. Why delete-and-recreate didn't save us

`scripts/deploy-testnet.sh` tries to prevent this exact failure by
wiping the account before each deploy. The relevant lines are 47-48:

```bash
printf 'y\n' | near delete "$acct" "$MASTER" --force \
  --networkId "$NETWORK_ID" >/dev/null 2>&1 || true
near create-account "$acct" --masterAccount "$MASTER" \
  --initialBalance "$INITIAL_BALANCE" --networkId "$NETWORK_ID"
```

Three problems:

- **`>/dev/null 2>&1 || true`.** Every error from `near delete` is
  silently swallowed. If the delete fails for any reason — rate
  limits, network flake, or the reason relevant here — the script
  marches on as though the account is fresh.

- **`DeleteAccountWithLargeState` is a runtime guard, not a policy you
  can pay around.** The NEAR runtime refuses to execute a
  `DeleteAccount` action on an account whose storage sweep would
  exceed the single-receipt gas budget. The threshold is not
  documented in precise bytes, but it is easy to cross with modest
  contract state — a few dozen yielded promises or a handful of balance
  triggers is enough. Funding the account with more NEAR does
  **not** help. The guard is about gas per receipt, not balance.

- **`near create-account` on an already-existing account fails.** So
  after the silent-delete-failure, the next step either aborts the
  script or, if someone ran `near deploy` manually, lands the new
  WASM on top of the stale state. Either way, once the new WASM is
  on an account with old-shape storage, every read panics.

This is the most common way NEAR devs destroy their own testnet rigs.
The script looks defensive but the `|| true` is a silent failure
catching a real one.

## 5. Why seasoned NEAR devs rarely see this

Five patterns, each one preventing a specific class of trap. Applied
from day one, they cover the large majority of "Cannot deserialize
the contract state" incidents.

**a. Never add a non-`Option` field to `Contract` without a
migration.** If you must add a required field, ship a one-shot
migration:

```rust
#[private]
#[init(ignore_state)]
pub fn migrate() -> Self {
    let old: ContractV0 = env::state_read().expect("no v0 state");
    Self {
        owner_id: old.owner_id,
        authorized_executor: None,
        yielded_promises: old.yielded_promises,
        // ... carry forward each old field; initialize new ones ...
        balance_triggers: IterableMap::new(StorageKey::BalanceTriggers),
        automation_runs: IterableMap::new(StorageKey::AutomationRuns),
    }
}
```

Redeploy with `--initFunction migrate`. After that one call, the
account is on the new schema and you remove `ContractV0` from the
crate before the next release.

**b. `Option<T>` is borsh-safe only when appended.** Borsh writes
`Option<T>` as a `0` byte (None) or `1 + T_bytes` (Some). That tag is
positional, so appending a new `Option<U>` field works (the reader
hits the end of the old bytes, and borsh treats "no bytes" as an
error — it does **not** synthesize `None`). What works instead:
append the new `Option<U>` *and* ship a migration, or wrap the whole
thing in a versioned enum (pattern c). `#[serde(default)]` is a JSON
affordance; borsh does not honor it.

**c. Wrap state in a versioned enum early.** The canonical pattern:

```rust
#[near(serializers = [borsh])]
pub enum VersionedContract {
    V1(ContractV1),
    V2(ContractV2),
}
```

You pay one byte of storage overhead forever in exchange for cheap
future migrations: add `V3(ContractV3)`, implement `From<V2> for V3`,
ship a no-op `migrate()` that converts in place. You do this before
mainnet, not after.

**d. Treat `DeleteAccount` as a cliff, not a shortcut.** Once your
rig carries real state, assume the account is long-lived. Clear
storage explicitly per-collection before attempting delete, or accept
that the account becomes stateful infrastructure. The repo's
`CLAUDE.md:111-118` already says this; the `|| true` in
`deploy-testnet.sh` is a countervailing pattern that should probably
be tightened (see §7).

**e. Pin `near-sdk` deliberately.** Collection-type renames
(`UnorderedMap` → `IterableMap`) across a major version are
borsh-breaking regardless of your own code. Upgrading `near-sdk` from
4.x to 5.x while live state exists on chain requires the versioned
wrapper from pattern c, a migration, and a test that round-trips
state through the old and new readers. This is why upgrade-in-place
gets a pull-request checklist on serious contracts.

## 6. What we would actually do to fix `smart-account.x.mike.testnet`

Sketch, not prescription. Documenting the path we chose not to walk,
so the option is known.

1. Read the on-chain state bytes directly:
   ```bash
   near view-state smart-account.x.mike.testnet --finality final
   ```
   This enumerates the stored keys with their borsh prefix byte.
2. Match observed prefixes against the `StorageKey` variants.
   - If you see only prefix `0` (`YieldedPromises`) and `1`
     (`SequenceQueue`) but no `3` (`BalanceTriggers`) or `4`
     (`AutomationRuns`), the break is class 1: added fields.
   - If you see prefixes that don't match any current `StorageKey`
     variant, the break is class 2 or class 4.
3. Write a `ContractV0` struct in the crate that matches the guessed
   old shape. Keep it alongside the current `Contract`.
4. Ship a migration:
   ```rust
   #[private]
   #[init(ignore_state)]
   pub fn migrate_v0_to_current() -> Self {
       let old: ContractV0 = env::state_read().expect("no v0 state");
       Self {
           owner_id: old.owner_id,
           authorized_executor: None,
           yielded_promises: old.yielded_promises,
           sequence_queue: old.sequence_queue,
           sequence_templates: IterableMap::new(StorageKey::SequenceTemplates),
           balance_triggers: IterableMap::new(StorageKey::BalanceTriggers),
           automation_runs: IterableMap::new(StorageKey::AutomationRuns),
       }
   }
   ```
5. Redeploy the contract with
   `--initFunction migrate_v0_to_current`.
6. Call `list_sequence_templates` and confirm it returns `[]`
   without panic.
7. Remove `ContractV0` and the migration function in the next
   release.

Recommendation: **don't do this**. `sa-asserted.x.mike.testnet` is
the active rig, the original account is drained of live sequences,
and the recovery work is only worth the effort if there is a reason
to reclaim that specific subaccount. This is documentation of the
path, not a request to walk it.

## 7. Implications for mainnet

This ties directly back to the "should I mainnet deploy?" thread.
If you stand this contract up on mainnet as-is, you are one `Contract`
field away from bricking the account, and NEAR mainnet's
`DeleteAccountWithLargeState` threshold is reached faster because
storage-stake costs are real.

Concrete pre-mainnet changes worth making first:

- **Wrap `Contract` in a versioned enum.** Even if today is V1, the
  wrapper makes the first V1→V2 migration cheap. Pattern (c) from §5.
- **Add a no-op `migrate()`.** Ship it live with V1. The redeploy
  ritual on mainnet becomes "deploy new WASM, call migrate," not
  "delete and recreate."
- **Add an explicit `schema_version: u8` on `Contract`** (or on the
  versioned wrapper). Future breakage becomes loud ("expected v2, got
  v1") rather than "Cannot deserialize the contract state."
- **Retire the `|| true` on the delete step** — on mainnet you should
  never be running delete-and-recreate at all, but keeping the
  `scripts/deploy-testnet.sh` pattern where a silent delete failure
  is fine would be an unforced error.
- **Freeze `near-sdk` version** for the first mainnet era. Plan the
  eventual 5.x → 6.x upgrade as a migration tranche with a staged
  rollout, not a drive-by bump.

None of this is large. It is the delta between "interesting POC" and
"contract you would actually let users put money in."

## 8. References

- `contracts/smart-account/src/lib.rs:57-65` — `StorageKey` enum
- `contracts/smart-account/src/lib.rs:67-77` — `SequenceCall` with
  `ResolutionPolicy`
- `contracts/smart-account/src/lib.rs:141-148` — `AutomationRunStatus`
- `contracts/smart-account/src/lib.rs:150-178` — `AutomationRun`,
  `BalanceTrigger`
- `contracts/smart-account/src/lib.rs:207-237` — `Contract` struct and
  `new` / `new_with_owner` initializers (no migration)
- `types/src/types.rs:12-48` — `ResolutionPolicy` enum (current shape)
- `contracts/smart-account/Cargo.toml:11` — `near-sdk = "5.26.1"` pin
- `scripts/deploy-testnet.sh:47-48` — the silently-failing delete +
  recreate
- `CLAUDE.md:88-91` — canonical statement of the break
- `CLAUDE.md:111-118` — churn rule: fresh child accounts, don't fight
  `DeleteAccountWithLargeState`
- `md-CLAUDE-chapters/20-pathological-contract-probe.md:326-328` —
  `sa-probe.x.mike.testnet` created because the original had
  "incompatible prior state"
- `md-CLAUDE-chapters/21-asserted-resolve-policy.md:282-285` —
  `sa-asserted.x.mike.testnet` created; original is "left untouched"
- `README.md:67-74`, `PROTOCOL-ONBOARDING.md:109-116` — the same
  churn rule, repeated for operator audiences

## 9. TL;DR for the hurried reader

- Real cause, almost certainly: `Contract` grew new required fields
  (the automation layer — templates, balance triggers, automation
  runs) between deploys, without a migration.
- The delete-and-recreate deploy ritual failed silently, probably
  because `DeleteAccountWithLargeState` blocked the delete and the
  `|| true` swallowed the error.
- The fix is a `#[init(ignore_state)]` migration function plus a
  `ContractV0` struct reconstructed from the old shape. We're
  choosing not to walk it; `sa-asserted` is the active rig now.
- Before mainnet, add a versioned-state enum, a `migrate()` function,
  and an explicit `schema_version` field. That is ~50 lines of code
  that saves you from repeating this incident with real money
  involved.
