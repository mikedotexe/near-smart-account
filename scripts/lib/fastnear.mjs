// scripts/lib/fastnear.mjs — FastNEAR HTTP plumbing + endpoint wrappers.
//
// Error-surfacing convention:
// - Transport-level failures (non-2xx HTTP) throw from `request()`. That
//   bubbles through every wrapper and crashes the caller with a readable
//   message. These are "your curl would have failed" errors.
// - Protocol-level errors (JSON-RPC `{error: ...}`, tx-API error bodies,
//   view-method contract panics) land in the returned object. Thin
//   wrappers (`rpcCall`, `txApiPost`, `fetchBlock`, `fetchAccountHistory`,
//   `fetchTransactions`, `fetchReceipt`, `fetchBlockRange`) return the
//   raw response so callers can inspect `result.error` / `error` shapes.
// - Post-processing wrappers with opinions about "what success means"
//   (see `callViewMethod` in near-cli.mjs and `traceTx` in trace-rpc.mjs)
//   normalize: `callViewMethod` throws on protocol errors; `traceTx`
//   returns `{error}` so classification survives partial failure.
//
// In short: thin = raw passthrough, opinionated = explicit error channel.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "../..");

loadEnvFile(path.join(REPO_ROOT, ".env"));

export function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const src = fs.readFileSync(filePath, "utf8");
  for (const rawLine of src.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (!key || process.env[key] != null) continue;
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

export function getApiKey() {
  return process.env.FASTNEAR_API_KEY || "";
}

export function getNetworkConfig(network = "testnet") {
  if (network === "testnet") {
    return {
      network,
      rpc: "https://rpc.testnet.fastnear.com",
      archivalRpc: "https://archival-rpc.testnet.fastnear.com",
      txApi: "https://tx.test.fastnear.com",
      nearData: "https://testnet.neardata.xyz",
      fastApi: "https://test.api.fastnear.com",
    };
  }
  if (network === "mainnet") {
    return {
      network,
      rpc: "https://rpc.mainnet.fastnear.com",
      archivalRpc: "https://archival-rpc.mainnet.fastnear.com",
      txApi: "https://tx.main.fastnear.com",
      nearData: "https://mainnet.neardata.xyz",
      fastApi: "https://api.fastnear.com",
    };
  }
  throw new Error(`unsupported network '${network}'`);
}

export function withApiKey(url, apiKey = getApiKey()) {
  if (!apiKey) return url;
  const u = new URL(url);
  u.searchParams.set("apiKey", apiKey);
  return u.toString();
}

export function shortHash(hash) {
  if (!hash || hash.length < 12) return hash || "?";
  return `${hash.slice(0, 6)}...${hash.slice(-4)}`;
}

export function truncate(text, max = 120) {
  const s = String(text ?? "");
  return s.length > max ? `${s.slice(0, max - 1)}...` : s;
}

export function formatTimestampNs(value) {
  if (value == null || value === "") return "?";
  try {
    const ms = Number(BigInt(String(value)) / 1_000_000n);
    return new Date(ms).toISOString();
  } catch {
    return String(value);
  }
}

export function decodeBase64Utf8(value) {
  try {
    return Buffer.from(String(value), "base64").toString("utf8");
  } catch {
    return null;
  }
}

export function decodeSuccessValue(value) {
  if (value == null || value === "") return null;
  const text = decodeBase64Utf8(value);
  if (text == null) return value;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function request(url, options = {}) {
  const apiKey = options.apiKey ?? getApiKey();
  const headers = new Headers(options.headers || {});
  if (options.json !== false && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (apiKey && options.bearer !== false && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }

  let finalUrl = url;
  if (apiKey && options.queryApiKey) {
    finalUrl = withApiKey(finalUrl, apiKey);
  }

  const init = {
    method: options.method || "GET",
    headers,
    redirect: options.redirect,
  };
  if (options.body !== undefined) {
    init.body =
      options.json === false || typeof options.body === "string"
        ? options.body
        : JSON.stringify(options.body);
  }

  const res = await fetch(finalUrl, init);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `${init.method} ${new URL(finalUrl).origin}${new URL(finalUrl).pathname} failed: ${res.status} ${res.statusText}\n${truncate(text, 400)}`
    );
  }
  return res;
}

export async function requestJson(url, options = {}) {
  const res = await request(url, options);
  return { data: await res.json(), response: res };
}

export async function rpcCall(network, method, params, options = {}) {
  const cfg = getNetworkConfig(network);
  const url = options.archival ? cfg.archivalRpc : cfg.rpc;
  const { data } = await requestJson(url, {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: options.id || "fastnear",
      method,
      params,
    },
  });
  return data;
}

export async function txApiPost(network, pathname, body) {
  const cfg = getNetworkConfig(network);
  const { data } = await requestJson(`${cfg.txApi}${pathname}`, {
    method: "POST",
    body,
  });
  return data;
}

export async function fetchAccountHistory(network, accountId, opts = {}) {
  const body = { account_id: accountId };
  if (opts.limit != null) body.limit = Number(opts.limit);
  if (opts.desc != null) body.desc = Boolean(opts.desc);
  if (opts.fromBlock != null) body.from_tx_block_height = Number(opts.fromBlock);
  if (opts.toBlock != null) body.to_tx_block_height = Number(opts.toBlock);
  if (opts.resumeToken) body.resume_token = opts.resumeToken;
  if (opts.isSigner) body.is_signer = true;
  if (opts.isReceiver) body.is_receiver = true;
  if (opts.isPredecessor) body.is_predecessor = true;
  if (opts.isFunctionCall) body.is_function_call = true;
  if (opts.isRealReceiver) body.is_real_receiver = true;
  if (opts.isRealSigner) body.is_real_signer = true;
  if (opts.isAnySigner) body.is_any_signer = true;
  if (opts.isDelegatedSigner) body.is_delegated_signer = true;
  if (opts.isActionArg) body.is_action_arg = true;
  if (opts.isEventLog) body.is_event_log = true;
  if (opts.isExplicitRefundTo) body.is_explicit_refund_to = true;
  if (opts.isSuccess === true) body.is_success = true;
  else if (opts.isSuccess === false) body.is_success = false;
  return txApiPost(network, "/v0/account", body);
}

export async function fetchBlock(network, blockId, opts = {}) {
  const id = typeof blockId === "string" && /^\d+$/.test(blockId) ? Number(blockId) : blockId;
  return txApiPost(network, "/v0/block", {
    block_id: id,
    with_receipts: Boolean(opts.withReceipts),
    with_transactions: Boolean(opts.withTransactions),
  });
}

export async function fetchBlockRange(network, fromHeight, toHeight, opts = {}) {
  return txApiPost(network, "/v0/blocks", {
    from_block_height: Number(fromHeight),
    to_block_height: Number(toHeight),
    limit: Number(opts.limit ?? 10),
    desc: Boolean(opts.desc),
  });
}

export async function fetchTransactions(network, txHashes) {
  return txApiPost(network, "/v0/transactions", { tx_hashes: txHashes });
}

export async function fetchReceipt(network, receiptId) {
  return txApiPost(network, "/v0/receipt", { receipt_id: receiptId });
}

export async function nearDataGet(network, pathname) {
  const cfg = getNetworkConfig(network);
  return requestJson(`${cfg.nearData}${pathname}`, {
    method: "GET",
    bearer: false,
    queryApiKey: true,
  });
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
