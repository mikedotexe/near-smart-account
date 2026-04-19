#!/usr/bin/env node
//
// social-storage-deposit.mjs — pre-fund the sequencer's storage balance on
// NEAR Social so it can write posts via `set(...)`.
//
// SocialDB charges the writer for storage at first write, and every write
// that adds bytes. Pre-depositing a small amount once avoids mid-run
// failures during `send-social-poem.mjs`.
//
//   ./simple-example/scripts/social-storage-deposit.mjs \
//     --network mainnet \
//     --signer mike.near \
//     --sequencer simple-sequencer.sa-lab.mike.near \
//     --amount-near 0.1
//
// The deposit is paid by --signer and credited to --sequencer.

import process from "node:process";
import { parseArgs } from "node:util";
import { callViewMethod, connectNearWithSigners } from "../../scripts/lib/near-cli.mjs";

const DEFAULT_SOCIAL_BY_NETWORK = {
  mainnet: "social.near",
  testnet: "v1.social08.testnet",
};

const { values } = parseArgs({
  options: {
    network: { type: "string", default: "mainnet" },
    signer: { type: "string" },
    sequencer: { type: "string" },
    "social-account": { type: "string" },
    "amount-near": { type: "string", default: "0.1" },
    "registration-only": { type: "boolean", default: false },
    "gas-tgas": { type: "string", default: "30" },
    force: { type: "boolean", default: false },
    dry: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
});

if (!values.signer) throw new Error("--signer is required");
if (!values.sequencer) throw new Error("--sequencer is required");
if (!DEFAULT_SOCIAL_BY_NETWORK[values.network]) {
  throw new Error(`unsupported --network '${values.network}'`);
}

const socialAccount = values["social-account"] || DEFAULT_SOCIAL_BY_NETWORK[values.network];
const amountNear = Number(values["amount-near"]);
if (!Number.isFinite(amountNear) || amountNear <= 0) {
  throw new Error("--amount-near must be a positive number");
}
const gasTgas = Number(values["gas-tgas"]);
if (!Number.isFinite(gasTgas) || gasTgas <= 0) {
  throw new Error("--gas-tgas must be a positive number");
}
const depositYocto = BigInt(Math.round(amountNear * 1e6)) * 10n ** 18n;

if (values.dry) {
  console.log(
    JSON.stringify(
      {
        network: values.network,
        signer: values.signer,
        sequencer: values.sequencer,
        social_account: socialAccount,
        amount_near: amountNear,
        deposit_yocto: depositYocto.toString(),
        registration_only: values["registration-only"],
        gas_tgas: gasTgas,
        will_call: `${socialAccount}.storage_deposit({ account_id: "${values.sequencer}", registration_only: ${values["registration-only"]} })`,
      },
      null,
      2
    )
  );
  process.exit(0);
}

const before = await readStorageBalance({
  network: values.network,
  socialAccount,
  accountId: values.sequencer,
});

if (before.total && !values.force) {
  const msg = {
    skipped: true,
    reason: "sequencer already has a non-zero storage balance on the social contract",
    sequencer: values.sequencer,
    social_account: socialAccount,
    before,
    hint: "rerun with --force to top up anyway",
  };
  if (values.json) {
    console.log(JSON.stringify(msg, null, 2));
  } else {
    console.log(
      `storage already present on ${socialAccount} for ${values.sequencer}: total=${before.total} available=${before.available}`
    );
    console.log("rerun with --force to top up anyway");
  }
  process.exit(0);
}

const { nearApi, accounts } = await connectNearWithSigners(values.network, [values.signer]);
const account = accounts[values.signer];

const result = await account.signAndSendTransaction({
  receiverId: socialAccount,
  actions: [
    nearApi.transactions.functionCall(
      "storage_deposit",
      Buffer.from(
        JSON.stringify({
          account_id: values.sequencer,
          registration_only: values["registration-only"],
        })
      ),
      BigInt(gasTgas) * 10n ** 12n,
      depositYocto
    ),
  ],
});

const after = await readStorageBalance({
  network: values.network,
  socialAccount,
  accountId: values.sequencer,
});

const out = {
  network: values.network,
  signer: values.signer,
  sequencer: values.sequencer,
  social_account: socialAccount,
  amount_near: amountNear,
  deposit_yocto: depositYocto.toString(),
  tx_hash: result.transaction?.hash || null,
  status: result.status || null,
  storage_balance_before: before,
  storage_balance_after: after,
};

if (values.json) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(
    `deposited ${amountNear} NEAR on ${socialAccount} for ${values.sequencer} (tx=${out.tx_hash})`
  );
  console.log(
    `storage_balance: before total=${before.total ?? "null"} -> after total=${after.total ?? "null"}`
  );
}

async function readStorageBalance({ network, socialAccount, accountId }) {
  try {
    const { value } = await callViewMethod(network, socialAccount, "storage_balance_of", {
      account_id: accountId,
    });
    if (!value) return { total: null, available: null };
    return { total: value.total ?? null, available: value.available ?? null };
  } catch (error) {
    return { total: null, available: null, error: String(error) };
  }
}
