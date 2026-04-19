export function buildDemoExecutionPlan({ registerOnly }) {
  return {
    registerOnly: Boolean(registerOnly),
    runSequence: !registerOnly,
    waitForRecorder: !registerOnly,
    writeArtifacts: !registerOnly,
  };
}
