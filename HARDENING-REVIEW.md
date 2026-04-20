# HARDENING-REVIEW.md

A living, deliberately short repo-shape audit for places where the project
may be overengineered now that the sequencer, compatibility model, and
operator tooling are all real.

The goal is not "delete complexity." It is to separate:

- **earned complexity** — the parts that are doing real work
- **presentation overhead** — the parts that make the repo harder to read
  than it needs to be
- **historical sediment** — valuable proof artifacts that should stay,
  but should stop pretending to be the first thing a new reader needs

## TL;DR (as of 2026-04-19)

The core mechanism is in good shape, and the sequential-intents reshape
has landed: `execute_steps` / `register_step` / `run_sequence` / `StepPolicy`
is the external surface; `mike.near` itself now runs the v4 sequencer
(`v4.0.2-ops`) with four curated reference artifacts under
`collab/artifacts/reference/` — see
[`MAINNET-PROOF.md`](./MAINNET-PROOF.md). The flagship gallery, mainnet
battletest evidence, and v4 reference runs are all linked from the
README. Most of the earlier audit's concrete trims have shipped:

- root cruft (`smart-account.zip`) is gone
- `AGENTS.md` is a short pointer to `CLAUDE.md`
- `md-CLAUDE-chapters/README.md` classifies each chapter as current
  reference vs historical proof archive
- `scripts/README.md` catalogs the demo / probe / operator surfaces
- the `simple-example/` README now leads with the sequencer claim and
  three tiers of proof (local cargo test → testnet → mainnet
  `near.social`) with the forensic material split into
  `simple-example/OPERATOR-APPENDIX.md`

Additional hardening landed later on 2026-04-19 (the "make it
falsifiable" pass):

- [`QUICK-VERIFY.md`](./QUICK-VERIFY.md) + `scripts/verify-mainnet-claims.sh`
  turn the mainnet proof into a one-command check anyone can run
  against public archival RPC
- [`REPRODUCIBLE-BUILD.md`](./REPRODUCIBLE-BUILD.md) closes the
  source-attestation gap named in earlier audits: `rust-toolchain.toml`
  pins nightly, and the host build produces a byte-exact match to the
  deployed `code_hash`
- [`FLAGSHIP-HOWTO.md`](./FLAGSHIP-HOWTO.md) externalizes the implicit
  knowledge for composing a new flagship
- terminology audit reconciled repo-wide (`run_steps` phantom → actual
  `run_sequence`)

What remains is mostly architectural: `smart-account` contains two
products in one crate, and `simple-example` still carries a parallel
operational surface that could share more with the main one. Both of
these open findings, below, are unaffected by the 2026-04-19
hardening pass.

## Open findings

### 1. `contracts/smart-account/` contains two products in one contract

**Evidence.** `contracts/smart-account/src/lib.rs` is large and clearly
contains two distinct surfaces:

- the narrow sequencer (`execute_steps` / `register_step` /
  `run_sequence`, `on_step_resumed`, `on_step_resolved`, `StepPolicy`
  dispatch)
- the automation/product layer (templates, triggers, authorized
  executor, automation runs)

**Why it feels overbuilt.** The repo's core theorem is about
deterministic receipt-release order. The smart-account contract also
ships a meaningful automation surface on top. Both are valid, but they
are not the same thing.

**Recommendation.** Document the split before trying to refactor it:
add a short internal surface map to the smart-account crate docs,
clearly name sequencer vs automation sections in module comments. Do not
split into two contracts yet — the shape is real, the doc split is the
first hardening move.

### 2. `simple-example/` doubles the operational shell surface

**Evidence.** `simple-example/` has its own workspace, contracts,
deploy / check scripts, and demo runners. Great pedagogically, but two
parallel operational paths exist in the repo.

**Why it feels overbuilt.** Not code abstraction overkill —
surface-area duplication. Every duplicated shell entrypoint is another
place for drift.

**Recommendation.** Keep the minimal contracts and README. Reduce the
duplicated shell-script surface later by making `simple-example`
scripts thin wrappers around the shared helpers under `scripts/lib/`.
The new `send-social-poem.mjs` and `social-storage-deposit.mjs`
already reuse the shared libs; the older `deploy-testnet.sh` and
`build-all.sh` variants are the next candidates.

## What does *not* feel overengineered

These are the parts to protect from a reflex simplification pass:

- **The sequencer itself.**
  `execute_steps` / `register_step` / `run_sequence` / `on_step_resumed` /
  `on_step_resolved` is the heart of the repo and earns its complexity.
- **The three step policies.**
  `Direct`, `Adapter`, and `Asserted` each cover a distinct
  failure / truth boundary. Not redundant — the
  `sequential-intents.mike.near` round-trip needs `Asserted` to catch
  deposit-path refunds that `Direct` would pass through as success.
- **`investigate-tx.mjs`.**
  The JSON-first investigation wrapper is exactly the kind of
  structure this repo needs.
- **`pathological-router` plus `probe-pathological`.**
  Research apparatus, not demo fluff.
- **`simple-example/` as a concept.**
  The minimal sequencer workspace is worth keeping; it just should not
  grow a full second ecosystem around itself.
- **The static web trace viewer.**
  Small, dependency-light, aligned with the repo's mental model.

## Bottom line

The remaining overengineering is **architectural and presentation**,
not **mechanism**. The right hardening move is not to flatten the repo
until it becomes vague — it is to make the four layers clearer:

- the sequencer
- the automation/product surface
- the proof archive
- the operator bench

Once those layers are easier to see, the remaining questions get much
easier.
