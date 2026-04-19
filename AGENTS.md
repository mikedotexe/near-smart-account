# AGENTS.md — smart-account-contract

Short pointer note for future Codex sessions.

Canonical continuity lives in [CLAUDE.md](./CLAUDE.md). Read that first if you
need the current repo theorem, shared rig, compatibility model, or pitfalls.

Recommended reading path:

1. [START-HERE.md](./START-HERE.md) — shortest reading funnel
2. [README.md](./README.md) — public overview, flagship gallery, mainnet
   validation
3. [SEQUENTIAL-INTENTS-DESIGN.md](./SEQUENTIAL-INTENTS-DESIGN.md) — design
   doc + battletest findings
4. [PROTOCOL-ONBOARDING.md](./PROTOCOL-ONBOARDING.md) — operator guidance
5. [md-CLAUDE-chapters/README.md](./md-CLAUDE-chapters/README.md) — chapter map
6. [CLAUDE.md](./CLAUDE.md) — canonical continuity note

Codex-specific reminders:

- Treat `CLAUDE.md` as the single shared continuity source rather than
  duplicating repo-state prose here again.
- External surface is `execute_steps` / `register_step` / `run_steps` /
  `Step` / `StepPolicy`. Callbacks are `on_step_resumed` /
  `on_step_resolved`.
- Prose spine for internal mechanics is **yield · resume · resolve ·
  decay**.
- Older archived chapters may still use `yield_promise` / `run_sequence`
  / `resolution_policy` (pre-Phase-A) or `stage_call` / `settle_policy`
  (earlier still) as period-accurate terms. Historical chapters may
  also mention `latch`, `conduct`, `gated_call`, or `label` — those
  belong to the earliest era.
- Use fresh direct-child accounts for churn; long-lived shared rigs can
  cross NEAR's `DeleteAccountWithLargeState` guard.
- `intents.near` maintains its own per-account public-key registry.
  Bootstrap via `intents.near.add_public_key` before first
  `execute_intents` call from a new signer. See CLAUDE.md §
  session-critical pitfalls.
