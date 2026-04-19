# SISTER-REPOS.md — the three-repo picture

Three NEAR repositories that all ride NEP-519 yield/resume. Each
exists at a distinct abstraction level. They stack; they do not
overlap; they are not competing drafts.

## Thesis

One primitive. Three repos. Three audiences.

| Layer | Repo | What a reader gets |
|---|---|---|
| **Primitive, as pedagogy** | [`near-sequencer-demo`](../near-sequencer-demo/) | Four NEP-519 recipes isolating one conceptual beat each; machine-checked DAG-placement invariant; testnet-only |
| **Product** | **`smart-account-contract`** (this repo) | NEAR smart account as composable policy surface: six primitives (`Direct` / `Adapter` / `Asserted` / `PreGate` / value threading / session keys), `execute_steps` facade, automation; mainnet-validated on `sequential-intents.mike.near` |
| **Model, as pedagogy** | [`manim-visualizations`](../manim-visualizations/) | Orbital-mechanics animations for any NEP-519 receipt DAG; live-trace translation; four-tier visual QA |

A new reader lands in whichever repo the outside world pointed them
at. This note makes the other two legible from here.

## At a glance

### `near-sequencer-demo` — the primitive

Compact teaching artifact. Four recipes — **basic**, **timeout**,
**chained**, **handoff** — each isolating exactly one conceptual beat
of NEP-519 yield/resume. Uses the raw NEP-519 primitive
(`Promise::new_yield(...)`, `yield_id.resume(payload)`) without
introducing product-level abstractions. Machine-checks the
DAG-placement invariant: every trace event emitted by callback code
lives in the **YIELD** tx's receipt DAG, not the resume tx's.
Testnet-only by design — static teaching artifacts don't belong in
archival.

Audience: *"I want a working mental model of yield/resume before I
build on it."*

### `smart-account-contract` — the product (this repo)

NEAR smart account shipping **six composable primitives** on NEP-519
yield/resume, each answering one explicit question about a
cross-contract call:

- **Execution trust** — `Direct` / `Adapter` / `Asserted`
  (post-resolve byte-equality on a caller-chosen view)
- **Pre-dispatch gating** — `PreGate` (fire the target only if a live
  view sits in range; programmable limit-order engine)
- **Value threading** — `save_result` + `args_template` (step N+1's
  args derived from step N's return)
- **Auth delegation** — session keys (annotated function-call access
  keys with expiry / fire-cap / trigger-allowlist enforcement)

`execute_steps(steps)` facade over the kernel; automation surface
(templates, balance triggers, execution delegation, session-key auth
hub); `sequential-intents.mike.near` is mainnet-validated for
`Direct` / `Adapter` / `Asserted` (see
[`SEQUENTIAL-INTENTS-DESIGN.md`](./SEQUENTIAL-INTENTS-DESIGN.md)).
`PreGate` / threading / session keys are testnet-validated on fresh
subaccounts of `x.mike.testnet`.

Audience: *"I need to compose real multi-contract plans on mainnet
with explicit per-step trust boundaries and per-account delegation."*

### `manim-visualizations` — the model

Orbital-mechanics animation pipeline. Contracts render as liquid
spheres; yielded callbacks as satellites in orbit around them; the
200-block yield budget as orbital decay. Every visual channel is
pinned to a protocol primitive — decorative motion is explicitly
disallowed (see that repo's `PIPELINE.md` §0.1). Includes a live-trace
translation pipeline: paste any testnet/mainnet tx hash, get a
timeline JSON, render a Manim scene. Four-tier QA gate enforces five
fatal visual invariants at render time (safe frame, no overlap, no
label overflow, satellite hygiene, ephemera hygiene).

Audience: *"I want to see how yield/resume unfolds, or I'm teaching
someone who's never held it in their head."*

## Side-by-side

| Dimension | `near-sequencer-demo` | `smart-account-contract` (here) | `manim-visualizations` |
|---|---|---|---|
| Layer | Primitive, as pedagogy | Product | Model, as pedagogy |
| Scope | 4 recipes, one contract | Full smart-account + automation | Animation pipeline + live-trace translation |
| Network | Testnet-only | Mainnet-validated | Testnet (mainnet archival infra, no scenes yet) |
| Contracts? | `recipes` + `counter` | 6 crates (kernel + adapters + routers + echo) | None — visualization only |
| Flagship script? | `scripts/src/demo.ts` | `examples/sequential-intents.mjs` | `scripts/pull-trace.mjs` + scene renders |
| Animations? | Yes (vendored from `manim-visualizations`) | None | Yes (primary output) |
| Key novelty | DAG-placement machine-check | Six orthogonal primitives composing on one step | Orbital metaphor + visual QA invariants |

## Vocabulary map

The same NEP-519 primitive under four vocabularies. The drift is
**intentional** — each vocabulary optimizes for a different audience.

| Surface | Yield | Resume | Callback OK | Callback Err |
|---|---|---|---|---|
| NEP-519 raw primitive | `Promise::new_yield(...)` | `yield_id.resume(payload)` | `#[callback_result]` Ok | `#[callback_result]` Err |
| `near-sequencer-demo` | `recipe_basic_yield` (and peers) | recipe's resume method | `on_basic_resumed` Ok | `on_basic_resumed` with `PromiseError` |
| `smart-account-contract` (here) | `register_step` (inside `execute_steps`) | `run_steps` / `execute_trigger` | `on_step_resolved` Ok path | `on_step_resolved` Err / `Asserted` mismatch |
| `manim-visualizations` | `stage_call` (event: `yield_eject`) | `run_sequence` (events: `resume_data` / `resume_action`) | `on_stage_call_settled` Ok | `on_stage_call_settled` Err / decay |

Why the drift is load-bearing:

- `near-sequencer-demo` stays with the raw NEP-519 primitive so a
  beginner's search queries resolve.
- `smart-account-contract` introduces `execute_steps` / `StepPolicy`
  (execution trust) alongside orthogonal per-step primitives
  `PreGate` (pre-dispatch gating), `save_result` + `args_template`
  (value threading), and per-account session keys. **Composable trust
  boundaries** is the load-bearing concept at this layer — what the
  product sells is the vocabulary to name each boundary explicitly.
- `manim-visualizations` uses `stage_call` / `run_sequence` because
  it translates from *any* NEP-519 receipt DAG (including this repo's
  older pre-Phase-A shape) and needs a vocabulary that survives both
  the old and new spellings.

## Which to reach for when

| Goal | Start here |
|---|---|
| "I want to understand NEP-519 from first principles." | `near-sequencer-demo` — four recipes, one concept each |
| "I want to render a visualization of my own yield/resume tx." | `manim-visualizations` — paste tx hash into `scripts/pull-trace.mjs` |
| "I want to build a multi-step plan against `intents.near`." | this repo → [`examples/sequential-intents.mjs`](./examples/sequential-intents.mjs) + [`SEQUENTIAL-INTENTS-DESIGN.md`](./SEQUENTIAL-INTENTS-DESIGN.md) |
| "I want to add a new protocol as a sequential step." | this repo → [`PROTOCOL-ONBOARDING.md`](./PROTOCOL-ONBOARDING.md) |
| "I want to teach someone the mechanism." | `manim-visualizations` — the four-tier QA gate keeps visual claims honest |
| "I want to prove the DAG-placement invariant on my own yield flow." | `near-sequencer-demo` — its audit pipeline is the reference |

## What each repo actually confirms

Worth naming precisely, because it's easy to misread three repos as
"three confirmations of the same thing." They aren't — they confirm
different sub-claims at different stakes.

| Repo | What its evidence establishes | What it is silent on |
|---|---|---|
| `near-sequencer-demo` (testnet) | The NEP-519 **primitive** itself: one yield → one resume → one callback ordering. The DAG-placement invariant is **machine-checked**, so a violation is an assertion, not a style warning. | Multi-step sequencing across separate yielded receipts. Each recipe is "one yield, one resume" in isolation. |
| `smart-account-contract` (mainnet + testnet) | **Multi-step sequencing with six orthogonal per-step/per-account primitives.** Mainnet: `Direct` / `Adapter` / `Asserted` on `sequential-intents.mike.near`; halt latency bifurcation (§10.3) is DAG-level proof that step N+1 did not fire when step N halted. Testnet: `PreGate` / threading / session keys on three fresh subaccounts of `x.mike.testnet`. | Independent implementation. All evidence comes from one party's kernel. |
| `manim-visualizations` (testnet renderings of this repo's testnet traces) | The observed receipt DAGs **look like** the mental model claims. Useful as sanity check on the framing. | Independent verification — it's our traces through another lens, not a separate source of evidence. |

The single-sentence version: **only this repo has mainnet evidence of
sequential receipt execution.** Convergence across the three repos
strengthens the mental model, not the mainnet claim. If you want
independent mainnet verification, a different party has to deploy the
kernel and reproduce the battletests — which hasn't happened.

## Cross-references that already exist

The shallow coupling between the three repos:

- `near-sequencer-demo`'s README and CLAUDE.md both forward-refer to
  this repo as the **"sibling saga-runner"** for production use cases
  beyond pedagogical scope.
- `manim-visualizations`' two live-trace scenes (`fail_and_retry`,
  `fail_and_timeout`) are rendered from **this repo's testnet
  traces**.
- `manim-visualizations` commit `5bc9e49` explicitly **decoupled**
  its runtime dependency — FastNEAR transport libs
  (`fastnear.mjs`, `trace-rpc.mjs`) were vendored into its
  `scripts/lib/` so it can translate any NEP-519 receipt DAG, not
  only ones from this repo.

There is **no shared code** between the three repos beyond that
vendored transport layer. Each ships its own contracts (where it has
any) and its own primary scripts.

## What each repo uniquely offers

Collapsing any two would lose real signal.

**This repo only:**

- Mainnet validation via `sequential-intents.mike.near` (v3)
- **Six composable primitives**, each addressing a distinct question
  about cross-contract calls:
  - `StepPolicy::Asserted` — post-state byte-equality gating beyond
    receipt-level success (critical for `intents.near` workflows
    where an `ft_transfer_call` can succeed at the receipt level
    while the verifier ledger refunds the deposit)
  - `PreGate` — pre-dispatch view comparison gate; halts before the
    target fires if a live view sits outside `[min, max]`
  - `save_result` + `args_template` — value threading; step N+1's
    args derived at dispatch from step N's saved return bytes,
    via `Raw` / `DivU128` / `PercentU128` substitution ops
  - Session keys (`SessionGrant`) — annotated function-call access
    keys minted by the smart account itself, with on-chain policy
    enforcement (expiry / fire-cap / trigger-allowlist / label)
- `save_sequence_template` / `create_balance_trigger` /
  `execute_trigger` automation with delegated execution
- `compat-adapter` and `pathological-router` probe infrastructure
- NEP-413 signing helper (`scripts/lib/nep413-sign.mjs`)
- Eight-battletest mainnet coverage (see
  [`SEQUENTIAL-INTENTS-DESIGN.md` §10](./SEQUENTIAL-INTENTS-DESIGN.md))
- Structured `sa-automation` NEP-297 event stream including
  `pre_gate_checked`, `result_saved`, `session_enrolled` /
  `session_fired` / `session_revoked` (see
  [`TELEMETRY-DESIGN.md`](./TELEMETRY-DESIGN.md))

**`near-sequencer-demo` only:**

- DAG-placement invariant as a **machine-checked** audit (a violation
  is a fatal assertion at audit time, not a style warning)
- Four recipes isolating one conceptual beat per method group
  (basic / timeout / chained / handoff) — pedagogy through
  discipline, not combinatorial sprawl
- Live + synthetic variant pairing per Manim scene

**`manim-visualizations` only:**

- Orbital-mechanics metaphor: contracts as liquid spheres, callbacks
  as satellites in orbit, 200-block budget as orbital decay
- Live-trace translation pipeline from any testnet/mainnet tx hash
  to timeline JSON
- Four-tier QA pipeline: render-time fatal invariants (safe frame /
  no overlap / no label overflow / satellite hygiene / ephemera
  hygiene) plus `storyboard.sh` frame-grid audit

## Pointers

The three repos live as peer checkouts under the same parent
directory. In a typical clone they appear as siblings:

- `../near-sequencer-demo/` — primitive, as pedagogy
- `./` — product (this repo)
- `../manim-visualizations/` — model, as pedagogy

If this repo becomes public and the siblings do too, the relative
paths above should be replaced with GitHub URLs.
