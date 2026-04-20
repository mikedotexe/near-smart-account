//! `smart-account-observer`: live and retrospective views of
//! `sa-automation` NEP-297 events on a NEAR smart-account deployment.
//!
//! Two subcommands:
//! - `stream` — tails FastNEAR's neardata service, emits one jsonl
//!   line per event on stdout. Good for "what's happening right now?"
//! - `trace` — fetches a single tx from FastNEAR's TX API and renders
//!   a deep-mechanics ASCII/ANSI table showing receipt-DAG ordering,
//!   NEP-519 yield/resume arrows, event emissions, and gas burn.
//!   Good for "walk me through the sequencer's machinery".

mod nep297;
mod stream;
mod trace;

use anyhow::Result;
use clap::{Parser, Subcommand};

#[derive(Parser, Debug)]
#[command(
    name = "smart-account-observer",
    about = "Observe sa-automation NEP-297 events on a NEAR smart-account deployment.",
    long_about = "Two modes:\n\
                  - `stream` tails FastNEAR's neardata service for live events\n\
                  - `trace`  fetches one tx and renders the receipt-DAG walkthrough\n\
                  \n\
                  Loads FASTNEAR_API_KEY from .env if present."
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Tail sa-automation events live via FastNEAR neardata.
    Stream(stream::StreamArgs),
    /// Render the receipt-DAG + NEP-519 yield/resume walkthrough for
    /// one transaction via FastNEAR's TX API.
    Trace(trace::TraceArgs),
}

#[tokio::main]
async fn main() -> Result<()> {
    // Load .env before anything reads the environment.
    dotenvy::dotenv().ok();

    // Tracing goes to stderr so stdout stays clean (jsonl for stream,
    // ASCII for trace).
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let cli = Cli::parse();
    match cli.command {
        Command::Stream(args) => stream::run(args).await,
        Command::Trace(args) => trace::run(args).await,
    }
}
