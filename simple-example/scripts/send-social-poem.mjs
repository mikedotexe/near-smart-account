#!/usr/bin/env node
//
// send-social-poem.mjs — point the simple-sequencer at real NEAR Social and
// prove the release-order reorder on a human-visible profile page.
//
// The simple-sequencer contract is unchanged. It registers three
// `social.near.set(...)` calls, and `run_sequence` releases them in a chosen
// order. Each release writes a post under the sequencer's own namespace, so
// the three-line poem materializes on `near.social/<sequencer-account>` with
// feed order (newest first) determined by the release order.
//
// Default release order is the reverse of the --lines argument, so the
// resulting reverse-chronological feed reads top-down as written.
//
// Before the first run you must pre-fund the sequencer's storage on social:
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

const MAX_TX_GAS_TGAS = 1_000;
const DEFAULT_SOCIAL_BY_NETWORK = {
  mainnet: "social.near",
  testnet: "v1.social08.testnet",
};
const NEAR_SOCIAL_PROFILE_BASE = {
  mainnet: "https://near.social",
  testnet: "https://test.near.social",
};

const { values, positionals } = parseArgs({
  options: {
    network: { type: "string", default: "mainnet" },
    signer: { type: "string" },
    sequencer: { type: "string" },
    "social-account": { type: "string" },
    lines: { type: "string", multiple: true },
    "sequence-order": { type: "string" },
    "action-gas": { type: "string", default: "250" },
    "post-gas": { type: "string", default: "80" },
    "run-gas": { type: "string", default: "100" },
    "run-id": { type: "string" },
    "artifacts-file": { type: "string" },
    "poll-ms": { type: "string", default: "2000" },
    "step-register-timeout-ms": { type: "string", default: "30000" },
    "resolve-timeout-ms": { type: "string", default: "120000" },
    "skip-storage-check": { type: "boolean", default: false },
    "register-only": { type: "boolean", default: false },
    dry: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
  allowPositionals: true,
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

const lines = collectLines(values.lines, positionals);
if (lines.length !== 3) {
  throw new Error(
    `expected exactly 3 poem lines, got ${lines.length} (pass via --lines or three positional args)`
  );
}

const runId = values["run-id"] || Date.now().toString(36);
const stepIds = lines.map((_, i) => `haiku-${runId}-${i + 1}`);
const sequenceOrder = values["sequence-order"]
  ? parseSequenceOrder(values["sequence-order"], stepIds)
  : [...stepIds].reverse();
const socialAccount = values["social-account"] || DEFAULT_SOCIAL_BY_NETWORK[network];
const actionGasTgas = assertPositiveNumber(values["action-gas"], "--action-gas");
const postGasTgas = assertPositiveNumber(values["post-gas"], "--post-gas");
const runGasTgas = assertPositiveNumber(values["run-gas"], "--run-gas");
const pollMs = assertPositiveNumber(values["poll-ms"], "--poll-ms");
const stepRegisterTimeoutMs = assertPositiveNumber(values["step-register-timeout-ms"], "--step-register-timeout-ms");
const resolveTimeoutMs = assertPositiveNumber(
  values["resolve-timeout-ms"],
  "--resolve-timeout-ms"
);
const totalActionGasTgas = actionGasTgas * lines.length;
if (totalActionGasTgas > MAX_TX_GAS_TGAS) {
  throw new Error(
    `${lines.length} register actions at ${actionGasTgas} TGas each exceeds the ${MAX_TX_GAS_TGAS} TGas tx envelope`
  );
}

const feedUrl = `${NEAR_SOCIAL_PROFILE_BASE[network]}/${values.sequencer}`;
const artifactsFile =
  values["artifacts-file"] || defaultArtifactsFile({ signer: values.signer, runId });
const runSequenceArgs = { caller_id: values.signer, order: sequenceOrder };

const networkConfig = getNetworkConfig(network);

const stepPlan = stepIds.map((stepId, index) => ({
  step_id: stepId,
  position_in_poem: index + 1,
  text: lines[index],
  downstream_args: buildSocialSetArgs({
    sequencerAccount: values.sequencer,
    text: lines[index],
  }),
}));

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
        lines,
        step_ids: stepIds,
        sequence_order_requested: sequenceOrder,
        action_gas_tgas: actionGasTgas,
        total_action_gas_tgas: totalActionGasTgas,
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
        reverse_chronological_feed_preview: previewFeed(stepIds, sequenceOrder, lines),
        expected_post_main_final: lines[stepIds.indexOf(sequenceOrder.at(-1))],
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
      expectedPosts: lines.length,
    });

const postMainBefore = await readPostMain({
  network,
  socialAccount,
  sequencer: values.sequencer,
});

const actions = stepPlan.map((entry) =>
  nearApi.transactions.functionCall(
    "register_step",
    Buffer.from(
      JSON.stringify({
        target_id: socialAccount,
        method_name: "set",
        args: Buffer.from(JSON.stringify(entry.downstream_args)).toString("base64"),
        attached_deposit_yocto: "0",
        gas_tgas: postGasTgas,
        step_id: entry.step_id,
      })
    ),
    BigInt(actionGasTgas) * 10n ** 12n,
    0n
  )
);

const registerResult = await sendTransactionAsync(account, values.sequencer, actions);
const registerArtifact = await buildTxArtifact(network, registerResult, values.signer, "register_batch");
const registerDiagnosis = await diagnoseRegisterTransaction({
  network,
  txHash: registerArtifact.tx_hash,
  signer: values.signer,
  contractId: values.sequencer,
  expectedCount: lines.length,
  pollMs,
  timeoutMs: stepRegisterTimeoutMs,
});

if (values["register-only"]) {
  const registerTraceEarly = await safeTrace(network, registerArtifact.tx_hash, values.signer);
  const out = {
    generated_at: new Date().toISOString(),
    run_id: runId,
    network,
    signer: values.signer,
    sequencer: values.sequencer,
    social_account: socialAccount,
    feed_url: feedUrl,
    lines,
    step_ids: stepIds,
    sequence_order_requested: sequenceOrder,
    action_gas_tgas: actionGasTgas,
    post_gas_tgas: postGasTgas,
    storage_balance_before: storageBefore,
    post_main_before: postMainBefore,
    register_primary_forensics: {
      tx_hash: registerArtifact.tx_hash,
      signer: values.signer,
    },
    txs: [registerArtifact],
    registered_steps_before_release: registerDiagnosis.registered_state,
    step_outcome: registerDiagnosis.step_outcome,
    traces: { register_batch: summarizeTrace(registerTraceEarly) },
    register_only: true,
    commands: commandSet({
      network,
      signer: values.signer,
      sequencer: values.sequencer,
      socialAccount,
      runSequenceArgs,
      registerTxHash: registerArtifact.tx_hash,
      runSequenceTxHash: "<run_sequence_tx_hash>",
    }),
    artifacts_file: artifactsFile,
  };
  writeArtifact(artifactsFile, out);
  if (values.json) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    printRegisterOnlySummary(out);
  }
  process.exit(0);
}

if (registerDiagnosis.step_outcome.classification !== "pending_until_resume") {
  throw new Error(
    `register batch ${registerArtifact.tx_hash} did not remain pending: ${registerDiagnosis.step_outcome.classification}`
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
const downstreamOrder = await resolveDownstreamOrder({
  network,
  registerTrace,
  socialAccount,
});
const postMainTimeline = await readPostMainTimeline({
  network,
  socialAccount,
  sequencer: values.sequencer,
  downstreamOrder,
  stepIds,
  sequenceOrder,
  lines,
});
const postMainAfter = await waitForPostMain({
  network,
  socialAccount,
  sequencer: values.sequencer,
  expectedText: lines[stepIds.indexOf(sequenceOrder.at(-1))],
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
  lines,
  step_ids: stepIds,
  sequence_order_requested: sequenceOrder,
  run_sequence_args: runSequenceArgs,
  storage_balance_before: storageBefore,
  post_main_before: postMainBefore,
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
  downstream_social_receipts: downstreamOrder,
  post_main_timeline: postMainTimeline,
  post_main_after: postMainAfter,
  expected_post_main_final: lines[stepIds.indexOf(sequenceOrder.at(-1))],
  reverse_chronological_feed_preview: previewFeed(stepIds, sequenceOrder, lines),
  commands: finalCommands,
  artifacts_file: artifactsFile,
};

writeArtifact(artifactsFile, artifacts);

if (values.json) {
  console.log(JSON.stringify(artifacts, null, 2));
  process.exit(0);
}

printFullSummary(artifacts);

function collectLines(flagged, positional) {
  const flaggedLines = Array.isArray(flagged) ? flagged : flagged ? [flagged] : [];
  const merged = [...flaggedLines, ...(positional || [])];
  return merged.map((line) => String(line).trim()).filter(Boolean);
}

function parseSequenceOrder(raw, validStepIds) {
  const order = raw
    .split(",")
    .map((stepId) => stepId.trim())
    .filter(Boolean);
  if (order.length !== validStepIds.length) {
    throw new Error(
      `--sequence-order must list exactly ${validStepIds.length} step ids`
    );
  }
  const allowed = new Set(validStepIds);
  for (const stepId of order) {
    if (!allowed.delete(stepId)) {
      throw new Error(`--sequence-order contains invalid or duplicate step_id '${stepId}'`);
    }
  }
  return order;
}

function assertPositiveNumber(raw, label) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return n;
}

function buildSocialSetArgs({ sequencerAccount, text }) {
  const post = JSON.stringify({ type: "md", text });
  const indexEntry = JSON.stringify({ key: "main", value: { type: "md" } });
  return {
    data: {
      [sequencerAccount]: {
        post: { main: post },
        index: { post: indexEntry },
      },
    },
  };
}

function downstreamArgsPreview(argsObj) {
  return JSON.stringify(argsObj).slice(0, 240);
}

function previewFeed(stepIds, sequenceOrder, lines) {
  const reversed = [...sequenceOrder].reverse();
  return reversed.map((stepId) => {
    const idx = stepIds.indexOf(stepId);
    return {
      rank_top_is_newest: reversed.indexOf(stepId) + 1,
      step_id: stepId,
      line: idx === -1 ? null : lines[idx],
    };
  });
}

async function verifyStorageBalance({ network, socialAccount, sequencer, expectedPosts }) {
  try {
    const { value } = await callViewMethod(network, socialAccount, "storage_balance_of", {
      account_id: sequencer,
    });
    if (!value || !value.total) {
      throw new Error(
        `${sequencer} has no storage balance on ${socialAccount}; run social-storage-deposit.mjs first`
      );
    }
    return { skipped: false, ...value, expected_posts: expectedPosts };
  } catch (error) {
    throw new Error(
      `storage balance check failed for ${sequencer} on ${socialAccount}: ${error.message}`
    );
  }
}

async function readPostMain({ network, socialAccount, sequencer }) {
  try {
    const { value, block_height, block_hash } = await callViewMethod(
      network,
      socialAccount,
      "get",
      { keys: [`${sequencer}/post/main`] }
    );
    return {
      post_main: extractPostMain(value, sequencer),
      block_height,
      block_hash,
    };
  } catch (error) {
    return { post_main: null, error: String(error) };
  }
}

function extractPostMain(value, sequencer) {
  if (!value || typeof value !== "object") return null;
  const branch = value[sequencer]?.post?.main;
  if (typeof branch !== "string") return null;
  try {
    return JSON.parse(branch);
  } catch {
    return { raw: branch };
  }
}

async function waitForPostMain({
  network,
  socialAccount,
  sequencer,
  expectedText,
  pollMs,
  timeoutMs,
}) {
  const deadline = Date.now() + timeoutMs;
  let last = await readPostMain({ network, socialAccount, sequencer });
  while (Date.now() < deadline) {
    if (last.post_main?.text === expectedText) break;
    await sleep(pollMs);
    last = await readPostMain({ network, socialAccount, sequencer });
  }
  return {
    resolved: last.post_main?.text === expectedText,
    expected_text: expectedText,
    observed: last,
    poll_ms: pollMs,
    timeout_ms: timeoutMs,
  };
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

async function resolveDownstreamOrder({ network, registerTrace, socialAccount }) {
  const tree = registerTrace?.tree;
  if (!tree) {
    return {
      error: registerTrace?.error || "no register trace tree",
      note:
        "downstream social.near.set receipts live on the register tx's registered step callback subtree; rerun trace-tx against the register tx hash if empty",
    };
  }

  const flat = flattenReceiptTree(tree);
  const socialSetReceipts = flat.filter(
    (receipt) =>
      receipt.executor === socialAccount &&
      receipt.actions?.some((action) => typeof action === "string" && action.startsWith("FunctionCall(set,"))
  );
  const metadata = await fetchTraceBlockMetadata(network, tree).catch(() => null);

  const ordered = socialSetReceipts.map((receipt) => {
    const located = metadata?.receiptLocations?.get(receipt.id) || null;
    const resolvedStepId = deriveResolvedStepId(receipt, flat);
    return {
      receipt_id: receipt.id,
      block_hash: receipt.blockHash,
      block_height: located?.blockHeight ?? null,
      status: receipt.status,
      predecessor: receipt.predecessor,
      resolved_step_id: resolvedStepId,
    };
  });
  ordered.sort((a, b) => compareNullableNumbers(a.block_height, b.block_height));
  return {
    ordered,
    expected_count: socialSetReceipts.length,
    note:
      "order computed from the register tx's registered step callback subtree; lowest block_height = first step released",
  };
}

function deriveResolvedStepId(receipt, flat) {
  const parent = flat.find((r) => r.id === receipt.parentId);
  if (!parent) return null;
  for (const log of parent.logs || []) {
    const match = /register_step '([^']+)'[^]*?resumed/.exec(log);
    if (match) return match[1];
  }
  const resumeAction = parent.actions?.find(
    (action) => typeof action === "string" && action.includes("on_step_resumed")
  );
  if (resumeAction) {
    const match = /"step_id":"([^"]+)"/.exec(resumeAction);
    if (match) return match[1];
  }
  return null;
}

async function readPostMainTimeline({
  network,
  socialAccount,
  sequencer,
  downstreamOrder,
  stepIds,
  sequenceOrder,
  lines,
}) {
  const receipts = Array.isArray(downstreamOrder?.ordered) ? downstreamOrder.ordered : [];
  if (!receipts.length) {
    return { error: "no downstream receipts to pin" };
  }

  const entries = [];
  for (let i = 0; i < receipts.length; i += 1) {
    const receipt = receipts[i];
    const releasedStepId = sequenceOrder[i];
    const inputIdx = releasedStepId ? stepIds.indexOf(releasedStepId) : -1;
    const expectedText = inputIdx >= 0 ? lines[inputIdx] : null;
    let observedText = null;
    let pinnedError = null;
    if (receipt.block_height != null) {
      try {
        const { value } = await callViewMethod(
          network,
          socialAccount,
          "get",
          { keys: [`${sequencer}/post/main`] },
          { blockId: receipt.block_height }
        );
        observedText = extractPostMain(value, sequencer)?.text ?? null;
      } catch (error) {
        pinnedError = String(error);
      }
    }
    entries.push({
      release_rank: i + 1,
      released_step_id: releasedStepId ?? null,
      expected_text: expectedText,
      observed_text: observedText,
      matches_expected: expectedText != null && observedText === expectedText,
      block_height: receipt.block_height,
      block_hash: receipt.block_hash,
      receipt_id: receipt.receipt_id,
      pinned_error: pinnedError,
    });
  }

  const proof_ordered = entries.every((e) => e.matches_expected);
  return { proof_ordered, entries };
}

function compareNullableNumbers(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a - b;
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
    `${stamp}-social-poem-${signer.replace(/\./g, "-")}-${runId}.json`
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
  const postView = JSON.stringify({
    account: socialAccount,
    method: "get",
    args: { keys: [`${sequencer}/post/main`] },
  });
  return {
    run_sequence: `NEAR_ENV=${network} near call ${sequencer} run_sequence '${JSON.stringify(
      runSequenceArgs
    )}' --accountId ${signer}`,
    trace_register: `./scripts/trace-tx.mjs ${registerTxHash} ${signer} --wait FINAL`,
    trace_run_sequence: `./scripts/trace-tx.mjs ${runSequenceTxHash} ${signer} --wait FINAL`,
    state_social_post: `./scripts/state.mjs ${socialAccount} --method get --args '${JSON.stringify(
      { keys: [`${sequencer}/post/main`] }
    )}'`,
    investigate_register:
      `./scripts/investigate-tx.mjs ${registerTxHash} ${signer} --wait FINAL ` +
      `--accounts ${sequencer},${socialAccount} --view '${postView}'`,
    feed_url: `${NEAR_SOCIAL_PROFILE_BASE[network]}/${sequencer}`,
  };
}

function printRegisterOnlySummary(out) {
  console.log(
    `network=${out.network} signer=${out.signer} sequencer=${out.sequencer} social=${out.social_account}`
  );
  console.log(
    `register_batch: tx_hash=${out.txs[0].tx_hash} block_height=${out.txs[0].block_height ?? "?"}`
  );
  console.log(renderStepOutcomeSummary(out.step_outcome));
  for (let i = 0; i < out.lines.length; i += 1) {
    console.log(`  ${out.step_ids[i]} -> ${out.social_account}.set  (line: "${out.lines[i]}")`);
  }
  console.log(`trace(register_batch): ${out.commands.trace_register}`);
  console.log(`investigate(register_batch): ${out.commands.investigate_register}`);
  console.log(`run_sequence: ${out.commands.run_sequence}`);
  console.log(`artifacts=${out.artifacts_file}`);
  console.log(`short=register:${shortHash(out.txs[0].tx_hash)}`);
}

function printFullSummary(a) {
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
  const resolved = a.post_main_after?.resolved ? "yes" : "no";
  console.log(
    `post_main final: resolved=${resolved} text="${a.post_main_after?.observed?.post_main?.text ?? "?"}"`
  );
  if (Array.isArray(a.downstream_social_receipts?.ordered)) {
    console.log(`downstream ${a.social_account}.set receipts (oldest first):`);
    for (const r of a.downstream_social_receipts.ordered) {
      console.log(
        `  block=${r.block_height ?? "?"} status=${r.status} receipt_id=${r.receipt_id}`
      );
    }
  }
  if (Array.isArray(a.post_main_timeline?.entries)) {
    const verdict = a.post_main_timeline.proof_ordered ? "proof_ordered=true" : "proof_ordered=false";
    console.log(`post/main block-pinned time-series (${verdict}):`);
    for (const entry of a.post_main_timeline.entries) {
      const check = entry.matches_expected ? "ok" : "MISMATCH";
      console.log(
        `  [${entry.release_rank}] block=${entry.block_height ?? "?"} step=${entry.released_step_id} expected="${entry.expected_text}" observed="${entry.observed_text ?? "?"}" ${check}`
      );
    }
  }
  console.log("reverse-chronological feed preview (top=newest):");
  for (const entry of a.reverse_chronological_feed_preview) {
    console.log(`  [${entry.rank_top_is_newest}] ${entry.step_id}  "${entry.line}"`);
  }
  console.log(`feed: ${a.feed_url}`);
  console.log(`trace(register_batch): ${a.commands.trace_register}`);
  console.log(`trace(run_sequence): ${a.commands.trace_run_sequence}`);
  console.log(`state(post/main): ${a.commands.state_social_post}`);
  console.log(`investigate(register_batch): ${a.commands.investigate_register}`);
  console.log(`artifacts=${a.artifacts_file}`);
  console.log(
    `short=register:${shortHash(a.txs[0].tx_hash)} run:${shortHash(a.txs[1].tx_hash)}`
  );
}
