#!/usr/bin/env bash
# Verify the four-primitive mainnet flagship (intents-deposit-limit) is
# still falsifiable against public archival RPC. Exits 0 iff all three
# QUICK-VERIFY paths agree with the committed reference artifact:
#
#   collab/artifacts/reference/mike-near-v4.0.2-intents-deposit-limit.json
#
# Any disagreement — FastNEAR drift, artifact edit, sequencer redeploy
# invalidating block anchors — surfaces here as a non-zero exit plus a
# specific "saw X, expected Y" diagnostic.
#
# Runs live RPC calls; NOT part of scripts/check.sh (that's offline).
# Prose version of these three paths lives in QUICK-VERIFY.md.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

ARTIFACT="${ARTIFACT:-collab/artifacts/reference/mike-near-v4.0.2-intents-deposit-limit.json}"
# Archival subdomain is the documented correct endpoint for historical
# block_id queries. docs.fastnear.com/rpc for the full surface.
RPC="${RPC:-https://archival-rpc.mainnet.fastnear.com}"
# Expected code_hash of mike.near at v4.0.2-ops. Base58-encoded SHA-256
# of the deployed WASM. Derived from view_account at the pass-fire block.
EXPECTED_CODE_HASH="${EXPECTED_CODE_HASH:-DytwYt4tMP849QjXAQZFeEMuvMYUVq1bvyhwk8JWQvy4}"

if [[ ! -f "$ARTIFACT" ]]; then
  echo "ERR: reference artifact not found: $ARTIFACT" >&2
  exit 2
fi

python3 - "$ARTIFACT" "$RPC" "$EXPECTED_CODE_HASH" <<'PY'
import sys, json, urllib.request

ARTIFACT_PATH, RPC, EXPECTED_CODE_HASH = sys.argv[1], sys.argv[2], sys.argv[3]

SIGNER = "mike.near"
PASS_TX = "65K4kDyd8Ab3vWnsdAB81YK5ptYLJ1Xem3ea1sRXZx9L"
HALT_TX = "EEC83UhpqvckEcuMnYqekQgR6jpuLMGtJJctxE23HhX"
# enroll-tx block (before pass) vs halt-tx block (after pass).
# Diff gives pass-fire-only delta (halt fire does not touch the ledger).
BEFORE_BLOCK = "9VUDKP6vH3abxCEU99UD1VMQMwg3dDcMLJMHMdgMg2SE"
AFTER_BLOCK  = "6nCyyuMA3j9op6vaCJH1gS6yhi3F5HoL8R1oadGhNYMX"
# base64 of {"account_id":"mike.near","token_id":"nep141:wrap.near"}
BALANCE_ARGS_B64 = "eyJhY2NvdW50X2lkIjoibWlrZS5uZWFyIiwidG9rZW5faWQiOiJuZXAxNDE6d3JhcC5uZWFyIn0="


def rpc_call(body):
    req = urllib.request.Request(
        RPC,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def fetch_tx(tx_hash):
    r = rpc_call({"jsonrpc": "2.0", "id": 1, "method": "tx",
                  "params": [tx_hash, SIGNER]})
    if "error" in r:
        sys.exit(f"RPC error fetching tx {tx_hash}: {r['error']}")
    return r["result"]


def fetch_view(block_hash):
    r = rpc_call({"jsonrpc": "2.0", "id": 1, "method": "query", "params": {
        "request_type": "call_function",
        "block_id": block_hash,
        "account_id": "intents.near",
        "method_name": "mt_balance_of",
        "args_base64": BALANCE_ARGS_B64,
    }})
    if "error" in r:
        sys.exit(f"RPC error fetching view at {block_hash}: {r['error']}")
    bytes_ = r["result"]["result"]
    s = "".join(chr(b) for b in bytes_)
    return json.loads(s) if s.startswith('"') else s


def fetch_account(block_hash, account_id):
    r = rpc_call({"jsonrpc": "2.0", "id": 1, "method": "query", "params": {
        "request_type": "view_account",
        "block_id": block_hash,
        "account_id": account_id,
    }})
    if "error" in r:
        sys.exit(f"RPC error fetching account at {block_hash}: {r['error']}")
    return r["result"]


def extract_events(tx_result):
    events = []
    for ro in tx_result["receipts_outcome"]:
        for log in ro["outcome"]["logs"]:
            if log.startswith("EVENT_JSON:"):
                e = json.loads(log[len("EVENT_JSON:"):])
                events.append((e.get("standard", "?"), e["event"], e.get("data", {})))
    return events


print(f"Verifying {ARTIFACT_PATH}")
print(f"RPC: {RPC}")
print()

with open(ARTIFACT_PATH) as f:
    artifact = json.load(f)

problems = []


# -----------------------------------------------------------------------------
# Path 1: pass-fire events match structured_events.fire_pass + mt_mint present
# -----------------------------------------------------------------------------

print(f"[1/4] pass-fire events ({PASS_TX})")
pass_events = extract_events(fetch_tx(PASS_TX))
expected_pass = [e["event"] for e in artifact["structured_events"]["fire_pass"]]
live_pass_sa = [ev for (std, ev, _) in pass_events if std == "sa-automation"]
live_pass_mt_mint = sum(1 for (std, ev, _) in pass_events
                        if std == "nep245" and ev == "mt_mint")
path1_problems = []
if live_pass_sa != expected_pass:
    path1_problems.append(
        f"sa-automation events differ:\n    expected: {expected_pass}\n    live:     {live_pass_sa}"
    )
if live_pass_mt_mint != 1:
    path1_problems.append(
        f"expected exactly 1 nep245/mt_mint on pass fire, saw {live_pass_mt_mint}"
    )
if path1_problems:
    for p in path1_problems: print(f"  FAIL: {p}", file=sys.stderr)
    problems.append("path 1")
else:
    print(f"  OK: {len(expected_pass)} sa-automation events match; 1 nep245/mt_mint present")


# -----------------------------------------------------------------------------
# Path 2: halt-fire events match + step 2 below_min + sequence_halted + no mt_mint
# -----------------------------------------------------------------------------

print(f"[2/4] halt-fire events ({HALT_TX})")
halt_events = extract_events(fetch_tx(HALT_TX))
expected_halt = [e["event"] for e in artifact["structured_events"]["fire_halt"]]
live_halt_sa = [ev for (std, ev, _) in halt_events if std == "sa-automation"]
live_halt_mt_mint = sum(1 for (std, ev, _) in halt_events
                        if std == "nep245" and ev == "mt_mint")
step2_gate = next(
    ((ev, data.get("outcome"))
     for (std, ev, data) in halt_events
     if std == "sa-automation" and ev == "pre_gate_checked"
        and data.get("step_id") == "deposit-into-intents"),
    None,
)
halted = next(
    (((data.get("reason"), data.get("error_kind")))
     for (std, ev, data) in halt_events
     if std == "sa-automation" and ev == "sequence_halted"),
    None,
)
path2_problems = []
if live_halt_sa != expected_halt:
    path2_problems.append(
        f"sa-automation events differ:\n    expected: {expected_halt}\n    live:     {live_halt_sa}"
    )
if live_halt_mt_mint != 0:
    path2_problems.append(
        f"expected 0 nep245/mt_mint on halt (proof by silence), saw {live_halt_mt_mint}"
    )
if not step2_gate or step2_gate[1] != "below_min":
    path2_problems.append(
        f"step 2 pre_gate_checked expected outcome=below_min, saw {step2_gate}"
    )
if halted != ("pre_gate_failed", "pre_gate_below_min"):
    path2_problems.append(
        f"expected sequence_halted {{reason=pre_gate_failed,error_kind=pre_gate_below_min}}, saw {halted}"
    )
if path2_problems:
    for p in path2_problems: print(f"  FAIL: {p}", file=sys.stderr)
    problems.append("path 2")
else:
    print(f"  OK: {len(expected_halt)} sa-automation events match; step 2 below_min; halted cleanly; no mt_mint")


# -----------------------------------------------------------------------------
# Path 3: mt_balance_of delta across pass-fire matches balances.intents_delta
# -----------------------------------------------------------------------------

print(f"[3/4] balance delta at intents.near NEP-245 ledger")
before = fetch_view(BEFORE_BLOCK)
after  = fetch_view(AFTER_BLOCK)
expected_before = artifact["balances"]["intents_before"]
expected_after  = artifact["balances"]["intents_after"]
expected_delta  = artifact["balances"]["intents_delta"]
live_delta = str(int(after) - int(before))
path3_problems = []
if before != expected_before:
    path3_problems.append(f"before: expected {expected_before}, live {before}")
if after != expected_after:
    path3_problems.append(f"after:  expected {expected_after}, live {after}")
if live_delta != expected_delta:
    path3_problems.append(f"delta:  expected {expected_delta}, live {live_delta}")
if path3_problems:
    for p in path3_problems: print(f"  FAIL: {p}", file=sys.stderr)
    problems.append("path 3")
else:
    print(f"  OK: intents.near mt_balance_of grew by {expected_delta} yocto wNEAR")


# -----------------------------------------------------------------------------
# Path 4: mike.near code_hash at the pass-fire block matches expected
# -----------------------------------------------------------------------------

pass_block = artifact["block_info"]["fire_pass"]["transaction_block_hash"]
print(f"[4/4] mike.near code_hash at pass-fire block ({pass_block[:16]}…)")
live_acct = fetch_account(pass_block, "mike.near")
live_code_hash = live_acct.get("code_hash")
path4_problems = []
if live_code_hash != EXPECTED_CODE_HASH:
    path4_problems.append(
        f"code_hash: expected {EXPECTED_CODE_HASH}, live {live_code_hash}"
    )
if path4_problems:
    for p in path4_problems: print(f"  FAIL: {p}", file=sys.stderr)
    problems.append("path 4")
else:
    print(f"  OK: code_hash pinned to {live_code_hash} at pass-fire block")


print()
if problems:
    print(f"DISAGREEMENT on: {', '.join(problems)}", file=sys.stderr)
    print(f"If this repo's artifact is correct, the bug is on-chain (or archival drift).", file=sys.stderr)
    print(f"If the on-chain state is correct, the bug is in this repo's artifact.", file=sys.stderr)
    sys.exit(1)

print(f"All four paths agree with {ARTIFACT_PATH}")
print(f"Headline claim still falsifiable; sequencer v4.0.2-ops on mike.near verified")
print(f"  (contract self-report via events + code_hash pin + balance diff).")
PY
