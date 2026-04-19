#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import {
  decodeSuccessValue,
  REPO_ROOT,
  shortHash,
} from "../lib/fastnear.mjs";
import {
  buildTxArtifact,
  callView,
  connectNearWithSigners,
  sendFunctionCall,
} from "../lib/near-cli.mjs";

const WRAP_STORAGE_DEPOSIT_YOCTO = 1_250_000_000_000_000_000_000n;
const FT_TRANSFER_DEPOSIT_YOCTO = 1n;
const YOCTO_PER_NEAR = 10n ** 24n;

const { values, positionals } = parseArgs({
  options: {
    network: { type: "string", default: "testnet" },
    mode: { type: "string", default: "mixed" },
    contract: { type: "string", default: "smart-account.x.mike.testnet" },
    wrap: { type: "string", default: "wrap.testnet" },
    adapter: { type: "string", default: "compat-adapter.x.mike.testnet" },
    "adapter-method": {
      type: "string",
      default: "adapt_wrap_near_deposit_then_transfer",
    },
    "owner-signer": { type: "string", default: "x.mike.testnet" },
    "executor-signer": { type: "string" },
    "owner-gas": { type: "string", default: "120" },
    "execute-gas": { type: "string", default: "800" },
    "storage-gas": { type: "string", default: "50" },
    "call-gas": { type: "string", default: "40" },
    "min-balance-yocto": { type: "string", default: "0" },
    "max-runs": { type: "string", default: "1" },
    "sequence-id": { type: "string" },
    "trigger-id": { type: "string" },
    "artifacts-file": { type: "string" },
    "prepare-adapter": { type: "boolean", default: true },
    dry: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
  allowPositionals: true,
});

const specs = (positionals.length ? positionals : ["alpha:0.01", "beta:0.02"]).map(parseSpec);
assertUniqueStepIds(specs.map((spec) => spec.step_id), "submitted actions");
const ownerGasTgas = parsePositiveInt(values["owner-gas"], "--owner-gas");
const executeGasTgas = parsePositiveInt(values["execute-gas"], "--execute-gas");
const storageGasTgas = parsePositiveInt(values["storage-gas"], "--storage-gas");
const callGasTgas = parsePositiveInt(values["call-gas"], "--call-gas");
const maxRuns = parsePositiveInt(values["max-runs"], "--max-runs");
const minBalanceYocto = parseNonNegativeBigInt(
  values["min-balance-yocto"],
  "--min-balance-yocto"
);
const mode = parseMode(values.mode);
const executorSigner = values["executor-signer"] || values["owner-signer"];
const idSuffix = Date.now().toString(36);
const sequenceId = values["sequence-id"] || `wrap-seq-${idSuffix}`;
const triggerId = values["trigger-id"] || `balance-trigger-${idSuffix}`;
const artifactsFile =
  values["artifacts-file"] || defaultArtifactsFile(sequenceId, triggerId);
const registerCall = buildRegisterCall(values.contract, values.wrap, storageGasTgas);
const depositCalls = specs.map(({ step_id, amountNear, amountYocto }, index) =>
  buildDepositCall(mode, values, step_id, amountNear, amountYocto, index, callGasTgas)
);
const sequenceCalls = [registerCall, ...depositCalls];

const preview = {
  network: values.network,
  mode,
  contract: values.contract,
  wrap: values.wrap,
  adapter: values.adapter,
  adapter_method: values["adapter-method"],
  owner_signer: values["owner-signer"],
  executor_signer: executorSigner,
  sequence_id: sequenceId,
  trigger_id: triggerId,
  owner_gas_tgas: ownerGasTgas,
  execute_gas_tgas: executeGasTgas,
  storage_gas_tgas: storageGasTgas,
  call_gas_tgas: callGasTgas,
  min_balance_yocto: minBalanceYocto.toString(),
  max_runs: maxRuns,
  prepare_adapter: values["prepare-adapter"] && modeUsesAdapter(mode),
  calls: [
    {
      order: 0,
      step_id: registerCall.step_id,
      policy: "Direct",
      route: `${values.wrap}.storage_deposit({ account_id: ${values.contract}, registration_only: true })`,
      attached_deposit_yocto: registerCall.attached_deposit_yocto,
    },
    ...depositCalls.map((call, index) => ({
      order: index + 1,
      step_id: call.step_id,
      policy: policyLabel(call),
      route: describeCall(values, call, specs[index]),
      attached_deposit_yocto: call.attached_deposit_yocto,
    })),
  ],
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
const smartWrapBalanceBefore = await callView(values.network, values.wrap, "ft_balance_of", {
  account_id: values.contract,
});
const adapterWrapBalanceBefore = await callView(values.network, values.wrap, "ft_balance_of", {
  account_id: values.adapter,
});

const adapterPreparation = values["prepare-adapter"] && modeUsesAdapter(mode)
  ? await ensureAdapterWrapRegistration(
      values.network,
      nearApi,
      ownerAccount,
      values.wrap,
      values.adapter,
      ownerGasTgas
    )
  : {
      needed: false,
      already_registered: false,
      skipped: true,
    };

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
const smartWrapBalanceAfter = await callView(values.network, values.wrap, "ft_balance_of", {
  account_id: values.contract,
});
const adapterWrapBalanceAfter = await callView(values.network, values.wrap, "ft_balance_of", {
  account_id: values.adapter,
});

const txs = [];
if (adapterPreparation.tx) {
  txs.push(adapterPreparation.tx);
}
txs.push(
  await buildTxArtifact(values.network, saveTemplate, values["owner-signer"], "save_sequence_template")
);
txs.push(
  await buildTxArtifact(values.network, createTrigger, values["owner-signer"], "create_balance_trigger")
);
txs.push(
  await buildTxArtifact(values.network, executeTrigger, executorSigner, "execute_trigger")
);

const artifacts = {
  generated_at: new Date().toISOString(),
  ...preview,
  adapter_preparation: adapterPreparation,
  sequence_template_view: saveTemplateStatus,
  balance_trigger_view: createTriggerStatus,
  execution_view: executeTriggerStatus,
  wrap_balances_before: {
    [values.contract]: smartWrapBalanceBefore,
    [values.adapter]: adapterWrapBalanceBefore,
  },
  wrap_balances_after: {
    [values.contract]: smartWrapBalanceAfter,
    [values.adapter]: adapterWrapBalanceAfter,
  },
  txs,
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
console.log(`wnear_balance_before(${values.contract})=${smartWrapBalanceBefore}`);
console.log(`wnear_balance_before(${values.adapter})=${adapterWrapBalanceBefore}`);
console.log(`wnear_balance(${values.contract})=${smartWrapBalanceAfter}`);
console.log(`wnear_balance(${values.adapter})=${adapterWrapBalanceAfter}`);
console.log(`artifacts=${artifactsFile}`);
for (const tx of artifacts.txs) {
  console.log(`trace(${tx.step}): ./scripts/trace-tx.mjs ${tx.tx_hash} ${tx.signer} --wait FINAL`);
}
console.log(
  `trigger_state: ./scripts/state.mjs ${values.contract} --method get_balance_trigger --args '${JSON.stringify({ trigger_id: triggerId })}'`
);
console.log(
  `wrap_balance: ./scripts/state.mjs ${values.wrap} --method ft_balance_of --args '${JSON.stringify({ account_id: values.contract })}'`
);
console.log(
  `short=${artifacts.txs.map((tx) => `${tx.step}:${shortHash(tx.tx_hash)}`).join(" ")}`
);

function parseSpec(raw) {
  const idx = raw.indexOf(":");
  if (idx <= 0 || idx === raw.length - 1) {
    throw new Error(`invalid action spec '${raw}' (expected step_id:near-amount)`);
  }
  const step_id = raw.slice(0, idx);
  if (step_id === "register") {
    throw new Error(`'register' is reserved for the wrap storage step`);
  }
  const amountNear = raw.slice(idx + 1);
  return {
    step_id,
    amountNear,
    amountYocto: parseNearAmount(amountNear),
  };
}

function parseMode(raw) {
  if (raw === "direct" || raw === "adapter" || raw === "mixed") {
    return raw;
  }
  throw new Error(`invalid --mode '${raw}' (expected direct, adapter, or mixed)`);
}

function modeUsesAdapter(mode) {
  return mode === "adapter" || mode === "mixed";
}

function assertUniqueStepIds(stepIds, context) {
  if (new Set(stepIds).size !== stepIds.length) {
    throw new Error(`${context} contain duplicate step IDs`);
  }
}

function buildRegisterCall(contractId, wrapId, storageGasTgas) {
  return {
    step_id: "register",
    target_id: wrapId,
    method_name: "storage_deposit",
    args: Buffer.from(
      JSON.stringify({
        account_id: contractId,
        registration_only: true,
      })
    ).toString("base64"),
    attached_deposit_yocto: WRAP_STORAGE_DEPOSIT_YOCTO.toString(),
    gas_tgas: storageGasTgas,
  };
}

function buildDepositCall(mode, values, step_id, amountNear, amountYocto, index, callGasTgas) {
  const adapterWrapped = mode === "adapter" || (mode === "mixed" && index % 2 === 1);
  const argsBase64 = Buffer.from(JSON.stringify({})).toString("base64");
  if (adapterWrapped) {
    return {
      step_id,
      target_id: values.wrap,
      method_name: "near_deposit",
      args: argsBase64,
      attached_deposit_yocto: (amountYocto + FT_TRANSFER_DEPOSIT_YOCTO).toString(),
      gas_tgas: callGasTgas,
      policy: {
        Adapter: {
          adapter_id: values.adapter,
          adapter_method: values["adapter-method"],
        },
      },
    };
  }

  return {
    step_id,
    target_id: values.wrap,
    method_name: "near_deposit",
    args: argsBase64,
    attached_deposit_yocto: amountYocto.toString(),
    gas_tgas: callGasTgas,
  };
}

function policyLabel(call) {
  const policy = call.policy;
  if (!policy) return "Direct";
  if (policy.Adapter) {
    return `Adapter via ${policy.Adapter.adapter_id}.${policy.Adapter.adapter_method}`;
  }
  return "Direct";
}

function describeCall(values, call, spec) {
  if (call.policy?.Adapter) {
    return `${values.adapter}.${values["adapter-method"]}({ target: ${values.wrap}.near_deposit(), beneficiary: predecessor=${values.contract}, amount: ${spec.amountNear} wNEAR })`;
  }
  return `${values.wrap}.near_deposit({}) -> ${spec.amountNear} wNEAR to predecessor=${values.contract}`;
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

function parseNearAmount(raw) {
  const value = String(raw).trim();
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new Error(`invalid NEAR amount '${raw}'`);
  }
  const [wholePart, fracPart = ""] = value.split(".");
  if (fracPart.length > 24) {
    throw new Error(`NEAR amount '${raw}' has more than 24 decimal places`);
  }
  const whole = BigInt(wholePart);
  const frac = BigInt((fracPart + "0".repeat(24)).slice(0, 24));
  return whole * YOCTO_PER_NEAR + frac;
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

async function ensureAdapterWrapRegistration(
  network,
  nearApi,
  ownerAccount,
  wrapId,
  adapterId,
  ownerGasTgas
) {
  const before = await callView(network, wrapId, "storage_balance_of", {
    account_id: adapterId,
  });
  if (before) {
    return {
      needed: false,
      already_registered: true,
      storage_balance_before: before,
    };
  }

  const result = await sendFunctionCall(
    nearApi,
    ownerAccount,
    wrapId,
    "storage_deposit",
    {
      account_id: adapterId,
      registration_only: true,
    },
    ownerGasTgas,
    WRAP_STORAGE_DEPOSIT_YOCTO
  );
  const tx = await buildTxArtifact(
    network,
    result,
    ownerAccount.accountId,
    "prepare_adapter_wrap_registration"
  );
  const after = await callView(network, wrapId, "storage_balance_of", {
    account_id: adapterId,
  });
  return {
    needed: true,
    already_registered: false,
    storage_balance_after: after,
    tx,
  };
}
