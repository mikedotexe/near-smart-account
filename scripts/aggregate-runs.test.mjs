import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildAggregateReport,
  renderMarkdownReport,
  writeAggregateOutputs,
} from "./aggregate-runs.mjs";

function fixtureReport() {
  return buildAggregateReport({
    network: "testnet",
    accountId: "smart-account.testnet",
    history: { txs_count: 12 },
    txSummaries: [
      {
        txHash: "tx-1",
        signer: "mike.testnet",
        classification: "FULL_SUCCESS",
        eventCount: 4,
      },
      {
        txHash: "tx-2",
        signer: "mike.testnet",
        classification: "PARTIAL_FAIL",
        eventCount: 2,
        error: "synthetic failure",
      },
    ],
    events: [
      {
        event: "trigger_fired",
        data: { namespace: "auto:t1:1" },
        receipt: { id: "r1", blockHeight: 100, transactionHash: "tx-1" },
      },
      {
        event: "step_settled_ok",
        data: { namespace: "auto:t1:1", step_id: "alpha" },
        receipt: { id: "r2", blockHeight: 101, transactionHash: "tx-1" },
      },
      {
        event: "run_finished",
        data: { namespace: "auto:t1:1", status: "Succeeded" },
        receipt: { id: "r3", blockHeight: 102, transactionHash: "tx-1" },
      },
    ],
    runs: [
      {
        namespace: "auto:t1:1",
        origin: "automation",
        triggerId: "t1",
        runNonce: 1,
        sequenceId: "seq-a",
        executorId: "owner.testnet",
        signerId: "owner.testnet",
        firstSeenBlockHeight: 100,
        lastSeenBlockHeight: 102,
        startedAtMs: 1_700_000_000_000,
        finishedAtMs: 1_700_000_000_050,
        durationMs: 50,
        status: "succeeded",
        failedStepId: null,
        errorKind: null,
        errorMsg: null,
        stepCount: 2,
        stepsSettledOk: 2,
        resumeLatencyMsAvg: 12.5,
        resumeLatencyMsMax: 15,
        settleLatencyMsAvg: 22.5,
        settleLatencyMsMax: 30,
        maxUsedGasTgas: 31,
        latestStorageUsage: 555,
        assertionSuccessCount: 1,
        assertionFailureCount: 0,
        events: [
          {
            event: "trigger_fired",
            data: { namespace: "auto:t1:1", trigger_id: "t1", run_nonce: 1, call_count: 2 },
            receipt: { blockHeight: 100, id: "r1" },
          },
          {
            event: "step_settled_ok",
            data: {
              namespace: "auto:t1:1",
              step_id: "alpha",
              next_step_id: "beta",
              settle_latency_ms: 20,
            },
            receipt: { blockHeight: 101, id: "r2" },
          },
          {
            event: "run_finished",
            data: {
              namespace: "auto:t1:1",
              status: "Succeeded",
              duration_ms: 50,
            },
            receipt: { blockHeight: 102, id: "r3" },
          },
        ],
      },
    ],
  });
}

test("renderMarkdownReport includes approachable summary and run details", () => {
  const markdown = renderMarkdownReport(fixtureReport());
  assert.match(markdown, /# Aggregate runs:/);
  assert.match(markdown, /## Overview/);
  assert.match(markdown, /## Run summary/);
  assert.match(markdown, /## Transactions scanned/);
  assert.match(markdown, /## Run details/);
  assert.match(markdown, /auto:t1:1/);
  assert.match(markdown, /Resume ms avg\/max/);
  assert.match(markdown, /step_settled_ok/);
});

test("writeAggregateOutputs preserves schema_version in json output", () => {
  const emitted = writeAggregateOutputs(fixtureReport(), "json");
  const parsed = JSON.parse(emitted.stdout);
  assert.equal(parsed.schema_version, 1);
});

test("writeAggregateOutputs writes markdown and json siblings when requested", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aggregate-runs-"));
  const base = path.join(dir, "report.md");

  const emitted = writeAggregateOutputs(fixtureReport(), "both", base);

  assert.deepEqual(
    emitted.files.sort(),
    [path.join(dir, "report.json"), path.join(dir, "report.md")].sort()
  );
  assert.match(fs.readFileSync(path.join(dir, "report.md"), "utf8"), /Run summary/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8")).schema_version, 1);
});
