//! `recorder` — a tiny stateful leaf contract for the simple-example proof.
//!
//! Each `record(step_id, value)` call appends one durable entry that includes
//! the caller provenance and block metadata. That gives the demo two matching
//! proof surfaces:
//!
//! - receipt/log ordering in the trace
//! - durable state ordering in `get_entries()`

use near_sdk::store::Vector;
use near_sdk::{env, near, AccountId, BorshStorageKey, PanicOnDefault};

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Entries,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
struct RecordEntry {
    step_id: String,
    value: u32,
    predecessor_id: AccountId,
    signer_id: AccountId,
    block_height: u64,
    timestamp_ms: u64,
}

#[near(serializers = [json])]
pub struct RecordEntryView {
    pub step_id: String,
    pub value: u32,
    pub predecessor_id: AccountId,
    pub signer_id: AccountId,
    pub block_height: u64,
    pub timestamp_ms: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    entries: Vector<RecordEntry>,
}

#[near]
impl Contract {
    #[init]
    pub fn new() -> Self {
        Self {
            entries: Vector::new(StorageKey::Entries),
        }
    }

    pub fn record(&mut self, step_id: String, value: u32) -> u32 {
        assert!(!step_id.is_empty(), "step_id cannot be empty");

        let entry = RecordEntry {
            step_id: step_id.clone(),
            value,
            predecessor_id: env::predecessor_account_id(),
            signer_id: env::signer_account_id(),
            block_height: env::block_height(),
            timestamp_ms: env::block_timestamp_ms(),
        };

        env::log_str(&format!("recorded {step_id}={value}"));
        self.entries.push(entry);
        value
    }

    pub fn get_entries(&self) -> Vec<RecordEntryView> {
        self.entries.iter().map(Self::entry_view).collect()
    }
}

impl Contract {
    fn entry_view(entry: &RecordEntry) -> RecordEntryView {
        RecordEntryView {
            step_id: entry.step_id.clone(),
            value: entry.value,
            predecessor_id: entry.predecessor_id.clone(),
            signer_id: entry.signer_id.clone(),
            block_height: entry.block_height,
            timestamp_ms: entry.timestamp_ms,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn current() -> AccountId {
        "recorder.near".parse().unwrap()
    }

    fn ctx(predecessor: AccountId, signer: AccountId, block_height: u64, timestamp_ms: u64) {
        let mut b = VMContextBuilder::new();
        b.current_account_id(current())
            .predecessor_account_id(predecessor)
            .signer_account_id(signer)
            .block_height(block_height)
            .block_timestamp(timestamp_ms * 1_000_000);
        testing_env!(b.build());
    }

    #[test]
    fn record_appends_entries_in_order() {
        let caller: AccountId = "simple-sequencer.near".parse().unwrap();
        let signer: AccountId = "mike.near".parse().unwrap();
        ctx(caller.clone(), signer.clone(), 42, 1_000);
        let mut c = Contract::new();

        assert_eq!(c.record("beta".into(), 2), 2);

        ctx(caller, signer, 43, 1_500);
        assert_eq!(c.record("alpha".into(), 1), 1);

        let entries = c.get_entries();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].step_id, "beta");
        assert_eq!(entries[0].value, 2);
        assert_eq!(entries[1].step_id, "alpha");
        assert_eq!(entries[1].value, 1);
    }

    #[test]
    fn record_exposes_caller_provenance_metadata() {
        let predecessor: AccountId = "simple-sequencer.near".parse().unwrap();
        let signer: AccountId = "mike.near".parse().unwrap();
        ctx(
            predecessor.clone(),
            signer.clone(),
            246_214_777,
            1_712_345_678_900,
        );
        let mut c = Contract::new();
        c.record("gamma".into(), 3);

        let entries = c.get_entries();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].step_id, "gamma");
        assert_eq!(entries[0].value, 3);
        assert_eq!(entries[0].predecessor_id, predecessor);
        assert_eq!(entries[0].signer_id, signer);
        assert_eq!(entries[0].block_height, 246_214_777);
        assert_eq!(entries[0].timestamp_ms, 1_712_345_678_900);
    }
}
