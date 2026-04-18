import test from "node:test";
import assert from "node:assert/strict";

import { buildDemoExecutionPlan } from "./demo-plan.mjs";

test("--stage-only disables run_sequence, recorder waiting, and artifact writes", () => {
  assert.deepEqual(buildDemoExecutionPlan({ stageOnly: true }), {
    stageOnly: true,
    runSequence: false,
    waitForRecorder: false,
    writeArtifacts: false,
  });
});

test("default mode keeps the full demo flow", () => {
  assert.deepEqual(buildDemoExecutionPlan({ stageOnly: false }), {
    stageOnly: false,
    runSequence: true,
    waitForRecorder: true,
    writeArtifacts: true,
  });
});
