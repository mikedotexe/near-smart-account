//! `smart-account-contract` — the on-chain half.
//!
//! The public surface is intentionally narrow and centers on two sequencing
//! surfaces:
//!
//! - Manual staged execution:
//!   - `stage_call(...)` registers a staged downstream `FunctionCall` and
//!     creates its yielded callback receipt
//!   - `run_sequence(caller, order)` starts the ordered release by resuming the
//!     first staged step
//!   - `on_stage_call_resume` dispatches the real downstream call only after
//!     that release
//!   - `on_stage_call_settled` advances the next yielded step only after the
//!     downstream call's trusted completion surface has resolved
//! - Balance-trigger automation:
//!   - `save_sequence_template(...)` stores a durable ordered call template
//!   - `create_balance_trigger(...)` stores a balance gate over a template
//!   - `execute_trigger(...)` materializes a fresh staged namespace and starts
//!     the sequence once an authorized caller spends their own transaction gas

use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::serde_json::{self, json};
use near_sdk::store::IterableMap;
use near_sdk::{
    env, near, AccountId, BorshStorageKey, Gas, GasWeight, NearToken, PanicOnDefault, Promise,
    PromiseError, PromiseOrValue, YieldId,
};
use smart_account_types::{AdapterDispatchInput, SettlePolicy};

const STAGE_SETTLE_CALLBACK_GAS_TGAS: u64 = 20;
const STAGE_RESUME_OVERHEAD_TGAS: u64 = 20;
const MAX_CONTRACT_GAS_TGAS: u64 = 1_000;
/// Keep 20 TGas of slack so the originating `stage_call` can still create the
/// yielded callback at the new PV 83 1 PGas ceiling.
const STAGE_GAS_SLACK_TGAS: u64 = 20;
const MAX_STAGE_CALL_GAS_TGAS: u64 = MAX_CONTRACT_GAS_TGAS
    - STAGE_SETTLE_CALLBACK_GAS_TGAS
    - STAGE_RESUME_OVERHEAD_TGAS
    - STAGE_GAS_SLACK_TGAS;
const ADAPTER_SEQUENCE_OVERHEAD_TGAS: u64 = 320;
const MAX_ADAPTER_TARGET_GAS_TGAS: u64 = MAX_STAGE_CALL_GAS_TGAS - ADAPTER_SEQUENCE_OVERHEAD_TGAS;
/// Callback-visible settlement is intentionally bounded; oversized success
/// payloads are treated as sequencer failure rather than partial success.
const MAX_CALLBACK_RESULT_BYTES: usize = 16 * 1024;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    StagedCalls,
    SequenceQueue,
    SequenceTemplates,
    BalanceTriggers,
    AutomationRuns,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct SequenceCall {
    pub step_id: String,
    pub target_id: AccountId,
    pub method_name: String,
    pub args: Vec<u8>,
    pub attached_deposit_yocto: u128,
    pub gas_tgas: u64,
    pub settle_policy: SettlePolicy,
}

#[near(serializers = [json])]
pub struct SequenceCallInput {
    pub step_id: String,
    pub target_id: AccountId,
    pub method_name: String,
    pub args: Base64VecU8,
    pub attached_deposit_yocto: U128,
    pub gas_tgas: u64,
    #[serde(default)]
    pub settle_policy: SettlePolicy,
}

#[near(serializers = [json])]
pub struct SequenceCallView {
    pub step_id: String,
    pub target_id: AccountId,
    pub method_name: String,
    pub args: Base64VecU8,
    pub attached_deposit_yocto: U128,
    pub gas_tgas: u64,
    pub settle_policy: SettlePolicy,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct StagedCall {
    pub yield_id: YieldId,
    pub call: SequenceCall,
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
    pub settle_policy: SettlePolicy,
    pub created_at_ms: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct SequenceTemplate {
    pub calls: Vec<SequenceCall>,
    pub saved_at_ms: u64,
    pub total_attached_deposit_yocto: u128,
}

#[near(serializers = [json])]
pub struct SequenceTemplateView {
    pub sequence_id: String,
    pub calls: Vec<SequenceCallView>,
    pub contains_adapter_calls: bool,
    pub saved_at_ms: u64,
    pub total_attached_deposit_yocto: U128,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AutomationRunStatus {
    InFlight,
    Succeeded,
    DownstreamFailed,
    ResumeFailed,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct AutomationRun {
    pub trigger_id: String,
    pub sequence_id: String,
    pub sequence_namespace: String,
    pub run_nonce: u32,
    pub executor_id: AccountId,
    pub started_at_ms: u64,
    pub finished_at_ms: Option<u64>,
    pub status: AutomationRunStatus,
    pub failed_step_id: Option<String>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct BalanceTrigger {
    pub sequence_id: String,
    pub min_balance_yocto: u128,
    pub max_runs: u32,
    pub runs_started: u32,
    pub in_flight: bool,
    pub last_executor_id: Option<AccountId>,
    pub last_started_at_ms: Option<u64>,
    pub last_finished_at_ms: Option<u64>,
    pub last_run_namespace: Option<String>,
    pub last_run_outcome: Option<AutomationRunStatus>,
    pub created_at_ms: u64,
}

#[near(serializers = [json])]
pub struct BalanceTriggerView {
    pub trigger_id: String,
    pub sequence_id: String,
    pub min_balance_yocto: U128,
    pub max_runs: u32,
    pub runs_started: u32,
    pub in_flight: bool,
    pub last_executor_id: Option<AccountId>,
    pub last_started_at_ms: Option<u64>,
    pub last_finished_at_ms: Option<u64>,
    pub last_run_namespace: Option<String>,
    pub last_run_outcome: Option<AutomationRunStatus>,
    pub created_at_ms: u64,
}

#[near(serializers = [json])]
pub struct TriggerExecutionView {
    pub trigger_id: String,
    pub sequence_id: String,
    pub sequence_namespace: String,
    pub run_nonce: u32,
    pub executor_id: AccountId,
    pub started_at_ms: u64,
    pub call_count: u32,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    pub owner_id: AccountId,
    pub authorized_executor: Option<AccountId>,
    pub staged_calls: IterableMap<String, StagedCall>,
    pub sequence_queue: IterableMap<String, Vec<String>>,
    pub sequence_templates: IterableMap<String, SequenceTemplate>,
    pub balance_triggers: IterableMap<String, BalanceTrigger>,
    pub automation_runs: IterableMap<String, AutomationRun>,
}

#[near]
impl Contract {
    #[init]
    pub fn new() -> Self {
        Self::new_with_owner(env::predecessor_account_id())
    }

    #[init]
    pub fn new_with_owner(owner_id: AccountId) -> Self {
        Self {
            owner_id,
            authorized_executor: None,
            staged_calls: IterableMap::new(StorageKey::StagedCalls),
            sequence_queue: IterableMap::new(StorageKey::SequenceQueue),
            sequence_templates: IterableMap::new(StorageKey::SequenceTemplates),
            balance_triggers: IterableMap::new(StorageKey::BalanceTriggers),
            automation_runs: IterableMap::new(StorageKey::AutomationRuns),
        }
    }

    // --- Manual staged execution ---

    pub fn get_authorized_executor(&self) -> Option<AccountId> {
        self.authorized_executor.clone()
    }

    pub fn set_authorized_executor(&mut self, authorized_executor: Option<AccountId>) {
        self.assert_owner();
        self.authorized_executor = authorized_executor;
    }

    /// Register a staged downstream call under `manual:{predecessor}`.
    ///
    /// The returned yielded promise is what makes each action in a multi-action
    /// transaction show up as its own child callback receipt in the trace.
    pub fn stage_call(
        &mut self,
        target_id: AccountId,
        method_name: String,
        args: Base64VecU8,
        attached_deposit_yocto: U128,
        gas_tgas: u64,
        step_id: String,
        settle_policy: Option<SettlePolicy>,
    ) -> Promise {
        let caller = env::predecessor_account_id();
        let namespace = manual_namespace(&caller);
        let call = Self::sequence_call_from_raw(
            step_id,
            target_id,
            method_name,
            args.0,
            attached_deposit_yocto.0,
            gas_tgas,
            settle_policy.unwrap_or_default(),
        );
        self.register_staged_yield_in_namespace(&namespace, call)
    }

    /// Resume the first pending step immediately and leave the rest queued so
    /// `on_stage_call_settled` can advance them one by one after each real
    /// downstream call completes.
    pub fn run_sequence(&mut self, caller_id: AccountId, order: Vec<String>) -> u32 {
        self.assert_executor();
        self.start_sequence_release_in_namespace(&manual_namespace(&caller_id), order)
    }

    #[private]
    pub fn on_stage_call_resume(
        &mut self,
        sequence_namespace: String,
        step_id: String,
        #[callback_result] resume_signal: Result<(), PromiseError>,
    ) -> PromiseOrValue<()> {
        let key = staged_call_key(&sequence_namespace, &step_id);
        let Some(staged) = self.staged_calls.get(&key).cloned() else {
            env::log_str(&format!(
                "stage_call '{step_id}' in {sequence_namespace} woke up but was no longer staged"
            ));
            return PromiseOrValue::Value(());
        };

        match resume_signal {
            Ok(()) => {
                env::log_str(&format!(
                    "stage_call '{step_id}' in {sequence_namespace} resumed and is dispatching real downstream work via {}",
                    Self::call_dispatch_summary(&staged.call),
                ));
            }
            Err(error) => {
                self.staged_calls.remove(&key);
                self.sequence_queue.remove(&sequence_namespace);
                self.finish_automation_run(
                    &sequence_namespace,
                    AutomationRunStatus::ResumeFailed,
                    Some(step_id.clone()),
                );
                env::log_str(&format!(
                    "stage_call '{step_id}' in {sequence_namespace} could not resume, so its staged yield was dropped and the sequence halted: {error:?}"
                ));
                return PromiseOrValue::Value(());
            }
        }

        let finish_args = Self::encode_callback_args(&sequence_namespace, &step_id);
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
    pub fn on_stage_call_settled(&mut self, sequence_namespace: String, step_id: String) {
        let key = staged_call_key(&sequence_namespace, &step_id);
        let dispatch_summary = self
            .staged_calls
            .get(&key)
            .map(|staged| Self::call_dispatch_summary(&staged.call))
            .unwrap_or_else(|| "unknown dispatch".to_string());
        let result = env::promise_result_checked(0, MAX_CALLBACK_RESULT_BYTES);

        self.staged_calls.remove(&key);

        match result {
            Ok(bytes) => {
                self.progress_sequence_after_successful_settlement(
                    &sequence_namespace,
                    &step_id,
                    &dispatch_summary,
                    bytes.len(),
                );
            }
            Err(error) => {
                self.sequence_queue.remove(&sequence_namespace);
                self.finish_automation_run(
                    &sequence_namespace,
                    AutomationRunStatus::DownstreamFailed,
                    Some(step_id.clone()),
                );
                env::log_str(&format!(
                    "stage_call '{step_id}' in {sequence_namespace} failed downstream via {}; ordered release stopped here: {error:?}",
                    dispatch_summary
                ));
            }
        }
    }

    pub fn has_staged_call(&self, caller_id: AccountId, step_id: String) -> bool {
        self.staged_calls
            .get(&staged_call_key(&manual_namespace(&caller_id), &step_id))
            .is_some()
    }

    pub fn staged_calls_for(&self, caller_id: AccountId) -> Vec<StagedCallView> {
        self.staged_calls_for_namespace(&manual_namespace(&caller_id))
    }

    // --- Durable sequence templates ---

    pub fn save_sequence_template(
        &mut self,
        sequence_id: String,
        calls: Vec<SequenceCallInput>,
    ) -> SequenceTemplateView {
        self.assert_owner();
        assert!(!sequence_id.is_empty(), "sequence_id cannot be empty");
        assert!(
            !calls.is_empty(),
            "sequence template must contain at least one call"
        );

        let now = env::block_timestamp_ms();
        let (validated_calls, total_attached_deposit_yocto) =
            Self::validate_sequence_template_inputs(calls);

        self.sequence_templates.insert(
            sequence_id.clone(),
            SequenceTemplate {
                calls: validated_calls.clone(),
                saved_at_ms: now,
                total_attached_deposit_yocto,
            },
        );

        Self::sequence_template_view(
            sequence_id,
            &SequenceTemplate {
                calls: validated_calls,
                saved_at_ms: now,
                total_attached_deposit_yocto,
            },
        )
    }

    pub fn delete_sequence_template(&mut self, sequence_id: String) -> bool {
        self.assert_owner();
        assert!(
            self.sequence_templates.get(&sequence_id).is_some(),
            "unknown sequence template"
        );
        assert!(
            !self.sequence_id_is_referenced(&sequence_id),
            "sequence template is still referenced by a balance trigger"
        );
        self.sequence_templates.remove(&sequence_id).is_some()
    }

    pub fn get_sequence_template(&self, sequence_id: String) -> Option<SequenceTemplateView> {
        self.sequence_templates
            .get(&sequence_id)
            .map(|template| Self::sequence_template_view(sequence_id, template))
    }

    pub fn list_sequence_templates(&self) -> Vec<SequenceTemplateView> {
        self.sequence_templates
            .iter()
            .map(|(sequence_id, template)| {
                Self::sequence_template_view(sequence_id.clone(), template)
            })
            .collect()
    }

    // --- Balance-trigger automation ---

    pub fn create_balance_trigger(
        &mut self,
        trigger_id: String,
        sequence_id: String,
        min_balance_yocto: U128,
        max_runs: u32,
    ) -> BalanceTriggerView {
        self.assert_owner();
        assert!(!trigger_id.is_empty(), "trigger_id cannot be empty");
        assert!(!sequence_id.is_empty(), "sequence_id cannot be empty");
        assert!(max_runs > 0, "max_runs must be greater than zero");
        assert!(
            self.balance_triggers.get(&trigger_id).is_none(),
            "trigger_id already exists"
        );
        assert!(
            self.sequence_templates.get(&sequence_id).is_some(),
            "unknown sequence template"
        );

        let trigger = BalanceTrigger {
            sequence_id: sequence_id.clone(),
            min_balance_yocto: min_balance_yocto.0,
            max_runs,
            runs_started: 0,
            in_flight: false,
            last_executor_id: None,
            last_started_at_ms: None,
            last_finished_at_ms: None,
            last_run_namespace: None,
            last_run_outcome: None,
            created_at_ms: env::block_timestamp_ms(),
        };
        self.balance_triggers
            .insert(trigger_id.clone(), trigger.clone());
        Self::balance_trigger_view(trigger_id, &trigger)
    }

    pub fn delete_balance_trigger(&mut self, trigger_id: String) -> bool {
        self.assert_owner();
        let trigger = self
            .balance_triggers
            .get(&trigger_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown balance trigger"));
        assert!(!trigger.in_flight, "balance trigger is currently in flight");
        self.balance_triggers.remove(&trigger_id).is_some()
    }

    pub fn get_balance_trigger(&self, trigger_id: String) -> Option<BalanceTriggerView> {
        self.balance_triggers
            .get(&trigger_id)
            .map(|trigger| Self::balance_trigger_view(trigger_id, trigger))
    }

    pub fn list_balance_triggers(&self) -> Vec<BalanceTriggerView> {
        self.balance_triggers
            .iter()
            .map(|(trigger_id, trigger)| Self::balance_trigger_view(trigger_id.clone(), trigger))
            .collect()
    }

    pub fn execute_trigger(&mut self, trigger_id: String) -> TriggerExecutionView {
        self.assert_executor();

        let executor_id = env::predecessor_account_id();
        let now = env::block_timestamp_ms();
        let mut trigger = self
            .balance_triggers
            .get(&trigger_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown balance trigger"));
        let template = self
            .sequence_templates
            .get(&trigger.sequence_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown sequence template"));

        assert!(
            !trigger.in_flight,
            "balance trigger already has a run in flight"
        );
        assert!(
            trigger.runs_started < trigger.max_runs,
            "balance trigger has exhausted max_runs"
        );

        let required_balance_yocto = trigger
            .min_balance_yocto
            .max(template.total_attached_deposit_yocto);
        let current_balance_yocto = env::account_balance().as_yoctonear();
        assert!(
            current_balance_yocto >= required_balance_yocto,
            "smart account balance is below the trigger threshold"
        );

        let run_nonce = trigger
            .runs_started
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("run nonce overflow"));
        let sequence_namespace = automation_namespace(&trigger_id, run_nonce);
        assert!(
            self.automation_runs.get(&sequence_namespace).is_none(),
            "automation namespace already exists"
        );
        trigger.runs_started = run_nonce;

        for call in &template.calls {
            self.register_staged_yield_in_namespace(&sequence_namespace, call.clone())
                .detach();
        }
        env::log_str(&format!(
            "execute_trigger '{trigger_id}' materialized {} yielded receipts in {sequence_namespace}",
            template.calls.len()
        ));

        let order: Vec<String> = template
            .calls
            .iter()
            .map(|call| call.step_id.clone())
            .collect();
        let call_count = self.start_sequence_release_in_namespace(&sequence_namespace, order);

        trigger.in_flight = true;
        trigger.last_executor_id = Some(executor_id.clone());
        trigger.last_started_at_ms = Some(now);
        trigger.last_finished_at_ms = None;
        trigger.last_run_namespace = Some(sequence_namespace.clone());
        trigger.last_run_outcome = Some(AutomationRunStatus::InFlight);
        self.balance_triggers
            .insert(trigger_id.clone(), trigger.clone());

        self.automation_runs.insert(
            sequence_namespace.clone(),
            AutomationRun {
                trigger_id: trigger_id.clone(),
                sequence_id: trigger.sequence_id.clone(),
                sequence_namespace: sequence_namespace.clone(),
                run_nonce,
                executor_id: executor_id.clone(),
                started_at_ms: now,
                finished_at_ms: None,
                status: AutomationRunStatus::InFlight,
                failed_step_id: None,
            },
        );

        TriggerExecutionView {
            trigger_id,
            sequence_id: trigger.sequence_id,
            sequence_namespace,
            run_nonce,
            executor_id,
            started_at_ms: now,
            call_count,
        }
    }
}

impl Contract {
    // --- Shared guards and validation ---

    fn assert_owner(&self) {
        assert_eq!(env::predecessor_account_id(), self.owner_id, "owner-only");
    }

    fn assert_executor(&self) {
        let caller = env::predecessor_account_id();
        let is_authorized = caller == self.owner_id
            || self
                .authorized_executor
                .as_ref()
                .map(|account_id| account_id == &caller)
                .unwrap_or(false);
        assert!(is_authorized, "caller is not allowed to execute sequences");
    }

    fn sequence_call_from_raw(
        step_id: String,
        target_id: AccountId,
        method_name: String,
        args: Vec<u8>,
        attached_deposit_yocto: u128,
        gas_tgas: u64,
        settle_policy: SettlePolicy,
    ) -> SequenceCall {
        let call = SequenceCall {
            step_id,
            target_id,
            method_name,
            args,
            attached_deposit_yocto,
            gas_tgas,
            settle_policy,
        };
        Self::validate_sequence_call(&call);
        call
    }

    fn validate_sequence_template_inputs(
        calls: Vec<SequenceCallInput>,
    ) -> (Vec<SequenceCall>, u128) {
        let mut seen = std::collections::BTreeSet::new();
        let mut total_attached_deposit_yocto = 0_u128;
        let validated_calls = calls
            .into_iter()
            .map(|call| {
                let validated = Self::sequence_call_from_raw(
                    call.step_id,
                    call.target_id,
                    call.method_name,
                    call.args.0,
                    call.attached_deposit_yocto.0,
                    call.gas_tgas,
                    call.settle_policy,
                );
                assert!(
                    seen.insert(validated.step_id.clone()),
                    "sequence template step IDs must be unique"
                );
                total_attached_deposit_yocto = total_attached_deposit_yocto
                    .checked_add(validated.attached_deposit_yocto)
                    .unwrap_or_else(|| env::panic_str("template attached deposit overflow"));
                validated
            })
            .collect();
        (validated_calls, total_attached_deposit_yocto)
    }

    fn validate_sequence_call(call: &SequenceCall) {
        assert!(!call.step_id.is_empty(), "step_id cannot be empty");
        assert!(!call.method_name.is_empty(), "method_name cannot be empty");
        assert!(call.gas_tgas > 0, "gas_tgas must be greater than zero");
        match &call.settle_policy {
            SettlePolicy::Direct => {}
            SettlePolicy::Adapter { adapter_method, .. } => {
                assert!(!adapter_method.is_empty(), "adapter_method cannot be empty");
            }
            SettlePolicy::Asserted => {
                env::panic_str("asserted settle policy is reserved but not implemented")
            }
        }
        assert!(
            call.gas_tgas <= Self::max_target_gas_tgas(&call.settle_policy),
            "gas_tgas is too large for this settle policy"
        );
    }

    fn sequence_call_view(call: &SequenceCall) -> SequenceCallView {
        SequenceCallView {
            step_id: call.step_id.clone(),
            target_id: call.target_id.clone(),
            method_name: call.method_name.clone(),
            args: Base64VecU8::from(call.args.clone()),
            attached_deposit_yocto: U128(call.attached_deposit_yocto),
            gas_tgas: call.gas_tgas,
            settle_policy: call.settle_policy.clone(),
        }
    }

    fn staged_call_view(staged: &StagedCall) -> StagedCallView {
        StagedCallView {
            step_id: staged.call.step_id.clone(),
            target_id: staged.call.target_id.clone(),
            method_name: staged.call.method_name.clone(),
            args: Base64VecU8::from(staged.call.args.clone()),
            attached_deposit_yocto: U128(staged.call.attached_deposit_yocto),
            gas_tgas: staged.call.gas_tgas,
            settle_policy: staged.call.settle_policy.clone(),
            created_at_ms: staged.created_at_ms,
        }
    }

    fn sequence_template_view(
        sequence_id: String,
        template: &SequenceTemplate,
    ) -> SequenceTemplateView {
        SequenceTemplateView {
            sequence_id,
            calls: template
                .calls
                .iter()
                .map(Self::sequence_call_view)
                .collect(),
            contains_adapter_calls: template
                .calls
                .iter()
                .any(|call| matches!(call.settle_policy, SettlePolicy::Adapter { .. })),
            saved_at_ms: template.saved_at_ms,
            total_attached_deposit_yocto: U128(template.total_attached_deposit_yocto),
        }
    }

    fn balance_trigger_view(trigger_id: String, trigger: &BalanceTrigger) -> BalanceTriggerView {
        BalanceTriggerView {
            trigger_id,
            sequence_id: trigger.sequence_id.clone(),
            min_balance_yocto: U128(trigger.min_balance_yocto),
            max_runs: trigger.max_runs,
            runs_started: trigger.runs_started,
            in_flight: trigger.in_flight,
            last_executor_id: trigger.last_executor_id.clone(),
            last_started_at_ms: trigger.last_started_at_ms,
            last_finished_at_ms: trigger.last_finished_at_ms,
            last_run_namespace: trigger.last_run_namespace.clone(),
            last_run_outcome: trigger.last_run_outcome,
            created_at_ms: trigger.created_at_ms,
        }
    }

    // --- Sequencing kernel: registration ---

    fn register_staged_yield_in_namespace(
        &mut self,
        sequence_namespace: &str,
        call: SequenceCall,
    ) -> Promise {
        let key = staged_call_key(sequence_namespace, &call.step_id);
        assert!(
            self.staged_calls.get(&key).is_none(),
            "step_id already staged for this sequence"
        );

        let step_id = call.step_id.clone();
        let dispatch_summary = Self::call_dispatch_summary(&call);
        let resume_callback_gas = Gas::from_tgas(
            call.gas_tgas
                + Self::adapter_overhead_tgas(&call.settle_policy)
                + STAGE_SETTLE_CALLBACK_GAS_TGAS
                + STAGE_RESUME_OVERHEAD_TGAS,
        );
        let callback_args = Self::encode_callback_args(sequence_namespace, &call.step_id);
        let (yield_promise, yield_id) = Promise::new_yield(
            "on_stage_call_resume",
            callback_args,
            resume_callback_gas,
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
            "stage_call '{step_id}' in {sequence_namespace} staged and waiting for resume via {dispatch_summary}"
        ));

        yield_promise
    }

    // --- Sequencing kernel: release ---

    fn start_sequence_release_in_namespace(
        &mut self,
        sequence_namespace: &str,
        order: Vec<String>,
    ) -> u32 {
        assert!(!order.is_empty(), "order cannot be empty");
        assert!(
            self.sequence_queue.get(sequence_namespace).is_none(),
            "sequence already has a run in flight"
        );
        for step_id in &order {
            assert!(
                self.staged_calls
                    .get(&staged_call_key(sequence_namespace, step_id))
                    .is_some(),
                "step_id '{step_id}' not staged for this sequence"
            );
        }

        let n = order.len() as u32;
        let mut iter = order.into_iter();
        let first = iter.next().expect("checked non-empty");
        let rest: Vec<String> = iter.collect();
        if !rest.is_empty() {
            self.sequence_queue
                .insert(sequence_namespace.to_owned(), rest);
        }

        if let Err(message) = self.resume_staged_step(sequence_namespace, &first) {
            env::panic_str(&message);
        }
        let queued = self
            .sequence_queue
            .get(sequence_namespace)
            .map(|remaining| remaining.len())
            .unwrap_or(0);
        env::log_str(&format!(
            "sequence {sequence_namespace} started ordered resume with step '{first}' ({queued} still waiting behind it)"
        ));

        n
    }

    fn encode_callback_args(sequence_namespace: &str, step_id: &str) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "sequence_namespace": sequence_namespace,
            "step_id": step_id,
        }))
        .unwrap_or_else(|_| env::panic_str("failed to encode stage_call callback args"))
    }

    fn encode_adapter_dispatch_args(call: &SequenceCall) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "call": AdapterDispatchInput {
                target_id: call.target_id.clone(),
                method_name: call.method_name.clone(),
                args: Base64VecU8::from(call.args.clone()),
                attached_deposit_yocto: U128(call.attached_deposit_yocto),
                gas_tgas: call.gas_tgas,
            }
        }))
        .unwrap_or_else(|_| env::panic_str("failed to encode adapter dispatch args"))
    }

    fn resume_staged_step(&self, sequence_namespace: &str, step_id: &str) -> Result<(), String> {
        let key = staged_call_key(sequence_namespace, step_id);
        let staged = self
            .staged_calls
            .get(&key)
            .ok_or_else(|| format!("step_id '{step_id}' not staged for this sequence"))?;

        let payload = Self::encode_resume_payload();
        staged
            .yield_id
            .resume(payload)
            .map_err(|_| format!("failed to resume staged step '{step_id}'"))
    }

    fn dispatch_promise_for_call(call: &SequenceCall) -> Promise {
        match &call.settle_policy {
            SettlePolicy::Direct => Promise::new(call.target_id.clone()).function_call(
                call.method_name.clone(),
                call.args.clone(),
                NearToken::from_yoctonear(call.attached_deposit_yocto),
                Gas::from_tgas(call.gas_tgas),
            ),
            SettlePolicy::Adapter {
                adapter_id,
                adapter_method,
            } => Promise::new(adapter_id.clone()).function_call(
                adapter_method.clone(),
                Self::encode_adapter_dispatch_args(call),
                NearToken::from_yoctonear(call.attached_deposit_yocto),
                Gas::from_tgas(call.gas_tgas + ADAPTER_SEQUENCE_OVERHEAD_TGAS),
            ),
            SettlePolicy::Asserted => {
                env::panic_str("asserted settle policy is reserved but not implemented")
            }
        }
    }

    fn call_dispatch_summary(call: &SequenceCall) -> String {
        match &call.settle_policy {
            SettlePolicy::Direct => format!("direct {}.{}", call.target_id, call.method_name),
            SettlePolicy::Adapter {
                adapter_id,
                adapter_method,
            } => format!(
                "adapter {}.{} wrapping {}.{}",
                adapter_id, adapter_method, call.target_id, call.method_name
            ),
            SettlePolicy::Asserted => "asserted".to_string(),
        }
    }

    fn adapter_overhead_tgas(settle_policy: &SettlePolicy) -> u64 {
        match settle_policy {
            SettlePolicy::Direct => 0,
            SettlePolicy::Adapter { .. } => ADAPTER_SEQUENCE_OVERHEAD_TGAS,
            SettlePolicy::Asserted => 0,
        }
    }

    fn max_target_gas_tgas(settle_policy: &SettlePolicy) -> u64 {
        match settle_policy {
            SettlePolicy::Direct => MAX_STAGE_CALL_GAS_TGAS,
            SettlePolicy::Adapter { .. } => MAX_ADAPTER_TARGET_GAS_TGAS,
            SettlePolicy::Asserted => MAX_STAGE_CALL_GAS_TGAS,
        }
    }

    fn staged_calls_for_namespace(&self, sequence_namespace: &str) -> Vec<StagedCallView> {
        let prefix = format!("{sequence_namespace}#");
        self.staged_calls
            .iter()
            .filter_map(|(key, staged)| {
                if key.starts_with(&prefix) {
                    Some(Self::staged_call_view(staged))
                } else {
                    None
                }
            })
            .collect()
    }

    // --- Sequencing kernel: progression after settlement ---

    fn progress_sequence_after_successful_settlement(
        &mut self,
        sequence_namespace: &str,
        settled_step_id: &str,
        dispatch_summary: &str,
        result_len: usize,
    ) {
        if let Some(next) = self.take_next_queued_step(sequence_namespace) {
            env::log_str(&format!(
                "stage_call '{settled_step_id}' in {sequence_namespace} settled successfully via {dispatch_summary} ({result_len} result bytes); resuming step '{next}' next"
            ));
            if let Err(message) = self.resume_staged_step(sequence_namespace, &next) {
                self.sequence_queue.remove(sequence_namespace);
                self.finish_automation_run(
                    sequence_namespace,
                    AutomationRunStatus::ResumeFailed,
                    Some(next.clone()),
                );
                env::log_str(&format!(
                    "stage_call '{settled_step_id}' in {sequence_namespace} settled, but the next staged step '{next}' could not be resumed: {message}"
                ));
            }
        } else {
            env::log_str(&format!(
                "stage_call '{settled_step_id}' in {sequence_namespace} settled successfully via {dispatch_summary} ({result_len} result bytes); sequence completed"
            ));
            self.finish_automation_run(sequence_namespace, AutomationRunStatus::Succeeded, None);
        }
    }

    fn take_next_queued_step(&mut self, sequence_namespace: &str) -> Option<String> {
        let mut remaining = self.sequence_queue.get(sequence_namespace).cloned()?;
        if remaining.is_empty() {
            self.sequence_queue.remove(sequence_namespace);
            return None;
        }

        let next = remaining.remove(0);
        if remaining.is_empty() {
            self.sequence_queue.remove(sequence_namespace);
        } else {
            self.sequence_queue
                .insert(sequence_namespace.to_owned(), remaining);
        }
        Some(next)
    }

    fn encode_resume_payload() -> Vec<u8> {
        serde_json::to_vec(&())
            .unwrap_or_else(|_| env::panic_str("failed to encode resume payload"))
    }

    fn finish_automation_run(
        &mut self,
        sequence_namespace: &str,
        status: AutomationRunStatus,
        failed_step_id: Option<String>,
    ) {
        let Some(mut run) = self.automation_runs.get(sequence_namespace).cloned() else {
            return;
        };
        if run.status != AutomationRunStatus::InFlight {
            return;
        }

        run.status = status;
        run.failed_step_id = failed_step_id;
        run.finished_at_ms = Some(env::block_timestamp_ms());
        self.automation_runs
            .insert(sequence_namespace.to_owned(), run.clone());

        if let Some(mut trigger) = self.balance_triggers.get(&run.trigger_id).cloned() {
            trigger.in_flight = false;
            trigger.last_finished_at_ms = run.finished_at_ms;
            trigger.last_run_outcome = Some(status);
            self.balance_triggers
                .insert(run.trigger_id.clone(), trigger);
        }

        self.clear_staged_namespace(sequence_namespace);
        self.sequence_queue.remove(sequence_namespace);
    }

    fn clear_staged_namespace(&mut self, sequence_namespace: &str) {
        let prefix = format!("{sequence_namespace}#");
        let keys: Vec<String> = self
            .staged_calls
            .iter()
            .filter_map(|(key, _)| {
                if key.starts_with(&prefix) {
                    Some(key.clone())
                } else {
                    None
                }
            })
            .collect();
        for key in keys {
            self.staged_calls.remove(&key);
        }
    }

    fn sequence_id_is_referenced(&self, sequence_id: &str) -> bool {
        self.balance_triggers
            .iter()
            .any(|(_, trigger)| trigger.sequence_id == sequence_id)
    }
}

fn manual_namespace(caller: &AccountId) -> String {
    format!("manual:{caller}")
}

fn automation_namespace(trigger_id: &str, run_nonce: u32) -> String {
    format!("auto:{trigger_id}:{run_nonce}")
}

fn staged_call_key(sequence_namespace: &str, step_id: &str) -> String {
    format!("{sequence_namespace}#{step_id}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::mock::MockAction;
    use near_sdk::serde::Deserialize;
    use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
    use near_sdk::{test_vm_config, testing_env, PromiseResult, RuntimeFeesConfig};
    use std::collections::HashMap;

    fn current() -> AccountId {
        "smart.near".parse().unwrap()
    }

    fn owner() -> AccountId {
        "owner.near".parse().unwrap()
    }

    fn stranger() -> AccountId {
        "alice.near".parse().unwrap()
    }

    fn executor() -> AccountId {
        "executor.near".parse().unwrap()
    }

    fn router() -> AccountId {
        "router.near".parse().unwrap()
    }

    fn echo() -> AccountId {
        "echo.near".parse().unwrap()
    }

    fn wild_router() -> AccountId {
        "wild-router.near".parse().unwrap()
    }

    fn adapter() -> AccountId {
        "demo-adapter.near".parse().unwrap()
    }

    fn ctx(predecessor: AccountId) {
        ctx_with_balance(predecessor, NearToken::from_near(100));
    }

    fn ctx_with_balance(predecessor: AccountId, balance: NearToken) {
        let mut b = VMContextBuilder::new();
        b.current_account_id(current())
            .signer_account_id(predecessor.clone())
            .predecessor_account_id(predecessor)
            .account_balance(balance);
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

    fn stage_input(step_id: &str, n: u32) -> SequenceCallInput {
        stage_input_with_policy(step_id, n, SettlePolicy::Direct)
    }

    fn stage_input_with_policy(
        step_id: &str,
        n: u32,
        settle_policy: SettlePolicy,
    ) -> SequenceCallInput {
        SequenceCallInput {
            step_id: step_id.into(),
            target_id: router(),
            method_name: "route_echo".into(),
            args: Base64VecU8::from(format!(r#"{{"callee":"{}","n":{}}}"#, echo(), n).into_bytes()),
            attached_deposit_yocto: U128(0),
            gas_tgas: 40,
            settle_policy,
        }
    }

    fn adapter_stage_input(step_id: &str, n: u32) -> SequenceCallInput {
        SequenceCallInput {
            step_id: step_id.into(),
            target_id: wild_router(),
            method_name: "route_echo_fire_and_forget".into(),
            args: Base64VecU8::from(format!(r#"{{"callee":"{}","n":{}}}"#, echo(), n).into_bytes()),
            attached_deposit_yocto: U128(0),
            gas_tgas: 40,
            settle_policy: adapter_policy(),
        }
    }

    fn adapter_policy() -> SettlePolicy {
        SettlePolicy::Adapter {
            adapter_id: adapter(),
            adapter_method: "adapt_fire_and_forget_route_echo".into(),
        }
    }

    #[derive(Deserialize)]
    #[serde(crate = "near_sdk::serde")]
    struct AdapterEnvelope {
        call: AdapterDispatchInput,
    }

    fn find_function_call(
        receipts: &[near_sdk::mock::Receipt],
        receiver_id: &AccountId,
    ) -> Option<(String, Vec<u8>, NearToken, Gas)> {
        receipts.iter().find_map(|receipt| {
            if &receipt.receiver_id != receiver_id {
                return None;
            }
            receipt.actions.iter().find_map(|action| match action {
                MockAction::FunctionCallWeight {
                    method_name,
                    args,
                    attached_deposit,
                    prepaid_gas,
                    ..
                } => Some((
                    String::from_utf8(method_name.clone()).unwrap(),
                    args.clone(),
                    *attached_deposit,
                    *prepaid_gas,
                )),
                _ => None,
            })
        })
    }

    fn setup_trigger(max_runs: u32) -> (Contract, String, String) {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        let sequence_id = "router-demo".to_string();
        let trigger_id = "balance-demo".to_string();
        c.save_sequence_template(sequence_id.clone(), vec![stage_input("alpha", 1)]);
        c.create_balance_trigger(trigger_id.clone(), sequence_id.clone(), U128(0), max_runs);
        (c, sequence_id, trigger_id)
    }

    #[test]
    fn stage_call_registers_staged_view() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        let _ = c.stage_call(
            echo(),
            "echo".into(),
            Base64VecU8::from(br#"{"n":7}"#.to_vec()),
            U128(0),
            30,
            "alpha".into(),
            None,
        );

        assert!(c.has_staged_call(owner(), "alpha".into()));
        let staged = c.staged_calls_for(owner());
        assert_eq!(staged.len(), 1);
        assert_eq!(staged[0].step_id, "alpha");
        assert_eq!(staged[0].target_id, echo());
        assert_eq!(staged[0].method_name, "echo");
    }

    #[test]
    fn stage_call_allocates_distinct_yielded_receipt_per_step() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        let _ = c.stage_call(
            echo(),
            "echo".into(),
            Base64VecU8::from(br#"{"n":5}"#.to_vec()),
            U128(0),
            30,
            "alpha".into(),
            None,
        );
        let _ = c.stage_call(
            echo(),
            "echo".into(),
            Base64VecU8::from(br#"{"n":6}"#.to_vec()),
            U128(0),
            30,
            "beta".into(),
            None,
        );

        let alpha = c
            .staged_calls
            .get(&staged_call_key(&manual_namespace(&owner()), "alpha"))
            .unwrap();
        let beta = c
            .staged_calls
            .get(&staged_call_key(&manual_namespace(&owner()), "beta"))
            .unwrap();
        assert_ne!(alpha.yield_id, beta.yield_id);
    }

    #[test]
    fn stage_call_accepts_pv83_max_call_gas() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        let _ = c.stage_call(
            echo(),
            "echo".into(),
            Base64VecU8::from(br#"{"n":9}"#.to_vec()),
            U128(0),
            MAX_STAGE_CALL_GAS_TGAS,
            "max".into(),
            None,
        );

        let staged = c.staged_calls_for(owner());
        assert_eq!(staged.len(), 1);
        assert_eq!(staged[0].gas_tgas, MAX_STAGE_CALL_GAS_TGAS);
    }

    #[test]
    #[should_panic(expected = "step_id already staged for this sequence")]
    fn stage_call_rejects_duplicate_step_id() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        let _ = c.stage_call(
            echo(),
            "echo".into(),
            Base64VecU8::from(br#"{"n":1}"#.to_vec()),
            U128(0),
            30,
            "alpha".into(),
            None,
        );
        let _ = c.stage_call(
            echo(),
            "echo".into(),
            Base64VecU8::from(br#"{"n":2}"#.to_vec()),
            U128(0),
            30,
            "alpha".into(),
            None,
        );
    }

    #[test]
    #[should_panic(expected = "gas_tgas is too large")]
    fn stage_call_rejects_over_max_gas() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        let _ = c.stage_call(
            echo(),
            "echo".into(),
            Base64VecU8::from(br#"{"n":1}"#.to_vec()),
            U128(0),
            MAX_STAGE_CALL_GAS_TGAS + 1,
            "alpha".into(),
            None,
        );
    }

    #[test]
    fn direct_policy_treats_empty_success_bytes_as_successful_settlement() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        let _ = c.stage_call(
            echo(),
            "echo".into(),
            Base64VecU8::from(br#"{"n":7}"#.to_vec()),
            U128(0),
            30,
            "alpha".into(),
            None,
        );
        let _ = c.stage_call(
            echo(),
            "echo".into(),
            Base64VecU8::from(br#"{"n":8}"#.to_vec()),
            U128(0),
            30,
            "beta".into(),
            None,
        );
        c.sequence_queue
            .insert(manual_namespace(&owner()), vec!["beta".into()]);

        callback_ctx(PromiseResult::Successful(vec![]));
        c.on_stage_call_settled(manual_namespace(&owner()), "alpha".into());

        assert!(!c.has_staged_call(owner(), "alpha".into()));
        assert!(c.sequence_queue.get(&manual_namespace(&owner())).is_none());
        assert!(c.has_staged_call(owner(), "beta".into()));
    }

    #[test]
    fn adapter_policy_dispatches_to_adapter_contract() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        let _ = c.stage_call(
            wild_router(),
            "route_echo_fire_and_forget".into(),
            Base64VecU8::from(format!(r#"{{"callee":"{}","n":9}}"#, echo()).into_bytes()),
            U128(0),
            40,
            "alpha".into(),
            Some(adapter_policy()),
        );

        ctx(current());
        let result = c.on_stage_call_resume(manual_namespace(&owner()), "alpha".into(), Ok(()));
        assert!(matches!(result, PromiseOrValue::Promise(_)));
        drop(result);

        let receipts = get_created_receipts();
        let (method_name, args, attached_deposit, prepaid_gas) =
            find_function_call(&receipts, &adapter()).expect("adapter dispatch receipt");
        assert_eq!(method_name, "adapt_fire_and_forget_route_echo");
        assert_eq!(attached_deposit, NearToken::from_yoctonear(0));
        assert_eq!(
            prepaid_gas,
            Gas::from_tgas(40 + ADAPTER_SEQUENCE_OVERHEAD_TGAS)
        );

        let envelope: AdapterEnvelope = serde_json::from_slice(&args).unwrap();
        assert_eq!(envelope.call.target_id, wild_router());
        assert_eq!(envelope.call.method_name, "route_echo_fire_and_forget");
        assert_eq!(envelope.call.gas_tgas, 40);
        assert_eq!(envelope.call.attached_deposit_yocto, U128(0));
        assert_eq!(
            String::from_utf8(envelope.call.args.0).unwrap(),
            format!(r#"{{"callee":"{}","n":9}}"#, echo())
        );
        assert!(find_function_call(&receipts, &wild_router()).is_none());
    }

    #[test]
    #[should_panic(expected = "order cannot be empty")]
    fn run_sequence_rejects_empty_order() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        c.run_sequence(owner(), vec![]);
    }

    #[test]
    #[should_panic(expected = "not staged for this sequence")]
    fn run_sequence_rejects_unknown_step_id() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        c.run_sequence(owner(), vec!["phantom".into()]);
    }

    #[test]
    #[should_panic(expected = "caller is not allowed to execute sequences")]
    fn run_sequence_requires_authorized_executor() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        c.set_authorized_executor(Some(stranger()));
        ctx("eve.near".parse().unwrap());
        c.run_sequence(owner(), vec!["alpha".into()]);
    }

    #[test]
    fn run_sequence_only_resumes_first_step_and_queues_rest() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        for (step_id, n) in [("alpha", 1_u32), ("beta", 2), ("gamma", 3)] {
            let _ = c.stage_call(
                echo(),
                "echo".into(),
                Base64VecU8::from(format!(r#"{{"n":{n}}}"#).into_bytes()),
                U128(0),
                30,
                step_id.into(),
                None,
            );
        }

        let released = c.run_sequence(owner(), vec!["alpha".into(), "beta".into(), "gamma".into()]);

        assert_eq!(released, 3);
        assert_eq!(
            c.sequence_queue
                .get(&manual_namespace(&owner()))
                .cloned()
                .unwrap(),
            vec!["beta".to_string(), "gamma".to_string()]
        );
        assert!(c.has_staged_call(owner(), "alpha".into()));
    }

    #[test]
    fn successful_progression_resumes_next_step_only_after_downstream_completion() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        let _ = c.stage_call(
            echo(),
            "echo".into(),
            Base64VecU8::from(br#"{"n":1}"#.to_vec()),
            U128(0),
            30,
            "alpha".into(),
            None,
        );
        let _ = c.stage_call(
            echo(),
            "echo".into(),
            Base64VecU8::from(br#"{"n":2}"#.to_vec()),
            U128(0),
            30,
            "beta".into(),
            None,
        );

        c.run_sequence(owner(), vec!["alpha".into(), "beta".into()]);
        c.staged_calls
            .remove(&staged_call_key(&manual_namespace(&owner()), "alpha"));
        c.progress_sequence_after_successful_settlement(
            &manual_namespace(&owner()),
            "alpha",
            "direct echo.near.echo",
            1,
        );

        assert!(c.sequence_queue.get(&manual_namespace(&owner())).is_none());
        assert!(c.has_staged_call(owner(), "beta".into()));
    }

    #[test]
    fn downstream_failure_halts_without_resuming_next_step() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        let _ = c.stage_call(
            echo(),
            "echo".into(),
            Base64VecU8::from(br#"{"n":1}"#.to_vec()),
            U128(0),
            30,
            "alpha".into(),
            None,
        );
        let _ = c.stage_call(
            echo(),
            "echo".into(),
            Base64VecU8::from(br#"{"n":2}"#.to_vec()),
            U128(0),
            30,
            "beta".into(),
            None,
        );

        c.sequence_queue
            .insert(manual_namespace(&owner()), vec!["beta".into()]);

        callback_ctx(PromiseResult::Failed);
        c.on_stage_call_settled(manual_namespace(&owner()), "alpha".into());

        assert!(c.sequence_queue.get(&manual_namespace(&owner())).is_none());
        assert!(c.has_staged_call(owner(), "beta".into()));
    }

    #[test]
    fn sequence_template_crud_roundtrip() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        c.save_sequence_template(
            "router-demo".into(),
            vec![stage_input("alpha", 1), stage_input("beta", 2)],
        );

        let listed = c.list_sequence_templates();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].sequence_id, "router-demo");
        assert_eq!(listed[0].calls.len(), 2);
        assert!(!listed[0].contains_adapter_calls);
        assert!(c.delete_sequence_template("router-demo".into()));
        assert!(c.get_sequence_template("router-demo".into()).is_none());
    }

    #[test]
    fn sequence_template_reports_mixed_policies() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        c.save_sequence_template(
            "mixed-demo".into(),
            vec![
                stage_input("alpha", 1),
                adapter_stage_input("beta", 2),
                stage_input_with_policy("gamma", 3, SettlePolicy::Direct),
            ],
        );

        let template = c.get_sequence_template("mixed-demo".into()).unwrap();
        assert!(template.contains_adapter_calls);
        assert_eq!(template.calls[0].settle_policy, SettlePolicy::Direct);
        assert_eq!(template.calls[1].settle_policy, adapter_policy());
    }

    #[test]
    #[should_panic(expected = "owner-only")]
    fn save_sequence_template_requires_owner() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        ctx(stranger());
        c.save_sequence_template("router-demo".into(), vec![stage_input("alpha", 1)]);
    }

    #[test]
    #[should_panic(expected = "sequence template is still referenced")]
    fn delete_sequence_template_rejects_referenced_trigger() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        c.save_sequence_template("router-demo".into(), vec![stage_input("alpha", 1)]);
        c.create_balance_trigger("balance-demo".into(), "router-demo".into(), U128(0), 1);
        c.delete_sequence_template("router-demo".into());
    }

    #[test]
    fn balance_trigger_crud_roundtrip() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        c.save_sequence_template("router-demo".into(), vec![stage_input("alpha", 1)]);
        c.create_balance_trigger("balance-demo".into(), "router-demo".into(), U128(0), 2);

        let listed = c.list_balance_triggers();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].trigger_id, "balance-demo");
        assert_eq!(listed[0].sequence_id, "router-demo");
        assert!(c.delete_balance_trigger("balance-demo".into()));
        assert!(c.get_balance_trigger("balance-demo".into()).is_none());
    }

    #[test]
    #[should_panic(expected = "owner-only")]
    fn create_balance_trigger_requires_owner() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        c.save_sequence_template("router-demo".into(), vec![stage_input("alpha", 1)]);
        ctx(stranger());
        c.create_balance_trigger("balance-demo".into(), "router-demo".into(), U128(0), 1);
    }

    #[test]
    #[should_panic(expected = "unknown balance trigger")]
    fn execute_trigger_rejects_unknown_trigger() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        ctx(owner());
        c.execute_trigger("missing".into());
    }

    #[test]
    #[should_panic(expected = "smart account balance is below the trigger threshold")]
    fn execute_trigger_rejects_below_threshold() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        c.save_sequence_template("router-demo".into(), vec![stage_input("alpha", 1)]);
        c.create_balance_trigger("balance-demo".into(), "router-demo".into(), U128(10), 1);
        ctx_with_balance(owner(), NearToken::from_yoctonear(1));
        c.execute_trigger("balance-demo".into());
    }

    #[test]
    #[should_panic(expected = "balance trigger has exhausted max_runs")]
    fn execute_trigger_rejects_exhausted_max_runs() {
        let (mut c, _, trigger_id) = setup_trigger(1);
        let mut trigger = c.balance_triggers.get(&trigger_id).cloned().unwrap();
        trigger.runs_started = trigger.max_runs;
        c.balance_triggers.insert(trigger_id.clone(), trigger);
        ctx(owner());
        c.execute_trigger(trigger_id);
    }

    #[test]
    #[should_panic(expected = "balance trigger already has a run in flight")]
    fn execute_trigger_rejects_already_in_flight() {
        let (mut c, _, trigger_id) = setup_trigger(2);
        ctx(owner());
        c.execute_trigger(trigger_id.clone());
        ctx(owner());
        c.execute_trigger(trigger_id);
    }

    #[test]
    #[should_panic(expected = "caller is not allowed to execute sequences")]
    fn execute_trigger_requires_authorized_executor() {
        let (mut c, _, trigger_id) = setup_trigger(1);
        ctx(stranger());
        c.execute_trigger(trigger_id);
    }

    #[test]
    fn execute_trigger_starts_sequence() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        c.save_sequence_template(
            "router-demo".into(),
            vec![stage_input("alpha", 1), stage_input("beta", 2)],
        );
        c.create_balance_trigger("balance-demo".into(), "router-demo".into(), U128(0), 2);

        ctx(owner());
        let result = c.execute_trigger("balance-demo".into());

        assert_eq!(result.trigger_id, "balance-demo");
        assert_eq!(result.sequence_id, "router-demo");
        assert_eq!(result.sequence_namespace, "auto:balance-demo:1");
        assert_eq!(result.call_count, 2);
        assert_eq!(result.executor_id, owner());

        let trigger = c.balance_triggers.get("balance-demo").cloned().unwrap();
        assert!(trigger.in_flight);
        assert_eq!(trigger.runs_started, 1);
        assert_eq!(trigger.last_executor_id, Some(owner()));

        let run = c
            .automation_runs
            .get("auto:balance-demo:1")
            .cloned()
            .unwrap();
        assert_eq!(run.status, AutomationRunStatus::InFlight);
        assert_eq!(run.executor_id, owner());

        let staged = c.staged_calls_for_namespace("auto:balance-demo:1");
        assert_eq!(staged.len(), 2);
        let queued = c
            .sequence_queue
            .get("auto:balance-demo:1")
            .cloned()
            .unwrap();
        assert_eq!(queued, vec!["beta".to_string()]);
    }

    #[test]
    fn execute_trigger_materializes_yielded_receipts_before_starting_release() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        c.save_sequence_template(
            "router-demo".into(),
            vec![
                stage_input("alpha", 1),
                stage_input("beta", 2),
                stage_input("gamma", 3),
            ],
        );
        c.create_balance_trigger("balance-demo".into(), "router-demo".into(), U128(0), 1);

        ctx(owner());
        let started = c.execute_trigger("balance-demo".into());

        assert_eq!(started.call_count, 3);
        let staged = c.staged_calls_for_namespace(&started.sequence_namespace);
        assert_eq!(staged.len(), 3);
        assert_eq!(
            c.sequence_queue
                .get(&started.sequence_namespace)
                .cloned()
                .unwrap(),
            vec!["beta".to_string(), "gamma".to_string()]
        );
    }

    #[test]
    fn adapter_success_marks_terminal_run_succeeded() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        c.save_sequence_template("adapter-demo".into(), vec![adapter_stage_input("alpha", 1)]);
        c.create_balance_trigger("balance-demo".into(), "adapter-demo".into(), U128(0), 1);

        ctx(owner());
        let started = c.execute_trigger("balance-demo".into());

        callback_ctx(PromiseResult::Successful(vec![1]));
        c.on_stage_call_settled(started.sequence_namespace.clone(), "alpha".into());

        let trigger = c.balance_triggers.get("balance-demo").cloned().unwrap();
        assert!(!trigger.in_flight);
        assert_eq!(
            trigger.last_run_outcome,
            Some(AutomationRunStatus::Succeeded)
        );

        let run = c
            .automation_runs
            .get(&started.sequence_namespace)
            .cloned()
            .unwrap();
        assert_eq!(run.status, AutomationRunStatus::Succeeded);
    }

    #[test]
    fn adapter_failure_halts_sequence_as_downstream_failed() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        c.save_sequence_template("adapter-demo".into(), vec![adapter_stage_input("alpha", 1)]);
        c.create_balance_trigger("balance-demo".into(), "adapter-demo".into(), U128(0), 1);

        ctx(owner());
        let started = c.execute_trigger("balance-demo".into());

        callback_ctx(PromiseResult::Failed);
        c.on_stage_call_settled(started.sequence_namespace.clone(), "alpha".into());

        let trigger = c.balance_triggers.get("balance-demo").cloned().unwrap();
        assert!(!trigger.in_flight);
        assert_eq!(
            trigger.last_run_outcome,
            Some(AutomationRunStatus::DownstreamFailed)
        );

        let run = c
            .automation_runs
            .get(&started.sequence_namespace)
            .cloned()
            .unwrap();
        assert_eq!(run.status, AutomationRunStatus::DownstreamFailed);
        assert_eq!(run.failed_step_id, Some("alpha".into()));
    }

    #[test]
    fn oversized_success_result_is_treated_as_downstream_failure() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        c.save_sequence_template(
            "router-demo".into(),
            vec![stage_input("alpha", 1), stage_input("beta", 2)],
        );
        c.create_balance_trigger("balance-demo".into(), "router-demo".into(), U128(0), 1);

        ctx(owner());
        let started = c.execute_trigger("balance-demo".into());

        callback_ctx(PromiseResult::Successful(vec![
            7_u8;
            MAX_CALLBACK_RESULT_BYTES + 1
        ]));
        c.on_stage_call_settled(started.sequence_namespace.clone(), "alpha".into());

        let trigger = c.balance_triggers.get("balance-demo").cloned().unwrap();
        assert!(!trigger.in_flight);
        assert_eq!(
            trigger.last_run_outcome,
            Some(AutomationRunStatus::DownstreamFailed)
        );

        let run = c
            .automation_runs
            .get(&started.sequence_namespace)
            .cloned()
            .unwrap();
        assert_eq!(run.status, AutomationRunStatus::DownstreamFailed);
        assert_eq!(run.failed_step_id, Some("alpha".into()));
        assert!(c
            .staged_calls_for_namespace(&started.sequence_namespace)
            .is_empty());
    }

    #[test]
    fn mixed_policy_template_runs_without_namespace_collisions() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        c.save_sequence_template(
            "mixed-demo".into(),
            vec![
                stage_input("alpha", 1),
                adapter_stage_input("beta", 2),
                stage_input("gamma", 3),
            ],
        );
        c.create_balance_trigger("balance-demo".into(), "mixed-demo".into(), U128(0), 1);

        ctx(owner());
        let started = c.execute_trigger("balance-demo".into());

        let staged = c.staged_calls_for_namespace(&started.sequence_namespace);
        assert_eq!(staged.len(), 3);
        assert_eq!(
            staged
                .iter()
                .map(|call| (call.step_id.clone(), call.settle_policy.clone()))
                .collect::<Vec<_>>(),
            vec![
                ("alpha".to_string(), SettlePolicy::Direct),
                ("beta".to_string(), adapter_policy()),
                ("gamma".to_string(), SettlePolicy::Direct),
            ]
        );
    }

    #[test]
    fn repeated_runs_get_fresh_namespaces() {
        let (mut c, _, trigger_id) = setup_trigger(2);

        ctx(owner());
        let first = c.execute_trigger(trigger_id.clone());
        assert_eq!(first.sequence_namespace, "auto:balance-demo:1");

        callback_ctx(PromiseResult::Successful(vec![1]));
        c.on_stage_call_settled(first.sequence_namespace.clone(), "alpha".into());

        let first_run = c
            .automation_runs
            .get(&first.sequence_namespace)
            .cloned()
            .unwrap();
        assert_eq!(first_run.status, AutomationRunStatus::Succeeded);
        assert!(c
            .staged_calls_for_namespace(&first.sequence_namespace)
            .is_empty());

        ctx(owner());
        let second = c.execute_trigger(trigger_id.clone());
        assert_eq!(second.sequence_namespace, "auto:balance-demo:2");
        assert_ne!(first.sequence_namespace, second.sequence_namespace);

        let second_run = c
            .automation_runs
            .get(&second.sequence_namespace)
            .cloned()
            .unwrap();
        assert_eq!(second_run.status, AutomationRunStatus::InFlight);
    }

    #[test]
    fn multiple_triggers_can_coexist() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        c.save_sequence_template("seq-a".into(), vec![stage_input("alpha", 1)]);
        c.save_sequence_template("seq-b".into(), vec![stage_input("beta", 2)]);
        c.create_balance_trigger("trigger-a".into(), "seq-a".into(), U128(0), 1);
        c.create_balance_trigger("trigger-b".into(), "seq-b".into(), U128(0), 1);
        c.set_authorized_executor(Some(executor()));

        ctx(executor());
        let a = c.execute_trigger("trigger-a".into());
        ctx(owner());
        let b = c.execute_trigger("trigger-b".into());

        assert_eq!(a.sequence_namespace, "auto:trigger-a:1");
        assert_eq!(b.sequence_namespace, "auto:trigger-b:1");
        assert_eq!(
            c.staged_calls_for_namespace("auto:trigger-a:1")
                .iter()
                .map(|call| call.step_id.clone())
                .collect::<Vec<_>>(),
            vec!["alpha".to_string()]
        );
        assert_eq!(
            c.staged_calls_for_namespace("auto:trigger-b:1")
                .iter()
                .map(|call| call.step_id.clone())
                .collect::<Vec<_>>(),
            vec!["beta".to_string()]
        );
    }

    #[test]
    fn downstream_failure_clears_in_flight_and_keeps_run_record() {
        let (mut c, _, trigger_id) = setup_trigger(1);

        ctx(owner());
        let started = c.execute_trigger(trigger_id.clone());

        callback_ctx(PromiseResult::Failed);
        c.on_stage_call_settled(started.sequence_namespace.clone(), "alpha".into());

        let trigger = c.balance_triggers.get(&trigger_id).cloned().unwrap();
        assert!(!trigger.in_flight);
        assert_eq!(trigger.runs_started, 1);
        assert_eq!(
            trigger.last_run_outcome,
            Some(AutomationRunStatus::DownstreamFailed)
        );

        let run = c
            .automation_runs
            .get(&started.sequence_namespace)
            .cloned()
            .unwrap();
        assert_eq!(run.status, AutomationRunStatus::DownstreamFailed);
        assert_eq!(run.failed_step_id, Some("alpha".into()));
        assert!(run.finished_at_ms.is_some());
    }

    #[test]
    fn missing_next_step_marks_resume_failure_and_clears_leftovers() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        c.save_sequence_template(
            "router-demo".into(),
            vec![stage_input("alpha", 1), stage_input("beta", 2)],
        );
        c.create_balance_trigger("balance-demo".into(), "router-demo".into(), U128(0), 1);

        ctx(owner());
        let started = c.execute_trigger("balance-demo".into());
        c.staged_calls
            .remove(&staged_call_key(&started.sequence_namespace, "beta"));

        callback_ctx(PromiseResult::Successful(vec![1]));
        c.on_stage_call_settled(started.sequence_namespace.clone(), "alpha".into());

        let trigger = c.balance_triggers.get("balance-demo").cloned().unwrap();
        assert!(!trigger.in_flight);
        assert_eq!(
            trigger.last_run_outcome,
            Some(AutomationRunStatus::ResumeFailed)
        );
        assert!(c
            .staged_calls_for_namespace(&started.sequence_namespace)
            .is_empty());
    }

    #[test]
    fn cleared_late_step_can_still_wake_after_namespace_cleanup() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        c.save_sequence_template(
            "router-demo".into(),
            vec![stage_input("alpha", 1), stage_input("beta", 2)],
        );
        c.create_balance_trigger("balance-demo".into(), "router-demo".into(), U128(0), 1);

        ctx(owner());
        let started = c.execute_trigger("balance-demo".into());

        callback_ctx(PromiseResult::Failed);
        c.on_stage_call_settled(started.sequence_namespace.clone(), "alpha".into());

        assert!(c
            .staged_calls
            .get(&staged_call_key(&started.sequence_namespace, "beta"))
            .is_none());

        ctx(current());
        let result = c.on_stage_call_resume(
            started.sequence_namespace.clone(),
            "beta".into(),
            Err(PromiseError::Failed),
        );
        assert!(matches!(result, PromiseOrValue::Value(())));

        let run = c
            .automation_runs
            .get(&started.sequence_namespace)
            .cloned()
            .unwrap();
        assert_eq!(run.status, AutomationRunStatus::DownstreamFailed);
        assert_eq!(run.failed_step_id, Some("alpha".into()));
    }

    #[test]
    fn unit_resume_payload_serializes_to_json_null() {
        assert_eq!(Contract::encode_resume_payload(), b"null".to_vec());
    }
}
