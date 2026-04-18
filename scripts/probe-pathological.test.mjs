import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULTS,
  PRESET_DEFINITIONS,
  buildProbeCommands,
  defaultStepId,
  renderHumanReport,
  resolveProbeRequest,
} from "./probe-pathological.mjs";

test("defaultStepId uses explicit runtime-facing preset names", () => {
  assert.equal(defaultStepId("false_success", 35), "probe-false_success-z");
});

test("resolveProbeRequest maps control preset to honest work", () => {
  const request = resolveProbeRequest({
    preset: "control",
    stepId: "probe-control-abc",
  });

  assert.equal(request.methodName, PRESET_DEFINITIONS.control.methodName);
  assert.deepEqual(request.args, { label: "probe-control-abc" });
  assert.equal(request.innerGasTgas, DEFAULTS.defaultInnerGasTgas);
  assert.match(request.expectation, /real target-side work/);
});

test("resolveProbeRequest maps decoy_returned_chain to explicit callee args", () => {
  const request = resolveProbeRequest({
    preset: "decoy_returned_chain",
    stepId: "probe-decoy-abc",
    callee: "echo.x.mike.testnet",
  });

  assert.equal(request.methodName, PRESET_DEFINITIONS.decoy_returned_chain.methodName);
  assert.deepEqual(request.args, { callee: "echo.x.mike.testnet" });
  assert.match(request.expectation, /returned decoy chain/);
});

test("resolveProbeRequest rejects raw preset without method", () => {
  assert.throws(
    () =>
      resolveProbeRequest({
        preset: "raw",
        stepId: "probe-raw-abc",
        argsJson: "{}",
      }),
    /raw preset requires --method/
  );
});

test("resolveProbeRequest rejects raw preset without args-json", () => {
  assert.throws(
    () =>
      resolveProbeRequest({
        preset: "raw",
        stepId: "probe-raw-abc",
        method: "do_honest_work",
      }),
    /raw preset requires --args-json/
  );
});

test("resolveProbeRequest accepts raw preset with explicit object args", () => {
  const request = resolveProbeRequest({
    preset: "raw",
    stepId: "probe-raw-abc",
    method: "do_honest_work",
    argsJson: '{"label":"manual"}',
    innerGasTgas: 77,
  });

  assert.equal(request.methodName, "do_honest_work");
  assert.deepEqual(request.args, { label: "manual" });
  assert.equal(request.innerGasTgas, 77);
});

test("buildProbeCommands renders follow-up trace investigate and state commands", () => {
  const commands = buildProbeCommands({
    network: "testnet",
    signer: "x.mike.testnet",
    contractId: "smart-account.x.mike.testnet",
    targetId: "pathological-router.x.mike.testnet",
    stageTxHash: "stagehash",
    runTxHash: "runhash",
  });

  assert.equal(
    commands.trace_stage,
    "./scripts/trace-tx.mjs stagehash x.mike.testnet --wait FINAL --network testnet"
  );
  assert.equal(
    commands.trace_run,
    "./scripts/trace-tx.mjs runhash x.mike.testnet --wait FINAL --network testnet"
  );
  assert.match(
    commands.investigate_stage,
    /investigate-tx\.mjs stagehash x\.mike\.testnet --wait FINAL --network testnet/
  );
  assert.match(commands.investigate_stage, /get_calls_completed/);
  assert.match(commands.investigate_stage, /get_last_burst/);
  assert.equal(
    commands.state_calls_completed,
    "./scripts/state.mjs pathological-router.x.mike.testnet --method get_calls_completed --network testnet"
  );
});

test("renderHumanReport includes explicit runtime-facing preset and expectation text", () => {
  const output = renderHumanReport({
    preset: "false_success",
    description:
      "False-success probe: the target can return callback-visible success even though no real target-side work happened.",
    target_id: "pathological-router.x.mike.testnet",
    method_name: "noop_claim_success",
    args: { label: "probe-false_success-abc" },
    expectation: "Direct may observe success even when target-side work did not happen.",
    state_before: { available: true, calls_completed: 0, last_burst: null },
    stage_tx_hash: "7ETbKx4hgby",
    run_tx_hash: "FEXVz2sNQk2",
    state_after: { available: true, calls_completed: 0, last_burst: null },
    commands: buildProbeCommands({
      network: "testnet",
      signer: "x.mike.testnet",
      contractId: "smart-account.x.mike.testnet",
      targetId: "pathological-router.x.mike.testnet",
      stageTxHash: "7ETbKx4hgby",
      runTxHash: "FEXVz2sNQk2",
    }),
  });

  assert.match(output, /^preset=false_success/m);
  assert.match(output, /expectation=Direct may observe success even when target-side work did not happen\./);
  assert.match(output, /state_before=calls_completed=0 last_burst=null/);
  assert.match(output, /trace\(stage\):/);
});
