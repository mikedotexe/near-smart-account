//! `pathological-router` — four methods, each a distinct wild-contract
//! pathology a real target might exhibit in the wild.
//!
//! Companion to `wild-router`:
//! - `wild-router.route_echo_fire_and_forget` exhibits dishonest async
//!   (real work happens, hidden via `.detach()`; outer returns plain
//!   success value).
//! - This crate covers four distinct pathologies that fire-and-forget
//!   does not: gas exhaustion, pure lie (no work at all), decoy-promise
//!   indirection (settle chains on a decoy while real work detaches),
//!   and oversized return payload (probes the 16 KiB settle ceiling).
//!
//! Each method is intentionally minimal so chapter 19 can characterize
//! what the smart-account's `Direct` completion policy sees for each
//! shape, and where signal is lost.

use near_sdk::{env, ext_contract, near, AccountId, Gas, Promise};

const GAS_DETACHED_REAL: Gas = Gas::from_tgas(10);
const GAS_DECOY: Gas = Gas::from_tgas(5);

#[ext_contract(ext_echo)]
#[allow(dead_code)]
trait ExtEcho {
    fn echo(&self, n: u32) -> u32;
}

#[near(contract_state)]
#[derive(Default)]
pub struct PathologicalRouter {
    /// Incremented ONLY by `do_honest_work`. The pathological methods
    /// deliberately leave it untouched so an external observer (or
    /// future adapter in v1.1) can distinguish "work claimed" vs
    /// "work done" by polling `get_calls_completed`.
    pub calls_completed: u32,

    /// Set by `do_honest_work` (with its label) and by
    /// `return_decoy_promise` (with a fixed sentinel). Not touched by
    /// the pure-lie or gas-burn or oversized pathologies.
    pub last_burst: Option<String>,
}

#[near]
impl PathologicalRouter {
    /// Baseline honest method. Use this first in chapter 19 to establish
    /// what a well-behaved call's three-surfaces view looks like.
    pub fn do_honest_work(&mut self, label: String) -> String {
        self.calls_completed += 1;
        self.last_burst = Some(label.clone());
        format!("completed:{label}")
    }

    /// Pathology 1 — gas-exhaustion.
    ///
    /// Spins forever hashing its own output. Each iteration is a real
    /// host-function call (`sha256_array`) with well-understood per-call
    /// cost, so gas depletes predictably. From the smart-account's
    /// perspective this is indistinguishable from an honest panic:
    /// `on_stage_call_settled` receives `PromiseError::Failed`.
    pub fn burn_gas(&self) {
        let mut seed: [u8; 32] = [0; 32];
        loop {
            seed = env::sha256_array(&seed);
        }
    }

    /// Pathology 2 — pure lie (false success).
    ///
    /// Returns the literal string `"ok"` as SuccessValue without doing
    /// any work: no state mutation, no downstream promise. `Direct`
    /// settle sees `Ok(bytes)` where bytes is the JSON-encoded `"ok"`
    /// (4 bytes on the wire including quotes), and advances the
    /// sequence. `get_calls_completed` remains 0, proving the lie.
    pub fn noop_claim_success(&self, label: String) -> String {
        env::log_str(&format!(
            "pathological-router: noop_claim_success({label}); skipping real work"
        ));
        "ok".to_string()
    }

    /// Pathology 3 — decoy-promise return.
    ///
    /// Detaches the "real" work as a fire-and-forget echo call
    /// (`echo(42)`), and returns a SEPARATE Promise to a cheap decoy
    /// (`echo(0)`). The smart-account's `on_stage_call_settled` chains
    /// on the returned Promise, sees the decoy's success, and advances.
    /// The real work's outcome is never examined.
    ///
    /// Visually distinct from fire-and-forget in the receipt DAG: there
    /// are TWO child receipts from this call's outcome — one for the
    /// detached echo(42) (unreturned) and one for the chained echo(0)
    /// (the decoy). A naive trace-viewer audit that trusts "the thing
    /// settle chained on succeeded" is fooled.
    pub fn return_decoy_promise(&mut self, callee: AccountId) -> Promise {
        self.last_burst = Some("decoy-returned".to_string());

        ext_echo::ext(callee.clone())
            .with_static_gas(GAS_DETACHED_REAL)
            .echo(42)
            .detach();

        ext_echo::ext(callee).with_static_gas(GAS_DECOY).echo(0)
    }

    /// Pathology 4 — oversized return payload.
    ///
    /// Returns a JSON-encoded string of size `kb * 1024` bytes (plus
    /// two surrounding quote bytes from JSON wire form). The
    /// `MAX_CALLBACK_RESULT_BYTES` ceiling in smart-account is 16 KiB,
    /// so `kb = 20` pushes comfortably past it.
    ///
    /// This probe empirically resolves whether near-sdk's
    /// `promise_result_checked` treats oversized results as failure
    /// (`Err(PromiseError::Failed)`) or silently truncates to max-len
    /// (`Ok(truncated_bytes)`). CLAUDE.md claims the former; the
    /// Explore agent's read of the runtime claims the latter. Whichever
    /// is observed by chapter 19's probe becomes the ground truth.
    pub fn return_oversized_payload(&self, kb: u32) -> String {
        "x".repeat((kb as usize) * 1024)
    }

    pub fn get_calls_completed(&self) -> u32 {
        self.calls_completed
    }

    pub fn get_last_burst(&self) -> Option<String> {
        self.last_burst.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn honest_work_increments_counter_and_records_label() {
        let mut c = PathologicalRouter::default();
        assert_eq!(c.calls_completed, 0);
        assert_eq!(c.last_burst, None);

        let result = c.do_honest_work("alpha".to_string());

        assert_eq!(result, "completed:alpha");
        assert_eq!(c.calls_completed, 1);
        assert_eq!(c.last_burst, Some("alpha".to_string()));

        c.do_honest_work("beta".to_string());
        assert_eq!(c.calls_completed, 2);
        assert_eq!(c.last_burst, Some("beta".to_string()));
    }

    #[test]
    fn noop_claim_success_returns_ok_and_does_not_touch_state() {
        let c = PathologicalRouter::default();
        assert_eq!(c.calls_completed, 0);

        let result = c.noop_claim_success("would-have-been-alpha".to_string());

        assert_eq!(result, "ok");
        // State is immutable (`&self`), but explicitly assert invariants:
        assert_eq!(c.calls_completed, 0);
        assert_eq!(c.last_burst, None);
    }

    #[test]
    fn oversized_payload_returns_requested_size() {
        let c = PathologicalRouter::default();
        let payload = c.return_oversized_payload(20);
        assert_eq!(payload.len(), 20 * 1024);
        assert!(payload.chars().all(|ch| ch == 'x'));
    }

    #[test]
    fn oversized_payload_zero_returns_empty() {
        let c = PathologicalRouter::default();
        let payload = c.return_oversized_payload(0);
        assert_eq!(payload.len(), 0);
    }
}
