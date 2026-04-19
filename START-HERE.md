# START HERE

Short reading path for smart NEAR engineers who want the idea quickly.

## Repo in one sentence

This repo shows that a NEAR smart account can use **yield / resume**
(`NEP-519`) to create the next real downstream `FunctionCall` receipt only
after the previous step's trusted resolution surface resolves.

That means **deterministic receipt-release order**, not global receipt ordering
and not exclusive chain execution.

## If you only have 5 minutes

Read these in order:

1. [simple-example/README.md](./simple-example/README.md)
2. [README.md](./README.md)

That is the shortest path to the kernel claim and the current repo shape.

## If you have 20 minutes

Read these in order:

1. [simple-example/README.md](./simple-example/README.md)
   Minimal kernel: `yield_promise` + `run_sequence` + a tiny recorder leaf.
2. [README.md](./README.md)
   Current public surface: smart account, adapters, probes, tooling.
3. [PROTOCOL-ONBOARDING.md](./PROTOCOL-ONBOARDING.md)
   Practical rule for `Direct` vs `Adapter`, plus how to investigate a new
   protocol safely.

After that, go straight to the code:

4. [contracts/smart-account/src/lib.rs](./contracts/smart-account/src/lib.rs)

## What to ignore on first pass

You do **not** need all of this immediately:

- `md-CLAUDE-chapters/`
  These are the proof archive and design papers. Useful later, not first.
- `collab/`
  Team handoff and investigation residue.
- `web/`
  Helpful once you want to inspect receipt trees visually.

## Mental model

Three layers matter:

1. Minimal kernel
   Each step yields a promise, and a later call resumes them in a chosen order.
2. Current product surface
   The smart account adds resolution policy, automation, and protocol adapters.
3. Historical proof archive
   The chapters show how the idea was validated and hardened over time.

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
