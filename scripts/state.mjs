#!/usr/bin/env node
// state.mjs — read a contract's state two ways:
//
//   raw:   RPC `query { request_type: view_state }` → base64 KV pairs
//          (with utf8 / hex decoding attempts)
//   typed: RPC `query { request_type: call_function }` → the contract's own
//          view method (JSON-decoded `result` bytes)
//
// Typed calls are the clean path when the contract exposes a view for the
// collection we want (e.g. smart-account's `registered_steps_for`). Raw
// view_state is the power tool when no such view exists yet, or when we need
// to see every entry across every caller at once.
//
// This CLI intentionally stays on the thin `rpcCall` path rather than the
// `callViewMethod` / `viewContractState` helpers in lib/. The reason is
// `--json`: this tool's contract with humans is "dump the full RPC
// response so you can see what NEAR actually said." Library callers who
// want the convenience-decoded form should import the helpers directly.

import { parseArgs } from "node:util";
import { rpcCall, shortHash, truncate } from "./lib/fastnear.mjs";

const { values, positionals } = parseArgs({
  options: {
    network: { type: "string", default: "testnet" },
    method: { type: "string" },
    args: { type: "string", default: "{}" },
    prefix: { type: "string", default: "" },
    block: { type: "string" },
    finality: { type: "string", default: "final" },
    json: { type: "boolean", default: false },
    limit: { type: "string", default: "40" },
  },
  allowPositionals: true,
});

const [accountId] = positionals;
if (!accountId) {
  console.error(
    `usage:
  scripts/state.mjs <account> [--prefix <base64>] [--block <height|hash>] [--limit 40] [--json]
  scripts/state.mjs <account> --method <view> [--args '{"k":"v"}'] [--block <height|hash>] [--json]

flags:
  --prefix   base64-encoded storage-key prefix filter for view_state
  --block    pin the read to a specific block height or hash (otherwise finality=final)
  --finality final | near-final | optimistic (only when --block is not set)
  --limit    max entries to render for raw view_state (default 40)
  --method   if set, use call_function on a named view method instead of view_state
  --args     JSON string for the method's args (default '{}')
  --json     dump the raw RPC response instead of the pretty-printed view
`
  );
  process.exit(1);
}

function blockOrFinality() {
  if (values.block) {
    const id = /^\d+$/.test(values.block) ? Number(values.block) : values.block;
    return { block_id: id };
  }
  return { finality: values.finality };
}

let res;
if (values.method) {
  res = await rpcCall(values.network, "query", {
    request_type: "call_function",
    account_id: accountId,
    method_name: values.method,
    args_base64: Buffer.from(values.args).toString("base64"),
    ...blockOrFinality(),
  });
} else {
  res = await rpcCall(values.network, "query", {
    request_type: "view_state",
    account_id: accountId,
    prefix_base64: values.prefix,
    ...blockOrFinality(),
  });
}

if (values.json) {
  console.log(JSON.stringify(res, null, 2));
  process.exit(res.error ? 1 : 0);
}

if (res.error) {
  console.error(JSON.stringify(res.error, null, 2));
  process.exit(1);
}

const result = res.result;
if (result?.error) {
  // Method-level errors (MethodNotFound, contract panic, etc.) land inside
  // result.error with a 200 status. Surface them as real failures.
  console.error(`contract error: ${result.error}`);
  process.exit(1);
}

if (values.method) {
  const bytes = Buffer.from(result.result || []);
  let decoded;
  try {
    decoded = JSON.parse(bytes.toString("utf8"));
  } catch {
    decoded = bytes.toString("utf8");
  }
  console.log(
    `account=${accountId} method=${values.method} block=${result.block_height} hash=${shortHash(
      result.block_hash
    )}`
  );
  if (result.logs?.length) {
    for (const log of result.logs) console.log(`  log: ${log}`);
  }
  console.log(JSON.stringify(decoded, null, 2));
  process.exit(0);
}

const entries = result.values || [];
const limit = Number(values.limit);
console.log(
  `account=${accountId} entries=${entries.length} block=${result.block_height} hash=${shortHash(
    result.block_hash
  )}`
);
for (const entry of entries.slice(0, limit)) {
  const keyBuf = Buffer.from(entry.key, "base64");
  const valBuf = Buffer.from(entry.value, "base64");
  console.log(`  key(${keyBuf.length}b) ${renderBytes(keyBuf)}`);
  console.log(`    val(${valBuf.length}b) ${renderBytes(valBuf)}`);
}
if (entries.length > limit) {
  console.log(`(... ${entries.length - limit} more; raise --limit to see all)`);
}

function renderBytes(buf) {
  if (buf.length === 0) return "<empty>";
  const first = buf[0];
  const rest = buf.slice(1);
  if (isPrintable(rest)) {
    return `[0x${first.toString(16).padStart(2, "0")}] ${JSON.stringify(
      truncate(rest.toString("utf8"), 160)
    )}`;
  }
  const hex = buf.toString("hex");
  return `0x${hex.length > 160 ? `${hex.slice(0, 160)}...` : hex}`;
}

function isPrintable(buf) {
  if (buf.length === 0) return true;
  for (const b of buf) {
    if (b < 0x20 || b > 0x7e) return false;
  }
  return true;
}
