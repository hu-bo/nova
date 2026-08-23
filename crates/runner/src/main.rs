mod config;
mod connection;
mod error;
mod execution;
mod pb;
mod process;
mod protocol;
mod workspace;

use std::sync::Arc;

use clap::Parser;
use tokio::sync::watch;

use config::{Args, Config, ConfigError};
use execution::Executor;
use workspace::Workspace;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    tracing_subscriber::fmt().with_env_filter(env_filter).init();

    let config = match Config::from_args(Args::parse()) {
        Ok(config) => Arc::new(config),
        Err(err) => {
            eprintln!("nova-runner: {err}");
            match err {
                // These are documented, expected refusals (docs/runner.md §8/§10.4), not bugs —
                // exit cleanly rather than dumping a panic backtrace at the user.
                ConfigError::WorkspaceMissing(_) | ConfigError::ServerMissing => {
                    std::process::exit(1)
                }
            }
        }
    };

    let workspace = Arc::new(Workspace::new(config.workspace.clone())?);
    let executor = Executor::new(
        config.max_concurrency,
        config.queue_size,
        config.default_timeout_ms,
    );

    tracing::info!(
        runner_id = %config.runner_id,
        server = %config.server,
        workspace = %workspace.root().display(),
        max_concurrency = config.max_concurrency,
        queue_size = config.queue_size,
        "nova-runner starting"
    );

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            tracing::info!("shutting down");
            let _ = shutdown_tx.send(true);
        }
    });
    connection::run(config, workspace, executor, shutdown_rx).await
}
