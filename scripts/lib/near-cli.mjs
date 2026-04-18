import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fetchTransactions, getNetworkConfig, rpcCall } from "./fastnear.mjs";

export function loadNearApi() {
  const requireFromHere = createRequire(import.meta.url);
  const candidates = [
    path.resolve(path.dirname(process.execPath), "../lib/node_modules/near-cli"),
    path.join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "near-cli"),
  ];

  for (const candidate of candidates) {
    try {
      const modulePath = requireFromHere.resolve("near-api-js", {
        paths: [candidate],
      });
      return requireFromHere(modulePath);
    } catch {
      // try the next candidate
    }
  }

  throw new Error(
    "could not resolve near-api-js from the installed near CLI; install the JS near CLI first"
  );
}

export async function loadCredential(keyStore, nearApi, network, signer) {
  const credentialPath = path.join(os.homedir(), ".near-credentials", network, `${signer}.json`);
  if (!fs.existsSync(credentialPath)) {
    throw new Error(`missing credential file: ${credentialPath}`);
  }
  const credential = JSON.parse(fs.readFileSync(credentialPath, "utf8"));
  const keyPair = nearApi.KeyPair.fromString(credential.private_key);
  await keyStore.setKey(network, signer, keyPair);
}

export async function connectNearWithSigners(network, signers) {
  const nearApi = loadNearApi();
  const keyStore = new nearApi.keyStores.InMemoryKeyStore();

  const dedupedSigners = [...new Set(signers.filter(Boolean))];
  for (const signer of dedupedSigners) {
    await loadCredential(keyStore, nearApi, network, signer);
  }

  const cfg = getNetworkConfig(network);
  const near = await nearApi.connect({
    networkId: network,
    nodeUrl: cfg.rpc,
    deps: { keyStore },
  });

  const accounts = {};
  for (const signer of dedupedSigners) {
    accounts[signer] = await near.account(signer);
  }

  return { nearApi, near, keyStore, cfg, accounts };
}

export async function sendFunctionCall(
  nearApi,
  account,
  receiverId,
  methodName,
  args,
  gasTgas,
  attachedDepositYocto = 0n
) {
  return account.signAndSendTransaction({
    receiverId,
    actions: [
      nearApi.transactions.functionCall(
        methodName,
        Buffer.from(JSON.stringify(args)),
        BigInt(gasTgas) * 10n ** 12n,
        BigInt(attachedDepositYocto)
      ),
    ],
  });
}

// Block-pinned or finality-pinned view call. Exactly one of opts.blockId /
// opts.finality applies; if neither is passed, default is finality: "final".
// blockId accepts a numeric height, numeric string, or block hash.
export async function callViewMethod(network, accountId, methodName, args = {}, opts = {}) {
  const pin = {};
  if (opts.blockId != null) {
    pin.block_id = /^\d+$/.test(String(opts.blockId)) ? Number(opts.blockId) : opts.blockId;
  } else {
    pin.finality = opts.finality || "final";
  }
  const res = await rpcCall(network, "query", {
    request_type: "call_function",
    account_id: accountId,
    method_name: methodName,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    ...pin,
  });
  if (res.error) {
    throw new Error(JSON.stringify(res.error));
  }
  if (res.result?.error) {
    throw new Error(`${accountId}.${methodName} failed: ${res.result.error}`);
  }
  const bytes = Buffer.from(res.result?.result || []);
  const value = bytes.length === 0 ? null : decodeViewBytes(bytes);
  return {
    value,
    block_height: res.result?.block_height ?? null,
    block_hash: res.result?.block_hash ?? null,
    logs: res.result?.logs || [],
  };
}

function decodeViewBytes(bytes) {
  const text = bytes.toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function callView(network, accountId, methodName, args) {
  const { value } = await callViewMethod(network, accountId, methodName, args);
  return value;
}

// Raw view_state passthrough. Exactly one of opts.blockId / opts.finality
// applies; default finality: "final". prefixBase64 filters storage keys.
// Returns the raw rpcCall response so callers can reach result.values /
// result.block_height / result.error as needed.
export async function viewContractState(network, accountId, opts = {}) {
  const pin = {};
  if (opts.blockId != null) {
    pin.block_id = /^\d+$/.test(String(opts.blockId)) ? Number(opts.blockId) : opts.blockId;
  } else {
    pin.finality = opts.finality || "final";
  }
  return rpcCall(network, "query", {
    request_type: "view_state",
    account_id: accountId,
    prefix_base64: opts.prefixBase64 || "",
    ...pin,
  });
}

export async function buildTxArtifact(network, result, signer, step) {
  const txHash = result.transaction?.hash || result.transaction_outcome?.id || "?";
  const details = await fetchTransactions(network, [txHash]);
  const tx = details.transactions?.[0];
  return {
    step,
    signer,
    receiver_id: tx?.transaction?.receiver_id || result.transaction?.receiver_id || "?",
    tx_hash: txHash,
    block_hash: tx?.execution_outcome?.block_hash || result.transaction_outcome?.block_hash || null,
    block_height: tx?.execution_outcome?.block_height || null,
    status: tx?.execution_outcome?.outcome?.status || result.status || null,
  };
}
