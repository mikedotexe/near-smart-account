#!/usr/bin/env bash
# Workspace-wide fast check.
#
# near-sdk 5.x refuses to compile against a non-wasm target unless `cfg(test)`
# is set or the `non-contract-usage` feature is enabled — so the types crate
# checks host-side (it has the feature), and everything else checks wasm-side.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

RF="${RUSTFLAGS:--A warnings}"

RUSTFLAGS="$RF" cargo check -p smart-account-types
RUSTFLAGS="$RF" cargo check \
  -p smart-account -p compat-adapter -p demo-adapter -p echo -p router -p wild-router -p pathological-router \
  --target wasm32-unknown-unknown
node --test \
  scripts/lib/near-cli.test.mjs \
  scripts/lib/staged-sequence.test.mjs \
  scripts/lib/trace-rpc.test.mjs \
  scripts/lib/events.test.mjs \
  scripts/aggregate-runs.test.mjs \
  scripts/investigate-tx.test.mjs \
  scripts/probe-pathological.test.mjs \
  simple-example/scripts/send-demo.test.mjs
