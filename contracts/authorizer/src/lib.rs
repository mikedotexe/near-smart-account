//! `authorizer` — the root-account half of the v5 architectural split.
//!
//! Lives on the user's canonical account (e.g. `mike.near`). Holds an
//! allowlist of *extension* accounts (e.g. `sequential-intents.x.mike.near`)
//! that are permitted to act on this account's behalf for downstream
//! cross-contract calls.
//!
//! The contract has exactly three powers:
//!
//! 1. `dispatch(target, method, args, gas_tgas)` — called by an armed
//!    extension. Forwards the attached deposit + named call as a
//!    `Promise::new(target).function_call(...)` issued from THIS account.
//!    Downstream receivers see `predecessor_id = <this account>` and the
//!    chain-preserved `signer_id = <this account>` (the user signed the
//!    top-level tx on their own identity). This is what lets balance-
//!    keyed receivers like `intents.near` credit deposits to the user's
//!    canonical account even though the sequencer lives on a
//!    subaccount.
//!
//! 2. `add_session_key` / `delete_session_key` — mint / revoke a NEAR
//!    function-call access key on THIS account, restricted to a single
//!    method on a single receiver (the extension's `execute_trigger`).
//!    Policy bookkeeping (expiry, fire caps, allowlists) lives on the
//!    extension alongside `SessionGrant` state; the raw FCAK lives here.
//!
//! 3. Owner-managed allowlist curation — `add_extension` /
//!    `remove_extension` / `list_extensions`. Disarming an extension is
//!    one owner-signed tx; no redeploy required to shut off the
//!    delegation.
//!
//! Security model — every extension-callable method asserts:
//!
//! - `env::signer_account_id() == env::current_account_id()`: the
//!   top-level tx signer IS this account. The chain sets `signer_id`
//!   unspoofably, so this proves the user initiated the tx under their
//!   own identity (or via a session key that this account previously
//!   minted). An attacker signing into the extension with their own
//!   key cannot satisfy this.
//! - `env::predecessor_account_id() ∈ extensions`: the DIRECT caller is
//!   one of the owner-authorized extensions. An unarmed subaccount
//!   cannot satisfy this.
//!
//! Both checks are cheap (one equality, one set membership) and together
//! admit exactly the intended call pattern: user signs tx on root,
//! tx targets an armed extension, extension calls back to `dispatch`.
//! No other path admits.

use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::store::IterableSet;
use near_sdk::{
    env, near, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PublicKey,
};

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Extensions,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Authorizer {
    pub owner_id: AccountId,
    pub extensions: IterableSet<AccountId>,
}

#[near]
impl Authorizer {
    #[init]
    pub fn new() -> Self {
        Self::new_with_owner(env::predecessor_account_id())
    }

    #[init]
    pub fn new_with_owner(owner_id: AccountId) -> Self {
        Self {
            owner_id,
            extensions: IterableSet::new(StorageKey::Extensions),
        }
    }

    /// Schema-migration entry point. Default no-op: reads current-shape
    /// state and returns it unchanged. Overridden in a future tranche if
    /// the state layout changes.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let current: Authorizer =
            env::state_read().unwrap_or_else(|| env::panic_str("no prior authorizer state found"));
        env::log_str(&format!(
            "authorizer.migrate: read state for owner={}, {} extensions",
            current.owner_id,
            current.extensions.len(),
        ));
        current
    }

    pub fn contract_version(&self) -> String {
        "authorizer-v5.0.0".to_string()
    }

    // --- owner-only allowlist curation ---

    pub fn add_extension(&mut self, account_id: AccountId) {
        self.assert_owner();
        let inserted = self.extensions.insert(account_id.clone());
        if inserted {
            env::log_str(&format!("extension_added account_id={account_id}"));
        }
    }

    pub fn remove_extension(&mut self, account_id: AccountId) {
        self.assert_owner();
        let removed = self.extensions.remove(&account_id);
        if removed {
            env::log_str(&format!("extension_removed account_id={account_id}"));
        }
    }

    pub fn set_owner(&mut self, new_owner: AccountId) {
        self.assert_owner();
        let prev = self.owner_id.clone();
        self.owner_id = new_owner.clone();
        env::log_str(&format!("owner_changed prev={prev} new={new_owner}"));
    }

    // --- public views ---

    pub fn owner(&self) -> AccountId {
        self.owner_id.clone()
    }

    pub fn list_extensions(&self) -> Vec<AccountId> {
        self.extensions.iter().cloned().collect()
    }

    pub fn is_extension_armed(&self, account_id: AccountId) -> bool {
        self.extensions.contains(&account_id)
    }

    // --- extension-callable primitives ---

    /// Forward a `FunctionCall` to `target_id` under THIS account's
    /// identity. Extension attaches the deposit it wants forwarded;
    /// this contract passes it through via `env::attached_deposit()`.
    ///
    /// Auth: signer must equal current account (proves user signed the
    /// top-level tx), predecessor must be an armed extension.
    #[payable]
    pub fn dispatch(
        &mut self,
        target_id: AccountId,
        method_name: String,
        args: Base64VecU8,
        gas_tgas: u64,
    ) -> Promise {
        self.assert_extension_acting_as_self();
        assert!(gas_tgas > 0, "gas_tgas must be positive");
        Promise::new(target_id).function_call(
            method_name,
            args.0,
            env::attached_deposit(),
            Gas::from_tgas(gas_tgas),
        )
    }

    /// Mint a NEAR function-call access key on THIS account, scoped to
    /// one method on one receiver (typically the extension's
    /// `execute_trigger`). Policy metadata (expiry, fire caps,
    /// allowlists) is the extension's responsibility.
    ///
    /// Auth: same two-factor check as `dispatch`.
    pub fn add_session_key(
        &mut self,
        public_key: PublicKey,
        allowance_yocto: U128,
        receiver_id: AccountId,
        method_name: String,
    ) -> Promise {
        self.assert_extension_acting_as_self();
        let allowance = near_sdk::Allowance::limited(NearToken::from_yoctonear(allowance_yocto.0))
            .unwrap_or_else(|| env::panic_str("allowance_yocto must be > 0"));
        Promise::new(env::current_account_id()).add_access_key_allowance(
            public_key,
            allowance,
            receiver_id,
            method_name,
        )
    }

    /// Delete a NEAR function-call access key on THIS account.
    ///
    /// Auth: same two-factor check as `dispatch`.
    pub fn delete_session_key(&mut self, public_key: PublicKey) -> Promise {
        self.assert_extension_acting_as_self();
        Promise::new(env::current_account_id()).delete_key(public_key)
    }
}

impl Authorizer {
    fn assert_owner(&self) {
        assert_eq!(
            env::predecessor_account_id(),
            self.owner_id,
            "authorizer: only owner {} may call this method",
            self.owner_id
        );
    }

    /// Two-factor auth for extension-callable methods:
    /// 1. `signer_account_id() == current_account_id()` — top-level tx
    ///    signer is this account (chain-set, unspoofable).
    /// 2. `predecessor_account_id() ∈ extensions` — direct caller is an
    ///    owner-authorized extension.
    fn assert_extension_acting_as_self(&self) {
        let current = env::current_account_id();
        let signer = env::signer_account_id();
        assert_eq!(
            signer, current,
            "authorizer: signer_id '{signer}' must equal current_account_id '{current}' (user must sign the top-level tx on this account)"
        );
        let predecessor = env::predecessor_account_id();
        assert!(
            self.extensions.contains(&predecessor),
            "authorizer: predecessor '{predecessor}' is not in the authorized extensions list"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn root() -> AccountId {
        "mike.near".parse().unwrap()
    }
    fn extension() -> AccountId {
        "sequential-intents.x.mike.near".parse().unwrap()
    }
    fn other_extension() -> AccountId {
        "trading.x.mike.near".parse().unwrap()
    }
    fn stranger() -> AccountId {
        "stranger.near".parse().unwrap()
    }
    fn target() -> AccountId {
        "wrap.near".parse().unwrap()
    }

    /// Owner-signed direct call to the authorizer (no dispatch-back).
    fn owner_ctx() {
        testing_env!(VMContextBuilder::new()
            .current_account_id(root())
            .signer_account_id(root())
            .predecessor_account_id(root())
            .build());
    }

    /// Dispatch-back from an armed extension: user signed on root,
    /// tx targets extension, extension calls back to authorizer.
    fn dispatch_back_ctx(predecessor: AccountId, attached_yocto: u128) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(root())
            .signer_account_id(root())
            .predecessor_account_id(predecessor)
            .attached_deposit(NearToken::from_yoctonear(attached_yocto))
            .build());
    }

    #[test]
    fn new_with_owner_sets_owner_and_empty_allowlist() {
        owner_ctx();
        let c = Authorizer::new_with_owner(root());
        assert_eq!(c.owner(), root());
        assert!(c.list_extensions().is_empty());
    }

    #[test]
    fn add_and_remove_extension_by_owner() {
        owner_ctx();
        let mut c = Authorizer::new_with_owner(root());
        c.add_extension(extension());
        assert!(c.is_extension_armed(extension()));
        assert_eq!(c.list_extensions(), vec![extension()]);

        c.add_extension(other_extension());
        let listed = c.list_extensions();
        assert_eq!(listed.len(), 2);
        assert!(listed.contains(&extension()));
        assert!(listed.contains(&other_extension()));

        c.remove_extension(extension());
        assert!(!c.is_extension_armed(extension()));
        assert!(c.is_extension_armed(other_extension()));
    }

    #[test]
    #[should_panic(expected = "only owner")]
    fn add_extension_rejects_non_owner() {
        owner_ctx();
        let mut c = Authorizer::new_with_owner(root());
        testing_env!(VMContextBuilder::new()
            .current_account_id(root())
            .signer_account_id(stranger())
            .predecessor_account_id(stranger())
            .build());
        c.add_extension(extension());
    }

    #[test]
    #[should_panic(expected = "only owner")]
    fn remove_extension_rejects_non_owner() {
        owner_ctx();
        let mut c = Authorizer::new_with_owner(root());
        c.add_extension(extension());
        testing_env!(VMContextBuilder::new()
            .current_account_id(root())
            .signer_account_id(stranger())
            .predecessor_account_id(stranger())
            .build());
        c.remove_extension(extension());
    }

    #[test]
    fn set_owner_rotates() {
        owner_ctx();
        let mut c = Authorizer::new_with_owner(root());
        let new_owner: AccountId = "new-owner.near".parse().unwrap();
        c.set_owner(new_owner.clone());
        assert_eq!(c.owner(), new_owner);
    }

    #[test]
    fn dispatch_passes_with_both_checks_satisfied() {
        owner_ctx();
        let mut c = Authorizer::new_with_owner(root());
        c.add_extension(extension());
        dispatch_back_ctx(extension(), 1_000_000);
        // Should construct and return a Promise without panicking.
        let _ = c.dispatch(
            target(),
            "ft_transfer_call".to_string(),
            Base64VecU8::from(b"{}".to_vec()),
            50,
        );
    }

    #[test]
    #[should_panic(expected = "predecessor")]
    fn dispatch_rejects_unarmed_extension() {
        owner_ctx();
        let mut c = Authorizer::new_with_owner(root());
        // NOT adding extension() to the allowlist.
        dispatch_back_ctx(extension(), 0);
        let _ = c.dispatch(
            target(),
            "ft_transfer_call".to_string(),
            Base64VecU8::from(b"{}".to_vec()),
            50,
        );
    }

    #[test]
    #[should_panic(expected = "signer_id")]
    fn dispatch_rejects_when_signer_is_not_self() {
        owner_ctx();
        let mut c = Authorizer::new_with_owner(root());
        c.add_extension(extension());
        // Wrong signer: stranger signed the top-level tx, not the user.
        testing_env!(VMContextBuilder::new()
            .current_account_id(root())
            .signer_account_id(stranger())
            .predecessor_account_id(extension())
            .build());
        let _ = c.dispatch(
            target(),
            "ft_transfer_call".to_string(),
            Base64VecU8::from(b"{}".to_vec()),
            50,
        );
    }

    #[test]
    #[should_panic(expected = "gas_tgas")]
    fn dispatch_rejects_zero_gas() {
        owner_ctx();
        let mut c = Authorizer::new_with_owner(root());
        c.add_extension(extension());
        dispatch_back_ctx(extension(), 0);
        let _ = c.dispatch(
            target(),
            "ft_transfer_call".to_string(),
            Base64VecU8::from(b"{}".to_vec()),
            0,
        );
    }

    #[test]
    fn add_session_key_passes_with_both_checks_satisfied() {
        owner_ctx();
        let mut c = Authorizer::new_with_owner(root());
        c.add_extension(extension());
        dispatch_back_ctx(extension(), 0);
        let pk: PublicKey = "ed25519:DjoxeiWKvPvohyCqocnJPCB48Y3UoigpuT82c9uoVpoa"
            .parse()
            .unwrap();
        let _ = c.add_session_key(pk, U128(1_000_000_000_000_000_000), extension(), "execute_trigger".to_string());
    }

    #[test]
    #[should_panic(expected = "predecessor")]
    fn add_session_key_rejects_unarmed_extension() {
        owner_ctx();
        let mut c = Authorizer::new_with_owner(root());
        dispatch_back_ctx(extension(), 0);
        let pk: PublicKey = "ed25519:DjoxeiWKvPvohyCqocnJPCB48Y3UoigpuT82c9uoVpoa"
            .parse()
            .unwrap();
        let _ = c.add_session_key(pk, U128(1_000_000_000_000_000_000), extension(), "execute_trigger".to_string());
    }

    #[test]
    #[should_panic(expected = "allowance_yocto must be > 0")]
    fn add_session_key_rejects_zero_allowance() {
        owner_ctx();
        let mut c = Authorizer::new_with_owner(root());
        c.add_extension(extension());
        dispatch_back_ctx(extension(), 0);
        let pk: PublicKey = "ed25519:DjoxeiWKvPvohyCqocnJPCB48Y3UoigpuT82c9uoVpoa"
            .parse()
            .unwrap();
        let _ = c.add_session_key(pk, U128(0), extension(), "execute_trigger".to_string());
    }

    #[test]
    fn delete_session_key_passes_with_both_checks_satisfied() {
        owner_ctx();
        let mut c = Authorizer::new_with_owner(root());
        c.add_extension(extension());
        dispatch_back_ctx(extension(), 0);
        let pk: PublicKey = "ed25519:DjoxeiWKvPvohyCqocnJPCB48Y3UoigpuT82c9uoVpoa"
            .parse()
            .unwrap();
        let _ = c.delete_session_key(pk);
    }

    #[test]
    #[should_panic(expected = "signer_id")]
    fn delete_session_key_rejects_wrong_signer() {
        owner_ctx();
        let mut c = Authorizer::new_with_owner(root());
        c.add_extension(extension());
        testing_env!(VMContextBuilder::new()
            .current_account_id(root())
            .signer_account_id(stranger())
            .predecessor_account_id(extension())
            .build());
        let pk: PublicKey = "ed25519:DjoxeiWKvPvohyCqocnJPCB48Y3UoigpuT82c9uoVpoa"
            .parse()
            .unwrap();
        let _ = c.delete_session_key(pk);
    }
}
