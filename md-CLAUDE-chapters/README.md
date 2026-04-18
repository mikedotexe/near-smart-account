# Chapter Map

This directory contains both the current reference set and the historical proof
archive that got the repo here.

## Recommended reading path

Start with these if you want the current shape of the project:

1. `01-near-cross-contract-tracing.md`
2. `14-wild-contract-compatibility.md`
3. `18-keep-yield-canonical.md`
4. `19-protocol-onboarding-and-investigation.md`
5. `20-pathological-contract-probe.md`
6. `21-asserted-settle-policy.md`

## Status index

| Chapter | Status | Why |
|---|---|---|
| `01-near-cross-contract-tracing.md` | Current reference | Runtime and tracing mental model for everything else |
| `02-latch-conduct-testnet-validation.md` | Historical proof archive | First live latch/conduct proof |
| `03-smart-account-staged-call.md` | Historical proof archive | Early staged-call scaffold and validation |
| `04-three-surfaces-observability.md` | Historical proof archive | Foundational method, but period-specific walkthrough |
| `05-staged-call-three-surfaces.md` | Historical proof archive | Historical staged-call walkthrough |
| `06-stage-call-failure-modes.md` | Historical proof archive | Earlier failure-mode validation |
| `07-stage-call-retry-within-yield-window.md` | Historical proof archive | Retry proof for older staged-call work |
| `08-stage-call-mixed-outcome-sequence.md` | Historical proof archive | Mixed saga proof for older staged-call work |
| `09-balance-trigger-sequence-automation.md` | Historical proof archive | First automation layer writeup |
| `10-cross-caller-isolation-and-positive-dual-retry.md` | Historical proof archive | Historical staged-state isolation proof |
| `11-orbital-model-diagrams.md` | Historical proof archive | Mental-model diagrams for earlier framing |
| `12-deterministic-smart-account-automation.md` | Historical proof archive | Paper-shaped articulation of the mechanism before later hardening |
| `13-stage-call-against-real-defi.md` | Historical proof archive | First live external DeFi probe |
| `14-wild-contract-compatibility.md` | Current reference | `Direct` vs `Adapter` compatibility model |
| `15-stage-call-wild-contract-semantics.md` | Historical proof archive | Earlier wild-contract semantics pass |
| `16-wrap-testnet-protocol-adapter.md` | Historical proof archive | Live wrap adapter validation |
| `17-stage-call-multi-contract-intent.md` | Historical proof archive | Historical multi-contract orchestration proof |
| `18-keep-yield-canonical.md` | Current reference | Why yield/resume stays canonical |
| `19-protocol-onboarding-and-investigation.md` | Current reference | Onboarding and investigation rationale |
| `20-pathological-contract-probe.md` | Current reference | Pathology taxonomy and probe surface |
| `21-asserted-settle-policy.md` | Current reference | `Asserted` semantics and live probe results |

## How to use this directory

- Treat **Current reference** chapters as the load-bearing set for today’s repo.
- Treat **Historical proof archive** chapters as validation lineage and design
  history, not required first-pass reading.
- Keep historical terminology inside those archived chapters; current prose and
  code should continue to prefer `step`, `completion policy`, and
  `completion surface`.
