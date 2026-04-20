# Chapter Map

Both the current reference set and the historical proof archive that
got the repo here. Organized by function, not by chronology.

The **Policies** section below has **one chapter per primitive** (14 /
21 / 23 / 24 / 25) — read any one independently; they compose
orthogonally in the code. One step can carry `PreGate` + `Asserted` +
`args_template` + session-key auth simultaneously, each covering a
different branch of the cascade.

## Five sections

1. **Using** — how the sequencer exposes multi-step cross-contract
   composition today.
2. **Policies** — one chapter per primitive, grounded in the trust
   taxonomy we found in the wild.
3. **Foundations** — the NEAR runtime mechanics the sequencer rides on.
4. **Lineage** — historical proof archive; valuable as validation
   history, not first-pass reading.
5. **Operations** — what to do when state drifts and how to
   investigate.

## 1. Using

How the sequencer is consumed today.

- [`19-protocol-onboarding-and-investigation.md`](./19-protocol-onboarding-and-investigation.md)
  — Adding a new protocol as a sequential-intents step; policy decision
  rationale; investigation workflow. Paired with [`PROTOCOL-ONBOARDING.md`](../PROTOCOL-ONBOARDING.md).

## 2. Policies

One chapter per `StepPolicy` variant, grounded in live probes.

- [`14-wild-contract-compatibility.md`](./14-wild-contract-compatibility.md)
  — Why `Direct` vs `Adapter` exists. Hidden async is the hazard;
  return shape is not.
- [`20-pathological-contract-probe.md`](./20-pathological-contract-probe.md)
  — Pathology taxonomy across three detection layers (receipt
  classification, resolve log, target state). Maps directly to what
  `Direct` can and cannot catch.
- [`21-asserted-resolve-policy.md`](./21-asserted-resolve-policy.md)
  — `Asserted` semantics + four testnet probes proving the sequencer
  catches noop and decoy pathologies via inline postcheck.
- [`23-pre-gate-policy.md`](./23-pre-gate-policy.md)
  — `PreGate` pre-dispatch conditional gate design; six-branch
  cascade covering in-range / below_min / above_max / comparison_error
  / gate_panicked + happy path. Flagship: `examples/limit-order.mjs`.
- [`24-value-threading.md`](./24-value-threading.md)
  — `save_result` + `args_template` + `Substitution` + `SubstitutionOp`
  (Raw / DivU128 / PercentU128); pure `materialize_args` engine;
  `result_saved` + `args_materialize_failed` events. Flagship:
  `examples/ladder-swap.mjs`.
- [`25-session-keys.md`](./25-session-keys.md)
  — Annotated function-call access keys minted by the smart account
  itself; `SessionGrant` state layer with `{expires, fire_cap,
  allowlist, label}`; enroll / fire / revoke lifecycle; pairs with
  top-level [`SESSION-KEYS.md`](../SESSION-KEYS.md). Flagship:
  `examples/session-dapp.mjs`.

## 3. Foundations

The NEAR-runtime mechanics the whole sequencer rides on.

- [`01-near-cross-contract-tracing.md`](./01-near-cross-contract-tracing.md)
  — Receipt mechanics, tracing model, the three-surfaces method.
  Load-bearing for everything else.
- [`18-keep-yield-canonical.md`](./18-keep-yield-canonical.md)
  — Why NEP-519 `yield_promise` stays canonical even though a pure
  state-driven queue would also work. Registration / release /
  progression as three explicit phases.

## 4. Lineage

Historical proof archive. Read to understand how the repo got here,
not to learn the current shape.

- [`02-latch-conduct-testnet-validation.md`](./02-latch-conduct-testnet-validation.md)
  — First live latch/conduct proof on testnet. Period-accurate
  vocabulary.
- [`04-three-surfaces-observability.md`](./04-three-surfaces-observability.md)
  — Foundational observability method, specific to an earlier walkthrough.
- [`11-orbital-model-diagrams.md`](./11-orbital-model-diagrams.md)
  — Mental-model diagrams from earlier framing.
- [`archive-staged-call-lineage.md`](./archive-staged-call-lineage.md)
  — Consolidated 03/05/06/07/08 — staged-call testnet proofs: 4-label
  success, dual-failure, retry-within-window, mixed-outcome.
- [`archive-automation-lineage.md`](./archive-automation-lineage.md)
  — Consolidated 09/10/12 — balance-trigger automation landing +
  cross-caller isolation + paper-shaped articulation.
- [`archive-real-world-adapter-lineage.md`](./archive-real-world-adapter-lineage.md)
  — Consolidated 13/15/16/17 — `wrap.testnet` first contact +
  promise-chain / failure-opacity probes + first live adapter +
  three-contract orchestration.

## 5. Operations

What to do when the shape of the contract or its state moves under you.

- [`22-state-break-investigation.md`](./22-state-break-investigation.md)
  — Borsh schema-break forensics. Pre-mainnet migration patterns
  (versioned state via `VersionedContract::{V1, V2}`,
  `#[init(ignore_state)]`, `DeleteAccountWithLargeState`). Pairs with
  [`TELEMETRY-DESIGN.md`](../TELEMETRY-DESIGN.md) Phase B discussion.

## Vocabulary note

Current prose uses the post-Phase-A spine: **`Step` / `StepPolicy` /
`execute_steps` / `register_step` / `run_sequence`**, with the internal
NEP-519 mechanics still described as **yield · resume · resolve ·
decay**. Historical chapters use earlier spellings — `yield_promise`
/ `run_sequence` / `resolution_policy` (pre-Phase-A) and
`stage_call` / `settle_policy` (earlier still) — as period-accurate
history. Callers that still mention `latch`, `conduct`, `gated_call`,
or `label` belong to the earliest era and only survive in archived
chapters.
