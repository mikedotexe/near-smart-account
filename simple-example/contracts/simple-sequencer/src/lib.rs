//! `simple-sequencer` — the smallest contract in this repo that still proves
//! the interesting thing.
//!
//! A caller submits one multi-action transaction whose actions all hit
//! `stage_call(...)`. Each action returns a yielded callback receipt. A later
//! `run_sequence(...)` resumes only the first step; each later step resumes
//! only after the previous real downstream call has settled.
//!
//! Compared to `contracts/smart-account/`, this intentionally omits account
//! semantics and product layers:
//!
//! - no owner / delegated executor model
//! - no durable templates or triggers
//! - no per-call completion policy or adapters
//! - no smart-account framing beyond the shared `stage_call` / `run_sequence`
//!   terminology

use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::serde_json::{self, json};
use near_sdk::store::IterableMap;
use near_sdk::{
    env, near, AccountId, BorshStorageKey, Gas, GasWeight, NearToken, PanicOnDefault, Promise,
    PromiseError, PromiseOrValue, YieldId,
};

const STAGE_SETTLE_CALLBACK_GAS_TGAS: u64 = 20;
const STAGE_RESUME_OVERHEAD_TGAS: u64 = 20;
const MAX_CONTRACT_GAS_TGAS: u64 = 1_000;
const STAGE_GAS_SLACK_TGAS: u64 = 20;
const MAX_STAGE_CALL_GAS_TGAS: u64 = MAX_CONTRACT_GAS_TGAS
    - STAGE_SETTLE_CALLBACK_GAS_TGAS
    - STAGE_RESUME_OVERHEAD_TGAS
    - STAGE_GAS_SLACK_TGAS;
const MAX_CALLBACK_RESULT_BYTES: usize = 16 * 1024;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    StagedCalls,
    SequenceQueue,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
struct SequenceCall {
    step_id: String,
    target_id: AccountId,
    method_name: String,
    args: Vec<u8>,
    attached_deposit_yocto: u128,
    gas_tgas: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct StagedCall {
    pub yield_id: YieldId,
    call: SequenceCall,
    pub created_at_ms: u64,
}

#[near(serializers = [json])]
pub struct StagedCallView {
    pub step_id: String,
    pub target_id: AccountId,
    pub method_name: String,
    pub args: Base64VecU8,
    pub attached_deposit_yocto: U128,
    pub gas_tgas: u64,
    pub created_at_ms: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    pub staged_calls: IterableMap<String, StagedCall>,
    pub sequence_queue: IterableMap<String, Vec<String>>,
}

#[near]
impl Contract {
    #[init]
    pub fn new() -> Self {
        Self {
            staged_calls: IterableMap::new(StorageKey::StagedCalls),
            sequence_queue: IterableMap::new(StorageKey::SequenceQueue),
        }
    }

    /// Register a yielded downstream call under the predecessor's namespace.
    ///
    /// Each `stage_call` action in one transaction produces its own yielded
    /// callback receipt, which is the topology we later control with
    /// `run_sequence`.
    pub fn stage_call(
        &mut self,
        target_id: AccountId,
        method_name: String,
        args: Base64VecU8,
        attached_deposit_yocto: U128,
        gas_tgas: u64,
        step_id: String,
    ) -> Promise {
        let caller_id = env::predecessor_account_id();
        let call = Self::sequence_call_from_raw(
            step_id,
            target_id,
            method_name,
            args.0,
            attached_deposit_yocto.0,
            gas_tgas,
        );
        self.register_staged_yield_for_caller(&caller_id, call)
    }

    /// Resume only the first pending step immediately; later steps remain in a
    /// queue and advance only after each real downstream call settles.
    pub fn run_sequence(&mut self, caller_id: AccountId, order: Vec<String>) -> u32 {
        assert_eq!(
            env::predecessor_account_id(),
            caller_id,
            "caller_id must match predecessor"
        );
        self.start_sequence_release_for_caller(&caller_id, order)
    }

    #[private]
    pub fn on_stage_call_resume(
        &mut self,
        caller_id: AccountId,
        step_id: String,
        #[callback_result] resume_signal: Result<(), PromiseError>,
    ) -> PromiseOrValue<()> {
        let key = staged_call_key(&caller_id, &step_id);
        let Some(staged) = self.staged_calls.get(&key).cloned() else {
            env::log_str(&format!(
                "stage_call '{step_id}' for {caller_id} woke up but was no longer staged"
            ));
            return PromiseOrValue::Value(());
        };

        match resume_signal {
            Ok(()) => {
                env::log_str(&format!(
                    "stage_call '{step_id}' for {caller_id} resumed and is dispatching {}.{}",
                    staged.call.target_id, staged.call.method_name
                ));
            }
            Err(error) => {
                self.staged_calls.remove(&key);
                self.clear_queue_for_caller(&caller_id);
                env::log_str(&format!(
                    "stage_call '{step_id}' for {caller_id} could not resume, so its staged yield was dropped and the sequence halted: {error:?}"
                ));
                return PromiseOrValue::Value(());
            }
        }

        let finish_args = Self::encode_callback_args(&caller_id, &step_id);
        let downstream = Self::dispatch_promise_for_call(&staged.call);
        let finish = Promise::new(env::current_account_id()).function_call(
            "on_stage_call_settled",
            finish_args,
            NearToken::from_yoctonear(0),
            Gas::from_tgas(STAGE_SETTLE_CALLBACK_GAS_TGAS),
        );
        PromiseOrValue::Promise(downstream.then(finish))
    }

    #[private]
    pub fn on_stage_call_settled(&mut self, caller_id: AccountId, step_id: String) {
        let key = staged_call_key(&caller_id, &step_id);
        let dispatch_summary = self
            .staged_calls
            .get(&key)
            .map(|staged| format!("{}.{}", staged.call.target_id, staged.call.method_name))
            .unwrap_or_else(|| "unknown dispatch".to_string());
        let result = env::promise_result_checked(0, MAX_CALLBACK_RESULT_BYTES);

        self.staged_calls.remove(&key);

        match result {
            Ok(bytes) => self.progress_after_successful_settlement(
                &caller_id,
                &step_id,
                &dispatch_summary,
                bytes.len(),
            ),
            Err(error) => {
                self.clear_queue_for_caller(&caller_id);
                env::log_str(&format!(
                    "stage_call '{step_id}' for {caller_id} failed downstream via {dispatch_summary}; ordered release stopped here: {error:?}"
                ));
            }
        }
    }

    pub fn staged_calls_for(&self, caller_id: AccountId) -> Vec<StagedCallView> {
        let prefix = format!("{caller_id}#");
        let mut staged: Vec<_> = self
            .staged_calls
            .iter()
            .filter_map(|(key, staged)| {
                if key.starts_with(&prefix) {
                    Some(Self::staged_call_view(staged))
                } else {
                    None
                }
            })
            .collect();
        staged.sort_by(|a, b| {
            a.created_at_ms
                .cmp(&b.created_at_ms)
                .then_with(|| a.step_id.cmp(&b.step_id))
        });
        staged
    }

    pub fn queued_steps_for(&self, caller_id: AccountId) -> Vec<String> {
        self.sequence_queue
            .get(&sequence_queue_key(&caller_id))
            .cloned()
            .unwrap_or_default()
    }
}

impl Contract {
    fn sequence_call_from_raw(
        step_id: String,
        target_id: AccountId,
        method_name: String,
        args: Vec<u8>,
        attached_deposit_yocto: u128,
        gas_tgas: u64,
    ) -> SequenceCall {
        let call = SequenceCall {
            step_id,
            target_id,
            method_name,
            args,
            attached_deposit_yocto,
            gas_tgas,
        };
        Self::validate_sequence_call(&call);
        call
    }

    fn validate_sequence_call(call: &SequenceCall) {
        assert!(!call.step_id.is_empty(), "step_id cannot be empty");
        assert!(!call.method_name.is_empty(), "method_name cannot be empty");
        assert!(call.gas_tgas > 0, "gas_tgas must be greater than zero");
        assert!(
            call.gas_tgas <= MAX_STAGE_CALL_GAS_TGAS,
            "gas_tgas is too large for a staged direct call"
        );
    }

    fn staged_call_view(staged: &StagedCall) -> StagedCallView {
        StagedCallView {
            step_id: staged.call.step_id.clone(),
            target_id: staged.call.target_id.clone(),
            method_name: staged.call.method_name.clone(),
            args: Base64VecU8::from(staged.call.args.clone()),
            attached_deposit_yocto: U128(staged.call.attached_deposit_yocto),
            gas_tgas: staged.call.gas_tgas,
            created_at_ms: staged.created_at_ms,
        }
    }

    fn register_staged_yield_for_caller(
        &mut self,
        caller_id: &AccountId,
        call: SequenceCall,
    ) -> Promise {
        let key = staged_call_key(caller_id, &call.step_id);
        assert!(
            self.staged_calls.get(&key).is_none(),
            "step_id already staged for this caller"
        );

        let step_id = call.step_id.clone();
        let callback_args = Self::encode_callback_args(caller_id, &call.step_id);
        let (yield_promise, yield_id) = Promise::new_yield(
            "on_stage_call_resume",
            callback_args,
            Gas::from_tgas(
                call.gas_tgas + STAGE_SETTLE_CALLBACK_GAS_TGAS + STAGE_RESUME_OVERHEAD_TGAS,
            ),
            GasWeight::default(),
        );

        self.staged_calls.insert(
            key,
            StagedCall {
                yield_id,
                call,
                created_at_ms: env::block_timestamp_ms(),
            },
        );
        env::log_str(&format!(
            "stage_call '{step_id}' for {caller_id} is staged and waiting for resume"
        ));
        yield_promise
    }

    fn start_sequence_release_for_caller(
        &mut self,
        caller_id: &AccountId,
        order: Vec<String>,
    ) -> u32 {
        assert!(!order.is_empty(), "order cannot be empty");

        let queue_key = sequence_queue_key(caller_id);
        assert!(
            self.sequence_queue.get(&queue_key).is_none(),
            "caller already has a run in flight"
        );
        for step_id in &order {
            assert!(
                self.staged_calls
                    .get(&staged_call_key(caller_id, step_id))
                    .is_some(),
                "step_id '{step_id}' not staged for this caller"
            );
        }

        let n = order.len() as u32;
        let mut iter = order.into_iter();
        let first = iter.next().expect("checked non-empty");
        let rest: Vec<String> = iter.collect();
        if !rest.is_empty() {
            self.sequence_queue.insert(queue_key.clone(), rest);
        }

        if let Err(message) = self.resume_staged_step(caller_id, &first) {
            self.sequence_queue.remove(&queue_key);
            env::panic_str(&message);
        }

        let queued = self
            .sequence_queue
            .get(&queue_key)
            .map(|remaining| remaining.len())
            .unwrap_or(0);
        env::log_str(&format!(
            "sequence for {caller_id} started ordered resume with step '{first}' ({queued} still waiting behind it)"
        ));

        n
    }

    fn progress_after_successful_settlement(
        &mut self,
        caller_id: &AccountId,
        settled_step_id: &str,
        dispatch_summary: &str,
        result_len: usize,
    ) {
        if let Some(next) = self.take_next_queued_step(caller_id) {
            env::log_str(&format!(
                "stage_call '{settled_step_id}' for {caller_id} settled successfully via {dispatch_summary} ({result_len} result bytes); resuming step '{next}' next"
            ));
            if let Err(message) = self.resume_staged_step(caller_id, &next) {
                self.clear_queue_for_caller(caller_id);
                env::log_str(&format!(
                    "stage_call '{settled_step_id}' for {caller_id} settled, but the next staged step '{next}' could not be resumed: {message}"
                ));
            }
        } else {
            env::log_str(&format!(
                "stage_call '{settled_step_id}' for {caller_id} settled successfully via {dispatch_summary} ({result_len} result bytes); sequence completed"
            ));
        }
    }

    fn take_next_queued_step(&mut self, caller_id: &AccountId) -> Option<String> {
        let key = sequence_queue_key(caller_id);
        let mut remaining = self.sequence_queue.get(&key).cloned()?;
        if remaining.is_empty() {
            self.sequence_queue.remove(&key);
            return None;
        }

        let next = remaining.remove(0);
        if remaining.is_empty() {
            self.sequence_queue.remove(&key);
        } else {
            self.sequence_queue.insert(key, remaining);
        }
        Some(next)
    }

    fn resume_staged_step(&self, caller_id: &AccountId, step_id: &str) -> Result<(), String> {
        let key = staged_call_key(caller_id, step_id);
        let staged = self
            .staged_calls
            .get(&key)
            .ok_or_else(|| format!("step_id '{step_id}' not staged for this caller"))?;

        staged
            .yield_id
            .resume(Self::encode_resume_payload())
            .map_err(|_| format!("failed to resume staged step '{step_id}'"))
    }

    fn clear_queue_for_caller(&mut self, caller_id: &AccountId) {
        self.sequence_queue.remove(&sequence_queue_key(caller_id));
    }

    fn dispatch_promise_for_call(call: &SequenceCall) -> Promise {
        Promise::new(call.target_id.clone()).function_call(
            call.method_name.clone(),
            call.args.clone(),
            NearToken::from_yoctonear(call.attached_deposit_yocto),
            Gas::from_tgas(call.gas_tgas),
        )
    }

    fn encode_callback_args(caller_id: &AccountId, step_id: &str) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "caller_id": caller_id,
            "step_id": step_id,
        }))
        .unwrap_or_else(|_| env::panic_str("failed to encode callback args"))
    }

    fn encode_resume_payload() -> Vec<u8> {
        serde_json::to_vec(&())
            .unwrap_or_else(|_| env::panic_str("failed to encode resume payload"))
    }
}

fn sequence_queue_key(caller_id: &AccountId) -> String {
    caller_id.to_string()
}

fn staged_call_key(caller_id: &AccountId, step_id: &str) -> String {
    format!("{caller_id}#{step_id}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{test_vm_config, testing_env, PromiseResult, RuntimeFeesConfig};
    use std::collections::HashMap;

    fn current() -> AccountId {
        "simple-sequencer.near".parse().unwrap()
    }

    fn caller() -> AccountId {
        "mike.near".parse().unwrap()
    }

    fn other() -> AccountId {
        "alice.near".parse().unwrap()
    }

    fn recorder() -> AccountId {
        "recorder.near".parse().unwrap()
    }

    fn ctx(predecessor: AccountId) {
        let mut b = VMContextBuilder::new();
        b.current_account_id(current())
            .signer_account_id(predecessor.clone())
            .predecessor_account_id(predecessor)
            .account_balance(NearToken::from_near(100));
        testing_env!(b.build());
    }

    fn callback_ctx(result: PromiseResult) {
        let mut b = VMContextBuilder::new();
        b.current_account_id(current())
            .signer_account_id(current())
            .predecessor_account_id(current())
            .account_balance(NearToken::from_near(100));
        testing_env!(
            b.build(),
            test_vm_config(),
            RuntimeFeesConfig::test(),
            HashMap::default(),
            vec![result]
        );
    }

    fn stage_args(step_id: &str, value: u32) -> Base64VecU8 {
        Base64VecU8::from(format!(r#"{{"step_id":"{step_id}","value":{value}}}"#).into_bytes())
    }

    #[test]
    fn stage_call_registers_staged_view() {
        ctx(caller());
        let mut c = Contract::new();
        let _ = c.stage_call(
            recorder(),
            "record".into(),
            stage_args("alpha", 7),
            U128(0),
            30,
            "alpha".into(),
        );

        let staged = c.staged_calls_for(caller());
        assert_eq!(staged.len(), 1);
        assert_eq!(staged[0].step_id, "alpha");
        assert_eq!(staged[0].target_id, recorder());
        assert_eq!(staged[0].method_name, "record");
    }

    #[test]
    fn stage_call_allocates_distinct_yield_ids() {
        ctx(caller());
        let mut c = Contract::new();
        let _ = c.stage_call(
            recorder(),
            "record".into(),
            stage_args("alpha", 1),
            U128(0),
            30,
            "alpha".into(),
        );
        let _ = c.stage_call(
            recorder(),
            "record".into(),
            stage_args("beta", 2),
            U128(0),
            30,
            "beta".into(),
        );

        let alpha = c
            .staged_calls
            .get(&staged_call_key(&caller(), "alpha"))
            .unwrap();
        let beta = c
            .staged_calls
            .get(&staged_call_key(&caller(), "beta"))
            .unwrap();
        assert_ne!(alpha.yield_id, beta.yield_id);
    }

    #[test]
    #[should_panic(expected = "step_id already staged for this caller")]
    fn duplicate_step_id_is_rejected() {
        ctx(caller());
        let mut c = Contract::new();
        let _ = c.stage_call(
            recorder(),
            "record".into(),
            stage_args("alpha", 1),
            U128(0),
            30,
            "alpha".into(),
        );
        let _ = c.stage_call(
            recorder(),
            "record".into(),
            stage_args("alpha", 2),
            U128(0),
            30,
            "alpha".into(),
        );
    }

    #[test]
    #[should_panic(expected = "order cannot be empty")]
    fn run_sequence_rejects_empty_order() {
        ctx(caller());
        let mut c = Contract::new();
        c.run_sequence(caller(), vec![]);
    }

    #[test]
    #[should_panic(expected = "not staged for this caller")]
    fn run_sequence_rejects_unknown_step_id() {
        ctx(caller());
        let mut c = Contract::new();
        c.run_sequence(caller(), vec!["phantom".into()]);
    }

    #[test]
    fn run_sequence_only_resumes_first_step_and_queues_rest() {
        ctx(caller());
        let mut c = Contract::new();
        for (step_id, value) in [("alpha", 1_u32), ("beta", 2), ("gamma", 3)] {
            let _ = c.stage_call(
                recorder(),
                "record".into(),
                stage_args(step_id, value),
                U128(0),
                30,
                step_id.into(),
            );
        }

        let released = c.run_sequence(
            caller(),
            vec!["alpha".into(), "beta".into(), "gamma".into()],
        );

        assert_eq!(released, 3);
        assert_eq!(
            c.queued_steps_for(caller()),
            vec!["beta".to_string(), "gamma".to_string()]
        );
        assert!(c
            .staged_calls
            .get(&staged_call_key(&caller(), "alpha"))
            .is_some());
    }

    #[test]
    fn successful_settlement_resumes_next_step_and_drains_queue() {
        ctx(caller());
        let mut c = Contract::new();
        let _ = c.stage_call(
            recorder(),
            "record".into(),
            stage_args("alpha", 1),
            U128(0),
            30,
            "alpha".into(),
        );
        let _ = c.stage_call(
            recorder(),
            "record".into(),
            stage_args("beta", 2),
            U128(0),
            30,
            "beta".into(),
        );

        c.run_sequence(caller(), vec!["alpha".into(), "beta".into()]);

        callback_ctx(PromiseResult::Successful(br#"1"#.to_vec()));
        c.on_stage_call_settled(caller(), "alpha".into());

        assert_eq!(c.queued_steps_for(caller()), Vec::<String>::new());
        assert!(c
            .staged_calls
            .get(&staged_call_key(&caller(), "alpha"))
            .is_none());
        assert!(c
            .staged_calls
            .get(&staged_call_key(&caller(), "beta"))
            .is_some());
    }

    #[test]
    fn resume_failure_clears_queue_and_drops_current_step() {
        ctx(caller());
        let mut c = Contract::new();
        let _ = c.stage_call(
            recorder(),
            "record".into(),
            stage_args("alpha", 1),
            U128(0),
            30,
            "alpha".into(),
        );
        let _ = c.stage_call(
            recorder(),
            "record".into(),
            stage_args("beta", 2),
            U128(0),
            30,
            "beta".into(),
        );
        c.run_sequence(caller(), vec!["alpha".into(), "beta".into()]);

        ctx(current());
        let result = c.on_stage_call_resume(caller(), "alpha".into(), Err(PromiseError::Failed));

        assert!(matches!(result, PromiseOrValue::Value(())));
        assert_eq!(c.queued_steps_for(caller()), Vec::<String>::new());
        assert!(c
            .staged_calls
            .get(&staged_call_key(&caller(), "alpha"))
            .is_none());
        assert!(c
            .staged_calls
            .get(&staged_call_key(&caller(), "beta"))
            .is_some());
    }

    #[test]
    fn downstream_failure_halts_without_resuming_next_step() {
        ctx(caller());
        let mut c = Contract::new();
        let _ = c.stage_call(
            recorder(),
            "record".into(),
            stage_args("alpha", 1),
            U128(0),
            30,
            "alpha".into(),
        );
        let _ = c.stage_call(
            recorder(),
            "record".into(),
            stage_args("beta", 2),
            U128(0),
            30,
            "beta".into(),
        );
        c.run_sequence(caller(), vec!["alpha".into(), "beta".into()]);

        callback_ctx(PromiseResult::Failed);
        c.on_stage_call_settled(caller(), "alpha".into());

        assert_eq!(c.queued_steps_for(caller()), Vec::<String>::new());
        assert!(c
            .staged_calls
            .get(&staged_call_key(&caller(), "alpha"))
            .is_none());
        assert!(c
            .staged_calls
            .get(&staged_call_key(&caller(), "beta"))
            .is_some());
    }

    #[test]
    #[should_panic(expected = "caller_id must match predecessor")]
    fn run_sequence_requires_matching_predecessor() {
        ctx(other());
        let mut c = Contract::new();
        c.run_sequence(caller(), vec!["alpha".into()]);
    }
}
