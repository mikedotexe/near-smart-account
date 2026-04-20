#!/usr/bin/env node
//
// social-stamp-profile.mjs — have the simple-sequencer introduce itself on
// near.social using its own sequencer.
//
// Registers one `social.near.set(...)` call that writes
// `<sequencer>/profile/name` and `<sequencer>/profile/description`
// (optionally `<sequencer>/profile/image.url`), then runs `run_sequence`
// with a single-step order. The result is a one-tx register + one-tx release
// that makes `https://near.social/<sequencer>` render with identity
// instead of an empty page.
//
// This is deliberately a separate helper from `send-social-poem.mjs`:
// that script stays a clean three-step sequencer proof, this one handles
// the once-per-account profile stamp.
//
// Before the first run, pre-fund the sequencer's storage on social:
//
//   ./simple-example/scripts/social-storage-deposit.mjs \
//     --network mainnet \
//     --signer mike.near \
//     --sequencer simple-sequencer.sa-lab.mike.near \
//     --amount-near 0.1

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import {
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
import {
  fetchTraceBlockMetadata,
  flattenReceiptTree,
  traceTx,
} from "../../scripts/lib/trace-rpc.mjs";
import {
  diagnoseRegisterTransaction,
  renderStepOutcomeSummary,
} from "../../scripts/lib/step-sequence.mjs";

const DEFAULT_SOCIAL_BY_NETWORK = {
  mainnet: "social.near",
  testnet: "v1.social08.testnet",
};
const NEAR_SOCIAL_PROFILE_BASE = {
  mainnet: "https://near.social",
  testnet: "https://test.near.social",
};
const DEFAULT_PROFILE_NAME = "simple-sequencer lab";
const DEFAULT_PROFILE_DESCRIPTION =
  "Each post here is one step of a registered-step cascade on NEAR, released in a chosen order via NEP-519 yield/resume.";

const { values } = parseArgs({
  options: {
    network: { type: "string", default: "mainnet" },
    signer: { type: "string" },
    sequencer: { type: "string" },
    "social-account": { type: "string" },
    "profile-name": { type: "string" },
    "profile-description": { type: "string" },
    "profile-image-url": { type: "string" },
    "action-gas": { type: "string", default: "300" },
    "post-gas": { type: "string", default: "80" },
    "run-gas": { type: "string", default: "100" },
    "run-id": { type: "string" },
    "artifacts-file": { type: "string" },
    "poll-ms": { type: "string", default: "2000" },
    "step-register-timeout-ms": { type: "string", default: "30000" },
    "resolve-timeout-ms": { type: "string", default: "120000" },
    "skip-storage-check": { type: "boolean", default: false },
    dry: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (!values.signer) {
  throw new Error("--signer is required (e.g. --signer mike.near)");
}
if (!values.sequencer) {
  throw new Error(
    "--sequencer is required (e.g. --sequencer simple-sequencer.sa-lab.mike.near)"
  );
}

const network = values.network;
if (!DEFAULT_SOCIAL_BY_NETWORK[network]) {
  throw new Error(`unsupported --network '${network}' (expected mainnet or testnet)`);
}

const runId = values["run-id"] || Date.now().toString(36);
const stepId = `profile-stamp-${runId}`;
const socialAccount = values["social-account"] || DEFAULT_SOCIAL_BY_NETWORK[network];
const profileName = values["profile-name"] || DEFAULT_PROFILE_NAME;
const profileDescription = values["profile-description"] || DEFAULT_PROFILE_DESCRIPTION;
const profileImageUrl = values["profile-image-url"] || null;
const actionGasTgas = assertPositiveNumber(values["action-gas"], "--action-gas");
const postGasTgas = assertPositiveNumber(values["post-gas"], "--post-gas");
const runGasTgas = assertPositiveNumber(values["run-gas"], "--run-gas");
const pollMs = assertPositiveNumber(values["poll-ms"], "--poll-ms");
const stepRegisterTimeoutMs = assertPositiveNumber(values["step-register-timeout-ms"], "--step-register-timeout-ms");
const resolveTimeoutMs = assertPositiveNumber(values["resolve-timeout-ms"], "--resolve-timeout-ms");

const feedUrl = `${NEAR_SOCIAL_PROFILE_BASE[network]}/${values.sequencer}`;
const artifactsFile =
  values["artifacts-file"] || defaultArtifactsFile({ signer: values.signer, runId });
const runSequenceArgs = { caller_id: values.signer, order: [stepId] };

getNetworkConfig(network);

const downstreamArgs = buildSocialProfileArgs({
  sequencerAccount: values.sequencer,
  name: profileName,
  description: profileDescription,
  imageUrl: profileImageUrl,
});

const stepPlan = [
  {
    step_id: stepId,
    target_id: socialAccount,
    method_name: "set",
    profile_name: profileName,
    profile_description: profileDescription,
    profile_image_url: profileImageUrl,
    downstream_args: downstreamArgs,
  },
];

if (values.dry) {
  console.log(
    JSON.stringify(
      {
        network,
        signer: values.signer,
        sequencer: values.sequencer,
        social_account: socialAccount,
        feed_url: feedUrl,
        run_id: runId,
        step_id: stepId,
        profile: {
          name: profileName,
          description: profileDescription,
          image_url: profileImageUrl,
        },
        action_gas_tgas: actionGasTgas,
        post_gas_tgas: postGasTgas,
        run_gas_tgas: runGasTgas,
        step_register_timeout_ms: stepRegisterTimeoutMs,
        resolve_timeout_ms: resolveTimeoutMs,
        poll_ms: pollMs,
        artifacts_file: artifactsFile,
        step_plan: stepPlan.map(({ downstream_args, ...rest }) => ({
          ...rest,
          downstream_args_preview: downstreamArgsPreview(downstream_args),
        })),
        run_sequence_args: runSequenceArgs,
        commands: commandSet({
          network,
          signer: values.signer,
          sequencer: values.sequencer,
          socialAccount,
          runSequenceArgs,
          registerTxHash: "<register_tx_hash>",
          runSequenceTxHash: "<run_sequence_tx_hash>",
        }),
      },
      null,
      2
    )
  );
  process.exit(0);
}

const { nearApi, accounts } = await connectNearWithSigners(network, [values.signer]);
const account = accounts[values.signer];

const storageBefore = values["skip-storage-check"]
  ? { skipped: true }
  : await verifyStorageBalance({
      network,
      socialAccount,
      sequencer: values.sequencer,
    });

const profileBefore = await readProfile({
  network,
  socialAccount,
  sequencer: values.sequencer,
});

const actions = [
  nearApi.transactions.functionCall(
    "register_step",
    Buffer.from(
      JSON.stringify({
        target_id: socialAccount,
        method_name: "set",
        args: Buffer.from(JSON.stringify(downstreamArgs)).toString("base64"),
        attached_deposit_yocto: "0",
        gas_tgas: postGasTgas,
        step_id: stepId,
      })
    ),
    BigInt(actionGasTgas) * 10n ** 12n,
    0n
  ),
];

const registerResult = await sendTransactionAsync(account, values.sequencer, actions);
const registerArtifact = await buildTxArtifact(network, registerResult, values.signer, "register_batch");
const registerDiagnosis = await diagnoseRegisterTransaction({
  network,
  txHash: registerArtifact.tx_hash,
  signer: values.signer,
  contractId: values.sequencer,
  expectedCount: 1,
  pollMs,
  timeoutMs: stepRegisterTimeoutMs,
});

if (registerDiagnosis.step_outcome.classification !== "pending_until_resume") {
  throw new Error(
    `register ${registerArtifact.tx_hash} did not remain pending: ${registerDiagnosis.step_outcome.classification}`
  );
}

const runResult = await sendFunctionCall(
  nearApi,
  account,
  values.sequencer,
  "run_sequence",
  runSequenceArgs,
  runGasTgas
);
const runArtifact = await buildTxArtifact(network, runResult, values.signer, "run_sequence");
const [registerTrace, runTrace] = await Promise.all([
  safeTrace(network, registerArtifact.tx_hash, values.signer),
  safeTrace(network, runArtifact.tx_hash, values.signer),
]);
const downstreamReceipt = await resolveDownstreamReceipt({
  network,
  registerTrace,
  socialAccount,
});
const profileAfter = await waitForProfile({
  network,
  socialAccount,
  sequencer: values.sequencer,
  expectedName: profileName,
  expectedDescription: profileDescription,
  expectedImageUrl: profileImageUrl,
  pollMs,
  timeoutMs: resolveTimeoutMs,
});

const finalCommands = commandSet({
  network,
  signer: values.signer,
  sequencer: values.sequencer,
  socialAccount,
  runSequenceArgs,
  registerTxHash: registerArtifact.tx_hash,
  runSequenceTxHash: runArtifact.tx_hash,
});

const artifacts = {
  generated_at: new Date().toISOString(),
  run_id: runId,
  network,
  signer: values.signer,
  sequencer: values.sequencer,
  social_account: socialAccount,
  feed_url: feedUrl,
  action_gas_tgas: actionGasTgas,
  post_gas_tgas: postGasTgas,
  run_gas_tgas: runGasTgas,
  step_id: stepId,
  profile: {
    name: profileName,
    description: profileDescription,
    image_url: profileImageUrl,
  },
  run_sequence_args: runSequenceArgs,
  storage_balance_before: storageBefore,
  profile_before: profileBefore,
  register_primary_forensics: {
    tx_hash: registerArtifact.tx_hash,
    signer: values.signer,
  },
  txs: [registerArtifact, runArtifact],
  registered_steps_before_release: registerDiagnosis.registered_state,
  step_outcome: registerDiagnosis.step_outcome,
  traces: {
    register_batch: summarizeTrace(registerTrace),
    run_sequence: summarizeTrace(runTrace),
  },
  downstream_social_receipt: downstreamReceipt,
  profile_after: profileAfter,
  commands: finalCommands,
  artifacts_file: artifactsFile,
};

writeArtifact(artifactsFile, artifacts);

if (values.json) {
  console.log(JSON.stringify(artifacts, null, 2));
  process.exit(0);
}

printSummary(artifacts);

function assertPositiveNumber(raw, label) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return n;
}

function buildSocialProfileArgs({ sequencerAccount, name, description, imageUrl }) {
  const profile = { name, description };
  if (imageUrl) profile.image = { url: imageUrl };
  return {
    data: {
      [sequencerAccount]: {
        profile,
      },
    },
  };
}

function downstreamArgsPreview(argsObj) {
  return JSON.stringify(argsObj).slice(0, 240);
}

async function verifyStorageBalance({ network, socialAccount, sequencer }) {
  try {
    const { value } = await callViewMethod(network, socialAccount, "storage_balance_of", {
      account_id: sequencer,
    });
    if (!value || !value.total) {
      throw new Error(
        `${sequencer} has no storage balance on ${socialAccount}; run social-storage-deposit.mjs first`
      );
    }
    return { skipped: false, ...value };
  } catch (error) {
    throw new Error(
      `storage balance check failed for ${sequencer} on ${socialAccount}: ${error.message}`
    );
  }
}

async function readProfile({ network, socialAccount, sequencer }) {
  try {
    const { value, block_height, block_hash } = await callViewMethod(
      network,
      socialAccount,
      "get",
      { keys: [`${sequencer}/profile/**`] }
    );
    return {
      profile: extractProfile(value, sequencer),
      block_height,
      block_hash,
    };
  } catch (error) {
    return { profile: null, error: String(error) };
  }
}

function extractProfile(value, sequencer) {
  if (!value || typeof value !== "object") return null;
  const branch = value[sequencer]?.profile;
  return branch ?? null;
}

async function waitForProfile({
  network,
  socialAccount,
  sequencer,
  expectedName,
  expectedDescription,
  expectedImageUrl,
  pollMs,
  timeoutMs,
}) {
  const deadline = Date.now() + timeoutMs;
  let last = await readProfile({ network, socialAccount, sequencer });
  while (Date.now() < deadline) {
    if (profileMatches(last.profile, { expectedName, expectedDescription, expectedImageUrl })) break;
    await sleep(pollMs);
    last = await readProfile({ network, socialAccount, sequencer });
  }
  return {
    resolved: profileMatches(last.profile, { expectedName, expectedDescription, expectedImageUrl }),
    expected: {
      name: expectedName,
      description: expectedDescription,
      image_url: expectedImageUrl,
    },
    observed: last,
    poll_ms: pollMs,
    timeout_ms: timeoutMs,
  };
}

function profileMatches(observed, { expectedName, expectedDescription, expectedImageUrl }) {
  if (!observed || typeof observed !== "object") return false;
  if (observed.name !== expectedName) return false;
  if (observed.description !== expectedDescription) return false;
  if (expectedImageUrl) {
    const observedUrl = observed.image?.url ?? null;
    if (observedUrl !== expectedImageUrl) return false;
  }
  return true;
}

async function safeTrace(network, txHash, signer, { retries = 3, delayMs = 2000 } = {}) {
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const traced = await traceTx(network, txHash, signer, "FINAL");
      if (traced?.tree) return traced;
      last = traced || { error: "no tree" };
    } catch (error) {
      last = { error: String(error) };
    }
    if (attempt < retries) await sleep(delayMs);
  }
  return last ?? { error: "safeTrace exhausted retries" };
}

function summarizeTrace(trace) {
  if (!trace || trace.error) return { error: trace?.error || "no trace" };
  return {
    sender_id: trace.senderId,
    classification: trace.classification,
    error: trace.error || null,
  };
}

async function resolveDownstreamReceipt({ network, registerTrace, socialAccount }) {
  const tree = registerTrace?.tree;
  if (!tree) {
    return {
      error: registerTrace?.error || "no register trace tree",
      note:
        "downstream social.near.set receipt lives on the register tx's registered step callback subtree",
    };
  }
  const flat = flattenReceiptTree(tree);
  const match = flat.find(
    (receipt) =>
      receipt.executor === socialAccount &&
      receipt.actions?.some(
        (action) => typeof action === "string" && action.startsWith("FunctionCall(set,")
      )
  );
  if (!match) {
    return {
      error: `no social.near.set receipt found in register trace`,
      note: "expected exactly one downstream receipt for a single-step stamp",
    };
  }
  // FastNEAR's block-receipts index can lag chain finality by a block or two;
  // retry a handful of times until our receipt appears in the location map.
  let located = null;
  let metaError = null;
  for (let attempt = 0; attempt < 4 && !located; attempt += 1) {
    if (attempt > 0) await sleep(1500);
    try {
      const metadata = await fetchTraceBlockMetadata(network, tree);
      located = metadata?.receiptLocations?.get(match.id) || null;
    } catch (error) {
      metaError = String(error);
    }
  }
  return {
    receipt_id: match.id,
    block_hash: match.blockHash,
    block_height: located?.blockHeight ?? null,
    status: match.status,
    predecessor: match.predecessor,
    metadata_error: metaError,
    metadata_lag_note:
      located || metaError
        ? null
        : "FastNEAR /v0/block did not yet index this receipt after retries; block_height is null",
  };
}

function writeArtifact(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function defaultArtifactsFile({ signer, runId }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(
    REPO_ROOT,
    "collab",
    "artifacts",
    `${stamp}-social-profile-${signer.replace(/\./g, "-")}-${runId}.json`
  );
}

function commandSet({
  network,
  signer,
  sequencer,
  socialAccount,
  runSequenceArgs,
  registerTxHash,
  runSequenceTxHash,
}) {
  const profileView = JSON.stringify({
    account: socialAccount,
    method: "get",
    args: { keys: [`${sequencer}/profile/**`] },
  });
  return {
    run_sequence: `NEAR_ENV=${network} near call ${sequencer} run_sequence '${JSON.stringify(
      runSequenceArgs
    )}' --accountId ${signer}`,
    trace_register: `./scripts/trace-tx.mjs ${registerTxHash} ${signer} --wait FINAL`,
    trace_run_sequence: `./scripts/trace-tx.mjs ${runSequenceTxHash} ${signer} --wait FINAL`,
    state_social_profile: `./scripts/state.mjs ${socialAccount} --network ${network} --method get --args '${JSON.stringify(
      { keys: [`${sequencer}/profile/**`] }
    )}'`,
    investigate_register:
      `./scripts/investigate-tx.mjs ${registerTxHash} ${signer} --wait FINAL ` +
      `--accounts ${sequencer},${socialAccount} --view '${profileView}'`,
    feed_url: `${NEAR_SOCIAL_PROFILE_BASE[network]}/${sequencer}`,
  };
}

function printSummary(a) {
  console.log(
    `network=${a.network} signer=${a.signer} sequencer=${a.sequencer} social=${a.social_account}`
  );
  console.log(
    `register_batch: tx_hash=${a.txs[0].tx_hash} block_height=${a.txs[0].block_height ?? "?"}`
  );
  console.log(renderStepOutcomeSummary(a.step_outcome));
  console.log(
    `run_sequence: tx_hash=${a.txs[1].tx_hash} block_height=${a.txs[1].block_height ?? "?"}`
  );
  const resolved = a.profile_after?.resolved ? "yes" : "no";
  const obs = a.profile_after?.observed?.profile;
  console.log(
    `profile final: resolved=${resolved} name="${obs?.name ?? "?"}" description="${obs?.description ?? "?"}"${
      obs?.image?.url ? ` image.url="${obs.image.url}"` : ""
    }`
  );
  if (a.downstream_social_receipt?.receipt_id) {
    const r = a.downstream_social_receipt;
    console.log(
      `downstream ${a.social_account}.set receipt: block=${r.block_height ?? "?"} status=${r.status} receipt_id=${r.receipt_id}`
    );
  } else if (a.downstream_social_receipt?.error) {
    console.log(`downstream receipt: ${a.downstream_social_receipt.error}`);
  }
  console.log(`feed: ${a.feed_url}`);
  console.log(`trace(register_batch): ${a.commands.trace_register}`);
  console.log(`trace(run_sequence): ${a.commands.trace_run_sequence}`);
  console.log(`state(profile): ${a.commands.state_social_profile}`);
  console.log(`investigate(register_batch): ${a.commands.investigate_register}`);
  console.log(`artifacts=${a.artifacts_file}`);
  console.log(
    `short=register:${shortHash(a.txs[0].tx_hash)} run:${shortHash(a.txs[1].tx_hash)}`
  );
}
