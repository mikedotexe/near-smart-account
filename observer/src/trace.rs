//! Receipt-DAG + NEP-519 yield/resume walkthrough for one transaction.
//!
//! Fetches a tx from FastNEAR's TX API (`/v0/transactions`, archival-
//! backed), normalizes the response into an execution-ordered list of
//! rows (action receipts + data receipts), correlates yield/resume
//! data receipts with their consuming `on_*` callbacks, extracts
//! NEP-297 `sa-automation` events, and renders either an ASCII/ANSI
//! walkthrough (default) or a structured JSON summary (`--json`).
//!
//! The ASCII renderer is the pedagogical surface — every row carries
//! block height, Δt from tx, receipt id, predecessor→receiver, method
//! or data, gas burnt, and inlined events. Block heights and receipt
//! ids are archival-stable, so the output stays verifiable forever.

use std::collections::BTreeMap;
use std::io::IsTerminal;

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
use clap::Parser;
use serde_json::Value;

use crate::nep297::parse_event_json;

#[derive(Parser, Debug)]
pub struct TraceArgs {
    /// Transaction hash to trace.
    #[arg(long)]
    pub tx: String,

    /// `mainnet` or `testnet`. Default: mainnet.
    #[arg(long, default_value = "mainnet")]
    pub network: String,

    /// Disable ANSI colors. Otherwise auto-detected from the TTY.
    #[arg(long)]
    pub no_color: bool,

    /// Emit a machine-readable JSON summary instead of the ASCII table.
    #[arg(long)]
    pub json: bool,

    /// Compact "prove the claim" view: numbered state-changing events +
    /// near.rocks explorer links anyone can click to verify on-chain.
    #[arg(long)]
    pub simple: bool,

    /// Show refund receipts instead of collapsing them into one line.
    #[arg(long)]
    pub show_refunds: bool,

    /// Include event `runtime` blocks (noisy).
    #[arg(long)]
    pub verbose: bool,
}

pub async fn run(args: TraceArgs) -> Result<()> {
    let api_key = std::env::var("FASTNEAR_API_KEY")
        .ok()
        .filter(|s| !s.is_empty());
    let response = fetch_tx(&args.network, &args.tx, api_key.as_deref()).await?;
    let trace = parse_trace(&response)?;

    if args.json {
        let v = render_json(&trace);
        println!("{}", serde_json::to_string_pretty(&v)?);
    } else if args.simple {
        let color = !args.no_color && std::io::stdout().is_terminal();
        let out = render_simple(&trace, color);
        print!("{out}");
    } else {
        let color = !args.no_color && std::io::stdout().is_terminal();
        let out = render_ascii(&trace, color, args.show_refunds, args.verbose);
        print!("{out}");
    }
    Ok(())
}

// ---------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------

async fn fetch_tx(network: &str, tx_hash: &str, api_key: Option<&str>) -> Result<Value> {
    let host = match network {
        "mainnet" => "https://tx.main.fastnear.com",
        "testnet" => "https://tx.test.fastnear.com",
        other => bail!("--network must be `mainnet` or `testnet`, got `{other}`"),
    };
    let url = format!("{host}/v0/transactions");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()?;
    let mut req = client.post(&url).json(&serde_json::json!({
        "tx_hashes": [tx_hash],
    }));
    if let Some(key) = api_key {
        req = req.bearer_auth(key);
    }

    let res = req.send().await.with_context(|| format!("POST {url}"))?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        bail!(
            "TX API returned {status}. Body (first 400 chars): {}",
            &body.chars().take(400).collect::<String>()
        );
    }
    let value: Value = res.json().await.context("parse TX API response as JSON")?;

    let txs = value
        .get("transactions")
        .and_then(|v| v.as_array())
        .ok_or_else(|| anyhow!("response has no `transactions` array"))?;
    if txs.is_empty() {
        bail!(
            "TX API returned zero transactions for hash {tx_hash}. \
             The tx may be older than the API's retention window."
        );
    }
    Ok(value)
}

// ---------------------------------------------------------------
// Data model
// ---------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct Trace {
    pub tx_hash: String,
    pub signer_id: String,
    pub receiver_id: String,
    pub top_method: Option<String>,
    pub tx_block_height: u64,
    pub tx_block_timestamp_ns: u64,
    pub rows: Vec<Row>,
    pub events: Vec<ParsedEvent>,
    pub summary: Summary,
}

#[derive(Debug, Clone)]
pub struct Row {
    pub block_height: u64,
    pub block_timestamp_ns: u64,
    pub delta_s_from_tx: f64,
    pub receipt_id: String,
    pub kind: RowKind,
    pub gas_burnt: u64,
    pub tokens_burnt: u128,
    pub events: Vec<ParsedEvent>,
    pub resumed_by_data_id: Option<String>,
    pub resumed_by_data_utf8: Option<String>,
    pub status: OutcomeStatus,
    pub is_refund: bool,
    pub is_yield_resume: bool,
}

#[derive(Debug, Clone)]
pub enum RowKind {
    Action {
        method: Option<String>,
        receiver_id: String,
        predecessor_id: String,
    },
    Data {
        data_id: String,
        is_promise_resume: bool,
        data_utf8: Option<String>,
        data_bytes_len: usize,
        receiver_id: String,
        predecessor_id: String,
    },
}

#[derive(Debug, Clone)]
pub enum OutcomeStatus {
    SuccessValue(String),
    SuccessReceiptId(String),
    Failure(String),
    Unknown,
    NotApplicable,
}

#[derive(Debug, Clone)]
pub struct ParsedEvent {
    pub block_height: u64,
    pub block_timestamp_ns: u64,
    pub receipt_id: String,
    pub standard: String,
    pub version: String,
    pub event: String,
    pub data: Value,
}

#[derive(Debug, Clone)]
pub struct Summary {
    pub block_min: u64,
    pub block_max: u64,
    pub duration_s: f64,
    pub gas_burnt_total: u64,
    pub tokens_burnt_total: u128,
    pub event_counts: BTreeMap<String, usize>,
    pub action_receipts: usize,
    pub data_receipts: usize,
    pub refund_count: usize,
    pub refund_gas_total: u64,
    pub outcome_banner: String,
    pub outcome_is_error: bool,
    pub yield_resume_detected: bool,
    pub yield_resume_latency_s: Option<f64>,
}

// ---------------------------------------------------------------
// Parse
// ---------------------------------------------------------------

pub fn parse_trace(response: &Value) -> Result<Trace> {
    let tx = response
        .pointer("/transactions/0")
        .ok_or_else(|| anyhow!("no transactions[0]"))?;

    let header = tx
        .pointer("/transaction")
        .ok_or_else(|| anyhow!("no /transaction"))?;
    let tx_hash = header
        .get("hash")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let signer_id = header
        .get("signer_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let receiver_id = header
        .get("receiver_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let top_method = header
        .pointer("/actions/0/FunctionCall/method_name")
        .and_then(Value::as_str)
        .map(|s| s.to_string());

    // Tx-to-receipt conversion is the anchor: its block/ts define Δt=0.
    let tx_outcome = tx
        .get("execution_outcome")
        .ok_or_else(|| anyhow!("no /execution_outcome"))?;
    let tx_block_height = tx_outcome
        .get("block_height")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let tx_block_timestamp_ns = tx_outcome
        .get("block_timestamp")
        .and_then(Value::as_u64)
        .unwrap_or_default();

    let receipts = tx
        .get("receipts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let data_receipts = tx
        .get("data_receipts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut rows: Vec<Row> = Vec::new();
    let mut events: Vec<ParsedEvent> = Vec::new();
    let mut event_counts: BTreeMap<String, usize> = BTreeMap::new();

    // Action receipts -> Row::Action
    for r in &receipts {
        let eo = r.get("execution_outcome").unwrap_or(&Value::Null);
        let rb = r.get("receipt").unwrap_or(&Value::Null);
        let block_height = eo.get("block_height").and_then(Value::as_u64).unwrap_or(0);
        let block_ts = eo
            .get("block_timestamp")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let delta_s = delta_seconds(block_ts, tx_block_timestamp_ns);
        let receipt_id = eo
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("?")
            .to_string();

        let outcome = eo.get("outcome").unwrap_or(&Value::Null);
        let gas_burnt = outcome
            .get("gas_burnt")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let tokens_burnt = outcome
            .get("tokens_burnt")
            .and_then(Value::as_str)
            .and_then(|s| s.parse::<u128>().ok())
            .unwrap_or(0);
        let logs = outcome
            .get("logs")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let status = parse_status(outcome.get("status"));

        let predecessor_id = rb
            .get("predecessor_id")
            .and_then(Value::as_str)
            .unwrap_or("?")
            .to_string();
        let recv = rb
            .get("receiver_id")
            .and_then(Value::as_str)
            .unwrap_or("?")
            .to_string();

        // Inner receipt tag: Action { actions } | Data { ... }
        let inner = rb.pointer("/receipt").unwrap_or(&Value::Null);
        let (method, is_refund) = if let Some(action) = inner.get("Action") {
            let actions = action.get("actions").and_then(Value::as_array);
            let method = actions
                .and_then(|a| a.first())
                .and_then(|a0| a0.pointer("/FunctionCall/method_name"))
                .and_then(Value::as_str)
                .map(|s| s.to_string());
            // System-predecessor Transfer == gas refund
            let is_transfer_only = actions
                .map(|a| a.len() == 1 && a[0].get("Transfer").is_some())
                .unwrap_or(false);
            let is_refund = predecessor_id == "system" && is_transfer_only;
            (method, is_refund)
        } else {
            // Data-shaped action receipt (rare but possible).
            (None, false)
        };

        // Extract events from logs (with receipt anchor).
        let mut row_events = Vec::new();
        for log in logs.iter().filter_map(Value::as_str) {
            if let Some(event_json) = parse_event_json(log) {
                let parsed = ParsedEvent {
                    block_height,
                    block_timestamp_ns: block_ts,
                    receipt_id: receipt_id.clone(),
                    standard: event_json
                        .get("standard")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    version: event_json
                        .get("version")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    event: event_json
                        .get("event")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    data: event_json.get("data").cloned().unwrap_or(Value::Null),
                };
                if !parsed.event.is_empty() {
                    *event_counts.entry(parsed.event.clone()).or_insert(0) += 1;
                }
                events.push(parsed.clone());
                row_events.push(parsed);
            }
        }

        rows.push(Row {
            block_height,
            block_timestamp_ns: block_ts,
            delta_s_from_tx: delta_s,
            receipt_id,
            kind: RowKind::Action {
                method,
                receiver_id: recv,
                predecessor_id,
            },
            gas_burnt,
            tokens_burnt,
            events: row_events,
            resumed_by_data_id: None,
            resumed_by_data_utf8: None,
            status,
            is_refund,
            is_yield_resume: false,
        });
    }

    // Data receipts -> Row::Data
    for dr in &data_receipts {
        let block_height = dr.get("block_height").and_then(Value::as_u64).unwrap_or(0);
        let block_ts = dr
            .get("block_timestamp")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let delta_s = delta_seconds(block_ts, tx_block_timestamp_ns);
        let receipt_id = dr
            .get("receipt_id")
            .and_then(Value::as_str)
            .unwrap_or("?")
            .to_string();
        let recv = dr
            .get("receiver_id")
            .and_then(Value::as_str)
            .unwrap_or("?")
            .to_string();
        let predecessor_id = dr
            .get("predecessor_id")
            .and_then(Value::as_str)
            .unwrap_or("?")
            .to_string();

        let data_body = dr.pointer("/receipt/Data").unwrap_or(&Value::Null);
        let data_b64 = data_body.get("data").and_then(Value::as_str).unwrap_or("");
        let data_id = data_body
            .get("data_id")
            .and_then(Value::as_str)
            .unwrap_or("?")
            .to_string();
        let is_promise_resume = data_body
            .get("is_promise_resume")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let (data_utf8, data_bytes_len) = decode_data(data_b64);

        rows.push(Row {
            block_height,
            block_timestamp_ns: block_ts,
            delta_s_from_tx: delta_s,
            receipt_id,
            kind: RowKind::Data {
                data_id,
                is_promise_resume,
                data_utf8,
                data_bytes_len,
                receiver_id: recv,
                predecessor_id,
            },
            gas_burnt: 0,
            tokens_burnt: 0,
            events: Vec::new(),
            resumed_by_data_id: None,
            resumed_by_data_utf8: None,
            status: OutcomeStatus::NotApplicable,
            is_refund: false,
            is_yield_resume: false,
        });
    }

    // Stable sort: block, then timestamp, then by receipt id for determinism.
    rows.sort_by(|a, b| {
        a.block_height
            .cmp(&b.block_height)
            .then(a.block_timestamp_ns.cmp(&b.block_timestamp_ns))
            .then(a.receipt_id.cmp(&b.receipt_id))
    });

    correlate_resumes(&mut rows);

    // Yield-resume detection: find the on_step_resumed row that was
    // fed by a is_promise_resume=true data receipt. Report the
    // register→resume latency from the first step_registered event.
    let yield_resume_detected = rows.iter().any(|r| r.is_yield_resume);
    let yield_resume_latency_s = yield_resume_latency(&rows, &events);

    // Outcome banner: last sa-automation terminal event
    let (outcome_banner, outcome_is_error) = build_outcome_banner(&events);

    let action_receipts = rows
        .iter()
        .filter(|r| matches!(r.kind, RowKind::Action { .. }))
        .count();
    let data_receipts_count = rows
        .iter()
        .filter(|r| matches!(r.kind, RowKind::Data { .. }))
        .count();
    let refund_count = rows.iter().filter(|r| r.is_refund).count();
    let refund_gas_total: u64 = rows
        .iter()
        .filter(|r| r.is_refund)
        .map(|r| r.gas_burnt)
        .sum();

    let gas_burnt_total: u64 = rows.iter().map(|r| r.gas_burnt).sum();
    let tokens_burnt_total: u128 = rows.iter().map(|r| r.tokens_burnt).sum();

    let block_min = rows
        .iter()
        .map(|r| r.block_height)
        .min()
        .unwrap_or(tx_block_height);
    let block_max = rows
        .iter()
        .map(|r| r.block_height)
        .max()
        .unwrap_or(tx_block_height);
    let ts_min = rows
        .iter()
        .map(|r| r.block_timestamp_ns)
        .min()
        .unwrap_or(tx_block_timestamp_ns);
    let ts_max = rows
        .iter()
        .map(|r| r.block_timestamp_ns)
        .max()
        .unwrap_or(tx_block_timestamp_ns);
    let duration_s = delta_seconds(ts_max, ts_min);

    Ok(Trace {
        tx_hash,
        signer_id,
        receiver_id,
        top_method,
        tx_block_height,
        tx_block_timestamp_ns,
        rows,
        events,
        summary: Summary {
            block_min,
            block_max,
            duration_s,
            gas_burnt_total,
            tokens_burnt_total,
            event_counts,
            action_receipts,
            data_receipts: data_receipts_count,
            refund_count,
            refund_gas_total,
            outcome_banner,
            outcome_is_error,
            yield_resume_detected,
            yield_resume_latency_s,
        },
    })
}

fn parse_status(status: Option<&Value>) -> OutcomeStatus {
    let Some(s) = status else {
        return OutcomeStatus::Unknown;
    };
    if let Some(v) = s.get("SuccessValue").and_then(Value::as_str) {
        return OutcomeStatus::SuccessValue(v.to_string());
    }
    if let Some(v) = s.get("SuccessReceiptId").and_then(Value::as_str) {
        return OutcomeStatus::SuccessReceiptId(v.to_string());
    }
    if let Some(v) = s.get("Failure") {
        return OutcomeStatus::Failure(v.to_string());
    }
    OutcomeStatus::Unknown
}

fn delta_seconds(now_ns: u64, zero_ns: u64) -> f64 {
    if now_ns <= zero_ns {
        0.0
    } else {
        (now_ns - zero_ns) as f64 / 1_000_000_000.0
    }
}

fn decode_data(b64: &str) -> (Option<String>, usize) {
    if b64.is_empty() {
        return (None, 0);
    }
    match base64::engine::general_purpose::STANDARD.decode(b64) {
        Ok(bytes) => {
            let len = bytes.len();
            let utf8 = std::str::from_utf8(&bytes).ok().map(|s| s.to_string());
            (utf8, len)
        }
        Err(_) => (None, 0),
    }
}

/// Pair each `on_*` callback action receipt with the data receipt that
/// triggered it. Heuristic: for each consuming action receipt with
/// receiver Y at block B, find the nearest unclaimed Data receipt at
/// block ≤ B with matching receiver. If the action receipt's method
/// is `on_step_resumed` AND the matched data receipt has
/// `is_promise_resume: true`, flag it as a yield/resume hop
/// (NEP-519).
///
/// We search the whole row list, not just rows before index i,
/// because sort-order ties within the same block/timestamp are
/// resolved by receipt_id, which is unrelated to the causal
/// action→data relationship.
fn correlate_resumes(rows: &mut [Row]) {
    let n = rows.len();
    // Collect (row_index, data_id, is_promise_resume, receiver, block, data_utf8)
    // for easy selection without repeated pattern matching.
    let data_catalog: Vec<(usize, String, bool, String, u64, Option<String>)> = rows
        .iter()
        .enumerate()
        .filter_map(|(idx, row)| match &row.kind {
            RowKind::Data {
                data_id,
                is_promise_resume,
                receiver_id,
                data_utf8,
                ..
            } => Some((
                idx,
                data_id.clone(),
                *is_promise_resume,
                receiver_id.clone(),
                row.block_height,
                data_utf8.clone(),
            )),
            _ => None,
        })
        .collect();

    let mut claimed: std::collections::HashSet<usize> = std::collections::HashSet::new();

    for i in 0..n {
        let (method, recv, consuming_block) = match &rows[i].kind {
            RowKind::Action {
                method: Some(m),
                receiver_id,
                ..
            } if m.starts_with("on_") => (m.clone(), receiver_id.clone(), rows[i].block_height),
            _ => continue,
        };

        // Prefer the latest candidate data receipt with:
        //   - receiver matches
        //   - block_height <= consuming_block
        //   - not yet claimed
        // Among those, prefer the highest block, then the one whose
        // is_promise_resume flag matches the expected pattern (true for
        // on_step_resumed, false for other on_* callbacks).
        let expected_resume = method == "on_step_resumed";
        let mut best: Option<(usize, String, bool, Option<String>, u64)> = None;
        for (idx, data_id, is_promise_resume, dr_recv, dr_block, data_utf8) in &data_catalog {
            if claimed.contains(idx) {
                continue;
            }
            if dr_recv != &recv {
                continue;
            }
            if *dr_block > consuming_block {
                continue;
            }
            let this_score = (*dr_block, *is_promise_resume == expected_resume);
            let better = match &best {
                None => true,
                Some((_, _, best_is_resume, _, best_block)) => {
                    let best_score = (*best_block, *best_is_resume == expected_resume);
                    this_score > best_score
                }
            };
            if better {
                best = Some((
                    *idx,
                    data_id.clone(),
                    *is_promise_resume,
                    data_utf8.clone(),
                    *dr_block,
                ));
            }
        }

        if let Some((idx, data_id, is_promise_resume, data_utf8, _)) = best {
            claimed.insert(idx);
            rows[idx].resumed_by_data_id = Some(data_id.clone());
            rows[i].resumed_by_data_id = Some(data_id);
            rows[i].resumed_by_data_utf8 = data_utf8;
            if method == "on_step_resumed" && is_promise_resume {
                rows[i].is_yield_resume = true;
            }
        }
    }
}

fn yield_resume_latency(rows: &[Row], events: &[ParsedEvent]) -> Option<f64> {
    let resumed_block_ts = rows
        .iter()
        .find(|r| r.is_yield_resume)
        .map(|r| r.block_timestamp_ns)?;
    let registered_ts = events
        .iter()
        .find(|e| e.event == "step_registered")
        .map(|e| e.block_timestamp_ns)?;
    Some(delta_seconds(resumed_block_ts, registered_ts))
}

fn build_outcome_banner(events: &[ParsedEvent]) -> (String, bool) {
    for e in events.iter().rev() {
        match e.event.as_str() {
            "sequence_completed" => {
                let step = e
                    .data
                    .get("final_step_id")
                    .and_then(Value::as_str)
                    .unwrap_or("?");
                return (format!("sequence_completed  (final step {step})"), false);
            }
            "sequence_halted" => {
                let reason = e.data.get("reason").and_then(Value::as_str).unwrap_or("?");
                let step = e.data.get("step_id").and_then(Value::as_str).unwrap_or("?");
                let kind = e
                    .data
                    .get("error_kind")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let label = if kind.is_empty() {
                    format!("sequence_halted  (reason={reason}, step {step})")
                } else {
                    format!("sequence_halted  (reason={reason}, error_kind={kind}, step {step})")
                };
                return (label, true);
            }
            _ => {}
        }
    }
    ("(no sequence terminal event detected)".to_string(), false)
}

// ---------------------------------------------------------------
// Render — ASCII/ANSI
// ---------------------------------------------------------------

mod style {
    const RESET: &str = "\x1b[0m";
    const BOLD: &str = "\x1b[1m";
    const DIM: &str = "\x1b[2m";
    const RED: &str = "\x1b[31m";
    const GREEN: &str = "\x1b[32m";
    const YELLOW: &str = "\x1b[33m";
    const CYAN: &str = "\x1b[36m";

    pub fn bold(s: &str, on: bool) -> String {
        if on {
            format!("{BOLD}{s}{RESET}")
        } else {
            s.to_string()
        }
    }
    pub fn dim(s: &str, on: bool) -> String {
        if on {
            format!("{DIM}{s}{RESET}")
        } else {
            s.to_string()
        }
    }
    pub fn red(s: &str, on: bool) -> String {
        if on {
            format!("{RED}{s}{RESET}")
        } else {
            s.to_string()
        }
    }
    pub fn green(s: &str, on: bool) -> String {
        if on {
            format!("{GREEN}{s}{RESET}")
        } else {
            s.to_string()
        }
    }
    pub fn yellow(s: &str, on: bool) -> String {
        if on {
            format!("{YELLOW}{s}{RESET}")
        } else {
            s.to_string()
        }
    }
    pub fn cyan(s: &str, on: bool) -> String {
        if on {
            format!("{CYAN}{s}{RESET}")
        } else {
            s.to_string()
        }
    }
}

pub fn render_ascii(trace: &Trace, color: bool, show_refunds: bool, verbose: bool) -> String {
    let mut out = String::new();

    // --- Banner ---
    let block_span = format!(
        "{} → {}  ({} blocks, Δ {:.2}s)",
        with_commas(trace.summary.block_min),
        with_commas(trace.summary.block_max),
        trace.summary.block_max - trace.summary.block_min + 1,
        trace.summary.duration_s
    );
    let outcome_line = if trace.summary.outcome_is_error {
        style::red(&trace.summary.outcome_banner, color)
    } else {
        style::green(&trace.summary.outcome_banner, color)
    };
    let method = trace
        .top_method
        .clone()
        .unwrap_or_else(|| "(not a FunctionCall)".to_string());

    let width: usize = 78;
    out.push_str(&format!("{}\n", box_top(width)));
    out.push_str(&format!(
        "{}\n",
        box_row(&style::bold("Sequence trace", color), width, color)
    ));
    out.push_str(&format!("{}\n", box_row("", width, color)));
    out.push_str(&format!(
        "{}\n",
        box_row(
            &format!("  smart account   {}", trace.receiver_id),
            width,
            color
        )
    ));
    out.push_str(&format!(
        "{}\n",
        box_row(
            &format!("  signer          {}", trace.signer_id),
            width,
            color
        )
    ));
    out.push_str(&format!(
        "{}\n",
        box_row(
            &format!("  transaction     {}", trace.tx_hash),
            width,
            color
        )
    ));
    out.push_str(&format!(
        "{}\n",
        box_row(&format!("  top-level call  {}", method), width, color)
    ));
    out.push_str(&format!(
        "{}\n",
        box_row(&format!("  block span      {}", block_span), width, color)
    ));
    out.push_str(&format!(
        "{}\n",
        box_row(&format!("  outcome         {}", outcome_line), width, color)
    ));
    out.push_str(&format!("{}\n\n", box_bottom(width)));

    out.push_str(&format!(
        "{}\n\n",
        style::bold("Receipts in execution order:", color)
    ));

    // --- Rows ---
    let mut pending_refunds: Vec<&Row> = Vec::new();
    for row in &trace.rows {
        if row.is_refund && !show_refunds {
            pending_refunds.push(row);
            continue;
        }
        render_row(&mut out, row, trace, color, verbose);
    }
    if !pending_refunds.is_empty() && !show_refunds {
        let bmin = pending_refunds
            .iter()
            .map(|r| r.block_height)
            .min()
            .unwrap_or(0);
        let bmax = pending_refunds
            .iter()
            .map(|r| r.block_height)
            .max()
            .unwrap_or(0);
        let gas_total: u64 = pending_refunds.iter().map(|r| r.gas_burnt).sum();
        let line = format!(
            " … {} refund receipts across blocks {}–{}  ({:.2} TGas total)",
            pending_refunds.len(),
            with_commas(bmin),
            with_commas(bmax),
            gas_total as f64 / 1_000_000_000_000.0,
        );
        out.push_str(&format!("{}\n", style::dim(&line, color)));
    }

    // --- NEP-519 callout ---
    if trace.summary.yield_resume_detected {
        out.push('\n');
        out.push_str(&format!("{}\n", hr(width)));
        out.push('\n');
        out.push_str(&format!(
            "{}\n",
            style::bold("NEP-519 yield/resume:", color)
        ));
        let latency = trace
            .summary
            .yield_resume_latency_s
            .map(|l| format!("{:.2}s", l))
            .unwrap_or_else(|| "?".to_string());
        out.push_str(
            "   execute_steps ran register_step, which yielded and returned a DataReceipt\n",
        );
        out.push_str(&format!(
            "   placeholder. {} later, that placeholder was resolved, firing the\n   \
             on_step_resumed callback. This is the core mechanic that lets step N+1\n   \
             wait for step N's resolution.\n",
            latency
        ));
    }

    // --- Summary footer ---
    out.push('\n');
    out.push_str(&format!("{}\n", hr(width)));
    out.push('\n');
    out.push_str(&format!(
        "{} {:.2} TGas  (tokens burnt: {})\n",
        style::bold("Gas total    ", color),
        trace.summary.gas_burnt_total as f64 / 1_000_000_000_000.0,
        format_yocto_near(trace.summary.tokens_burnt_total),
    ));
    let n_events: usize = trace.summary.event_counts.values().sum();
    let n_emitting_receipts = trace.rows.iter().filter(|r| !r.events.is_empty()).count();
    let event_types: Vec<String> = trace.summary.event_counts.keys().cloned().collect();
    out.push_str(&format!(
        "{} {} events across {} receipts\n",
        style::bold("Events       ", color),
        n_events,
        n_emitting_receipts,
    ));
    if !event_types.is_empty() {
        out.push_str(&format!("             {}\n", event_types.join(", ")));
    }
    out.push_str(&format!(
        "{} {} action + {} data receipts",
        style::bold("Receipts     ", color),
        trace.summary.action_receipts,
        trace.summary.data_receipts
    ));
    if trace.summary.refund_count > 0 {
        out.push_str(&format!(
            "  ({} gas-refund receipts collapsed)",
            trace.summary.refund_count
        ));
    }
    out.push('\n');

    out
}

fn render_row(out: &mut String, row: &Row, trace: &Trace, color: bool, verbose: bool) {
    match &row.kind {
        RowKind::Action {
            method,
            receiver_id,
            predecessor_id,
        } => {
            let marker =
                if !row.events.is_empty() || row.receipt_id == first_action_receipt_id(trace) {
                    style::green("●", color)
                } else {
                    style::dim("○", color)
                };
            let method_label = match method {
                Some(m) => {
                    let prefix = if m.starts_with("on_") {
                        "fn(cb): "
                    } else {
                        "fn:      "
                    };
                    format!("{prefix}{m}")
                }
                None => "(non-FunctionCall action)".to_string(),
            };
            let header = format!(
                " {marker} {block}  +{delta:5.2}s  {id}  {flow}  {gas}",
                marker = marker,
                block = style::bold(&with_commas(row.block_height), color),
                delta = row.delta_s_from_tx,
                id = style::cyan(&short_id(&row.receipt_id), color),
                flow = style::dim(&format!("{predecessor_id} → {receiver_id}"), color),
                gas = style::dim(
                    &format!("{:6.2} TGas", row.gas_burnt as f64 / 1_000_000_000_000.0),
                    color
                ),
            );
            out.push_str(&header);
            out.push('\n');
            out.push_str(&format!("     {method_label}"));
            if let Some(data_id) = &row.resumed_by_data_id {
                let decoded = row
                    .resumed_by_data_utf8
                    .clone()
                    .unwrap_or_else(|| "<bytes>".to_string());
                let arrow = if row.is_yield_resume {
                    format!(
                        "  {} yield-resumed by data {} ({})",
                        style::yellow("←", color),
                        short_id(data_id),
                        truncate(&decoded, 40)
                    )
                } else {
                    format!(
                        "  ← fed by data {} ({})",
                        short_id(data_id),
                        truncate(&decoded, 40)
                    )
                };
                out.push_str(&style::dim(&arrow, color));
            }
            out.push('\n');
            for e in &row.events {
                out.push_str(&format!(
                    "       └ {} {}\n",
                    style::bold(&e.event, color),
                    event_data_summary(e, verbose)
                ));
            }
        }
        RowKind::Data {
            data_id,
            is_promise_resume,
            data_utf8,
            data_bytes_len,
            receiver_id,
            predecessor_id,
        } => {
            let marker = style::dim("·", color);
            let kind_label = if *is_promise_resume {
                "Data (yield-resume)"
            } else {
                "Data (promise-result)"
            };
            let body = match data_utf8 {
                Some(s) if !s.is_empty() => truncate(&strip_json_quotes(s), 50),
                _ => format!("<{data_bytes_len} bytes>"),
            };
            let header = format!(
                " {marker} {block}  +{delta:5.2}s  {id}  {flow}",
                marker = marker,
                block = style::dim(&with_commas(row.block_height), color),
                delta = row.delta_s_from_tx,
                id = style::dim(&short_id(&row.receipt_id), color),
                flow = style::dim(&format!("{predecessor_id} → {receiver_id}"), color),
            );
            out.push_str(&header);
            out.push('\n');
            out.push_str(&style::dim(
                &format!(
                    "     {kind_label}  data_id={}  body=\"{}\"\n",
                    short_id(data_id),
                    body
                ),
                color,
            ));
        }
    }
}

fn first_action_receipt_id(trace: &Trace) -> String {
    trace
        .rows
        .iter()
        .find_map(|r| match &r.kind {
            RowKind::Action { .. } => Some(r.receipt_id.clone()),
            _ => None,
        })
        .unwrap_or_default()
}

/// Extract the "interesting" fields from an sa-automation event
/// without dumping its whole body. Verbose mode includes runtime.
fn event_data_summary(e: &ParsedEvent, verbose: bool) -> String {
    let d = &e.data;
    let mut bits: Vec<String> = Vec::new();
    if let Some(s) = d.get("step_id").and_then(Value::as_str) {
        bits.push(format!("step={}", truncate(s, 40)));
    }
    match e.event.as_str() {
        "pre_gate_checked" => {
            if let Some(v) = d.get("outcome").and_then(Value::as_str) {
                bits.push(format!("outcome={v}"));
            }
            if let Some(v) = d.get("matched").and_then(Value::as_bool) {
                bits.push(format!("matched={v}"));
            }
            if let Some(v) = d.get("comparison").and_then(Value::as_str) {
                bits.push(format!("cmp={v}"));
            }
        }
        "step_resolved_ok" => {
            if let Some(v) = d.get("result_bytes_len").and_then(Value::as_u64) {
                bits.push(format!("bytes={v}"));
            }
            if let Some(v) = d.get("resolve_latency_ms").and_then(Value::as_u64) {
                bits.push(format!("latency={}ms", v));
            }
        }
        "step_resolved_err" => {
            if let Some(v) = d.get("reason").and_then(Value::as_str) {
                bits.push(format!("reason={v}"));
            }
        }
        "sequence_halted" => {
            if let Some(v) = d.get("reason").and_then(Value::as_str) {
                bits.push(format!("reason={v}"));
            }
            if let Some(v) = d.get("error_kind").and_then(Value::as_str) {
                bits.push(format!("error_kind={v}"));
            }
        }
        "step_registered" => {
            if let Some(v) = d.pointer("/call/policy").and_then(Value::as_str) {
                bits.push(format!("policy={v}"));
            }
            if let Some(v) = d.pointer("/call/target_id").and_then(Value::as_str) {
                bits.push(format!("target={v}"));
            }
        }
        "sequence_started" => {
            if let Some(v) = d.get("namespace").and_then(Value::as_str) {
                bits.push(format!("ns={v}"));
            }
        }
        "sequence_completed" => {
            if let Some(v) = d.get("final_step_id").and_then(Value::as_str) {
                bits.push(format!("final={v}"));
            }
            if let Some(v) = d.get("final_result_bytes_len").and_then(Value::as_u64) {
                bits.push(format!("bytes={v}"));
            }
        }
        "result_saved" => {
            if let Some(v) = d.get("as_name").and_then(Value::as_str) {
                bits.push(format!("as={v}"));
            }
            if let Some(v) = d.get("kind").and_then(Value::as_str) {
                bits.push(format!("kind={v}"));
            }
        }
        _ => {}
    }
    if verbose {
        if let Some(rt) = d.get("runtime") {
            bits.push(format!("runtime={}", rt));
        }
    }
    bits.join("  ")
}

// ---------------------------------------------------------------
// Render — simple ("prove the claim")
// ---------------------------------------------------------------

/// Compact timeline of state-changing events with numbered markers
/// and near.rocks links at the bottom. The user's eye-test surface:
/// monotonic block numbers prove on-chain order; links let a skeptic
/// click through and verify independently.
pub fn render_simple(trace: &Trace, color: bool) -> String {
    let mut out = String::new();

    // Header line: flagship hint (from top_method) • account • ✓/✗ status • duration.
    let (status_icon, status_word) = if trace.summary.outcome_is_error {
        (style::red("✗", color), "halted")
    } else if trace
        .summary
        .outcome_banner
        .starts_with("sequence_completed")
    {
        (style::green("✓", color), "completed")
    } else {
        (style::yellow("◌", color), "unknown")
    };
    let flagship_hint = trace.top_method.as_deref().unwrap_or("(no-method)");
    out.push_str(&format!(
        "{} {} {} {} {} {} in {:.2}s\n\n",
        style::bold(flagship_hint, color),
        style::dim("•", color),
        style::bold(&trace.receiver_id, color),
        style::dim("•", color),
        status_icon,
        status_word,
        trace.summary.duration_s,
    ));

    // Assemble timeline markers. The "tx submitted" marker is always #1,
    // anchored on the tx block. Then each state-changing event contributes
    // a marker; result_saved folds into its sibling step_resolved_ok.
    let mut markers: Vec<SimpleMarker> = Vec::new();

    let step_count = trace
        .summary
        .event_counts
        .get("step_registered")
        .copied()
        .unwrap_or(0);
    markers.push(SimpleMarker {
        block_height: trace.tx_block_height,
        delta_s: 0.0,
        label: "tx submitted".to_string(),
        detail: if step_count > 0 {
            format!(
                "{} ({} step{})",
                flagship_hint,
                step_count,
                if step_count == 1 { "" } else { "s" }
            )
        } else {
            flagship_hint.to_string()
        },
        ok: true,
    });

    // result_saved lookup: index by step_id so step_resolved_ok can pick
    // up the "saved as X" annotation for the same step.
    let saved_by_step: std::collections::HashMap<String, String> = trace
        .events
        .iter()
        .filter(|e| e.event == "result_saved")
        .filter_map(|e| {
            let step = e.data.get("step_id").and_then(Value::as_str)?;
            let as_name = e.data.get("as_name").and_then(Value::as_str).unwrap_or("?");
            Some((step.to_string(), as_name.to_string()))
        })
        .collect();

    let tx_ts = trace.tx_block_timestamp_ns;
    for e in &trace.events {
        let delta = delta_seconds(e.block_timestamp_ns, tx_ts);
        match e.event.as_str() {
            "pre_gate_checked" => {
                let step = e.data.get("step_id").and_then(Value::as_str).unwrap_or("?");
                let outcome = e.data.get("outcome").and_then(Value::as_str).unwrap_or("?");
                let matched = e
                    .data
                    .get("matched")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let mut detail = format!("{outcome}");
                // actual_return is base64-encoded bytes (the gate view
                // result). Decode if UTF-8 for pedagogy.
                if let Some(actual_b64) = e.data.get("actual_return").and_then(Value::as_str) {
                    let (utf8, _) = decode_data(actual_b64);
                    match utf8 {
                        Some(s) if !s.is_empty() => {
                            detail.push_str(&format!(
                                " (value={})",
                                truncate(&strip_json_quotes(&s), 24)
                            ));
                        }
                        _ => {
                            detail.push_str(&format!(" (value={})", truncate(actual_b64, 24)));
                        }
                    }
                }
                markers.push(SimpleMarker {
                    block_height: e.block_height,
                    delta_s: delta,
                    label: format!("gate check {}", short_step(step)),
                    detail,
                    ok: matched,
                });
            }
            "step_resolved_ok" => {
                let step = e.data.get("step_id").and_then(Value::as_str).unwrap_or("?");
                let bytes = e
                    .data
                    .get("result_bytes_len")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                let method = e
                    .data
                    .pointer("/call/method")
                    .and_then(Value::as_str)
                    .unwrap_or("?");
                let mut detail = format!("{method} → {bytes} bytes");
                if let Some(as_name) = saved_by_step.get(step) {
                    detail.push_str(&format!(", saved as \"{as_name}\""));
                }
                markers.push(SimpleMarker {
                    block_height: e.block_height,
                    delta_s: delta,
                    label: format!("{} resolved", short_step(step)),
                    detail,
                    ok: true,
                });
            }
            "step_resolved_err" => {
                let step = e.data.get("step_id").and_then(Value::as_str).unwrap_or("?");
                let reason = e.data.get("reason").and_then(Value::as_str).unwrap_or("?");
                markers.push(SimpleMarker {
                    block_height: e.block_height,
                    delta_s: delta,
                    label: format!("{} failed", short_step(step)),
                    detail: format!("reason={reason}"),
                    ok: false,
                });
            }
            "sequence_halted" => {
                let reason = e.data.get("reason").and_then(Value::as_str).unwrap_or("?");
                let kind = e.data.get("error_kind").and_then(Value::as_str);
                let detail = match kind {
                    Some(k) if !k.is_empty() => format!("reason={reason}, error_kind={k}"),
                    _ => format!("reason={reason}"),
                };
                markers.push(SimpleMarker {
                    block_height: e.block_height,
                    delta_s: delta,
                    label: "sequence halted".to_string(),
                    detail,
                    ok: false,
                });
            }
            "sequence_completed" => {
                let final_step = e
                    .data
                    .get("final_step_id")
                    .and_then(Value::as_str)
                    .unwrap_or("?");
                markers.push(SimpleMarker {
                    block_height: e.block_height,
                    delta_s: delta,
                    label: "sequence completed".to_string(),
                    detail: format!("final {}", short_step(final_step)),
                    ok: true,
                });
            }
            _ => {}
        }
    }

    // Determine column widths so the numeric columns line up.
    let max_label_len = markers
        .iter()
        .map(|m| m.label.chars().count())
        .max()
        .unwrap_or(0);
    for (i, m) in markers.iter().enumerate() {
        let circled = circled_digit(i + 1);
        let check = if m.ok {
            style::green("✓", color)
        } else {
            style::red("✗", color)
        };
        let detail_prefix = if m.detail.is_empty() { "" } else { "  " };
        out.push_str(&format!(
            "  {circled} {label:<width$}  block {block:>11}   +{delta:5.2}s{pfx}{check} {detail}\n",
            circled = circled,
            label = m.label,
            width = max_label_len,
            block = with_commas(m.block_height),
            delta = m.delta_s,
            pfx = detail_prefix,
            check = check,
            detail = m.detail,
        ));
    }

    // Explorer links — the "click this to verify" payoff.
    out.push('\n');
    out.push_str(&format!("{}\n", style::bold("Verify on-chain:", color)));
    out.push_str(&format!(
        "  tx     https://near.rocks/tx/{}\n",
        trace.tx_hash
    ));
    out.push_str(&format!(
        "  start  https://near.rocks/block/{}\n",
        trace.summary.block_min
    ));
    if trace.summary.block_max != trace.summary.block_min {
        out.push_str(&format!(
            "  end    https://near.rocks/block/{}\n",
            trace.summary.block_max
        ));
    }

    out
}

struct SimpleMarker {
    block_height: u64,
    delta_s: f64,
    label: String,
    detail: String,
    ok: bool,
}

/// Trim a verbose step_id like `limit-order-20260419T17050` to a
/// friendly "step limit-order-…" while keeping short ids intact.
fn short_step(step_id: &str) -> String {
    if step_id == "?" || step_id.is_empty() {
        return "step ?".to_string();
    }
    if step_id.len() <= 20 {
        format!("step {step_id}")
    } else {
        format!("step {}…", &step_id[..18])
    }
}

/// Unicode circled digit for 1..=20, fallback to `(N)` beyond.
fn circled_digit(n: usize) -> String {
    const CIRCLED: &[char] = &[
        '①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱',
        '⑲', '⑳',
    ];
    if n >= 1 && n <= CIRCLED.len() {
        CIRCLED[n - 1].to_string()
    } else {
        format!("({n})")
    }
}

// ---------------------------------------------------------------
// Render — JSON
// ---------------------------------------------------------------

pub fn render_json(trace: &Trace) -> Value {
    let rows: Vec<Value> = trace
        .rows
        .iter()
        .map(|r| {
            let kind = match &r.kind {
                RowKind::Action {
                    method,
                    receiver_id,
                    predecessor_id,
                } => serde_json::json!({
                    "type": "action",
                    "method": method,
                    "receiver_id": receiver_id,
                    "predecessor_id": predecessor_id,
                }),
                RowKind::Data {
                    data_id,
                    is_promise_resume,
                    data_utf8,
                    data_bytes_len,
                    receiver_id,
                    predecessor_id,
                } => serde_json::json!({
                    "type": "data",
                    "data_id": data_id,
                    "is_promise_resume": is_promise_resume,
                    "data_utf8": data_utf8,
                    "data_bytes_len": data_bytes_len,
                    "receiver_id": receiver_id,
                    "predecessor_id": predecessor_id,
                }),
            };
            let status = match &r.status {
                OutcomeStatus::SuccessValue(v) => {
                    serde_json::json!({"type": "SuccessValue", "value": v})
                }
                OutcomeStatus::SuccessReceiptId(v) => {
                    serde_json::json!({"type": "SuccessReceiptId", "receipt_id": v})
                }
                OutcomeStatus::Failure(v) => serde_json::json!({"type": "Failure", "detail": v}),
                OutcomeStatus::Unknown => serde_json::json!({"type": "Unknown"}),
                OutcomeStatus::NotApplicable => Value::Null,
            };
            serde_json::json!({
                "block_height": r.block_height,
                "block_timestamp_ns": r.block_timestamp_ns,
                "delta_s": r.delta_s_from_tx,
                "receipt_id": r.receipt_id,
                "gas_burnt": r.gas_burnt,
                "tokens_burnt": r.tokens_burnt.to_string(),
                "is_refund": r.is_refund,
                "is_yield_resume": r.is_yield_resume,
                "resumed_by_data_id": r.resumed_by_data_id,
                "status": status,
                "kind": kind,
                "events": r.events.iter().map(|e| serde_json::json!({
                    "standard": e.standard,
                    "version": e.version,
                    "event": e.event,
                    "data": e.data,
                })).collect::<Vec<_>>(),
            })
        })
        .collect();

    serde_json::json!({
        "tx_hash": trace.tx_hash,
        "signer_id": trace.signer_id,
        "receiver_id": trace.receiver_id,
        "top_method": trace.top_method,
        "tx_block_height": trace.tx_block_height,
        "tx_block_timestamp_ns": trace.tx_block_timestamp_ns,
        "block_span": {
            "min": trace.summary.block_min,
            "max": trace.summary.block_max,
            "duration_s": trace.summary.duration_s,
        },
        "summary": {
            "gas_burnt_total": trace.summary.gas_burnt_total,
            "tokens_burnt_total": trace.summary.tokens_burnt_total.to_string(),
            "event_counts": trace.summary.event_counts,
            "action_receipts": trace.summary.action_receipts,
            "data_receipts": trace.summary.data_receipts,
            "refund_count": trace.summary.refund_count,
            "refund_gas_total": trace.summary.refund_gas_total,
            "outcome_banner": trace.summary.outcome_banner,
            "outcome_is_error": trace.summary.outcome_is_error,
            "yield_resume_detected": trace.summary.yield_resume_detected,
            "yield_resume_latency_s": trace.summary.yield_resume_latency_s,
        },
        "events": trace.events.iter().map(|e| serde_json::json!({
            "block_height": e.block_height,
            "block_timestamp_ns": e.block_timestamp_ns,
            "receipt_id": e.receipt_id,
            "standard": e.standard,
            "version": e.version,
            "event": e.event,
            "data": e.data,
        })).collect::<Vec<_>>(),
        "receipts": rows,
    })
}

// ---------------------------------------------------------------
// Small formatting helpers
// ---------------------------------------------------------------

fn short_id(s: &str) -> String {
    if s.len() <= 12 {
        s.to_string()
    } else {
        format!("{}…", &s[..8])
    }
}

/// Strip outer JSON string quotes if the bytes decode to a JSON string.
/// `"hello"` → `hello`; `{"k":1}` → `{"k":1}`.
fn strip_json_quotes(s: &str) -> String {
    if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') {
        s[1..s.len() - 1].to_string()
    } else {
        s.to_string()
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let head: String = s.chars().take(max.saturating_sub(1)).collect();
        format!("{head}…")
    }
}

fn with_commas(n: u64) -> String {
    let s = n.to_string();
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len() + s.len() / 3);
    let first_group_len = bytes.len() % 3;
    for (i, b) in bytes.iter().enumerate() {
        if i > 0 && (i - first_group_len) % 3 == 0 && i != first_group_len {
            out.push(',');
        } else if i == first_group_len && first_group_len != 0 && first_group_len != bytes.len() {
            out.push(',');
        }
        out.push(*b as char);
    }
    out
}

fn format_yocto_near(yocto: u128) -> String {
    // Render in millinear (mN) if < 1 NEAR, else NEAR with 4 decimals.
    let one_near: u128 = 1_000_000_000_000_000_000_000_000;
    let milli: u128 = one_near / 1_000;
    if yocto >= one_near {
        let whole = yocto / one_near;
        let frac = (yocto % one_near) / (one_near / 10_000);
        format!("{}.{:04} N", whole, frac)
    } else if yocto >= milli {
        let whole = yocto / milli;
        let frac = (yocto % milli) / (milli / 100);
        format!("{}.{:02} mN", whole, frac)
    } else {
        format!("{} yN", yocto)
    }
}

fn box_top(w: usize) -> String {
    format!("╭{}╮", "─".repeat(w - 2))
}
fn box_bottom(w: usize) -> String {
    format!("╰{}╯", "─".repeat(w - 2))
}
fn box_row(body: &str, w: usize, _color: bool) -> String {
    // Account for ANSI escape sequences when computing visible length.
    // Budget: w minus 2 border chars minus 2 inner spaces (left/right).
    let inner = w.saturating_sub(4);
    let visible = visible_len(body);
    let (rendered, vis) = if visible > inner {
        let truncated = truncate_preserving_ansi(body, inner);
        let v = visible_len(&truncated);
        (truncated, v)
    } else {
        (body.to_string(), visible)
    };
    let pad = inner.saturating_sub(vis);
    format!("│ {rendered}{} │", " ".repeat(pad))
}

fn truncate_preserving_ansi(s: &str, max_visible: usize) -> String {
    let mut out = String::new();
    let mut count = 0usize;
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' && chars.peek() == Some(&'[') {
            out.push(c);
            while let Some(next) = chars.next() {
                out.push(next);
                if next == 'm' {
                    break;
                }
            }
            continue;
        }
        if count + 1 > max_visible {
            // Try to end with ellipsis if room.
            if out.chars().last() != Some('…') {
                // Pop one char to make room.
                let popped_len = out.chars().last().map(|c| c.len_utf8()).unwrap_or(0);
                if popped_len > 0 {
                    let new_len = out.len() - popped_len;
                    out.truncate(new_len);
                }
                out.push('…');
            }
            break;
        }
        out.push(c);
        count += 1;
    }
    out
}
fn hr(w: usize) -> String {
    "─".repeat(w)
}

fn visible_len(s: &str) -> usize {
    // Strip ANSI CSI sequences for width calculation.
    let mut count = 0usize;
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' && chars.peek() == Some(&'[') {
            chars.next();
            for next in chars.by_ref() {
                if next == 'm' {
                    break;
                }
            }
            continue;
        }
        count += 1;
    }
    count
}

// ---------------------------------------------------------------
// Tests
// ---------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn load_fixture(name: &str) -> Value {
        let path = format!("{}/fixtures/{}", env!("CARGO_MANIFEST_DIR"), name);
        let bytes = std::fs::read(&path).expect("fixture read");
        serde_json::from_slice(&bytes).expect("fixture parse")
    }

    #[test]
    fn parse_trace_limit_order() {
        let v = load_fixture("limit-order.json");
        let trace = parse_trace(&v).unwrap();

        assert_eq!(
            trace.tx_hash,
            "9quv5g2S1c4ZeLJQrMZmSpuGwfYM4fX4Y61GfA7vf4Cr"
        );
        assert_eq!(trace.signer_id, "mike.near");
        assert_eq!(trace.receiver_id, "mike.near");
        assert_eq!(trace.top_method.as_deref(), Some("execute_steps"));

        assert_eq!(trace.summary.action_receipts, 11);
        assert_eq!(trace.summary.data_receipts, 3);

        // 6 events: step_registered, sequence_started, step_resumed,
        // pre_gate_checked, step_resolved_ok, sequence_completed.
        assert_eq!(trace.events.len(), 6);
        assert_eq!(trace.summary.event_counts.get("step_registered"), Some(&1));
        assert_eq!(
            trace.summary.event_counts.get("sequence_completed"),
            Some(&1)
        );

        // Yield-resume detection: limit-order yields + resumes once.
        assert!(trace.summary.yield_resume_detected);
        assert!(trace.summary.yield_resume_latency_s.unwrap() > 0.0);

        assert!(trace
            .summary
            .outcome_banner
            .starts_with("sequence_completed"));
        assert!(!trace.summary.outcome_is_error);

        // At least one row should be a yield-resume action.
        assert!(trace.rows.iter().any(|r| r.is_yield_resume));

        // Refunds detected.
        assert!(trace.summary.refund_count >= 3);
    }

    #[test]
    fn parse_trace_ladder_swap() {
        let v = load_fixture("ladder-swap.json");
        let trace = parse_trace(&v).unwrap();

        assert_eq!(trace.signer_id, "mike.near");
        // Three step_registered events + sequence_started, etc.
        assert_eq!(trace.summary.event_counts.get("step_registered"), Some(&3));
        assert_eq!(
            trace.summary.event_counts.get("sequence_completed"),
            Some(&1)
        );
        // Value threading: expect a result_saved event.
        assert!(trace.summary.event_counts.get("result_saved").is_some());
        assert!(trace
            .summary
            .outcome_banner
            .starts_with("sequence_completed"));
    }

    #[test]
    fn render_ascii_smoke_limit_order() {
        let v = load_fixture("limit-order.json");
        let trace = parse_trace(&v).unwrap();
        let out = render_ascii(&trace, false, false, false);

        assert!(out.contains("mike.near"));
        assert!(out.contains("9quv5g2S1c4ZeLJQrMZmSpuGwfYM4fX4Y61GfA7vf4Cr"));
        assert!(out.contains("execute_steps"));
        assert!(out.contains("sequence_completed"));
        assert!(out.contains("NEP-519 yield/resume"));
        assert!(out.contains("on_step_resumed"));
        assert!(out.contains("on_pre_gate_checked"));
        assert!(out.contains("on_step_resolved"));
        assert!(out.contains("Gas total"));
        // Events inlined under receipts.
        assert!(out.contains("step_registered"));
        assert!(out.contains("pre_gate_checked"));
    }

    #[test]
    fn render_no_color_is_ansi_free() {
        let v = load_fixture("limit-order.json");
        let trace = parse_trace(&v).unwrap();
        let out = render_ascii(&trace, false, false, false);
        assert!(
            !out.contains('\x1b'),
            "no-color output must be free of ANSI escapes"
        );
    }

    #[test]
    fn render_color_has_ansi() {
        let v = load_fixture("limit-order.json");
        let trace = parse_trace(&v).unwrap();
        let out = render_ascii(&trace, true, false, false);
        assert!(
            out.contains('\x1b'),
            "color output should contain ANSI escapes"
        );
    }

    #[test]
    fn render_json_schema() {
        let v = load_fixture("limit-order.json");
        let trace = parse_trace(&v).unwrap();
        let j = render_json(&trace);
        for key in [
            "tx_hash",
            "signer_id",
            "receiver_id",
            "block_span",
            "summary",
            "events",
            "receipts",
        ] {
            assert!(j.get(key).is_some(), "missing key `{key}`");
        }
        assert_eq!(j["tx_hash"], "9quv5g2S1c4ZeLJQrMZmSpuGwfYM4fX4Y61GfA7vf4Cr");
        assert_eq!(j["summary"]["yield_resume_detected"], true);
    }

    #[test]
    fn render_simple_limit_order() {
        let v = load_fixture("limit-order.json");
        let trace = parse_trace(&v).unwrap();
        let out = render_simple(&trace, false);

        // Status line: flagship hint, account, completed, duration.
        assert!(out.contains("execute_steps"));
        assert!(out.contains("mike.near"));
        assert!(out.contains("completed"));

        // Numbered markers.
        assert!(out.contains("①"), "missing circled 1");
        assert!(out.contains("tx submitted"));
        assert!(out.contains("gate check"));
        assert!(out.contains("resolved"));
        assert!(out.contains("sequence completed"));

        // near.rocks links: tx + start block always; end block iff
        // block_max differs from block_min.
        assert!(out.contains("https://near.rocks/tx/9quv5g2S1c4ZeLJQrMZmSpuGwfYM4fX4Y61GfA7vf4Cr"));
        assert!(out.contains("https://near.rocks/block/194707945"));
        assert!(out.contains(&format!(
            "https://near.rocks/block/{}",
            trace.summary.block_max
        )));

        // No ANSI when color=false.
        assert!(!out.contains('\x1b'));
    }

    #[test]
    fn render_simple_ladder_swap() {
        let v = load_fixture("ladder-swap.json");
        let trace = parse_trace(&v).unwrap();
        let out = render_simple(&trace, false);

        // Three step_resolved_ok events → three numbered markers.
        assert!(out.contains("①"));
        assert!(out.contains("②"));
        assert!(out.contains("③"));
        assert!(out.contains("④"));
        assert!(out.contains("⑤"));

        // Value-threading hint: the "saved as X" annotation from result_saved.
        assert!(
            out.contains("saved as"),
            "expected the result_saved annotation"
        );
    }

    #[test]
    fn circled_digit_table() {
        assert_eq!(circled_digit(1), "①");
        assert_eq!(circled_digit(20), "⑳");
        assert_eq!(circled_digit(21), "(21)");
        assert_eq!(circled_digit(0), "(0)");
    }

    #[test]
    fn with_commas_formats_numbers() {
        assert_eq!(with_commas(0), "0");
        assert_eq!(with_commas(999), "999");
        assert_eq!(with_commas(1_000), "1,000");
        assert_eq!(with_commas(194_707_948), "194,707,948");
        assert_eq!(with_commas(1_234_567_890), "1,234,567,890");
    }

    #[test]
    fn short_id_truncates_long() {
        let long = "G2qtaZCfn62hpLmhpNbRHJEdG5PYLuzBb2FGVbbeyhkQ";
        assert_eq!(short_id(long), "G2qtaZCf…");
        assert_eq!(short_id("short"), "short");
    }

    #[test]
    fn format_yocto_near_thresholds() {
        assert_eq!(format_yocto_near(0), "0 yN");
        // 5 mN
        let milli_near = 1_000_000_000_000_000_000_000u128;
        assert!(format_yocto_near(5 * milli_near).ends_with("mN"));
        // 1.5 N
        let one_near = 1_000_000_000_000_000_000_000_000u128;
        let result = format_yocto_near(3 * one_near / 2);
        assert!(result.ends_with("N"));
        assert!(result.contains("1.5"));
    }
}
