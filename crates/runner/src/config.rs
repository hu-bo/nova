use clap::Parser;
use serde::Deserialize;
use std::{fs, path::PathBuf};

#[derive(Debug, Parser)]
#[command(name = "nova-runner", about = "WebSocket-based Nova workspace Runner")]
pub struct Cli {
    #[arg(long, env = "NOVA_RUNNER_CONFIG")]
    config: Option<PathBuf>,
    #[arg(long, env = "NOVA_RUNNER_SERVER")]
    server: Option<String>,
    #[arg(long, env = "NOVA_RUNNER_TOKEN")]
    token: Option<String>,
    #[arg(long, env = "NOVA_RUNNER_WORKSPACE")]
    workspace: Option<PathBuf>,
    #[arg(long, env = "NOVA_RUNNER_WORKSPACE_ID")]
    workspace_id: Option<String>,
    #[arg(long, env = "NOVA_RUNNER_DISPLAY_NAME")]
    display_name: Option<String>,
    #[arg(long, env = "NOVA_RUNNER_ID")]
    runner_id: Option<String>,
    #[arg(long, env = "NOVA_RUNNER_MAX_CONCURRENCY")]
    max_concurrency: Option<usize>,
    #[arg(long, env = "NOVA_RUNNER_READ_ONLY", default_value_t = false)]
    read_only: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct FileConfig {
    server: Option<String>,
    token: Option<String>,
    workspace: Option<PathBuf>,
    workspace_id: Option<String>,
    display_name: Option<String>,
    runner_id: Option<String>,
    max_concurrency: Option<usize>,
    read_only: bool,
}

#[derive(Debug)]
pub struct Config {
    pub server: String,
    pub token: String,
    pub workspace: PathBuf,
    pub workspace_id: String,
    pub display_name: String,
    pub runner_id: String,
    pub max_concurrency: usize,
    pub read_only: bool,
}

impl Config {
    pub fn load(cli: Cli) -> Result<Self, Box<dyn std::error::Error>> {
        let file = match &cli.config {
            Some(path) => toml::from_str::<FileConfig>(&fs::read_to_string(path)?)?,
            None => FileConfig::default(),
        };
        let server =
            choose(cli.server, file.server).ok_or("missing --server or NOVA_RUNNER_SERVER")?;
        let token = choose(cli.token, file.token).ok_or("missing --token or NOVA_RUNNER_TOKEN")?;
        let workspace = choose(cli.workspace, file.workspace).unwrap_or_else(|| PathBuf::from("."));
        if token.trim().is_empty() {
            return Err("Runner token cannot be empty".into());
        }
        let url = url::Url::parse(&server)?;
        if !matches!(url.scheme(), "ws" | "wss") || url.host().is_none() {
            return Err("--server must be a ws:// or wss:// URL".into());
        }
        let workspace = fs::canonicalize(&workspace)?;
        if !workspace.is_dir() {
            return Err("Runner workspace must be an existing directory".into());
        }
        let workspace_id =
            choose(cli.workspace_id, file.workspace_id).unwrap_or_else(|| "default".into());
        let display_name =
            choose(cli.display_name, file.display_name).unwrap_or_else(|| workspace_id.clone());
        let host = std::env::var("COMPUTERNAME")
            .or_else(|_| std::env::var("HOSTNAME"))
            .unwrap_or_else(|_| "runner".into());
        let runner_id = choose(cli.runner_id, file.runner_id)
            .unwrap_or_else(|| format!("{host}:{workspace_id}"));
        let max_concurrency = cli.max_concurrency.or(file.max_concurrency).unwrap_or(4);
        if max_concurrency == 0 || max_concurrency > 64 {
            return Err("max-concurrency must be between 1 and 64".into());
        }
        Ok(Self {
            server,
            token,
            workspace,
            workspace_id,
            display_name,
            runner_id,
            max_concurrency,
            read_only: cli.read_only || file.read_only,
        })
    }
}

fn choose<T>(first: Option<T>, second: Option<T>) -> Option<T> {
    first.or(second)
}

impl Cli {
    pub fn parse() -> Self {
        <Self as Parser>::parse()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cli(workspace: Option<PathBuf>) -> Cli {
        Cli {
            config: None,
            server: Some("ws://127.0.0.1:9203/runner/v1/connect".into()),
            token: Some("test-token".into()),
            workspace,
            workspace_id: None,
            display_name: None,
            runner_id: None,
            max_concurrency: None,
            read_only: false,
        }
    }

    #[test]
    fn workspace_defaults_to_current_directory() {
        let config = Config::load(cli(None)).unwrap();
        assert_eq!(config.workspace, fs::canonicalize(".").unwrap());
    }

    #[test]
    fn explicit_workspace_overrides_current_directory() {
        let config = Config::load(cli(Some(PathBuf::from("..")))).unwrap();
        assert_eq!(config.workspace, fs::canonicalize("..").unwrap());
    }
}
