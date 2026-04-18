// Structured NEP-297 event parsing for smart-account automation.
//
// The smart-account contract emits `EVENT_JSON:{...}` lines alongside its
// existing prose logs. Each event follows the NEP-297 shape:
//   { "standard": "sa-automation", "version": "1.0.0", "event": "<name>",
//     "data": { ... } }
//
// This helper filters a flattened receipt array (as produced by
// `scripts/lib/trace-rpc.mjs`) for those structured events and annotates
// each with its originating receipt metadata so consumers can reason about
// ordering, block height, and the tx they belong to.
//
// See `TELEMETRY-DESIGN.md` §2–§5 for the schema and `§3` for the full
// event catalog.

export const EVENT_JSON_PREFIX = "EVENT_JSON:";
export const SA_AUTOMATION_STANDARD = "sa-automation";

/**
 * Parse structured events out of an array of materialized/flattened receipts.
 *
 * @param {Array<object>} receipts - Receipts as produced by
 *   `flattenReceiptTree(tree)` or `materializeFlattenedReceipts(tree, ...)`.
 *   Each receipt should carry at minimum `id` and `logs`; block/receipt
 *   ordering fields (blockHeight, receiptIndex, ordinal) are carried through
 *   when present.
 * @param {object} [opts]
 * @param {string} [opts.standard] - Filter to only events matching this
 *   `standard` field. Defaults to `"sa-automation"`. Pass `null` to accept
 *   any standard.
 * @param {string} [opts.transactionHash] - Optional tx hash to attach to
 *   every parsed event. Useful when a caller already knows the tx and wants
 *   events tagged with it without reading every receipt.
 * @returns {Array<object>} Parsed events in receipt order. Each event has:
 *   { standard, version, event, data, receipt: { id, blockHeight,
 *     blockTimestamp, blockHash, receiptIndex, ordinal, executor,
 *     predecessor, transactionHash }, raw }.
 *   Malformed `EVENT_JSON:` lines are skipped silently.
 */
export function parseStructuredEvents(receipts, opts = {}) {
  const standard = opts.standard === undefined ? SA_AUTOMATION_STANDARD : opts.standard;
  const txHashOverride = opts.transactionHash ?? null;

  const events = [];
  for (const receipt of receipts || []) {
    const logs = receipt?.logs || [];
    for (let i = 0; i < logs.length; i++) {
      const line = logs[i];
      if (typeof line !== "string" || !line.startsWith(EVENT_JSON_PREFIX)) continue;

      const body = line.slice(EVENT_JSON_PREFIX.length);
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        continue; // malformed event line; ignore rather than throw
      }
      if (!parsed || typeof parsed !== "object") continue;
      if (standard != null && parsed.standard !== standard) continue;
      if (typeof parsed.event !== "string") continue;

      events.push({
        standard: parsed.standard,
        version: parsed.version,
        event: parsed.event,
        data: parsed.data ?? null,
        receipt: {
          id: receipt.id ?? null,
          blockHeight: receipt.blockHeight ?? null,
          blockTimestamp: receipt.blockTimestamp ?? null,
          blockHash: receipt.blockHash ?? null,
          receiptIndex: receipt.receiptIndex ?? null,
          ordinal: receipt.ordinal ?? null,
          logIndex: i,
          executor: receipt.executor ?? null,
          predecessor: receipt.predecessor ?? null,
          transactionHash: txHashOverride ?? receipt.transactionHash ?? null,
        },
        raw: line,
      });
    }
  }
  return events;
}

/**
 * Group events by their `data.namespace` (sequence namespace). Events without
 * a namespace field are bucketed under the empty string key. Within each
 * bucket, events preserve their input order.
 */
export function groupEventsByNamespace(events) {
  const buckets = new Map();
  for (const event of events) {
    const key = typeof event?.data?.namespace === "string" ? event.data.namespace : "";
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(event);
  }
  return buckets;
}

/**
 * Collapse `trigger_fired` + `sequence_started` + ... + `run_finished` events
 * for one automation run into a single summary row. Manual (non-automation)
 * sequences that never emit `trigger_fired`/`run_finished` are still
 * summarized based on `sequence_started`/`sequence_completed`/`sequence_halted`.
 *
 * Returns an array of run summaries, one per distinct namespace. Fields pulled
 * from v1.1.0 events include: executor_id, runs_started, max_runs,
 * balance/required-balance, duration_ms, settle latency, assertion outcomes.
 */
export function summarizeRuns(events) {
  const byNamespace = groupEventsByNamespace(events);
  const summaries = [];

  for (const [namespace, bucket] of byNamespace.entries()) {
    if (!namespace) continue; // skip events with no namespace (e.g. trigger_created)

    const summary = {
      namespace,
      origin: null,
      triggerId: null,
      runNonce: null,
      sequenceId: null,
      executorId: null,
      signerId: null,
      firstSeenBlockHeight: null,
      lastSeenBlockHeight: null,
      firstSeenBlockTimestampMs: null,
      lastSeenBlockTimestampMs: null,
      startedAtMs: null,
      finishedAtMs: null,
      durationMs: null,
      status: "unknown",
      failedStepId: null,
      errorKind: null,
      errorMsg: null,
      stepCount: 0,
      stepsSettledOk: 0,
      runsStarted: null,
      maxRuns: null,
      runsRemaining: null,
      balanceYocto: null,
      requiredBalanceYocto: null,
      minBalanceYocto: null,
      templateTotalDepositYocto: null,
      resumeLatencyMsSamples: [],
      settleLatencyMsSamples: [],
      gasBurntTgasSamples: [],
      storageUsageSamples: [],
      resumeLatencyMsAvg: null,
      resumeLatencyMsMax: null,
      settleLatencyMsAvg: null,
      settleLatencyMsMax: null,
      maxUsedGasTgas: null,
      latestStorageUsage: null,
      assertions: [],
      events: bucket,
    };

    for (const event of bucket) {
      const height = event.receipt?.blockHeight ?? null;
      if (height != null) {
        if (summary.firstSeenBlockHeight == null || height < summary.firstSeenBlockHeight) {
          summary.firstSeenBlockHeight = height;
        }
        if (summary.lastSeenBlockHeight == null || height > summary.lastSeenBlockHeight) {
          summary.lastSeenBlockHeight = height;
        }
      }
      const ts = event.receipt?.blockTimestamp ?? null;
      if (ts != null) {
        if (
          summary.firstSeenBlockTimestampMs == null ||
          ts < summary.firstSeenBlockTimestampMs
        ) {
          summary.firstSeenBlockTimestampMs = ts;
        }
        if (
          summary.lastSeenBlockTimestampMs == null ||
          ts > summary.lastSeenBlockTimestampMs
        ) {
          summary.lastSeenBlockTimestampMs = ts;
        }
      }

      const data = event.data || {};
      const runtime = data.runtime || {};
      if (runtime.signer_id) summary.signerId = runtime.signer_id;
      if (typeof runtime.used_gas_tgas === "number") {
        summary.gasBurntTgasSamples.push(runtime.used_gas_tgas);
      }
      if (typeof runtime.storage_usage === "number") {
        summary.storageUsageSamples.push(runtime.storage_usage);
      }

      if (event.event === "trigger_fired") {
        summary.origin = "automation";
        summary.triggerId = data.trigger_id ?? summary.triggerId;
        summary.runNonce = data.run_nonce ?? summary.runNonce;
        summary.sequenceId = data.sequence_id ?? summary.sequenceId;
        summary.executorId = data.executor_id ?? summary.executorId;
        summary.startedAtMs = data.started_at_ms ?? summary.startedAtMs;
        summary.runsStarted = data.runs_started ?? summary.runsStarted;
        summary.maxRuns = data.max_runs ?? summary.maxRuns;
        summary.runsRemaining = data.runs_remaining ?? summary.runsRemaining;
        summary.balanceYocto = data.balance_yocto ?? summary.balanceYocto;
        summary.requiredBalanceYocto =
          data.required_balance_yocto ?? summary.requiredBalanceYocto;
        summary.minBalanceYocto = data.min_balance_yocto ?? summary.minBalanceYocto;
        summary.templateTotalDepositYocto =
          data.template_total_deposit_yocto ?? summary.templateTotalDepositYocto;
      } else if (event.event === "sequence_started") {
        summary.origin = summary.origin ?? data.origin ?? null;
        summary.stepCount = Math.max(summary.stepCount, data.total_steps ?? 0);
        if (data.automation_run) {
          summary.triggerId = data.automation_run.trigger_id ?? summary.triggerId;
          summary.sequenceId = data.automation_run.sequence_id ?? summary.sequenceId;
          summary.runNonce = data.automation_run.run_nonce ?? summary.runNonce;
          summary.executorId = data.automation_run.executor_id ?? summary.executorId;
          summary.startedAtMs = data.automation_run.started_at_ms ?? summary.startedAtMs;
        }
      } else if (event.event === "step_resumed") {
        if (typeof data.resume_latency_ms === "number") {
          summary.resumeLatencyMsSamples.push(data.resume_latency_ms);
        }
      } else if (event.event === "step_settled_ok") {
        summary.stepsSettledOk += 1;
        summary.stepCount = Math.max(summary.stepCount, summary.stepsSettledOk);
        if (typeof data.settle_latency_ms === "number") {
          summary.settleLatencyMsSamples.push(data.settle_latency_ms);
        }
      } else if (event.event === "step_settled_err") {
        summary.errorKind = data.error_kind ?? summary.errorKind;
        summary.errorMsg = data.error_msg ?? summary.errorMsg;
        if (typeof data.settle_latency_ms === "number") {
          summary.settleLatencyMsSamples.push(data.settle_latency_ms);
        }
      } else if (event.event === "sequence_completed") {
        summary.status = "succeeded";
      } else if (event.event === "sequence_halted") {
        summary.status = "halted";
        summary.failedStepId = data.failed_step_id ?? summary.failedStepId;
        summary.errorKind = data.error_kind ?? data.reason ?? summary.errorKind;
        summary.errorMsg = data.error_msg ?? summary.errorMsg;
      } else if (event.event === "run_finished") {
        summary.status = (data.status || "").toLowerCase() || summary.status;
        summary.finishedAtMs = data.finished_at_ms ?? summary.finishedAtMs;
        summary.failedStepId = data.failed_step_id ?? summary.failedStepId;
        summary.triggerId = data.trigger_id ?? summary.triggerId;
        summary.runNonce = data.run_nonce ?? summary.runNonce;
        summary.durationMs = data.duration_ms ?? summary.durationMs;
      } else if (event.event === "assertion_checked") {
        summary.assertions.push({
          stepId: data.step_id ?? null,
          match: data.match ?? null,
          outcome: data.outcome ?? null,
          expectedBytesLen: data.expected_bytes_len ?? null,
          actualBytesLen: data.actual_bytes_len ?? null,
        });
      }
    }

    if (summary.durationMs == null && summary.startedAtMs != null && summary.finishedAtMs != null) {
      summary.durationMs = summary.finishedAtMs - summary.startedAtMs;
    }

    summary.resumeLatencyMsAvg = average(summary.resumeLatencyMsSamples);
    summary.resumeLatencyMsMax = maximum(summary.resumeLatencyMsSamples);
    summary.settleLatencyMsAvg = average(summary.settleLatencyMsSamples);
    summary.settleLatencyMsMax = maximum(summary.settleLatencyMsSamples);
    summary.maxUsedGasTgas = maximum(summary.gasBurntTgasSamples);
    summary.latestStorageUsage =
      summary.storageUsageSamples.length > 0
        ? summary.storageUsageSamples[summary.storageUsageSamples.length - 1]
        : null;
    summary.assertionSuccessCount = summary.assertions.filter((item) => item.match === true).length;
    summary.assertionFailureCount = summary.assertions.filter((item) => item.match === false).length;

    summaries.push(summary);
  }

  return summaries;
}

function average(values) {
  if (!values?.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function maximum(values) {
  if (!values?.length) return null;
  return Math.max(...values);
}
