# simple-example: NEAR Social variant

The default `simple-example` run uses a repo-owned `recorder` leaf. That
proves the sequencer claim but keeps the witness in JSON. This variant swaps
the leaf for **NEAR Social** (`social.near` on mainnet,
`v1.social08.testnet` on testnet) so the reorder is publicly visible on a
real profile page any human can click through to.

No Rust changes. The `simple-sequencer`'s `yield_promise(...)` already accepts
any `target_id` and `method_name`, so the variant is purely a new
off-chain script plus a one-time storage deposit.

## Claim this variant proves

Exactly the same sequencer claim as the recorder variant:

> one multi-action transaction manufactures multiple yielded callbacks, and
> a later `run_sequence` releases real downstream cross-contract work in a
> deliberately different order than the original action order

The only thing that changes is the witness. Instead of asking
`simple-recorder.get_entries()` to read out the observed order, you look at
`near.social/<sequencer-account>` and read three posts whose feed position
is determined entirely by the chosen release order.

## What the reveal looks like

Each yielded step writes to two SocialDB paths under the sequencer's own
namespace:

- `<sequencer>/post/main` — the current post body (overwritten each set)
- `<sequencer>/index/post` — an indexer event announcing "there is a post
  at `main`"

The `near.social` frontend replays `index/post` events and snapshots
`post/main` at each event's block height. So after one run:

- three `index/post` events exist at three different block heights
- each one references `post/main` at that block, which held the line that
  was released at that block
- the feed renders newest at the top

The release order therefore maps directly to reverse-chronological feed
order. The default `--sequence-order` is `reverse(--lines)`, so the feed
reads top-to-bottom as the poem was written.

## Prerequisites

The operator account naming mirrors the mainnet / testnet `sa-lab` lab
parents:

- mainnet: `sa-lab.mike.near` -> `simple-sequencer.sa-lab.mike.near`
- testnet: `sa-lab.mike.testnet` -> `simple-sequencer.sa-lab.mike.testnet`

Each lab parent is a long-lived sacrificial child of the primary identity
account (`mike.near` / `mike.testnet`).

1. A deployed `simple-sequencer` on the target network. For mainnet, a
   fresh direct-child subaccount is strongly preferred:

   ```bash
   near create-account simple-sequencer.sa-lab.mike.near \
     --masterAccount sa-lab.mike.near \
     --initialBalance 3 \
     --networkId mainnet
   ./simple-example/scripts/build-all.sh
   near deploy simple-sequencer.sa-lab.mike.near \
     simple-example/res/simple_sequencer_local.wasm \
     --initFunction new --initArgs '{}' \
     --networkId mainnet
   ```

   The same shape works on testnet if you first create
   `sa-lab.mike.testnet`. Alternatively, any already-live simple-example
   sequencer on testnet (e.g. one previously cut by
   `deploy-testnet.sh` under `x.mike.testnet`) can be used directly.

2. A one-time storage deposit so the sequencer can write to social.near:

   ```bash
   ./simple-example/scripts/social-storage-deposit.mjs \
     --network mainnet \
     --signer mike.near \
     --sequencer simple-sequencer.sa-lab.mike.near \
     --amount-near 0.1
   ```

   The helper reads `storage_balance_of(account_id: <sequencer>)` first
   and skips unless you pass `--force`. `0.1 NEAR` covers many small
   posts.

## Running the demo

```bash
./simple-example/scripts/send-social-poem.mjs \
  --network mainnet \
  --signer mike.near \
  --sequencer simple-sequencer.sa-lab.mike.near \
  --lines "An old silent pond" "A frog jumps in" "Splash! Silence again"
```

What happens:

1. three `yield_promise(social.near, "set", <post-args>, ...)` actions land in
   one multi-action tx; each creates a yielded callback receipt
2. the script polls `sequencer.yielded_promises_for({ caller_id: <signer> })`
   until three yields are visible
3. `run_sequence(caller_id, order)` releases them in the chosen order
   (default `reverse(--lines)`); the sequencer's
   `on_promise_resumed` -> `on_promise_resolved` callback pair holds
   the next release until the previous downstream receipt resolves
4. the script reads `social.near.get({ keys: ["<sequencer>/post/main"] })`
   until it reflects the last-released line
5. it parses the run_sequence trace to recover the block heights of the
   three downstream social.near.set receipts and prints them oldest-first
6. it writes an artifact under `collab/artifacts/` and prints the
   `near.social` feed URL

Expected console shape:

```
stage_batch: tx_hash=... block_height=...
run_sequence: tx_hash=... block_height=...
post_main final: settled=yes text="An old silent pond"
downstream social.near.set receipts (oldest first):
  block=<H1> status=SuccessValue receipt_id=...
  block=<H2> status=SuccessValue receipt_id=...
  block=<H3> status=SuccessValue receipt_id=...
reverse-chronological feed preview (top=newest):
  [1] haiku-<run>-1  "An old silent pond"
  [2] haiku-<run>-2  "A frog jumps in"
  [3] haiku-<run>-3  "Splash! Silence again"
feed: https://near.social/simple-sequencer.sa-lab.mike.near
```

If you visit the feed URL a moment later, you'll see three posts with
those lines, newest at the top.

## Testnet dry run first

Every flag above works against `--network testnet` as long as you have a
testnet deploy of `simple-sequencer` and have deposited storage on
`v1.social08.testnet`. That's the safest way to shake out gas, args, and
ordering before spending mainnet gas.

```bash
./simple-example/scripts/social-storage-deposit.mjs \
  --network testnet \
  --signer mike.testnet \
  --sequencer simple-sequencer.sa-lab.mike.testnet \
  --amount-near 0.1

./simple-example/scripts/send-social-poem.mjs \
  --network testnet \
  --signer mike.testnet \
  --sequencer simple-sequencer.sa-lab.mike.testnet \
  --lines "testnet line a" "testnet line b" "testnet line c"
```

## Validated testnet reference run

As of 2026-04-18, this variant has been driven end to end on testnet
against an existing simple-example deploy
(`simple-sequencer-simple-mo4jdkp3.x.mike.testnet`):

- storage deposit tx:
  `7jCxqZ5J56SeCB8qbYeniC7stHaDTd4ZALffhEWtutGY`
  (0.1 NEAR, total=0.1, available=~0.095 after registration)
- stage_batch tx:
  `DhhnGr6sb1iyMhdgDYuWLwN6erugvDJ9Y7QfBjz9dhd5`
- run_sequence tx:
  `EaLXYQ3UnrBggyUQ97UN7n5PWncKeUGdWe5H9haZdXpV`
- requested release order: `haiku-mo4xlw6r-{3, 2, 1}`
- downstream `v1.social08.testnet.set` receipts, oldest first:
  - block `246371085` step 3 -> `"Leaves refuse to land"`
  - block `246371088` step 2 -> `"The cat considers its options"`
  - block `246371091` step 1 -> `"First snow falling"`
- proof_ordered: `true` (block-pinned `post/main` at each height matches
  the line released at that step)
- final `post/main` content: `"First snow falling"` (line 1, released
  last, therefore the top of the reverse-chronological feed)
- feed:
  `https://test.near.social/simple-sequencer-simple-mo4jdkp3.x.mike.testnet`

The downstream receipt block heights increase monotonically with release
order, which is the sequencer claim in its starkest public form: the next
real `FunctionCall` receipt is created only after the previous step's
resolution surface resolves.

## Validated mainnet reference run

Also on 2026-04-18 the same variant was driven end to end on mainnet
against a fresh `sa-lab` child:

- sequencer: `simple-sequencer.sa-lab.mike.near`
  (created by `5fE4jqkerWaFX5D6GkcbkBheBBCd4mTZTmTWFHyUTUmj`,
  deployed by `DNo4oDnpQPjqp9cXkKN4YqzjDe4rJvWgMQr2fL46Y9yW`)
- storage deposit on `social.near`:
  `2ES81ytgLAPtspTCGXHnuZuwUAaJhTardkABu22wNg2M`
  (total 0.1 NEAR, available ~0.0954)
- stage_batch tx:
  `9Zb7PJFEbZi7v28c61hNNaAHCP11UfMAMGNhUwuzA7mY`
  (3 actions x 300 TGas, matching the validated mainnet multi-action
  floor from the smart-account lab)
- run_sequence tx:
  `ChFXaJXHbmcz6vERCS8HcZqsVMR5f57AnodfLxQ6DmFV`
- downstream `social.near.set` receipts, oldest first:
  - block `194599850` step 3 -> `"Splash! Silence again"`
  - block `194599853` step 2 -> `"A frog jumps into the pond"`
  - block `194599856` step 1 -> `"An old silent pond"`
- proof_ordered: `true`
- final `post/main` content: `"An old silent pond"`
- feed:
  `https://near.social/simple-sequencer.sa-lab.mike.near`

The same 200-block yield window applies on mainnet, so repeat runs must
call `run_sequence` before the yielded callbacks time out (~4 minutes).
The script's default pre-run flow stays well under that.

## Safety notes

- **Fresh subaccount**, not `mike.near`. Per the repo's churn rule, a
  long-lived account that accumulates SocialDB state will eventually
  cross NEAR's `DeleteAccountWithLargeState` threshold and stop being
  cleanly deletable. A throwaway child keeps the variant reversible.
- **Storage griefing is bounded.** `yield_promise` is public with no caller
  allowlist, but every yielded entry is keyed by `caller_id` and self-
  clears on yield timeout (~4 min) via `PromiseError::Failed`. A burst
  can temporarily balloon sequencer state; it cannot permanently pin it.
- **Deposit attachment.** The sequencer's yielded social.near.set calls
  attach 0 yoctoNEAR. SocialDB writes silently fail if the sequencer's
  storage balance is exhausted. If a run fails with a confusing error,
  re-check `storage_balance_of(sequencer)` and top up.
- **Gas.** The default per-yield action gas (250 TGas) and downstream
  post gas (80 TGas) are set to stay well under the 1 PGas tx envelope.
  If you want to yield a longer poem than three lines, lower
  `--action-gas` so `n * action-gas <= 1000`.

## Future: post on your actual profile

In the default variant, the posts land at
`near.social/<sequencer-account>`, because SocialDB's permission check
uses `predecessor_id` (which is the sequencer contract, not the signer).

To make the posts land at `near.social/<your-account>` instead:

1. grant the sequencer write permission for your post paths:

   ```bash
   near call social.near grant_write_permission '{
     "predecessor_id": "simple-sequencer.sa-lab.mike.near",
     "keys": ["mike.near/post/main", "mike.near/index/post"]
   }' --accountId mike.near --deposit 0.001 --networkId mainnet
   ```

2. rerun `send-social-poem.mjs` with `--social-target-account mike.near`
   (flag not yet wired into the script; this is the next incremental
   step).

This intentionally stays out of the first pass because it adds
permission coupling that the sequencer demo does not need.
