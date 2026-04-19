//! Core domain types for the smart-account contract.
//!
//! These are intentionally kept free of any contract-specific logic so they can
//! be consumed by other contracts and off-chain tooling via the
//! `smart-account-types` crate.

use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::{near, AccountId};

/// Per-step safety policy: how a step in a multi-step plan should resolve
/// before the smart account advances to the next step.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum StepPolicy {
    /// Treat the target receipt's own outcome as truth.
    #[default]
    Direct,
    /// Dispatch to an adapter contract that exposes one honest top-level
    /// success/failure surface for a protocol with messy internal async work.
    Adapter {
        adapter_id: AccountId,
        adapter_method: String,
    },
    /// Post-call assertion mode. After the target resolves successfully, fire
    /// a caller-specified postcheck call and advance the sequence only if the
    /// postcheck returns bytes matching `expected_return` exactly. Mismatch
    /// halts the sequence as `DownstreamFailed`, same as any other resolve
    /// failure.
    Asserted {
        /// Contract hosting the postcheck call. Often the target itself
        /// (asking the target to prove its own state), but any contract works.
        assertion_id: AccountId,
        /// Method on `assertion_id` to call after the target resolves. Called
        /// as a regular FunctionCall receipt (not an enforced read-only view),
        /// so gas and receipts are real and the caller must choose a
        /// trustworthy postcheck surface.
        assertion_method: String,
        /// Raw bytes the postcheck call receives as its JSON body. Use
        /// base64-of-`{}` (`"e30="`) on the wire for no-arg methods.
        assertion_args: Base64VecU8,
        /// Exact bytes the postcheck call must return. Compared byte-for-byte
        /// against `env::promise_result_checked(0, MAX_CALLBACK_RESULT_BYTES)`.
        expected_return: Base64VecU8,
        /// Gas for the `assertion_id.assertion_method` postcheck FunctionCall,
        /// in TGas.
        assertion_gas_tgas: u64,
    },
}

/// Standard argument shape the smart account uses when dispatching an adapter
/// policy call.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AdapterDispatchInput {
    pub target_id: AccountId,
    pub method_name: String,
    pub args: Base64VecU8,
    pub attached_deposit_yocto: U128,
    pub gas_tgas: u64,
}
