import { callViewMethod } from "./near-cli.mjs";
import { flattenReceiptTree, traceTx } from "./trace-rpc.mjs";

export const STEP_OUTCOME = Object.freeze({
  HARD_FAIL_BEFORE_REGISTER: "hard_fail_before_register",
  PENDING_UNTIL_RESUME: "pending_until_resume",
  IMMEDIATE_RESUME_FAILED: "immediate_resume_failed",
});

export function classifyStepOutcome({ registerTrace, registeredState }) {
  const finalStatus = registerTrace?.tree?.finalStatus;
  const receipts = registerTrace?.tree ? flattenReceiptTree(registerTrace.tree) : [];
  const yieldedReceipts = receipts.filter((receipt) => receipt.isPromiseYield);
  const pendingYieldCount = yieldedReceipts.filter(
    (receipt) => receipt.statusTag === "pending_yield"
  ).length;
  const resumeFailedCount = yieldedReceipts.filter((receipt) =>
    receipt.logs.some((log) => log.includes("could not resume"))
  ).length;
  const resumedBeforeRunCount = Math.max(0, yieldedReceipts.length - pendingYieldCount);

  let classification = STEP_OUTCOME.HARD_FAIL_BEFORE_REGISTER;
  let reason = "register tx failed before a pending registered step became visible";

  if (isFailureStatus(finalStatus)) {
    classification = STEP_OUTCOME.HARD_FAIL_BEFORE_REGISTER;
    reason = extractFailureMessage(finalStatus);
  } else if (resumeFailedCount > 0) {
    classification = STEP_OUTCOME.IMMEDIATE_RESUME_FAILED;
    reason = "registered step's callback resumed before run_sequence and observed PromiseError::Failed";
  } else if (pendingYieldCount > 0 || registeredState?.ready) {
    classification = STEP_OUTCOME.PENDING_UNTIL_RESUME;
    reason = "registered step stayed pending for explicit run_sequence release";
  } else if (yieldedReceipts.length > 0 && resumedBeforeRunCount > 0) {
    classification = STEP_OUTCOME.IMMEDIATE_RESUME_FAILED;
    reason = "registered step's callback executed before run_sequence instead of remaining pending";
  } else if (registerTrace?.error) {
    reason = `register trace unavailable: ${registerTrace.error}`;
  }

  return {
    classification,
    reason,
    registered_visible: Boolean(registeredState?.ready),
    observed_registered_count: registeredState?.observed_count ?? 0,
    registered_view_error: registeredState?.error ?? null,
    pending_yield_count: pendingYieldCount,
    yielded_receipt_count: yieldedReceipts.length,
    resumed_before_run: resumedBeforeRunCount > 0,
    resumed_before_run_count: resumedBeforeRunCount,
    resume_failed_count: resumeFailedCount,
    trace_classification: registerTrace?.classification ?? null,
  };
}

function isFailureStatus(status) {
  return typeof status === "object" && status !== null && "Failure" in status;
}

function extractFailureMessage(status) {
  if (!isFailureStatus(status)) {
    return "unknown register failure";
  }
  try {
    const failure = status.Failure;
    const execError =
      failure?.ActionError?.kind?.FunctionCallError?.ExecutionError ||
      failure?.ActionError?.kind?.FunctionCallError?.CompilationError ||
      JSON.stringify(failure);
    return String(execError);
  } catch {
    return "unknown register failure";
  }
}

export async function readRegisteredStepsForCaller(network, contractId, callerId) {
  try {
    const view = await callViewMethod(network, contractId, "registered_steps_for", {
      caller_id: callerId,
    });
    return {
      block_height: view.block_height,
      block_hash: view.block_hash,
      registered_steps: Array.isArray(view.value) ? view.value : [],
      error: null,
    };
  } catch (error) {
    return {
      block_height: null,
      block_hash: null,
      registered_steps: [],
      error: String(error),
    };
  }
}

export async function waitForRegisteredStepsForCaller({
  network,
  contractId,
  callerId,
  expectedCount,
  pollMs,
  timeoutMs,
}) {
  let last = await readRegisteredStepsForCaller(network, contractId, callerId);

  if (timeoutMs <= 0) {
    return {
      ready: last.registered_steps.length >= expectedCount,
      expected_count: expectedCount,
      observed_count: last.registered_steps.length,
      poll_ms: pollMs,
      timeout_ms: timeoutMs,
      block_height: last.block_height,
      block_hash: last.block_hash,
      registered_steps: last.registered_steps,
    };
  }

  const deadline = Date.now() + timeoutMs;
  while (last.registered_steps.length < expectedCount && Date.now() < deadline) {
    if (last.error) {
      break;
    }
    await sleep(pollMs);
    last = await readRegisteredStepsForCaller(network, contractId, callerId);
  }

  return {
    ready: last.registered_steps.length >= expectedCount,
    expected_count: expectedCount,
    observed_count: last.registered_steps.length,
    poll_ms: pollMs,
    timeout_ms: timeoutMs,
    block_height: last.block_height,
    block_hash: last.block_hash,
    registered_steps: last.registered_steps,
    error: last.error,
  };
}

export async function diagnoseRegisterTransaction({
  network,
  txHash,
  signer,
  contractId,
  expectedCount,
  pollMs = 1_000,
  timeoutMs = 15_000,
}) {
  const registeredState = await waitForRegisteredStepsForCaller({
    network,
    contractId,
    callerId: signer,
    expectedCount,
    pollMs,
    timeoutMs,
  });

  let registerTrace = null;
  try {
    registerTrace = await traceTx(network, txHash, signer, "EXECUTED_OPTIMISTIC");
  } catch (error) {
    registerTrace = {
      senderId: signer,
      classification: "ERROR",
      tree: null,
      error: String(error),
    };
  }

  return {
    tx_hash: txHash,
    registered_state: registeredState,
    register_trace: registerTrace,
    step_outcome: classifyStepOutcome({
      registerTrace,
      registeredState,
    }),
  };
}

export function renderStepOutcomeSummary(summary) {
  return [
    `step_outcome=${summary.classification}`,
    `reason=${summary.reason}`,
    `registered_visible=${summary.registered_visible}`,
    `observed_registered_count=${summary.observed_registered_count}`,
    `registered_view_error=${summary.registered_view_error ?? "none"}`,
    `yielded_receipts=${summary.yielded_receipt_count}`,
    `pending_yield_count=${summary.pending_yield_count}`,
    `resumed_before_run=${summary.resumed_before_run}`,
    `resume_failed_count=${summary.resume_failed_count}`,
    `trace_classification=${summary.trace_classification ?? "unknown"}`,
  ].join("\n");
}

export function getMainnetStepGasGuidance({ network, actionCount, actionGasTgas }) {
  if (network !== "mainnet" || actionCount <= 1) return [];

  const guidance = [
    "mainnet note: current lab probes showed single-step plans staying pending at 180/250/500 TGas, but two-step batches only stayed pending at 300/400 TGas per action.",
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
