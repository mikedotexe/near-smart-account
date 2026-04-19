import test from "node:test";
import assert from "node:assert/strict";

import { buildDemoExecutionPlan } from "./demo-plan.mjs";

test("--register-only disables run_sequence, recorder waiting, and artifact writes", () => {
  assert.deepEqual(buildDemoExecutionPlan({ registerOnly: true }), {
    registerOnly: true,
    runSequence: false,
    waitForRecorder: false,
    writeArtifacts: false,
  });
});

test("default mode keeps the full demo flow", () => {
  assert.deepEqual(buildDemoExecutionPlan({ registerOnly: false }), {
    registerOnly: false,
    runSequence: true,
    waitForRecorder: true,
    writeArtifacts: true,
  });
});
