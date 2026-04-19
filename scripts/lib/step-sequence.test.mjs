import test from "node:test";
import assert from "node:assert/strict";

import {
  STEP_OUTCOME,
  classifyStepOutcome,
  getMainnetStepGasGuidance,
  renderStepOutcomeSummary,
} from "./step-sequence.mjs";

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

test("classifyStepOutcome recognizes hard gas failure before registering", () => {
  const outcome = classifyStepOutcome({
    registerTrace: {
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
    registeredState: {
      ready: false,
      observed_count: 0,
    },
  });

  assert.equal(outcome.classification, STEP_OUTCOME.HARD_FAIL_BEFORE_REGISTER);
  assert.match(outcome.reason, /Exceeded the prepaid gas/);
});

test("classifyStepOutcome recognizes pending registered steps", () => {
  const outcome = classifyStepOutcome({
    registerTrace: {
      classification: "PENDING",
      tree: tx([
        receipt({
          isPromiseYield: true,
          statusTag: "pending_yield",
        }),
      ]),
      error: null,
    },
    registeredState: {
      ready: true,
      observed_count: 1,
    },
  });

  assert.equal(outcome.classification, STEP_OUTCOME.PENDING_UNTIL_RESUME);
  assert.equal(outcome.pending_yield_count, 1);
});

test("classifyStepOutcome recognizes immediate resume failure", () => {
  const outcome = classifyStepOutcome({
    registerTrace: {
      classification: "FULL_SUCCESS",
      tree: tx([
        receipt({
          isPromiseYield: true,
          logs: [
            "register_step 'alpha' in manual:mike.testnet could not resume, so its yielded promise was dropped and the sequence halted: Failed",
          ],
        }),
      ]),
      error: null,
    },
    registeredState: {
      ready: false,
      observed_count: 0,
    },
  });

  assert.equal(outcome.classification, STEP_OUTCOME.IMMEDIATE_RESUME_FAILED);
  assert.equal(outcome.resume_failed_count, 1);
  assert.equal(outcome.resumed_before_run, true);
});

test("renderStepOutcomeSummary prints the operator-facing fields", () => {
  const summary = renderStepOutcomeSummary({
    classification: STEP_OUTCOME.PENDING_UNTIL_RESUME,
    reason: "registered step stayed pending for explicit run_sequence release",
    registered_visible: true,
    observed_registered_count: 1,
    yielded_receipt_count: 1,
    pending_yield_count: 1,
    resumed_before_run: false,
    resume_failed_count: 0,
    trace_classification: "PENDING",
  });

  assert.match(summary, /step_outcome=pending_until_resume/);
  assert.match(summary, /observed_registered_count=1/);
  assert.match(summary, /trace_classification=PENDING/);
});

test("getMainnetStepGasGuidance warns on low multi-step mainnet action gas", () => {
  const guidance = getMainnetStepGasGuidance({
    network: "mainnet",
    actionCount: 2,
    actionGasTgas: 250,
  });

  assert.equal(guidance.length, 2);
  assert.match(guidance[1], /below the current observed two-step floor/);
});

test("getMainnetStepGasGuidance stays quiet off mainnet or for single-step probes", () => {
  assert.deepEqual(
    getMainnetStepGasGuidance({
      network: "testnet",
      actionCount: 2,
      actionGasTgas: 250,
    }),
    []
  );
  assert.deepEqual(
    getMainnetStepGasGuidance({
      network: "mainnet",
      actionCount: 1,
      actionGasTgas: 180,
    }),
    []
  );
});
