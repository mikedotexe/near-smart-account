import test from "node:test";
import assert from "node:assert/strict";

import {
  EVENT_JSON_PREFIX,
  SA_AUTOMATION_STANDARD,
  parseStructuredEvents,
  groupEventsByNamespace,
  summarizeRuns,
} from "./events.mjs";

function eventLine(event, data) {
  return `${EVENT_JSON_PREFIX}${JSON.stringify({
    standard: SA_AUTOMATION_STANDARD,
    version: "1.0.0",
    event,
    data,
  })}`;
}

function receipt({ id, logs = [], blockHeight = 100, receiptIndex = 0, ordinal = 0 }) {
  return {
    id,
    logs,
    blockHeight,
    blockTimestamp: blockHeight * 1_000_000_000,
    blockHash: `hash-${blockHeight}`,
    receiptIndex,
    ordinal,
    executor: "smart-account.testnet",
    predecessor: "owner.testnet",
    transactionHash: "tx-abc",
  };
}

test("parseStructuredEvents extracts EVENT_JSON lines and tags with receipt metadata", () => {
  const receipts = [
    receipt({
      id: "r1",
      logs: [
        "register_step 'alpha' in manual:owner.testnet registered", // prose, ignored
        eventLine("step_registered", { step_id: "alpha", namespace: "manual:owner.testnet" }),
      ],
    }),
  ];

  const events = parseStructuredEvents(receipts);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "step_registered");
  assert.equal(events[0].standard, SA_AUTOMATION_STANDARD);
  assert.equal(events[0].data.step_id, "alpha");
  assert.equal(events[0].receipt.id, "r1");
  assert.equal(events[0].receipt.blockHeight, 100);
  assert.equal(events[0].receipt.logIndex, 1);
  assert.equal(events[0].receipt.transactionHash, "tx-abc");
});

test("parseStructuredEvents skips malformed EVENT_JSON lines", () => {
  const receipts = [
    receipt({
      id: "r1",
      logs: [
        `${EVENT_JSON_PREFIX}not-json-here`,
        `${EVENT_JSON_PREFIX}{"standard":"sa-automation","event":"ok","version":"1.0.0","data":{}}`,
      ],
    }),
  ];
  const events = parseStructuredEvents(receipts);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "ok");
});

test("parseStructuredEvents honors a custom standard filter", () => {
  const receipts = [
    receipt({
      id: "r1",
      logs: [
        `${EVENT_JSON_PREFIX}${JSON.stringify({ standard: "nep141", version: "1.0.0", event: "ft_transfer", data: {} })}`,
        eventLine("trigger_created", { trigger_id: "t1" }),
      ],
    }),
  ];
  const saOnly = parseStructuredEvents(receipts);
  assert.equal(saOnly.length, 1);
  assert.equal(saOnly[0].event, "trigger_created");

  const anyStandard = parseStructuredEvents(receipts, { standard: null });
  assert.equal(anyStandard.length, 2);
});

test("groupEventsByNamespace buckets events by data.namespace", () => {
  const receipts = [
    receipt({
      id: "r1",
      logs: [
        eventLine("trigger_created", { trigger_id: "t1" }), // no namespace
        eventLine("trigger_fired", { trigger_id: "t1", namespace: "auto:t1:1" }),
        eventLine("step_resumed", { step_id: "a", namespace: "auto:t1:1" }),
        eventLine("step_resumed", { step_id: "b", namespace: "auto:t1:2" }),
      ],
    }),
  ];
  const events = parseStructuredEvents(receipts);
  const buckets = groupEventsByNamespace(events);
  assert.equal(buckets.get("").length, 1);
  assert.equal(buckets.get("auto:t1:1").length, 2);
  assert.equal(buckets.get("auto:t1:2").length, 1);
});

test("summarizeRuns collapses a full automation run into one summary", () => {
  const receipts = [
    receipt({
      id: "r1",
      blockHeight: 100,
      logs: [
        eventLine("trigger_fired", {
          trigger_id: "t1",
          namespace: "auto:t1:1",
          sequence_id: "seq-a",
          run_nonce: 1,
          executor_id: "owner.testnet",
          started_at_ms: 1_700_000_000_000,
          runtime: { used_gas_tgas: 12, storage_usage: 111 },
        }),
        eventLine("sequence_started", {
          namespace: "auto:t1:1",
          first_step_id: "alpha",
          total_steps: 2,
        }),
      ],
    }),
    receipt({
      id: "r2",
      blockHeight: 110,
      logs: [
        eventLine("step_resumed", {
          step_id: "alpha",
          namespace: "auto:t1:1",
          resume_latency_ms: 50,
          runtime: { used_gas_tgas: 18, storage_usage: 112 },
        }),
        eventLine("step_resolved_ok", {
          step_id: "alpha",
          namespace: "auto:t1:1",
          next_step_id: "beta",
          resolve_latency_ms: 75,
          runtime: { used_gas_tgas: 24, storage_usage: 113 },
        }),
      ],
    }),
    receipt({
      id: "r3",
      blockHeight: 120,
      logs: [
        eventLine("step_resolved_ok", {
          step_id: "beta",
          namespace: "auto:t1:1",
          next_step_id: null,
          resolve_latency_ms: 125,
          runtime: { used_gas_tgas: 30, storage_usage: 114 },
        }),
        eventLine("sequence_completed", { namespace: "auto:t1:1", final_step_id: "beta" }),
        eventLine("run_finished", {
          trigger_id: "t1",
          namespace: "auto:t1:1",
          run_nonce: 1,
          status: "Succeeded",
          finished_at_ms: 1_700_000_001_000,
        }),
      ],
    }),
  ];
  const events = parseStructuredEvents(receipts);
  const summaries = summarizeRuns(events);
  assert.equal(summaries.length, 1);
  const [run] = summaries;
  assert.equal(run.namespace, "auto:t1:1");
  assert.equal(run.triggerId, "t1");
  assert.equal(run.runNonce, 1);
  assert.equal(run.sequenceId, "seq-a");
  assert.equal(run.status, "succeeded");
  assert.equal(run.firstSeenBlockHeight, 100);
  assert.equal(run.lastSeenBlockHeight, 120);
  assert.equal(run.stepCount, 2);
  assert.equal(run.resumeLatencyMsAvg, 50);
  assert.equal(run.resumeLatencyMsMax, 50);
  assert.equal(run.resolveLatencyMsAvg, 100);
  assert.equal(run.resolveLatencyMsMax, 125);
  assert.equal(run.maxUsedGasTgas, 30);
  assert.equal(run.latestStorageUsage, 114);
});

test("summarizeRuns harvests v1.1.0 enrichment (runtime, duration, runsStarted, assertions)", () => {
  const runtime = {
    block_height: 1000,
    block_timestamp_ms: 1_700_000_000_000,
    used_gas_tgas: 50,
    storage_usage: 12345,
    signer_id: "executor.testnet",
    predecessor_id: "executor.testnet",
    current_account_id: "sa.testnet",
  };
  const receipts = [
    receipt({
      id: "r1",
      blockHeight: 1000,
      logs: [
        `${EVENT_JSON_PREFIX}${JSON.stringify({
          standard: SA_AUTOMATION_STANDARD,
          version: "1.1.0",
          event: "trigger_fired",
          data: {
            trigger_id: "t1",
            namespace: "auto:t1:1",
            sequence_id: "seq-a",
            run_nonce: 1,
            executor_id: "executor.testnet",
            started_at_ms: 1_700_000_000_000,
            runs_started: 1,
            max_runs: 3,
            runs_remaining: 2,
            balance_yocto: "5000000000000000000000000",
            required_balance_yocto: "1000000000000000000000000",
            runtime,
          },
        })}`,
        `${EVENT_JSON_PREFIX}${JSON.stringify({
          standard: SA_AUTOMATION_STANDARD,
          version: "1.1.0",
          event: "assertion_checked",
          data: {
            step_id: "alpha",
            namespace: "auto:t1:1",
            expected_bytes_len: 4,
            actual_bytes_len: 4,
            match: true,
            outcome: "matched",
            runtime,
          },
        })}`,
        `${EVENT_JSON_PREFIX}${JSON.stringify({
          standard: SA_AUTOMATION_STANDARD,
          version: "1.1.0",
          event: "run_finished",
          data: {
            trigger_id: "t1",
            namespace: "auto:t1:1",
            run_nonce: 1,
            status: "Succeeded",
            started_at_ms: 1_700_000_000_000,
            finished_at_ms: 1_700_000_002_500,
            duration_ms: 2500,
            runtime,
          },
        })}`,
      ],
    }),
  ];

  const [summary] = summarizeRuns(parseStructuredEvents(receipts));
  assert.equal(summary.runsStarted, 1);
  assert.equal(summary.maxRuns, 3);
  assert.equal(summary.runsRemaining, 2);
  assert.equal(summary.balanceYocto, "5000000000000000000000000");
  assert.equal(summary.requiredBalanceYocto, "1000000000000000000000000");
  assert.equal(summary.durationMs, 2500);
  assert.equal(summary.status, "succeeded");
  assert.equal(summary.signerId, "executor.testnet");
  assert.equal(summary.assertions.length, 1);
  assert.equal(summary.assertions[0].match, true);
  assert.deepEqual(summary.gasBurntTgasSamples, [50, 50, 50]);
  assert.deepEqual(summary.storageUsageSamples, [12345, 12345, 12345]);
});

test("summarizeRuns marks a halted run", () => {
  const receipts = [
    receipt({
      id: "r1",
      logs: [
        eventLine("trigger_fired", { trigger_id: "t1", namespace: "auto:t1:1", run_nonce: 1 }),
        eventLine("sequence_started", { namespace: "auto:t1:1", first_step_id: "alpha", total_steps: 2 }),
        eventLine("sequence_halted", {
          namespace: "auto:t1:1",
          failed_step_id: "alpha",
          reason: "resume_failed",
        }),
      ],
    }),
  ];
  const summaries = summarizeRuns(parseStructuredEvents(receipts));
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].status, "halted");
  assert.equal(summaries[0].failedStepId, "alpha");
});
