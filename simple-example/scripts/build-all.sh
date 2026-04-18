#!/usr/bin/env bash
# Build the simple-example contracts into simple-example/res/.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${CARGO_TARGET_DIR:-$DIR/target}"
TOOLCHAIN="${NEAR_RUST_TOOLCHAIN:-nightly}"
WASM_RUSTFLAGS="${NEAR_WASM_RUSTFLAGS:--C link-arg=-s -C target-cpu=mvp}"

rustup component add rust-src --toolchain "$TOOLCHAIN" >/dev/null
rustup target add wasm32-unknown-unknown --toolchain "$TOOLCHAIN" >/dev/null

RUSTFLAGS="$WASM_RUSTFLAGS" cargo +"$TOOLCHAIN" -Z build-std=std,panic_abort build \
  --manifest-path "$DIR/Cargo.toml" \
  --target wasm32-unknown-unknown --release \
  -p simple-sequencer -p recorder

mkdir -p "$DIR/res"
for c in simple_sequencer recorder; do
  cp "$TARGET/wasm32-unknown-unknown/release/${c}.wasm" "$DIR/res/${c}_local.wasm"
  size=$(wc -c < "$DIR/res/${c}_local.wasm")
  echo "  $c -> res/${c}_local.wasm ($size bytes)"
done
