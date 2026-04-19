# scripts/

Guide to the script surface so new operators can tell what is canonical,
investigative, or historical.

## Canonical operator tools

- `investigate-tx.mjs`
  JSON-first three-surfaces investigation wrapper. This is the best single
  report for understanding one transaction, and it now surfaces structured
  `sa-automation` receipt events, step-lifecycle classification, and compact
  sequence telemetry metrics when present.
- `aggregate-runs.mjs`
  Account-wide structured-event sweep. Use this when you want automation-run
  summaries across many txs instead of one report for one tx. It now renders a
  markdown-first run summary and per-run event detail, with optional JSON/both
  output for artifacts.
- `trace-tx.mjs`
  Receipt-tree / classification view for one transaction.
- `state.mjs`
  Block-pinned view helper for contract state snapshots.
- `account-history.mjs`
  Per-account activity helper inside a block window.
- `receipt-to-tx.mjs`
  Resolve a receipt back to its originating transaction.
- `block-window.mjs`
  Show block windows around an investigated transaction or receipt.
- `watch-tip.mjs`
  Follow chain tip while waiting on live probes.

## Canonical demos

- `probe-pathological.mjs`
  Canonical Direct-pathology probe against `pathological-router`.
- `verify-mainnet-claims.sh`
  Four-path live-RPC falsifiability check against the 4-primitive
  mainnet reference artifact. Exits 0 iff reality matches the
  committed artifact.
- `send-register-step-multi.mjs`
  Canonical multi-step register/run helper for manual experiments.
  On mainnet, the current observed two-step floor is `300 TGas` per
  outer action; the helper prints that guidance explicitly.

## Useful reproduction helpers

- `send-balance-trigger-router-demo.mjs`
  Repo-local automation helper for direct / adapter / mixed router
  demos. Referenced by chapter 14 (wild-contract compatibility).

## Archive chapter recipes

Scripts kept solely so the archive chapter Recipes sections remain
reproducible. For new work use `send-register-step-multi.mjs` (above)
or a flagship under `examples/`. See
[`chapter-recipes/README.md`](./chapter-recipes/README.md).

- `chapter-recipes/send-step-echo-demo.mjs`
  Smallest manual sequencing demo (archive chapters 03, 06, 07, 10).
- `chapter-recipes/send-step-mixed-demo.mjs`
  Mixed-outcome step-registration (archive staged-call lineage).
- `chapter-recipes/send-balance-trigger-wrap-demo.mjs`
  Real-protocol automation over `wrap.testnet` (archive
  real-world-adapter-lineage).

## Build and deploy

- `check.sh`
  Main repo validation pass.
- `test.sh`
  Thin alias to the main test/check workflow.
- `build-all.sh`
  Known-good wasm build path for this machine.
- `deploy-testnet.sh`
  Shared-rig deploy/churn script.

## Tests

- `investigate-tx.test.mjs`
- `probe-pathological.test.mjs`

## Shared libraries

- `lib/near-cli.mjs`
  Shared near-api-js wiring and transaction helpers.
- `lib/trace-rpc.mjs`
  Receipt tracing / classification logic used by the operator bench.
- `lib/fastnear.mjs`
  Shared RPC / FastNEAR access helpers.

## Simple example

`simple-example/scripts/send-demo.mjs` is the demo driver for the nested
mini-workspace. It is canonical for `simple-example/`, but separate from the
main repo’s operator bench.
