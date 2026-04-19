#!/usr/bin/env node
//
// send-demo.mjs — run the standalone simple-sequencer demo end to end.
//
// The default execution path performs both transactions:
//
// 1. submit one multi-action `register_step` batch against `simple-sequencer`
// 2. call `run_sequence(...)` in a deliberately different order
// 3. poll `simple-recorder.get_entries()` until the downstream sequence resolves
// 4. write a forensic artifact under `collab/artifacts/`

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import {
  decodeSuccessValue,
  getNetworkConfig,
  REPO_ROOT,
  shortHash,
  sleep,
} from "../../scripts/lib/fastnear.mjs";
import {
  buildTxArtifact,
  callViewMethod,
  connectNearWithSigners,
  sendFunctionCall,
  sendTransactionAsync,
} from "../../scripts/lib/near-cli.mjs";
import { traceTx } from "../../scripts/lib/trace-rpc.mjs";
import {
  diagnoseRegisterTransaction,
  renderStepOutcomeSummary,
} from "../../scripts/lib/step-sequence.mjs";
import { buildDemoExecutionPlan } from "./demo-plan.mjs";

const MAX_TX_GAS_TGAS = 1_000;

const { values, positionals } = parseArgs({
  options: {
    network: { type: "string", default: "testnet" },
    signer: { type: "string", default: process.env.SIGNER || "mike.testnet" },
    master: { type: "string", default: process.env.MASTER || "x.mike.testnet" },
    prefix: { type: "string", default: process.env.PREFIX || "" },
    contract: { type: "string" },
    target: { type: "string" },
    method: { type: "string", default: "record" },
    "action-gas": { type: "string", default: "250" },
    "call-gas": { type: "string", default: "30" },
    "run-gas": { type: "string", default: "100" },
    "call-deposit-yocto": { type: "string", default: "0" },
    "sequence-order": { type: "string" },
    "artifacts-file": { type: "string" },
    "poll-ms": { type: "string", default: "2000" },
    "step-register-timeout-ms": { type: "string", default: "30000" },
    "resolve-timeout-ms": { type: "string", default: "90000" },
    "register-only": { type: "boolean", default: false },
    dry: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
  allowPositionals: true,
});

const specs = (positionals.length ? positionals : ["alpha:1", "beta:2", "gamma:3"]).map(
  parseSpec
);
assertUniqueStepIds(specs.map((spec) => spec.step_id), "submitted actions");

const actionGasTgas = Number(values["action-gas"]);
const callGasTgas = Number(values["call-gas"]);
const runGasTgas = Number(values["run-gas"]);
const pollMs = Number(values["poll-ms"]);
const stepRegisterTimeoutMs = Number(values["step-register-timeout-ms"]);
const resolveTimeoutMs = Number(values["resolve-timeout-ms"]);
if (!Number.isFinite(actionGasTgas) || actionGasTgas <= 0) {
  throw new Error("--action-gas must be a positive number");
}
if (!Number.isFinite(callGasTgas) || callGasTgas <= 0) {
  throw new Error("--call-gas must be a positive number");
}
if (!Number.isFinite(runGasTgas) || runGasTgas <= 0) {
  throw new Error("--run-gas must be a positive number");
}
if (!Number.isFinite(pollMs) || pollMs <= 0) {
  throw new Error("--poll-ms must be a positive number");
}
if (!Number.isFinite(stepRegisterTimeoutMs) || stepRegisterTimeoutMs <= 0) {
  throw new Error("--step-register-timeout-ms must be a positive number");
}
if (!Number.isFinite(resolveTimeoutMs) || resolveTimeoutMs <= 0) {
  throw new Error("--resolve-timeout-ms must be a positive number");
}

const totalActionGasTgas = actionGasTgas * specs.length;
if (totalActionGasTgas > MAX_TX_GAS_TGAS) {
  throw new Error(
    `requested ${totalActionGasTgas} TGas across ${specs.length} actions; keep one transaction at or under ${MAX_TX_GAS_TGAS} TGas`
  );
}

const sequenceOrder = values["sequence-order"]
  ? values["sequence-order"]
      .split(",")
      .map((stepId) => stepId.trim())
      .filter(Boolean)
  : specs.map((spec) => spec.step_id);
validateSequenceOrder(specs, sequenceOrder);
const contractId =
  values.contract || subaccount("simple-sequencer", values.prefix, values.master);
const targetId = values.target || subaccount("simple-recorder", values.prefix, values.master);
const runSequenceArgs = {
  caller_id: values.signer,
  order: sequenceOrder,
};
const runId = Date.now().toString(36);
const networkConfig = getNetworkConfig(values.network);
const artifactsFile =
  values["artifacts-file"] ||
  defaultArtifactsFile({ prefix: values.prefix, signer: values.signer, runId });
const executionPlan = buildDemoExecutionPlan({
  registerOnly: values["register-only"],
});
const commands = commandSet({
  network: values.network,
  signer: values.signer,
  contractId,
  targetId,
  runSequenceArgs,
  registerTxHash: "<register_tx_hash>",
  runSequenceTxHash: "<run_sequence_tx_hash>",
});

if (values.dry) {
  console.log(
    JSON.stringify(
      {
        network: values.network,
        signer: values.signer,
        master: values.master,
        prefix: values.prefix || null,
        contract: contractId,
        target: targetId,
        method: values.method,
        action_gas_tgas: actionGasTgas,
        total_action_gas_tgas: totalActionGasTgas,
        downstream_call_gas_tgas: callGasTgas,
        run_gas_tgas: runGasTgas,
        register_only: executionPlan.registerOnly,
        downstream_call_deposit_yocto: values["call-deposit-yocto"],
        sequence_order: sequenceOrder,
        step_register_timeout_ms: stepRegisterTimeoutMs,
        resolve_timeout_ms: resolveTimeoutMs,
        poll_ms: pollMs,
        artifacts_file: artifactsFile,
        fastnear_endpoints: endpointNotes({
          networkConfig,
          contractId,
          targetId,
          signer: values.signer,
          runSequenceArgs,
        }),
        actions: specs,
        commands,
      },
      null,
      2
    )
  );
  process.exit(0);
}

const { nearApi, accounts } = await connectNearWithSigners(values.network, [values.signer]);
const account = accounts[values.signer];
const recorderBefore = await readRecorderState(values.network, targetId);
const actions = specs.map((spec) =>
  nearApi.transactions.functionCall(
    "register_step",
    Buffer.from(
      JSON.stringify({
        target_id: targetId,
        method_name: values.method,
        args: Buffer.from(
          JSON.stringify({ step_id: spec.step_id, value: spec.value })
        ).toString("base64"),
        attached_deposit_yocto: values["call-deposit-yocto"],
        gas_tgas: callGasTgas,
        step_id: spec.step_id,
      })
    ),
    BigInt(actionGasTgas) * 10n ** 12n,
    0n
  )
);

const registerResult = await sendTransactionAsync(account, contractId, actions);
const registerArtifact = await buildTxArtifact(
  values.network,
  registerResult,
  values.signer,
  "register_batch"
);
const registerDiagnosis = await diagnoseRegisterTransaction({
  network: values.network,
  txHash: registerArtifact.tx_hash,
  signer: values.signer,
  contractId,
  expectedCount: specs.length,
  pollMs,
  timeoutMs: stepRegisterTimeoutMs,
});
const registerTrace = await safeTrace(values.network, registerArtifact.tx_hash, values.signer);

if (executionPlan.registerOnly) {
  const registerOnlyCommands = commandSet({
    network: values.network,
    signer: values.signer,
    contractId,
    targetId,
    runSequenceArgs,
    registerTxHash: registerArtifact.tx_hash,
    runSequenceTxHash: "<run_sequence_tx_hash>",
  });
  const registerOnlyOutput = {
    generated_at: new Date().toISOString(),
    run_id: runId,
    network: values.network,
    signer: values.signer,
    master: values.master,
    prefix: values.prefix || null,
    contract_id: contractId,
    recorder_id: targetId,
    method: values.method,
    action_gas_tgas: actionGasTgas,
    downstream_call_gas_tgas: callGasTgas,
    step_register_timeout_ms: stepRegisterTimeoutMs,
    submitted_actions: specs,
    sequence_order_requested: sequenceOrder,
    register_only: true,
    register_primary_forensics: {
      tx_hash: registerArtifact.tx_hash,
      signer: values.signer,
    },
    txs: [
      {
        ...registerArtifact,
        decoded_success_value: null,
      },
    ],
    recorder_state_before: recorderBefore,
    registered_steps_before_release: registerDiagnosis.registered_state,
    step_outcome: registerDiagnosis.step_outcome,
    traces: {
      register_batch: registerTrace,
    },
    commands: registerOnlyCommands,
  };

  if (values.json) {
    console.log(JSON.stringify(registerOnlyOutput, null, 2));
    process.exit(0);
  }

  console.log(
    `network=${values.network} signer=${values.signer} contract=${contractId} recorder=${targetId}`
  );
  console.log(
    `register_batch: tx_hash=${registerArtifact.tx_hash} block_height=${registerArtifact.block_height ?? "?"} signer=${values.signer}`
  );
  console.log(renderStepOutcomeSummary(registerDiagnosis.step_outcome));
  for (const spec of specs) {
    console.log(
      `  ${spec.step_id} -> ${targetId}.${values.method}({"step_id":"${spec.step_id}","value":${spec.value}})`
    );
  }
  console.log(`trace(register_batch): ${registerOnlyCommands.trace_register}`);
  console.log(`state(recorder): ${registerOnlyCommands.state_recorder}`);
  console.log(`investigate(register_batch): ${registerOnlyCommands.investigate_register}`);
  if (registerDiagnosis.step_outcome.classification === "pending_until_resume") {
    console.log(`run_sequence: ${registerOnlyCommands.run_sequence}`);
  } else {
    console.log("run_sequence: skipped until step_outcome becomes pending_until_resume");
  }
  console.log(`short=register:${shortHash(registerArtifact.tx_hash)}`);
  process.exit(0);
}

if (registerDiagnosis.step_outcome.classification !== "pending_until_resume") {
  throw new Error(
    `register batch ${registerArtifact.tx_hash} did not remain pending: ${registerDiagnosis.step_outcome.classification}`
  );
}

const runSequenceResult = await sendFunctionCall(
  nearApi,
  account,
  contractId,
  "run_sequence",
  runSequenceArgs,
  runGasTgas
);
const recorderAfter = await waitForRecorderEntries({
  network: values.network,
  targetId,
  initialCount: recorderBefore.entries.length,
  expectedNewEntries: specs.length,
  pollMs,
  resolveTimeoutMs,
});
const runSequenceArtifact = await buildTxArtifact(
  values.network,
  runSequenceResult,
  values.signer,
  "run_sequence"
);
const finalCommands = commandSet({
  network: values.network,
  signer: values.signer,
  contractId,
  targetId,
  runSequenceArgs,
  registerTxHash: registerArtifact.tx_hash,
  runSequenceTxHash: runSequenceArtifact.tx_hash,
});
const runSequenceTrace = await safeTrace(
  values.network,
  runSequenceArtifact.tx_hash,
  values.signer
);
const artifacts = {
  generated_at: new Date().toISOString(),
  run_id: runId,
  network: values.network,
  signer: values.signer,
  master: values.master,
  prefix: values.prefix || null,
  contract_id: contractId,
  recorder_id: targetId,
  method: values.method,
  action_gas_tgas: actionGasTgas,
  downstream_call_gas_tgas: callGasTgas,
  run_gas_tgas: runGasTgas,
  step_register_timeout_ms: stepRegisterTimeoutMs,
  downstream_call_deposit_yocto: values["call-deposit-yocto"],
  submitted_actions: specs,
  sequence_order_requested: sequenceOrder,
  run_sequence_args: runSequenceArgs,
  register_primary_forensics: {
    tx_hash: registerArtifact.tx_hash,
    signer: values.signer,
  },
  txs: [
    {
      ...registerArtifact,
      decoded_success_value: null,
    },
    {
      ...runSequenceArtifact,
      decoded_success_value:
        decodeSuccessValue(runSequenceResult.status?.SuccessValue) || null,
    },
  ],
  recorder_state_before: recorderBefore,
  registered_steps_before_release: registerDiagnosis.registered_state,
  step_outcome: registerDiagnosis.step_outcome,
  recorder_state_after: recorderAfter,
  traces: {
    register_batch: registerTrace,
    run_sequence: runSequenceTrace,
  },
  fastnear_endpoints: endpointNotes({
    networkConfig,
    contractId,
    targetId,
    signer: values.signer,
    runSequenceArgs,
  }),
  commands: finalCommands,
  artifacts_file: artifactsFile,
};

fs.mkdirSync(path.dirname(artifactsFile), { recursive: true });
fs.writeFileSync(artifactsFile, `${JSON.stringify(artifacts, null, 2)}\n`);

if (values.json) {
  console.log(JSON.stringify(artifacts, null, 2));
  process.exit(0);
}

console.log(
  `network=${values.network} signer=${values.signer} contract=${contractId} recorder=${targetId}`
);
console.log(
  `register_batch: tx_hash=${registerArtifact.tx_hash} block_height=${registerArtifact.block_height ?? "?"} signer=${values.signer}`
);
console.log(renderStepOutcomeSummary(registerDiagnosis.step_outcome));
console.log(
  `run_sequence: tx_hash=${runSequenceArtifact.tx_hash} block_height=${runSequenceArtifact.block_height ?? "?"} signer=${values.signer}`
);
console.log(
  `recorder: resolved=${recorderAfter.resolved} new_entries=${recorderAfter.new_entries.length}/${specs.length} block_height=${recorderAfter.block_height ?? "?"}`
);
console.log(`artifacts=${artifactsFile}`);
for (const spec of specs) {
  console.log(
    `  ${spec.step_id} -> ${targetId}.${values.method}({"step_id":"${spec.step_id}","value":${spec.value}})`
  );
}
console.log(`trace(register_batch): ${finalCommands.trace_register}`);
console.log(`trace(run_sequence): ${finalCommands.trace_run_sequence}`);
console.log(`state(recorder): ${finalCommands.state_recorder}`);
console.log(`investigate(register_batch): ${finalCommands.investigate_register}`);
console.log(`receipt_to_tx: ${finalCommands.receipt_to_tx}`);
console.log(
  `short=register:${shortHash(registerArtifact.tx_hash)} run:${shortHash(runSequenceArtifact.tx_hash)}`
);

function parseSpec(raw) {
  const idx = raw.indexOf(":");
  if (idx <= 0 || idx === raw.length - 1) {
    throw new Error(`invalid action spec '${raw}' (expected step_id:number)`);
  }
  const step_id = raw.slice(0, idx);
  const value = Number(raw.slice(idx + 1));
  if (!Number.isInteger(value)) {
    throw new Error(`invalid numeric payload in '${raw}'`);
  }
  return { step_id, value };
}

function assertUniqueStepIds(stepIds, context) {
  if (new Set(stepIds).size !== stepIds.length) {
    throw new Error(`${context} contain duplicate step IDs`);
  }
}

function validateSequenceOrder(specs, sequenceOrder) {
  const submitted = new Set(specs.map((spec) => spec.step_id));
  if (sequenceOrder.length !== specs.length) {
    throw new Error("--sequence-order must list exactly one step_id for each submitted action");
  }
  for (const stepId of sequenceOrder) {
    if (!submitted.delete(stepId)) {
      throw new Error(`--sequence-order contains an unknown or duplicate step_id '${stepId}'`);
    }
  }
}

function subaccount(name, prefix, master) {
  if (prefix) {
    return `${name}-${prefix}.${master}`;
  }
  return `${name}.${master}`;
}

function defaultArtifactsFile({ prefix, signer, runId }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(
    REPO_ROOT,
    "collab",
    "artifacts",
    `${stamp}-simple-example-${prefix || signer.replace(/\./g, "-")}-${runId}.json`
  );
}

function commandSet({
  network,
  signer,
  contractId,
  targetId,
  runSequenceArgs,
  registerTxHash,
  runSequenceTxHash,
}) {
  const recorderView = JSON.stringify({
    account: targetId,
    method: "get_entries",
  });
  return {
    run_sequence: `NEAR_ENV=${network} near call ${contractId} run_sequence '${JSON.stringify(
      runSequenceArgs
    )}' --accountId ${signer}`,
    trace_register: `./scripts/trace-tx.mjs ${registerTxHash} ${signer} --wait FINAL`,
    trace_run_sequence: `./scripts/trace-tx.mjs ${runSequenceTxHash} ${signer} --wait FINAL`,
    state_recorder: `./scripts/state.mjs ${targetId} --method get_entries`,
    investigate_register:
      `./scripts/investigate-tx.mjs ${registerTxHash} ${signer} --wait FINAL ` +
      `--accounts ${contractId},${targetId} --view '${recorderView}'`,
    receipt_to_tx: "./scripts/receipt-to-tx.mjs <receipt_id>",
  };
}

async function readRecorderState(network, targetId) {
  const view = await callViewMethod(network, targetId, "get_entries");
  const entries = Array.isArray(view.value) ? view.value : [];
  return {
    block_height: view.block_height,
    block_hash: view.block_hash,
    logs: view.logs,
    entries,
  };
}

async function waitForRecorderEntries({
  network,
  targetId,
  initialCount,
  expectedNewEntries,
  pollMs,
  resolveTimeoutMs,
}) {
  const deadline = Date.now() + resolveTimeoutMs;
  let last = await readRecorderState(network, targetId);
  while (last.entries.length < initialCount + expectedNewEntries && Date.now() < deadline) {
    await sleep(pollMs);
    last = await readRecorderState(network, targetId);
  }

  const finalEntries = last.entries;
  return {
    resolved: finalEntries.length >= initialCount + expectedNewEntries,
    expected_new_entries: expectedNewEntries,
    initial_entry_count: initialCount,
    observed_entry_count: finalEntries.length,
    observed_new_entries: Math.max(0, finalEntries.length - initialCount),
    poll_ms: pollMs,
    timeout_ms: resolveTimeoutMs,
    block_height: last.block_height,
    block_hash: last.block_hash,
    logs: last.logs,
    entries: finalEntries,
    new_entries: finalEntries.slice(initialCount),
  };
}

async function safeTrace(network, txHash, signer) {
  try {
    const traced = await traceTx(network, txHash, signer, "FINAL");
    return {
      sender_id: traced.senderId,
      classification: traced.classification,
      error: traced.error || null,
    };
  } catch (error) {
    return {
      sender_id: signer,
      classification: "ERROR",
      error: String(error),
    };
  }
}

function endpointNotes({
  networkConfig,
  contractId,
  targetId,
  signer,
  runSequenceArgs,
}) {
  return [
    {
      kind: "live_capture",
      transport: "RPC",
      endpoint: "EXPERIMENTAL_tx_status",
      base_url: networkConfig.rpc,
      archival_fallback_base_url: networkConfig.archivalRpc,
      helper: "traceTx(...) via scripts/lib/trace-rpc.mjs",
      how_we_use_it: {
        params: {
          tx_hash: "<register_or_run_sequence_tx_hash>",
          sender_account_id: "<signer>",
          wait_until: "FINAL",
        },
        behavior:
          "The helper queries the hot RPC first and retries on the archival RPC when the hot node returns UNKNOWN_TRANSACTION.",
      },
      why_we_use_it:
        "Classify the register and run_sequence traces and preserve the receipt-DAG anchor we will inspect later for callback ordering.",
    },
    {
      kind: "live_capture",
      transport: "RPC",
      endpoint: "query(call_function)",
      base_url: networkConfig.rpc,
      helper: "callViewMethod(...) via scripts/lib/near-cli.mjs",
      how_we_use_it: {
        params: {
          request_type: "call_function",
          account_id: contractId,
          method_name: "registered_steps_for",
          args_base64: Buffer.from(
            JSON.stringify({ caller_id: signer })
          ).toString("base64"),
          finality: "final",
        },
        behavior:
          "After async register submission, we poll simple-sequencer.registered_steps_for(caller_id) until the expected registered steps materialize before sending run_sequence.",
      },
      why_we_use_it:
        "Avoid commit-style submission semantics and prove that the registered steps are actually live before we try to resume them.",
    },
    {
      kind: "live_capture",
      transport: "Transactions API",
      endpoint: "POST /v0/transactions",
      base_url: networkConfig.txApi,
      helper: "buildTxArtifact(...) via scripts/lib/near-cli.mjs",
      how_we_use_it: {
        body: {
          tx_hashes: ["<register_tx_hash>", "<run_sequence_tx_hash>"],
        },
        behavior:
          "We call the endpoint once per transaction to enrich the run artifact with block_height, block_hash, receiver_id, and execution status.",
      },
      why_we_use_it:
        "Turn each tx hash into a durable forensic anchor that includes the exact block and receiver metadata we will want later on archival lookups.",
    },
    {
      kind: "live_capture",
      transport: "RPC",
      endpoint: "query(call_function)",
      base_url: networkConfig.rpc,
      helper: "callViewMethod(...) via scripts/lib/near-cli.mjs",
      how_we_use_it: {
        params: {
          request_type: "call_function",
          account_id: targetId,
          method_name: "get_entries",
          args_base64: Buffer.from("{}").toString("base64"),
          finality: "final",
        },
        behavior:
          "We read simple-recorder.get_entries() before the run and poll it after run_sequence until the expected new entries appear or the timeout expires.",
      },
      why_we_use_it:
        "Capture durable state proof of actual downstream effect order, not just the transaction and receipt metadata.",
    },
    {
      kind: "follow_up_analysis",
      transport: "Transactions API",
      endpoint: "POST /v0/receipt",
      base_url: networkConfig.txApi,
      helper: "scripts/receipt-to-tx.mjs",
      how_we_use_it: {
        body: {
          receipt_id: "<receipt_id>",
        },
        behavior:
          "Use it interactively after trace inspection to pivot any interesting registered or downstream receipt back to its originating transaction.",
      },
      why_we_use_it:
        "Receipt ids show up all over the DAG; this is the fastest way to reconnect any one of them to the originating tx for deeper forensic work.",
    },
    {
      kind: "follow_up_analysis",
      transport: "Transactions API",
      endpoint: "POST /v0/block",
      base_url: networkConfig.txApi,
      helper: "fetchBlock(...) via scripts/investigate-tx.mjs",
      how_we_use_it: {
        body: {
          block_id: "<included_or_cascade_block_height_or_hash>",
          with_receipts: true,
          with_transactions: false,
        },
        behavior:
          "The investigation report fetches the included block plus each cascade block, with receipts, to reconstruct the per-block execution timeline.",
      },
      why_we_use_it:
        "Translate the DAG into an actual block-by-block story suitable for later forensic analysis and chapter writing.",
    },
    {
      kind: "follow_up_analysis",
      transport: "Transactions API",
      endpoint: "POST /v0/account",
      base_url: networkConfig.txApi,
      helper: "fetchAccountHistory(...) via scripts/investigate-tx.mjs",
      how_we_use_it: {
        body: {
          account_id: `<one of ${contractId} or ${targetId}>`,
          is_function_call: true,
          limit: 50,
        },
        behavior:
          "The investigation report narrows account activity to the tx window so we can correlate contract-local history with the DAG and state snapshots.",
      },
      why_we_use_it:
        "Adds the account-activity surface, which is often the fastest human-readable way to confirm that a contract participated in the cascade at the blocks we expect.",
    },
    {
      kind: "follow_up_analysis",
      transport: "RPC",
      endpoint: "query(call_function)",
      base_url: networkConfig.rpc,
      helper: "callViewMethod(...) via scripts/investigate-tx.mjs",
      how_we_use_it: {
        params: {
          request_type: "call_function",
          account_id: targetId,
          method_name: "get_entries",
          args_base64: Buffer.from("{}").toString("base64"),
          block_id: "<interesting_block_height>",
        },
        behavior:
          "The investigation report can replay recorder state at specific block heights with the view spec that send-demo prints in its investigate command.",
      },
      why_we_use_it:
        "Turns the recorder into a time series so we can prove not just final order, but when the observable state changed block by block.",
    },
    {
      kind: "follow_up_analysis",
      transport: "CLI wrapper",
      endpoint: "run_sequence contract call",
      base_url: null,
      helper: "send-demo command output",
      how_we_use_it: {
        args: runSequenceArgs,
        behavior:
          "The artifact preserves the exact run_sequence payload used to release the registered steps so later analysis never depends on memory.",
      },
      why_we_use_it:
        "The chosen release order is part of the evidence; saving the payload alongside the tx/block metadata makes the run decision-complete for later forensics.",
    },
  ];
}
