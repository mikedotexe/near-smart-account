# 02 · Latch / conduct testnet validation and the smart-account implication

Historical terminology note: this chapter preserves the original experimental
terms `latch`, `conduct`, and `label` because those were the live names on
chain when this run happened. Current docs and current code use `step` and
`run_sequence`.

**BLUF.** On 2026-04-17 we validated the `latch / conduct` POC live on
testnet. A single multi-action transaction from `mike.testnet` to
`yield-sequencer.x.mike.testnet` created three yielded callback receipts, and
a later `conduct(caller_id="mike.testnet", order=["beta","alpha","gamma"])`
caused those original yielded callbacks to execute in the deliberately
shuffled order `beta -> alpha -> gamma`. The crucial proof is in the original
transaction's yielded callback receipts, not in the `conduct` transaction's
own tree. This is the first concrete evidence in this repo that "receipt order
is impossible on NEAR" is too coarse a statement: if the user calls a
smart-account-like contract first, that contract can manufacture yielded child
receipts and release them in a deterministic, user-chosen order.

---

## 1. Why this experiment mattered

The old intuition is mostly right at the raw protocol level:

- a user cannot directly impose an order on sibling cross-contract receipts
- a multi-Action transaction to one receiver still executes as one receipt
- sibling child receipts created during that receipt are free to execute later
  under protocol scheduling

What this experiment tested was narrower and more interesting:

- can the first receiver be the user's own contract
- can that contract convert each action into a yielded child receipt
- can a later explicit resume pick the order in which those children wake up

The answer from this run is yes.

That does not magically make NEAR transaction-level atomic. It does mean a
smart account can act as a sequencing membrane between the user's intent and
the network's eventually independent receipt execution.

## 2. Working local workflow

The repo now has a workable "do the obvious thing" testnet path:

```bash
./scripts/check.sh
cargo t
MASTER=x.mike.testnet ./scripts/deploy-testnet.sh
python3 -m http.server 8000 -d web
```

Important details that were learned the hard way:

- `deploy-testnet.sh` must use a modern testnet RPC for the old JS `near` CLI.
  The script now exports `NEAR_TESTNET_RPC=https://test.rpc.fastnear.com`
  automatically on testnet.
- The current Wasm recipe that executes correctly on testnet is the one hidden
  behind `scripts/build-all.sh`: `cargo +nightly -Z build-std=std,panic_abort`
  plus `RUSTFLAGS='-C link-arg=-s -C target-cpu=mvp'`.
- For the shared `*.x.mike.testnet` rig, deploy with
  `MASTER=x.mike.testnet`, not `MASTER=mike.testnet`.

Deployed shared accounts from the reference run:

- `smart-account.x.mike.testnet`
- `router.x.mike.testnet`
- `echo.x.mike.testnet`
- `echo-b.x.mike.testnet`
- `yield-sequencer.x.mike.testnet`

## 3. Exact live procedure

### 3.1 Prepare the resumer

`yield-sequencer` is initialized with `owner_id = $MASTER`, so on the shared
rig the owner is `x.mike.testnet`, not `mike.testnet`.

That means the run must include:

```bash
NEAR_ENV=testnet near call yield-sequencer.x.mike.testnet \
  set_authorized_resumer '{"authorized_resumer":"mike.testnet"}' \
  --accountId x.mike.testnet
```

Reference tx:

- `GA5VLoXKeHq4uASvgVHJKZDvTBvUPBQ9cMnaucwFx5rg`

### 3.2 Originate a real multi-action latch transaction

This cannot be simulated with repeated `near call` invocations. The test must
be one signed transaction containing three `FunctionCall` actions:

- `latch("alpha")`
- `latch("beta")`
- `latch("gamma")`

The practical way to do this locally was a one-off Node helper using the
globally installed `near-cli`'s bundled `near-api-js` and the existing
full-access credential in:

- `~/.near-credentials/testnet/mike.testnet.json`

One important nuance: submit the transaction asynchronously. A commit-style RPC
wait can block until yields settle, which is exactly the wrong behavior for
this experiment.

Reference latch tx:

- `4ct5RA1d4x9efJXWGxPBQRLhsPtKxw453wGpP6F8WZ3L`

Immediately after submission, the contract showed:

- `pending_latches_for("mike.testnet") == ["alpha", "beta", "gamma"]`

### 3.3 Conduct in a nontrivial order

The follow-up call was:

```bash
NEAR_ENV=testnet near call yield-sequencer.x.mike.testnet \
  conduct '{"caller_id":"mike.testnet","order":["beta","alpha","gamma"]}' \
  --accountId mike.testnet
```

Reference conduct tx:

- `BW3fmRbzZGFdFrE37uxX2cMzHj6Ur1mG7FCEmjAXKVmT`

Return value:

- `3`

After completion:

- `pending_latches_for("mike.testnet") == []`

## 4. What the trace actually proved

The tricky part is where to look.

`conduct` itself does not render as "resume child A, then child B, then child
C" in its own receipt tree. Instead, it injects the resume payload that wakes
the yielded callback receipts created earlier by the original latch tx.

So the proof lives on the original latch transaction.

### 4.1 Reference ordering evidence

Observed block heights from `EXPERIMENTAL_tx_status` and block lookups:

- conduct transaction included at block `246214775`
- conduct contract receipt executed at block `246214776`
- resumed callback `beta` executed at block `246214777`
- resumed callback `alpha` executed at block `246214778`
- resumed callback `gamma` executed at block `246214779`

The labels above came from decoding the `on_latch_resume` callback args on the
original latch tx's yielded callback receipts.

That is the key result:

- the original action order was `alpha, beta, gamma`
- the resumed callback order was `beta, alpha, gamma`

So the later `conduct` call did in fact choose the wake-up order.

### 4.2 Reference transaction hashes

- successful latch tx:
  `4ct5RA1d4x9efJXWGxPBQRLhsPtKxw453wGpP6F8WZ3L`
- successful conduct tx:
  `BW3fmRbzZGFdFrE37uxX2cMzHj6Ur1mG7FCEmjAXKVmT`

These are useful anchor points for future sessions because the trace viewer can
be pointed at them directly while the transactions remain inside the regular
retention window, or later via archival lookup.

## 5. The timeout caveat

This run also exposed the most important weakness in the current POC.

Earlier in the session, a latch transaction was submitted and then left alone
for too long. NEP-519 eventually auto-resumed the yielded callbacks with
`PromiseError::Failed`, but `on_latch_resume` ignored
`#[callback_result] _sig: Result<ResumeSignal, PromiseError>`.

That means the callback still:

- removed the latch entry
- returned the label as though the resume had been intentional
- made the trace look terminally successful

Then a later `conduct` failed because the latch was already gone.

Reference failed conduct tx:

- `7BLRjAWij8omnTE4FKqPRUpJ4qxBopw65Gz3gohjc2zk`

Observed panic:

- `label 'beta' not latched for this caller`

So the current latch POC is only reliable if `conduct` happens promptly.

## 6. Architectural meaning

This is the broader takeaway worth carrying between sessions:

- raw NEAR does not offer direct user control over sibling receipt ordering
- a user-controlled contract can still become the first receiver
- that contract can convert work into yielded child receipts
- explicit resume can then release those children in a user-chosen order

In other words, the sequencing lever does not live in the transaction format.
It lives in the smart-account contract's ability to interpose and manufacture a
different receipt topology.

That is the paradigm shift:

- user signs one transaction to their own smart account
- the smart account does not immediately "broadcast" all external work
- instead it creates yielded handles for the downstream work
- and later resumes them in the declared order

The result is not Ethereum-style synchronous transaction ordering. It is a new
kind of user-owned receipt scheduler.

## 7. Recommended next step

The next meaningful step is to move from inert `latch(label)` callbacks to one
real smart-account-shaped gated action.

Concretely:

- add a `stage_call` / `staged_echo` style method whose resume callback performs
  an actual downstream `FunctionCall` or `Transfer`
- make the callback honor `#[callback_result]` so timeout does not silently
  consume the latch
- drive the same experiment again, but this time prove not only callback order,
  but true downstream effect order: "A completed, then B started, then C
  completed"

That would turn the current proof from "we can order yielded callbacks" into
"the smart account can order real cross-contract work." That feels like the
next genuinely novel milestone.
