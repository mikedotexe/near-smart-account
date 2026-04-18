#!/usr/bin/env bash
# Workspace tests. cfg(test) bypasses near-sdk's host-target guard.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"
exec cargo test --workspace "$@"
