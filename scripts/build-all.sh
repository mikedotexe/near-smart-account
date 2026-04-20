#!/usr/bin/env bash
# Build every contract's wasm into res/. Uses the local host toolchain (not
# the reproducible docker build — see `cargo run-script optimize` for that).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${CARGO_TARGET_DIR:-$DIR/target}"
TOOLCHAIN="${NEAR_RUST_TOOLCHAIN:-nightly}"
WASM_RUSTFLAGS="${NEAR_WASM_RUSTFLAGS:--C link-arg=-s -C target-cpu=mvp -C link-arg=--import-undefined}"

rustup component add rust-src --toolchain "$TOOLCHAIN" >/dev/null
rustup target add wasm32-unknown-unknown --toolchain "$TOOLCHAIN" >/dev/null

RUSTFLAGS="$WASM_RUSTFLAGS" cargo +"$TOOLCHAIN" -Z build-std=std,panic_abort build \
  --manifest-path "$DIR/Cargo.toml" \
  --target wasm32-unknown-unknown --release \
  -p smart-account -p authorizer -p compat-adapter -p demo-adapter -p echo -p router -p wild-router -p pathological-router

mkdir -p "$DIR/res"
for c in smart_account authorizer compat_adapter demo_adapter echo router wild_router pathological_router; do
  cp "$TARGET/wasm32-unknown-unknown/release/${c}.wasm" "$DIR/res/${c}_local.wasm"
  size=$(wc -c < "$DIR/res/${c}_local.wasm")
  echo "  $c → res/${c}_local.wasm ($size bytes)"
done
