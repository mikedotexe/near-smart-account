#!/usr/bin/env node

import { parseArgs } from "node:util";
import { fetchAccountHistory, formatTimestampNs, shortHash } from "./lib/fastnear.mjs";

const { values, positionals } = parseArgs({
  options: {
    network: { type: "string", default: "testnet" },
    limit: { type: "string", default: "20" },
    "from-block": { type: "string" },
    "to-block": { type: "string" },
    "resume-token": { type: "string" },
    desc: { type: "boolean", default: true },
    signer: { type: "boolean", default: false },
    receiver: { type: "boolean", default: false },
    predecessor: { type: "boolean", default: false },
    "function-call": { type: "boolean", default: false },
    "real-receiver": { type: "boolean", default: false },
    "real-signer": { type: "boolean", default: false },
    "any-signer": { type: "boolean", default: false },
    "delegated-signer": { type: "boolean", default: false },
    "action-arg": { type: "boolean", default: false },
    "event-log": { type: "boolean", default: false },
    "explicit-refund-to": { type: "boolean", default: false },
    success: { type: "boolean", default: false },
    failure: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
  allowPositionals: true,
});

const [accountId] = positionals;
if (!accountId) {
  console.error(
    "usage: scripts/account-history.mjs <account_id> [--limit 20] [--signer] [--receiver] [--predecessor] [--function-call] [--success|--failure] [--json]"
  );
  process.exit(1);
}

const json = await fetchAccountHistory(values.network, accountId, {
  limit: values.limit,
  desc: values.desc,
  fromBlock: values["from-block"],
  toBlock: values["to-block"],
  resumeToken: values["resume-token"],
  isSigner: values.signer,
  isReceiver: values.receiver,
  isPredecessor: values.predecessor,
  isFunctionCall: values["function-call"],
  isRealReceiver: values["real-receiver"],
  isRealSigner: values["real-signer"],
  isAnySigner: values["any-signer"],
  isDelegatedSigner: values["delegated-signer"],
  isActionArg: values["action-arg"],
  isEventLog: values["event-log"],
  isExplicitRefundTo: values["explicit-refund-to"],
  isSuccess: values.success ? true : values.failure ? false : undefined,
});

if (values.json) {
  console.log(JSON.stringify(json, null, 2));
  process.exit(0);
}

console.log(
  `network=${values.network} account=${accountId} rows=${json.account_txs.length} total=${json.txs_count}`
);
for (const row of json.account_txs) {
  const flags = [];
  if (row.is_signer) flags.push("signer");
  if (row.is_receiver) flags.push("receiver");
  if (row.is_predecessor) flags.push("predecessor");
  if (row.is_function_call) flags.push("function_call");
  if (row.is_real_receiver) flags.push("real_receiver");
  if (row.is_real_signer) flags.push("real_signer");
  if (row.is_any_signer) flags.push("any_signer");
  if (row.is_delegated_signer) flags.push("delegated_signer");
  if (row.is_action_arg) flags.push("action_arg");
  if (row.is_event_log) flags.push("event_log");
  if (row.is_explicit_refund_to) flags.push("explicit_refund_to");
  flags.push(row.is_success ? "success" : "not_success");
  console.log(
    `${row.tx_block_height} ${shortHash(row.transaction_hash)} ${formatTimestampNs(row.tx_block_timestamp)} ${flags.join(",")}`
  );
}
if (json.resume_token) {
  console.log(`resume_token=${json.resume_token}`);
}
