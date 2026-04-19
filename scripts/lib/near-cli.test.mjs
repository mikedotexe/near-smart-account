import test from "node:test";
import assert from "node:assert/strict";

import { sendTransactionAsync } from "./near-cli.mjs";

test("sendTransactionAsync signs once and returns the transaction hash", async () => {
  const actions = [{ type: "FunctionCall" }];
  const signedTransaction = { signed: true };
  const account = {
    signTransactionCalls: [],
    providerCalls: [],
    async signTransaction(receiverId, sentActions) {
      this.signTransactionCalls.push({ receiverId, sentActions });
      return [{ hash: "ignored" }, signedTransaction];
    },
    connection: {
      provider: {
        sendTransactionAsync: async (tx) => {
          account.providerCalls.push(tx);
          return "register-hash.testnet";
        },
      },
    },
  };

  const result = await sendTransactionAsync(account, "smart-account.testnet", actions);

  assert.deepEqual(account.signTransactionCalls, [
    {
      receiverId: "smart-account.testnet",
      sentActions: actions,
    },
  ]);
  assert.deepEqual(account.providerCalls, [signedTransaction]);
  assert.deepEqual(result, {
    transaction: {
      hash: "register-hash.testnet",
      receiver_id: "smart-account.testnet",
    },
  });
});
