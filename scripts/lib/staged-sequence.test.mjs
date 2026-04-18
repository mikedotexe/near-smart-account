import test from "node:test";
import assert from "node:assert/strict";

import {
  STAGE_OUTCOME,
  classifyStageOutcome,
  getMainnetStageGasGuidance,
  renderStageOutcomeSummary,
} from "./staged-sequence.mjs";

function receipt(overrides = {}) {
  return {
    kind: "receipt",
    id: "receipt.testnet",
    executor: "smart-account.testnet",
    predecessor: "mike.testnet",
    isRefund: false,
    isPromiseYield: false,
    actions: [],
    inputDataIds: [],
    outputDataReceivers: [],
    logs: [],
    gasBurnt: 0,
    tokensBurnt: 0,
    statusTag: "SuccessValue",
    returnValue: null,
    failure: undefined,
    children: [],
    ...overrides,
  };
}

function tx(children, finalStatus = { SuccessValue: "" }) {
  return {
    kind: "tx",
    txHash: "tx.testnet",
    signer: "mike.testnet",
    receiver: "smart-account.testnet",
    finality: "FINAL",
    finalStatus,
    gasBurntTx: 0,
    tokensBurntTx: 0,
    children,
  };
}

test("classifyStageOutcome recognizes hard gas failure before staging", () => {
  const outcome = classifyStageOutcome({
    stageTrace: {
      classification: "HARD_FAIL",
      tree: tx([], {
        Failure: {
          ActionError: {
            kind: {
              FunctionCallError: {
                ExecutionError: "Exceeded the prepaid gas.",
              },
            },
          },
        },
      }),
      error: null,
    },
    stagedState: {
      ready: false,
      observed_count: 0,
    },
  });

  assert.equal(outcome.classification, STAGE_OUTCOME.HARD_FAIL_BEFORE_STAGE);
  assert.match(outcome.reason, /Exceeded the prepaid gas/);
});

test("classifyStageOutcome recognizes pending yielded steps", () => {
  const outcome = classifyStageOutcome({
    stageTrace: {
      classification: "PENDING",
      tree: tx([
        receipt({
          isPromiseYield: true,
          statusTag: "pending_yield",
        }),
      ]),
      error: null,
    },
    stagedState: {
      ready: true,
      observed_count: 1,
    },
  });

  assert.equal(outcome.classification, STAGE_OUTCOME.PENDING_UNTIL_RESUME);
  assert.equal(outcome.pending_yield_count, 1);
});

test("classifyStageOutcome recognizes immediate resume failure", () => {
  const outcome = classifyStageOutcome({
    stageTrace: {
      classification: "FULL_SUCCESS",
      tree: tx([
        receipt({
          isPromiseYield: true,
          logs: [
            "stage_call 'alpha' in manual:mike.testnet could not resume, so its staged yield was dropped and the sequence halted: Failed",
          ],
        }),
      ]),
      error: null,
    },
    stagedState: {
      ready: false,
      observed_count: 0,
    },
  });

  assert.equal(outcome.classification, STAGE_OUTCOME.IMMEDIATE_RESUME_FAILED);
  assert.equal(outcome.resume_failed_count, 1);
  assert.equal(outcome.resumed_before_run, true);
});

test("renderStageOutcomeSummary prints the operator-facing fields", () => {
  const summary = renderStageOutcomeSummary({
    classification: STAGE_OUTCOME.PENDING_UNTIL_RESUME,
    reason: "yielded step stayed pending for explicit run_sequence release",
    staged_visible: true,
    observed_staged_count: 1,
    yielded_receipt_count: 1,
    pending_yield_count: 1,
    resumed_before_run: false,
    resume_failed_count: 0,
    trace_classification: "PENDING",
  });

  assert.match(summary, /stage_outcome=pending_until_resume/);
  assert.match(summary, /observed_staged_count=1/);
  assert.match(summary, /trace_classification=PENDING/);
});

test("getMainnetStageGasGuidance warns on low multi-step mainnet action gas", () => {
  const guidance = getMainnetStageGasGuidance({
    network: "mainnet",
    actionCount: 2,
    actionGasTgas: 250,
  });

  assert.equal(guidance.length, 2);
  assert.match(guidance[1], /below the current observed two-step floor/);
});

test("getMainnetStageGasGuidance stays quiet off mainnet or for single-step probes", () => {
  assert.deepEqual(
    getMainnetStageGasGuidance({
      network: "testnet",
      actionCount: 2,
      actionGasTgas: 250,
    }),
    []
  );
  assert.deepEqual(
    getMainnetStageGasGuidance({
      network: "mainnet",
      actionCount: 1,
      actionGasTgas: 180,
    }),
    []
  );
});
