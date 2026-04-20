# Build your own flagship

A contributor guide for composing smart-account primitives into a new
runnable flagship. Takes you from *"I want to compose primitive X + Y
for protocol Z"* to a merged PR in one sitting. Externalizes the
implicit knowledge embedded across the seven existing flagships in
[`examples/`](./examples/).

Read once top-to-bottom, then crib from the flagship closest to your
target shape.

## TL;DR decision table

Pick the primitives by answering one question each. Any combination
is legal — one step can carry multiple.

| Question | Reach for | Primitive type |
|---|---|---|
| "Do I need to read view state BEFORE committing the call?" | `PreGate` | Pre-dispatch gate |
| "Do I need step N's returned value feeding step N+1's args?" | `save_result` + `args_template` | Value threading |
| "Do I need to assert a specific receiver-side postcondition AFTER the call succeeds?" | `Asserted` | Execution-trust policy |
| "Does the target have hidden async (fire-and-forget, messy promise chain)?" | `Adapter` | Execution-trust policy |
| "Do I just trust the target's top-level resolution?" | `Direct` (default) | Execution-trust policy |
| "Should a dapp fire this repeatedly without owner signing each time?" | Session key + balance trigger | Per-account auth |

See [`CLAUDE.md`](./CLAUDE.md) §Compatibility-rule for the authoritative
per-primitive definition; this file covers the *how-to-assemble*.

## Common skeleton (all seven flagships)

```js
#!/usr/bin/env node
//
// examples/your-flagship.mjs — one-paragraph narrative.
//
// Mechanism: what primitives compose + why each was chosen.
// Usage: one canonical invocation + any variant toggles.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { REPO_ROOT, shortHash, sleep } from "../scripts/lib/fastnear.mjs";
import {
  callViewMethod,
  connectNearWithSigners,
  sendTransactionAsync,
  sendFunctionCall,
  buildTxArtifact,
} from "../scripts/lib/near-cli.mjs";
import { extractBlockInfo, flattenReceiptTree, traceTx } from "../scripts/lib/trace-rpc.mjs";
import { renderStepOutcomeSummary } from "../scripts/lib/step-sequence.mjs";

const NETWORK = process.env.NETWORK || "testnet";    // or "mainnet" for intents.near

const { values } = parseArgs({
  options: {
    signer: { type: "string" },
    "smart-account": { type: "string" },
    // ... primitive-specific knobs ...
    "artifacts-file": { type: "string" },
    dry: { type: "boolean", default: false },
  },
});

// 1. Build the step(s): Step { target_id, method_name, args, gas_tgas,
//    policy, pre_gate?, save_result?, args_template? }
const steps = [/* your step specs */];

if (values.dry) {
  console.log(JSON.stringify(steps, null, 2));
  process.exit(0);
}

// 2. Submit: sendTransactionAsync (owner path) or sendFunctionCall (session-key path)
const nearApi = await connectNearWithSigners(NETWORK, [values.signer]);
const txResult = await sendTransactionAsync(/* ... */);

// 3. Trace + capture
const trace = await traceTx(NETWORK, txResult.transaction.hash, values.signer);
const blockInfo = extractBlockInfo(trace);
// ... capture structured_events from receipt logs ...

// 4. Write artifact with the standard envelope
const artifact = {
  schema_version: 1,
  run_id,
  short_hash: shortHash(run_id),
  network: NETWORK,
  signer: values.signer,
  smart_account: values["smart-account"],
  config: values,                         // echo all CLI flags
  tx_hashes: { /* ... */ },
  block_info: blockInfo,
  structured_events: /* filtered from trace */,
  balances: /* optional: before/after deltas */,
  outcomes: /* per-fire classification */,
};
if (values["artifacts-file"]) {
  fs.writeFileSync(values["artifacts-file"], JSON.stringify(artifact, null, 2));
}
```

Concrete references: [`examples/limit-order.mjs`](./examples/limit-order.mjs)
(PreGate only, cleanest PreGate demo),
[`examples/ladder-swap.mjs`](./examples/ladder-swap.mjs) (threading
only, cleanest `save_result` + `args_template`),
[`examples/session-dapp.mjs`](./examples/session-dapp.mjs)
(session-key lifecycle — enroll/fire/revoke), and
[`examples/intents-deposit-limit.mjs`](./examples/intents-deposit-limit.mjs)
(four primitives composed — the densest example).

## Writing a step

Each step is a JSON struct matching `smart-account-types::Step`:

```js
const step = {
  step_id: "read-wnear-balance",         // stable string identifier
  target_id: "wrap.near",                // AccountId
  method_name: "ft_balance_of",          // string
  args: base64Json({account_id: ...}),   // base64-encoded JSON args
  attached_deposit_yocto: "0",           // U128 as decimal string
  gas_tgas: 15,                          // prepaid gas

  // Optional: pre-dispatch gate. Fires BEFORE target; if gate passes,
  // target fires chained with on_step_resolved; if gate fails, the
  // sequencer halts the sequence cleanly — target never fires.
  pre_gate: {
    gate_id: "wrap.near",
    gate_method: "ft_balance_of",
    gate_args: base64Json({account_id: ...}),
    min_bytes: base64Utf8("1"),          // base64-encoded comparison bound
    max_bytes: null,                     // null = no upper bound
    comparison: "U128Json",              // or "I128Json" / "LexBytes"
    gate_gas_tgas: 15,
  },

  // Optional: save the step's returned bytes into the sequence context.
  save_result: {
    as_name: "wnear_balance",            // referenced later via ${wnear_balance}
    kind: "U128Json",                    // how to parse the returned bytes
  },

  // Optional: materialize args at dispatch time from saved results.
  args_template: {
    template: base64Utf8(
      '{"receiver_id":"intents.near","amount":"${wnear_balance}"}'
    ),
    substitutions: [{
      reference: "wnear_balance",
      op: { PercentU128: { bps: 5000 } }, // 50% of saved value
    }],
  },

  // Policy defines the resolution surface of the target call.
  policy: "Direct",   // or { Adapter: {adapter_id, adapter_method} }
                      // or { Asserted: {assertion_id, assertion_method,
                      //                 assertion_args, expected_return,
                      //                 assertion_gas_tgas} }
};
```

Orthogonality rule: `pre_gate` / `save_result` / `args_template` /
`policy` are independent. One step can carry all four; each emits its
own NEP-297 event (`pre_gate_checked`, `result_saved`,
`step_resolved_ok`, `assertion_checked`).

### Placeholder syntax for `args_template`

Placeholder position matters. `PercentU128` outputs a quoted
decimal-string u128 (e.g. `"500"`). The placeholder
`"${wnear_balance}"` in the template must carry its own surrounding
quotes — the op supplies the *inner* quotes. So:

```js
// right — quoted placeholder + quoted output
template: base64Utf8('{"amount":"${wnear_balance}"}')
// wrong — placeholder without quotes
template: base64Utf8('{"amount":${wnear_balance}}')
```

When in doubt: run with `--dry` and eyeball the materialized args.

## Onboarding a new receiver (target protocol)

Before composing primitives, validate the target surface:

1. **Identify the target `receiver_id` + method.** Prefer NEP-standard
   methods (NEP-141 `ft_transfer_call`, NEP-245 `mt_balance_of`) where
   available — standard surfaces are predictable.
2. **Find a good view method for `Asserted` postcheck.** Something
   cheap, deterministic, and state-reflecting (e.g.
   `intents.near.mt_balance_of` after a deposit).
3. **Check what NEP-297 events the target emits.** `nep141/ft_transfer`,
   `nep245/mt_mint`, etc. These show up in your flagship's receipt tree
   alongside our `sa-automation` events — corroboration surface.
4. **Testnet rehearsal first.** `x.mike.testnet` rig is shared; spin
   up a fresh probe subaccount (`sa-yourname.x.mike.testnet`) for
   schema-breaking experiments. Mainnet only when sequencer and receiver
   both settle.
5. **Mainnet on `mike.near`.** The v4.0.2-ops sequencer is active;
   `NETWORK=mainnet --smart-account mike.near` is the default target.
   Keep probes small (≤ 0.1 NEAR of movement per run).

See also [`PROTOCOL-ONBOARDING.md`](./PROTOCOL-ONBOARDING.md) for the
policy decision tree when wrapping a new protocol as an
`Adapter`-style primitive.

## Artifact conventions

Every flagship writes a JSON artifact via `--artifacts-file` with the
same envelope shape. This matters because verification tooling
(`scripts/verify-mainnet-claims.sh`,
[`MAINNET-PROOF.md`](./MAINNET-PROOF.md) recipes) reads specific
top-level keys:

- `schema_version: 1`
- `run_id` + `short_hash`
- `network`, `signer`, `smart_account`
- `config` — echo of all CLI flags (for reproducibility)
- `tx_hashes` — labeled map of all submitted txs
- `block_info` — output of `extractBlockInfo(trace)` per fire; gives
  archival verifiers the block hashes they need
- `structured_events` — filtered to `sa-automation`-standard events
  only (receiver events like `nep245/mt_mint` are observable in the
  receipt tree but NOT duplicated in the artifact)
- `balances` — optional; before/after token balances where relevant
- `outcomes` — per-fire classification ("completed", "halted (...)")

File under `collab/artifacts/` for ephemeral probes. For flagship
reference runs that merit preservation, curate into
`collab/artifacts/reference/` and add a `.gitignore` whitelist entry.

## Worked example: `intents-deposit-limit`

The densest four-primitive flagship, walked in decisions not code:

1. **Goal.** Deposit wNEAR into `intents.near` only when the NEAR→USDT
   quote on Ref Finance is above threshold. Fire-and-forget via a
   session key; owner signs once.
2. **Step 1 — read + floor-gate the wNEAR balance.** `Direct` target on
   `wrap.near.ft_balance_of`. Gate on the same view with
   `min_bytes: "1"` to halt cleanly if balance is zero (prevents a
   later `ft_transfer_call` NEP-141 panic). `save_result` the balance
   as `wnear_balance` for threading.
3. **Step 2 — `ft_transfer_call` into intents.near, gated on Ref quote.**
   `Direct` target; `PreGate` checks
   `v2.ref-finance.near.get_return(wrap.near → usdt.tether-token.near)`
   with `min_bytes` encoding the threshold. `args_template` carries a
   JSON template string with `"${wnear_balance}"` placeholder and a
   `PercentU128 { bps: 100 }` substitution — dispatches 1% of the
   saved balance.
4. **Why no `Asserted` on step 2?** `intents.near.mt_balance_of` grows
   across repeated fires (session key fires many times), so a static
   `expected_return` would fail on fire #2+. The PreGate already guards
   the deposit condition; `refund_if_fails: true` in the NEP-141 `msg`
   handles receiver-side refund if anything goes wrong downstream.
5. **Session-key wrapping.** One `enroll_session` tx (1 yocto,
   2h expiry, 2 triggers allowed, 5 max fires). Two templates (pass
   + halt) → two triggers → one session key allowlisted for both →
   ephemeral key fires both from a loop. Owner revokes at the end.
6. **Verification.** Script writes a single artifact with both pass and
   halt fires; `QUICK-VERIFY.md` / `scripts/verify-mainnet-claims.sh`
   check it against live archival RPC.

The running flagship is
[`examples/intents-deposit-limit.mjs`](./examples/intents-deposit-limit.mjs);
the mainnet proof lives at
[`collab/artifacts/reference/mike-near-v4.0.2-intents-deposit-limit.json`](./collab/artifacts/reference/mike-near-v4.0.2-intents-deposit-limit.json).

## Checklist before opening a PR

- `./scripts/check.sh` green (sequencer checks + existing node tests pass)
- Flagship runs end-to-end with `--dry` (templates materialize
  without error)
- Testnet rehearsal: one successful end-to-end run, artifact captured
- Mainnet reference run captured under `collab/artifacts/reference/`
  with a `.gitignore` whitelist entry
- [`README.md`](./README.md) flagship gallery updated
- [`examples/README.md`](./examples/README.md) new entry written
- If the flagship exercises a novel primitive combination, add a
  pointer in [`CLAUDE.md`](./CLAUDE.md) mainnet-lab-rig section

## See also

- [`CLAUDE.md`](./CLAUDE.md) §Terminology — authoritative name list
- [`PROTOCOL-ONBOARDING.md`](./PROTOCOL-ONBOARDING.md) — policy
  decision tree for wrapping a new protocol
- [`MAINNET-PROOF.md`](./MAINNET-PROOF.md) — how verifiers check
  reference artifacts
- [`QUICK-VERIFY.md`](./QUICK-VERIFY.md) — 60-second falsifiability
  path for the four-primitive flagship
