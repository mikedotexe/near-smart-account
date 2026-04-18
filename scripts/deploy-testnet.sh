#!/usr/bin/env bash
# Deploy (fresh) the demo contracts to testnet subaccounts.
#
# Usage:
#   PREFIX=mike-$(date +%s) ./scripts/deploy-testnet.sh
#     → creates smart-account.<PREFIX>.x.mike.testnet etc.
#   ./scripts/deploy-testnet.sh
#     → defaults to smart-account.x.mike.testnet etc. (reused each run; the
#       script deletes+recreates to reset state)
#
# Requires: near-cli (the JS one or near-cli-rs); `near login` done.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MASTER="${MASTER:-mike.testnet}"
PREFIX="${PREFIX:-}"
INITIAL_BALANCE="${INITIAL_BALANCE:-10}"
NETWORK_ID="${NETWORK_ID:-testnet}"
export NEAR_ENV="$NETWORK_ID"

if [[ "$NETWORK_ID" == "testnet" ]]; then
  export NEAR_TESTNET_RPC="${NEAR_TESTNET_RPC:-https://test.rpc.fastnear.com}"
fi

subaccount() {
  local name="$1"
  if [[ -n "$PREFIX" ]]; then
    echo "${name}.${PREFIX}.${MASTER}"
  else
    echo "${name}.${MASTER}"
  fi
}

deploy_one() {
  local short="$1"   # wasm basename without _local.wasm
  local name="$2"    # account short-name
  local wasm="$DIR/res/${short}_local.wasm"
  local acct; acct="$(subaccount "$name")"
  local init_fn="new"

  if [[ ! -f "$wasm" ]]; then
    echo "missing $wasm — run ./scripts/build-all.sh first" >&2
    exit 1
  fi

  echo "==> $acct"
  printf 'y\n' | near delete "$acct" "$MASTER" --force --networkId "$NETWORK_ID" >/dev/null 2>&1 || true
  near create-account "$acct" --masterAccount "$MASTER" --initialBalance "$INITIAL_BALANCE" --networkId "$NETWORK_ID"

  local init_args
  case "$name" in
    smart-account)
      init_fn="new_with_owner"
      init_args="{\"owner_id\":\"$MASTER\"}"
      ;;
    router)
      init_args='{}'
      ;;
    compat-adapter)
      init_args='{}'
      ;;
    demo-adapter)
      init_args='{}'
      ;;
    wild-router)
      init_args='{}'
      ;;
    *)
      init_args=""
      ;;
  esac

  if [[ -n "$init_args" ]]; then
    near deploy "$acct" "$wasm" --initFunction "$init_fn" --initArgs "$init_args" --networkId "$NETWORK_ID"
  else
    near deploy "$acct" "$wasm" --networkId "$NETWORK_ID"
  fi
}

"$DIR/scripts/build-all.sh"

deploy_one smart_account       smart-account
deploy_one compat_adapter      compat-adapter
deploy_one demo_adapter        demo-adapter
deploy_one echo                echo
deploy_one echo                echo-b           # second echo for promise_and demos
deploy_one router              router
deploy_one wild_router         wild-router
deploy_one pathological_router pathological-router

echo
echo "Deployed:"
echo "  smart-account:        $(subaccount smart-account)"
echo "  compat-adapter:       $(subaccount compat-adapter)"
echo "  demo-adapter:         $(subaccount demo-adapter)"
echo "  echo (A):             $(subaccount echo)"
echo "  echo (B):             $(subaccount echo-b)"
echo "  router:               $(subaccount router)"
echo "  wild-router:          $(subaccount wild-router)"
echo "  pathological-router:  $(subaccount pathological-router)"
