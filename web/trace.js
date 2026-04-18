// trace.js — pure FastNEAR-RPC DAG walker.
//
// Implements the algorithm in md-CLAUDE-chapters/01-near-cross-contract-tracing.md
// §2.4 "Canonical trace reconstruction algorithm":
//
//   1. EXPERIMENTAL_tx_status(tx_hash, sender, wait_until=FINAL)
//   2. Index receipts_outcome by receipt_id
//   3. DFS from transaction_outcome.receipt_ids[0]
//   4. Dedupe by receipt_id (promise_and → DAG, not tree)
//   5. Classify: scan every outcome for Failure → PARTIAL_FAIL vs FULL_SUCCESS
//   6. Filter refund receipts (predecessor_id === "system") for user-facing views
//
// Also exports receiptToTx() which uses FastNEAR's bespoke
// POST tx.test.fastnear.com/v0/receipt endpoint to pivot from an
// opaque receipt_id back to its originating tx (chapter §2.1, §3.5).

const TESTNET_RPC = "https://rpc.testnet.fastnear.com";
const TESTNET_ARCHIVAL = "https://archival-rpc.testnet.fastnear.com";
const TESTNET_RECEIPT_LOOKUP = "https://tx.test.fastnear.com/v0/receipt";

/** Tack `?apiKey=` onto a URL when we have a key. Idempotent. */
function withApiKey(url, apiKey) {
  if (!apiKey) return url;
  const u = new URL(url);
  u.searchParams.set("apiKey", apiKey);
  return u.toString();
}

/** Fetch headers including Bearer when we have a key. FastNEAR accepts either
 * form; we send both so endpoint quirks don't bite. */
function authHeaders(apiKey) {
  const h = { "Content-Type": "application/json" };
  if (apiKey) h.Authorization = `Bearer ${apiKey}`;
  return h;
}

/** One JSON-RPC round trip. Throws only on transport / JSON errors. */
async function rpc(url, method, params, apiKey) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: "trace", method, params });
  const res = await fetch(withApiKey(url, apiKey), {
    method: "POST",
    headers: authHeaders(apiKey),
    body,
  });
  return res.json();
}

/**
 * Fetch EXPERIMENTAL_tx_status with archival failover on UNKNOWN_TRANSACTION,
 * per chapter §2.5. Regular testnet RPC has a ~3-epoch window; if the hash has
 * aged out we silently retry against archival.
 */
async function fetchTxStatus(txHash, senderId, waitUntil, apiKey) {
  const params = {
    tx_hash: txHash,
    sender_account_id: senderId,
    wait_until: waitUntil,
  };

  let r = await rpc(TESTNET_RPC, "EXPERIMENTAL_tx_status", params, apiKey);
  if (r.error && r.error.cause && r.error.cause.name === "UNKNOWN_TRANSACTION") {
    r = await rpc(TESTNET_ARCHIVAL, "EXPERIMENTAL_tx_status", params, apiKey);
  }
  return r;
}

/** Decode a SuccessValue (base64) as JSON, falling back to text. */
function decodeSuccessValue(b64) {
  if (b64 == null || b64 === "") return null; // ReturnData::None is expected
  try {
    const buf = atob(b64);
    try {
      return JSON.parse(buf);
    } catch {
      return buf;
    }
  } catch {
    return b64;
  }
}

/** Classify status per chapter §1.8; returns one of the handful of tags the UI
 * renders. Never throws. */
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

/**
 * Build a normalized receipt-tree rooted at the originating receipt.
 *
 *   { kind: "tx", txHash, signer, receiver, status, children: [...] }
 *   { kind: "receipt", id, executor, predecessor, status, statusTag,
 *     returnValue?, logs, gasBurnt, tokensBurnt, actions[], inputDataIds[],
 *     outputDataReceivers[], isPromiseYield, isRefund, children: [...] }
 *
 * Dedupes children by receipt_id (promise_and can produce DAG joins).
 */
export function buildTree(rpcResult) {
  const r = rpcResult.result;
  if (!r) return { kind: "error", error: rpcResult.error ?? "missing result" };

  const outById = new Map(r.receipts_outcome.map((o) => [o.id, o]));
  const receiptById = new Map((r.receipts ?? []).map((rc) => [rc.receipt_id, rc]));
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

    // Yield detection: an Action receipt with is_promise_yield=true whose
    // outcome is still SuccessReceiptId (chained to its callback) hasn't been
    // resumed yet. Chapter §5 gotcha #6.
    if (isPromiseYield && tag === "SuccessReceiptId") tag = "pending_yield";

    const returnValue =
      tag === "SuccessValue" ? decodeSuccessValue(status.SuccessValue) : undefined;

    const children = (out.outcome.receipt_ids || []).map(walkReceipt);

    return {
      kind: "receipt",
      id,
      executor: out.outcome.executor_id,
      predecessor: raw?.predecessor_id ?? "?",
      isRefund: raw?.predecessor_id === "system",
      isPromiseYield,
      actions: (action?.actions ?? []).map(summarizeAction),
      inputDataIds: action?.input_data_ids ?? [],
      outputDataReceivers: action?.output_data_receivers ?? [],
      logs: out.outcome.logs ?? [],
      gasBurnt: BigInt(out.outcome.gas_burnt ?? 0),
      tokensBurnt: BigInt(out.outcome.tokens_burnt ?? 0),
      statusTag: tag,
      returnValue,
      failure: tag === "Failure" ? status.Failure : undefined,
      children,
    };
  }

  const txOutcome = r.transaction_outcome?.outcome;
  const rootIds = txOutcome?.receipt_ids ?? [];

  return {
    kind: "tx",
    txHash: r.transaction?.hash,
    signer: r.transaction?.signer_id,
    receiver: r.transaction?.receiver_id,
    finality: r.final_execution_status, // TxExecutionStatus
    finalStatus: r.status, // FinalExecutionStatus
    gasBurntTx: BigInt(txOutcome?.gas_burnt ?? 0),
    tokensBurntTx: BigInt(txOutcome?.tokens_burnt ?? 0),
    children: rootIds.map(walkReceipt),
  };
}

function summarizeAction(a) {
  if (typeof a === "string") return a; // e.g. "CreateAccount"
  const key = Object.keys(a)[0];
  if (key === "FunctionCall") {
    const f = a.FunctionCall;
    let argsPreview = "";
    try {
      argsPreview = atob(f.args);
      if (argsPreview.length > 60) argsPreview = argsPreview.slice(0, 60) + "…";
    } catch {
      argsPreview = "<non-utf8>";
    }
    return `FunctionCall(${f.method_name}, gas=${f.gas}, args=${argsPreview})`;
  }
  if (key === "Transfer") return `Transfer(${a.Transfer.deposit})`;
  return key;
}

/**
 * Scan every receipt outcome in the tree for Failure. Classification per
 * chapter §4.6:
 *   HARD_FAIL     — top-level status is Failure
 *   PARTIAL_FAIL  — top-level SuccessValue but some sibling failed
 *   PENDING       — any waiting-for-resume yield (`pending_yield`) or Unknown
 *   FULL_SUCCESS  — terminal SuccessValue, no failures, no pending
 */
export function classify(tree) {
  if (tree.kind !== "tx") return "UNKNOWN";
  const top = tree.finalStatus;
  const topFail = typeof top === "object" && top !== null && "Failure" in top;

  let anyFail = false;
  let anyPending = false;

  const walk = (n) => {
    if (!n || n.kind !== "receipt") return;
    if (n.statusTag === "Failure" && !n.isRefund) anyFail = true;
    if (n.statusTag === "pending_yield" || n.statusTag === "Unknown")
      anyPending = true;
    for (const c of n.children) walk(c);
  };
  for (const c of tree.children) walk(c);

  if (topFail) return "HARD_FAIL";
  if (anyPending) return "PENDING";
  if (anyFail) return "PARTIAL_FAIL";
  return "FULL_SUCCESS";
}

/**
 * One-shot trace. Callers typically re-invoke on an interval for PENDING
 * results (yield/resume stalls) per chapter §1.9.
 */
export async function traceTx({ txHash, senderId, waitUntil = "EXECUTED_OPTIMISTIC", apiKey }) {
  const raw = await fetchTxStatus(txHash, senderId, waitUntil, apiKey);
  if (raw.error) {
    return { error: raw.error, tree: null, classification: "ERROR" };
  }
  const tree = buildTree(raw);
  return { error: null, tree, classification: classify(tree), raw };
}

/**
 * Receipt → originating tx pivot. Chapter §2.1, §3.5: no JSON-RPC equivalent
 * exists; this is the fastest path from an opaque receipt_id to a tx_hash.
 */
export async function receiptToTx(receiptId, apiKey) {
  const res = await fetch(withApiKey(TESTNET_RECEIPT_LOOKUP, apiKey), {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify({ receipt_id: receiptId }),
  });
  return res.json();
}

/**
 * Render a tree (from buildTree) as an indented string for the <pre> panel.
 * Deliberately text-based so it's trivially copy-pastable; richer HTML lives
 * in renderHtml().
 */
export function renderText(tree) {
  if (tree.kind === "error") return `error: ${JSON.stringify(tree.error)}`;
  if (tree.kind !== "tx") return "(empty)";

  const lines = [];
  lines.push(`tx ${shortHash(tree.txHash)}  signer=${tree.signer}  receiver=${tree.receiver}`);
  lines.push(`  finality=${tree.finality}  tx.gas_burnt=${tree.gasBurntTx}`);
  for (const c of tree.children) renderLine(c, "  ", lines);
  return lines.join("\n");
}

function renderLine(n, indent, lines) {
  if (!n) return;
  if (n.kind !== "receipt") return;
  if (n.dedupe) {
    lines.push(`${indent}↻ ${shortHash(n.id)} (dedupe — seen via promise_and)`);
    return;
  }
  if (n.missing) {
    lines.push(`${indent}? ${shortHash(n.id)} (no outcome in response)`);
    return;
  }
  const marker =
    n.statusTag === "SuccessValue"     ? "✓" :
    n.statusTag === "SuccessReceiptId" ? "→" :
    n.statusTag === "Failure"          ? "✗" :
    n.statusTag === "pending_yield"    ? "…" : "?";
  const kind = n.isRefund ? " [refund]" : n.isPromiseYield ? " [yield]" : "";
  const renderedTag = renderStatusTag(n.statusTag);
  const act = n.actions.length ? `  ${n.actions.join(", ")}` : "";
  const value = n.statusTag === "SuccessValue"
    ? `  ⇒ ${JSON.stringify(n.returnValue)}`
    : n.statusTag === "Failure"
    ? `  ⇒ ${JSON.stringify(n.failure).slice(0, 120)}`
    : "";
  lines.push(
    `${indent}${marker} ${shortHash(n.id)} ${renderedTag}${kind}  @${n.executor}${act}${value}`
  );
  if (n.inputDataIds.length) {
    lines.push(`${indent}   input_data_ids=[${n.inputDataIds.map(shortHash).join(", ")}]`);
  }
  for (const l of n.logs) {
    lines.push(`${indent}   log: ${l}`);
  }
  for (const c of n.children) renderLine(c, indent + "  ", lines);
}

function shortHash(h) {
  if (!h) return "?";
  return `${h.slice(0, 6)}…${h.slice(-4)}`;
}
