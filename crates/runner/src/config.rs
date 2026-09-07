//! CLI/config surface. See docs/runner.md §8 (workspace) and §9 (command).

use std::net::IpAddr;
use std::path::{Path, PathBuf};

use clap::Parser;
use serde::Deserialize;

#[derive(Debug, Parser)]
#[command(name = "nova-runner", version)]
pub struct Args {
    /// TOML configuration file. Explicit CLI values override file values.
    #[arg(long)]
    pub config: Option<PathBuf>,

    /// Server URL to open the outbound gRPC connection to, e.g. http://127.0.0.1:54321.
    #[arg(long)]
    pub server: Option<String>,

    /// Connect directly to this IP, preserving the server hostname and port.
    #[arg(long)]
    pub connect_ip: Option<IpAddr>,

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
    #[arg(long)]
    pub default_timeout_ms: Option<u32>,
}

pub struct Config {
    pub server: String,
    pub connect_ip: Option<IpAddr>,
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
    #[error("runner server is missing; set --server or server in --config (docs/runner.md §9)")]
    ServerMissing,
    #[error("runner token is missing; set --token or token in --config (docs/runner.md §9)")]
    TokenMissing,
    #[error("failed to read runner config {path:?}: {source}")]
    ConfigRead {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to parse runner config {path:?}: {source}")]
    ConfigParse {
        path: PathBuf,
        #[source]
        source: Box<toml::de::Error>,
    },
}

impl Config {
    pub fn from_args(args: Args) -> Result<Self, ConfigError> {
        let config_path = args.config.as_deref();
        let file = config_path
            .map(FileConfig::load)
            .transpose()?
            .unwrap_or_default();

        let server = non_empty(args.server)
            .or_else(|| non_empty(file.server))
            .ok_or(ConfigError::ServerMissing)?;
        let token = non_empty(args.token)
            .or_else(|| non_empty(file.token))
            .ok_or(ConfigError::TokenMissing)?;

        let workspace = match (args.workspace, file.workspace) {
            (Some(workspace), _) => workspace,
            (None, Some(workspace)) => resolve_config_path(config_path, workspace),
            (None, None) => std::env::current_dir()
                .map_err(|_| ConfigError::WorkspaceMissing(PathBuf::from(".")))?,
        };
        if !workspace.is_dir() {
            return Err(ConfigError::WorkspaceMissing(workspace));
        }
        let runner_id = non_empty(args.runner_id)
            .or_else(|| non_empty(file.runner_id))
            .unwrap_or_else(|| default_runner_id(&workspace));

        let max_concurrency = args
            .max_concurrency
            .or(file.max_concurrency)
            .unwrap_or_else(|| {
                std::thread::available_parallelism()
                    .map(|n| n.get())
                    .unwrap_or(4)
            });
        let queue_size = args
            .queue_size
            .or(file.queue_size)
            .unwrap_or(max_concurrency * 4);
        let default_timeout_ms = args
            .default_timeout_ms
            .or(file.default_timeout_ms)
            .unwrap_or(120_000);

        Ok(Config {
            server,
            connect_ip: args.connect_ip.or(file.connect_ip),
            token,
            runner_id,
            workspace,
            max_concurrency,
            queue_size,
            default_timeout_ms,
        })
    }
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileConfig {
    server: Option<String>,
    connect_ip: Option<IpAddr>,
    token: Option<String>,
    runner_id: Option<String>,
    workspace: Option<PathBuf>,
    max_concurrency: Option<usize>,
    queue_size: Option<usize>,
    default_timeout_ms: Option<u32>,
}

impl FileConfig {
    fn load(path: &Path) -> Result<Self, ConfigError> {
        let source = std::fs::read_to_string(path).map_err(|source| ConfigError::ConfigRead {
            path: path.to_path_buf(),
            source,
        })?;
        toml::from_str(&source).map_err(|source| ConfigError::ConfigParse {
            path: path.to_path_buf(),
            source: Box::new(source),
        })
    }
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.trim().is_empty())
}

fn resolve_config_path(config_path: Option<&Path>, path: PathBuf) -> PathBuf {
    if path.is_absolute() {
        return path;
    }
    config_path
        .and_then(Path::parent)
        .map_or(path.clone(), |parent| parent.join(path))
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

#[cfg(test)]
mod tests {
    use super::{Args, Config, ConfigError};
    use clap::Parser;
    use std::fs;

    fn args(config: std::path::PathBuf) -> Args {
        Args {
            config: Some(config),
            server: None,
            connect_ip: None,
            token: None,
            runner_id: None,
            workspace: None,
            max_concurrency: None,
            queue_size: None,
            default_timeout_ms: None,
        }
    }

    #[test]
    fn loads_service_configuration_and_resolves_relative_workspace() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        let path = directory.path().join("config.toml");
        fs::write(
            &path,
            r#"
server = "https://runner.example.com"
connect_ip = "223.109.200.118"
token = "runner-secret"
workspace = "workspace"
runner_id = "desktop"
max_concurrency = 3
queue_size = 9
default_timeout_ms = 4567
"#,
        )
        .unwrap();

        let config = Config::from_args(args(path)).unwrap();

        assert_eq!(config.server, "https://runner.example.com");
        assert_eq!(config.connect_ip, Some("223.109.200.118".parse().unwrap()));
        assert_eq!(config.token, "runner-secret");
        assert_eq!(config.workspace, workspace);
        assert_eq!(config.runner_id, "desktop");
        assert_eq!(config.max_concurrency, 3);
        assert_eq!(config.queue_size, 9);
        assert_eq!(config.default_timeout_ms, 4567);
    }

    #[test]
    fn explicit_cli_values_override_file_values() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        let path = directory.path().join("config.toml");
        fs::write(
            &path,
            format!(
                "server = \"https://old.example.com\"\nconnect_ip = \"127.0.0.1\"\ntoken = \"old\"\nworkspace = {:?}\nmax_concurrency = 2\n",
                workspace.to_string_lossy()
            ),
        )
        .unwrap();
        let mut input = args(path);
        input.server = Some("https://new.example.com".into());
        input.connect_ip = Some("::1".parse().unwrap());
        input.token = Some("new".into());
        input.max_concurrency = Some(5);

        let config = Config::from_args(input).unwrap();

        assert_eq!(config.server, "https://new.example.com");
        assert_eq!(config.connect_ip, Some("::1".parse().unwrap()));
        assert_eq!(config.token, "new");
        assert_eq!(config.max_concurrency, 5);
    }

    #[test]
    fn rejects_unknown_file_fields() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.toml");
        fs::write(
            &path,
            "server = \"https://runner.example.com\"\ntypo = true\n",
        )
        .unwrap();

        let error = match Config::from_args(args(path)) {
            Ok(_) => panic!("unknown config field was accepted"),
            Err(error) => error,
        };

        assert!(matches!(error, ConfigError::ConfigParse { .. }));
    }

    #[test]
    fn connect_ip_accepts_only_ip_literals() {
        for ip in ["127.0.0.1", "::1"] {
            let args = Args::try_parse_from(["nova-runner", "--connect-ip", ip]).unwrap();
            assert_eq!(args.connect_ip, Some(ip.parse().unwrap()));
        }
        for invalid in ["example.com", "127.0.0.1:80", "", "999.1.1.1"] {
            assert!(Args::try_parse_from(["nova-runner", "--connect-ip", invalid]).is_err());
            assert!(
                toml::from_str::<super::FileConfig>(&format!("connect_ip = {invalid:?}")).is_err()
            );
        }
        assert!(
            Args::try_parse_from(["nova-runner"])
                .unwrap()
                .connect_ip
                .is_none()
        );
    }
}
