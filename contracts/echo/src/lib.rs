//! `echo` — the simplest possible callee.
//!
//! Used as the downstream target for every `router` demo so the trace viewer
//! has a stable, boring receipt to render at the leaves of the DAG. Two
//! variants:
//!
//! - `echo(n)` — returns `n` with no logs. Produces the most minimal
//!   `ExecutionOutcomeView`: empty `logs`, single `SuccessValue`.
//! - `echo_log(n)` — emits `env::log_str` before returning, so the trace
//!   viewer has something non-empty in `outcome.logs` to render.

use near_sdk::{env, near};

#[near(contract_state)]
#[derive(Default)]
pub struct Echo;

#[near]
impl Echo {
    pub fn echo(&self, n: u32) -> u32 {
        n
    }

    pub fn echo_log(&self, n: u32) -> u32 {
        env::log_str(&format!("echo({n})"));
        n
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn echo_returns_input() {
        let c = Echo;
        assert_eq!(c.echo(42), 42);
        assert_eq!(c.echo_log(7), 7);
    }
}
