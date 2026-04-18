import test from "node:test";
import assert from "node:assert/strict";

import {
  classify,
  flattenReceiptTree,
  indexTraceBlockMetadata,
  materializeFlattenedReceipts,
  renderText,
} from "./trace-rpc.mjs";

function receipt(overrides = {}) {
  return {
    kind: "receipt",
    id: "receipt.testnet",
    executor: "smart-account.testnet",
    predecessor: "mike.testnet",
    isRefund: false,
    isPromiseYield: false,
    actions: [],
    inputDataIds: [],
    outputDataReceivers: [],
    logs: [],
    gasBurnt: 0,
    tokensBurnt: 0,
    statusTag: "SuccessValue",
    returnValue: null,
    failure: undefined,
    children: [],
    ...overrides,
  };
}

function tx(children, finalStatus = { SuccessValue: "" }) {
  return {
    kind: "tx",
    txHash: "tx.testnet",
    signer: "mike.testnet",
    receiver: "smart-account.testnet",
    finality: "FINAL",
    finalStatus,
    gasBurntTx: 0,
    tokensBurntTx: 0,
    children,
  };
}

test("staged-only yield renders as waiting_for_resume and stays pending", () => {
  const tree = tx([
    receipt({
      id: "yielded-receipt.testnet",
      statusTag: "pending_yield",
      isPromiseYield: true,
    }),
  ]);

  assert.equal(classify(tree), "PENDING");
  const text = renderText(tree);
  assert.match(text, /waiting_for_resume \[yield\]/);
  assert.doesNotMatch(text, /pending_yield/);
});

test("released and settled yielded tree becomes full success", () => {
  const tree = tx([
    receipt({
      id: "yielded-receipt.testnet",
      statusTag: "SuccessReceiptId",
      isPromiseYield: true,
      children: [
        receipt({
          id: "downstream.testnet",
          statusTag: "SuccessValue",
          returnValue: 7,
        }),
      ],
    }),
  ]);

  assert.equal(classify(tree), "FULL_SUCCESS");
});

test("failing descendant still classifies as partial failure", () => {
  const tree = tx([
    receipt({
      id: "yielded-receipt.testnet",
      statusTag: "SuccessReceiptId",
      isPromiseYield: true,
      children: [
        receipt({
          id: "downstream.testnet",
          statusTag: "Failure",
          failure: { ActionError: { index: 0 } },
        }),
      ],
    }),
  ]);

  assert.equal(classify(tree), "PARTIAL_FAIL");
});

test("flattened receipts preserve receipt order metadata", () => {
  const tree = tx([
    receipt({
      id: "yielded-receipt.testnet",
      blockHash: "block-yield",
      statusTag: "SuccessReceiptId",
      isPromiseYield: true,
      children: [
        receipt({
          id: "downstream-a.testnet",
          blockHash: "block-a",
          statusTag: "SuccessValue",
          returnValue: 1,
        }),
        receipt({
          id: "downstream-b.testnet",
          blockHash: "block-a",
          statusTag: "SuccessValue",
          returnValue: 2,
        }),
      ],
    }),
  ]);
  tree.includedBlockHash = "block-included";

  const metadata = indexTraceBlockMetadata(tree, [
    {
      block: {
        block_hash: "block-included",
        block_height: 100,
      },
      block_receipts: [],
    },
    {
      block: {
        block_hash: "block-yield",
        block_height: 101,
      },
      block_receipts: [
        {
          receipt_id: "yielded-receipt.testnet",
          receipt_index: 2,
          transaction_hash: "tx.testnet",
          receipt_type: "Action",
          is_success: true,
        },
      ],
    },
    {
      block: {
        block_hash: "block-a",
        block_height: 102,
      },
      block_receipts: [
        {
          receipt_id: "downstream-a.testnet",
          receipt_index: 0,
          transaction_hash: "tx.testnet",
          receipt_type: "Action",
          is_success: true,
        },
        {
          receipt_id: "downstream-b.testnet",
          receipt_index: 1,
          transaction_hash: "tx.testnet",
          receipt_type: "Action",
          is_success: true,
        },
      ],
    },
  ]);

  const flat = materializeFlattenedReceipts(tree, metadata);
  assert.deepEqual(
    flat.map((receipt) => [receipt.id, receipt.blockHeight, receipt.receiptIndex]),
    [
      ["yielded-receipt.testnet", 101, 2],
      ["downstream-a.testnet", 102, 0],
      ["downstream-b.testnet", 102, 1],
    ]
  );
});

test("flatten helper omits dedupe placeholders", () => {
  const tree = tx([
    receipt({
      id: "root.testnet",
      children: [
        { kind: "receipt", id: "dup.testnet", dedupe: true, children: [] },
        receipt({ id: "child.testnet" }),
      ],
    }),
  ]);

  assert.deepEqual(
    flattenReceiptTree(tree).map((receipt) => receipt.id),
    ["root.testnet", "child.testnet"]
  );
});
