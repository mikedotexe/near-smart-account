import { callViewMethod } from "./near-cli.mjs";
import { flattenReceiptTree, traceTx } from "./trace-rpc.mjs";

export const STAGE_OUTCOME = Object.freeze({
  HARD_FAIL_BEFORE_STAGE: "hard_fail_before_stage",
  PENDING_UNTIL_RESUME: "pending_until_resume",
  IMMEDIATE_RESUME_FAILED: "immediate_resume_failed",
});

export function classifyStageOutcome({ stageTrace, stagedState }) {
  const finalStatus = stageTrace?.tree?.finalStatus;
  const receipts = stageTrace?.tree ? flattenReceiptTree(stageTrace.tree) : [];
  const yieldedReceipts = receipts.filter((receipt) => receipt.isPromiseYield);
  const pendingYieldCount = yieldedReceipts.filter(
    (receipt) => receipt.statusTag === "pending_yield"
  ).length;
  const resumeFailedCount = yieldedReceipts.filter((receipt) =>
    receipt.logs.some((log) => log.includes("could not resume"))
  ).length;
  const resumedBeforeRunCount = Math.max(0, yieldedReceipts.length - pendingYieldCount);

  let classification = STAGE_OUTCOME.HARD_FAIL_BEFORE_STAGE;
  let reason = "stage receipt failed before a pending yielded step became visible";

  if (isFailureStatus(finalStatus)) {
    classification = STAGE_OUTCOME.HARD_FAIL_BEFORE_STAGE;
    reason = extractFailureMessage(finalStatus);
  } else if (resumeFailedCount > 0) {
    classification = STAGE_OUTCOME.IMMEDIATE_RESUME_FAILED;
    reason = "yielded callback resumed before run_sequence and observed PromiseError::Failed";
  } else if (pendingYieldCount > 0 || stagedState?.ready) {
    classification = STAGE_OUTCOME.PENDING_UNTIL_RESUME;
    reason = "yielded step stayed pending for explicit run_sequence release";
  } else if (yieldedReceipts.length > 0 && resumedBeforeRunCount > 0) {
    classification = STAGE_OUTCOME.IMMEDIATE_RESUME_FAILED;
    reason = "yielded callback executed before run_sequence instead of remaining pending";
  } else if (stageTrace?.error) {
    reason = `stage trace unavailable: ${stageTrace.error}`;
  }

  return {
    classification,
    reason,
    staged_visible: Boolean(stagedState?.ready),
    observed_staged_count: stagedState?.observed_count ?? 0,
    staged_view_error: stagedState?.error ?? null,
    pending_yield_count: pendingYieldCount,
    yielded_receipt_count: yieldedReceipts.length,
    resumed_before_run: resumedBeforeRunCount > 0,
    resumed_before_run_count: resumedBeforeRunCount,
    resume_failed_count: resumeFailedCount,
    trace_classification: stageTrace?.classification ?? null,
  };
}

function isFailureStatus(status) {
  return typeof status === "object" && status !== null && "Failure" in status;
}

function extractFailureMessage(status) {
  if (!isFailureStatus(status)) {
    return "unknown stage failure";
  }
  try {
    const failure = status.Failure;
    const execError =
      failure?.ActionError?.kind?.FunctionCallError?.ExecutionError ||
      failure?.ActionError?.kind?.FunctionCallError?.CompilationError ||
      JSON.stringify(failure);
    return String(execError);
  } catch {
    return "unknown stage failure";
  }
}

export async function readStagedCallsForCaller(network, contractId, callerId) {
  try {
    const view = await callViewMethod(network, contractId, "staged_calls_for", {
      caller_id: callerId,
    });
    return {
      block_height: view.block_height,
      block_hash: view.block_hash,
      staged_calls: Array.isArray(view.value) ? view.value : [],
      error: null,
    };
  } catch (error) {
    return {
      block_height: null,
      block_hash: null,
      staged_calls: [],
      error: String(error),
    };
  }
}

export async function waitForStagedCallsForCaller({
  network,
  contractId,
  callerId,
  expectedCount,
  pollMs,
  timeoutMs,
}) {
  let last = await readStagedCallsForCaller(network, contractId, callerId);

  if (timeoutMs <= 0) {
    return {
      ready: last.staged_calls.length >= expectedCount,
      expected_count: expectedCount,
      observed_count: last.staged_calls.length,
      poll_ms: pollMs,
      timeout_ms: timeoutMs,
      block_height: last.block_height,
      block_hash: last.block_hash,
      staged_calls: last.staged_calls,
    };
  }

  const deadline = Date.now() + timeoutMs;
  while (last.staged_calls.length < expectedCount && Date.now() < deadline) {
    if (last.error) {
      break;
    }
    await sleep(pollMs);
    last = await readStagedCallsForCaller(network, contractId, callerId);
  }

  return {
    ready: last.staged_calls.length >= expectedCount,
    expected_count: expectedCount,
    observed_count: last.staged_calls.length,
    poll_ms: pollMs,
    timeout_ms: timeoutMs,
    block_height: last.block_height,
    block_hash: last.block_hash,
    staged_calls: last.staged_calls,
    error: last.error,
  };
}

export async function diagnoseStageTransaction({
  network,
  txHash,
  signer,
  contractId,
  expectedCount,
  pollMs = 1_000,
  timeoutMs = 15_000,
}) {
  const stagedState = await waitForStagedCallsForCaller({
    network,
    contractId,
    callerId: signer,
    expectedCount,
    pollMs,
    timeoutMs,
  });

  let stageTrace = null;
  try {
    stageTrace = await traceTx(network, txHash, signer, "EXECUTED_OPTIMISTIC");
  } catch (error) {
    stageTrace = {
      senderId: signer,
      classification: "ERROR",
      tree: null,
      error: String(error),
    };
  }

  return {
    tx_hash: txHash,
    staged_state: stagedState,
    stage_trace: stageTrace,
    stage_outcome: classifyStageOutcome({
      stageTrace,
      stagedState,
    }),
  };
}

export function renderStageOutcomeSummary(summary) {
  return [
    `stage_outcome=${summary.classification}`,
    `reason=${summary.reason}`,
    `staged_visible=${summary.staged_visible}`,
    `observed_staged_count=${summary.observed_staged_count}`,
    `staged_view_error=${summary.staged_view_error ?? "none"}`,
    `yielded_receipts=${summary.yielded_receipt_count}`,
    `pending_yield_count=${summary.pending_yield_count}`,
    `resumed_before_run=${summary.resumed_before_run}`,
    `resume_failed_count=${summary.resume_failed_count}`,
    `trace_classification=${summary.trace_classification ?? "unknown"}`,
  ].join("\n");
}

export function getMainnetStageGasGuidance({ network, actionCount, actionGasTgas }) {
  if (network !== "mainnet" || actionCount <= 1) return [];

  const guidance = [
    "mainnet note: current lab probes showed single-step staged calls staying pending at 180/250/500 TGas, but two-step batches only stayed pending at 300/400 TGas per action.",
  ];

  if (actionGasTgas < 300) {
    guidance.push(
      `warning: ${actionCount}-step mainnet batch at ${actionGasTgas} TGas/action is below the current observed two-step floor; start at 300 TGas/action unless you are deliberately probing the failure boundary.`
    );
  } else {
    guidance.push(
      `mainnet guidance: ${actionCount}-step batch at ${actionGasTgas} TGas/action is at or above the current observed two-step floor (300 TGas/action).`
    );
  }

  return guidance;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
