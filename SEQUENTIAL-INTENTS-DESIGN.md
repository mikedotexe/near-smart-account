# Sequential NEAR Intents via yield/resume — design note

Status: **decision doc**. Terminates in a flagship recommendation (§5) and concrete Pass-2 work items (§7). This note is the gate for Pass 2 of the reshape plan.

## 1 · What we're trying to show

A NEAR smart account built on NEP-519 yield/resume can **fire a sequence of `intents.near` operations in a deliberate order, with each step gated by the previous one's settled state on the verifier ledger** — in a single caller-initiated transaction.

Default NEAR cross-contract semantics: async, unordered, no halt-on-failure across separate calls. Our smart account makes a chain of operations atomic-or-halted as a user-visible unit. `intents.near` on its own provides atomicity *inside* a single `execute_intents` batch; our kernel provides ordering *across* batches and *across protocols*.

## 2 · `intents.near` surface map

Researched from docs.near-intents.org (2026-04-18 snapshot) and github.com/near/intents (`contracts/defuse/src/intents.rs`).

### 2.1 Entry points on `intents.near`

```rust
// defuse_contract::Intents trait
fn execute_intents(&mut self, signed: Vec<MultiPayload>);
fn simulate_intents(&self, signed: Vec<MultiPayload>); // view — useful for pre-check
```

`MultiPayload` is the outer NEP-413 envelope; the inner payload carries one or more intents. `simulate_intents` is a view method — it can dry-run an intent batch without committing, which is relevant for our `Asserted` story (see §3).

### 2.2 Deposit (no signed intent required)

`ft_transfer_call(receiver_id="intents.near", amount, msg)` on a NEP-141 token contract, where `msg` is a string. Three `msg` shapes:

1. Empty string — ownership goes to tx sender.
2. A bare account-id string (e.g. `"bob.near"`) — ownership goes to that account.
3. JSON-encoded **DepositMessage** object:
   ```json
   { "receiver_id": "<account>",
     "execute_intents": [<signed intents to run inline>],
     "refund_if_fails": true }
   ```

NFT and multi-token deposits use `nft_transfer_call` / `mt_batch_transfer_call` with the same `msg` semantics. Native NEAR must be wrapped first (`wrap.near.near_deposit`).

Our flagship (formerly `intent-onboard.mjs`, now `sequential-intents.mjs`) uses shape (3) with `execute_intents` omitted — i.e. a plain deposit that credits `receiver_id`, with `refund_if_fails: true` as a safety net for future inline extensions.

### 2.3 Withdraw (signed intent OR direct call)

Two paths:

- Signed intent via `execute_intents` — e.g. `ft_withdraw`:
  ```json
  { "intent": "ft_withdraw",
    "token": "wrap.near",
    "receiver_id": "alice.near",
    "amount": "1000" }
  ```
- Direct function call on the verifier (not yet spec'd in this note — `execute_intents` path is sufficient for flagship).

The signed-intent path is what we'll use — it keeps the flagship uniform (every non-deposit step is an `execute_intents` call).

### 2.4 Intent types available

From the docs (`integration/verifier-contract/intent-types-and-execution`):

| Intent | Signer-alone? | Purpose |
|---|---|---|
| `transfer` | ✓ | Intra-`intents.near` balance move between accounts |
| `token_diff` | ✗ (needs counterparty) | Swap primitive — diff across token set must sum to zero |
| `ft_withdraw` | ✓ | Withdraw NEP-141 out to a NEAR account; supports `msg`, `storage_deposit`, `memo` |
| `nft_withdraw` | ✓ | NEP-171 withdrawal |
| `mt_withdraw` | ✓ | NEP-245 withdrawal |
| `native_withdraw` | ✓ | Unwrap-and-send native NEAR out |
| `storage_deposit` | ✓ | Register signer on an external contract (useful before `ft_withdraw` to an unregistered destination) |
| `add_public_key` / `remove_public_key` | ✓ | Signer auth management |

**Signer-alone** means the intent can be signed and submitted by the signer with no counterparty. `token_diff` (swap) requires a matching counter-diff — in practice this means a solver (e.g. the 1Click service) returns a paired intent that settles atomically.

### 2.5 Signed intent envelope (NEP-413)

```
{
  "standard": "nep413",
  "payload": {
    "recipient": "intents.near",
    "nonce": "<base64 256-bit>",
    "message": "<JSON-serialized inner>"
  },
  "public_key": "ed25519:...",
  "signature": "ed25519:..."
}
```

Inner `message` (also JSON):
```
{ "signer_id": "user.near",
  "deadline": "2025-05-20T13:29:34.360380Z",
  "intents": [<intent objects>] }
```

Key properties:
- `recipient` prevents cross-contract replay.
- `nonce` is 256 bits, base64-encoded; paired with `deadline` it prevents replay and expiry abuse.
- Any public key registered to `signer_id` can sign. The submitter can be anyone (relayer pattern). **This is what lets our smart account submit intents on the user's behalf without the user needing to co-sign the outer tx.**
- Encoding: `message` is a serialized JSON string; the outer envelope is also JSON. Signatures use `ed25519:` + base58.

### 2.6 View surface (live-probed on mainnet, see compact summary)

| Method | Status | Use |
|---|---|---|
| `mt_balance_of({account_id, token_id})` | ✓ live | Single-asset balance check — the load-bearing `Asserted` postcheck |
| `mt_batch_balance_of({account_id, token_ids})` | ✓ live | Multi-asset balance check — useful for cross-asset assertions |
| `mt_metadata_by_token_id({token_ids})` | ✗ `MethodNotFound` | Not implemented on `intents.near` — callers pre-know token IDs |
| `simulate_intents(signed: Vec<MultiPayload>)` | confirmed in source | Dry-run a batch without committing (potential future Asserted dry-run use) |

Token-id convention: `nep141:<contract>` for wrapped FTs. E.g. `nep141:wrap.near` is the user's wNEAR position on `intents.near`.

## 3 · What yield/resume uniquely adds on top

`intents.near` itself provides:
- Atomicity *inside* a single `execute_intents` batch. `token_diff` must sum to zero across the batch, which makes a solver-mediated swap atomic: user gets target token ↔ solver gets source token, or the whole batch reverts.
- Ordered execution *of the intents list itself* inside one call.

What `intents.near` does **not** provide:
- Cross-batch ordering. If you call `execute_intents` twice from separate txs, the second may reach the verifier before the first settles (NEAR's async cross-contract semantics).
- State-asserted advancement across calls. Without a kernel like ours, you can't say "run batch B only if after batch A, `mt_balance_of` reads exactly X."
- Cross-protocol gating. If step 1 is `intents.near`, step 2 is Ref Finance, step 3 is `intents.near`, default NEAR gives you no way to sequence them with halt-on-failure.

What our kernel adds:

1. **Cross-call ordering across the verifier.** A plan with steps `[execute_intents(A), execute_intents(B)]` fires B only after A's resolution surface resolves. Not possible in vanilla NEAR.
2. **State-asserted advancement.** Each step can carry `Asserted { intents.near.mt_balance_of, expected: <bytes> }`. If the solver partially filled, filled at a worse price, or didn't fill at all, the postcheck catches it and halts.
3. **Cross-protocol gating.** The same kernel sequences `intents.near` with wrap.near, Ref, Burrow, or any other protocol. Composition extends beyond intents.
4. **Session-level atomicity.** One tx from the user initiates the whole plan. If step 2 halts, step 3 doesn't fire — funds don't strand as they would across three independent user txs.

What we **don't** add:
- In-batch atomicity — that's intents.near's ledger property (`token_diff` sum-to-zero). We submit the batch as-is.
- Solver substitution — we don't change what a solver does.

Phrased for the README: **`intents.near` gives you atomic intent batches; our smart account gives you atomic sequences of batches, asserted at each hop.**

## 4 · Signing UX for flagship scripts

**Decision: Option A — in-script NEP-413 signing using the signer's near-credentials ed25519 key.**

Options considered:

- **(A) In-script signing.** Our scripts already load the signer's full-access key from `~/.near-credentials` via `scripts/lib/near-cli.mjs`. The same ed25519 key signs NEP-413 messages directly — no wallet round-trip, no external service. Requires a ~50-line helper `scripts/lib/nep413-sign.mjs` exposing `signNep413(signer, inner_message) → MultiPayload`. Reusable across all flagships.
- **(B) Pre-signed intents as args/file.** User signs outside the script and passes bytes in. Flexible but adds a manual step that breaks the "one command, full demo" ergonomic.
- **(C) Hardcoded dev-time signed intents.** Demo-only; not a real path. Rejected.

Choice: **A**. Rationale:
- Flagship UX stays single-command.
- The same signer that owns funds on `intents.near` is the one who holds the key in credentials — so "sign as self" is the natural pattern.
- The helper is small and will be reused by every subsequent flagship that involves signed intents.
- Canonicalization (JSON-serialize inner, base64 nonce, ed25519 over payload) is directly implementable with Node's `crypto` module and `near-api-js` KeyPair primitives.

Caveat: if we ever want the smart account itself to sign intents (agent flows, non-custodial automation), we revisit — that would need on-chain signing primitives or a delegated-key model. For now the human signer signs; the smart account submits.

## 5 · Flagship shape — evaluation and recommendation

### 5.1 Candidates revisited

| Tag | Shape | Signer-alone? | Live-buildable without 1Click? |
|---|---|---|---|
| FS-1 Onboard+Trade | Deposit → solver-mediated swap | No — solver needed | ✗ |
| FS-2 Chained swaps | Swap A→B, swap B→C | No — two solver batches | ✗ |
| FS-3 Full journey | Deposit → swap → withdraw | No for the swap | ✗ |
| FS-4 Cross-protocol | `intents.near` swap + Ref/Burrow | No for the swap | ✗ |
| **FS-5 Round-trip** | Deposit → withdraw back | **Yes** (one signed `ft_withdraw`) | **✓** |
| FS-6 Deposit + internal transfer + withdraw | Deposit → `transfer` → `ft_withdraw` | Yes (two signed intents) | ✓ |

FS-1–FS-4 all require a solver (1Click API integration). That integration needs its own research pass — the 1Click public endpoints partially 404'd during this research, so we don't yet know whether a developer can pull a signed pair and submit via their own tx or whether 1Click always broadcasts server-side. **Not blocked on** — we'll reach it — but not the right gate for Pass 2.

FS-5 and FS-6 are solver-free and buildable now.

### 5.2 Recommendation — **FS-5 Round-Trip (as primary v1 flagship)**

**Plan shape:** a two-step sequence demonstrating cross-call ordering and state-asserted advancement, no solver required.

```
Step 1 (no signed intent):
  wrap.near.ft_transfer_call
    receiver_id = intents.near
    amount      = N
    msg         = '{"receiver_id": signer, "refund_if_fails": true}'
  attached     = 1 yocto
  policy       = Asserted
    assertion  = intents.near.mt_balance_of({account_id: signer, token_id: "nep141:wrap.near"})
    expected   = (prev + N) as U128 JSON string

Step 2 (signed ft_withdraw intent via execute_intents):
  intents.near.execute_intents
    signed = [MultiPayload({
      inner = { signer_id: signer, deadline: +5min, intents: [
        { intent: "ft_withdraw",
          token:  "wrap.near",
          receiver_id: signer,
          amount: "<N>" }
      ]}
    })]
  policy = Asserted
    assertion = wrap.near.ft_balance_of({account_id: signer})
    expected  = (prev_wrap_balance + N) as U128 JSON string
```

Why this wins as v1:
- **Shows ordering genuinely** — without our kernel, the `ft_withdraw` might race the deposit (insufficient-balance error on the verifier). Our kernel asserts deposit-settled before firing withdraw.
- **Shows two-sided asserting** — first step asserts on `intents.near`'s ledger via `mt_balance_of`; second step asserts on the wallet ledger via `ft_balance_of`. Both bases covered.
- **Self-contained** — no external API, no pre-existing balance, no solver. A developer can `./examples/sequential-intents.mjs --signer me --amount-near 0.01` and the whole demo runs end-to-end.
- **Real dependency** — the withdraw actually *needs* the deposit to have settled, so the ordering isn't ceremonial; it's load-bearing.
- **Upgrade path** — once 1Click research lands, FS-5's second step becomes an `execute_intents` carrying a solver-supplied `token_diff` pair, upgrading round-trip to round-trip-with-swap. Same kernel, same assertion pattern, one intent shape swapped.

FS-6 (add an intra-intents.near `transfer` between deposit and withdraw) is a nice extension that shows **two** signed intents in sequence. Recommend: bake in a `--with-transfer <recipient>` optional flag that turns FS-5 into FS-6 in one line. Default stays FS-5.

### 5.3 Rename

- `examples/intent-onboard.mjs` (original onboard-only flagship) → **`examples/sequential-intents.mjs`** (round-trip primary).
- Purpose of the file expands: v1 ships round-trip (FS-5 / FS-6 behind flag). v2 adds `--swap-via-oneclick` for solver-mediated swaps once research lands. File stays canonical.
- `examples/wrap-and-deposit.mjs` — header-only reframe as the "no `intents.near` required" cross-protocol counterpoint. Mechanics unchanged.

## 6 · Open questions (not blockers for Pass 2)

These stay open; none gate the FS-5 build.

- **1Click API surface.** Does it return a signed intent pair the developer can submit via their own tx, or does it always broadcast server-side? Resolve before FS-1 upgrade. Endpoints partially 404'd — likely needs direct OpenAPI spec fetch or an email to the intents team.
- **Nonce management across long plans.** NEP-413 nonce is per-signer replay-prevention. If a plan signs intent A with nonce X and intent B with nonce Y, the verifier checks both at submission time. Question: does the verifier treat nonces as strictly-ascending or just not-previously-seen? Matters for concurrent plans from the same signer. Resolve before FS-6 lands (two signed intents from same signer).
- **Deadline semantics in multi-hop plans.** Intent signed with `deadline = now + 5min`. If step 1 takes 4 minutes to settle and step 2 fires at minute 4.5, its deadline has 30s to resolve on the verifier. How tight can we go? Live-probe during FS-5 live run.
- **Withdraw destination storage.** `ft_withdraw` to an unregistered NEP-141 account fails. Our signer's own wNEAR storage is already registered (they hold wNEAR to deposit). Preflight check is `wrap.near.storage_balance_of(signer)` before submission. Add to FS-5 preflight.
- **`simulate_intents` as an Asserted dry-run.** Could a future `StepPolicy::SimulatedAsserted` use `simulate_intents` to verify an intent will settle *before* firing `execute_intents` itself? Powerful pattern — defer as future design.

## 7 · Pass-2 work items (commit after this note is approved)

1. **NEW** `scripts/lib/nep413-sign.mjs` — signing helper: `signNep413(signer, innerMessage) → MultiPayload`. ~50 lines. Unit-tested with a fixed test vector.
2. **RENAME** `examples/intent-onboard.mjs` → `examples/sequential-intents.mjs`. Rebuild around FS-5 (deposit + ft_withdraw, both Asserted). Preserve existing DepositMessage + `mt_balance_of` scaffolding. Add `--deposit-only` flag for the prior minimal-mode case.
3. **RENAME-HEADER** `examples/wrap-and-deposit.mjs` — header comment only. Rebrand as "cross-protocol atomic composition — sequential kernel works beyond `intents.near`."
4. **NEW** `examples/dca.mjs` — scheduled variant of `sequential-intents.mjs`. Same FS-5 plan saved as a template, fired periodically via balance triggers.
5. **NEW** `examples/README.md` — gallery index. Primary: `sequential-intents.mjs`. Secondary: `wrap-and-deposit.mjs`. Scheduled: `dca.mjs`.
6. **LIVE-VALIDATE** `sequential-intents.mjs` against mainnet `intents.near` + `wrap.near` on a fresh v3 smart account (`sequential-intents.mike.near`) at small stakes (0.01 NEAR). Capture tx hashes for the README.

Gate for Pass 2 ship: all of (1)–(5) pass `./scripts/check.sh` and dry-run produces valid artifacts. Live-validate (6) before Pass 3 docs reshape.

## 8 · Out of scope for this note

- Implementation of a `StepPolicy::SimulatedAsserted` variant (deferred future design).
- Solver / 1Click integration (next research pass, post Pass 2 ship).
- Multi-signer / agent-delegated signing flows (requires kernel changes; not in reshape scope).
- Withdraw via direct function call on the verifier (we standardize on `execute_intents` + `ft_withdraw` intent).

## 9 · Sources

- https://docs.near-intents.org/integration/verifier-contract/deposits-and-withdrawals (deposits summary)
- https://docs.near-intents.org/integration/verifier-contract/deposits-and-withdrawals/withdrawals (ft_withdraw example)
- https://docs.near-intents.org/integration/verifier-contract/intent-types-and-execution (intent types list)
- https://docs.near-intents.org/integration/verifier-contract/signing-intents (NEP-413 envelope)
- https://raw.githubusercontent.com/near/intents/main/contracts/defuse/src/intents.rs (Intents trait: `execute_intents`, `simulate_intents`)
- Live mainnet probes via `./scripts/state.mjs intents.near` at block ~194627000 (compact summary).
- Existing flagship (now `examples/sequential-intents.mjs`, formerly `intent-onboard.mjs`) — DepositMessage shape and Asserted wire format proven.
