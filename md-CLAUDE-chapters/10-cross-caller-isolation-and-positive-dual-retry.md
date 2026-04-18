# 10 · Cross-caller isolation and positive dual-retry

**BLUF.** The last two open corners from chapter 08 §7 are closed:

1. **Cross-caller isolation works.** Two distinct callers (`mike.testnet`
   and `x.mike.testnet`) each staged a label named `alpha` at the same
   `smart-account.x.mike.testnet`. `staged_calls_for(caller_id)` returned
   exactly each caller's own entry, not the other's. A `run_sequence`
   issued by the owner on behalf of `x.mike.testnet` drained only
   `x.mike.testnet`'s `alpha`; `mike.testnet`'s `alpha` was untouched.
2. **Positive dual-retry works.** Two successive `run_sequence` calls on
   the same pending set (no failure between them) each drained exactly
   their declared label, leaving the other pending for the next call.
   No state weirdness, no queue carryover.

One incidental surprise worth writing down: `IterableMap::remove`'s
swap-remove shuffles the observed iteration order of labels belonging
to a *third* caller. After `x.mike.testnet`'s `alpha` was drained,
`mike.testnet`'s pending set visually re-ordered from `[alpha, beta]`
to `[beta, alpha]` — even though nothing happened to `mike.testnet`'s
labels. The *set* is preserved; the order is not. Clients should
decide execution order semantically, not by iteration.

## 1. Mental-model continuation

Each caller has their own flight of satellites around the smart-account
sphere. The contract's ground station can retrieve any caller's
satellites on command (assuming the ground-station operator is owner or
authorized executor) without affecting the orbits belonging to other
callers. Cross-caller work does not collide; it simply shares the same
central sphere.

## 2. Reference run

| Artifact | Value | Block |
|---|---|---|
| `x.mike.testnet` stages `alpha:11` | `Fwemx5UrZ66sqAQXLjLN61fnZE9gprE3BtXeGKqMaESy` | `246229521` |
| `mike.testnet` stages `alpha:1 beta:2` | `3AuT7f7QdD8cJE9biSzfeyPiHQXkg2i6NBm6WqEWaxfe` | `246229531` |
| `run_sequence(caller_id=x.mike.testnet, order=[alpha])` — signed by mike.testnet as owner | `44dJSdZ99uTQufUnsWozETLuuREWoQhwx9tGGpuDXt7d` | `246229573` |
| `run_sequence(caller_id=mike.testnet, order=[alpha])` | `B51CDETKobH5em7EH8dpdLchPkuSpBoVfiWeQBrrHT8z` | `246229638` |
| `run_sequence(caller_id=mike.testnet, order=[beta])` | `HaZkk8GR6Z6oLsLTavFV2ZFMG92RJbkH9athBXXnvFSu` | `246229653` |

All five tx's signed from the already-loaded credentials:

- `x.mike.testnet` → the deploy parent, used once here as a regular caller
- `mike.testnet` → both an ordinary stager *and* the contract's owner
  (per `new_with_owner`), so it is the only account allowed to call
  `run_sequence`

`x.mike.testnet` CANNOT call `run_sequence` on its own set under the
current authorization; it can only stage. Someone with execution
authority (owner = mike.testnet here, or a future
`set_authorized_executor` entry) has to actually conduct. That
asymmetry — **caller puts labels on orbit, executor retrieves them** —
is worth naming: it's the account
abstraction lever. A smart account might let anyone stage calls that
the account's owner (or an MFA service, or a scheduled automation
service) decides
when to execute.

## 3. Surface 2 — side-by-side state for both callers

`scripts/state.mjs smart-account.x.mike.testnet --block <h> --method staged_calls_for --args '{"caller_id":"<who>"}'`

| Block | `staged_calls_for(x.mike.testnet)` | `staged_calls_for(mike.testnet)` | What just happened |
|---|---|---|---|
| 246229521 | `[]` | `[]` | `x.mike.testnet`'s batch tx included; contract receipt pending |
| 246229522 | `[alpha]` | `[]` | `x.mike.testnet`'s batch receipt runs; one yielded callback allocated for `x.mike.testnet#alpha` |
| 246229531 | `[alpha]` | `[]` | `mike.testnet`'s batch tx included |
| 246229532 | `[alpha]` | `[alpha, beta]` | `mike.testnet`'s batch receipt runs; two yielded callbacks allocated for `mike.testnet#alpha` and `mike.testnet#beta`. **Two distinct `alpha`'s live at the same smart-account, distinguished only by their caller-id prefix.** |
| 246229573 | `[alpha]` | `[alpha, beta]` | `run_sequence(caller_id=x.mike.testnet)` tx included |
| 246229577 | `[]` | `[beta, alpha]` | **`x.mike.testnet`'s alpha drained** via the saga success path. `mike.testnet`'s entries were untouched but their iteration order flipped (swap-remove side-effect) |
| 246229580 | `[]` | `[beta, alpha]` | steady |
| 246229638 | `[]` | `[beta, alpha]` | `run_sequence(caller_id=mike.testnet, order=[alpha])` tx included |
| 246229642 | `[]` | `[beta]` | `mike.testnet`'s `alpha` drained; `beta` still pending |
| 246229645 | `[]` | `[beta]` | steady |
| 246229653 | `[]` | `[beta]` | `run_sequence(caller_id=mike.testnet, order=[beta])` tx included |
| 246229657 | `[]` | `[]` | `mike.testnet`'s `beta` drained; both callers' sets empty |

## 4. The swap-remove cross-caller side-effect

`IterableMap` in near-sdk 5.x stores entries under `(prefix, u32_index)`
keys. `remove()` is implemented as swap-remove: the removed entry's
slot is overwritten by the *last* entry, and the length is decremented.
That last entry could belong to any caller.

In this run:

- at block `246229532` the IterableMap had three entries in insertion
  order:
    - idx 0 → `x.mike.testnet#alpha`
    - idx 1 → `mike.testnet#alpha`
    - idx 2 → `mike.testnet#beta`
- at block `246229577` `x.mike.testnet#alpha` (idx 0) was removed. Swap-
  remove moved the last entry (`mike.testnet#beta`, idx 2) into idx 0.
- the IterableMap is now:
    - idx 0 → `mike.testnet#beta`
    - idx 1 → `mike.testnet#alpha`
- `staged_calls_for(mike.testnet)` iterates the map in storage-order
  and filters by caller prefix, so it now returns `[beta, alpha]`
  rather than `[alpha, beta]` — without `mike.testnet` ever performing
  an action.

Consequence: consumers of `staged_calls_for` must not assume stable
iteration order. If order matters to a downstream tool (e.g., picking
a default conduct order), the tool should provide its own ordering
(e.g., sort by `created_at_ms` or by label name), not rely on the
iteration order.

This is a **display-layer surprise, not a correctness bug** — the set
of pending labels is still right.

## 5. Positive dual-retry (no failure between)

Chapter 07 validated retry-after-halt. This chapter also validates the
simpler case: two consecutive `run_sequence` calls on the same caller's
pending set, both succeeding, no halt between.

- block `246229638`: `run_sequence(caller_id=mike.testnet, order=[alpha])` — drains `mike.testnet#alpha`.
- block `246229653`: `run_sequence(caller_id=mike.testnet, order=[beta])` — drains `mike.testnet#beta`.

Each call's cascade took ~4 blocks (`run_sequence` inclusion → contract
receipt → resume → downstream → settle). No state carryover between
calls; the second call's `assert_no_conduct_in_flight` passed cleanly
because the first call's saga success path cleared the queue on the
last settle.

This pattern is what an automation service would naturally use: one call per
label at its own pace, each call independent.

## 6. What chapters 03–09 have now proven, together

| Claim | Empirical location |
|---|---|
| multi-Action tx creates N independent yielded callbacks | 02, 03 |
| `run_sequence` can deterministically pick the wake-up order | 02, 03, 05 |
| downstream work is executed in the declared order | 03, 05 |
| contract state time-series corroborates the receipt DAG | 05 |
| downstream failure halts the sequence cleanly | 06, 08 |
| yield timeout auto-cleans up unresolved labels | 06 |
| post-halt labels remain pending for retry | 07, 08 |
| retry can pick *any* order, not just the original | 07, 08 |
| mixed success/halt within one `run_sequence` behaves correctly | 08 |
| cross-caller label isolation | **09** |
| iterative state ordering is not stable across cross-caller ops | **09** |
| positive dual-retry (no halt between) | **09** |

The single-smart-account saga semantic is empirically closed. What
remains, substantively, is either (a) a contract change (e.g.,
compensation hooks) or (b) a different surface (yield-sequencer's
plan-based API on testnet, signed user-ops, multi-account flows). Both
are next-tranche items.

## 7. Recipes

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

# owner conducts x.mike.testnet's set on its behalf
near call smart-account.x.mike.testnet run_sequence \
  '{"caller_id":"x.mike.testnet","order":["alpha"]}' --accountId mike.testnet

# then owner conducts its own set, one label at a time
near call smart-account.x.mike.testnet run_sequence \
  '{"caller_id":"mike.testnet","order":["alpha"]}' --accountId mike.testnet
near call smart-account.x.mike.testnet run_sequence \
  '{"caller_id":"mike.testnet","order":["beta"]}' --accountId mike.testnet
```

Tables generated from live testnet reads. As in chapters 05–08, the
chapter is the running log.
