#!/usr/bin/env node
// scripts/probe-pathological.mjs — single-step Direct probe against
// pathological-router via the real smart-account register_step/run_sequence path.

import { execFile } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { parseArgs, promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { shortHash } from "./lib/fastnear.mjs";
import { callViewMethod, connectNearWithSigners } from "./lib/near-cli.mjs";

const execFileAsync = promisify(execFile);

export const DEFAULTS = Object.freeze({
  network: "testnet",
  signer: "x.mike.testnet",
  contractId: "smart-account.x.mike.testnet",
  targetId: "pathological-router.x.mike.testnet",
  callee: "echo.x.mike.testnet",
  actionGasTgas: 250,
  runGasTgas: 300,
  defaultInnerGasTgas: 100,
  pollMs: 1_000,
  viewTimeoutMs: 8_000,
  stepRegisterTimeoutMs: 30_000,
  postRunObserveMs: 12_000,
});

export const PRESET_DEFINITIONS = Object.freeze({
  control: Object.freeze({
    methodName: "do_honest_work",
    description:
      "Control probe: the target receipt should succeed and that success should correspond to real target-side work.",
    expectation:
      "Direct should succeed and that success should correspond to real target-side work.",
    buildArgs: ({ stepId }) => ({ label: stepId }),
  }),
  gas_exhaustion: Object.freeze({
    methodName: "burn_gas",
    description:
      "Gas-exhaustion probe: the downstream receipt should fail from gas depletion and Direct should halt on that failure.",
    expectation:
      "Direct should observe downstream failure and halt ordered release.",
    buildArgs: () => ({}),
  }),
  false_success: Object.freeze({
    methodName: "noop_claim_success",
    description:
      "False-success probe: the target can return callback-visible success even though no real target-side work happened.",
    expectation:
      "Direct may observe success even when target-side work did not happen.",
    buildArgs: ({ stepId }) => ({ label: stepId }),
  }),
  decoy_returned_chain: Object.freeze({
    methodName: "return_decoy_promise",
    description:
      "Decoy returned-chain probe: the target returns one promise chain while detached real work proceeds outside the trusted surface.",
    expectation:
      "Direct may observe success on the returned decoy chain rather than on the detached real work.",
    buildArgs: ({ callee }) => ({ callee }),
  }),
  oversized_result: Object.freeze({
    methodName: "return_oversized_payload",
    description:
      "Oversized-result probe: the target returns callback-visible success bytes large enough to hit the sequencer's callback size boundary.",
    expectation:
      "Direct may classify an otherwise-successful result as downstream failure because callback result size is part of the completion predicate.",
    buildArgs: () => ({ kb: 20 }),
  }),
});

function parseJsonObject(text, flagName) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${flagName} must be valid JSON: ${error.message}`);
  }
  if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) {
    throw new Error(`${flagName} must be a JSON object`);
  }
  return parsed;
}

export function defaultStepId(preset, now = Date.now()) {
  return `probe-${preset}-${now.toString(36)}`;
}

export function resolveProbeRequest({
  preset,
  stepId,
  targetId = DEFAULTS.targetId,
  callee = DEFAULTS.callee,
  method,
  argsJson,
  innerGasTgas,
  policy,
}) {
  if (preset === "raw") {
    if (!method) {
      throw new Error("raw preset requires --method");
    }
    if (!argsJson) {
      throw new Error("raw preset requires --args-json");
    }
    const request = {
      preset,
      stepId,
      targetId,
      methodName: method,
      args: parseJsonObject(argsJson, "--args-json"),
      innerGasTgas: innerGasTgas ?? DEFAULTS.defaultInnerGasTgas,
      description:
        "Raw Direct probe: invoke one explicit downstream method and inspect the callback-visible completion surface without adapter help.",
      expectation:
        "Interpret the result according to the specific downstream method's completion surface.",
    };
    if (policy !== undefined) {
      request.policy = policy;
    }
    return request;
  }

  const definition = PRESET_DEFINITIONS[preset];
  if (!definition) {
    throw new Error(
      `unknown preset '${preset}' (expected one of: ${[
        ...Object.keys(PRESET_DEFINITIONS),
        "raw",
      ].join(", ")})`
    );
  }

  const request = {
    preset,
    stepId,
    targetId,
    methodName: definition.methodName,
    args: definition.buildArgs({ stepId, callee }),
    innerGasTgas: innerGasTgas ?? DEFAULTS.defaultInnerGasTgas,
    description: definition.description,
    expectation: definition.expectation,
  };
  if (policy !== undefined) {
    request.policy = policy;
  }
  return request;
}

function renderInlineJson(value) {
  return JSON.stringify(value);
}

function renderStateSnapshot(snapshot) {
  if (!snapshot?.available) {
    return "unavailable";
  }
  return `calls_completed=${snapshot.calls_completed} last_burst=${JSON.stringify(snapshot.last_burst)}`;
}

function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

export function buildProbeCommands({
  network,
  signer,
  contractId,
  targetId,
  registerTxHash,
  runTxHash,
}) {
  const networkFlag = ` --network ${network}`;
  const callsCompletedView = JSON.stringify({
    account: targetId,
    method: "get_calls_completed",
    args: {},
  });
  const lastBurstView = JSON.stringify({
    account: targetId,
    method: "get_last_burst",
    args: {},
  });

  return {
    trace_register: `./scripts/trace-tx.mjs ${registerTxHash} ${signer} --wait FINAL${networkFlag}`,
    trace_run: `./scripts/trace-tx.mjs ${runTxHash} ${signer} --wait FINAL${networkFlag}`,
    investigate_register:
      `./scripts/investigate-tx.mjs ${registerTxHash} ${signer} --wait FINAL${networkFlag} ` +
      `--accounts ${contractId},${targetId} --view '${callsCompletedView}' --view '${lastBurstView}'`,
    state_calls_completed: `./scripts/state.mjs ${targetId} --method get_calls_completed${networkFlag}`,
    state_last_burst: `./scripts/state.mjs ${targetId} --method get_last_burst${networkFlag}`,
  };
}

export function renderHumanReport(report) {
  const lines = [];
  lines.push(`preset=${report.preset}`);
  lines.push(`probe=${report.description}`);
  lines.push(
    `downstream=${report.target_id}.${report.method_name}(${renderInlineJson(report.args)})`
  );
  lines.push(`expectation=${report.expectation}`);
  lines.push(`state_before=${renderStateSnapshot(report.state_before)}`);
  lines.push(`register_tx=${report.register_tx_hash}`);
  lines.push(`run_tx=${report.run_tx_hash}`);
  lines.push(`state_after=${renderStateSnapshot(report.state_after)}`);
  lines.push(`trace(register): ${report.commands.trace_register}`);
  lines.push(`trace(run): ${report.commands.trace_run}`);
  lines.push(`investigate(register): ${report.commands.investigate_register}`);
  lines.push(`state(calls_completed): ${report.commands.state_calls_completed}`);
  lines.push(`state(last_burst): ${report.commands.state_last_burst}`);
  lines.push(
    `short=register:${shortHash(report.register_tx_hash)} run:${shortHash(report.run_tx_hash)}`
  );
  return lines.join("\n");
}

async function readPathologicalState(network, targetId) {
  try {
    const [callsCompleted, lastBurst] = await Promise.all([
      withTimeout(
        callViewMethod(network, targetId, "get_calls_completed", {}),
        DEFAULTS.viewTimeoutMs,
        `${targetId}.get_calls_completed`
      ),
      withTimeout(
        callViewMethod(network, targetId, "get_last_burst", {}),
        DEFAULTS.viewTimeoutMs,
        `${targetId}.get_last_burst`
      ),
    ]);
    return {
      available: true,
      calls_completed: callsCompleted.value,
      last_burst: lastBurst.value,
      block_height: callsCompleted.block_height,
      block_hash: callsCompleted.block_hash,
    };
  } catch (error) {
    return {
      available: false,
      error: String(error),
    };
  }
}

function stateSnapshotChanged(before, after) {
  if (!before?.available || !after?.available) {
    return false;
  }
  return (
    before.calls_completed !== after.calls_completed ||
    JSON.stringify(before.last_burst) !== JSON.stringify(after.last_burst)
  );
}

async function waitForPathologicalStateChange({
  network,
  targetId,
  before,
  pollMs = DEFAULTS.pollMs,
  timeoutMs = DEFAULTS.postRunObserveMs,
}) {
  let latest = await readPathologicalState(network, targetId);
  if (stateSnapshotChanged(before, latest)) {
    return latest;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    latest = await readPathologicalState(network, targetId);
    if (stateSnapshotChanged(before, latest)) {
      return latest;
    }
  }
  return latest;
}

async function waitForRegisteredStep({
  network,
  contractId,
  callerId,
  stepId,
  pollMs = DEFAULTS.pollMs,
  timeoutMs = DEFAULTS.stepRegisterTimeoutMs,
}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;

  while (Date.now() < deadline) {
    try {
      const view = await withTimeout(
        callViewMethod(
          network,
          contractId,
          "registered_steps_for",
          { caller_id: callerId }
        ),
        DEFAULTS.viewTimeoutMs,
        `${contractId}.registered_steps_for`
      );
      const registeredSteps = Array.isArray(view.value) ? view.value : [];
      last = {
        block_height: view.block_height,
        block_hash: view.block_hash,
        registered_steps: registeredSteps,
      };
      if (registeredSteps.some((call) => call.step_id === stepId)) {
        return {
          ready: true,
          ...last,
        };
      }
    } catch (error) {
      last = {
        block_height: last?.block_height ?? null,
        block_hash: last?.block_hash ?? null,
        registered_steps: last?.registered_steps ?? [],
        poll_error: String(error),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  return {
    ready: false,
    ...(last || { block_height: null, block_hash: null, registered_steps: [] }),
  };
}

function registerActionForRequest(nearApi, request, actionGasTgas) {
  const payload = {
    target_id: request.targetId,
    method_name: request.methodName,
    args: Buffer.from(JSON.stringify(request.args)).toString("base64"),
    attached_deposit_yocto: "0",
    gas_tgas: request.innerGasTgas,
    step_id: request.stepId,
  };
  if (request.policy !== undefined) {
    payload.policy = request.policy;
  }
  return nearApi.transactions.functionCall(
    "register_step",
    Buffer.from(JSON.stringify(payload)),
    BigInt(actionGasTgas) * 10n ** 12n,
    0n
  );
}

function runActionForRequest(signer, stepId, runGasTgas) {
  return {
    methodName: "run_sequence",
    args: { caller_id: signer, order: [stepId] },
    gasTgas: runGasTgas,
  };
}

async function sendTransactionAsync(account, receiverId, actions) {
  const [, signedTransaction] = await account.signTransaction(receiverId, actions);
  const txHash = await account.connection.provider.sendTransactionAsync(signedTransaction);
  return {
    txHash,
    receiverId,
  };
}

function parseTxHashFromNearCli(output) {
  const match = output.match(/Transaction Id\s+([A-Za-z0-9]+)/);
  if (!match) {
    throw new Error(`could not find transaction hash in near CLI output:\n${output}`);
  }
  return match[1];
}

async function callContractViaNearCli({ network, signer, contractId, methodName, args, gasTgas }) {
  const gas = (BigInt(gasTgas) * 10n ** 12n).toString();
  const cliArgs = [
    "call",
    contractId,
    methodName,
    JSON.stringify(args),
    "--accountId",
    signer,
    "--gas",
    gas,
    "--networkId",
    network,
  ];

  try {
    const { stdout, stderr } = await execFileAsync("near", cliArgs, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NEAR_ENV: network,
      },
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      txHash: parseTxHashFromNearCli(`${stdout}\n${stderr}`),
      stdout,
      stderr,
    };
  } catch (error) {
    const stdout = error.stdout || "";
    const stderr = error.stderr || "";
    throw new Error(
      [
        `near call ${contractId}.${methodName} failed`,
        stdout && `stdout:\n${stdout.trimEnd()}`,
        stderr && `stderr:\n${stderr.trimEnd()}`,
      ]
        .filter(Boolean)
        .join("\n\n")
    );
  }
}

async function runProbe(options) {
  const { nearApi, accounts } = await connectNearWithSigners(options.network, [options.signer]);
  const account = accounts[options.signer];
  const stateBefore = await readPathologicalState(options.network, options.targetId);

  const registerResult = await sendTransactionAsync(account, options.contractId, [
    registerActionForRequest(nearApi, options.request, options.actionGasTgas),
  ]);
  const registerTxHash = registerResult.txHash;

  const registered = await waitForRegisteredStep({
    network: options.network,
    contractId: options.contractId,
    callerId: options.signer,
    stepId: options.request.stepId,
  });
  if (!registered.ready) {
    throw new Error(
      `registered step '${options.request.stepId}' did not materialize within ${DEFAULTS.stepRegisterTimeoutMs} ms after register tx ${registerTxHash}`
    );
  }

  const runAction = runActionForRequest(
    options.signer,
    options.request.stepId,
    options.runGasTgas
  );
  const runResult = await callContractViaNearCli({
    network: options.network,
    signer: options.signer,
    contractId: options.contractId,
    methodName: runAction.methodName,
    args: runAction.args,
    gasTgas: runAction.gasTgas,
  });

  const stateAfter = await waitForPathologicalStateChange({
    network: options.network,
    targetId: options.targetId,
    before: stateBefore,
  });
  const runTxHash = runResult.txHash;
  const commands = buildProbeCommands({
    network: options.network,
    signer: options.signer,
    contractId: options.contractId,
    targetId: options.targetId,
    registerTxHash,
    runTxHash,
  });

  return {
    preset: options.request.preset,
    network: options.network,
    signer: options.signer,
    contract_id: options.contractId,
    target_id: options.targetId,
    step_id: options.request.stepId,
    method_name: options.request.methodName,
    args: options.request.args,
    policy: options.request.policy ?? null,
    description: options.request.description,
    expectation: options.request.expectation,
    state_before: stateBefore,
    registered_step_visible: {
      block_height: registered.block_height,
      block_hash: registered.block_hash,
      count: registered.registered_steps.length,
    },
    register_tx_hash: registerTxHash,
    run_tx_hash: runTxHash,
    run_status: null,
    state_after: stateAfter,
    commands,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      network: { type: "string", default: DEFAULTS.network },
      signer: { type: "string", default: DEFAULTS.signer },
      contract: { type: "string", default: DEFAULTS.contractId },
      target: { type: "string", default: DEFAULTS.targetId },
      "step-id": { type: "string" },
      "inner-gas": { type: "string" },
      "action-gas": { type: "string", default: String(DEFAULTS.actionGasTgas) },
      "run-gas": { type: "string", default: String(DEFAULTS.runGasTgas) },
      callee: { type: "string", default: DEFAULTS.callee },
      method: { type: "string" },
      "args-json": { type: "string" },
      "policy-json": { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const preset = positionals[0];
  if (!preset) {
    console.error(
      "usage: scripts/probe-pathological.mjs <preset> [--network testnet] [--signer x.mike.testnet] [--contract smart-account.x.mike.testnet] [--target pathological-router.x.mike.testnet] [--step-id probe-...] [--inner-gas 100] [--action-gas 250] [--run-gas 300] [--callee echo.x.mike.testnet] [--json]"
    );
    console.error(
      "presets: control, gas_exhaustion, false_success, decoy_returned_chain, oversized_result, raw"
    );
    console.error("raw also requires: --method <method_name> --args-json '{...}'");
    process.exit(1);
  }

  const actionGasTgas = Number(values["action-gas"]);
  const runGasTgas = Number(values["run-gas"]);
  const innerGasTgas =
    values["inner-gas"] != null ? Number(values["inner-gas"]) : undefined;
  if (!Number.isFinite(actionGasTgas) || actionGasTgas <= 0) {
    throw new Error("--action-gas must be a positive number");
  }
  if (!Number.isFinite(runGasTgas) || runGasTgas <= 0) {
    throw new Error("--run-gas must be a positive number");
  }
  if (
    values["inner-gas"] != null &&
    (!Number.isFinite(innerGasTgas) || innerGasTgas <= 0)
  ) {
    throw new Error("--inner-gas must be a positive number");
  }

  const stepId = values["step-id"] || defaultStepId(preset);
  let policy;
  if (values["policy-json"] != null) {
    policy = parseJsonObject(values["policy-json"], "--policy-json");
  }
  const request = resolveProbeRequest({
    preset,
    stepId,
    targetId: values.target,
    callee: values.callee,
    method: values.method,
    argsJson: values["args-json"],
    innerGasTgas,
    policy,
  });

  const report = await runProbe({
    network: values.network,
    signer: values.signer,
    contractId: values.contract,
    targetId: values.target,
    actionGasTgas,
    runGasTgas,
    request,
  });

  if (values.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${renderHumanReport(report)}\n`);
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}

if (isMainModule()) {
  await main();
}
