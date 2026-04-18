#!/usr/bin/env node

import { parseArgs } from "node:util";
import { traceTx, renderText } from "./lib/trace-rpc.mjs";

const { values, positionals } = parseArgs({
  options: {
    network: { type: "string", default: "testnet" },
    wait: { type: "string", default: "EXECUTED_OPTIMISTIC" },
    json: { type: "boolean", default: false },
  },
  allowPositionals: true,
});

const [txHash, senderId] = positionals;
if (!txHash) {
  console.error(
    "usage: scripts/trace-tx.mjs <tx_hash> [sender_account_id] [--network testnet] [--wait FINAL] [--json]"
  );
  process.exit(1);
}

const result = await traceTx(values.network, txHash, senderId, values.wait);

if (values.json) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

if (result.error) {
  console.error(JSON.stringify(result.error, null, 2));
  process.exit(1);
}

console.log(
  `network=${values.network} sender=${result.senderId} wait=${values.wait} classification=${result.classification}`
);
console.log(renderText(result.tree));
