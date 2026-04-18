use near_sdk::json_types::U128;
use near_sdk::{
    env, ext_contract, near, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
    PromiseOrValue,
};
use smart_account_types::AdapterDispatchInput;

const MIN_CALLBACK_BUDGET_TGAS: u64 = 40;
const ADAPTER_START_OVERHEAD_TGAS: u64 = 30;
const WRAP_TRANSFER_GAS_TGAS: u64 = 20;
const WRAP_TRANSFER_STEP_OVERHEAD_TGAS: u64 = 25;
const FT_TRANSFER_DEPOSIT_YOCTO: u128 = 1;

#[ext_contract(ext_wrap)]
#[allow(dead_code)]
trait ExtWrap {
    fn near_deposit(&mut self);
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct CompatAdapter;

#[near]
impl CompatAdapter {
    #[init]
    pub fn new() -> Self {
        Self
    }

    pub fn adapt_wrap_near_deposit_then_transfer(&self, call: AdapterDispatchInput) -> Promise {
        assert_eq!(
            call.method_name, "near_deposit",
            "adapt_wrap_near_deposit_then_transfer only supports near_deposit"
        );
        assert!(
            call.attached_deposit_yocto.0 > FT_TRANSFER_DEPOSIT_YOCTO,
            "wrap adapter needs more than 1 yocto so it can reserve ft_transfer deposit"
        );

        let wrap_amount_yocto = call.attached_deposit_yocto.0 - FT_TRANSFER_DEPOSIT_YOCTO;
        let callback_budget_tgas = env::prepaid_gas()
            .as_tgas()
            .saturating_sub(call.gas_tgas + ADAPTER_START_OVERHEAD_TGAS);
        assert!(
            callback_budget_tgas >= MIN_CALLBACK_BUDGET_TGAS,
            "adapter callback budget is too small"
        );

        ext_wrap::ext(call.target_id.clone())
            .with_static_gas(Gas::from_tgas(call.gas_tgas))
            .with_attached_deposit(NearToken::from_yoctonear(wrap_amount_yocto))
            .near_deposit()
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(callback_budget_tgas))
                    .on_wrap_near_deposit_started(
                        call.target_id,
                        env::predecessor_account_id(),
                        U128(wrap_amount_yocto),
                        callback_budget_tgas,
                    ),
            )
    }

    #[private]
    pub fn on_wrap_near_deposit_started(
        &self,
        target_id: AccountId,
        beneficiary_id: AccountId,
        wrapped_amount_yocto: U128,
        remaining_budget_tgas: u64,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> PromiseOrValue<U128> {
        match result {
            Ok(()) => {
                let transfer_callback_budget_tgas =
                    remaining_budget_tgas.saturating_sub(WRAP_TRANSFER_STEP_OVERHEAD_TGAS);
                assert!(
                    transfer_callback_budget_tgas >= MIN_CALLBACK_BUDGET_TGAS,
                    "adapter callback budget is too small to confirm wrap transfer"
                );
                PromiseOrValue::Promise(
                    ext_wrap::ext(target_id)
                        .with_static_gas(Gas::from_tgas(WRAP_TRANSFER_GAS_TGAS))
                        .with_attached_deposit(NearToken::from_yoctonear(FT_TRANSFER_DEPOSIT_YOCTO))
                        .ft_transfer(
                            beneficiary_id.clone(),
                            wrapped_amount_yocto,
                            Some(format!("compat-adapter forward to {beneficiary_id}")),
                        )
                        .then(
                            Self::ext(env::current_account_id())
                                .with_static_gas(Gas::from_tgas(transfer_callback_budget_tgas))
                                .on_wrap_ft_transfer_finished(beneficiary_id, wrapped_amount_yocto),
                        ),
                )
            }
            Err(_) => env::panic_str("wrap near_deposit failed"),
        }
    }

    #[private]
    pub fn on_wrap_ft_transfer_finished(
        &self,
        beneficiary_id: AccountId,
        wrapped_amount_yocto: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> U128 {
        match result {
            Ok(()) => {
                env::log_str(&format!(
                    "compat-adapter forwarded {} wNEAR yocto to {}",
                    wrapped_amount_yocto.0, beneficiary_id
                ));
                wrapped_amount_yocto
            }
            Err(_) => env::panic_str("wrap ft_transfer failed after near_deposit"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::mock::MockAction;
    use near_sdk::serde_json;
    use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
    use near_sdk::testing_env;

    fn current() -> AccountId {
        "compat-adapter.near".parse().unwrap()
    }

    fn wrap() -> AccountId {
        "wrap.near".parse().unwrap()
    }

    fn beneficiary() -> AccountId {
        "smart-account.near".parse().unwrap()
    }

    fn ctx(prepaid_gas_tgas: u64) {
        ctx_with_predecessor(prepaid_gas_tgas, current());
    }

    fn ctx_with_predecessor(prepaid_gas_tgas: u64, predecessor: AccountId) {
        let mut b = VMContextBuilder::new();
        b.current_account_id(current())
            .signer_account_id(predecessor.clone())
            .predecessor_account_id(predecessor)
            .prepaid_gas(Gas::from_tgas(prepaid_gas_tgas));
        testing_env!(b.build());
    }

    fn function_call_to(receiver_id: &AccountId) -> (String, Vec<u8>, NearToken, Gas) {
        let receipt = get_created_receipts()
            .into_iter()
            .find(|receipt| &receipt.receiver_id == receiver_id)
            .expect("receipt for receiver");
        let action = receipt
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
            .expect("function call action");
        action
    }

    #[test]
    fn wrap_adapter_starts_near_deposit_with_reserved_transfer_yocto() {
        ctx_with_predecessor(260, beneficiary());
        let c = CompatAdapter::new();
        let attached = 10_000_000_000_000_000_000_001_u128;
        let _ = c.adapt_wrap_near_deposit_then_transfer(AdapterDispatchInput {
            target_id: wrap(),
            method_name: "near_deposit".into(),
            args: near_sdk::json_types::Base64VecU8::from(br#"{}"#.to_vec()),
            attached_deposit_yocto: U128(attached),
            gas_tgas: 40,
        });

        let (method_name, _, attached_deposit, gas) = function_call_to(&wrap());
        assert_eq!(method_name, "near_deposit");
        assert_eq!(
            attached_deposit,
            NearToken::from_yoctonear(attached - FT_TRANSFER_DEPOSIT_YOCTO)
        );
        assert_eq!(gas, Gas::from_tgas(40));
    }

    #[test]
    fn wrap_adapter_success_schedules_ft_transfer_to_predecessor() {
        ctx(260);
        let c = CompatAdapter::new();
        let amount = U128(10_000_000_000_000_000_000_000);
        let result = c.on_wrap_near_deposit_started(wrap(), beneficiary(), amount, 220, Ok(()));
        assert!(matches!(result, PromiseOrValue::Promise(_)));
        drop(result);

        let (method_name, args, attached_deposit, gas) = function_call_to(&wrap());
        assert_eq!(method_name, "ft_transfer");
        assert_eq!(
            attached_deposit,
            NearToken::from_yoctonear(FT_TRANSFER_DEPOSIT_YOCTO)
        );
        assert_eq!(gas, Gas::from_tgas(WRAP_TRANSFER_GAS_TGAS));

        let payload: serde_json::Value = serde_json::from_slice(&args).unwrap();
        assert_eq!(payload["receiver_id"], beneficiary().to_string());
        assert_eq!(payload["amount"], amount.0.to_string());
    }

    #[test]
    fn wrap_adapter_transfer_success_returns_amount() {
        ctx(260);
        let c = CompatAdapter::new();
        let amount = U128(10_000_000_000_000_000_000_000);
        let result = c.on_wrap_ft_transfer_finished(beneficiary(), amount, Ok(()));
        assert_eq!(result, amount);
    }
}
