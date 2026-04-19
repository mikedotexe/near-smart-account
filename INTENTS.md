# INTENTS.md — this smart account vs `intents.near`

Positioning note. Who does what, where they overlap (spoiler: they
don't), when to use which, and how the flagship uses both together.

## One sentence each

- **`intents.near`** is the mainnet-deployed **Defuse Verifier** — a
  settlement + solver economy where users sign NEP-413 messages off
  chain, solvers compose a matching tx, and the verifier guarantees
  atomic settlement on its internal ledger. Deposits, swaps,
  withdrawals are all expressed as signed intents executed by
  `execute_intents(...)`.
- **This smart account** is a **sequencer client** — an on-chain
  account whose `execute_steps(steps)` facade uses NEP-519
  yield/resume to fire a multi-step plan across any combination of
  contracts (including `intents.near`) in a deliberate order, with
  each step gated by the previous one's settled state.

They live at different layers. `intents.near` is what happens *inside*
one signed intent; the sequencer is what happens *across* multiple
calls in a single user tx.

## What `intents.near` already gives you

Worth naming so we're honest about what we're **not** re-inventing:

- **Signed-message UX.** A user signs a NEP-413 payload off chain; any
  relayer can submit it. The on-chain account never has to hold the
  signing key for the settlement path.
- **Atomic batched intents inside one `execute_intents` call.** If the
  call includes a deposit, a swap, and a withdrawal as three signed
  intents, the verifier settles them atomically or not at all. You
  don't need our kernel to batch *within* one signed intent.
- **`token_diff` swap semantics.** The verifier matches opposing
  `token_diff` intents across signers to produce atomic swaps without
  a solver-run AMM. This is the core of the `intents.near` product —
  we have no equivalent primitive and aren't trying to.
- **Per-account public-key registry.** The verifier maintains its own
  allowlist independent of on-chain access keys (see SEQUENTIAL-INTENTS-DESIGN.md §10.8).
- **Ledger of balances by `(account_id, token_id)`** queryable via
  NEP-245 `mt_balance_of` / `mt_batch_balance_of`.

If your whole workflow can live inside a single `execute_intents` call,
you do not need a sequencer.

## What this smart account adds on top

The sequencer is only interesting when you need ordering or
post-state gating **across** `execute_intents` calls, or **between**
`execute_intents` and a non-`intents.near` contract.

- **Cross-tx ordering across separate `execute_intents` calls.** A
  single `execute_intents` is atomic with itself, but two back-to-back
  `execute_intents` calls are just async receipts. Our kernel forces
  the second to wait on the first's resolution surface.
- **Atomic halt on `Asserted` mismatch.** `ft_transfer_call` into
  `intents.near` can succeed at the receipt level while the verifier
  ledger refunds the deposit. `Direct` policy would pass that through;
  `Asserted` with an `mt_balance_of` postcheck catches the drift and
  halts the sequence before step N+1 fires. Proven live by battletest
  B4 in `SEQUENTIAL-INTENTS-DESIGN.md §10.2`.
- **Cross-protocol sequencing.** `intents.near` deposits from NEAR
  require wrapping first (`wrap.near.near_deposit` → `ft_transfer_call`
  to `intents.near`). Our kernel sequences both hops in one user tx
  with `Direct` on the wrap and `Asserted` on the deposit.
- **Balance-trigger automation.** `save_sequence_template` +
  `create_balance_trigger` + `execute_trigger` let an authorized
  executor re-fire the same signed plan when the smart account's
  balance crosses a threshold. Useful for DCA, scheduled rebalances,
  any "fire this plan periodically" workflow. Execution is delegated;
  signing is not.

## What this smart account does **not** add

Also worth naming so we stay honest about scope:

- **No solver.** We're a sequencer client, not a market-maker. The
  flagship's swap-style step would rely on `intents.near`'s solver
  economy or on a future 1Click integration (see
  `SEQUENTIAL-INTENTS-DESIGN.md §6` open questions).
- **No verifier.** We don't re-implement the `intents.near` atomic
  settlement ledger. An `Asserted` postcheck is a byte-equality check,
  not a settlement guarantee.
- **No signing delegation.** The owner can grant another account
  *execution* rights (`run_sequence`, `execute_trigger`) without granting
  any *signing* rights. The automation path never holds the user's
  NEP-413 signing key.
- **No batching substitute within one `execute_intents`.** If you can
  express your whole workflow as three signed intents inside one
  `execute_intents` call, the verifier gives you atomic batching for
  free. Use that; don't sequence it.

## Decision matrix

| Your workflow | Use |
|---|---|
| One signed intent, self-contained (e.g., a single `token_diff` swap with a solver) | Just `intents.near` directly. No sequencer needed. |
| Multiple signed intents that can fit in one `execute_intents` call (deposit + swap + withdraw expressed as signed intents) | Just `intents.near` — atomic inside one call |
| Cross-protocol — one step on `intents.near`, next on a non-`intents.near` contract (Ref, Burrow, a wrap, anything) | Sequencer. Only way to get ordering across protocols. |
| Two `execute_intents` calls where step N+1 depends on step N's *post-settled state* | Sequencer with `Asserted` on step N. Direct async would race. |
| Recurring / scheduled variant of any of the above | Sequencer + `create_balance_trigger` + authorized executor. |
| Deposit NEAR (not wNEAR) into `intents.near` | Sequencer. NEAR must be wrapped first, so you have at least two hops that must land in order. |

## Worked example — the flagship round-trip

`examples/sequential-intents.mjs` is the canonical case where both
layers are load-bearing together:

1. **`wrap.near.near_deposit`** — `Direct`. `intents.near` is
   concerned, just needs its downstream dependency wrapped.
2. **`wrap.near.ft_transfer_call` → `intents.near`** — `Asserted` on
   `intents.near.mt_balance_of(account, nep141:wrap.near)`. This is
   where the verifier credits the deposit. Asserted because a
   receipt-level success without a balance credit is a real
   battletest failure mode.
3. **`intents.near.execute_intents(...)`** signed `ft_withdraw` — a
   normal `intents.near` operation. `Asserted` on
   `wrap.near.ft_balance_of(destination)` because a signed withdraw
   intent can land while the inner `ft_transfer` is still in flight
   or fails downstream.

Steps 2 and 3 are both "normal `intents.near` things" — we're not
replacing them. The sequencer's job is the glue:

- step 1 → step 2 can only happen if the wrapped balance lands
- step 2 → step 3 can only happen if the verifier actually credited
- step 3 → sequence end can only happen if the withdrawal's inner
  `ft_transfer` actually delivered

Verified live at `7btFS8LzGQUpHari3EnzCEvyr3dU3r4egKCsnPVZMgmJ`.

## Pointers

- [`SEQUENTIAL-INTENTS-DESIGN.md`](./SEQUENTIAL-INTENTS-DESIGN.md) —
  decision doc. §1 is the `intents.near` surface map, §10 is the
  battletest findings (halt semantics, outcome taxonomy, halt latency,
  key-registry gotcha).
- [`PROTOCOL-ONBOARDING.md`](./PROTOCOL-ONBOARDING.md) — how to add a
  new step against any protocol (intents.near or otherwise).
- [`examples/sequential-intents.mjs`](./examples/sequential-intents.mjs)
  — the flagship round-trip described above, runnable.
- [https://docs.near-intents.org/](https://docs.near-intents.org/) —
  upstream `intents.near` documentation (solver economy, signed intent
  wire formats, verifier settlement).
