// NEP-413 signed-message builder, scoped to NEAR Intents (`intents.near`).
//
// A NEAR Intents submission carries a list of `MultiPayload` objects, each
// one a NEP-413 envelope wrapping an inner JSON message:
//
//   {
//     "standard": "nep413",
//     "payload": {
//       "recipient": "intents.near",
//       "nonce":     "<base64 32 bytes>",
//       "message":   "<JSON string — {signer_id, deadline, intents[]}>"
//     },
//     "public_key": "ed25519:<base58>",
//     "signature":  "ed25519:<base58 64 bytes>"
//   }
//
// The bytes actually signed are:
//
//   sha256(
//     u32_le(2^31 + 413) ||
//     u32_le(message_len) || message ||
//     nonce (32 bytes) ||
//     u32_le(recipient_len) || recipient ||
//     option_tag(callback_url)
//   )
//
// This module keeps the serializer pure (`nep413SigningBytes`) so tests can
// rebuild and verify signatures; `buildSignedIntent` composes serializer +
// key-pair to produce a submittable MultiPayload.

import crypto from "node:crypto";

const NEP413_PREFIX_TAG = 2147484061; // 2^31 + 413

export function nep413SigningBytes({ message, nonce, recipient, callbackUrl = null }) {
  if (!(nonce instanceof Uint8Array) || nonce.length !== 32) {
    throw new Error("nep413SigningBytes: nonce must be a 32-byte Uint8Array");
  }
  const messageBytes = Buffer.from(message, "utf8");
  const recipientBytes = Buffer.from(recipient, "utf8");
  const parts = [
    u32le(NEP413_PREFIX_TAG),
    u32le(messageBytes.length),
    messageBytes,
    Buffer.from(nonce),
    u32le(recipientBytes.length),
    recipientBytes,
  ];
  if (callbackUrl == null) {
    parts.push(Buffer.from([0]));
  } else {
    const cbBytes = Buffer.from(String(callbackUrl), "utf8");
    parts.push(Buffer.from([1]));
    parts.push(u32le(cbBytes.length));
    parts.push(cbBytes);
  }
  return Buffer.concat(parts);
}

export function buildSignedIntent({
  nearApi,
  keyPair,
  signerId,
  intents,
  recipient = "intents.near",
  deadline = null,
  nonce = null,
}) {
  if (!Array.isArray(intents) || intents.length === 0) {
    throw new Error("buildSignedIntent: intents must be a non-empty array");
  }
  const deadlineIso =
    deadline || new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const nonceBytes = nonce ?? crypto.randomBytes(32);
  if (!(nonceBytes instanceof Uint8Array) || nonceBytes.length !== 32) {
    throw new Error("buildSignedIntent: nonce must be a 32-byte Uint8Array");
  }
  const innerMessage = JSON.stringify({
    signer_id: signerId,
    deadline: deadlineIso,
    intents,
  });
  const signingBytes = nep413SigningBytes({
    message: innerMessage,
    nonce: nonceBytes,
    recipient,
  });
  const hash = crypto.createHash("sha256").update(signingBytes).digest();
  const { signature } = keyPair.sign(new Uint8Array(hash));
  return {
    standard: "nep413",
    payload: {
      recipient,
      nonce: Buffer.from(nonceBytes).toString("base64"),
      message: innerMessage,
    },
    public_key: keyPair.getPublicKey().toString(),
    signature: `ed25519:${nearApi.utils.serialize.base_encode(signature)}`,
  };
}

function u32le(n) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(n >>> 0);
  return buf;
}
