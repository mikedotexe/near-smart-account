//! `smart-account-contract` — the on-chain half.
//!
//! The public surface is intentionally narrow but now clearly has two layers:
//!
//! - Kernel sequencing surface:
//!   - `register_step(...)` registers a yielded downstream `FunctionCall` and
//!     creates its yielded callback receipt
//!   - `run_sequence(caller, order)` starts ordered release by resuming the
//!     first yielded step
//!   - `on_step_resumed` dispatches the real downstream call only after
//!     that release
//!   - `on_step_resolved` advances the next yielded step only after the
//!     downstream call's trusted completion surface has resolved
//!   - `policy` (`Direct`, `Adapter`, `Asserted`) defines what that
//!     trusted completion surface is for each step
//! - Automation/product surface built on top of the kernel:
//!   - `save_sequence_template(...)` stores a durable ordered call template
//!   - `create_balance_trigger(...)` stores a balance gate over a template
//!   - `execute_trigger(...)` materializes a fresh yielded namespace and starts
//!     the sequence once an authorized caller spends their own transaction gas
//!
//! The kernel is the narrow theorem this repo is built around. The automation
//! layer is a real product surface built on top of that kernel, not a separate
//! proof.

use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::serde_json::{self, json};
use near_sdk::store::IterableMap;
use near_sdk::{
    env, near, AccountId, BorshStorageKey, Gas, GasWeight, NearToken, PanicOnDefault, Promise,
    PromiseError, PromiseOrValue, YieldId,
};
use smart_account_types::{AdapterDispatchInput, StepPolicy};

const STEP_RESOLVE_CALLBACK_GAS_TGAS: u64 = 20;
const STEP_RESUME_OVERHEAD_TGAS: u64 = 20;
const MAX_CONTRACT_GAS_TGAS: u64 = 1_000;
/// Keep 20 TGas of slack so the originating `register_step` can still create the
/// yielded callback at the new PV 83 1 PGas ceiling.
const STEP_GAS_SLACK_TGAS: u64 = 20;
const MAX_STEP_GAS_TGAS: u64 = MAX_CONTRACT_GAS_TGAS
    - STEP_RESOLVE_CALLBACK_GAS_TGAS
    - STEP_RESUME_OVERHEAD_TGAS
    - STEP_GAS_SLACK_TGAS;
const ADAPTER_SEQUENCE_OVERHEAD_TGAS: u64 = 320;
const MAX_ADAPTER_TARGET_GAS_TGAS: u64 = MAX_STEP_GAS_TGAS - ADAPTER_SEQUENCE_OVERHEAD_TGAS;
/// Callback-visible resolution is intentionally bounded; oversized success
/// payloads are treated as sequencer failure rather than partial success.
const MAX_CALLBACK_RESULT_BYTES: usize = 16 * 1024;
/// Gas reserved for `on_asserted_run_postcheck` (reads target result and
/// constructs the check promise chain).
const ASSERTED_POSTCHECK_RUN_GAS_TGAS: u64 = 15;
/// Gas reserved for `on_asserted_evaluate_postcheck` (compares check-call
/// bytes to the caller-specified expected bytes).
const ASSERTED_POSTCHECK_EVALUATE_GAS_TGAS: u64 = 10;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    RegisteredSteps,
    SequenceQueue,
    SequenceTemplates,
    BalanceTriggers,
    AutomationRuns,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Step {
    pub step_id: String,
    pub target_id: AccountId,
    pub method_name: String,
    pub args: Vec<u8>,
    pub attached_deposit_yocto: u128,
    pub gas_tgas: u64,
    pub policy: StepPolicy,
}

#[near(serializers = [json])]
pub struct StepInput {
    pub step_id: String,
    pub target_id: AccountId,
    pub method_name: String,
    pub args: Base64VecU8,
    pub attached_deposit_yocto: U128,
    pub gas_tgas: u64,
    #[serde(default)]
    pub policy: StepPolicy,
}

#[near(serializers = [json])]
pub struct StepView {
    pub step_id: String,
    pub target_id: AccountId,
    pub method_name: String,
    pub args: Base64VecU8,
    pub attached_deposit_yocto: U128,
    pub gas_tgas: u64,
    pub policy: StepPolicy,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct RegisteredStep {
    pub yield_id: YieldId,
    pub call: Step,
    pub created_at_ms: u64,
}

#[near(serializers = [json])]
pub struct RegisteredStepView {
    pub step_id: String,
    pub target_id: AccountId,
    pub method_name: String,
    pub args: Base64VecU8,
    pub attached_deposit_yocto: U128,
    pub gas_tgas: u64,
    pub policy: StepPolicy,
    pub created_at_ms: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct SequenceTemplate {
    pub calls: Vec<Step>,
    pub saved_at_ms: u64,
    pub total_attached_deposit_yocto: u128,
}

#[near(serializers = [json])]
pub struct SequenceTemplateView {
    pub sequence_id: String,
    pub calls: Vec<StepView>,
    pub contains_adapter_calls: bool,
    pub contains_asserted_calls: bool,
    pub contains_non_direct_calls: bool,
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
    pub registered_steps: IterableMap<String, RegisteredStep>,
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
            registered_steps: IterableMap::new(StorageKey::RegisteredSteps),
            sequence_queue: IterableMap::new(StorageKey::SequenceQueue),
            sequence_templates: IterableMap::new(StorageKey::SequenceTemplates),
            balance_triggers: IterableMap::new(StorageKey::BalanceTriggers),
            automation_runs: IterableMap::new(StorageKey::AutomationRuns),
        }
    }

    // --- Manual yielded execution ---

    pub fn get_authorized_executor(&self) -> Option<AccountId> {
        self.authorized_executor.clone()
    }

    pub fn set_authorized_executor(&mut self, authorized_executor: Option<AccountId>) {
        self.assert_owner();
        self.authorized_executor = authorized_executor;
    }

    /// One-shot intent executor: register all steps under the caller's
    /// manual namespace and start ordered release atomically in a single tx.
    ///
    /// This is the recommended entry point for multi-step intents. It is
    /// equivalent to calling `register_step(...)` once per step and then
    /// `run_sequence(caller, order)`, but in one transaction and in the
    /// order the submitted `steps` vector was given.
    pub fn execute_steps(&mut self, steps: Vec<StepInput>) -> u32 {
        self.assert_executor();
        assert!(
            !steps.is_empty(),
            "execute_steps requires at least one step"
        );

        let caller = env::predecessor_account_id();
        let namespace = manual_namespace(&caller);
        let order: Vec<String> = steps.iter().map(|s| s.step_id.clone()).collect();

        // Reject duplicate step_ids up front so we don't half-register a
        // partial plan and then panic mid-run.
        let mut seen = std::collections::BTreeSet::new();
        for step_id in &order {
            assert!(
                seen.insert(step_id.clone()),
                "execute_steps: duplicate step_id in submitted plan"
            );
        }

        for step_input in steps {
            let call = Self::step_from_raw(
                step_input.step_id,
                step_input.target_id,
                step_input.method_name,
                step_input.args.0,
                step_input.attached_deposit_yocto.0,
                step_input.gas_tgas,
                step_input.policy,
            );
            self.register_step_in_namespace(&namespace, call).detach();
        }

        self.start_sequence_release_in_namespace(&namespace, order)
    }

    /// Register a yielded downstream call under `manual:{predecessor}`.
    ///
    /// Advanced usage. Most callers should use `execute_steps` instead, which
    /// registers all steps and starts release atomically. Use `register_step`
    /// only when you want to stage steps across multiple transactions before
    /// calling `run_sequence`.
    pub fn register_step(
        &mut self,
        target_id: AccountId,
        method_name: String,
        args: Base64VecU8,
        attached_deposit_yocto: U128,
        gas_tgas: u64,
        step_id: String,
        policy: Option<StepPolicy>,
    ) -> Promise {
        let caller = env::predecessor_account_id();
        let namespace = manual_namespace(&caller);
        let call = Self::step_from_raw(
            step_id,
            target_id,
            method_name,
            args.0,
            attached_deposit_yocto.0,
            gas_tgas,
            policy.unwrap_or_default(),
        );
        self.register_step_in_namespace(&namespace, call)
    }

    /// Resume the first pending step immediately and leave the rest queued so
    /// `on_step_resolved` can advance them one by one after each real
    /// downstream call completes.
    pub fn run_sequence(&mut self, caller_id: AccountId, order: Vec<String>) -> u32 {
        self.assert_executor();
        self.start_sequence_release_in_namespace(&manual_namespace(&caller_id), order)
    }

    #[private]
    pub fn on_step_resumed(
        &mut self,
        sequence_namespace: String,
        step_id: String,
        #[callback_result] resume_signal: Result<(), PromiseError>,
    ) -> PromiseOrValue<()> {
        let key = registered_step_key(&sequence_namespace, &step_id);
        let Some(yielded) = self.registered_steps.get(&key).cloned() else {
            env::log_str(&format!(
                "register_step '{step_id}' in {sequence_namespace} woke up but was no longer yielded"
            ));
            return PromiseOrValue::Value(());
        };

        match resume_signal {
            Ok(()) => {
                let dispatch_summary = Self::call_dispatch_summary(&yielded.call);
                let call_metadata = Self::call_metadata_json(&yielded.call);
                env::log_str(&format!(
                    "register_step '{step_id}' in {sequence_namespace} resumed and is dispatching real downstream work via {dispatch_summary}"
                ));
                Self::emit_event(
                    "step_resumed",
                    json!({
                        "step_id": step_id,
                        "namespace": sequence_namespace,
                        "registered_at_ms": yielded.created_at_ms,
                        "resume_latency_ms": env::block_timestamp_ms()
                            .saturating_sub(yielded.created_at_ms),
                        "call": call_metadata,
                    }),
                );
            }
            Err(error) => {
                let call_metadata = Self::call_metadata_json(&yielded.call);
                let registered_at_ms = yielded.created_at_ms;
                self.registered_steps.remove(&key);
                self.sequence_queue.remove(&sequence_namespace);
                self.finish_automation_run(
                    &sequence_namespace,
                    AutomationRunStatus::ResumeFailed,
                    Some(step_id.clone()),
                );
                env::log_str(&format!(
                    "register_step '{step_id}' in {sequence_namespace} could not resume, so its yielded promise was dropped and the sequence halted: {error:?}"
                ));
                Self::emit_event(
                    "sequence_halted",
                    json!({
                        "namespace": sequence_namespace,
                        "failed_step_id": step_id,
                        "reason": "resume_failed",
                        "error_kind": "resume_failed",
                        "error_msg": format!("{error:?}"),
                        "registered_at_ms": registered_at_ms,
                        "halt_latency_ms": env::block_timestamp_ms()
                            .saturating_sub(registered_at_ms),
                        "call": call_metadata,
                    }),
                );
                return PromiseOrValue::Value(());
            }
        }

        let finish_args = Self::encode_callback_args(&sequence_namespace, &step_id);
        let downstream = Self::dispatch_promise_for_call(&sequence_namespace, &yielded.call);
        let finish = Promise::new(env::current_account_id()).function_call(
            "on_step_resolved",
            finish_args,
            NearToken::from_yoctonear(0),
            Gas::from_tgas(STEP_RESOLVE_CALLBACK_GAS_TGAS),
        );
        PromiseOrValue::Promise(downstream.then(finish))
    }

    #[private]
    pub fn on_step_resolved(&mut self, sequence_namespace: String, step_id: String) {
        let key = registered_step_key(&sequence_namespace, &step_id);
        let (dispatch_summary, call_metadata, registered_at_ms) = self
            .registered_steps
            .get(&key)
            .map(|yielded| {
                (
                    Self::call_dispatch_summary(&yielded.call),
                    Self::call_metadata_json(&yielded.call),
                    yielded.created_at_ms,
                )
            })
            .unwrap_or_else(|| ("unknown dispatch".to_string(), json!(null), 0u64));
        let result = env::promise_result_checked(0, MAX_CALLBACK_RESULT_BYTES);

        self.registered_steps.remove(&key);

        match result {
            Ok(bytes) => {
                self.progress_sequence_after_successful_resolution(
                    &sequence_namespace,
                    &step_id,
                    &dispatch_summary,
                    bytes.len(),
                    &call_metadata,
                    registered_at_ms,
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
                    "register_step '{step_id}' in {sequence_namespace} failed downstream via {}; ordered release stopped here: {error:?}",
                    dispatch_summary
                ));
                Self::emit_event(
                    "step_resolved_err",
                    json!({
                        "step_id": step_id,
                        "namespace": sequence_namespace,
                        "error_kind": Self::resolve_error_kind(&error),
                        "error_msg": format!("{error:?}"),
                        "oversized_bytes": Self::resolve_error_oversized_bytes(&error),
                        "registered_at_ms": registered_at_ms,
                        "resolve_latency_ms": env::block_timestamp_ms().saturating_sub(registered_at_ms),
                        "call": call_metadata,
                    }),
                );
            }
        }
    }

    /// Private middle-callback for `StepPolicy::Asserted`. Reads the
    /// target's result and — if the target succeeded — fires the caller-
    /// specified postcheck call chained to `on_asserted_evaluate_postcheck`.
    /// If the target failed, panics so the outer `.then(on_step_resolved)`
    /// observes `PromiseError::Failed` and halts the sequence.
    #[private]
    pub fn on_asserted_run_postcheck(
        &self,
        sequence_namespace: String,
        step_id: String,
        assertion_id: AccountId,
        assertion_method: String,
        assertion_args: Base64VecU8,
        expected_return: Base64VecU8,
        assertion_gas_tgas: u64,
    ) -> Promise {
        let target_result = env::promise_result_checked(0, MAX_CALLBACK_RESULT_BYTES);
        match target_result {
            Err(error) => {
                env::panic_str(&format!(
                    "asserted step '{step_id}' in {sequence_namespace}: target failed before postcheck could run: {error:?}"
                ));
            }
            Ok(_bytes) => {
                let check_promise = Promise::new(assertion_id.clone()).function_call(
                    assertion_method.clone(),
                    assertion_args.0,
                    NearToken::from_yoctonear(0),
                    Gas::from_tgas(assertion_gas_tgas),
                );
                let evaluate_args = Self::encode_asserted_evaluate_args(
                    &sequence_namespace,
                    &step_id,
                    &expected_return,
                );
                let evaluate_callback = Promise::new(env::current_account_id()).function_call(
                    "on_asserted_evaluate_postcheck".to_string(),
                    evaluate_args,
                    NearToken::from_yoctonear(0),
                    Gas::from_tgas(ASSERTED_POSTCHECK_EVALUATE_GAS_TGAS),
                );
                check_promise.then(evaluate_callback)
            }
        }
    }

    /// Private terminal-callback for `StepPolicy::Asserted`. Compares the
    /// postcheck call's bytes to the caller-specified `expected_return`. Match →
    /// returns `()` (empty bytes) so `on_step_resolved` sees
    /// `Ok(_)` and advances the sequence. Mismatch → panics so
    /// `on_step_resolved` sees `PromiseError::Failed` and halts.
    #[private]
    pub fn on_asserted_evaluate_postcheck(
        &self,
        sequence_namespace: String,
        step_id: String,
        expected_return: Base64VecU8,
    ) {
        let check_result = env::promise_result_checked(0, MAX_CALLBACK_RESULT_BYTES);
        // The target step is still yielded at this point (on_step_resolved
        // hasn't fired yet), so we can include its full metadata — including
        // the assertion payload — because `assertion_checked` is the verdict
        // event where the bytes are load-bearing.
        let call_metadata = self
            .registered_steps
            .get(&registered_step_key(&sequence_namespace, &step_id))
            .map(|yielded| Self::call_metadata_json_full(&yielded.call))
            .unwrap_or(json!(null));
        match check_result {
            Err(error) => {
                Self::emit_event(
                    "assertion_checked",
                    json!({
                        "step_id": step_id,
                        "namespace": sequence_namespace,
                        "expected_bytes_len": expected_return.0.len(),
                        "actual_bytes_len": 0usize,
                        "expected_return": &expected_return,
                        "actual_return": Option::<Base64VecU8>::None,
                        "match": false,
                        "outcome": "postcheck_failed",
                        "error_kind": Self::resolve_error_kind(&error),
                        "error_msg": format!("{error:?}"),
                        "call": call_metadata,
                    }),
                );
                env::panic_str(&format!(
                    "asserted step '{step_id}' in {sequence_namespace}: postcheck call failed: {error:?}"
                ));
            }
            Ok(bytes) => {
                let actual_return = Base64VecU8::from(bytes.clone());
                let matched = bytes == expected_return.0;
                if !matched {
                    Self::emit_event(
                        "assertion_checked",
                        json!({
                            "step_id": step_id,
                            "namespace": sequence_namespace,
                            "expected_bytes_len": expected_return.0.len(),
                            "actual_bytes_len": bytes.len(),
                            "expected_return": &expected_return,
                            "actual_return": actual_return,
                            "match": false,
                            "outcome": "mismatch",
                            "call": call_metadata,
                        }),
                    );
                    env::panic_str(&format!(
                        "asserted step '{step_id}' in {sequence_namespace}: postcheck mismatch: expected={:?} actual={:?}",
                        String::from_utf8_lossy(&expected_return.0),
                        String::from_utf8_lossy(&bytes),
                    ));
                }
                env::log_str(&format!(
                    "asserted step '{step_id}' in {sequence_namespace}: postcheck matched ({} bytes)",
                    bytes.len()
                ));
                Self::emit_event(
                    "assertion_checked",
                    json!({
                        "step_id": step_id,
                        "namespace": sequence_namespace,
                        "expected_bytes_len": expected_return.0.len(),
                        "actual_bytes_len": bytes.len(),
                        "expected_return": &expected_return,
                        "actual_return": actual_return,
                        "match": true,
                        "outcome": "matched",
                        "call": call_metadata,
                    }),
                );
            }
        }
    }

    pub fn has_registered_step(&self, caller_id: AccountId, step_id: String) -> bool {
        self.registered_steps
            .get(&registered_step_key(&manual_namespace(&caller_id), &step_id))
            .is_some()
    }

    pub fn registered_steps_for(&self, caller_id: AccountId) -> Vec<RegisteredStepView> {
        self.registered_steps_for_namespace(&manual_namespace(&caller_id))
    }

    // --- Durable sequence templates ---

    pub fn save_sequence_template(
        &mut self,
        sequence_id: String,
        calls: Vec<StepInput>,
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
        let template_summary = self.sequence_templates.get(&trigger.sequence_id);
        Self::emit_event(
            "trigger_created",
            json!({
                "trigger_id": trigger_id,
                "sequence_id": trigger.sequence_id,
                "min_balance_yocto": trigger.min_balance_yocto.to_string(),
                "max_runs": trigger.max_runs,
                "created_at_ms": trigger.created_at_ms,
                "template_call_count": template_summary.map(|t| t.calls.len()),
                "template_total_deposit_yocto": template_summary
                    .map(|t| t.total_attached_deposit_yocto.to_string()),
            }),
        );
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
            self.register_step_in_namespace(&sequence_namespace, call.clone())
                .detach();
        }
        env::log_str(&format!(
            "execute_trigger '{trigger_id}' materialized {} yielded receipts in {sequence_namespace}",
            template.calls.len()
        ));
        Self::emit_event(
            "trigger_fired",
            json!({
                "trigger_id": trigger_id,
                "namespace": sequence_namespace,
                "sequence_id": trigger.sequence_id,
                "run_nonce": run_nonce,
                "executor_id": executor_id,
                "started_at_ms": now,
                "call_count": template.calls.len(),
                "runs_started": trigger.runs_started,
                "max_runs": trigger.max_runs,
                "runs_remaining": trigger.max_runs.saturating_sub(trigger.runs_started),
                "min_balance_yocto": trigger.min_balance_yocto.to_string(),
                "balance_yocto": current_balance_yocto.to_string(),
                "required_balance_yocto": required_balance_yocto.to_string(),
                "template_total_deposit_yocto":
                    template.total_attached_deposit_yocto.to_string(),
                "trigger_created_at_ms": trigger.created_at_ms,
            }),
        );

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

    fn step_from_raw(
        step_id: String,
        target_id: AccountId,
        method_name: String,
        args: Vec<u8>,
        attached_deposit_yocto: u128,
        gas_tgas: u64,
        policy: StepPolicy,
    ) -> Step {
        let call = Step {
            step_id,
            target_id,
            method_name,
            args,
            attached_deposit_yocto,
            gas_tgas,
            policy,
        };
        Self::validate_step(&call);
        call
    }

    fn validate_sequence_template_inputs(
        calls: Vec<StepInput>,
    ) -> (Vec<Step>, u128) {
        let mut seen = std::collections::BTreeSet::new();
        let mut total_attached_deposit_yocto = 0_u128;
        let validated_calls = calls
            .into_iter()
            .map(|call| {
                let validated = Self::step_from_raw(
                    call.step_id,
                    call.target_id,
                    call.method_name,
                    call.args.0,
                    call.attached_deposit_yocto.0,
                    call.gas_tgas,
                    call.policy,
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

    fn validate_step(call: &Step) {
        assert!(!call.step_id.is_empty(), "step_id cannot be empty");
        assert!(!call.method_name.is_empty(), "method_name cannot be empty");
        assert!(call.gas_tgas > 0, "gas_tgas must be greater than zero");
        match &call.policy {
            StepPolicy::Direct => {}
            StepPolicy::Adapter { adapter_method, .. } => {
                assert!(!adapter_method.is_empty(), "adapter_method cannot be empty");
            }
            StepPolicy::Asserted {
                assertion_method,
                assertion_gas_tgas,
                ..
            } => {
                assert!(
                    !assertion_method.is_empty(),
                    "assertion_method cannot be empty"
                );
                assert!(
                    *assertion_gas_tgas > 0,
                    "assertion_gas_tgas must be greater than zero"
                );
                assert!(
                    *assertion_gas_tgas <= MAX_STEP_GAS_TGAS,
                    "assertion_gas_tgas exceeds per-step gas cap"
                );
            }
        }
        assert!(
            call.gas_tgas <= Self::max_target_gas_tgas(&call.policy),
            "gas_tgas is too large for this resolution policy"
        );
    }

    fn step_view_from_call(call: &Step) -> StepView {
        StepView {
            step_id: call.step_id.clone(),
            target_id: call.target_id.clone(),
            method_name: call.method_name.clone(),
            args: Base64VecU8::from(call.args.clone()),
            attached_deposit_yocto: U128(call.attached_deposit_yocto),
            gas_tgas: call.gas_tgas,
            policy: call.policy.clone(),
        }
    }

    fn registered_step_view(yielded: &RegisteredStep) -> RegisteredStepView {
        RegisteredStepView {
            step_id: yielded.call.step_id.clone(),
            target_id: yielded.call.target_id.clone(),
            method_name: yielded.call.method_name.clone(),
            args: Base64VecU8::from(yielded.call.args.clone()),
            attached_deposit_yocto: U128(yielded.call.attached_deposit_yocto),
            gas_tgas: yielded.call.gas_tgas,
            policy: yielded.call.policy.clone(),
            created_at_ms: yielded.created_at_ms,
        }
    }

    fn sequence_template_view(
        sequence_id: String,
        template: &SequenceTemplate,
    ) -> SequenceTemplateView {
        let contains_adapter_calls = template
            .calls
            .iter()
            .any(|call| matches!(call.policy, StepPolicy::Adapter { .. }));
        let contains_asserted_calls = template
            .calls
            .iter()
            .any(|call| matches!(call.policy, StepPolicy::Asserted { .. }));
        SequenceTemplateView {
            sequence_id,
            calls: template
                .calls
                .iter()
                .map(Self::step_view_from_call)
                .collect(),
            contains_adapter_calls,
            contains_asserted_calls,
            contains_non_direct_calls: template
                .calls
                .iter()
                .any(|call| !matches!(call.policy, StepPolicy::Direct)),
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

    fn register_step_in_namespace(
        &mut self,
        sequence_namespace: &str,
        call: Step,
    ) -> Promise {
        let key = registered_step_key(sequence_namespace, &call.step_id);
        assert!(
            self.registered_steps.get(&key).is_none(),
            "step_id already yielded for this sequence"
        );

        let step_id = call.step_id.clone();
        let dispatch_summary = Self::call_dispatch_summary(&call);
        let call_metadata = Self::call_metadata_json_full(&call);
        let resume_callback_gas = Gas::from_tgas(
            call.gas_tgas
                + Self::adapter_overhead_tgas(&call.policy)
                + STEP_RESOLVE_CALLBACK_GAS_TGAS
                + STEP_RESUME_OVERHEAD_TGAS,
        );
        let callback_args = Self::encode_callback_args(sequence_namespace, &call.step_id);
        let (register_step, yield_id) = Promise::new_yield(
            "on_step_resumed",
            callback_args,
            resume_callback_gas,
            GasWeight::default(),
        );

        let registered_at_ms = env::block_timestamp_ms();
        self.registered_steps.insert(
            key,
            RegisteredStep {
                yield_id,
                call,
                created_at_ms: registered_at_ms,
            },
        );
        env::log_str(&format!(
            "register_step '{step_id}' in {sequence_namespace} yielded and waiting for resume via {dispatch_summary}"
        ));
        Self::emit_event(
            "step_registered",
            json!({
                "step_id": step_id,
                "namespace": sequence_namespace,
                "registered_at_ms": registered_at_ms,
                "resume_callback_gas_tgas": resume_callback_gas.as_tgas(),
                "call": call_metadata,
            }),
        );

        register_step
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
                self.registered_steps
                    .get(&registered_step_key(sequence_namespace, step_id))
                    .is_some(),
                "step_id '{step_id}' not yielded for this sequence"
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

        if let Err(message) = self.resume_registered_step(sequence_namespace, &first) {
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
        let automation_context = self.automation_runs.get(sequence_namespace).map(|run| {
            json!({
                "trigger_id": run.trigger_id,
                "sequence_id": run.sequence_id,
                "run_nonce": run.run_nonce,
                "executor_id": run.executor_id,
                "started_at_ms": run.started_at_ms,
            })
        });
        let origin = if automation_context.is_some() {
            "automation"
        } else {
            "manual"
        };
        Self::emit_event(
            "sequence_started",
            json!({
                "namespace": sequence_namespace,
                "first_step_id": first,
                "queued_count": queued,
                "total_steps": n,
                "automation_run": automation_context,
                "origin": origin,
            }),
        );

        n
    }

    fn encode_callback_args(sequence_namespace: &str, step_id: &str) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "sequence_namespace": sequence_namespace,
            "step_id": step_id,
        }))
        .unwrap_or_else(|_| env::panic_str("failed to encode register_step callback args"))
    }

    // --- Structured event emission (NEP-297, standard = "sa-automation") ---

    /// Emit a structured NEP-297 event alongside the existing prose logs.
    /// Consumers parse any log line starting with `EVENT_JSON:` as JSON with
    /// `{ standard, version, event, data }`.
    ///
    /// Every event automatically carries a `data.runtime` object with the
    /// on-chain snapshot visible at emission time: block, gas, deposit,
    /// balance, storage, and the three account-ids (predecessor/current/signer).
    /// Event-specific fields live alongside `runtime` under `data` and are
    /// documented in `TELEMETRY-DESIGN.md` §3.
    fn emit_event(event: &str, mut data: serde_json::Value) {
        if let serde_json::Value::Object(ref mut map) = data {
            map.insert("runtime".to_string(), Self::runtime_snapshot_json());
        }
        let payload = json!({
            "standard": "sa-automation",
            "version": "1.1.0",
            "event": event,
            "data": data,
        });
        env::log_str(&format!("EVENT_JSON:{payload}"));
    }

    /// Capture everything the VM makes cheap to observe at the current
    /// emission site. All values here come from the `env` host API and cost
    /// a few million gas total — trivially smaller than a single storage
    /// write. Consumers should read this as "ground truth visible on-chain
    /// when this log line was emitted."
    fn runtime_snapshot_json() -> serde_json::Value {
        json!({
            "block_height": env::block_height(),
            "block_timestamp_ms": env::block_timestamp_ms(),
            "epoch_height": env::epoch_height(),
            "used_gas_tgas": env::used_gas().as_tgas(),
            "prepaid_gas_tgas": env::prepaid_gas().as_tgas(),
            "attached_deposit_yocto": env::attached_deposit().as_yoctonear().to_string(),
            "account_balance_yocto": env::account_balance().as_yoctonear().to_string(),
            "account_locked_balance_yocto": env::account_locked_balance().as_yoctonear().to_string(),
            "storage_usage": env::storage_usage(),
            "predecessor_id": env::predecessor_account_id(),
            "current_account_id": env::current_account_id(),
            "signer_id": env::signer_account_id(),
        })
    }

    /// Structured description of a yielded promise without the full assertion
    /// payload. For Asserted calls this still names the assertion target
    /// (`assertion_id`, `assertion_method`, `assertion_gas_tgas`) and its
    /// byte-size footprint (`assertion_args_bytes_len`,
    /// `expected_return_bytes_len`), but skips the raw bytes — those appear
    /// only on `step_registered` and `assertion_checked`. This keeps
    /// intermediate events (step_resumed, step_resolved_ok/err,
    /// sequence_halted) small even when the assertion payload is large.
    fn call_metadata_json(call: &Step) -> serde_json::Value {
        Self::call_metadata_json_impl(call, false)
    }

    /// Same as `call_metadata_json` but also embeds the full assertion
    /// payload (`assertion_args`, `expected_return` as base64). Use this
    /// only at the two events where the payload is load-bearing:
    /// `step_registered` (the step's "birth" — full spec of intent)
    /// and `assertion_checked` (the verdict — needs the bytes to explain
    /// the match/mismatch outcome).
    fn call_metadata_json_full(call: &Step) -> serde_json::Value {
        Self::call_metadata_json_impl(call, true)
    }

    fn call_metadata_json_impl(
        call: &Step,
        include_assertion_payload: bool,
    ) -> serde_json::Value {
        let mut v = json!({
            "target_id": call.target_id,
            "method": call.method_name,
            "args_bytes_len": call.args.len(),
            "deposit_yocto": call.attached_deposit_yocto.to_string(),
            "gas_tgas": call.gas_tgas,
            "policy": Self::step_policy_label(&call.policy),
            "dispatch_summary": Self::call_dispatch_summary(call),
        });
        if let serde_json::Value::Object(map) = &mut v {
            match &call.policy {
                StepPolicy::Direct => {}
                StepPolicy::Adapter {
                    adapter_id,
                    adapter_method,
                } => {
                    map.insert("adapter_id".to_string(), json!(adapter_id));
                    map.insert("adapter_method".to_string(), json!(adapter_method));
                }
                StepPolicy::Asserted {
                    assertion_id,
                    assertion_method,
                    assertion_args,
                    expected_return,
                    assertion_gas_tgas,
                } => {
                    map.insert("assertion_id".to_string(), json!(assertion_id));
                    map.insert("assertion_method".to_string(), json!(assertion_method));
                    map.insert(
                        "assertion_gas_tgas".to_string(),
                        json!(assertion_gas_tgas),
                    );
                    map.insert(
                        "assertion_args_bytes_len".to_string(),
                        json!(assertion_args.0.len()),
                    );
                    map.insert(
                        "expected_return_bytes_len".to_string(),
                        json!(expected_return.0.len()),
                    );
                    if include_assertion_payload {
                        map.insert("assertion_args".to_string(), json!(assertion_args));
                        map.insert("expected_return".to_string(), json!(expected_return));
                    }
                }
            }
        }
        v
    }

    fn step_policy_label(policy: &StepPolicy) -> &'static str {
        match policy {
            StepPolicy::Direct => "direct",
            StepPolicy::Adapter { .. } => "adapter",
            StepPolicy::Asserted { .. } => "asserted",
        }
    }

    fn resolve_error_kind(error: &PromiseError) -> &'static str {
        match error {
            PromiseError::Failed => "downstream_failed",
            PromiseError::TooLong(_) => "result_oversized",
            _ => "unknown",
        }
    }

    fn resolve_error_oversized_bytes(error: &PromiseError) -> Option<usize> {
        match error {
            PromiseError::TooLong(size) => Some(*size),
            _ => None,
        }
    }

    fn encode_adapter_dispatch_args(call: &Step) -> Vec<u8> {
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

    fn encode_asserted_postcheck_args(
        sequence_namespace: &str,
        step_id: &str,
        assertion_id: &AccountId,
        assertion_method: &str,
        assertion_args: &Base64VecU8,
        expected_return: &Base64VecU8,
        assertion_gas_tgas: u64,
    ) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "sequence_namespace": sequence_namespace,
            "step_id": step_id,
            "assertion_id": assertion_id,
            "assertion_method": assertion_method,
            "assertion_args": assertion_args,
            "expected_return": expected_return,
            "assertion_gas_tgas": assertion_gas_tgas,
        }))
        .unwrap_or_else(|_| env::panic_str("failed to encode asserted postcheck args"))
    }

    fn encode_asserted_evaluate_args(
        sequence_namespace: &str,
        step_id: &str,
        expected_return: &Base64VecU8,
    ) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "sequence_namespace": sequence_namespace,
            "step_id": step_id,
            "expected_return": expected_return,
        }))
        .unwrap_or_else(|_| env::panic_str("failed to encode asserted evaluate args"))
    }

    fn resume_registered_step(&self, sequence_namespace: &str, step_id: &str) -> Result<(), String> {
        let key = registered_step_key(sequence_namespace, step_id);
        let yielded = self
            .registered_steps
            .get(&key)
            .ok_or_else(|| format!("step_id '{step_id}' not yielded for this sequence"))?;

        let payload = Self::encode_resume_payload();
        yielded
            .yield_id
            .resume(payload)
            .map_err(|_| format!("failed to resume yielded step '{step_id}'"))
    }

    fn dispatch_promise_for_call(sequence_namespace: &str, call: &Step) -> Promise {
        match &call.policy {
            StepPolicy::Direct => Promise::new(call.target_id.clone()).function_call(
                call.method_name.clone(),
                call.args.clone(),
                NearToken::from_yoctonear(call.attached_deposit_yocto),
                Gas::from_tgas(call.gas_tgas),
            ),
            StepPolicy::Adapter {
                adapter_id,
                adapter_method,
            } => Promise::new(adapter_id.clone()).function_call(
                adapter_method.clone(),
                Self::encode_adapter_dispatch_args(call),
                NearToken::from_yoctonear(call.attached_deposit_yocto),
                Gas::from_tgas(call.gas_tgas + ADAPTER_SEQUENCE_OVERHEAD_TGAS),
            ),
            StepPolicy::Asserted {
                assertion_id,
                assertion_method,
                assertion_args,
                expected_return,
                assertion_gas_tgas,
            } => {
                let target_promise = Promise::new(call.target_id.clone()).function_call(
                    call.method_name.clone(),
                    call.args.clone(),
                    NearToken::from_yoctonear(call.attached_deposit_yocto),
                    Gas::from_tgas(call.gas_tgas),
                );
                let postcheck_args = Self::encode_asserted_postcheck_args(
                    sequence_namespace,
                    &call.step_id,
                    assertion_id,
                    assertion_method,
                    assertion_args,
                    expected_return,
                    *assertion_gas_tgas,
                );
                let postcheck_callback = Promise::new(env::current_account_id()).function_call(
                    "on_asserted_run_postcheck".to_string(),
                    postcheck_args,
                    NearToken::from_yoctonear(0),
                    Gas::from_tgas(
                        ASSERTED_POSTCHECK_RUN_GAS_TGAS
                            + *assertion_gas_tgas
                            + ASSERTED_POSTCHECK_EVALUATE_GAS_TGAS,
                    ),
                );
                target_promise.then(postcheck_callback)
            }
        }
    }

    fn call_dispatch_summary(call: &Step) -> String {
        match &call.policy {
            StepPolicy::Direct => format!("direct {}.{}", call.target_id, call.method_name),
            StepPolicy::Adapter {
                adapter_id,
                adapter_method,
            } => format!(
                "adapter {}.{} wrapping {}.{}",
                adapter_id, adapter_method, call.target_id, call.method_name
            ),
            StepPolicy::Asserted {
                assertion_id,
                assertion_method,
                ..
            } => format!(
                "asserted {}.{} postchecked by {}.{}",
                call.target_id, call.method_name, assertion_id, assertion_method
            ),
        }
    }

    fn adapter_overhead_tgas(policy: &StepPolicy) -> u64 {
        match policy {
            StepPolicy::Direct => 0,
            StepPolicy::Adapter { .. } => ADAPTER_SEQUENCE_OVERHEAD_TGAS,
            StepPolicy::Asserted {
                assertion_gas_tgas, ..
            } => {
                ASSERTED_POSTCHECK_RUN_GAS_TGAS
                    + ASSERTED_POSTCHECK_EVALUATE_GAS_TGAS
                    + *assertion_gas_tgas
            }
        }
    }

    fn max_target_gas_tgas(policy: &StepPolicy) -> u64 {
        match policy {
            StepPolicy::Direct => MAX_STEP_GAS_TGAS,
            StepPolicy::Adapter { .. } => MAX_ADAPTER_TARGET_GAS_TGAS,
            StepPolicy::Asserted { .. } => {
                MAX_STEP_GAS_TGAS.saturating_sub(Self::adapter_overhead_tgas(policy))
            }
        }
    }

    fn registered_steps_for_namespace(&self, sequence_namespace: &str) -> Vec<RegisteredStepView> {
        let prefix = format!("{sequence_namespace}#");
        self.registered_steps
            .iter()
            .filter_map(|(key, yielded)| {
                if key.starts_with(&prefix) {
                    Some(Self::registered_step_view(yielded))
                } else {
                    None
                }
            })
            .collect()
    }

    // --- Sequencing kernel: progression after resolution ---

    fn progress_sequence_after_successful_resolution(
        &mut self,
        sequence_namespace: &str,
        resolved_step_id: &str,
        dispatch_summary: &str,
        result_len: usize,
        call_metadata: &serde_json::Value,
        registered_at_ms: u64,
    ) {
        let resolve_latency_ms = env::block_timestamp_ms().saturating_sub(registered_at_ms);

        if let Some(next) = self.take_next_queued_step(sequence_namespace) {
            env::log_str(&format!(
                "register_step '{resolved_step_id}' in {sequence_namespace} resolved successfully via {dispatch_summary} ({result_len} result bytes); resuming step '{next}' next"
            ));
            Self::emit_event(
                "step_resolved_ok",
                json!({
                    "step_id": resolved_step_id,
                    "namespace": sequence_namespace,
                    "result_bytes_len": result_len,
                    "next_step_id": next,
                    "registered_at_ms": registered_at_ms,
                    "resolve_latency_ms": resolve_latency_ms,
                    "call": call_metadata,
                }),
            );
            if let Err(message) = self.resume_registered_step(sequence_namespace, &next) {
                self.sequence_queue.remove(sequence_namespace);
                self.finish_automation_run(
                    sequence_namespace,
                    AutomationRunStatus::ResumeFailed,
                    Some(next.clone()),
                );
                env::log_str(&format!(
                    "register_step '{resolved_step_id}' in {sequence_namespace} resolved, but the next yielded step '{next}' could not be resumed: {message}"
                ));
                Self::emit_event(
                    "sequence_halted",
                    json!({
                        "namespace": sequence_namespace,
                        "failed_step_id": next,
                        "reason": "resume_failed",
                        "error_kind": "resume_failed",
                        "after_step_id": resolved_step_id,
                        "error_msg": message,
                    }),
                );
            }
        } else {
            env::log_str(&format!(
                "register_step '{resolved_step_id}' in {sequence_namespace} resolved successfully via {dispatch_summary} ({result_len} result bytes); sequence completed"
            ));
            Self::emit_event(
                "step_resolved_ok",
                json!({
                    "step_id": resolved_step_id,
                    "namespace": sequence_namespace,
                    "result_bytes_len": result_len,
                    "next_step_id": Option::<String>::None,
                    "registered_at_ms": registered_at_ms,
                    "resolve_latency_ms": resolve_latency_ms,
                    "call": call_metadata,
                }),
            );
            Self::emit_event(
                "sequence_completed",
                json!({
                    "namespace": sequence_namespace,
                    "final_step_id": resolved_step_id,
                    "final_result_bytes_len": result_len,
                }),
            );
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

        let duration_ms = run
            .finished_at_ms
            .map(|finished| finished.saturating_sub(run.started_at_ms));
        Self::emit_event(
            "run_finished",
            json!({
                "trigger_id": run.trigger_id,
                "namespace": sequence_namespace,
                "sequence_id": run.sequence_id,
                "run_nonce": run.run_nonce,
                "executor_id": run.executor_id,
                "status": format!("{status:?}"),
                "started_at_ms": run.started_at_ms,
                "finished_at_ms": run.finished_at_ms,
                "duration_ms": duration_ms,
                "failed_step_id": run.failed_step_id,
            }),
        );

        self.clear_registered_namespace(sequence_namespace);
        self.sequence_queue.remove(sequence_namespace);
    }

    fn clear_registered_namespace(&mut self, sequence_namespace: &str) {
        let prefix = format!("{sequence_namespace}#");
        let keys: Vec<String> = self
            .registered_steps
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
            self.registered_steps.remove(&key);
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

fn registered_step_key(sequence_namespace: &str, step_id: &str) -> String {
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

    fn pathological_router() -> AccountId {
        "pathological-router.near".parse().unwrap()
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

    fn yield_input(step_id: &str, n: u32) -> StepInput {
        yield_input_with_policy(step_id, n, StepPolicy::Direct)
    }

    fn yield_input_with_policy(
        step_id: &str,
        n: u32,
        policy: StepPolicy,
    ) -> StepInput {
        StepInput {
            step_id: step_id.into(),
            target_id: router(),
            method_name: "route_echo".into(),
            args: Base64VecU8::from(format!(r#"{{"callee":"{}","n":{}}}"#, echo(), n).into_bytes()),
            attached_deposit_yocto: U128(0),
            gas_tgas: 40,
            policy,
        }
    }

    fn adapter_yield_input(step_id: &str, n: u32) -> StepInput {
        StepInput {
            step_id: step_id.into(),
            target_id: wild_router(),
            method_name: "route_echo_fire_and_forget".into(),
            args: Base64VecU8::from(format!(r#"{{"callee":"{}","n":{}}}"#, echo(), n).into_bytes()),
            attached_deposit_yocto: U128(0),
            gas_tgas: 40,
            policy: adapter_policy(),
        }
    }

    fn adapter_policy() -> StepPolicy {
        StepPolicy::Adapter {
            adapter_id: adapter(),
            adapter_method: "adapt_fire_and_forget_route_echo".into(),
        }
    }

    fn asserted_policy(expected_return: Vec<u8>) -> StepPolicy {
        StepPolicy::Asserted {
            assertion_id: pathological_router(),
            assertion_method: "get_calls_completed".into(),
            assertion_args: Base64VecU8::from(br#"{}"#.to_vec()),
            expected_return: Base64VecU8::from(expected_return),
            assertion_gas_tgas: 30,
        }
    }

    fn asserted_yield_input(step_id: &str, expected_return: Vec<u8>) -> StepInput {
        StepInput {
            step_id: step_id.into(),
            target_id: pathological_router(),
            method_name: "do_honest_work".into(),
            args: Base64VecU8::from(br#"{"label":"probe"}"#.to_vec()),
            attached_deposit_yocto: U128(0),
            gas_tgas: 40,
            policy: asserted_policy(expected_return),
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
        c.save_sequence_template(sequence_id.clone(), vec![yield_input("alpha", 1)]);
        c.create_balance_trigger(trigger_id.clone(), sequence_id.clone(), U128(0), max_runs);
        (c, sequence_id, trigger_id)
    }

    #[test]
    fn register_step_registers_yielded_view() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        let _ = c.register_step(
            echo(),
            "echo".into(),
            Base64VecU8::from(br#"{"n":7}"#.to_vec()),
            U128(0),
            30,
            "alpha".into(),
            None,
        );

        assert!(c.has_registered_step(owner(), "alpha".into()));
        let yielded = c.registered_steps_for(owner());
        assert_eq!(yielded.len(), 1);
        assert_eq!(yielded[0].step_id, "alpha");
        assert_eq!(yielded[0].target_id, echo());
        assert_eq!(yielded[0].method_name, "echo");
    }

    #[test]
    fn register_step_allocates_distinct_yielded_receipt_per_step() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        let _ = c.register_step(
            echo(),
            "echo".into(),
            Base64VecU8::from(br#"{"n":5}"#.to_vec()),
            U128(0),
            30,
            "alpha".into(),
            None,
        );
        let _ = c.register_step(
            echo(),
            "echo".into(),
            Base64VecU8::from(br#"{"n":6}"#.to_vec()),
            U128(0),
            30,
            "beta".into(),
            None,
        );

        let alpha = c
            .registered_steps
            .get(&registered_step_key(&manual_namespace(&owner()), "alpha"))
            .unwrap();
        let beta = c
            .registered_steps
            .get(&registered_step_key(&manual_namespace(&owner()), "beta"))
            .unwrap();
        assert_ne!(alpha.yield_id, beta.yield_id);
    }

    #[test]
    fn register_step_accepts_pv83_max_call_gas() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        let _ = c.register_step(
            echo(),
            "echo".into(),
            Base64VecU8::from(br#"{"n":9}"#.to_vec()),
            U128(0),
            MAX_STEP_GAS_TGAS,
            "max".into(),
            None,
        );

        let yielded = c.registered_steps_for(owner());
        assert_eq!(yielded.len(), 1);
        assert_eq!(yielded[0].gas_tgas, MAX_STEP_GAS_TGAS);
    }

    #[test]
    #[should_panic(expected = "step_id already yielded for this sequence")]
    fn register_step_rejects_duplicate_step_id() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        let _ = c.register_step(
            echo(),
            "echo".into(),
            Base64VecU8::from(br#"{"n":1}"#.to_vec()),
            U128(0),
            30,
            "alpha".into(),
            None,
        );
        let _ = c.register_step(
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
    fn register_step_rejects_over_max_gas() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        let _ = c.register_step(
            echo(),
            "echo".into(),
            Base64VecU8::from(br#"{"n":1}"#.to_vec()),
            U128(0),
            MAX_STEP_GAS_TGAS + 1,
            "alpha".into(),
            None,
        );
    }

    #[test]
    fn execute_steps_registers_single_step_and_starts_release() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());

        let count = c.execute_steps(vec![yield_input("alpha", 1)]);

        assert_eq!(count, 1);
        assert!(c.has_registered_step(owner(), "alpha".into()));
        assert_eq!(
            c.registered_steps_for(owner())[0].step_id,
            "alpha".to_string()
        );
    }

    #[test]
    fn execute_steps_registers_multi_step_plan_in_submission_order() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());

        let count = c.execute_steps(vec![
            yield_input("alpha", 1),
            yield_input("beta", 2),
            yield_input("gamma", 3),
        ]);

        assert_eq!(count, 3);
        let registered = c.registered_steps_for(owner());
        assert_eq!(registered.len(), 3);
        let ids: Vec<String> = registered.into_iter().map(|view| view.step_id).collect();
        assert_eq!(ids, vec!["alpha", "beta", "gamma"]);
    }

    #[test]
    #[should_panic(expected = "duplicate step_id in submitted plan")]
    fn execute_steps_rejects_duplicate_step_ids() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        c.execute_steps(vec![
            yield_input("alpha", 1),
            yield_input("alpha", 2),
        ]);
    }

    #[test]
    #[should_panic(expected = "execute_steps requires at least one step")]
    fn execute_steps_rejects_empty_plan() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        c.execute_steps(vec![]);
    }

    #[test]
    fn execute_steps_accepts_mixed_policy_plan() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());

        let count = c.execute_steps(vec![
            yield_input("alpha", 1),
            asserted_yield_input("beta", b"1".to_vec()),
        ]);

        assert_eq!(count, 2);
        let registered = c.registered_steps_for(owner());
        assert_eq!(registered.len(), 2);
        assert!(matches!(registered[0].policy, StepPolicy::Direct));
        assert!(matches!(
            registered[1].policy,
            StepPolicy::Asserted { .. }
        ));
    }

    #[test]
    #[should_panic(expected = "caller is not allowed to execute sequences")]
    fn execute_steps_requires_authorized_executor() {
        ctx(stranger());
        let mut c = Contract::new_with_owner(owner());
        c.execute_steps(vec![yield_input("alpha", 1)]);
    }

    #[test]
    fn direct_policy_treats_empty_success_bytes_as_successful_resolution() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        let _ = c.register_step(
            echo(),
            "echo".into(),
            Base64VecU8::from(br#"{"n":7}"#.to_vec()),
            U128(0),
            30,
            "alpha".into(),
            None,
        );
        let _ = c.register_step(
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
        c.on_step_resolved(manual_namespace(&owner()), "alpha".into());

        assert!(!c.has_registered_step(owner(), "alpha".into()));
        assert!(c.sequence_queue.get(&manual_namespace(&owner())).is_none());
        assert!(c.has_registered_step(owner(), "beta".into()));
    }

    #[test]
    fn adapter_policy_dispatches_to_adapter_contract() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        let _ = c.register_step(
            wild_router(),
            "route_echo_fire_and_forget".into(),
            Base64VecU8::from(format!(r#"{{"callee":"{}","n":9}}"#, echo()).into_bytes()),
            U128(0),
            40,
            "alpha".into(),
            Some(adapter_policy()),
        );

        ctx(current());
        let result = c.on_step_resumed(manual_namespace(&owner()), "alpha".into(), Ok(()));
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
    #[should_panic(expected = "not yielded for this sequence")]
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
            let _ = c.register_step(
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
        assert!(c.has_registered_step(owner(), "alpha".into()));
    }

    #[test]
    fn successful_progression_resumes_next_step_only_after_downstream_completion() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        let _ = c.register_step(
            echo(),
            "echo".into(),
            Base64VecU8::from(br#"{"n":1}"#.to_vec()),
            U128(0),
            30,
            "alpha".into(),
            None,
        );
        let _ = c.register_step(
            echo(),
            "echo".into(),
            Base64VecU8::from(br#"{"n":2}"#.to_vec()),
            U128(0),
            30,
            "beta".into(),
            None,
        );

        c.run_sequence(owner(), vec!["alpha".into(), "beta".into()]);
        c.registered_steps
            .remove(&registered_step_key(&manual_namespace(&owner()), "alpha"));
        c.progress_sequence_after_successful_resolution(
            &manual_namespace(&owner()),
            "alpha",
            "direct echo.near.echo",
            1,
            &near_sdk::serde_json::Value::Null,
            0,
        );

        assert!(c.sequence_queue.get(&manual_namespace(&owner())).is_none());
        assert!(c.has_registered_step(owner(), "beta".into()));
    }

    #[test]
    fn downstream_failure_halts_without_resuming_next_step() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        let _ = c.register_step(
            echo(),
            "echo".into(),
            Base64VecU8::from(br#"{"n":1}"#.to_vec()),
            U128(0),
            30,
            "alpha".into(),
            None,
        );
        let _ = c.register_step(
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
        c.on_step_resolved(manual_namespace(&owner()), "alpha".into());

        assert!(c.sequence_queue.get(&manual_namespace(&owner())).is_none());
        assert!(c.has_registered_step(owner(), "beta".into()));
    }

    #[test]
    fn sequence_template_crud_roundtrip() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        c.save_sequence_template(
            "router-demo".into(),
            vec![yield_input("alpha", 1), yield_input("beta", 2)],
        );

        let listed = c.list_sequence_templates();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].sequence_id, "router-demo");
        assert_eq!(listed[0].calls.len(), 2);
        assert!(!listed[0].contains_adapter_calls);
        assert!(!listed[0].contains_asserted_calls);
        assert!(!listed[0].contains_non_direct_calls);
        assert!(c.delete_sequence_template("router-demo".into()));
        assert!(c.get_sequence_template("router-demo".into()).is_none());
    }

    #[test]
    fn sequence_template_reports_adapter_only_summary_flags() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        c.save_sequence_template(
            "adapter-demo".into(),
            vec![adapter_yield_input("alpha", 1)],
        );

        let template = c.get_sequence_template("adapter-demo".into()).unwrap();
        assert!(template.contains_adapter_calls);
        assert!(!template.contains_asserted_calls);
        assert!(template.contains_non_direct_calls);
        assert_eq!(template.calls[0].policy, adapter_policy());
    }

    #[test]
    fn sequence_template_reports_asserted_only_summary_flags() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        c.save_sequence_template(
            "asserted-demo".into(),
            vec![asserted_yield_input("alpha", b"1".to_vec())],
        );

        let template = c.get_sequence_template("asserted-demo".into()).unwrap();
        assert!(!template.contains_adapter_calls);
        assert!(template.contains_asserted_calls);
        assert!(template.contains_non_direct_calls);
        assert!(matches!(
            template.calls[0].policy,
            StepPolicy::Asserted { .. }
        ));
    }

    #[test]
    fn sequence_template_reports_mixed_policies() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        c.save_sequence_template(
            "mixed-demo".into(),
            vec![
                yield_input("alpha", 1),
                adapter_yield_input("beta", 2),
                asserted_yield_input("gamma", b"1".to_vec()),
            ],
        );

        let template = c.get_sequence_template("mixed-demo".into()).unwrap();
        assert!(template.contains_adapter_calls);
        assert!(template.contains_asserted_calls);
        assert!(template.contains_non_direct_calls);
        assert_eq!(template.calls[0].policy, StepPolicy::Direct);
        assert_eq!(template.calls[1].policy, adapter_policy());
        assert!(matches!(
            template.calls[2].policy,
            StepPolicy::Asserted { .. }
        ));
    }

    #[test]
    #[should_panic(expected = "owner-only")]
    fn save_sequence_template_requires_owner() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        ctx(stranger());
        c.save_sequence_template("router-demo".into(), vec![yield_input("alpha", 1)]);
    }

    #[test]
    #[should_panic(expected = "sequence template is still referenced")]
    fn delete_sequence_template_rejects_referenced_trigger() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        c.save_sequence_template("router-demo".into(), vec![yield_input("alpha", 1)]);
        c.create_balance_trigger("balance-demo".into(), "router-demo".into(), U128(0), 1);
        c.delete_sequence_template("router-demo".into());
    }

    #[test]
    fn balance_trigger_crud_roundtrip() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        c.save_sequence_template("router-demo".into(), vec![yield_input("alpha", 1)]);
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
        c.save_sequence_template("router-demo".into(), vec![yield_input("alpha", 1)]);
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
        c.save_sequence_template("router-demo".into(), vec![yield_input("alpha", 1)]);
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
            vec![yield_input("alpha", 1), yield_input("beta", 2)],
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

        let yielded = c.registered_steps_for_namespace("auto:balance-demo:1");
        assert_eq!(yielded.len(), 2);
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
                yield_input("alpha", 1),
                yield_input("beta", 2),
                yield_input("gamma", 3),
            ],
        );
        c.create_balance_trigger("balance-demo".into(), "router-demo".into(), U128(0), 1);

        ctx(owner());
        let started = c.execute_trigger("balance-demo".into());

        assert_eq!(started.call_count, 3);
        let yielded = c.registered_steps_for_namespace(&started.sequence_namespace);
        assert_eq!(yielded.len(), 3);
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
        c.save_sequence_template("adapter-demo".into(), vec![adapter_yield_input("alpha", 1)]);
        c.create_balance_trigger("balance-demo".into(), "adapter-demo".into(), U128(0), 1);

        ctx(owner());
        let started = c.execute_trigger("balance-demo".into());

        callback_ctx(PromiseResult::Successful(vec![1]));
        c.on_step_resolved(started.sequence_namespace.clone(), "alpha".into());

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
        c.save_sequence_template("adapter-demo".into(), vec![adapter_yield_input("alpha", 1)]);
        c.create_balance_trigger("balance-demo".into(), "adapter-demo".into(), U128(0), 1);

        ctx(owner());
        let started = c.execute_trigger("balance-demo".into());

        callback_ctx(PromiseResult::Failed);
        c.on_step_resolved(started.sequence_namespace.clone(), "alpha".into());

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
            vec![yield_input("alpha", 1), yield_input("beta", 2)],
        );
        c.create_balance_trigger("balance-demo".into(), "router-demo".into(), U128(0), 1);

        ctx(owner());
        let started = c.execute_trigger("balance-demo".into());

        callback_ctx(PromiseResult::Successful(vec![
            7_u8;
            MAX_CALLBACK_RESULT_BYTES + 1
        ]));
        c.on_step_resolved(started.sequence_namespace.clone(), "alpha".into());

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
            .registered_steps_for_namespace(&started.sequence_namespace)
            .is_empty());
    }

    #[test]
    fn mixed_policy_template_runs_without_namespace_collisions() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        c.save_sequence_template(
            "mixed-demo".into(),
            vec![
                yield_input("alpha", 1),
                adapter_yield_input("beta", 2),
                yield_input("gamma", 3),
            ],
        );
        c.create_balance_trigger("balance-demo".into(), "mixed-demo".into(), U128(0), 1);

        ctx(owner());
        let started = c.execute_trigger("balance-demo".into());

        let yielded = c.registered_steps_for_namespace(&started.sequence_namespace);
        assert_eq!(yielded.len(), 3);
        assert_eq!(
            yielded
                .iter()
                .map(|call| (call.step_id.clone(), call.policy.clone()))
                .collect::<Vec<_>>(),
            vec![
                ("alpha".to_string(), StepPolicy::Direct),
                ("beta".to_string(), adapter_policy()),
                ("gamma".to_string(), StepPolicy::Direct),
            ]
        );
    }

    #[test]
    fn asserted_dispatch_builds_target_and_postcheck_receipts() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        let _ = c.register_step(
            pathological_router(),
            "do_honest_work".into(),
            Base64VecU8::from(br#"{"label":"probe"}"#.to_vec()),
            U128(0),
            40,
            "alpha".into(),
            Some(asserted_policy(b"1".to_vec())),
        );

        ctx(current());
        let result = c.on_step_resumed(manual_namespace(&owner()), "alpha".into(), Ok(()));
        assert!(matches!(result, PromiseOrValue::Promise(_)));
        drop(result);

        let receipts = get_created_receipts();
        let (target_method, _, _, _) =
            find_function_call(&receipts, &pathological_router()).expect("target dispatch receipt");
        assert_eq!(target_method, "do_honest_work");

        let (postcheck_method, postcheck_args, _, _) =
            find_function_call(&receipts, &current()).expect("postcheck callback receipt");
        assert_eq!(postcheck_method, "on_asserted_run_postcheck");
        let parsed: serde_json::Value = serde_json::from_slice(&postcheck_args).unwrap();
        assert_eq!(parsed["assertion_id"], pathological_router().to_string());
        assert_eq!(parsed["assertion_method"], "get_calls_completed");
        assert_eq!(parsed["assertion_gas_tgas"], 30);
        assert_eq!(
            receipts
                .iter()
                .filter(|receipt| receipt.receiver_id == pathological_router())
                .count(),
            1
        );
    }

    #[test]
    #[should_panic(expected = "target failed before postcheck could run")]
    fn asserted_run_postcheck_panics_when_target_fails() {
        ctx(owner());
        let c = Contract::new_with_owner(owner());

        callback_ctx(PromiseResult::Failed);
        let _ = c.on_asserted_run_postcheck(
            manual_namespace(&owner()),
            "alpha".into(),
            pathological_router(),
            "get_calls_completed".into(),
            Base64VecU8::from(br#"{}"#.to_vec()),
            Base64VecU8::from(b"1".to_vec()),
            30,
        );
    }

    #[test]
    fn asserted_run_postcheck_fires_check_and_evaluate_receipts_on_target_success() {
        ctx(owner());
        let c = Contract::new_with_owner(owner());

        callback_ctx(PromiseResult::Successful(b"\"ok\"".to_vec()));
        let _ = c.on_asserted_run_postcheck(
            manual_namespace(&owner()),
            "alpha".into(),
            pathological_router(),
            "get_calls_completed".into(),
            Base64VecU8::from(br#"{}"#.to_vec()),
            Base64VecU8::from(b"1".to_vec()),
            30,
        );

        let receipts = get_created_receipts();
        let (check_method, check_args, _, check_gas) =
            find_function_call(&receipts, &pathological_router()).expect("check-call receipt");
        assert_eq!(check_method, "get_calls_completed");
        assert_eq!(check_args, br#"{}"#.to_vec());
        assert_eq!(check_gas, Gas::from_tgas(30));

        let (eval_method, eval_args, _, _) =
            find_function_call(&receipts, &current()).expect("evaluate callback receipt");
        assert_eq!(eval_method, "on_asserted_evaluate_postcheck");
        let parsed: serde_json::Value = serde_json::from_slice(&eval_args).unwrap();
        assert_eq!(parsed["step_id"], "alpha");
    }

    #[test]
    fn asserted_evaluate_postcheck_accepts_matching_bytes() {
        ctx(owner());
        let c = Contract::new_with_owner(owner());

        callback_ctx(PromiseResult::Successful(b"1".to_vec()));
        c.on_asserted_evaluate_postcheck(
            manual_namespace(&owner()),
            "alpha".into(),
            Base64VecU8::from(b"1".to_vec()),
        );
    }

    #[test]
    #[should_panic(expected = "postcheck mismatch")]
    fn asserted_evaluate_postcheck_panics_on_mismatch() {
        ctx(owner());
        let c = Contract::new_with_owner(owner());

        callback_ctx(PromiseResult::Successful(b"0".to_vec()));
        c.on_asserted_evaluate_postcheck(
            manual_namespace(&owner()),
            "alpha".into(),
            Base64VecU8::from(b"1".to_vec()),
        );
    }

    #[test]
    #[should_panic(expected = "assertion_method cannot be empty")]
    fn asserted_policy_rejects_empty_assertion_method() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        let _ = c.register_step(
            echo(),
            "noop_claim_success".into(),
            Base64VecU8::from(br#"{"label":"probe"}"#.to_vec()),
            U128(0),
            40,
            "alpha".into(),
            Some(StepPolicy::Asserted {
                assertion_id: pathological_router(),
                assertion_method: "".into(),
                assertion_args: Base64VecU8::from(br#"{}"#.to_vec()),
                expected_return: Base64VecU8::from(b"1".to_vec()),
                assertion_gas_tgas: 30,
            }),
        );
    }

    #[test]
    #[should_panic(expected = "assertion_gas_tgas must be greater than zero")]
    fn asserted_policy_rejects_zero_assertion_gas() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        let _ = c.register_step(
            echo(),
            "noop_claim_success".into(),
            Base64VecU8::from(br#"{"label":"probe"}"#.to_vec()),
            U128(0),
            40,
            "alpha".into(),
            Some(StepPolicy::Asserted {
                assertion_id: pathological_router(),
                assertion_method: "get_calls_completed".into(),
                assertion_args: Base64VecU8::from(br#"{}"#.to_vec()),
                expected_return: Base64VecU8::from(b"1".to_vec()),
                assertion_gas_tgas: 0,
            }),
        );
    }

    #[test]
    fn asserted_automation_success_flows_through_postcheck_chain() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        c.save_sequence_template(
            "asserted-demo".into(),
            vec![asserted_yield_input("alpha", b"1".to_vec())],
        );
        c.create_balance_trigger("balance-demo".into(), "asserted-demo".into(), U128(0), 1);

        ctx(owner());
        let started = c.execute_trigger("balance-demo".into());

        ctx(current());
        let resumed = c.on_step_resumed(started.sequence_namespace.clone(), "alpha".into(), Ok(()));
        assert!(matches!(resumed, PromiseOrValue::Promise(_)));
        drop(resumed);

        callback_ctx(PromiseResult::Successful(br#""completed:probe""#.to_vec()));
        let postcheck = c.on_asserted_run_postcheck(
            started.sequence_namespace.clone(),
            "alpha".into(),
            pathological_router(),
            "get_calls_completed".into(),
            Base64VecU8::from(br#"{}"#.to_vec()),
            Base64VecU8::from(b"1".to_vec()),
            30,
        );
        drop(postcheck);

        callback_ctx(PromiseResult::Successful(b"1".to_vec()));
        c.on_asserted_evaluate_postcheck(
            started.sequence_namespace.clone(),
            "alpha".into(),
            Base64VecU8::from(b"1".to_vec()),
        );

        callback_ctx(PromiseResult::Successful(vec![]));
        c.on_step_resolved(started.sequence_namespace.clone(), "alpha".into());

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
        assert_eq!(run.failed_step_id, None);
    }

    #[test]
    fn asserted_resolve_failure_reported_as_downstream_failure() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        c.save_sequence_template(
            "asserted-demo".into(),
            vec![asserted_yield_input("alpha", b"1".to_vec())],
        );
        c.create_balance_trigger("balance-demo".into(), "asserted-demo".into(), U128(0), 1);

        ctx(owner());
        let started = c.execute_trigger("balance-demo".into());

        callback_ctx(PromiseResult::Failed);
        c.on_step_resolved(started.sequence_namespace.clone(), "alpha".into());

        let run = c
            .automation_runs
            .get(&started.sequence_namespace)
            .cloned()
            .unwrap();
        assert_eq!(run.status, AutomationRunStatus::DownstreamFailed);
        assert_eq!(run.failed_step_id, Some("alpha".into()));
    }

    #[test]
    fn repeated_runs_get_fresh_namespaces() {
        let (mut c, _, trigger_id) = setup_trigger(2);

        ctx(owner());
        let first = c.execute_trigger(trigger_id.clone());
        assert_eq!(first.sequence_namespace, "auto:balance-demo:1");

        callback_ctx(PromiseResult::Successful(vec![1]));
        c.on_step_resolved(first.sequence_namespace.clone(), "alpha".into());

        let first_run = c
            .automation_runs
            .get(&first.sequence_namespace)
            .cloned()
            .unwrap();
        assert_eq!(first_run.status, AutomationRunStatus::Succeeded);
        assert!(c
            .registered_steps_for_namespace(&first.sequence_namespace)
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
        c.save_sequence_template("seq-a".into(), vec![yield_input("alpha", 1)]);
        c.save_sequence_template("seq-b".into(), vec![yield_input("beta", 2)]);
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
            c.registered_steps_for_namespace("auto:trigger-a:1")
                .iter()
                .map(|call| call.step_id.clone())
                .collect::<Vec<_>>(),
            vec!["alpha".to_string()]
        );
        assert_eq!(
            c.registered_steps_for_namespace("auto:trigger-b:1")
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
        c.on_step_resolved(started.sequence_namespace.clone(), "alpha".into());

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
            vec![yield_input("alpha", 1), yield_input("beta", 2)],
        );
        c.create_balance_trigger("balance-demo".into(), "router-demo".into(), U128(0), 1);

        ctx(owner());
        let started = c.execute_trigger("balance-demo".into());
        c.registered_steps
            .remove(&registered_step_key(&started.sequence_namespace, "beta"));

        callback_ctx(PromiseResult::Successful(vec![1]));
        c.on_step_resolved(started.sequence_namespace.clone(), "alpha".into());

        let trigger = c.balance_triggers.get("balance-demo").cloned().unwrap();
        assert!(!trigger.in_flight);
        assert_eq!(
            trigger.last_run_outcome,
            Some(AutomationRunStatus::ResumeFailed)
        );
        assert!(c
            .registered_steps_for_namespace(&started.sequence_namespace)
            .is_empty());
    }

    #[test]
    fn cleared_late_step_can_still_wake_after_namespace_cleanup() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        c.save_sequence_template(
            "router-demo".into(),
            vec![yield_input("alpha", 1), yield_input("beta", 2)],
        );
        c.create_balance_trigger("balance-demo".into(), "router-demo".into(), U128(0), 1);

        ctx(owner());
        let started = c.execute_trigger("balance-demo".into());

        callback_ctx(PromiseResult::Failed);
        c.on_step_resolved(started.sequence_namespace.clone(), "alpha".into());

        assert!(c
            .registered_steps
            .get(&registered_step_key(&started.sequence_namespace, "beta"))
            .is_none());

        ctx(current());
        let result = c.on_step_resumed(
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

    #[test]
    fn register_step_emits_structured_event_with_call_metadata() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        let _ = c.register_step(
            echo(),
            "echo".into(),
            Base64VecU8::from(br#"{"n":7}"#.to_vec()),
            U128(0),
            30,
            "alpha".into(),
            None,
        );

        let event = find_structured_event(&near_sdk::test_utils::get_logs(), "step_registered")
            .expect("step_registered event not emitted");
        assert_eq!(event["standard"], "sa-automation");
        assert_eq!(event["version"], "1.1.0");
        let data = &event["data"];
        assert_eq!(data["step_id"], "alpha");
        assert_eq!(data["namespace"], manual_namespace(&owner()));
        assert!(data["registered_at_ms"].is_number());

        let call = &data["call"];
        assert_eq!(call["target_id"], echo().as_str());
        assert_eq!(call["method"], "echo");
        assert_eq!(call["policy"], "direct");
        assert_eq!(call["gas_tgas"], 30);
        assert_eq!(call["deposit_yocto"], "0");
        assert_eq!(call["args_bytes_len"], br#"{"n":7}"#.len());
        assert!(call["dispatch_summary"]
            .as_str()
            .unwrap_or("")
            .starts_with("direct "));
    }

    #[test]
    fn create_balance_trigger_emits_structured_event_with_template_detail() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        c.save_sequence_template(
            "router-demo".into(),
            vec![yield_input("alpha", 1), yield_input("beta", 2)],
        );
        let _ = c.create_balance_trigger("balance-demo".into(), "router-demo".into(), U128(42), 3);

        let event = find_structured_event(&near_sdk::test_utils::get_logs(), "trigger_created")
            .expect("trigger_created event not emitted");
        assert_eq!(event["standard"], "sa-automation");
        assert_eq!(event["version"], "1.1.0");
        let data = &event["data"];
        assert_eq!(data["trigger_id"], "balance-demo");
        assert_eq!(data["sequence_id"], "router-demo");
        assert_eq!(data["min_balance_yocto"], "42");
        assert_eq!(data["max_runs"], 3);
        assert_eq!(data["template_call_count"], 2);
    }

    #[test]
    fn every_event_carries_runtime_envelope() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        let _ = c.register_step(
            echo(),
            "echo".into(),
            Base64VecU8::from(br#"{"n":1}"#.to_vec()),
            U128(0),
            30,
            "alpha".into(),
            None,
        );

        let event = find_structured_event(&near_sdk::test_utils::get_logs(), "step_registered")
            .expect("step_registered event not emitted");
        let runtime = &event["data"]["runtime"];
        assert!(runtime.is_object(), "runtime envelope missing");
        for field in [
            "block_height",
            "block_timestamp_ms",
            "epoch_height",
            "used_gas_tgas",
            "prepaid_gas_tgas",
            "attached_deposit_yocto",
            "account_balance_yocto",
            "account_locked_balance_yocto",
            "storage_usage",
            "predecessor_id",
            "current_account_id",
            "signer_id",
        ] {
            assert!(
                !runtime[field].is_null(),
                "runtime envelope missing field: {field}"
            );
        }
        assert_eq!(runtime["predecessor_id"], owner().as_str());
        assert_eq!(runtime["current_account_id"], current().as_str());
        assert_eq!(runtime["account_balance_yocto"].as_str().unwrap().len() > 0, true);
    }

    #[test]
    fn trigger_fired_event_carries_runtime_accounting() {
        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        c.save_sequence_template("router-demo".into(), vec![yield_input("alpha", 1)]);
        c.create_balance_trigger("balance-demo".into(), "router-demo".into(), U128(0), 2);

        ctx(owner());
        let _ = c.execute_trigger("balance-demo".into());

        let event = find_structured_event(&near_sdk::test_utils::get_logs(), "trigger_fired")
            .expect("trigger_fired event not emitted");
        let data = &event["data"];
        assert_eq!(data["trigger_id"], "balance-demo");
        assert_eq!(data["run_nonce"], 1);
        assert_eq!(data["runs_started"], 1);
        assert_eq!(data["max_runs"], 2);
        assert_eq!(data["runs_remaining"], 1);
        assert_eq!(data["call_count"], 1);
        assert!(data["balance_yocto"].is_string());
        assert!(data["required_balance_yocto"].is_string());
    }

    #[test]
    fn asserted_payload_appears_only_on_birth_and_verdict_events() {
        // Large-ish expected_return to prove the size discipline: if the full
        // bytes leaked into step_resumed, the test would still pass trivially,
        // so we also assert the raw-bytes keys are absent.
        let big_expected = b"expected-return-42".repeat(8); // 144 bytes
        let big_expected_b64_len = Base64VecU8::from(big_expected.clone()).0.len();

        ctx(owner());
        let mut c = Contract::new_with_owner(owner());
        let _ = c.register_step(
            pathological_router(),
            "do_honest_work".into(),
            Base64VecU8::from(br#"{"label":"probe"}"#.to_vec()),
            U128(0),
            40,
            "alpha".into(),
            Some(asserted_policy(big_expected.clone())),
        );

        let birth = find_structured_event(
            &near_sdk::test_utils::get_logs(),
            "step_registered",
        )
        .expect("step_registered event not emitted");
        let birth_call = &birth["data"]["call"];
        assert_eq!(birth_call["policy"], "asserted");
        assert_eq!(birth_call["assertion_method"], "get_calls_completed");
        assert!(
            birth_call["expected_return"].is_string(),
            "birth event should carry full expected_return as base64 string"
        );
        assert!(
            birth_call["assertion_args"].is_string(),
            "birth event should carry full assertion_args as base64 string"
        );
        assert_eq!(birth_call["expected_return_bytes_len"], big_expected_b64_len);
        assert_eq!(birth_call["args_bytes_len"], br#"{"label":"probe"}"#.len());

        // Now simulate the yielded receipt waking up — step_resumed should
        // carry the light call metadata (pointers + byte counts) but NOT the
        // raw assertion bytes.
        ctx(current());
        let result = c.on_step_resumed(manual_namespace(&owner()), "alpha".into(), Ok(()));
        assert!(matches!(result, PromiseOrValue::Promise(_)));
        drop(result);

        let resumed = find_structured_event(
            &near_sdk::test_utils::get_logs(),
            "step_resumed",
        )
        .expect("step_resumed event not emitted");
        let resumed_call = &resumed["data"]["call"];
        assert_eq!(resumed_call["policy"], "asserted");
        assert_eq!(resumed_call["assertion_method"], "get_calls_completed");
        assert_eq!(resumed_call["assertion_gas_tgas"], 30);
        assert_eq!(
            resumed_call["expected_return_bytes_len"], big_expected_b64_len,
            "light call metadata should still report the byte footprint"
        );
        assert!(
            resumed_call["expected_return"].is_null(),
            "step_resumed must NOT carry the raw expected_return bytes"
        );
        assert!(
            resumed_call["assertion_args"].is_null(),
            "step_resumed must NOT carry the raw assertion_args bytes"
        );
    }

    fn find_structured_event(
        logs: &[String],
        event_name: &str,
    ) -> Option<near_sdk::serde_json::Value> {
        for line in logs {
            let Some(body) = line.strip_prefix("EVENT_JSON:") else {
                continue;
            };
            let parsed: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(body).ok()?;
            if parsed["event"] == event_name {
                return Some(parsed);
            }
        }
        None
    }
}
