#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { decodeSuccessValue, REPO_ROOT, shortHash } from "./lib/fastnear.mjs";
import {
  buildTxArtifact,
  connectNearWithSigners,
  sendFunctionCall,
} from "./lib/near-cli.mjs";

const { values, positionals } = parseArgs({
  options: {
    network: { type: "string", default: "testnet" },
    mode: { type: "string", default: "direct" },
    contract: { type: "string", default: "smart-account.x.mike.testnet" },
    router: { type: "string", default: "router.x.mike.testnet" },
    "wild-router": { type: "string", default: "wild-router.x.mike.testnet" },
    adapter: { type: "string", default: "demo-adapter.x.mike.testnet" },
    "adapter-method": {
      type: "string",
      default: "adapt_fire_and_forget_route_echo",
    },
    echo: { type: "string", default: "echo.x.mike.testnet" },
    "owner-signer": { type: "string", default: "x.mike.testnet" },
    "executor-signer": { type: "string" },
    "runner-signer": { type: "string" },
    "owner-gas": { type: "string", default: "100" },
    "execute-gas": { type: "string", default: "200" },
    "call-gas": { type: "string", default: "40" },
    "min-balance-yocto": {
      type: "string",
      default: "1000000000000000000000000",
    },
    "max-runs": { type: "string", default: "3" },
    "sequence-id": { type: "string" },
    "trigger-id": { type: "string" },
    "artifacts-file": { type: "string" },
    dry: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
  allowPositionals: true,
});

const specs = (positionals.length ? positionals : ["alpha:1", "beta:2", "gamma:3"]).map(
  parseSpec
);
assertUniqueStepIds(specs.map((spec) => spec.step_id), "submitted actions");
const ownerGasTgas = parsePositiveInt(values["owner-gas"], "--owner-gas");
const executeGasTgas = parsePositiveInt(values["execute-gas"], "--execute-gas");
const callGasTgas = parsePositiveInt(values["call-gas"], "--call-gas");
const maxRuns = parsePositiveInt(values["max-runs"], "--max-runs");
const minBalanceYocto = parseNonNegativeBigInt(
  values["min-balance-yocto"],
  "--min-balance-yocto"
);
const executorSigner =
  values["executor-signer"] || values["runner-signer"] || values["owner-signer"];
const idSuffix = Date.now().toString(36);
const sequenceId = values["sequence-id"] || `router-seq-${idSuffix}`;
const triggerId = values["trigger-id"] || `balance-trigger-${idSuffix}`;
const artifactsFile =
  values["artifacts-file"] || defaultArtifactsFile(sequenceId, triggerId);
const mode = parseMode(values.mode);
const sequenceCalls = specs.map(({ step_id, n }, index) =>
  buildSequenceCall(mode, values, step_id, n, index, callGasTgas)
);

const preview = {
  network: values.network,
  mode,
  contract: values.contract,
  router: values.router,
  wild_router: values["wild-router"],
  adapter: values.adapter,
  adapter_method: values["adapter-method"],
  echo: values.echo,
  owner_signer: values["owner-signer"],
  executor_signer: executorSigner,
  sequence_id: sequenceId,
  trigger_id: triggerId,
  owner_gas_tgas: ownerGasTgas,
  execute_gas_tgas: executeGasTgas,
  call_gas_tgas: callGasTgas,
  min_balance_yocto: minBalanceYocto.toString(),
  max_runs: maxRuns,
  calls: sequenceCalls.map((call, index) => ({
    order: index,
    step_id: call.step_id,
    policy: policyLabel(call),
    route: describeCall(values, call, specs[index].n),
  })),
  artifacts_file: artifactsFile,
};

if (values.dry) {
  console.log(JSON.stringify(preview, null, 2));
  process.exit(0);
}

const { nearApi, accounts } = await connectNearWithSigners(values.network, [
  values["owner-signer"],
  executorSigner,
]);
const ownerAccount = accounts[values["owner-signer"]];
const executorAccount = accounts[executorSigner];

const saveTemplate = await sendFunctionCall(
  nearApi,
  ownerAccount,
  values.contract,
  "save_sequence_template",
  {
    sequence_id: sequenceId,
    calls: sequenceCalls,
  },
  ownerGasTgas
);
const createTrigger = await sendFunctionCall(
  nearApi,
  ownerAccount,
  values.contract,
  "create_balance_trigger",
  {
    trigger_id: triggerId,
    sequence_id: sequenceId,
    min_balance_yocto: minBalanceYocto.toString(),
    max_runs: maxRuns,
  },
  ownerGasTgas
);
const executeTrigger = await sendFunctionCall(
  nearApi,
  executorAccount,
  values.contract,
  "execute_trigger",
  {
    trigger_id: triggerId,
  },
  executeGasTgas
);

const saveTemplateStatus = decodeSuccessValue(saveTemplate.status?.SuccessValue) || null;
const createTriggerStatus = decodeSuccessValue(createTrigger.status?.SuccessValue) || null;
const executeTriggerStatus = decodeSuccessValue(executeTrigger.status?.SuccessValue) || null;

const artifacts = {
  generated_at: new Date().toISOString(),
  ...preview,
  sequence_template_view: saveTemplateStatus,
  balance_trigger_view: createTriggerStatus,
  execution_view: executeTriggerStatus,
  txs: [
    await buildTxArtifact(values.network, saveTemplate, values["owner-signer"], "save_sequence_template"),
    await buildTxArtifact(
      values.network,
      createTrigger,
      values["owner-signer"],
      "create_balance_trigger"
    ),
    await buildTxArtifact(
      values.network,
      executeTrigger,
      executorSigner,
      "execute_trigger"
    ),
  ],
};

fs.mkdirSync(path.dirname(artifactsFile), { recursive: true });
fs.writeFileSync(artifactsFile, `${JSON.stringify(artifacts, null, 2)}\n`);

if (values.json) {
  console.log(JSON.stringify(artifacts, null, 2));
  process.exit(0);
}

for (const tx of artifacts.txs) {
  console.log(
    `${tx.step}: tx_hash=${tx.tx_hash} block_height=${tx.block_height ?? "?"} signer=${tx.signer}`
  );
}
console.log(`sequence_id=${sequenceId}`);
console.log(`trigger_id=${triggerId}`);
if (executeTriggerStatus?.sequence_namespace) {
  console.log(`sequence_namespace=${executeTriggerStatus.sequence_namespace}`);
}
console.log(`artifacts=${artifactsFile}`);
for (const tx of artifacts.txs) {
  console.log(`trace(${tx.step}): ./scripts/trace-tx.mjs ${tx.tx_hash} ${tx.signer} --wait FINAL`);
}
console.log(
  `trigger_state: ./scripts/state.mjs ${values.contract} --method get_balance_trigger --args '${JSON.stringify({ trigger_id: triggerId })}'`
);
console.log(
  `short=${artifacts.txs.map((tx) => `${tx.step}:${shortHash(tx.tx_hash)}`).join(" ")}`
);

function parseSpec(raw) {
  const idx = raw.indexOf(":");
  if (idx <= 0 || idx === raw.length - 1) {
    throw new Error(`invalid action spec '${raw}' (expected step_id:number)`);
  }
  const step_id = raw.slice(0, idx);
  const n = Number(raw.slice(idx + 1));
  if (!Number.isInteger(n)) {
    throw new Error(`invalid numeric payload in '${raw}'`);
  }
  return { step_id, n };
}

function parseMode(raw) {
  if (raw === "direct" || raw === "adapter" || raw === "mixed") {
    return raw;
  }
  throw new Error(`invalid --mode '${raw}' (expected direct, adapter, or mixed)`);
}

function assertUniqueStepIds(stepIds, context) {
  if (new Set(stepIds).size !== stepIds.length) {
    throw new Error(`${context} contain duplicate step IDs`);
  }
}

function buildSequenceCall(mode, values, step_id, n, index, callGasTgas) {
  const adapterWrapped = mode === "adapter" || (mode === "mixed" && index % 2 === 1);
  if (adapterWrapped) {
    return {
      step_id,
      target_id: values["wild-router"],
      method_name: "route_echo_fire_and_forget",
      args: Buffer.from(
        JSON.stringify({
          callee: values.echo,
          n,
        })
      ).toString("base64"),
      attached_deposit_yocto: "0",
      gas_tgas: callGasTgas,
      settle_policy: {
        Adapter: {
          adapter_id: values.adapter,
          adapter_method: values["adapter-method"],
        },
      },
    };
  }

  return {
    step_id,
    target_id: values.router,
    method_name: "route_echo",
    args: Buffer.from(
      JSON.stringify({
        callee: values.echo,
        n,
      })
    ).toString("base64"),
    attached_deposit_yocto: "0",
    gas_tgas: callGasTgas,
  };
}

function policyLabel(call) {
  const settlePolicy = call.settle_policy;
  if (!settlePolicy) {
    return "Direct";
  }
  if (settlePolicy.Adapter) {
    return `Adapter via ${settlePolicy.Adapter.adapter_id}.${settlePolicy.Adapter.adapter_method}`;
  }
  return "Direct";
}

function describeCall(values, call, n) {
  if (call.settle_policy?.Adapter) {
    return `${values.adapter}.${values["adapter-method"]}({ target: ${values["wild-router"]}.route_echo_fire_and_forget({ callee: ${values.echo}, n: ${n} }) })`;
  }
  return `${values.router}.route_echo({ callee: ${values.echo}, n: ${n} })`;
}

function parsePositiveInt(raw, flag) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return value;
}

function parseNonNegativeBigInt(raw, flag) {
  const value = BigInt(raw);
  if (value < 0n) {
    throw new Error(`${flag} must be zero or greater`);
  }
  return value;
}

function defaultArtifactsFile(sequenceId, triggerId) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(
    REPO_ROOT,
    "collab",
    "artifacts",
    `${stamp}-${sequenceId}-${triggerId}.json`
  );
}
