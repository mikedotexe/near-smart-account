# smart-account-contract

A NEAR smart account for **cross-contract composition with explicit
trust boundaries**. Bundle function calls across any protocols into
one signed plan; gate each step with its own policy; halt cleanly on
any failure.

**Six composable primitives** on NEP-519 yield/resume — each answering
one explicit question about a cross-contract call:

| Question | Primitive | Scope |
|---|---|---|
| Can I trust this step's receipt? | `Direct` (default) | per step |
| Can an adapter collapse this step's messy async? | `Adapter { adapter_id, adapter_method }` | per step |
| Does this step need a post-resolve byte-equality check? | `Asserted { assertion_id, assertion_method, expected_return, … }` | per step |
| Should this step fire given live view state? | `PreGate { gate_id, gate_method, min_bytes, max_bytes, comparison }` | per step |
| Does step N+1's input come from step N's output? | `save_result` + `args_template` | per step |
| Who can sign this delegated call? | Session keys (annotated FCAK) | per account |

They compose orthogonally. One step can carry `PreGate` + `Asserted`
+ `args_template` + session-key auth simultaneously — each covers a
different branch of the cascade, each emits its own NEP-297 event.

## What you can't do with vanilla NEAR

Native batched Actions bundle multiple `FunctionCall`s in one tx, but
**all Actions must target one `receiver_id`** — you can't batch
`wrap.near.near_deposit` and `intents.near.execute_intents`
natively. Cross-contract workflows default to async fire-and-forget.

This smart account: **one signed plan → N steps across N contracts →
halt cleanly on any policy failure.** Step N+1 only fires after step
N's resolution surface settles AND its policy passes.

Verified live:
[`7btFS8LzGQUpHari3EnzCEvyr3dU3r4egKCsnPVZMgmJ`](https://www.nearblocks.io/txns/7btFS8LzGQUpHari3EnzCEvyr3dU3r4egKCsnPVZMgmJ)
is a three-step round-trip on `intents.near` in one user tx, with two
`Asserted` postchecks gating the sequence.

## Quickstart — onboard NEAR into your `intents.near` trading balance

Assumes you have a v3 smart account deployed (see
[`DEPLOY-SEQUENTIAL-INTENTS.md`](./DEPLOY-SEQUENTIAL-INTENTS.md)) and
your signer's key is registered on `intents.near`
([§intents.near gotcha](#intentsnear-gotcha-first-time-signers)).

```bash
./examples/sequential-intents.mjs \
  --signer mike.near \
  --smart-account sequential-intents.mike.near \
  --amount-near 0.01
```

One tx → smart account mints 0.01 wNEAR → deposits to `intents.near`
crediting the signer → pulls it back out via a NEP-413-signed
`ft_withdraw` intent. Each hop `Asserted` against a view on the target
protocol. Exit code `0` iff all balances match exactly.

## Flagship gallery — [`examples/`](./examples/README.md)

One script per primitive (or primitive combination):

- **[`sequential-intents.mjs`](./examples/sequential-intents.mjs)** —
  `Asserted` cascade. Three-step round-trip on `intents.near` in one
  user tx with two `mt_balance_of` / `ft_balance_of` postchecks.
- **[`wrap-and-deposit.mjs`](./examples/wrap-and-deposit.mjs)** —
  `Asserted` across protocols (wrap NEAR, deposit to Ref Finance).
- **[`dca.mjs`](./examples/dca.mjs)** — scheduled automation. Template
  + balance trigger; each tick runs a sequence.
- **[`limit-order.mjs`](./examples/limit-order.mjs)** — `PreGate`.
  Target fires only if a live view sits inside `[min_bytes, max_bytes]`.
- **[`ladder-swap.mjs`](./examples/ladder-swap.mjs)** — value threading.
  Step N captures its return; step N+1's args are derived from it at
  dispatch time (`Raw` / `DivU128` / `PercentU128`).
- **[`session-dapp.mjs`](./examples/session-dapp.mjs)** — session keys.
  Owner enrolls an ephemeral key scoped to `execute_trigger` with
  `{expires, fire_cap, trigger allowlist, label}`; delegate fires N
  times, no main-wallet prompts; owner revokes atomically.

Mainnet-validated runs (`Direct` / `Adapter` / `Asserted`) on
`sequential-intents.mike.near` logged in
[`MAINNET-V3-JOURNAL.md`](./MAINNET-V3-JOURNAL.md).
Testnet-validated runs (`PreGate` / threading / session keys) on
`sa-pregate` / `sa-threading` / `sa-session` subaccounts of
`x.mike.testnet`, 2026-04-19.

## The primitives in depth

- **[Chapter 14](./md-CLAUDE-chapters/14-wild-contract-compatibility.md)
  — `Direct` / `Adapter`.** Why the compatibility distinction exists;
  hidden async as the hazard; adapters as a deliberate collapse of a
  protocol's async into one honest top-level result.
- **[Chapter 21](./md-CLAUDE-chapters/21-asserted-resolve-policy.md)
  — `Asserted`.** Post-resolve byte-equality check on a caller-chosen
  view. Catches target-state pathologies (noop, decoy refund) that
  `Direct` is blind to. The load-bearing primitive for `intents.near`
  workflows — an `ft_transfer_call` can succeed at the receipt level
  while the verifier ledger refunds the deposit; only an
  `mt_balance_of` postcheck catches that drift.
- **[Chapter 23](./md-CLAUDE-chapters/23-pre-gate-policy.md)
  — `PreGate`.** Pre-dispatch view comparison: fire the target only
  if a view call's returned bytes fall inside `[min_bytes, max_bytes]`
  under `comparison` (`U128Json` / `I128Json` / `LexBytes`). Out of
  range → halt with zero target-side effect. A programmable
  limit-order engine without market exposure on the halt path.
- **[Chapter 24](./md-CLAUDE-chapters/24-value-threading.md)
  — `save_result` + `args_template`.** Step N+1's args materialized
  at dispatch time from step N's return bytes, via a substitution
  engine (`Raw` / `DivU128` / `PercentU128`). Enables result-
  dependent sequences like ladder-swaps and allowance-drains without
  an off-chain read-then-sign loop.
- **[Chapter 25](./md-CLAUDE-chapters/25-session-keys.md) + top-level
  [SESSION-KEYS.md](./SESSION-KEYS.md) — session keys.** Annotated
  function-call access keys minted by the smart account itself; each
  key carries a `SessionGrant` with `{expires, fire_cap, allowlist,
  label}`, enforced at the top of `execute_trigger`. NEAR's native
  FCAK allowance plus a semantic policy layer — "fire
  `dca-weekly-eth` up to 10 times over the next hour, then the key
  is dead."

## How the kernel works — one paragraph

`execute_steps(steps)` is a facade: it registers each step as a
yielded receipt (`env::promise_yield_create`) under the caller's
namespace, then triggers ordered release. Each registered step waits
in yielded state until the kernel resumes it. On resume, any
`PreGate` fires first; if the gate passes (or is absent), the step's
args are materialized from the sequence context (if an
`args_template` is present) and dispatched cross-contract. When the
downstream call settles, `on_step_resolved` inspects the resolution
surface (plus any `Asserted` postcheck), optionally saves the return
bytes if `save_result` is set, and either advances or halts with a
distinct `error_kind` tag. That's the whole mechanism.

[Chapter 18](./md-CLAUDE-chapters/18-keep-yield-canonical.md) is the
canonical lifecycle walkthrough.

## `intents.near` gotcha — first-time signers

`intents.near` maintains **its own per-account public-key registry,
independent of on-chain access keys.** A signer's first
`execute_intents` call will panic with `public key '<pk>' doesn't
exist for account '<signer>'` unless they first register via a
direct call:

```bash
near call intents.near add_public_key \
  '{"public_key":"ed25519:<your-pk>"}' \
  --accountId <your-account> --depositYocto 1 --gas 30000000000000
```

View `intents.near.public_keys_of({account_id})` to inspect what's
registered. Discovered by battletest B6; see
[§10.8 of the design note](./SEQUENTIAL-INTENTS-DESIGN.md#108--critical-finding--intentsnear-per-account-public-key-registry).

## Validated on mainnet

**`mike.near` itself runs the v4 kernel as of 2026-04-19**
(currently at `v4.0.2-ops`). Every new primitive has a live
reference run with block-hash anchors anyone can verify on an
archival NEAR RPC — see
[`MAINNET-PROOF.md`](./MAINNET-PROOF.md) for the three reference
artifacts (PreGate / value threading / session keys) plus
copy-paste `curl` recipes that return the expected events.
Full tx log in
[`MAINNET-MIKE-NEAR-JOURNAL.md`](./MAINNET-MIKE-NEAR-JOURNAL.md);
deploy recipe in
[`DEPLOY-MIKE-NEAR.md`](./DEPLOY-MIKE-NEAR.md).

`sequential-intents.mike.near` (v3) — deployed 2026-04-18, owner
`mike.near`. Eight battletests covered the kernel's halt +
idempotency + automation edges. Covers `Direct` / `Adapter` /
`Asserted` surfaces. Every tx hash in
[`MAINNET-V3-JOURNAL.md`](./MAINNET-V3-JOURNAL.md); design
observations in [`SEQUENTIAL-INTENTS-DESIGN.md`](./SEQUENTIAL-INTENTS-DESIGN.md)
§10.

## Execution delegation — not signing delegation

The owner can grant another account execution rights (`run_steps`,
`execute_trigger`) without granting any signing rights. The
`authorized_executor` is an execution delegate only; session keys
extend this to any ephemeral ed25519 keypair with a `SessionGrant`
annotation.

## Layout

| Path | What lives here |
|---|---|
| `contracts/smart-account/` | The kernel. All six primitives; `execute_steps` facade, manual `register_step`/`run_steps`, balance-trigger automation, session-key auth hub. |
| `contracts/compat-adapter/` | Real external-protocol adapter surface (the `Adapter` primitive); currently wrap-specific. |
| `contracts/demo-adapter/` | Demo-only adapter for `wild-router`. |
| `contracts/echo/` | Trivial callee used as a downstream leaf in trace demos. |
| `contracts/router/` | Flat promise-shape demo (single-hop, `.then()`, `promise_and`). |
| `contracts/wild-router/` | Dishonest-async demo: fires real work but doesn't return the promise chain. |
| `contracts/pathological-router/` | Public probe for wild-contract taxonomy; also the predictable-counter surface for `PreGate` + threading demos. |
| `types/` | `smart-account-types` — shared shapes for `StepPolicy`, `PreGate`, `SaveResult`, `ArgsTemplate`, `Substitution`, `SubstitutionOp`, `MaterializeError`, and pure helpers (`evaluate_pre_gate`, `materialize_args`). |
| `examples/` | Runnable flagships, one per primitive or combination. See [`examples/README.md`](./examples/README.md). |
| `scripts/` | Build/deploy + FastNEAR observability toolkit. See [`scripts/README.md`](./scripts/README.md). |
| `scripts/lib/nep413-sign.mjs` | NEP-413 signing helper used by `sequential-intents.mjs` to sign inner intents. |
| `web/` | Static-HTML receipt-DAG viewer (no bundler). |
| `simple-example/` | Nested mini-workspace — the bare yield/resume kernel isolated from the main product. |
| `md-CLAUDE-chapters/` | Long-form design chapters, one per primitive. See [chapter map](./md-CLAUDE-chapters/README.md). |
| `collab/` | Team handoff notes + curated reference artifacts. |
| `res/` | Built wasm outputs. Rebuildable; not tracked. |

## Commands

```bash
cp .env.example .env          # paste FASTNEAR_API_KEY; stays out of git
./scripts/check.sh            # cargo check + cargo test (workspace) + node unit tests
cargo test --workspace        # all Rust tests
./scripts/build-all.sh        # release wasm → res/*_local.wasm
MASTER=x.mike.testnet ./scripts/deploy-testnet.sh   # shared testnet rig
python3 -m http.server 8000 -d web                  # serve the trace viewer
```

The flagship scripts under `examples/` auto-load `.env` and drop
full JSON artifacts to `collab/artifacts/` on every live run.

## Further reading

- [`SISTER-REPOS.md`](./SISTER-REPOS.md) — three-repo positioning: this repo, [`near-sequencer-demo`](../near-sequencer-demo/), [`manim-visualizations`](../manim-visualizations/).
- [`INTENTS.md`](./INTENTS.md) — positioning note: this smart account vs `intents.near`, when to use which.
- [`SESSION-KEYS.md`](./SESSION-KEYS.md) — annotated-FCAK session-key walkthrough (enroll → fire → revoke, safety model).
- [`PROTOCOL-ONBOARDING.md`](./PROTOCOL-ONBOARDING.md) — adding a new protocol as a step; primitive decision tree.
- [`DEPLOY-SEQUENTIAL-INTENTS.md`](./DEPLOY-SEQUENTIAL-INTENTS.md) — seven-phase mainnet deploy recipe.
- [`DEPLOY-MIKE-NEAR.md`](./DEPLOY-MIKE-NEAR.md) — two-phase recipe for deploying v4 to the `mike.near` root identity account.
- [`SEQUENTIAL-INTENTS-DESIGN.md`](./SEQUENTIAL-INTENTS-DESIGN.md) — design doc for the flagship `intents.near` round-trip: surface map, battletest findings, §10 critical discoveries.
- [`MAINNET-V3-JOURNAL.md`](./MAINNET-V3-JOURNAL.md) — every on-chain tx landed against `sequential-intents.mike.near`, with block ranges for archival lookup.
- [`MAINNET-MIKE-NEAR-JOURNAL.md`](./MAINNET-MIKE-NEAR-JOURNAL.md) — tx log for the v4 kernel on `mike.near` itself (Phase 1 lab → Phase 2 identity → Phase 3 ops migrate).
- [`MAINNET-PROOF.md`](./MAINNET-PROOF.md) — three curated reference artifacts (one per new v4 primitive) with copy-paste `curl` recipes that resolve on any public archival RPC — definitive, independent verifiability.
- [`HARDENING-REVIEW.md`](./HARDENING-REVIEW.md) — candid repo-shape critique.
- [`START-HERE.md`](./START-HERE.md) — shortest reading path.
- [`md-CLAUDE-chapters/README.md`](./md-CLAUDE-chapters/README.md) — chapter map: one chapter per primitive.
- [`simple-example/README.md`](./simple-example/README.md) — the bare `register_step`/`run_sequence` loop, no facade.

We're still early in the dev cycle — probing the solution space for
signal, not shipping yet. `sequential-intents.mike.near` is a lab
account; nothing in this repo is load-bearing as production
infrastructure.
