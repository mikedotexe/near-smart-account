#!/usr/bin/env bash
# Check the standalone simple-example workspace.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RF="${RUSTFLAGS:--A warnings}"

RUSTFLAGS="$RF" cargo check \
  --manifest-path "$DIR/Cargo.toml" \
  -p simple-sequencer -p recorder \
  --target wasm32-unknown-unknown
