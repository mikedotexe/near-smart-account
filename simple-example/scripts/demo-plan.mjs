export function buildDemoExecutionPlan({ stageOnly }) {
  return {
    stageOnly: Boolean(stageOnly),
    runSequence: !stageOnly,
    waitForRecorder: !stageOnly,
    writeArtifacts: !stageOnly,
  };
}
