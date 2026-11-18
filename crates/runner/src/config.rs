use clap::Parser;
use serde::Deserialize;
use std::{
    fs,
    path::{Path, PathBuf},
};
use uuid::Uuid;

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
        let runner_id = choose(cli.runner_id, file.runner_id).unwrap_or_else(default_runner_id);
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

// 默认设备 ID 为 `<用户名>-<系统>-<8位随机hex>`，首次生成后写入用户数据目录复用，
// 保证同一台机器重启后 runner_id 不变，避免服务端重复注册设备。
fn default_runner_id() -> String {
    persisted_runner_id(runner_id_file().as_deref())
}

fn persisted_runner_id(id_file: Option<&Path>) -> String {
    if let Some(id_file) = id_file {
        if let Ok(saved) = fs::read_to_string(id_file) {
            let saved = saved.trim();
            if is_usable_runner_id(saved) {
                return saved.to_owned();
            }
        }
    }
    let id = generate_runner_id();
    if let Some(id_file) = id_file {
        // 落盘失败时本次仍用新 ID，下次启动会重试写入。
        if let Some(dir) = id_file.parent() {
            if fs::create_dir_all(dir).is_ok() {
                let _ = fs::write(id_file, format!("{id}\n"));
            }
        }
    }
    id
}

fn generate_runner_id() -> String {
    let suffix: String = Uuid::new_v4().simple().to_string().chars().take(8).collect();
    format!("{}-{}-{suffix}", username_segment(), std::env::consts::OS)
}

fn username_segment() -> String {
    ["USERNAME", "USER", "LOGNAME"]
        .into_iter()
        .filter_map(|key| std::env::var(key).ok())
        .map(|value| sanitize_segment(&value, "unknown"))
        .find(|segment| segment != "unknown")
        .unwrap_or_else(|| "unknown".into())
}

// ID 只保留小写字母、数字与下划线，其他字符折叠为单个 `-`，避免用户名带域前缀或空格。
fn sanitize_segment(value: &str, fallback: &str) -> String {
    let mut out = String::new();
    for ch in value.to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            out.push(ch);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out = out.chars().take(32).collect();
    let out = out.trim_matches('-');
    if out.is_empty() {
        fallback.to_owned()
    } else {
        out.to_owned()
    }
}

fn is_usable_runner_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && !value
            .chars()
            .any(|ch| ch.is_control() || ch.is_whitespace())
}

fn runner_id_file() -> Option<PathBuf> {
    if cfg!(windows) {
        return std::env::var_os("LOCALAPPDATA")
            .map(|dir| PathBuf::from(dir).join("nova-runner").join("runner_id"));
    }
    let data_dir = match std::env::var_os("XDG_DATA_HOME").map(PathBuf::from) {
        Some(dir) if dir.is_absolute() => dir,
        _ => PathBuf::from(std::env::var_os("HOME")?).join(".local/share"),
    };
    Some(data_dir.join("nova-runner").join("runner_id"))
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
            // 显式传入以避免默认生成逻辑读写测试机的用户数据目录。
            runner_id: Some("runner:test".into()),
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

    fn temp_id_file(label: &str) -> PathBuf {
        std::env::temp_dir()
            .join(format!("nova-runner-{label}-{}", Uuid::new_v4()))
            .join("runner_id")
    }

    #[test]
    fn default_runner_id_is_generated_then_reused_from_file() {
        let file = temp_id_file("stable");
        let first = persisted_runner_id(Some(&file));
        let second = persisted_runner_id(Some(&file));
        assert_eq!(first, second);
        let prefix = format!("{}-{}-", username_segment(), std::env::consts::OS);
        assert!(
            first.starts_with(&prefix),
            "unexpected default runner_id: {first}"
        );
        let suffix = first.strip_prefix(&prefix).unwrap();
        assert_eq!(suffix.len(), 8);
        assert!(suffix.chars().all(|ch| ch.is_ascii_hexdigit()));
        fs::remove_dir_all(file.parent().unwrap()).unwrap();
    }

    #[test]
    fn unusable_id_file_content_triggers_regeneration() {
        let file = temp_id_file("invalid");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, "\n  \n").unwrap();
        let generated = persisted_runner_id(Some(&file));
        assert!(!generated.trim().is_empty());
        assert_eq!(fs::read_to_string(&file).unwrap().trim(), generated);
        fs::remove_dir_all(file.parent().unwrap()).unwrap();
    }

    #[test]
    fn sanitize_segment_collapses_unsafe_characters() {
        assert_eq!(sanitize_segment("hubo9", "unknown"), "hubo9");
        assert_eq!(
            sanitize_segment("DOMAIN\\Hubo 9", "unknown"),
            "domain-hubo-9"
        );
        assert_eq!(sanitize_segment("-- --", "unknown"), "unknown");
    }
}
