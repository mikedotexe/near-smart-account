import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildInterestingBlocks,
  parseViewSpec,
  partitionAccountActivityRows,
  renderMarkdownReport,
  writeReportOutputs,
} from "./investigate-tx.mjs";

function fixtureReport() {
  return {
    schema_version: 1,
    tx: {
      hash: "tx.testnet",
      signer: "mike.testnet",
      receiver: "smart-account.testnet",
      included_block_hash: "block-100",
      included_block_height: 100,
      finality: "FINAL",
      gas_burnt: 123,
      tokens_burnt: "456",
    },
    trace: {
      classification: "FULL_SUCCESS",
      rendered_status: "FULL_SUCCESS",
      text: "tx abc...\n  ... yielded receipt tree ...",
      raw_final_status: { SuccessValue: "" },
    },
    window: {
      minBlock: 100,
      maxBlock: 103,
      interestingBlocks: [100, 101, 103],
      extendAfter: 2,
    },
    receipts: [
      {
        ordinal: 0,
        id: "receipt-a",
        predecessor: "smart-account.testnet",
        executor: "router.testnet",
        actions: ["FunctionCall(route_echo, gas=1, args={})"],
        statusTag: "SuccessReceiptId",
        status: "SuccessReceiptId",
        blockHash: "block-101",
        blockHeight: 101,
        receiptIndex: 0,
        receiptType: "Action",
        logs: ["router step"],
      },
      {
        ordinal: 1,
        id: "receipt-b",
        predecessor: "router.testnet",
        executor: "echo.testnet",
        actions: ["FunctionCall(echo, gas=1, args={})"],
        statusTag: "SuccessValue",
        status: "SuccessValue",
        returnValue: 7,
        blockHash: "block-102",
        blockHeight: 102,
        receiptIndex: 1,
        receiptType: "Action",
        logs: [],
      },
    ],
    blocks: [
      {
        block_height: 101,
        receipts: [
          {
            id: "receipt-a",
            predecessor: "smart-account.testnet",
            executor: "router.testnet",
            actions: ["FunctionCall(route_echo, gas=1, args={})"],
            statusTag: "SuccessReceiptId",
            status: "SuccessReceiptId",
            logs: ["router step"],
            receiptType: "Action",
          },
        ],
      },
      {
        block_height: 102,
        receipts: [
          {
            id: "receipt-b",
            predecessor: "router.testnet",
            executor: "echo.testnet",
            actions: ["FunctionCall(echo, gas=1, args={})"],
            statusTag: "SuccessValue",
            status: "SuccessValue",
            logs: [],
            returnValue: 7,
            receiptType: "Action",
          },
        ],
      },
    ],
    state_snapshots: [
      {
        view: {
          account: "wrap.testnet",
          method: "ft_balance_of",
          args: { account_id: "smart-account.testnet" },
        },
        samples: [
          { block_height: 100, value: "0" },
          { block_height: 103, value: "30000000000000000000000" },
        ],
      },
    ],
    account_activity: [
      {
        account_id: "mike.testnet",
        tx_rows: [
          {
            tx_block_height: 100,
            transaction_hash: "tx.testnet",
            is_signer: true,
            is_success: true,
          },
        ],
        other_rows_in_window_count: 1,
        window_row_count: 2,
      },
    ],
    step_lifecycle: {
      classification: "released_after_register",
      reason: "registered step callbacks were later resumed and executed downstream work",
      yielded_receipt_count: 1,
      pending_yield_count: 0,
      resumed_yield_count: 1,
      resume_failed_count: 0,
    },
    structured_events: [
      {
        event: "sequence_started",
        version: "1.0.0",
        data: {
          namespace: "manual:mike.testnet",
          first_step_id: "alpha",
          total_steps: 2,
        },
        receipt: {
          id: "receipt-a",
          blockHeight: 101,
        },
      },
    ],
    run_summaries: [
      {
        namespace: "manual:mike.testnet",
        status: "succeeded",
        triggerId: null,
        runNonce: null,
        stepCount: 2,
        stepsResolvedOk: 2,
        durationMs: 30,
        resumeLatencyMsAvg: 10,
        resumeLatencyMsMax: 10,
        resolveLatencyMsAvg: 15,
        resolveLatencyMsMax: 20,
        maxUsedGasTgas: 22,
        latestStorageUsage: 321,
        firstSeenBlockHeight: 101,
        lastSeenBlockHeight: 102,
        failedStepId: null,
      },
    ],
    logs: [
      {
        block_height: 101,
        account: "router.testnet",
        log: "router step",
      },
    ],
  };
}

test("parseViewSpec accepts JSON object syntax", () => {
  const parsed = parseViewSpec(
    '{"account":"wrap.testnet","method":"ft_balance_of","args":{"account_id":"smart-account.testnet"}}'
  );
  assert.deepEqual(parsed, {
    account: "wrap.testnet",
    method: "ft_balance_of",
    args: { account_id: "smart-account.testnet" },
  });
});

test("buildInterestingBlocks includes tail block when requested", () => {
  const blocks = buildInterestingBlocks(
    100,
    [
      { blockHeight: 101 },
      { blockHeight: 102 },
    ],
    2
  );
  assert.deepEqual(blocks, [100, 101, 102, 104]);
});

test("partitionAccountActivityRows separates investigated tx from other window rows", () => {
  const partitioned = partitionAccountActivityRows(
    [
      { transaction_hash: "tx.testnet", tx_block_height: 100 },
      { transaction_hash: "other-1", tx_block_height: 101 },
      { transaction_hash: "tx.testnet", tx_block_height: 102 },
    ],
    "tx.testnet"
  );

  assert.equal(partitioned.tx_rows.length, 2);
  assert.equal(partitioned.other_rows_in_window_count, 1);
  assert.equal(partitioned.window_row_count, 3);
});

test("renderMarkdownReport includes core investigation sections", () => {
  const markdown = renderMarkdownReport(fixtureReport());
  assert.match(markdown, /# Investigate tx:/);
  assert.match(markdown, /## Surface 1: Receipt DAG/);
  assert.match(markdown, /## Surface 2: State time-series/);
  assert.match(markdown, /## Surface 3: Per-block receipts/);
  assert.match(markdown, /## Account activity/);
  assert.match(markdown, /## Sequence telemetry/);
  assert.match(markdown, /released_after_register/);
  assert.match(markdown, /## Structured events/);
  assert.match(markdown, /sequence_started/);
  assert.match(markdown, /## Logs/);
  assert.match(markdown, /Showing only rows for this tx/);
});

test("writeReportOutputs preserves schema_version in json output", () => {
  const emitted = writeReportOutputs(fixtureReport(), "json");
  const parsed = JSON.parse(emitted.stdout);
  assert.equal(parsed.schema_version, 1);
});

test("writeReportOutputs writes markdown and json siblings when requested", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "investigate-tx-"));
  const base = path.join(dir, "report.md");

  const emitted = writeReportOutputs(fixtureReport(), "both", base);

  assert.deepEqual(
    emitted.files.sort(),
    [path.join(dir, "report.json"), path.join(dir, "report.md")].sort()
  );
  assert.match(fs.readFileSync(path.join(dir, "report.md"), "utf8"), /Surface 1/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8")).schema_version, 1);
});
