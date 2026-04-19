//! `router` — exercises the three *flat* promise shapes the trace viewer has
//! to distinguish at the receipt-DAG level:
//!
//! 1. **Single-hop** (`route_echo`) — returning a `Promise` makes the caller's
//!    outcome `SuccessReceiptId(R_echo)` and `R_echo`'s outcome `SuccessValue(n)`.
//! 2. **`.then()` callback** (`route_echo_then`) — the callback receipt carries
//!    a populated `input_data_ids[]`; its parent's `output_data_receivers[]`
//!    contains the matching `(data_id, receiver_id)`.
//! 3. **`promise_and` fan-out** (`route_echo_and`) — two parallel echoes join
//!    into one callback with two `input_data_ids`. The walker must dedupe
//!    by `receipt_id` because the DAG isn't a tree.
//!
//! The fourth pattern (yield / resume) lives on `contracts/smart-account/`'s
//! `execute_steps` / `register_step` / `run_sequence` surface — this contract stays focused on
//! flat promise shapes so the pedagogy separates cleanly.

use near_sdk::serde_json::from_slice;
use near_sdk::{env, ext_contract, near, AccountId, Gas, PanicOnDefault, Promise};

const GAS_ECHO: Gas = Gas::from_tgas(5);
const GAS_CALLBACK: Gas = Gas::from_tgas(5);

/// Cap for a single echo result read back via `promise_result_checked`. An
/// echo returns a `u32` encoded as JSON (≤10 bytes); 64 is a generous ceiling
/// that still bounds gas in the out-of-gas-protection path.
const MAX_ECHO_RESULT_LEN: usize = 64;

#[ext_contract(ext_echo)]
pub trait ExtEcho {
    fn echo(&self, n: u32) -> u32;
    fn echo_log(&self, n: u32) -> u32;
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Router {}

#[near]
impl Router {
    #[init]
    pub fn new() -> Self {
        Self {}
    }

    // -------- 1. single-hop --------

    pub fn route_echo(&self, callee: AccountId, n: u32) -> Promise {
        ext_echo::ext(callee).with_static_gas(GAS_ECHO).echo(n)
    }

    // -------- 2. .then() callback --------

    pub fn route_echo_then(&self, callee: AccountId, n: u32) -> Promise {
        ext_echo::ext(callee)
            .with_static_gas(GAS_ECHO)
            .echo(n)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_echo(),
            )
    }

    #[private]
    pub fn on_echo(&self, #[callback_unwrap] n: u32) -> u32 {
        n.saturating_mul(2)
    }

    // -------- 3. promise_and fan-out --------

    pub fn route_echo_and(&self, callees: Vec<AccountId>, n: u32) -> Promise {
        assert!(
            callees.len() >= 2,
            "need at least two callees for promise_and"
        );
        let a = ext_echo::ext(callees[0].clone())
            .with_static_gas(GAS_ECHO)
            .echo(n);
        let b = ext_echo::ext(callees[1].clone())
            .with_static_gas(GAS_ECHO)
            .echo(n);
        a.and(b).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_CALLBACK)
                .on_echo_and(),
        )
    }

    #[private]
    pub fn on_echo_and(&self) -> Vec<u32> {
        let count = env::promise_results_count();
        (0..count)
            .map(
                |i| match env::promise_result_checked(i, MAX_ECHO_RESULT_LEN) {
                    Ok(bytes) => from_slice::<u32>(&bytes).unwrap_or(0),
                    Err(_) => 0,
                },
            )
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn current() -> AccountId {
        "router.test.near".parse().unwrap()
    }

    fn ctx() {
        let mut b = VMContextBuilder::new();
        b.current_account_id(current())
            .predecessor_account_id(current());
        testing_env!(b.build());
    }

    #[test]
    fn on_echo_doubles() {
        ctx();
        let r = Router::new();
        assert_eq!(r.on_echo(21), 42);
    }
}
