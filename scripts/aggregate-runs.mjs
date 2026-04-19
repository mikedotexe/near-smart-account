#!/usr/bin/env node

// Walk a smart-account's FastNEAR account history, trace each tx, parse
// structured NEP-297 `sa-automation` events from every receipt, and produce
// a run-centric report. The human-facing shape is markdown-first: concise run
// summary up top, then detailed event rows underneath. JSON remains available
// for machine consumption and artifact capture.

import { parseArgs } from "node:util";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { fetchAccountHistory, shortHash, truncate } from "./lib/fastnear.mjs";
import {
  traceTx,
  flattenReceiptTree,
  materializeFlattenedReceipts,
  fetchTraceBlockMetadata,
} from "./lib/trace-rpc.mjs";
import { parseStructuredEvents, summarizeRuns } from "./lib/events.mjs";

function countBy(items, keyFn) {
  const counts = new Map();
  for (const item of items || []) {
    const key = keyFn(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || String(a.key).localeCompare(String(b.key)));
}

function formatMetric(value, digits = 1) {
  if (value == null) return "`-`";
  if (typeof value === "number" && Number.isFinite(value)) {
    if (Number.isInteger(value)) return `\`${value}\``;
    return `\`${value.toFixed(digits)}\``;
  }
  return `\`${value}\``;
}

function formatInlineValue(value) {
  const rendered =
    typeof value === "string" ? value : JSON.stringify(value == null ? null : value);
  const text = truncate(rendered, 160).replace(/\|/g, "\\|").replace(/\n/g, " ");
  return `\`${text}\``;
}

function blockSpan(run) {
  if (run.firstSeenBlockHeight == null || run.lastSeenBlockHeight == null) return "?";
  return `${run.firstSeenBlockHeight}..${run.lastSeenBlockHeight}`;
}

function describeEvent(event) {
  const data = event.data || {};
  switch (event.event) {
    case "step_registered":
      return `${data.step_id ?? "?"} -> ${data.target_id ?? data.call?.target_id ?? "?"}.${data.method ?? data.call?.method_name ?? "?"} policy=${data.policy ?? data.call?.policy ?? "?"}`;
    case "sequence_started":
      return `first=${data.first_step_id ?? "?"} total=${data.total_steps ?? "?"}`;
    case "step_resumed":
      return `${data.step_id ?? "?"} resume_latency_ms=${data.resume_latency_ms ?? "-"} target=${data.call?.target_id ?? "?"}.${data.call?.method_name ?? "?"}`;
    case "step_resolved_ok":
      return `${data.step_id ?? "?"} resolve_latency_ms=${data.resolve_latency_ms ?? "-"} next=${data.next_step_id ?? "none"} result_bytes=${data.result_bytes_len ?? "-"}`;
    case "step_resolved_err":
      return `${data.step_id ?? "?"} error=${data.error_kind ?? "unknown"} resolve_latency_ms=${data.resolve_latency_ms ?? "-"} oversized=${data.oversized_bytes ?? "-"}`;
    case "sequence_completed":
      return `final=${data.final_step_id ?? "?"} result_bytes=${data.final_result_bytes_len ?? "-"}`;
    case "sequence_halted":
      return `failed=${data.failed_step_id ?? "?"} error=${data.error_kind ?? data.reason ?? "unknown"}`;
    case "assertion_checked":
      return `${data.step_id ?? "?"} match=${data.match ?? "?"} expected=${data.expected_bytes_len ?? "-"} actual=${data.actual_bytes_len ?? "-"}`;
    case "trigger_created":
      return `trigger=${data.trigger_id ?? "?"} sequence=${data.sequence_id ?? "?"} max_runs=${data.max_runs ?? "-"}`;
    case "trigger_fired":
      return `trigger=${data.trigger_id ?? "?"} run=${data.run_nonce ?? "?"} calls=${data.call_count ?? "-"} balance=${data.balance_yocto ?? "-"}`;
    case "run_finished":
      return `status=${data.status ?? "?"} duration_ms=${data.duration_ms ?? "-"} failed=${data.failed_step_id ?? "none"}`;
    default:
      return truncate(JSON.stringify(data), 160);
  }
}

export function buildAggregateReport({
  network,
  accountId,
  history,
  txSummaries,
  events,
  runs,
}) {
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    network,
    account_id: accountId,
    tx_count: txSummaries.length,
    txs_total_reported: history?.txs_count ?? null,
    event_count: events.length,
    run_count: runs.length,
    run_status_counts: countBy(runs, (run) => run.status || "unknown"),
    event_counts: countBy(events, (event) => event.event || "unknown"),
    tx_classification_counts: countBy(txSummaries, (tx) => tx.classification || "unknown"),
    txs: txSummaries,
    events,
    runs,
  };
}

export function renderMarkdownReport(report) {
  const lines = [];
  lines.push(`# Aggregate runs: ${report.account_id}`);
  lines.push("");
  lines.push(`**Network:** \`${report.network}\``);
  lines.push(`**Generated:** \`${report.generated_at}\``);
  lines.push(`**Tx scanned:** \`${report.tx_count}\``);
  lines.push(`**Events parsed:** \`${report.event_count}\``);
  lines.push(`**Runs summarized:** \`${report.run_count}\``);
  if (report.txs_total_reported != null) {
    lines.push(`**Account tx total reported by API:** \`${report.txs_total_reported}\``);
  }
  lines.push("");

  lines.push("## Overview");
  lines.push("");
  if (report.run_status_counts.length) {
    lines.push("### Run status counts");
    lines.push("");
    lines.push("| Status | Count |");
    lines.push("|---|---|");
    for (const row of report.run_status_counts) {
      lines.push(`| \`${row.key}\` | \`${row.count}\` |`);
    }
    lines.push("");
  }
  if (report.event_counts.length) {
    lines.push("### Event counts");
    lines.push("");
    lines.push("| Event | Count |");
    lines.push("|---|---|");
    for (const row of report.event_counts) {
      lines.push(`| \`${row.key}\` | \`${row.count}\` |`);
    }
    lines.push("");
  }

  lines.push("## Run summary");
  lines.push("");
  if (!report.runs.length) {
    lines.push("_No structured runs found in the scanned window._");
    lines.push("");
  } else {
    lines.push(
      "| Namespace | Origin | Status | Trigger | Steps ok/total | Duration ms | Resume ms avg/max | Resolve ms avg/max | Max gas (TGas) | Error |"
    );
    lines.push("|---|---|---|---|---|---|---|---|---|---|");
    for (const run of report.runs) {
      lines.push(
        `| \`${run.namespace}\` | \`${run.origin ?? "-"}\` | \`${run.status}\` | \`${run.triggerId ?? "-"}\` | \`${run.stepsResolvedOk}/${run.stepCount}\` | ${formatMetric(run.durationMs, 0)} | ${formatMetric(run.resumeLatencyMsAvg)}/${formatMetric(run.resumeLatencyMsMax, 0)} | ${formatMetric(run.resolveLatencyMsAvg)}/${formatMetric(run.resolveLatencyMsMax, 0)} | ${formatMetric(run.maxUsedGasTgas)} | \`${run.errorKind ?? "-"}\` |`
      );
    }
    lines.push("");
  }

  lines.push("## Transactions scanned");
  lines.push("");
  lines.push("| Tx | Signer | Classification | Events | Error |");
  lines.push("|---|---|---|---|---|");
  for (const tx of report.txs) {
    lines.push(
      `| \`${shortHash(tx.txHash || "?")}\` | \`${tx.signer ?? "-"}\` | \`${tx.classification}\` | \`${tx.eventCount}\` | ${formatInlineValue(tx.error ?? null)} |`
    );
  }
  lines.push("");

  lines.push("## Run details");
  lines.push("");
  if (!report.runs.length) {
    lines.push("_No run details to show._");
    lines.push("");
  } else {
    for (const run of report.runs) {
      lines.push(`### \`${run.namespace}\``);
      lines.push("");
      lines.push(`- status: \`${run.status}\``);
      lines.push(`- origin: \`${run.origin ?? "-"}\``);
      lines.push(`- blocks: \`${blockSpan(run)}\``);
      lines.push(`- trigger / sequence / run nonce: \`${run.triggerId ?? "-"}\` / \`${run.sequenceId ?? "-"}\` / \`${run.runNonce ?? "-"}\``);
      lines.push(`- executor / signer: \`${run.executorId ?? "-"}\` / \`${run.signerId ?? "-"}\``);
      lines.push(`- steps resolved ok / total: \`${run.stepsResolvedOk}/${run.stepCount}\``);
      lines.push(`- duration ms: ${formatMetric(run.durationMs, 0)}`);
      lines.push(`- resume latency ms avg/max: ${formatMetric(run.resumeLatencyMsAvg)} / ${formatMetric(run.resumeLatencyMsMax, 0)}`);
      lines.push(`- resolve latency ms avg/max: ${formatMetric(run.resolveLatencyMsAvg)} / ${formatMetric(run.resolveLatencyMsMax, 0)}`);
      lines.push(`- max observed used gas (TGas): ${formatMetric(run.maxUsedGasTgas)}`);
      lines.push(`- latest storage usage: ${formatMetric(run.latestStorageUsage, 0)}`);
      lines.push(`- assertions ok/fail: \`${run.assertionSuccessCount ?? 0}/${run.assertionFailureCount ?? 0}\``);
      if (run.balanceYocto != null || run.requiredBalanceYocto != null) {
        lines.push(
          `- balance / required balance yocto: \`${run.balanceYocto ?? "-"}\` / \`${run.requiredBalanceYocto ?? "-"}\``
        );
      }
      if (run.errorKind || run.errorMsg) {
        lines.push(`- error: \`${run.errorKind ?? "unknown"}\` ${run.errorMsg ? `(${truncate(run.errorMsg, 160)})` : ""}`);
      }
      lines.push("");
      lines.push("| Block | Event | Step | Details |");
      lines.push("|---|---|---|---|");
      for (const event of run.events || []) {
        lines.push(
          `| ${event.receipt.blockHeight ?? "?"} | \`${event.event}\` | \`${event.data?.step_id ?? "-"}\` | ${describeEvent(event).replace(/\|/g, "\\|")} |`
        );
      }
      lines.push("");
    }
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

export function writeAggregateOutputs(report, format, outPath) {
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

export async function buildAggregateFromHistory(accountId, values) {
  const network = values.network;
  const history = await fetchAccountHistory(network, accountId, {
    limit: values.limit,
    desc: true,
    fromBlock: values["from-block"],
    toBlock: values["to-block"],
    isReceiver: values.receiver,
    isFunctionCall: values["function-call"],
  });

  const rows = history?.account_txs || [];
  console.error(
    `network=${network} account=${accountId} txs=${rows.length} (total=${history.txs_count ?? "?"})`
  );

  const allEvents = [];
  const txSummaries = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const txHash = row.tx_hash;
    const signer = row.signer_id;
    if (!txHash || !signer) {
      txSummaries.push({ txHash, signer, classification: "SKIPPED", eventCount: 0 });
      continue;
    }
    process.stderr.write(`[${i + 1}/${rows.length}] ${txHash} signer=${signer}... `);
    try {
      const trace = await traceTx(network, txHash, signer, "FINAL");
      if (!trace.tree) {
        process.stderr.write(`skip (${trace.classification})\n`);
        txSummaries.push({
          txHash,
          signer,
          classification: trace.classification,
          eventCount: 0,
        });
        continue;
      }

      let receipts;
      if (values["with-blocks"]) {
        const blockMeta = await fetchTraceBlockMetadata(network, trace.tree);
        receipts = materializeFlattenedReceipts(trace.tree, blockMeta);
      } else {
        receipts = flattenReceiptTree(trace.tree);
      }

      const events = parseStructuredEvents(receipts, { transactionHash: txHash });
      allEvents.push(...events);
      txSummaries.push({
        txHash,
        signer,
        classification: trace.classification,
        eventCount: events.length,
      });
      process.stderr.write(`${events.length} events (${trace.classification})\n`);
    } catch (err) {
      process.stderr.write(`error: ${err.message}\n`);
      txSummaries.push({
        txHash,
        signer,
        classification: "ERROR",
        eventCount: 0,
        error: String(err.message || err),
      });
    }
  }

  const runs = summarizeRuns(allEvents);
  return buildAggregateReport({
    network,
    accountId,
    history,
    txSummaries,
    events: allEvents,
    runs,
  });
}

export async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      network: { type: "string", default: "testnet" },
      limit: { type: "string", default: "50" },
      "from-block": { type: "string" },
      "to-block": { type: "string" },
      "with-blocks": { type: "boolean", default: false },
      receiver: { type: "boolean", default: false },
      "function-call": { type: "boolean", default: false },
      format: { type: "string", default: "markdown" },
      out: { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const [accountId] = positionals;
  if (!accountId) {
    console.error(
      "usage: scripts/aggregate-runs.mjs <account_id> [--network testnet] [--limit 50]\n" +
        "                          [--from-block H] [--to-block H]\n" +
        "                          [--with-blocks] [--receiver] [--function-call]\n" +
        "                          [--format markdown|json|both] [--out path]\n" +
        "                          [--json]"
    );
    process.exit(1);
  }

  const format = values.json && !argv.includes("--format") ? "json" : values.format;
  if (!["markdown", "json", "both"].includes(format)) {
    throw new Error(`unsupported --format '${format}'`);
  }

  const report = await buildAggregateFromHistory(accountId, values);
  const emitted = writeAggregateOutputs(report, format, values.out ? path.resolve(values.out) : null);
  process.stdout.write(`${emitted.stdout}\n`);
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}

if (isMainModule()) {
  await main();
}
