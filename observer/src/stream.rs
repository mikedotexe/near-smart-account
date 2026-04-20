//! Live stream of `sa-automation` NEP-297 events via FastNEAR's
//! neardata service. Polls forward from `--from-height`, filters
//! receipt outcomes by `executor_id`, parses `EVENT_JSON:` log lines,
//! emits one jsonl line per event on stdout.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::{Context, Result};
use clap::Parser;
use fastnear_neardata_fetcher::fetcher;
use fastnear_primitives::block_with_tx_hash::BlockWithTxHashes;
use fastnear_primitives::near_indexer_primitives::types::Finality;
use fastnear_primitives::types::ChainId;
use serde::Serialize;
use tokio::sync::mpsc;

use crate::nep297::parse_event_json;

#[derive(Parser, Debug)]
pub struct StreamArgs {
    /// Account to watch (repeatable). A receipt is included iff its
    /// `executor_id` matches one of these values.
    #[arg(long, required = true)]
    pub account: Vec<String>,

    /// Block height to start streaming from. Defaults to
    /// `last_block/final - 10` (i.e. a few blocks back from tip).
    #[arg(long)]
    pub from_height: Option<u64>,

    /// Inclusive end block height. Defaults to unbounded (streams
    /// forever until ctrl-c).
    #[arg(long)]
    pub to_height: Option<u64>,

    /// `mainnet` or `testnet`. Default: mainnet.
    #[arg(long, default_value = "mainnet")]
    pub network: String,
}

#[derive(Serialize)]
struct EventLine<'a> {
    block_height: u64,
    block_timestamp_ms: u64,
    tx_hash: Option<String>,
    receipt_id: String,
    executor_id: &'a str,
    event: serde_json::Value,
}

pub async fn run(args: StreamArgs) -> Result<()> {
    let chain_id = ChainId::try_from(args.network.clone())
        .map_err(|e| anyhow::anyhow!("{e}"))
        .context("--network must be `mainnet` or `testnet`")?;

    // Graceful ctrl-c: flip the shared `is_running` flag the fetcher
    // checks in its retry/poll loop.
    let is_running = Arc::new(AtomicBool::new(true));
    {
        let flag = is_running.clone();
        tokio::spawn(async move {
            if tokio::signal::ctrl_c().await.is_ok() {
                tracing::info!("ctrl-c received; shutting down");
                flag.store(false, Ordering::SeqCst);
            }
        });
    }

    let mut cfg = fetcher::FetcherConfigBuilder::new()
        .chain_id(chain_id)
        .finality(Finality::Final);
    if let Some(h) = args.from_height {
        cfg = cfg.start_block_height(h);
    }
    if let Some(h) = args.to_height {
        cfg = cfg.end_block_height(h);
    }
    if let Ok(key) = std::env::var("FASTNEAR_API_KEY") {
        if !key.is_empty() {
            cfg = cfg.auth_bearer_token(key);
        }
    }
    let cfg = cfg.build();

    tracing::info!(
        chain = %args.network,
        accounts = ?args.account,
        from_height = ?args.from_height,
        to_height = ?args.to_height,
        "starting observer"
    );

    let (tx, mut rx) = mpsc::channel::<BlockWithTxHashes>(100);
    let fetcher_handle = tokio::spawn(fetcher::start_fetcher(cfg, tx, is_running.clone()));

    // Accept account matching with .iter().any() (small allowlist —
    // linear scan is cheaper than a HashSet for N < 10).
    while let Some(block) = rx.recv().await {
        let block_height = block.block.header.height;
        let block_ts_ms = block.block.header.timestamp_nanosec as u64 / 1_000_000;

        for shard in &block.shards {
            for reo in &shard.receipt_execution_outcomes {
                let executor = reo.execution_outcome.outcome.executor_id.as_str();
                if !args.account.iter().any(|a| a == executor) {
                    continue;
                }
                for log in &reo.execution_outcome.outcome.logs {
                    let Some(event) = parse_event_json(log) else {
                        continue;
                    };
                    let line = EventLine {
                        block_height,
                        block_timestamp_ms: block_ts_ms,
                        tx_hash: reo.tx_hash.map(|h| h.to_string()),
                        receipt_id: reo.execution_outcome.id.to_string(),
                        executor_id: executor,
                        event,
                    };
                    match serde_json::to_string(&line) {
                        Ok(s) => println!("{s}"),
                        Err(e) => tracing::warn!("failed to serialize event line: {e}"),
                    }
                }
            }
        }
    }

    // Ensure the fetcher task has exited before we return.
    let _ = fetcher_handle.await;
    Ok(())
}
