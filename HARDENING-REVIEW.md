# HARDENING-REVIEW.md

An honest repo-shape audit looking specifically for places where we may have
overengineered the project now that the kernel, compatibility model, and
operator tooling are all real.

The goal is not "delete complexity." It is to separate:

- **earned complexity** — the parts that are doing real work
- **presentation overhead** — the parts that make the repo harder to read than
  it needs to be
- **historical sediment** — valuable proof artifacts that should stay, but
  should stop pretending to be the first thing a new reader needs

## TL;DR

The core mechanism is in good shape. The repo is most overbuilt at the edges:

- too much prose relative to active code
- too many demo/probe entrypoints for a new operator to classify quickly
- two continuity docs (`AGENTS.md` and `CLAUDE.md`) that still drift
- one large contract that now clearly contains both a sequencing kernel and an
  automation product layer
- a small amount of root-level cruft (`smart-account.zip`)

The important part is that the **kernel itself does not feel overengineered**.
The sequencing theorem, the three completion policies (`Direct`, `Adapter`,
`Asserted`), and the investigation tooling all earn their keep.

## Snapshot

Current line counts from the working tree:

| Surface | Lines |
|---|---:|
| `md-CLAUDE-chapters/` (21 files) | 5,716 |
| Rust (`contracts/*/src/lib.rs` + `types/src/types.rs`) | 3,487 |
| Demo/probe runners (`send-*`, `simple-example/send-demo`, `probe-pathological`) | 2,506 |
| Top-level orientation docs (`README`, `START-HERE`, `PROTOCOL-ONBOARDING`, `AGENTS`, `CLAUDE`) | 1,028 |

That is not automatically bad. It does, however, mean the repo now needs a
more explicit distinction between:

1. **current public surface**
2. **historical proof archive**
3. **local/operator bench**

## Findings

### 1. Root-level cruft still exists

**Evidence.** `smart-account.zip` is still sitting at the repo root and is only
mentioned in `.gitignore` and older hardening notes. It is not a first-class
output of any script.

**Why it feels overbuilt.** Root clutter is the fastest way for a repo to look
less deliberate than it really is. A one-off share artifact at the top level
reads as residue, not infrastructure.

**Recommendation.** Delete `smart-account.zip`. If packaging matters later,
create a `dist/` convention and a script that writes there.

### 2. `AGENTS.md` and `CLAUDE.md` are still too close to each other

**Evidence.** They are no longer wildly out of sync, but `diff` still shows
real divergence in chapter coverage, `Asserted` detail, and testnet-rig notes.
That means they are still two continuity notes trying to do one job.

**Why it feels overbuilt.** Two similar context packs guarantee maintenance
overhead and future drift. This is especially ironic now that the repo has
already worked hard to reduce duplicated prose elsewhere.

**Recommendation.** Pick one of these and commit to it:

- make `CLAUDE.md` canonical and shrink `AGENTS.md` to a short pointer
- or keep one truly tool-specific delta, but move all shared continuity prose
  into one canonical file

The current state is serviceable, but it is still a duplication hazard.

### 3. The chapter archive is valuable, but too visually equal to current docs

**Evidence.** `md-CLAUDE-chapters/` is 5,716 lines across 21 files, while the
current Rust footprint is 3,487 lines. The active reading path in
`START-HERE.md` is short, but the chapter directory itself still looks like a
flat list of equally current materials.

**Why it feels overbuilt.** The archive is not the problem. The problem is that
historical proof artifacts and current references still look too similar when
someone browses the tree. A new smart NEAR engineer can easily misread the
archive as a required reading order.

**Recommendation.** Keep the archive, but make its status more explicit:

- add a tiny status line to each chapter (`current reference` or `historical`)
- or add a one-page chapter index that classifies them without moving files

I would avoid physically moving files unless link stability stops mattering.

### 4. The script surface is more powerful than it is legible

**Evidence.** The repo now has:

- five top-level `send-*-demo.mjs` drivers
- `scripts/probe-pathological.mjs`
- `simple-example/scripts/send-demo.mjs`
- plus the stronger shared investigation bench (`trace-tx`, `investigate-tx`,
  `state`, `account-history`, etc.)

That is 2,506 lines of demo/probe orchestration before counting the shared
libraries underneath.

**Why it feels overbuilt.** These tools are useful, but a new reader still has
to infer which scripts are:

- canonical entrypoints
- historical reproducers
- operator investigation tools
- probe tools for pathological cases

The capability is earned; the taxonomy is not obvious enough.

**Recommendation.**

- add `scripts/README.md` that classifies the scripts by role
- explicitly mark which scripts are canonical demos vs reproduction helpers

I do **not** think the immediate answer is "merge everything into one mega
script." Clarity first, consolidation second.

### 5. `contracts/smart-account/` now contains two products in one contract

**Evidence.** `contracts/smart-account/src/lib.rs` is 2,519 lines and clearly
contains:

- the narrow sequencing kernel (`stage_call`, `run_sequence`, sequencing
  callbacks, completion policy dispatch)
- the automation/product layer (templates, triggers, authorized executor,
  automation runs)

**Why it feels overbuilt.** The repo’s core theorem is about deterministic
receipt-release order. The smart-account contract also now ships a meaningful
automation surface on top of that theorem. Both are valid, but they are not the
same thing.

**Recommendation.** Document the split before trying to refactor it:

- add a short internal surface map to the smart-account crate docs or README
- clearly name kernel vs automation sections in the contract/module comments

I would not split this into two contracts yet. The shape is real, but the
documentation split is the first hardening move.

### 6. `simple-example/` is useful, but it doubles operational surface

**Evidence.** `simple-example/` has its own workspace, contracts, deploy/check
scripts, and demo runner. That makes it great pedagogically, but it also means
two parallel operational paths exist in the repo.

**Why it feels overbuilt.** This is not code abstraction overkill. It is
surface-area duplication. Every duplicated shell entrypoint is another place
for drift.

**Recommendation.** Keep the minimal contracts and README. Consider reducing the
duplicated shell-script surface later by making the simple-example scripts thin
wrappers around shared helpers.

### 7. The repo is strong enough now that a critique doc is itself warranted

This is actually a good sign.

The repo is no longer "too early to organize." It has enough real mechanism,
tests, probes, and live signal that it benefits from an explicit
overengineering audit. That is usually the moment when a project becomes easier
to harden, because we can stop asking "is any of this real?" and start asking
"which parts should stay first-class?"

## What does *not* feel overengineered

These are the parts I would protect from a reflex simplification pass:

- **The sequencing kernel.**
  `stage_call` / `run_sequence` / `on_stage_call_resume` /
  `on_stage_call_settled` is the actual heart of the repo and earns its
  complexity.
- **The three completion policies.**
  `Direct`, `Adapter`, and `Asserted` each cover a distinct failure/truth
  boundary. This is not redundant abstraction.
- **`investigate-tx.mjs`.**
  The JSON-first investigation wrapper is exactly the kind of structure this
  repo needs.
- **`pathological-router` plus `probe-pathological`.**
  This is good research apparatus, not gratuitous demo fluff.
- **`simple-example/` as a concept.**
  The minimal kernel workspace is worth keeping; it just should not grow a
  second full ecosystem around itself.
- **The static web trace viewer.**
  It stays small, dependency-light, and aligned with the repo’s mental model.

## Best next trims

If we want the highest-signal hardening moves without redesigning anything:

1. Delete `smart-account.zip`.
2. Make one continuity doc canonical and shrink the other to a pointer.
3. Add `scripts/README.md` to classify demo/probe/operator surfaces.
4. Add chapter-status markers or a chapter index.
5. Add a short kernel-vs-automation surface map for `smart-account`.

Those moves make the repo more legible without touching the theorem or the
contract behavior.

## Bottom line

Yes, there are overengineered aspects here — but they are mostly **repo-shape
and presentation** issues, not **mechanism** issues.

The main thing we should resist is simplifying away the parts that actually
earned their complexity. The right hardening move is not to flatten the repo
until it becomes vague. It is to make the layers clearer:

- the kernel
- the automation/product surface
- the proof archive
- the operator bench

Once those layers are easier to see, the remaining overengineering questions
get much easier too.
