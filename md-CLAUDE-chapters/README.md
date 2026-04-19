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
6. `21-asserted-resolve-policy.md`
7. `22-state-break-investigation.md`

## Status index

| Chapter | Status | Why |
|---|---|---|
| `01-near-cross-contract-tracing.md` | Current reference | Runtime and tracing mental model for everything else |
| `02-latch-conduct-testnet-validation.md` | Historical proof archive | First live latch/conduct proof |
| `04-three-surfaces-observability.md` | Historical proof archive | Foundational method, but period-specific walkthrough |
| `archive-staged-call-lineage.md` | Historical proof archive (consolidated) | Merged 03/05/06/07/08 — staged-call testnet proofs from 4-label success through dual-failure, retry-within-window, and mixed-outcome |
| `11-orbital-model-diagrams.md` | Historical proof archive | Mental-model diagrams for earlier framing |
| `archive-automation-lineage.md` | Historical proof archive (consolidated) | Merged 09/10/12 — balance-trigger automation landing + cross-caller isolation + paper-shaped articulation |
| `14-wild-contract-compatibility.md` | Current reference | `Direct` vs `Adapter` compatibility model |
| `archive-real-world-adapter-lineage.md` | Historical proof archive (consolidated) | Merged 13/15/16/17 — wrap.testnet first contact + Promise-chain/failure-opacity probes + first live adapter + three-contract orchestration |
| `18-keep-yield-canonical.md` | Current reference | Why yield/resume stays canonical |
| `19-protocol-onboarding-and-investigation.md` | Current reference | Onboarding and investigation rationale |
| `20-pathological-contract-probe.md` | Current reference | Pathology taxonomy and probe surface |
| `21-asserted-resolve-policy.md` | Current reference | `Asserted` semantics and live probe results |
| `22-state-break-investigation.md` | Current reference | Borsh schema-break forensics + pre-mainnet migration patterns (versioned state, `#[init(ignore_state)]`, `DeleteAccountWithLargeState`) |

## How to use this directory

- Treat **Current reference** chapters as the load-bearing set for today’s repo.
- Treat **Historical proof archive** chapters as validation lineage and design
  history, not required first-pass reading.
- Keep historical terminology inside those archived chapters.
- Current prose uses the **yield · resume · resolve · decay** spine
  (`resolution policy`, `resolution surface`). The Rust code and scripts still
  use `yield_promise` / `run_sequence` / `resolution_policy` after the
  Tranche 2 and 3 renames; archived chapters keep the older
  `stage_call` / `settle_policy` vocabulary as period-accurate history.
