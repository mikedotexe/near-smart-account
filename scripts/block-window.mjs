#!/usr/bin/env node

import { parseArgs } from "node:util";
import { fetchBlock, fetchBlockRange, formatTimestampNs, shortHash } from "./lib/fastnear.mjs";

const { values } = parseArgs({
  options: {
    network: { type: "string", default: "testnet" },
    block: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    limit: { type: "string", default: "10" },
    desc: { type: "boolean", default: false },
    "with-receipts": { type: "boolean", default: false },
    "with-transactions": { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
  allowPositionals: true,
});

if (values.block) {
  const json = await fetchBlock(values.network, values.block, {
    withReceipts: values["with-receipts"],
    withTransactions: values["with-transactions"],
  });

  if (values.json) {
    console.log(JSON.stringify(json, null, 2));
    process.exit(0);
  }

  const block = json.block;
  console.log(
    `block=${block.block_height} hash=${block.block_hash} author=${block.author_id} time=${formatTimestampNs(block.block_timestamp)}`
  );
  console.log(
    `txs=${block.num_transactions} receipts=${block.num_receipts} gas_burnt=${block.gas_burnt} tokens_burnt=${block.tokens_burnt}`
  );

  if (values["with-transactions"] && json.block_txs?.length) {
    console.log("\ntransactions:");
    for (const row of json.block_txs) {
      console.log(
        `  ${row.tx_index} ${shortHash(row.transaction_hash)} ${row.signer_id} -> ${row.receiver_id} completed=${row.is_completed} success=${row.is_success}`
      );
    }
  }

  if (values["with-receipts"] && json.block_receipts?.length) {
    console.log("\nreceipts:");
    for (const row of json.block_receipts) {
      console.log(
        `  ${row.receipt_index} ${shortHash(row.receipt_id)} ${row.predecessor_id} -> ${row.receiver_id} type=${row.receipt_type} success=${row.is_success} tx=${shortHash(row.transaction_hash)}`
      );
    }
  }
  process.exit(0);
}

if (!values.from || !values.to) {
  console.error(
    "usage: scripts/block-window.mjs --from <height> --to <height> [--limit 10] [--desc] [--json]\n   or: scripts/block-window.mjs --block <height-or-hash> [--with-receipts] [--with-transactions] [--json]"
  );
  process.exit(1);
}

const json = await fetchBlockRange(values.network, values.from, values.to, {
  limit: values.limit,
  desc: values.desc,
});

if (values.json) {
  console.log(JSON.stringify(json, null, 2));
  process.exit(0);
}

console.log(`network=${values.network} blocks=${json.blocks.length}`);
for (const block of json.blocks) {
  console.log(
    `${block.block_height} ${shortHash(block.block_hash)} ${formatTimestampNs(block.block_timestamp)} txs=${block.num_transactions} receipts=${block.num_receipts} gas=${block.gas_burnt}`
  );
}
