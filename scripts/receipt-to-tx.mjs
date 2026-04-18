#!/usr/bin/env node

import { parseArgs } from "node:util";
import { fetchReceipt, formatTimestampNs, shortHash } from "./lib/fastnear.mjs";

const { values, positionals } = parseArgs({
  options: {
    network: { type: "string", default: "testnet" },
    json: { type: "boolean", default: false },
  },
  allowPositionals: true,
});

const [receiptId] = positionals;
if (!receiptId) {
  console.error(
    "usage: scripts/receipt-to-tx.mjs <receipt_id> [--network testnet] [--json]"
  );
  process.exit(1);
}

const json = await fetchReceipt(values.network, receiptId);

if (values.json) {
  console.log(JSON.stringify(json, null, 2));
  process.exit(0);
}

const receipt = json.receipt;
const tx = json.transaction?.transaction;

console.log(`receipt=${receipt.receipt_id} type=${receipt.receipt_type} success=${receipt.is_success}`);
console.log(
  `tx=${receipt.transaction_hash} signer=${tx?.signer_id || "?"} receiver=${tx?.receiver_id || "?"}`
);
console.log(
  `predecessor=${receipt.predecessor_id} receiver=${receipt.receiver_id} shard=${receipt.shard_id}`
);
console.log(
  `appeared=${receipt.appear_block_height}#${receipt.appear_receipt_index} executed=${receipt.block_height}#${receipt.receipt_index}`
);
console.log(
  `tx_block=${receipt.tx_block_height} tx_time=${formatTimestampNs(receipt.tx_block_timestamp)} receipt_time=${formatTimestampNs(receipt.block_timestamp)}`
);
if (tx?.actions?.length) {
  console.log(`tx_actions=${tx.actions.length} nonce=${tx.nonce}`);
}
if (json.transaction?.receipts?.length) {
  console.log(
    `transaction_receipts=${json.transaction.receipts.length} data_receipts=${json.transaction.data_receipts?.length || 0}`
  );
}
console.log(`short: receipt ${shortHash(receipt.receipt_id)} -> tx ${shortHash(receipt.transaction_hash)}`);
