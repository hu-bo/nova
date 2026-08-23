//! CLI/config surface. See docs/runner.md §8 (workspace) and §9 (command).

use std::path::PathBuf;

use clap::Parser;

#[derive(Debug, Parser)]
#[command(name = "nova-runner", version)]
pub struct Args {
    /// Server URL to open the outbound gRPC connection to, e.g. http://127.0.0.1:54321.
    #[arg(long)]
    pub server: Option<String>,

    /// Runner connection token; sent as `authorization: Bearer <token>` metadata.
    #[arg(long)]
    pub token: Option<String>,

    /// Stable Runner id. Defaults to a host/workspace-derived id.
    #[arg(long)]
    pub runner_id: Option<String>,

    /// Workspace root. Must already exist — it is never created automatically.
    #[arg(long)]
    pub workspace: Option<PathBuf>,

    /// Max concurrently-running executions. Defaults to the number of CPUs.
    #[arg(long)]
    pub max_concurrency: Option<usize>,

    /// Extra admitted-but-queued executions beyond `max_concurrency`. Defaults to 4x it.
    #[arg(long)]
    pub queue_size: Option<usize>,

    /// Default execution timeout when a request doesn't specify one.
    #[arg(long, default_value_t = 120_000)]
    pub default_timeout_ms: u32,
}

pub struct Config {
    pub server: String,
    pub token: String,
    pub runner_id: String,
    pub workspace: PathBuf,
    pub max_concurrency: usize,
    pub queue_size: usize,
    pub default_timeout_ms: u32,
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error(
        "workspace {0:?} does not exist (it is never created automatically — see docs/runner.md §8)"
    )]
    WorkspaceMissing(PathBuf),
    #[error(
        "--server <url> and --token <t> are required to open the outbound connection (docs/runner.md §9)"
    )]
    ServerMissing,
}

impl Config {
    pub fn from_args(args: Args) -> Result<Self, ConfigError> {
        let server = args
            .server
            .filter(|s| !s.is_empty())
            .ok_or(ConfigError::ServerMissing)?;
        let token = args
            .token
            .filter(|t| !t.is_empty())
            .ok_or(ConfigError::ServerMissing)?;

        let workspace = args.workspace.unwrap_or(
            std::env::current_dir()
                .map_err(|_| ConfigError::WorkspaceMissing(PathBuf::from(".")))?,
        );
        if !workspace.is_dir() {
            return Err(ConfigError::WorkspaceMissing(workspace));
        }
        let runner_id = args
            .runner_id
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| default_runner_id(&workspace));

        let max_concurrency = args.max_concurrency.unwrap_or_else(|| {
            std::thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(4)
        });
        let queue_size = args.queue_size.unwrap_or(max_concurrency * 4);

        Ok(Config {
            server,
            token,
            runner_id,
            workspace,
            max_concurrency,
            queue_size,
            default_timeout_ms: args.default_timeout_ms,
        })
    }
}

fn default_runner_id(workspace: &std::path::Path) -> String {
    let hostname = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| std::env::consts::ARCH.to_string())
        .to_lowercase()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in workspace.to_string_lossy().as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("runner-{}-{hostname}-{hash:08x}", std::env::consts::OS)
}
