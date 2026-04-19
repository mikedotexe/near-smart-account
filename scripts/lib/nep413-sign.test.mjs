import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { buildSignedIntent, nep413SigningBytes } from "./nep413-sign.mjs";
import { loadNearApi } from "./near-cli.mjs";

test("nep413SigningBytes lays out the canonical NEP-413 buffer", () => {
  const message = "hello";
  const nonce = new Uint8Array(32); // all zeros
  const recipient = "intents.near";

  const out = nep413SigningBytes({ message, nonce, recipient });

  // tag(4) + msg_len(4) + msg(5) + nonce(32) + recv_len(4) + recv(12) + None(1) = 62
  assert.equal(out.length, 62);
  assert.equal(out.readUInt32LE(0), 2147484061); // 2^31 + 413
  assert.equal(out.readUInt32LE(4), 5);
  assert.equal(out.slice(8, 13).toString("utf8"), "hello");
  for (let i = 13; i < 45; i++) assert.equal(out[i], 0);
  assert.equal(out.readUInt32LE(45), 12);
  assert.equal(out.slice(49, 61).toString("utf8"), "intents.near");
  assert.equal(out[61], 0); // callback_url: None
});

test("nep413SigningBytes rejects nonces that are not 32 bytes", () => {
  assert.throws(
    () =>
      nep413SigningBytes({
        message: "x",
        nonce: new Uint8Array(16),
        recipient: "r",
      }),
    /32-byte Uint8Array/
  );
});

test("nep413SigningBytes appends a Some-encoded callback_url when provided", () => {
  const nonce = new Uint8Array(32);
  const out = nep413SigningBytes({
    message: "m",
    nonce,
    recipient: "r",
    callbackUrl: "https://example.test",
  });
  const someTagIndex = 4 + 4 + 1 + 32 + 4 + 1; // tag + len + msg + nonce + rlen + "r"
  assert.equal(out[someTagIndex], 1);
  assert.equal(out.readUInt32LE(someTagIndex + 1), "https://example.test".length);
});

test("buildSignedIntent round-trips against the signer's public key", () => {
  const nearApi = loadNearApi();
  const keyPair = nearApi.KeyPair.fromRandom("ed25519");
  const nonce = new Uint8Array(32);
  nonce.fill(0xab);
  const deadline = "2026-06-01T00:00:00.000Z";
  const intents = [
    {
      intent: "ft_withdraw",
      token: "wrap.near",
      receiver_id: "alice.near",
      amount: "1000",
    },
  ];

  const envelope = buildSignedIntent({
    nearApi,
    keyPair,
    signerId: "alice.near",
    intents,
    nonce,
    deadline,
  });

  assert.equal(envelope.standard, "nep413");
  assert.equal(envelope.payload.recipient, "intents.near");
  assert.equal(envelope.payload.nonce, Buffer.from(nonce).toString("base64"));
  assert.ok(envelope.payload.message.includes('"signer_id":"alice.near"'));
  assert.ok(envelope.payload.message.includes(`"deadline":"${deadline}"`));
  assert.ok(envelope.public_key.startsWith("ed25519:"));
  assert.ok(envelope.signature.startsWith("ed25519:"));

  // Rebuild the signed bytes and verify the signature we put on the wire.
  const signingBytes = nep413SigningBytes({
    message: envelope.payload.message,
    nonce,
    recipient: "intents.near",
  });
  const hash = crypto.createHash("sha256").update(signingBytes).digest();
  const sigBytes = nearApi.utils.serialize.base_decode(
    envelope.signature.slice("ed25519:".length)
  );
  assert.ok(
    keyPair.verify(new Uint8Array(hash), new Uint8Array(sigBytes)),
    "signature should verify against signer's public key"
  );
});

test("buildSignedIntent uses a fresh random nonce when none is supplied", () => {
  const nearApi = loadNearApi();
  const keyPair = nearApi.KeyPair.fromRandom("ed25519");
  const intents = [
    { intent: "transfer", receiver_id: "bob.near", tokens: {} },
  ];
  const a = buildSignedIntent({
    nearApi,
    keyPair,
    signerId: "alice.near",
    intents,
  });
  const b = buildSignedIntent({
    nearApi,
    keyPair,
    signerId: "alice.near",
    intents,
  });
  assert.notEqual(a.payload.nonce, b.payload.nonce);
});

test("buildSignedIntent rejects an empty intents array", () => {
  const nearApi = loadNearApi();
  const keyPair = nearApi.KeyPair.fromRandom("ed25519");
  assert.throws(
    () =>
      buildSignedIntent({
        nearApi,
        keyPair,
        signerId: "alice.near",
        intents: [],
      }),
    /non-empty/
  );
});
