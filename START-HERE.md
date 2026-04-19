# START HERE

Short reading path for smart NEAR engineers who want the idea quickly.

## Repo in one sentence

A NEAR smart account for **cross-contract composition with explicit
trust boundaries** — six composable primitives (`Direct` / `Adapter`
/ `Asserted` / `PreGate` / value threading / session keys) on NEP-519
yield/resume, mainnet-validated against `intents.near`.

Sequential here means **receipt-release order**, not global receipt
ordering and not exclusive chain execution.

## If you only have 5 minutes

Read these in order:

1. [README.md](./README.md) — six-primitive table, flagship gallery,
   mainnet tx hashes as proof.
2. [`examples/sequential-intents.mjs`](./examples/sequential-intents.mjs)
   header comment — the 3-step `Asserted`-gated round-trip laid out
   inline.

That is the shortest path to "what it does + why it's different from
native NEAR batched Actions."

## If you have 20 minutes

Read these in order:

1. [README.md](./README.md)
   Six-primitive table + flagship gallery + mainnet validation.
2. [SEQUENTIAL-INTENTS-DESIGN.md](./SEQUENTIAL-INTENTS-DESIGN.md)
   Decision doc for the `Asserted` flagship: `intents.near` surface
   map, §10 battletest findings (halt semantics, assertion outcome
   taxonomy, halt latency bifurcation, key-registry gotcha).
3. [simple-example/README.md](./simple-example/README.md)
   Minimal kernel: `register_step` + `run_steps` + a tiny recorder
   leaf — the bare NEP-519 loop isolated from the facade.
4. [PROTOCOL-ONBOARDING.md](./PROTOCOL-ONBOARDING.md)
   Primitive decision tree for a new protocol step.
5. [INTENTS.md](./INTENTS.md)
   Positioning note: this smart account vs `intents.near`, decision
   matrix for when to use which.
6. [SISTER-REPOS.md](./SISTER-REPOS.md)
   Three-repo picture: this repo (product) vs `near-sequencer-demo`
   (primitive pedagogy) vs `manim-visualizations` (model pedagogy).

## If you have 40 minutes — one chapter per primitive

Each chapter is primitive-pure. Read any subset in any order; they
compose orthogonally in the code.

- [Chapter 14](./md-CLAUDE-chapters/14-wild-contract-compatibility.md)
  — **`Direct` vs `Adapter`** (why the compatibility distinction
  exists; hidden async as the hazard).
- [Chapter 21](./md-CLAUDE-chapters/21-asserted-resolve-policy.md)
  — **`Asserted`** (post-resolve byte-equality check; catches noop
  and decoy pathologies `Direct` is blind to).
- [Chapter 23](./md-CLAUDE-chapters/23-pre-gate-policy.md)
  — **`PreGate`** (pre-dispatch view comparison; programmable
  limit-order engine).
- [Chapter 24](./md-CLAUDE-chapters/24-value-threading.md)
  — **`save_result` + `args_template`** (step N+1's input derived
  from step N's output; ladder-swaps).
- [Chapter 25](./md-CLAUDE-chapters/25-session-keys.md) + top-level
  [SESSION-KEYS.md](./SESSION-KEYS.md)
  — **Session keys** (annotated function-call access keys; dapp
  delegation with on-chain policy enforcement).

After that, go straight to the code:

- [contracts/smart-account/src/lib.rs](./contracts/smart-account/src/lib.rs)

## What to ignore on first pass

You do **not** need all of this immediately:

- `md-CLAUDE-chapters/` **archive subsection** (the `archive-*.md`
  files and chapters 1-13). These are the lineage / proof archive —
  period-accurate history, useful later, not first. The primitive
  chapters (14 / 18 / 21 / 23 / 24 / 25) are current reference.
- `collab/`
  Team handoff and investigation residue.
- `web/`
  Helpful once you want to inspect receipt trees visually.

## Mental model

Three layers matter:

1. **Minimal kernel** — each step yields a promise, and a later call
   resumes them in a chosen order (NEP-519).
2. **Six composable primitives** — the smart account layers execution
   trust (`Direct` / `Adapter` / `Asserted`), pre-dispatch gating
   (`PreGate`), data flow (value threading), and auth delegation
   (session keys) on top of the kernel.
3. **Historical proof archive** — the lineage chapters show how the
   primitives were validated and hardened over time.

## Current code surfaces

- [contracts/smart-account/](./contracts/smart-account/)
  Main contract: manual sequencing, resolution policy, automation.
- [contracts/compat-adapter/](./contracts/compat-adapter/)
  Real protocol adapter surface.
- [contracts/demo-adapter/](./contracts/demo-adapter/)
  Demo adapter for dishonest async.
- [contracts/pathological-router/](./contracts/pathological-router/)
  Probe contract for “what can go wrong under `Direct`?”
- [scripts/investigate-tx.mjs](./scripts/investigate-tx.mjs)
  One-command investigation wrapper.
- [scripts/probe-pathological.mjs](./scripts/probe-pathological.mjs)
  Fast Direct-pathology probe.

## Best first theorem

Use this phrasing:

> A user yields downstream promises in their smart account, and the account only
> creates the next real `FunctionCall` receipt after the previous step's
> trusted resolution surface resolves.

## Best first caution

`Direct` is about **callback-visible completion**, not guaranteed semantic
truth for every protocol.

- Empty return payloads are fine.
- Hidden async work that is not returned is the real danger.
- That is why the repo has `Adapter`.
