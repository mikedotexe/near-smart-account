import {
  decodeBase64Utf8,
  decodeSuccessValue,
  fetchBlock,
  fetchTransactions,
  getNetworkConfig,
  rpcCall,
  shortHash,
  truncate,
} from "./fastnear.mjs";

export async function resolveSenderId(network, txHash) {
  const json = await fetchTransactions(network, [txHash]);
  return json.transactions?.[0]?.transaction?.signer_id || null;
}

function isUnknownTransaction(error) {
  if (!error) return false;
  if (error.cause?.name === "UNKNOWN_TRANSACTION") return true;
  return /UNKNOWN_TRANSACTION/.test(
    `${error.name || ""} ${error.message || ""} ${error.data || ""}`
  );
}

export async function fetchTxStatus(
  network,
  txHash,
  senderId,
  waitUntil = "EXECUTED_OPTIMISTIC",
  opts = {}
) {
  const params = {
    tx_hash: txHash,
    sender_account_id: senderId,
    wait_until: waitUntil,
  };
  const cfg = opts.networkConfig || getNetworkConfig(network);
  const rpcCallFn = opts.rpcCallFn || rpcCall;
  const retryCount = opts.retryCount ?? 2;
  const retryDelayMs = opts.retryDelayMs ?? 250;
  const timeoutMs = opts.timeoutMs ?? 5_000;

  let raw = await callRpcWithRetry({
    network,
    params,
    rpcCallFn,
    urls: [cfg.rpc, cfg.officialRpc].filter(Boolean),
    retryCount,
    retryDelayMs,
    timeoutMs,
  });
  if (isUnknownTransaction(raw.error)) {
    raw = await callRpcWithRetry({
      network,
      params,
      rpcCallFn,
      urls: [cfg.archivalRpc].filter(Boolean),
      retryCount,
      retryDelayMs,
      timeoutMs,
      archival: true,
    });
  }
  return raw;
}

async function callRpcWithRetry({
  network,
  params,
  rpcCallFn,
  urls,
  retryCount,
  retryDelayMs,
  timeoutMs,
  archival = false,
}) {
  let lastError = null;

  for (const url of urls) {
    for (let attempt = 0; attempt <= retryCount; attempt += 1) {
      try {
        return await rpcCallFn(network, "EXPERIMENTAL_tx_status", params, {
          archival,
          url,
          timeoutMs,
        });
      } catch (error) {
        lastError = error;
        if (attempt < retryCount) {
          await sleep(retryDelayMs);
        }
      }
    }
  }

  throw lastError;
}

function statusTag(status) {
  if (status === "Unknown") return "Unknown";
  if (typeof status !== "object" || status === null) return "Unknown";
  if ("SuccessValue" in status) return "SuccessValue";
  if ("SuccessReceiptId" in status) return "SuccessReceiptId";
  if ("Failure" in status) return "Failure";
  return "Unknown";
}

function renderStatusTag(tag) {
  return tag === "pending_yield" ? "waiting_for_resume" : tag;
}

function walkReceipts(tree, visit) {
  function walk(node, parentId, depth) {
    if (!node || node.kind !== "receipt") return;
    visit(node, parentId, depth);
    for (const child of node.children || []) {
      walk(child, node.id, depth + 1);
    }
  }

  for (const child of tree.children || []) {
    walk(child, null, 0);
  }
}

function summarizeAction(action) {
  if (typeof action === "string") return action;
  const key = Object.keys(action || {})[0];
  if (!key) return "?";
  if (key === "FunctionCall") {
    const fn = action.FunctionCall;
    const decodedArgs = decodeBase64Utf8(fn.args);
    const preview = decodedArgs == null ? "<non-utf8>" : truncate(decodedArgs, 60);
    return `FunctionCall(${fn.method_name}, gas=${fn.gas}, args=${preview})`;
  }
  if (key === "Transfer") return `Transfer(${action.Transfer.deposit})`;
  return key;
}

export function buildTree(rpcResult) {
  const result = rpcResult.result;
  if (!result) {
    return { kind: "error", error: rpcResult.error || "missing result" };
  }

  const outById = new Map(
    (result.receipts_outcome || []).map((outcome) => [outcome.id, outcome])
  );
  const receiptById = new Map(
    (result.receipts || []).map((receipt) => [receipt.receipt_id, receipt])
  );
  const seen = new Set();

  function walkReceipt(id) {
    if (seen.has(id)) return { kind: "receipt", id, dedupe: true, children: [] };
    seen.add(id);

    const out = outById.get(id);
    if (!out) return { kind: "receipt", id, missing: true, children: [] };

    const raw = receiptById.get(id);
    const action = raw?.receipt?.Action;
    const isPromiseYield = action?.is_promise_yield === true;
    const status = out.outcome.status;
    let tag = statusTag(status);
    if (isPromiseYield && tag === "SuccessReceiptId") tag = "pending_yield";

    return {
      kind: "receipt",
      id,
      executor: out.outcome.executor_id,
      predecessor: raw?.predecessor_id || "?",
      isRefund: raw?.predecessor_id === "system",
      isPromiseYield,
      actions: (action?.actions || []).map(summarizeAction),
      inputDataIds: action?.input_data_ids || [],
      outputDataReceivers: action?.output_data_receivers || [],
      logs: out.outcome.logs || [],
      gasBurnt: out.outcome.gas_burnt ?? 0,
      tokensBurnt: out.outcome.tokens_burnt ?? 0,
      blockHash: out.block_hash || null,
      statusTag: tag,
      returnValue:
        tag === "SuccessValue"
          ? decodeSuccessValue(status.SuccessValue)
          : undefined,
      failure: tag === "Failure" ? status.Failure : undefined,
      children: (out.outcome.receipt_ids || []).map(walkReceipt),
    };
  }

  const txOutcome = result.transaction_outcome?.outcome;
  return {
    kind: "tx",
    txHash: result.transaction?.hash,
    signer: result.transaction?.signer_id,
    receiver: result.transaction?.receiver_id,
    finality: result.final_execution_status,
    finalStatus: result.status,
    gasBurntTx: txOutcome?.gas_burnt ?? 0,
    tokensBurntTx: txOutcome?.tokens_burnt ?? 0,
    includedBlockHash: result.transaction_outcome?.block_hash || null,
    children: (txOutcome?.receipt_ids || []).map(walkReceipt),
  };
}

export function flattenReceiptTree(tree) {
  if (!tree || tree.kind !== "tx") return [];

  const flat = [];
  let ordinal = 0;

  walkReceipts(tree, (node, parentId, depth) => {
    if (node.dedupe) return;
    flat.push({
      ordinal: ordinal++,
      id: node.id,
      parentId,
      depth,
      executor: node.executor,
      predecessor: node.predecessor,
      isRefund: node.isRefund,
      isPromiseYield: node.isPromiseYield,
      actions: [...(node.actions || [])],
      inputDataIds: [...(node.inputDataIds || [])],
      outputDataReceivers: [...(node.outputDataReceivers || [])],
      logs: [...(node.logs || [])],
      gasBurnt: node.gasBurnt ?? 0,
      tokensBurnt: node.tokensBurnt ?? 0,
      blockHash: node.blockHash || null,
      statusTag: node.statusTag,
      status: renderStatusTag(node.statusTag),
      returnValue: node.returnValue,
      failure: node.failure,
    });
  });

  return flat;
}

/**
 * Extract block-hash anchors from a trace for archival retrospective.
 * Returns:
 *   - transaction_block_hash: block hash where the tx itself was included
 *   - receipts: [{ receipt_id, block_hash }] for every non-dedupe node in
 *     the trace tree, in walk order
 *
 * Block heights are intentionally omitted here — the trace tree doesn't
 * carry them, and the per-event `runtime.block_height` in the structured
 * events captures them at the event granularity retrospectives need.
 * block_hashes are the pin-in-history anchor that lets an archival node
 * answer `view_state` / `view_account` at exactly that block.
 */
export function extractBlockInfo(trace) {
  if (!trace || !trace.tree) {
    return null;
  }
  const receipts = flattenReceiptTree(trace.tree).map((r) => ({
    receipt_id: r.id,
    block_hash: r.blockHash,
  }));
  return {
    transaction_block_hash: trace.tree.includedBlockHash ?? null,
    receipts,
  };
}

export function indexTraceBlockMetadata(tree, blockResponses) {
  const blockInfoByHash = new Map();
  const receiptLocations = new Map();

  for (const response of blockResponses) {
    const block = response?.block;
    if (!block?.block_hash) continue;

    blockInfoByHash.set(block.block_hash, {
      blockHash: block.block_hash,
      blockHeight: block.block_height ?? null,
      blockTimestamp: block.block_timestamp ?? null,
    });

    for (const row of response.block_receipts || []) {
      receiptLocations.set(row.receipt_id, {
        blockHash: block.block_hash,
        blockHeight: block.block_height ?? null,
        blockTimestamp: block.block_timestamp ?? null,
        receiptIndex: row.receipt_index ?? null,
        transactionHash: row.transaction_hash ?? null,
        receiptType: row.receipt_type ?? null,
        isSuccess: row.is_success ?? null,
      });
    }
  }

  const includedBlockInfo =
    tree?.includedBlockHash != null ? blockInfoByHash.get(tree.includedBlockHash) || null : null;

  return {
    blockInfoByHash,
    receiptLocations,
    includedBlockInfo,
  };
}

export async function fetchTraceBlockMetadata(network, tree, opts = {}) {
  if (!tree || tree.kind !== "tx") {
    return {
      blockInfoByHash: new Map(),
      receiptLocations: new Map(),
      includedBlockInfo: null,
    };
  }

  const fetchBlockFn = opts.fetchBlockFn || fetchBlock;
  const receiptBlockHashes = new Set();
  for (const receipt of flattenReceiptTree(tree)) {
    if (receipt.blockHash) receiptBlockHashes.add(receipt.blockHash);
  }

  const allBlockHashes = new Set(receiptBlockHashes);
  if (tree.includedBlockHash) allBlockHashes.add(tree.includedBlockHash);

  const responses = await Promise.all(
    [...allBlockHashes].map((blockHash) =>
      fetchBlockFn(network, blockHash, {
        withReceipts: receiptBlockHashes.has(blockHash),
      })
    )
  );

  return indexTraceBlockMetadata(tree, responses);
}

export function materializeFlattenedReceipts(tree, blockMetadata) {
  const flat = flattenReceiptTree(tree);

  return flat
    .map((receipt) => {
      const located = blockMetadata?.receiptLocations?.get(receipt.id) || null;
      const blockInfo =
        (receipt.blockHash && blockMetadata?.blockInfoByHash?.get(receipt.blockHash)) || null;

      return {
        ...receipt,
        blockHash: located?.blockHash || receipt.blockHash || null,
        blockHeight: located?.blockHeight ?? blockInfo?.blockHeight ?? null,
        blockTimestamp: located?.blockTimestamp ?? blockInfo?.blockTimestamp ?? null,
        receiptIndex: located?.receiptIndex ?? null,
        receiptType: located?.receiptType ?? null,
        transactionHash: located?.transactionHash ?? null,
        isSuccess: located?.isSuccess ?? null,
      };
    })
    .sort((a, b) => {
      const byHeight = compareNullableNumbers(a.blockHeight, b.blockHeight);
      if (byHeight !== 0) return byHeight;
      const byIndex = compareNullableNumbers(a.receiptIndex, b.receiptIndex);
      if (byIndex !== 0) return byIndex;
      return a.ordinal - b.ordinal;
    });
}

function compareNullableNumbers(a, b) {
  const av = a == null ? Number.POSITIVE_INFINITY : Number(a);
  const bv = b == null ? Number.POSITIVE_INFINITY : Number(b);
  if (av < bv) return -1;
  if (av > bv) return 1;
  return 0;
}

export function classify(tree) {
  if (tree.kind !== "tx") return "UNKNOWN";
  const top = tree.finalStatus;
  const topFail = typeof top === "object" && top !== null && "Failure" in top;

  let anyFail = false;
  let anyPending = false;

  function walk(node) {
    if (!node || node.kind !== "receipt") return;
    const nonDedupeChildren = (node.children || []).filter((child) => !child.dedupe);
    if (node.statusTag === "Failure" && !node.isRefund) anyFail = true;
    if (node.missing || node.statusTag === "Unknown") {
      anyPending = true;
    }
    if (node.statusTag === "pending_yield" && nonDedupeChildren.length === 0) {
      anyPending = true;
    }
    for (const child of node.children) walk(child);
  }

  for (const child of tree.children) walk(child);

  if (topFail) return "HARD_FAIL";
  if (anyPending) return "PENDING";
  if (anyFail) return "PARTIAL_FAIL";
  return "FULL_SUCCESS";
}

function renderLine(node, indent, lines) {
  if (!node || node.kind !== "receipt") return;
  if (node.dedupe) {
    lines.push(`${indent}↻ ${shortHash(node.id)} (dedupe)`);
    return;
  }
  if (node.missing) {
    lines.push(`${indent}? ${shortHash(node.id)} (missing outcome)`);
    return;
  }

  const marker =
    node.statusTag === "SuccessValue"
      ? "✓"
      : node.statusTag === "SuccessReceiptId"
      ? "→"
      : node.statusTag === "Failure"
      ? "✗"
      : node.statusTag === "pending_yield"
      ? "…"
      : "?";
  const kind = node.isRefund ? " [refund]" : node.isPromiseYield ? " [yield]" : "";
  const renderedTag = renderStatusTag(node.statusTag);
  const actions = node.actions.length ? `  ${node.actions.join(", ")}` : "";
  const value =
    node.statusTag === "SuccessValue"
      ? `  ⇒ ${JSON.stringify(node.returnValue)}`
      : node.statusTag === "Failure"
      ? `  ⇒ ${truncate(JSON.stringify(node.failure), 120)}`
      : "";
  lines.push(
    `${indent}${marker} ${shortHash(node.id)} ${renderedTag}${kind}  @${node.executor}${actions}${value}`
  );
  if (node.inputDataIds.length) {
    lines.push(
      `${indent}   input_data_ids=[${node.inputDataIds.map(shortHash).join(", ")}]`
    );
  }
  for (const log of node.logs) {
    lines.push(`${indent}   log: ${log}`);
  }
  for (const child of node.children) renderLine(child, `${indent}  `, lines);
}

export function renderText(tree) {
  if (tree.kind === "error") return `error: ${JSON.stringify(tree.error)}`;
  if (tree.kind !== "tx") return "(empty)";

  const lines = [];
  lines.push(
    `tx ${shortHash(tree.txHash)}  signer=${tree.signer}  receiver=${tree.receiver}`
  );
  lines.push(`  finality=${tree.finality}  tx.gas_burnt=${tree.gasBurntTx}`);
  for (const child of tree.children) renderLine(child, "  ", lines);
  return lines.join("\n");
}

export async function traceTx(network, txHash, senderId, waitUntil) {
  const resolvedSender = senderId || (await resolveSenderId(network, txHash));
  if (!resolvedSender) {
    throw new Error(
      `could not resolve sender for tx ${txHash}; pass the sender account id explicitly`
    );
  }
  const raw = await fetchTxStatus(network, txHash, resolvedSender, waitUntil);
  if (raw.error) {
    return {
      senderId: resolvedSender,
      classification: "ERROR",
      tree: null,
      raw,
      error: raw.error,
    };
  }
  const tree = buildTree(raw);
  return {
    senderId: resolvedSender,
    classification: classify(tree),
    tree,
    raw,
    error: null,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
