# Reproducible build — v4.0.2-ops on `mike.near`

Every reference run in [`MAINNET-PROOF.md`](./MAINNET-PROOF.md)
pins a specific deployed contract: kernel version `v4.0.2-ops` on
`mike.near`. Its on-chain `code_hash` is the base58 SHA-256 of the
WASM the validator actually runs. This doc's job: let any reviewer
rebuild that WASM locally and confirm the hash matches.

## The claim

Building `./scripts/build-all.sh` with the pinned toolchain
(`rust-toolchain.toml`) at this commit produces a
`res/smart_account_local.wasm` whose SHA-256 matches the deployed
`code_hash` exactly:

| Surface | Value |
|---|---|
| Pinned toolchain | `nightly-2026-04-17` (rustc 1.97.0-nightly, commit `7af3402cd`, built 2026-04-16) |
| Expected `sha256(smart_account_local.wasm)` (hex) | `c0df7f6c68bbd15d218506576b0aa2b78554f957de828c241e55e960b890666f` |
| Deployed `mike.near.code_hash` (base58) | `DytwYt4tMP849QjXAQZFeEMuvMYUVq1bvyhwk8JWQvy4` |
| Pinned-at block | `8WWSCDqcBWusDP8SsTLLye5w42zjAm5ZuC85p5oMEY8F` (pass fire) |

The hex hash base58-encodes to the deployed code_hash, so a byte-
for-byte match on the local build proves the source at this commit
is what produced the binary the chain runs.

## The recipe

```bash
# 1. Pinned toolchain is picked up automatically via rust-toolchain.toml.
#    Confirm:
rustup show active-toolchain
# → nightly-2026-04-17-aarch64-apple-darwin (or your host triple)

rustc --version
# → rustc 1.97.0-nightly (7af3402cd 2026-04-16)

# 2. Build.
./scripts/build-all.sh

# 3. Hash + compare.
shasum -a 256 res/smart_account_local.wasm
# Expected (hex):
#   c0df7f6c68bbd15d218506576b0aa2b78554f957de828c241e55e960b890666f

# 4. Cross-check against the live contract's code_hash.
curl -s -X POST https://archival-rpc.mainnet.fastnear.com \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{
    "request_type":"view_account",
    "block_id":"8WWSCDqcBWusDP8SsTLLye5w42zjAm5ZuC85p5oMEY8F",
    "account_id":"mike.near"
  }}' | jq -r '.result.code_hash'
# Expected:
#   "DytwYt4tMP849QjXAQZFeEMuvMYUVq1bvyhwk8JWQvy4"
```

To confirm the hex ↔ base58 equivalence by hand:

```bash
python3 -c '
B58="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
def b58d(s):
    n=0
    for c in s: n = n*58 + B58.index(c)
    return n.to_bytes((n.bit_length()+7)//8, "big")
print(b58d("DytwYt4tMP849QjXAQZFeEMuvMYUVq1bvyhwk8JWQvy4").hex())
'
# → c0df7f6c68bbd15d218506576b0aa2b78554f957de828c241e55e960b890666f
```

## What this proves, and what it doesn't

**Proven:** `res/smart_account_local.wasm` built from this tree at
this commit, under the pinned toolchain, has the same SHA-256 as
the WASM the NEAR validator runs for `mike.near` at the pass-fire
block. The bridge from *"our source"* to *"the deployed binary"*
is one hash comparison.

**Scope caveat — host vs. hermetic.** This recipe relies on a
host toolchain. The author's machine (macOS aarch64, Apple Silicon)
produces the expected hash reliably. Rust nightly builds can vary
across platforms (linker flags, stdlib source compilation under
`-Zbuild-std`, libc version). If your host produces a *different*
hash, the most likely culprits are:

- Toolchain mismatch. Check `rustc --version` matches exactly
  `rustc 1.97.0-nightly (7af3402cd 2026-04-16)`.
- `NEAR_WASM_RUSTFLAGS` overridden in your env. Default is
  `-C link-arg=-s -C target-cpu=mvp -C link-arg=--import-undefined`.
  See `scripts/build-all.sh` for the exact flags.
- Cross-platform variance that `rust-toolchain.toml` + host-linker
  can't fully constrain.

A future hardening step is a `Dockerfile.build` that freezes OS +
linker + glibc alongside the toolchain, for bit-exact reproducibility
across any host. That's tracked as a follow-up; this commit pins
the toolchain as the first layer.

**What this does NOT prove.** That the deployed contract has not
been redeployed *since* the pass-fire block to a different WASM.
Verify freshness by re-running step 4 against the current finality
tip (swap `block_id` for `"finality":"final"`).

## For maintainers — when v4.0.3 ships

Re-deploying a new kernel version should refresh this doc:

1. Bump `rust-toolchain.toml` only if the toolchain also moves.
2. Update the table at top with the new `code_hash`, hex hash, and
   the tx/block that captured the deploy.
3. Add the new deploy to
   [`MAINNET-MIKE-NEAR-JOURNAL.md`](./MAINNET-MIKE-NEAR-JOURNAL.md).
4. Re-run `./scripts/verify-mainnet-claims.sh` to confirm the
   reference artifact still reflects the live state.
