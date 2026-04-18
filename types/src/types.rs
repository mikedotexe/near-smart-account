//! Core domain types for the smart-account contract.
//!
//! These are intentionally kept free of any contract-specific logic so they can
//! be consumed by other contracts and off-chain tooling via the
//! `smart-account-types` crate.

use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::{near, AccountId};

/// How a staged call should be considered "done" before the sequencer
/// advances to the next step.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum SettlePolicy {
    /// Treat the target receipt's own outcome as truth.
    #[default]
    Direct,
    /// Dispatch to an adapter contract that exposes one honest top-level
    /// success/failure surface for a protocol with messy internal async work.
    Adapter {
        adapter_id: AccountId,
        adapter_method: String,
    },
    /// Reserved for a future "post-call assertion" mode.
    Asserted,
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
