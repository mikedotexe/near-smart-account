#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import { fetchAccountHistory, shortHash, truncate } from "./lib/fastnear.mjs";
import {
  fetchTraceBlockMetadata,
  materializeFlattenedReceipts,
  renderText,
  traceTx,
} from "./lib/trace-rpc.mjs";
import { callViewMethod } from "./lib/near-cli.mjs";
import { parseStructuredEvents, summarizeRuns } from "./lib/events.mjs";

export function parseViewSpec(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid --view JSON: ${error.message}`);
  }

  if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) {
    throw new Error("--view must be a JSON object");
  }
  if (typeof parsed.account !== "string" || !parsed.account) {
    throw new Error("--view.account must be a non-empty string");
  }
  if (typeof parsed.method !== "string" || !parsed.method) {
    throw new Error("--view.method must be a non-empty string");
  }
  const args =
    parsed.args == null
      ? {}
      : typeof parsed.args === "object" && !Array.isArray(parsed.args)
      ? parsed.args
      : (() => {
          throw new Error("--view.args must be a JSON object when provided");
        })();

  return {
    account: parsed.account,
    method: parsed.method,
    args,
  };
}

export function buildInterestingBlocks(includedBlockHeight, receipts, extendAfter = 0) {
  const heights = new Set();
  if (includedBlockHeight != null) heights.add(Number(includedBlockHeight));
  for (const receipt of receipts || []) {
    if (receipt.blockHeight != null) heights.add(Number(receipt.blockHeight));
  }

  const sortedReceiptHeights = [...heights].sort((a, b) => a - b);
  const lastObserved = sortedReceiptHeights.length
    ? sortedReceiptHeights[sortedReceiptHeights.length - 1]
    : includedBlockHeight != null
    ? Number(includedBlockHeight)
    : null;

  if (extendAfter > 0 && lastObserved != null) {
    heights.add(lastObserved + Number(extendAfter));
  }

  return [...heights].sort((a, b) => a - b);
}

export function buildCascadeWindow(includedBlockHeight, receipts, extendAfter = 0) {
  const interestingBlocks = buildInterestingBlocks(includedBlockHeight, receipts, extendAfter);
  const minBlock =
    includedBlockHeight != null
      ? Number(includedBlockHeight)
      : interestingBlocks.length
      ? interestingBlocks[0]
      : null;
  const maxObservedReceiptBlock =
    receipts && receipts.length
      ? Math.max(...receipts.map((receipt) => receipt.blockHeight ?? Number.NEGATIVE_INFINITY))
      : includedBlockHeight != null
      ? Number(includedBlockHeight)
      : null;
  const maxBlock =
    maxObservedReceiptBlock != null && maxObservedReceiptBlock !== Number.NEGATIVE_INFINITY
      ? maxObservedReceiptBlock + Number(extendAfter)
      : minBlock;

  return {
    minBlock,
    maxBlock,
    interestingBlocks,
    extendAfter: Number(extendAfter),
  };
}

function formatViewLabel(view) {
  return `${view.account}.${view.method}(${JSON.stringify(view.args)})`;
}

function formatInlineValue(value) {
  const rendered =
    typeof value === "string" ? value : JSON.stringify(value == null ? null : value);
  const text = truncate(rendered, 160).replace(/\|/g, "\\|").replace(/\n/g, " ");
  return `\`${text}\``;
}

function formatMetric(value, digits = 1) {
  if (value == null) return "`-`";
  if (typeof value === "number" && Number.isFinite(value)) {
    if (Number.isInteger(value)) return `\`${value}\``;
    return `\`${value.toFixed(digits)}\``;
  }
  return `\`${value}\``;
}

function classifyStepLifecycle(trace, receipts, structuredEvents) {
  const isStepLike =
    structuredEvents.some((event) => event.event === "step_registered") ||
    receipts.some((receipt) =>
      (receipt.actions || []).some(
        (action) => typeof action === "string" && action.includes("FunctionCall(register_step")
      )
    ) ||
    receipts.some((receipt) =>
      (receipt.logs || []).some((log) => typeof log === "string" && log.includes("register_step '"))
    );

  if (!isStepLike) return null;

  const yieldedReceipts = receipts.filter((receipt) => receipt.isPromiseYield);
  const pendingYieldCount = yieldedReceipts.filter(
    (receipt) => receipt.statusTag === "pending_yield"
  ).length;
  const resumeFailedCount = structuredEvents.filter(
    (event) => event.event === "sequence_halted" && event.data?.error_kind === "resume_failed"
  ).length;
  const yieldedReceiptCount = yieldedReceipts.length;
  const resumedYieldCount = Math.max(0, yieldedReceiptCount - pendingYieldCount);

  let classification = "register_like_tx_without_clear_outcome";
  let reason = "register-like transaction did not preserve enough live pending signal for a stronger classification";

  if (
    trace?.raw_final_status &&
    typeof trace.raw_final_status === "object" &&
    trace.raw_final_status !== null &&
    "Failure" in trace.raw_final_status &&
    yieldedReceiptCount === 0
  ) {
    classification = "hard_fail_before_register";
    reason = "register receipt failed before registered steps became visible";
  } else if (pendingYieldCount > 0) {
    classification = "pending_until_resume";
    reason = "registered step receipt is still pending and waiting for explicit release";
  } else if (resumeFailedCount > 0) {
    classification = "immediate_resume_failed";
    reason = "registered step callback resumed before the intended release path and halted on resume failure";
  } else if (resumedYieldCount > 0) {
    classification = "released_after_register";
    reason = "registered step callbacks were later resumed and executed downstream work";
  }

  return {
    classification,
    reason,
    yielded_receipt_count: yieldedReceiptCount,
    pending_yield_count: pendingYieldCount,
    resumed_yield_count: resumedYieldCount,
    resume_failed_count: resumeFailedCount,
  };
}

function renderAccountFlags(row) {
  const flags = [];
  if (row.is_signer) flags.push("signer");
  if (row.is_receiver) flags.push("receiver");
  if (row.is_predecessor) flags.push("predecessor");
  if (row.is_function_call) flags.push("function_call");
  if (row.is_real_receiver) flags.push("real_receiver");
  if (row.is_real_signer) flags.push("real_signer");
  if (row.is_any_signer) flags.push("any_signer");
  if (row.is_delegated_signer) flags.push("delegated_signer");
  if (row.is_action_arg) flags.push("action_arg");
  if (row.is_event_log) flags.push("event_log");
  if (row.is_explicit_refund_to) flags.push("explicit_refund_to");
  flags.push(row.is_success ? "success" : "not_success");
  return flags.join(", ");
}

export function partitionAccountActivityRows(rows, txHash) {
  const txRows = [];
  const otherRows = [];
  for (const row of rows) {
    if (row.transaction_hash === txHash) txRows.push(row);
    else otherRows.push(row);
  }
  return {
    tx_rows: txRows,
    other_rows_in_window_count: otherRows.length,
    window_row_count: rows.length,
  };
}

function formatReceiptNote(receipt) {
  const notes = [];
  if (receipt.logs?.length) notes.push(receipt.logs.join(" / "));
  if (receipt.statusTag === "SuccessValue" && receipt.returnValue !== undefined) {
    notes.push(`return ${truncate(JSON.stringify(receipt.returnValue), 100)}`);
  }
  if (receipt.statusTag === "Failure" && receipt.failure) {
    notes.push(`failure ${truncate(JSON.stringify(receipt.failure), 100)}`);
  }
  return notes.length ? notes.join(" | ").replace(/\|/g, "\\|") : "";
}

export function renderMarkdownReport(report) {
  const lines = [];
  lines.push(`# Investigate tx: ${shortHash(report.tx.hash)}`);
  lines.push("");
  lines.push(`**Tx:** \`${report.tx.hash}\``);
  lines.push(`**Signer:** \`${report.tx.signer}\``);
  lines.push(`**Receiver:** \`${report.tx.receiver}\``);
  lines.push(`**Included at block:** \`${report.tx.included_block_height ?? "?"}\``);
  lines.push(`**Classification:** \`${report.trace.classification}\``);
  lines.push(`**Gas burnt:** \`${report.tx.gas_burnt}\``);
  lines.push(
    `**Cascade window:** blocks \`${report.window.minBlock ?? "?"}\` .. \`${report.window.maxBlock ?? "?"}\` (inclusive)`
  );
  lines.push("");
  lines.push("## Surface 1: Receipt DAG");
  lines.push("");
  lines.push("```text");
  lines.push(report.trace.text);
  lines.push("```");
  lines.push("");
  lines.push("## Surface 2: State time-series");
  lines.push("");

  if (!report.state_snapshots.length) {
    lines.push("_No view specs requested._");
    lines.push("");
  } else {
    for (const snapshot of report.state_snapshots) {
      lines.push(`### \`${formatViewLabel(snapshot.view)}\``);
      lines.push("");
      lines.push("| Block | Value |");
      lines.push("|---|---|");
      for (const sample of snapshot.samples) {
        lines.push(`| ${sample.block_height ?? "?"} | ${formatInlineValue(sample.value)} |`);
      }
      lines.push("");
    }
  }

  lines.push("## Surface 3: Per-block receipts");
  lines.push("");
  if (!report.blocks.length) {
    lines.push("_No traced receipts found._");
    lines.push("");
  } else {
    for (const block of report.blocks) {
      lines.push(`### Block ${block.block_height}`);
      lines.push("");
      lines.push("| Receipt | From → To | Type | Status | Note |");
      lines.push("|---|---|---|---|---|");
      for (const receipt of block.receipts) {
        const type =
          receipt.receiptType ||
          (receipt.actions.length ? truncate(receipt.actions.join(", "), 80) : "Action");
        lines.push(
          `| \`${shortHash(receipt.id)}\` | \`${receipt.predecessor} → ${receipt.executor}\` | ${type.replace(/\|/g, "\\|")} | \`${receipt.status}\` | ${formatReceiptNote(receipt)} |`
        );
      }
      lines.push("");
    }
  }

  lines.push("## Account activity");
  lines.push("");
  for (const account of report.account_activity) {
    lines.push(`### \`${account.account_id}\``);
    lines.push("");
    if (!account.tx_rows.length) {
      if (account.other_rows_in_window_count > 0) {
        lines.push(
          `_No rows for this tx. Omitted ${account.other_rows_in_window_count} unrelated row(s) from the same block window._`
        );
      } else {
        lines.push("_No rows for this tx in the cascade window._");
      }
      lines.push("");
      continue;
    }
    if (account.other_rows_in_window_count > 0) {
      lines.push(
        `_Showing only rows for this tx. Omitted ${account.other_rows_in_window_count} unrelated row(s) from the same block window._`
      );
      lines.push("");
    }
    lines.push("| Block | Tx hash | Flags |");
    lines.push("|---|---|---|");
    for (const row of account.tx_rows) {
      lines.push(
        `| ${row.tx_block_height} | \`${shortHash(row.transaction_hash)}\` | ${renderAccountFlags(row).replace(/\|/g, "\\|")} |`
      );
    }
    lines.push("");
  }

  lines.push("## Sequence telemetry");
  lines.push("");
  if (!report.step_lifecycle && !report.run_summaries.length) {
    lines.push("_No sequence telemetry summary for this tx._");
    lines.push("");
  } else {
    if (report.step_lifecycle) {
      lines.push("### Step lifecycle");
      lines.push("");
      lines.push(`- classification: \`${report.step_lifecycle.classification}\``);
      lines.push(`- reason: ${report.step_lifecycle.reason}`);
      lines.push(`- yielded receipts: \`${report.step_lifecycle.yielded_receipt_count}\``);
      lines.push(`- pending yielded receipts: \`${report.step_lifecycle.pending_yield_count}\``);
      lines.push(`- resumed yielded receipts: \`${report.step_lifecycle.resumed_yield_count}\``);
      lines.push(`- resume-failed signals: \`${report.step_lifecycle.resume_failed_count}\``);
      lines.push("");
    }

    if (report.run_summaries.length) {
      lines.push("### Namespace metrics");
      lines.push("");
      lines.push(
        "| Namespace | Status | Steps ok/total | Duration ms | Resume latency ms avg/max | Resolve latency ms avg/max | Max used gas (TGas) | Latest storage | Error |"
      );
      lines.push("|---|---|---|---|---|---|---|---|---|");
      for (const run of report.run_summaries) {
        lines.push(
          `| \`${run.namespace}\` | \`${run.status}\` | \`${run.stepsResolvedOk}/${run.stepCount}\` | ${formatMetric(run.durationMs, 0)} | ${formatMetric(run.resumeLatencyMsAvg)}/${formatMetric(run.resumeLatencyMsMax, 0)} | ${formatMetric(run.resolveLatencyMsAvg)}/${formatMetric(run.resolveLatencyMsMax, 0)} | ${formatMetric(run.maxUsedGasTgas)} | ${formatMetric(run.latestStorageUsage, 0)} | \`${run.errorKind ?? "-"}\` |`
        );
      }
      lines.push("");
    }
  }

  lines.push("## Structured events");
  lines.push("");
  if (!report.structured_events.length) {
    lines.push("_No structured `sa-automation` events._");
    lines.push("");
  } else {
    if (report.run_summaries.length) {
      lines.push("### Run summaries");
      lines.push("");
      lines.push("| Namespace | Status | Trigger | Run nonce | Steps | Blocks | Failed step |");
      lines.push("|---|---|---|---|---|---|---|");
      for (const run of report.run_summaries) {
        const blockSpan =
          run.firstSeenBlockHeight != null && run.lastSeenBlockHeight != null
            ? `${run.firstSeenBlockHeight}..${run.lastSeenBlockHeight}`
            : "?";
        lines.push(
          `| \`${run.namespace}\` | \`${run.status}\` | \`${run.triggerId ?? "-"}\` | \`${run.runNonce ?? "-"}\` | \`${run.stepCount}\` | \`${blockSpan}\` | \`${run.failedStepId ?? "-"}\` |`
        );
      }
      lines.push("");
    }

    lines.push("### Receipt events");
    lines.push("");
    lines.push("| Block | Event | Namespace | Receipt | Details |");
    lines.push("|---|---|---|---|---|");
    for (const event of report.structured_events) {
      const namespace =
        typeof event.data?.namespace === "string" && event.data.namespace
          ? event.data.namespace
          : "-";
      lines.push(
        `| ${event.receipt.blockHeight ?? "?"} | \`${event.event}\` | \`${namespace}\` | \`${shortHash(event.receipt.id ?? "?")}\` | ${formatInlineValue(event.data)} |`
      );
    }
    lines.push("");
  }

  lines.push("## Logs");
  lines.push("");
  if (!report.logs.length) {
    lines.push("_No logs._");
    lines.push("");
  } else {
    lines.push("| Block | Account | Log |");
    lines.push("|---|---|---|");
    for (const row of report.logs) {
      lines.push(
        `| ${row.block_height ?? "?"} | \`${row.account}\` | ${truncate(row.log, 160).replace(/\|/g, "\\|")} |`
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

function getOutputTargets(format, outPath) {
  if (!outPath) return null;
  if (format === "both") {
    const parsed = path.parse(outPath);
    const base = parsed.ext ? path.join(parsed.dir, parsed.name) : outPath;
    return {
      markdown: `${base}.md`,
      json: `${base}.json`,
    };
  }
  return {
    [format]: outPath,
  };
}

export function writeReportOutputs(report, format, outPath) {
  const markdown = renderMarkdownReport(report);
  const json = JSON.stringify(report, null, 2);

  if (!outPath) {
    if (format === "markdown") return { stdout: markdown, files: [] };
    if (format === "json") return { stdout: json, files: [] };
    return { stdout: `${markdown}\n\n---\n\n${json}`, files: [] };
  }

  const targets = getOutputTargets(format, outPath);
  const files = [];
  for (const [kind, filePath] of Object.entries(targets)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, kind === "json" ? json : markdown);
    files.push(filePath);
  }
  return { stdout: files.map((filePath) => `wrote ${filePath}`).join("\n"), files };
}

async function fetchAccountHistoryWindow(network, accountId, window) {
  const rows = [];
  let resumeToken = null;

  do {
    const page = await fetchAccountHistory(network, accountId, {
      limit: 100,
      desc: false,
      fromBlock: window.minBlock,
      toBlock: window.maxBlock,
      resumeToken,
    });
    rows.push(...(page.account_txs || []));
    resumeToken = page.resume_token || null;
  } while (resumeToken);

  return rows.filter((row) => {
    if (window.minBlock != null && row.tx_block_height < window.minBlock) return false;
    if (window.maxBlock != null && row.tx_block_height > window.maxBlock) return false;
    return true;
  });
}

export async function buildInvestigateReport(
  network,
  txHash,
  signer,
  opts = {}
) {
  const waitUntil = opts.wait || "EXECUTED_OPTIMISTIC";
  const extendAfter = Number(opts.extendAfter ?? 0);
  const viewSpecs = (opts.viewSpecs || []).map((view) =>
    typeof view === "string" ? parseViewSpec(view) : view
  );
  const accounts = [...new Set([signer, ...(opts.accounts || [])].filter(Boolean))];

  const traced = await traceTx(network, txHash, signer, waitUntil);
  if (traced.error) {
    throw new Error(JSON.stringify(traced.error));
  }

  const blockMetadata = await fetchTraceBlockMetadata(network, traced.tree, {
    fetchBlockFn: opts.fetchBlockFn,
  });
  const receipts = materializeFlattenedReceipts(traced.tree, blockMetadata);
  const includedBlockHeight = blockMetadata.includedBlockInfo?.blockHeight ?? null;
  const window = buildCascadeWindow(includedBlockHeight, receipts, extendAfter);
  const interestingBlocks = window.interestingBlocks;

  const stateSnapshots = [];
  for (const view of viewSpecs) {
    const samples = [];
    for (const blockHeight of interestingBlocks) {
      const result = await callViewMethod(network, view.account, view.method, view.args, {
        blockId: blockHeight,
      });
      samples.push({
        block_height: result.block_height,
        block_hash: result.block_hash,
        logs: result.logs,
        value: result.value,
      });
    }
    stateSnapshots.push({ view, samples });
  }

  const accountActivity = [];
  for (const accountId of accounts) {
    const rows = await fetchAccountHistoryWindow(network, accountId, window);
    accountActivity.push({
      account_id: accountId,
      ...partitionAccountActivityRows(rows, traced.tree.txHash),
    });
  }

  const blocks = [];
  const byBlock = new Map();
  for (const receipt of receipts) {
    if (receipt.blockHeight == null) continue;
    const key = Number(receipt.blockHeight);
    if (!byBlock.has(key)) byBlock.set(key, []);
    byBlock.get(key).push(receipt);
  }
  for (const blockHeight of [...byBlock.keys()].sort((a, b) => a - b)) {
    const rows = byBlock.get(blockHeight).slice().sort((a, b) => {
      if ((a.receiptIndex ?? Number.POSITIVE_INFINITY) < (b.receiptIndex ?? Number.POSITIVE_INFINITY)) {
        return -1;
      }
      if ((a.receiptIndex ?? Number.POSITIVE_INFINITY) > (b.receiptIndex ?? Number.POSITIVE_INFINITY)) {
        return 1;
      }
      return a.ordinal - b.ordinal;
    });
    blocks.push({ block_height: blockHeight, receipts: rows });
  }

  const logs = receipts
    .flatMap((receipt) =>
      (receipt.logs || []).map((log) => ({
        block_height: receipt.blockHeight,
        receipt_id: receipt.id,
        receipt_index: receipt.receiptIndex,
        account: receipt.executor,
        log,
      }))
    )
    .sort((a, b) => {
      if ((a.block_height ?? Number.POSITIVE_INFINITY) < (b.block_height ?? Number.POSITIVE_INFINITY)) {
        return -1;
      }
      if ((a.block_height ?? Number.POSITIVE_INFINITY) > (b.block_height ?? Number.POSITIVE_INFINITY)) {
        return 1;
      }
      return (a.receipt_index ?? Number.POSITIVE_INFINITY) - (b.receipt_index ?? Number.POSITIVE_INFINITY);
    });

  const structuredEvents = parseStructuredEvents(receipts, {
    transactionHash: traced.tree.txHash,
  });
  const runSummaries = summarizeRuns(structuredEvents);
  const stepLifecycle = classifyStepLifecycle(
    {
      classification: traced.classification,
      raw_final_status: traced.tree.finalStatus,
    },
    receipts,
    structuredEvents
  );

  return {
    schema_version: 1,
    tx: {
      hash: traced.tree.txHash,
      signer: traced.tree.signer,
      receiver: traced.tree.receiver,
      included_block_hash: traced.tree.includedBlockHash,
      included_block_height: includedBlockHeight,
      finality: traced.tree.finality,
      gas_burnt: traced.tree.gasBurntTx,
      tokens_burnt: traced.tree.tokensBurntTx,
    },
    trace: {
      classification: traced.classification,
      rendered_status: traced.classification,
      text: renderText(traced.tree),
      raw_final_status: traced.tree.finalStatus,
    },
    window,
    receipts,
    blocks,
    state_snapshots: stateSnapshots,
    account_activity: accountActivity,
    step_lifecycle: stepLifecycle,
    structured_events: structuredEvents,
    run_summaries: runSummaries,
    logs,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      network: { type: "string", default: "testnet" },
      view: { type: "string", multiple: true },
      accounts: { type: "string" },
      "extend-after": { type: "string", default: "0" },
      wait: { type: "string", default: "EXECUTED_OPTIMISTIC" },
      format: { type: "string", default: "markdown" },
      out: { type: "string" },
    },
    allowPositionals: true,
  });

  const [txHash, signer] = positionals;
  if (!txHash || !signer) {
    console.error(
      "usage: scripts/investigate-tx.mjs <tx_hash> <signer> [--view '<json>'] [--accounts a,b] [--extend-after N] [--wait EXECUTED_OPTIMISTIC|FINAL] [--format markdown|json|both] [--out path]"
    );
    process.exit(1);
  }

  if (!["markdown", "json", "both"].includes(values.format)) {
    throw new Error(`unsupported --format '${values.format}'`);
  }

  const report = await buildInvestigateReport(values.network, txHash, signer, {
    wait: values.wait,
    extendAfter: Number(values["extend-after"]),
    viewSpecs: values.view || [],
    accounts: values.accounts
      ? values.accounts
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
      : [],
  });

  const emitted = writeReportOutputs(report, values.format, values.out);
  process.stdout.write(`${emitted.stdout}\n`);
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}

if (isMainModule()) {
  await main();
}
