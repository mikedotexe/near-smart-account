# smart-account-types

Shared type definitions for the [`smart-account-contract`](../contract) NEAR smart
contract. Other contracts and off-chain tooling that want to speak the same shapes
(step policy, adapter dispatch envelopes, and future request/response shapes
for the intent-executor flow) can pull in this lightweight crate instead of
depending on the contract itself.

The split mirrors the CosmWasm convention of
[`contracts/` + `packages/`](https://github.com/CosmWasm/cw-plus): the compiled
Wasm binary lives in `contract/`, and the consumable type definitions live here.

## Layout

- `src/lib.rs` — re-exports the public surface
- `src/types.rs` — core compatibility and step-policy types
