#!/usr/bin/env bash
# Deploy the standalone simple-example contracts to fresh testnet subaccounts.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MASTER="${MASTER:-x.mike.testnet}"
PREFIX="${PREFIX:-simple-$(node -e 'process.stdout.write(Date.now().toString(36))')}"
INITIAL_BALANCE="${INITIAL_BALANCE:-10}"
NETWORK_ID="${NETWORK_ID:-testnet}"
export NEAR_ENV="$NETWORK_ID"

if [[ "$NETWORK_ID" == "testnet" ]]; then
  export NEAR_TESTNET_RPC="${NEAR_TESTNET_RPC:-https://test.rpc.fastnear.com}"
fi

subaccount() {
  local name="$1"
  if [[ -n "$PREFIX" ]]; then
    echo "${name}-${PREFIX}.${MASTER}"
  else
    echo "${name}.${MASTER}"
  fi
}

deploy_one() {
  local short="$1"
  local name="$2"
  local wasm="$DIR/res/${short}_local.wasm"
  local acct; acct="$(subaccount "$name")"

  if [[ ! -f "$wasm" ]]; then
    echo "missing $wasm — run ./simple-example/scripts/build-all.sh first" >&2
    exit 1
  fi

  echo "==> $acct"
  printf 'y\n' | near delete "$acct" "$MASTER" --networkId "$NETWORK_ID" >/dev/null 2>&1 || true
  near create-account "$acct" --masterAccount "$MASTER" --initialBalance "$INITIAL_BALANCE" --networkId "$NETWORK_ID"
  near deploy "$acct" "$wasm" --initFunction new --initArgs '{}' --networkId "$NETWORK_ID"
}

"$DIR/scripts/build-all.sh"

deploy_one simple_sequencer simple-sequencer
deploy_one recorder simple-recorder

echo
echo "master=$MASTER"
echo "prefix=$PREFIX"
echo "Deployed:"
echo "  simple-sequencer: $(subaccount simple-sequencer)"
echo "  simple-recorder:  $(subaccount simple-recorder)"
echo
echo "Demo:"
echo "  ./simple-example/scripts/send-demo.mjs --master $MASTER --prefix $PREFIX alpha:1 beta:2 gamma:3 --sequence-order beta,alpha,gamma"
