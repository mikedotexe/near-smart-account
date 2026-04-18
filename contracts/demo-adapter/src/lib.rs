use near_sdk::serde_json;
use near_sdk::{
    env, ext_contract, near, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
    PromiseOrValue,
};
use smart_account_types::AdapterDispatchInput;

const MIN_CALLBACK_BUDGET_TGAS: u64 = 40;
const ADAPTER_START_OVERHEAD_TGAS: u64 = 30;
const POLL_GAS_TGAS: u64 = 10;
const POLL_STEP_OVERHEAD_TGAS: u64 = 25;
const MAX_POLL_ATTEMPTS: u8 = 4;

#[near(serializers = [json])]
struct FireAndForgetRouteEchoArgs {
    callee: AccountId,
    n: u32,
}

#[ext_contract(ext_wild_router)]
#[allow(dead_code)]
trait ExtWildRouter {
    fn route_echo_fire_and_forget(&mut self, callee: AccountId, n: u32) -> String;
    fn get_last_finished(&self) -> Option<u32>;
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct DemoAdapter;

#[near]
impl DemoAdapter {
    #[init]
    pub fn new() -> Self {
        Self
    }

    pub fn adapt_fire_and_forget_route_echo(&self, call: AdapterDispatchInput) -> Promise {
        assert_eq!(
            call.method_name, "route_echo_fire_and_forget",
            "adapt_fire_and_forget_route_echo only supports route_echo_fire_and_forget"
        );
        let route_args: FireAndForgetRouteEchoArgs = serde_json::from_slice(&call.args.0)
            .unwrap_or_else(|_| env::panic_str("invalid route_echo_fire_and_forget args"));
        let callback_budget_tgas = env::prepaid_gas()
            .as_tgas()
            .saturating_sub(call.gas_tgas + ADAPTER_START_OVERHEAD_TGAS);
        assert!(
            callback_budget_tgas >= MIN_CALLBACK_BUDGET_TGAS,
            "adapter callback budget is too small"
        );

        ext_wild_router::ext(call.target_id.clone())
            .with_static_gas(Gas::from_tgas(call.gas_tgas))
            .with_attached_deposit(NearToken::from_yoctonear(call.attached_deposit_yocto.0))
            .route_echo_fire_and_forget(route_args.callee, route_args.n)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(callback_budget_tgas))
                    .on_route_echo_started(
                        call.target_id,
                        route_args.n,
                        callback_budget_tgas,
                        MAX_POLL_ATTEMPTS,
                    ),
            )
    }

    #[private]
    pub fn on_route_echo_started(
        &self,
        target_id: AccountId,
        expected_n: u32,
        remaining_budget_tgas: u64,
        attempts_left: u8,
        #[callback_result] result: Result<String, PromiseError>,
    ) -> PromiseOrValue<u32> {
        match result {
            Ok(_) => self.schedule_finished_poll(
                target_id,
                expected_n,
                remaining_budget_tgas,
                attempts_left,
            ),
            Err(_) => env::panic_str("wild-router start receipt failed"),
        }
    }

    #[private]
    pub fn on_last_finished_polled(
        &self,
        target_id: AccountId,
        expected_n: u32,
        remaining_budget_tgas: u64,
        attempts_left: u8,
        #[callback_result] result: Result<Option<u32>, PromiseError>,
    ) -> PromiseOrValue<u32> {
        match result {
            Ok(Some(n)) if n == expected_n => PromiseOrValue::Value(n),
            Ok(_) | Err(_) if attempts_left == 0 => {
                env::panic_str("wild-router never exposed the expected finished state")
            }
            Ok(_) | Err(_) => self.schedule_finished_poll(
                target_id,
                expected_n,
                remaining_budget_tgas,
                attempts_left - 1,
            ),
        }
    }
}

impl DemoAdapter {
    fn schedule_finished_poll(
        &self,
        target_id: AccountId,
        expected_n: u32,
        remaining_budget_tgas: u64,
        attempts_left: u8,
    ) -> PromiseOrValue<u32> {
        let next_callback_budget_tgas =
            remaining_budget_tgas.saturating_sub(POLL_STEP_OVERHEAD_TGAS);
        assert!(
            next_callback_budget_tgas >= MIN_CALLBACK_BUDGET_TGAS,
            "adapter callback budget is too small to keep polling"
        );

        PromiseOrValue::Promise(
            ext_wild_router::ext(target_id.clone())
                .with_static_gas(Gas::from_tgas(POLL_GAS_TGAS))
                .get_last_finished()
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(Gas::from_tgas(next_callback_budget_tgas))
                        .on_last_finished_polled(
                            target_id,
                            expected_n,
                            next_callback_budget_tgas,
                            attempts_left,
                        ),
                ),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::mock::MockAction;
    use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
    use near_sdk::testing_env;

    fn current() -> AccountId {
        "demo-adapter.near".parse().unwrap()
    }

    fn wild_router() -> AccountId {
        "wild-router.near".parse().unwrap()
    }

    fn ctx(prepaid_gas_tgas: u64) {
        let mut b = VMContextBuilder::new();
        b.current_account_id(current())
            .signer_account_id(current())
            .predecessor_account_id(current())
            .prepaid_gas(Gas::from_tgas(prepaid_gas_tgas));
        testing_env!(b.build());
    }

    fn function_call_to(receiver_id: &AccountId) -> (String, Vec<u8>, NearToken, Gas) {
        let receipt = get_created_receipts()
            .into_iter()
            .find(|receipt| &receipt.receiver_id == receiver_id)
            .expect("receipt for receiver");
        receipt
            .actions
            .into_iter()
            .find_map(|action| match action {
                MockAction::FunctionCallWeight {
                    method_name,
                    args,
                    attached_deposit,
                    prepaid_gas,
                    ..
                } => Some((
                    String::from_utf8(method_name).unwrap(),
                    args,
                    attached_deposit,
                    prepaid_gas,
                )),
                _ => None,
            })
            .expect("function call action")
    }

    #[test]
    #[should_panic(expected = "only supports route_echo_fire_and_forget")]
    fn adapter_rejects_unknown_method() {
        ctx(220);
        let c = DemoAdapter::new();
        let _ = c.adapt_fire_and_forget_route_echo(AdapterDispatchInput {
            target_id: wild_router(),
            method_name: "route_echo".into(),
            args: near_sdk::json_types::Base64VecU8::from(br#"{}"#.to_vec()),
            attached_deposit_yocto: near_sdk::json_types::U128(0),
            gas_tgas: 40,
        });
    }

    #[test]
    fn adapter_success_returns_value() {
        ctx(260);
        let c = DemoAdapter::new();
        let result = c.on_last_finished_polled(wild_router(), 7, 240, 2, Ok(Some(7)));
        assert!(matches!(result, PromiseOrValue::Value(7)));
    }

    #[test]
    fn adapter_failure_to_observe_state_repolls() {
        ctx(260);
        let c = DemoAdapter::new();
        let result = c.on_last_finished_polled(wild_router(), 7, 240, 2, Ok(None));
        assert!(matches!(result, PromiseOrValue::Promise(_)));
        drop(result);

        let (method_name, _, _, gas) = function_call_to(&wild_router());
        assert_eq!(method_name, "get_last_finished");
        assert_eq!(gas, Gas::from_tgas(POLL_GAS_TGAS));
    }
}
