# AGENTS.md — smart-account-contract

Short pointer note for future Codex sessions.

Canonical continuity lives in [CLAUDE.md](./CLAUDE.md). Read that first if you
need the current repo theorem, shared rig, compatibility model, or pitfalls.

Recommended reading path:

1. [START-HERE.md](./START-HERE.md) — shortest reading funnel
2. [README.md](./README.md) — public overview and repo layout
3. [PROTOCOL-ONBOARDING.md](./PROTOCOL-ONBOARDING.md) — operator guidance
4. [md-CLAUDE-chapters/README.md](./md-CLAUDE-chapters/README.md) — chapter map
5. [CLAUDE.md](./CLAUDE.md) — canonical continuity note

Codex-specific reminders:

- Treat `CLAUDE.md` as the single shared continuity source rather than
  duplicating repo-state prose here again.
- In code, keep `settle_policy`; in prose, prefer **completion policy** /
  **completion surface**.
- Current docs prefer `step`; historical chapters may still mention `latch`,
  `conduct`, `gated_call`, or `label`.
- Use fresh direct-child accounts for churn; long-lived shared rigs can cross
  NEAR's `DeleteAccountWithLargeState` guard.
