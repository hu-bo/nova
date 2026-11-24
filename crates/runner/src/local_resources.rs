//! Runner 本地受限资源（docs/nova-skills.md §4.3）：
//! `~/.nova/{skills,agents}` 与 `<projectRoot>/.nova/{skills,agents}` 的只读发现、
//! 目录发布，以及按摘要校验的快照读取与受控写入（P0-G2 Runner 侧）。
//!
//! 红线：
//! - 扫描与读写只使用相对定位（源根 + 条目名），协议不携带任何绝对路径；
//! - 只读扫描不执行脚本、不创建目录；写入仅限已知资源源根链内；
//! - 超限/截断/权限失败必须标 `complete=false` 并附诊断，不以空结果冒充成功。

use crate::{
    config::Config,
    proto::nova::{
        common::v1::ErrorCode,
        runner::v1::{
            LocalResourceDiagnostic, LocalResourceEntry, ReadResourceSnapshotRequest,
            ReadResourceSnapshotResult, RefreshResourceCatalog, ResourceCatalogPublished,
            RunnerEnvelope, WriteResourceFileRequest, WriteResourceFileResult,
            runner_envelope::Payload,
        },
    },
    workspace,
};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{ErrorKind, Read},
    path::{Component, Path, PathBuf},
    time::{Duration, Instant},
};

/// 单次目录发布的条目数上限；超出即截断并标不完整。
pub const MAX_ENTRIES: usize = 256;
/// 入口文件（SKILL.md / <name>.md）大小上限，扫描与写入共用。
pub const MAX_ENTRY_BYTES: usize = 256 * 1024;
/// 单次扫描总时限。
pub const SCAN_DEADLINE: Duration = Duration::from_secs(5);
/// 定向刷新可累计跟踪的项目层数量上限，防止无界增长。
pub const MAX_PROJECT_LAYERS: usize = 64;
/// 名称最长 64 字符（小写 kebab-case）。
pub const MAX_NAME_LEN: usize = 64;

const NOVA_DIR: &str = ".nova";
const SKILLS_DIR: &str = "skills";
const AGENTS_DIR: &str = "agents";
const SKILL_ENTRY: &str = "SKILL.md";

pub const CAPABILITY_LOCAL_RESOURCES: &str = "local_resources";
pub const CAPABILITY_LOCAL_RESOURCES_WRITE: &str = "local_resources.write";

/// proto `ResourceKind` 数值（prost 以 i32 承载）。
#[cfg(test)]
pub const KIND_UNSPECIFIED: i32 = 0;
pub const KIND_SKILL: i32 = 1;
pub const KIND_AGENT: i32 = 2;
/// proto `ResourceScope` 数值。
#[cfg(test)]
pub const SCOPE_UNSPECIFIED: i32 = 0;
pub const SCOPE_GLOBAL: i32 = 1;
pub const SCOPE_PROJECT: i32 = 2;

/// 诊断 code 与 `@nova/agent-ui-contracts` 的 `skillCatalogDiagnosticSchema` 枚举一致。
mod code {
    pub const MISSING_HOME: &str = "missing_home";
    pub const PERMISSION_DENIED: &str = "permission_denied";
    pub const INVALID_FRONTMATTER: &str = "invalid_frontmatter";
    pub const FILE_TOO_LARGE: &str = "file_too_large";
    pub const DUPLICATE_NAME: &str = "duplicate_name";
    pub const PATH_ESCAPE: &str = "path_escape";
    pub const TRUNCATED: &str = "truncated";
    pub const SCAN_TIMEOUT: &str = "scan_timeout";
    pub const SCAN_ERROR: &str = "scan_error";
}

/// 使目录不完整的失败类诊断（数据类诊断只跳过单条目，不影响完整性）。
const INCOMPLETE_CODES: [&str; 5] = [
    code::MISSING_HOME,
    code::PERMISSION_DENIED,
    code::TRUNCATED,
    code::SCAN_TIMEOUT,
    code::SCAN_ERROR,
];

#[derive(Debug, thiserror::Error)]
pub enum ResourceError {
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    NotFound(String),
    #[error("resource target escapes its source root: {0}")]
    OutOfWorkspace(String),
    #[error("resource digest precondition failed: {0}")]
    Conflict(String),
    #[error("{0}")]
    Exists(String),
    #[error("{0}")]
    Permission(String),
    #[error("{0}")]
    TooLarge(String),
    #[error("resource I/O failed: {0}")]
    Io(String),
}

impl ResourceError {
    pub fn wire_code(&self) -> ErrorCode {
        match self {
            ResourceError::Invalid(_) => ErrorCode::Invalid,
            ResourceError::NotFound(_) => ErrorCode::NotFound,
            ResourceError::OutOfWorkspace(_) => ErrorCode::OutOfWorkspace,
            ResourceError::Conflict(_) => ErrorCode::Conflict,
            ResourceError::Exists(_) => ErrorCode::Exists,
            ResourceError::Permission(_) => ErrorCode::Permission,
            ResourceError::TooLarge(_) => ErrorCode::TooLarge,
            ResourceError::Io(_) => ErrorCode::Io,
        }
    }
}

/// I/O 错误只保留稳定短因由，绝不把含绝对路径的原始错误文案写进诊断。
fn kind_label(kind: ErrorKind) -> &'static str {
    match kind {
        ErrorKind::NotFound => "not_found",
        ErrorKind::PermissionDenied => "permission_denied",
        ErrorKind::AlreadyExists => "already_exists",
        ErrorKind::InvalidInput => "invalid_input",
        ErrorKind::InvalidData => "invalid_data",
        ErrorKind::TimedOut => "timed_out",
        _ => "io_error",
    }
}

fn io_reason(error: &std::io::Error) -> String {
    match error.raw_os_error() {
        Some(code) => format!("{} (os error {code})", kind_label(error.kind())),
        None => kind_label(error.kind()).to_owned(),
    }
}

/// Runner 用户主目录（`~`）：Windows 对应用户目录（USERPROFILE），其余平台 HOME。
/// 这是「Runner 进程 OS 用户」的目录，不是 Worker/浏览器用户的主目录。
pub fn resolve_home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let raw = std::env::var_os("USERPROFILE");
    #[cfg(not(windows))]
    let raw = std::env::var_os("HOME");
    let home = raw.map(PathBuf::from)?;
    if home.is_dir() { Some(home) } else { None }
}

/// 校验条目名：小写 kebab-case（`[a-z0-9]+(-[a-z0-9]+)*`），最长 64 字符。
pub fn is_valid_resource_name(name: &str) -> bool {
    if name.is_empty() || name.len() > MAX_NAME_LEN {
        return false;
    }
    let mut previous_dash = true; // 首字符不允许 '-'
    for byte in name.bytes() {
        if byte == b'-' {
            if previous_dash {
                return false;
            }
            previous_dash = true;
        } else if byte.is_ascii_lowercase() || byte.is_ascii_digit() {
            previous_dash = false;
        } else {
            return false;
        }
    }
    !previous_dash // 末字符不允许 '-'
}

/// 校验并规范化项目层 `relative_dir`（相对注册工作区根）。
/// 允许 "."（工作区根）；拒绝空串、绝对路径、盘符、`..`、空段与 NUL；输出统一 posix 形式。
pub fn normalize_relative_dir(raw: &str) -> Option<String> {
    if raw.contains('\0') {
        return None;
    }
    if raw == "." {
        return Some(".".to_owned());
    }
    if raw.is_empty() || raw.starts_with('/') {
        return None;
    }
    let mut segments = Vec::new();
    for component in Path::new(raw).components() {
        match component {
            Component::Normal(part) => {
                let part = part.to_string_lossy();
                if part == ".." || part == "." || part.is_empty() {
                    return None;
                }
                segments.push(part.into_owned());
            }
            // 绝对路径 / 盘符 / `..` / CurDir 混排一律拒绝。
            _ => return None,
        }
    }
    if segments.is_empty() {
        return None;
    }
    Some(segments.join("/"))
}

/// frontmatter 手工最小解析：首个 `---` 块内的顶层标量 `key: value`。
/// 不接受缩进（嵌套结构冒充标量）与列表项；无块、未闭合或结构非法返回 None。
pub fn parse_frontmatter(bytes: &[u8]) -> Option<BTreeMap<String, String>> {
    let text = std::str::from_utf8(bytes).ok()?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut lines = text.split('\n');
    let opener = lines.next()?.trim_end_matches('\r');
    if opener != "---" {
        return None;
    }
    let mut map = BTreeMap::new();
    let mut closed = false;
    for line in lines {
        let line = line.trim_end_matches('\r');
        if line.trim_end() == "---" {
            closed = true;
            break;
        }
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        // 缩进行或列表项意味着嵌套结构，P0 不接受。
        if line.starts_with(' ') || line.starts_with('\t') || line.trim_start().starts_with("- ") {
            return None;
        }
        let (key, value) = line.split_once(':')?;
        let key = key.trim();
        if key.is_empty()
            || !key
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        {
            return None;
        }
        let value = unwrap_scalar(value.trim());
        // 空标量（如 `description:` 后跟嵌套块）不构成合法顶层标量。
        if value.is_empty() {
            return None;
        }
        map.insert(key.to_owned(), value);
    }
    closed.then_some(map)
}

fn unwrap_scalar(value: &str) -> String {
    let bytes = value.as_bytes();
    if bytes.len() >= 2
        && ((bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\'')
            || (bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"'))
    {
        value[1..value.len() - 1].to_owned()
    } else {
        value.to_owned()
    }
}

#[derive(Debug, Clone)]
struct Candidate {
    kind: i32,
    scope: i32,
    workspace_id: String,
    relative_dir: String,
    name: String,
    description: String,
    sha256: String,
    size_bytes: u64,
}

/// 一次目录扫描的结果。
pub struct CatalogScan {
    pub entries: Vec<LocalResourceEntry>,
    pub diagnostics: Vec<LocalResourceDiagnostic>,
    pub complete: bool,
}

/// Runner 本地资源状态：源根定位、已跟踪的项目层与目录版本号。
#[derive(Debug, Clone)]
pub struct LocalResources {
    home: Option<PathBuf>,
    workspace_root: PathBuf,
    workspace_id: String,
    /// 已跟踪项目层（normalize_relative_dir 输出；启动默认含工作区根 "."）。
    project_dirs: BTreeSet<String>,
    revision: u64,
}

impl LocalResources {
    pub fn from_config(config: &Config) -> Self {
        Self {
            home: resolve_home_dir(),
            workspace_root: config.workspace.clone(),
            workspace_id: config.workspace_id.clone(),
            project_dirs: BTreeSet::from([".".to_owned()]),
            revision: 0,
        }
    }

    /// 显式注入源根的构造（单元/集成测试用，避免依赖真实用户主目录）。
    #[cfg(test)]
    pub fn with_roots(
        home: Option<PathBuf>,
        workspace_root: PathBuf,
        workspace_id: String,
    ) -> Self {
        Self {
            home,
            workspace_root,
            workspace_id,
            project_dirs: BTreeSet::from([".".to_owned()]),
            revision: 0,
        }
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    /// 每次成功发布递增目录版本。
    pub fn next_revision(&mut self) -> u64 {
        self.revision = self.revision.saturating_add(1);
        self.revision
    }

    /// 校验定向刷新的定位参数；非法定位返回错误（应答方标 complete=false + 诊断）。
    /// 合法时把新的项目层并入跟踪集合（global 层始终全量扫描，无需登记）。
    pub fn apply_refresh(&mut self, refresh: &RefreshResourceCatalog) -> Result<(), String> {
        match refresh.scope {
            SCOPE_GLOBAL => {
                if !refresh.workspace_id.is_empty() || !refresh.relative_dir.is_empty() {
                    return Err("global refresh must not carry workspace or relative_dir".into());
                }
                Ok(())
            }
            SCOPE_PROJECT => {
                if refresh.workspace_id != self.workspace_id {
                    return Err(format!(
                        "workspace {} is not registered on this Runner",
                        refresh.workspace_id
                    ));
                }
                // "."（工作区根）可省略 relative_dir，按根层处理。
                let dir = if refresh.relative_dir.is_empty() {
                    ".".to_owned()
                } else {
                    normalize_relative_dir(&refresh.relative_dir)
                        .ok_or_else(|| "refresh relative_dir is invalid".to_owned())?
                };
                if !self.project_dirs.contains(&dir)
                    && self.project_dirs.len() >= MAX_PROJECT_LAYERS
                {
                    return Err("project layer tracking limit is full".into());
                }
                self.project_dirs.insert(dir);
                Ok(())
            }
            _ => Err("refresh scope is invalid".into()),
        }
    }

    /// 全量扫描（全局层 + 已跟踪项目层）。
    pub fn scan(&self) -> CatalogScan {
        let started = Instant::now();
        let mut diagnostics: Vec<LocalResourceDiagnostic> = Vec::new();
        let mut candidates: Vec<Candidate> = Vec::new();
        let mut complete = true;

        if let Some(home) = &self.home {
            let layer = LayerRoot {
                scope: SCOPE_GLOBAL,
                workspace_id: String::new(),
                relative_dir: String::new(),
                nova: home.join(NOVA_DIR),
            };
            scan_layer(
                &layer,
                &started,
                &mut candidates,
                &mut diagnostics,
                &mut complete,
            );
        } else {
            complete = false;
            diagnostics.push(diagnostic(
                code::MISSING_HOME,
                "Runner process home directory is unavailable; the global layer was not scanned.",
                "",
                "",
            ));
        }

        for dir in &self.project_dirs {
            if limit_reached(&started, &candidates, &mut diagnostics, &mut complete) {
                break;
            }
            let mut path = self.workspace_root.clone();
            if dir != "." {
                for segment in dir.split('/') {
                    path.push(segment);
                }
            }
            let nova = match contained_layer_nova(&self.workspace_root, &path.join(NOVA_DIR)) {
                Ok(nova) => Some(nova),
                Err(message) => {
                    complete = false;
                    diagnostics.push(diagnostic(code::PATH_ESCAPE, &message, "", dir));
                    None
                }
            };
            if let Some(nova) = nova {
                let layer = LayerRoot {
                    scope: SCOPE_PROJECT,
                    workspace_id: self.workspace_id.clone(),
                    relative_dir: dir.clone(),
                    nova,
                };
                scan_layer(
                    &layer,
                    &started,
                    &mut candidates,
                    &mut diagnostics,
                    &mut complete,
                );
            }
        }

        dedupe_candidates(&mut candidates, &mut diagnostics);

        CatalogScan {
            entries: candidates
                .into_iter()
                .map(LocalResourceEntry::from)
                .collect(),
            diagnostics,
            complete,
        }
    }

    /// 快照读取：解析目标 → 摘要校验 → 返回内容。当前摘要与 `expected_sha256` 不符时
    /// 返回 Conflict，消息含当前摘要十六进制，不返回新内容（§4.3「不以新内容替代旧摘要」）。
    pub fn read_snapshot(
        &self,
        request: &ReadResourceSnapshotRequest,
    ) -> Result<ReadResourceSnapshotResult, ResourceError> {
        let target = self.resolve(
            request.kind,
            request.scope,
            &request.workspace_id,
            &request.relative_dir,
            &request.name,
            &request.relative_path,
        )?;
        if request.expected_sha256.is_empty() {
            return Err(ResourceError::Invalid(
                "expected_sha256 is required for resource snapshot reads".into(),
            ));
        }
        let bytes = load_entry_file(&target)?;
        let digest = hex::encode(Sha256::digest(&bytes));
        if digest != request.expected_sha256.to_ascii_lowercase() {
            return Err(ResourceError::Conflict(format!(
                "resource content changed since the published catalog; current_sha256={digest}"
            )));
        }
        let size_bytes = bytes.len() as u64;
        Ok(ReadResourceSnapshotResult {
            contents: bytes,
            sha256: digest,
            size_bytes,
        })
    }

    /// 受限写入（P0-G2 Runner 侧）：只允许已知资源源根链内的入口文件；
    /// 空 `expected_sha256` = 仅创建且目标必须不存在；非空 = CAS；
    /// 目标已是符号链接时拒绝，不创建合法源根链之外的路径。
    pub fn write_resource(
        &self,
        request: &WriteResourceFileRequest,
    ) -> Result<WriteResourceFileResult, ResourceError> {
        let target = self.resolve(
            request.kind,
            request.scope,
            &request.workspace_id,
            &request.relative_dir,
            &request.name,
            &request.relative_path,
        )?;
        if request.contents.len() > MAX_ENTRY_BYTES {
            return Err(ResourceError::TooLarge(format!(
                "resource entry exceeds the {} KiB limit",
                MAX_ENTRY_BYTES / 1024
            )));
        }
        let kind_root = target.kind_root();
        if let Ok(metadata) = fs::symlink_metadata(&kind_root) {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(ResourceError::OutOfWorkspace(
                    "resource source root must be a real directory".into(),
                ));
            }
        }
        // 只读扫描绝不建目录；此处是显式写操作，允许在固定源根链内补建
        //（`.nova/<skills|agents>/<name>`，段名全部来自校验常量）。
        let parent = if target.kind == KIND_SKILL {
            kind_root.join(&target.name)
        } else {
            kind_root.clone()
        };
        ensure_fixed_chain(&kind_root, &parent)?;
        let entry = parent.join(&target.entry_file);
        let existing = match fs::symlink_metadata(&entry) {
            Ok(metadata) => Some(metadata),
            Err(error) if error.kind() == ErrorKind::NotFound => None,
            Err(error) => return Err(ResourceError::Io(io_reason(&error))),
        };
        let mut created = true;
        if let Some(metadata) = existing {
            if metadata.file_type().is_symlink() {
                return Err(ResourceError::OutOfWorkspace(
                    "resource entry is a symbolic link".into(),
                ));
            }
            if !metadata.is_file() {
                return Err(ResourceError::Invalid(
                    "resource entry is not a file".into(),
                ));
            }
            created = false;
            let current = read_entry_bytes(&entry)?;
            let current_digest = hex::encode(Sha256::digest(&current));
            if request.expected_sha256.is_empty() {
                return Err(ResourceError::Exists(
                    "resource entry already exists; supply its current digest to replace it".into(),
                ));
            }
            if current_digest != request.expected_sha256.to_ascii_lowercase() {
                return Err(ResourceError::Conflict(format!(
                    "resource digest precondition failed; current_sha256={current_digest}"
                )));
            }
        } else if !request.expected_sha256.is_empty() {
            return Err(ResourceError::Conflict(
                "resource entry does not exist; leave expected_sha256 empty to create it".into(),
            ));
        }
        workspace::atomic_write(&entry, &request.contents)
            .map_err(|error| ResourceError::Io(error.to_string()))?;
        Ok(WriteResourceFileResult {
            sha256: hex::encode(Sha256::digest(&request.contents)),
            size_bytes: request.contents.len() as u64,
            created,
        })
    }

    /// 把 (kind, scope, workspace_id, relative_dir, name, relative_path) 解析为入口目标；
    /// 只做定位与标识校验，不做 IO。
    fn resolve(
        &self,
        kind: i32,
        scope: i32,
        workspace_id: &str,
        relative_dir: &str,
        name: &str,
        relative_path: &str,
    ) -> Result<ResourceTarget, ResourceError> {
        if kind != KIND_SKILL && kind != KIND_AGENT {
            return Err(ResourceError::Invalid("resource kind is invalid".into()));
        }
        if !is_valid_resource_name(name) {
            return Err(ResourceError::Invalid(format!(
                "resource name is not lowercase kebab-case within {MAX_NAME_LEN} characters"
            )));
        }
        let entry_file = if kind == KIND_SKILL {
            SKILL_ENTRY.to_owned()
        } else {
            format!("{name}.md")
        };
        // P0 只允许入口路径：留空由 kind+name 推导，传入则必须与推导一致。
        if !relative_path.is_empty() && relative_path != entry_file {
            return Err(ResourceError::Invalid(
                "relative_path must be the resource entry path".into(),
            ));
        }
        let nova_root = match scope {
            SCOPE_GLOBAL => {
                if !workspace_id.is_empty() || !relative_dir.is_empty() {
                    return Err(ResourceError::Invalid(
                        "global resources must not carry workspace or relative_dir".into(),
                    ));
                }
                let home = self.home.as_ref().ok_or_else(|| {
                    ResourceError::Permission("home directory is unavailable".into())
                })?;
                home.join(NOVA_DIR)
            }
            SCOPE_PROJECT => {
                if workspace_id != self.workspace_id {
                    return Err(ResourceError::OutOfWorkspace(
                        "resource workspace is not registered on this Runner".into(),
                    ));
                }
                let dir = if relative_dir.is_empty() {
                    ".".to_owned()
                } else {
                    normalize_relative_dir(relative_dir)
                        .ok_or_else(|| ResourceError::Invalid("relative_dir is invalid".into()))?
                };
                let mut path = self.workspace_root.clone();
                if dir != "." {
                    for segment in dir.split('/') {
                        path.push(segment);
                    }
                }
                contained_layer_nova(&self.workspace_root, &path.join(NOVA_DIR))
                    .map_err(ResourceError::OutOfWorkspace)?
            }
            _ => return Err(ResourceError::Invalid("resource scope is invalid".into())),
        };
        Ok(ResourceTarget {
            kind,
            name: name.to_owned(),
            entry_file,
            nova_root,
        })
    }
}

#[derive(Debug)]
struct ResourceTarget {
    kind: i32,
    name: String,
    entry_file: String,
    /// 已定位的 `<layerRoot>/.nova` 目录（层根已确认在工作区内）。
    nova_root: PathBuf,
}

impl ResourceTarget {
    /// 该 kind 的源根：`<nova>/skills` 或 `<nova>/agents`。
    fn kind_root(&self) -> PathBuf {
        self.nova_root.join(if self.kind == KIND_SKILL {
            SKILLS_DIR
        } else {
            AGENTS_DIR
        })
    }
}

struct LayerRoot {
    scope: i32,
    workspace_id: String,
    relative_dir: String,
    /// 已确认位于所属层内的 `<layer>/.nova` 路径。
    nova: PathBuf,
}

impl From<Candidate> for LocalResourceEntry {
    fn from(value: Candidate) -> Self {
        LocalResourceEntry {
            kind: value.kind,
            scope: value.scope,
            workspace_id: value.workspace_id,
            relative_dir: value.relative_dir,
            name: value.name,
            description: value.description,
            sha256: value.sha256,
            size_bytes: value.size_bytes,
        }
    }
}

fn diagnostic(code: &str, message: &str, name: &str, path: &str) -> LocalResourceDiagnostic {
    LocalResourceDiagnostic {
        code: code.to_owned(),
        message: message.to_owned(),
        name: name.to_owned(),
        path: path.to_owned(),
    }
}

fn push_diagnostics(
    diagnostics: &mut Vec<LocalResourceDiagnostic>,
    complete: &mut bool,
    entry: LocalResourceDiagnostic,
) {
    if INCOMPLETE_CODES.contains(&entry.code.as_str()) {
        *complete = false;
    }
    diagnostics.push(entry);
}

fn has_code(diagnostics: &[LocalResourceDiagnostic], code: &str) -> bool {
    diagnostics.iter().any(|item| item.code == code)
}

fn expired(started: &Instant) -> bool {
    started.elapsed() > SCAN_DEADLINE
}

/// 条目上限/时限的统一闸口；命中时写入诊断（每类一次）并标记不完整。
fn limit_reached(
    started: &Instant,
    candidates: &[Candidate],
    diagnostics: &mut Vec<LocalResourceDiagnostic>,
    complete: &mut bool,
) -> bool {
    if candidates.len() >= MAX_ENTRIES {
        *complete = false;
        if !has_code(diagnostics, code::TRUNCATED) {
            diagnostics.push(diagnostic(
                code::TRUNCATED,
                &format!(
                    "resource catalog entry limit ({MAX_ENTRIES}) reached; the scan was truncated."
                ),
                "",
                "",
            ));
        }
        return true;
    }
    if expired(started) {
        *complete = false;
        if !has_code(diagnostics, code::SCAN_TIMEOUT) {
            diagnostics.push(diagnostic(
                code::SCAN_TIMEOUT,
                &format!(
                    "resource scan exceeded its {} second limit; the scan was truncated.",
                    SCAN_DEADLINE.as_secs()
                ),
                "",
                "",
            ));
        }
        return true;
    }
    false
}

fn scan_layer(
    layer: &LayerRoot,
    started: &Instant,
    candidates: &mut Vec<Candidate>,
    diagnostics: &mut Vec<LocalResourceDiagnostic>,
    complete: &mut bool,
) {
    scan_skills_layer(layer, started, candidates, diagnostics, complete);
    if !expired(started) && candidates.len() < MAX_ENTRIES {
        scan_agents_layer(layer, started, candidates, diagnostics, complete);
    }
}

/// `<layer>/.nova/skills` 下的直接子目录发现（`<name>/SKILL.md`）。
fn scan_skills_layer(
    layer: &LayerRoot,
    started: &Instant,
    candidates: &mut Vec<Candidate>,
    diagnostics: &mut Vec<LocalResourceDiagnostic>,
    complete: &mut bool,
) {
    let source_root = match scan_source_root(&layer.nova, KIND_SKILL) {
        Ok(Some(root)) => root,
        Ok(None) => return, // 缺目录视为空。
        Err(item) => {
            push_diagnostics(diagnostics, complete, item);
            return;
        }
    };
    let children = match list_direct_children(&source_root) {
        Ok(children) => children,
        Err(item) => {
            push_diagnostics(diagnostics, complete, item);
            return;
        }
    };
    for child in children {
        if limit_reached(started, candidates, diagnostics, complete) {
            return;
        }
        let dir_name = child
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        let metadata = match fs::symlink_metadata(&child) {
            Ok(metadata) => metadata,
            Err(error) => {
                push_diagnostics(
                    diagnostics,
                    complete,
                    diagnostic(code::SCAN_ERROR, &io_reason(&error), &dir_name, ""),
                );
                continue;
            }
        };
        if metadata.file_type().is_symlink() {
            push_diagnostics(
                diagnostics,
                complete,
                diagnostic(
                    code::PATH_ESCAPE,
                    "skill entries must be real directories, not symbolic links",
                    &dir_name,
                    &dir_name,
                ),
            );
            continue;
        }
        if !metadata.is_dir() {
            continue;
        }
        let entry_path = child.join(SKILL_ENTRY);
        let relative = format!("{dir_name}/{SKILL_ENTRY}");
        let entry_metadata = match fs::symlink_metadata(&entry_path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) => {
                push_diagnostics(
                    diagnostics,
                    complete,
                    diagnostic(code::SCAN_ERROR, &io_reason(&error), &dir_name, &relative),
                );
                continue;
            }
        };
        if !entry_metadata.is_file() && !entry_metadata.file_type().is_symlink() {
            push_diagnostics(
                diagnostics,
                complete,
                diagnostic(
                    code::INVALID_FRONTMATTER,
                    "SKILL.md is missing or not a file",
                    &dir_name,
                    &relative,
                ),
            );
            continue;
        }
        // 入口符号链接允许存在，但解析后的真实位置不得逃出源根。
        let resolved = match fs::canonicalize(&entry_path) {
            Ok(resolved) if resolved.starts_with(&source_root) => resolved,
            Ok(_) => {
                push_diagnostics(
                    diagnostics,
                    complete,
                    diagnostic(
                        code::PATH_ESCAPE,
                        "SKILL.md resolves outside its source root",
                        &dir_name,
                        &relative,
                    ),
                );
                continue;
            }
            Err(_) => continue,
        };
        let bytes = match read_entry(&resolved) {
            ReadOutcome::Ok(bytes) => bytes,
            ReadOutcome::TooLarge => {
                push_diagnostics(
                    diagnostics,
                    complete,
                    diagnostic(
                        code::FILE_TOO_LARGE,
                        &format!(
                            "SKILL.md exceeds the {} KiB entry limit",
                            MAX_ENTRY_BYTES / 1024
                        ),
                        &dir_name,
                        &relative,
                    ),
                );
                continue;
            }
            ReadOutcome::Denied(message) => {
                push_diagnostics(
                    diagnostics,
                    complete,
                    diagnostic(code::PERMISSION_DENIED, &message, &dir_name, &relative),
                );
                continue;
            }
            ReadOutcome::Failed(message) => {
                push_diagnostics(
                    diagnostics,
                    complete,
                    diagnostic(code::SCAN_ERROR, &message, &dir_name, &relative),
                );
                continue;
            }
        };
        match classify_entry(KIND_SKILL, &dir_name, &bytes) {
            EntryOutcome::Accepted { name, description } => candidates.push(Candidate {
                kind: KIND_SKILL,
                scope: layer.scope,
                workspace_id: layer.workspace_id.clone(),
                relative_dir: layer.relative_dir.clone(),
                name,
                description,
                sha256: hex::encode(Sha256::digest(&bytes)),
                size_bytes: bytes.len() as u64,
            }),
            EntryOutcome::Rejected(code, message) => push_diagnostics(
                diagnostics,
                complete,
                diagnostic(code, &message, &dir_name, &relative),
            ),
        }
    }
}

/// `<layer>/.nova/agents` 下的直接子文件发现（`<name>.md`）。
fn scan_agents_layer(
    layer: &LayerRoot,
    started: &Instant,
    candidates: &mut Vec<Candidate>,
    diagnostics: &mut Vec<LocalResourceDiagnostic>,
    complete: &mut bool,
) {
    let source_root = match scan_source_root(&layer.nova, KIND_AGENT) {
        Ok(Some(root)) => root,
        Ok(None) => return,
        Err(item) => {
            push_diagnostics(diagnostics, complete, item);
            return;
        }
    };
    let children = match list_direct_children(&source_root) {
        Ok(children) => children,
        Err(item) => {
            push_diagnostics(diagnostics, complete, item);
            return;
        }
    };
    for child in children {
        if limit_reached(started, candidates, diagnostics, complete) {
            return;
        }
        let file_name = child
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        let Some(stem) = file_name.strip_suffix(".md") else {
            continue;
        };
        if stem.is_empty() {
            continue;
        }
        let metadata = match fs::symlink_metadata(&child) {
            Ok(metadata) => metadata,
            Err(error) => {
                push_diagnostics(
                    diagnostics,
                    complete,
                    diagnostic(code::SCAN_ERROR, &io_reason(&error), stem, &file_name),
                );
                continue;
            }
        };
        if !metadata.is_file() && !metadata.file_type().is_symlink() {
            continue;
        }
        let resolved = match fs::canonicalize(&child) {
            Ok(resolved) if resolved.starts_with(&source_root) => resolved,
            Ok(_) => {
                push_diagnostics(
                    diagnostics,
                    complete,
                    diagnostic(
                        code::PATH_ESCAPE,
                        "agent file resolves outside its source root",
                        stem,
                        &file_name,
                    ),
                );
                continue;
            }
            Err(_) => continue,
        };
        let bytes = match read_entry(&resolved) {
            ReadOutcome::Ok(bytes) => bytes,
            ReadOutcome::TooLarge => {
                push_diagnostics(
                    diagnostics,
                    complete,
                    diagnostic(
                        code::FILE_TOO_LARGE,
                        &format!(
                            "agent file exceeds the {} KiB entry limit",
                            MAX_ENTRY_BYTES / 1024
                        ),
                        stem,
                        &file_name,
                    ),
                );
                continue;
            }
            ReadOutcome::Denied(message) => {
                push_diagnostics(
                    diagnostics,
                    complete,
                    diagnostic(code::PERMISSION_DENIED, &message, stem, &file_name),
                );
                continue;
            }
            ReadOutcome::Failed(message) => {
                push_diagnostics(
                    diagnostics,
                    complete,
                    diagnostic(code::SCAN_ERROR, &message, stem, &file_name),
                );
                continue;
            }
        };
        // Agent 名称取文件名（须已合法）；frontmatter `name` 若存在必须与文件名一致。
        match classify_entry(KIND_AGENT, stem, &bytes) {
            EntryOutcome::Accepted { name, description } => candidates.push(Candidate {
                kind: KIND_AGENT,
                scope: layer.scope,
                workspace_id: layer.workspace_id.clone(),
                relative_dir: layer.relative_dir.clone(),
                name,
                description,
                sha256: hex::encode(Sha256::digest(&bytes)),
                size_bytes: bytes.len() as u64,
            }),
            EntryOutcome::Rejected(code, message) => push_diagnostics(
                diagnostics,
                complete,
                diagnostic(code, &message, stem, &file_name),
            ),
        }
    }
}

enum EntryOutcome {
    Accepted { name: String, description: String },
    Rejected(&'static str, String),
}

/// frontmatter 边界校验：skills 的 `name` 必填、kebab 且与目录名一致（大小写不敏感）；
/// agents 名称取文件名；`description` 必填非空。
fn classify_entry(kind: i32, identifier: &str, bytes: &[u8]) -> EntryOutcome {
    let Some(frontmatter) = parse_frontmatter(bytes) else {
        return EntryOutcome::Rejected(
            code::INVALID_FRONTMATTER,
            "missing or malformed `---` frontmatter block".into(),
        );
    };
    let name = match kind {
        KIND_SKILL => {
            let Some(raw) = frontmatter.get("name") else {
                return EntryOutcome::Rejected(
                    code::INVALID_FRONTMATTER,
                    "frontmatter name is required".into(),
                );
            };
            if !is_valid_resource_name(raw) {
                return EntryOutcome::Rejected(
                    code::INVALID_FRONTMATTER,
                    format!(
                        "frontmatter name `{raw}` is not lowercase kebab-case within {MAX_NAME_LEN} characters"
                    ),
                );
            }
            if !raw.eq_ignore_ascii_case(identifier) {
                return EntryOutcome::Rejected(
                    code::INVALID_FRONTMATTER,
                    format!(
                        "frontmatter name `{raw}` does not match entry directory `{identifier}`"
                    ),
                );
            }
            raw.clone()
        }
        _ => {
            if !is_valid_resource_name(identifier) {
                return EntryOutcome::Rejected(
                    code::INVALID_FRONTMATTER,
                    format!(
                        "agent file name `{identifier}` is not lowercase kebab-case within {MAX_NAME_LEN} characters"
                    ),
                );
            }
            if let Some(raw) = frontmatter.get("name") {
                if !raw.eq_ignore_ascii_case(identifier) {
                    return EntryOutcome::Rejected(
                        code::INVALID_FRONTMATTER,
                        format!(
                            "frontmatter name `{raw}` does not match agent file `{identifier}`"
                        ),
                    );
                }
            }
            identifier.to_owned()
        }
    };
    let description = frontmatter
        .get("description")
        .filter(|value| !value.trim().is_empty())
        .cloned();
    match description {
        Some(description) => EntryOutcome::Accepted { name, description },
        None => EntryOutcome::Rejected(
            code::INVALID_FRONTMATTER,
            "frontmatter description is required".into(),
        ),
    }
}

/// 同源根内重名条目整组记 duplicate_name 并丢弃，避免目录呈现无法定位的同名项。
/// （大小写或目录名折叠后的重复在候选名层面收敛，跨平台可测。）
fn dedupe_candidates(
    candidates: &mut Vec<Candidate>,
    diagnostics: &mut Vec<LocalResourceDiagnostic>,
) {
    let mut seen: BTreeSet<(i32, i32, String, String, String)> = BTreeSet::new();
    let mut duplicated: BTreeSet<(i32, i32, String, String)> = BTreeSet::new();
    for candidate in candidates.iter() {
        let key = (
            candidate.kind,
            candidate.scope,
            candidate.relative_dir.clone(),
            candidate.name.clone(),
            candidate.workspace_id.clone(),
        );
        if !seen.insert(key) {
            duplicated.insert((
                candidate.kind,
                candidate.scope,
                candidate.relative_dir.clone(),
                candidate.name.clone(),
            ));
        }
    }
    if duplicated.is_empty() {
        return;
    }
    candidates.retain(|candidate| {
        let drop = duplicated.contains(&(
            candidate.kind,
            candidate.scope,
            candidate.relative_dir.clone(),
            candidate.name.clone(),
        ));
        if drop {
            let path = if candidate.kind == KIND_SKILL {
                format!("{}/{}", candidate.name, SKILL_ENTRY)
            } else {
                format!("{}.md", candidate.name)
            };
            diagnostics.push(diagnostic(
                code::DUPLICATE_NAME,
                &format!(
                    "duplicate resource name `{}` within the same source root",
                    candidate.name
                ),
                &candidate.name,
                &path,
            ));
        }
        !drop
    });
}

/// 规范化 kinds 源根（`<nova>/skills` 或 `<nova>/agents`）用于扫描；缺目录返回 Ok(None)。
fn scan_source_root(
    nova_root: &Path,
    kind: i32,
) -> Result<Option<PathBuf>, LocalResourceDiagnostic> {
    let dir = if kind == KIND_SKILL {
        SKILLS_DIR
    } else {
        AGENTS_DIR
    };
    let source = nova_root.join(dir);
    match fs::symlink_metadata(&source) {
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(diagnostic(code::SCAN_ERROR, &io_reason(&error), "", dir)),
        Ok(metadata) if metadata.file_type().is_symlink() => Err(diagnostic(
            code::PATH_ESCAPE,
            "resource source root must be a real directory, not a symbolic link",
            "",
            dir,
        )),
        Ok(metadata) if !metadata.is_dir() => Err(diagnostic(
            code::SCAN_ERROR,
            "resource source root is not a directory",
            "",
            dir,
        )),
        Ok(_) => match fs::canonicalize(&source) {
            Ok(root) => Ok(Some(root)),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
            Err(error) if error.kind() == ErrorKind::PermissionDenied => Err(diagnostic(
                code::PERMISSION_DENIED,
                "resource source root is not readable",
                "",
                dir,
            )),
            Err(error) => Err(diagnostic(code::SCAN_ERROR, &io_reason(&error), "", dir)),
        },
    }
}

/// 读取入口的源根（缺目录 → NotFound，供快照读取的报错映射）。
fn read_source_root(nova_root: &Path, kind: i32) -> Result<PathBuf, ResourceError> {
    match scan_source_root(nova_root, kind) {
        Ok(Some(root)) => Ok(root),
        Ok(None) => Err(ResourceError::NotFound(
            "resource source root directory does not exist".into(),
        )),
        Err(item) => Err(match item.code.as_str() {
            code::PATH_ESCAPE => ResourceError::OutOfWorkspace(item.message),
            code::PERMISSION_DENIED => ResourceError::Permission(item.message),
            _ => ResourceError::Io(item.message),
        }),
    }
}

/// 项目层 `.nova` 的定位：已存在时经符号链接解析后不得逸出注册工作区根。
fn contained_layer_nova(workspace_root: &Path, nova: &Path) -> Result<PathBuf, String> {
    let canonical_workspace = fs::canonicalize(workspace_root)
        .map_err(|error| format!("workspace root is unavailable: {}", io_reason(&error)))?;
    match fs::canonicalize(nova) {
        Ok(resolved) => {
            if resolved.starts_with(&canonical_workspace) {
                Ok(resolved)
            } else {
                Err("project layer resolves outside the registered workspace".into())
            }
        }
        // 缺失：已存在的最近父环节点也不得逸出；深层缺失视为空目录。
        Err(_) => {
            let mut probe = nova.to_path_buf();
            loop {
                let Some(parent) = probe.parent() else {
                    return Ok(nova.to_path_buf());
                };
                match fs::canonicalize(parent) {
                    Ok(resolved) => {
                        return if resolved.starts_with(&canonical_workspace) {
                            Ok(nova.to_path_buf())
                        } else {
                            Err("project layer resolves outside the registered workspace".into())
                        };
                    }
                    Err(_) => probe = parent.to_path_buf(),
                }
            }
        }
    }
}

/// 解析并读取快照入口（只认直接子项；符号链接解析后不得逃出源根）。
fn load_entry_file(target: &ResourceTarget) -> Result<Vec<u8>, ResourceError> {
    let source_root = read_source_root(&target.nova_root, target.kind)?;
    let staged = if target.kind == KIND_SKILL {
        let child = source_root.join(&target.name);
        let metadata = fs::symlink_metadata(&child).map_err(|error| match error.kind() {
            ErrorKind::NotFound => ResourceError::NotFound("resource entry was not found".into()),
            ErrorKind::PermissionDenied => {
                ResourceError::Permission("resource entry is unreadable".into())
            }
            _ => ResourceError::Io(io_reason(&error)),
        })?;
        if metadata.file_type().is_symlink() {
            return Err(ResourceError::OutOfWorkspace(
                "skill entries must be direct child directories".into(),
            ));
        }
        if !metadata.is_dir() {
            return Err(ResourceError::NotFound(
                "resource entry was not found".into(),
            ));
        }
        child.join(&target.entry_file)
    } else {
        source_root.join(&target.entry_file)
    };
    let resolved = fs::canonicalize(&staged).map_err(|error| match error.kind() {
        ErrorKind::NotFound => ResourceError::NotFound("resource entry was not found".into()),
        ErrorKind::PermissionDenied => {
            ResourceError::Permission("resource entry is unreadable".into())
        }
        _ => ResourceError::Io(io_reason(&error)),
    })?;
    if !resolved.starts_with(&source_root) {
        return Err(ResourceError::OutOfWorkspace(
            "resource entry resolves outside its source root".into(),
        ));
    }
    let file_metadata =
        fs::metadata(&resolved).map_err(|error| ResourceError::Io(io_reason(&error)))?;
    if !file_metadata.is_file() {
        return Err(ResourceError::Invalid(
            "resource entry is not a file".into(),
        ));
    }
    match read_entry(&resolved) {
        ReadOutcome::Ok(bytes) => Ok(bytes),
        ReadOutcome::TooLarge => Err(ResourceError::TooLarge(format!(
            "resource entry exceeds the {} KiB limit",
            MAX_ENTRY_BYTES / 1024
        ))),
        ReadOutcome::Denied(message) => Err(ResourceError::Permission(message)),
        ReadOutcome::Failed(message) => Err(ResourceError::Io(message)),
    }
}

fn list_direct_children(root: &Path) -> Result<Vec<PathBuf>, LocalResourceDiagnostic> {
    let mut children: Vec<PathBuf> = Vec::new();
    match fs::read_dir(root) {
        Ok(entries) => {
            for entry in entries {
                match entry {
                    Ok(entry) => children.push(entry.path()),
                    Err(error) => {
                        return Err(diagnostic(code::SCAN_ERROR, &io_reason(&error), "", ""));
                    }
                }
            }
        }
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(children),
        Err(error) if error.kind() == ErrorKind::PermissionDenied => {
            return Err(diagnostic(
                code::PERMISSION_DENIED,
                "resource source root is not readable",
                "",
                "",
            ));
        }
        Err(error) => {
            return Err(diagnostic(code::SCAN_ERROR, &io_reason(&error), "", ""));
        }
    }
    children.sort();
    Ok(children)
}

enum ReadOutcome {
    Ok(Vec<u8>),
    TooLarge,
    Denied(String),
    Failed(String),
}

fn read_entry(path: &Path) -> ReadOutcome {
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::PermissionDenied => {
            return ReadOutcome::Denied("resource entry is not readable".into());
        }
        Err(error) => return ReadOutcome::Failed(io_reason(&error)),
    };
    let mut bytes = Vec::new();
    if file
        .by_ref()
        .take((MAX_ENTRY_BYTES as u64).saturating_add(1))
        .read_to_end(&mut bytes)
        .is_err()
    {
        return ReadOutcome::Failed("resource entry read failed".into());
    }
    if bytes.len() > MAX_ENTRY_BYTES {
        return ReadOutcome::TooLarge;
    }
    ReadOutcome::Ok(bytes)
}

/// 在源根链内逐级补建目录：已存在环节若是符号链接或文件即拒绝；
/// 新建环节仅限校验过的固定链（`skills/<name>` 或 `agents` 本身）。
fn ensure_fixed_chain(source_root: &Path, parent: &Path) -> Result<(), ResourceError> {
    let relative = parent.strip_prefix(source_root).map_err(|_| {
        ResourceError::OutOfWorkspace("write target is outside the source root".into())
    })?;
    if !source_root.exists() {
        fs::create_dir_all(source_root).map_err(|error| ResourceError::Io(io_reason(&error)))?;
    }
    let canonical_root =
        fs::canonicalize(source_root).map_err(|error| ResourceError::Io(io_reason(&error)))?;
    let mut current = canonical_root.clone();
    for component in relative.components() {
        let Component::Normal(part) = component else {
            return Err(ResourceError::Invalid(
                "write path segment is invalid".into(),
            ));
        };
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(ResourceError::OutOfWorkspace(
                        "resource write path passes through a symbolic link or file".into(),
                    ));
                }
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {
                fs::create_dir(&current).map_err(|error| ResourceError::Io(io_reason(&error)))?;
            }
            Err(error) => return Err(ResourceError::Io(io_reason(&error))),
        }
        let canonical =
            fs::canonicalize(&current).map_err(|error| ResourceError::Io(io_reason(&error)))?;
        if !canonical.starts_with(&canonical_root) || !canonical.is_dir() {
            return Err(ResourceError::OutOfWorkspace(
                "resource write path escapes its source root".into(),
            ));
        }
    }
    Ok(())
}

fn read_entry_bytes(path: &Path) -> Result<Vec<u8>, ResourceError> {
    match read_entry(path) {
        ReadOutcome::Ok(bytes) => Ok(bytes),
        ReadOutcome::TooLarge => Err(ResourceError::TooLarge(format!(
            "resource entry exceeds the {} KiB limit",
            MAX_ENTRY_BYTES / 1024
        ))),
        ReadOutcome::Denied(message) => Err(ResourceError::Permission(message)),
        ReadOutcome::Failed(message) => Err(ResourceError::Io(message)),
    }
}

/// 把扫描结果组装成 RunnerEnvelope 目录发布帧（自发发布 refresh_id 为空）。
pub fn published_frame(
    scan: CatalogScan,
    catalog_revision: u64,
    refresh_id: String,
) -> RunnerEnvelope {
    RunnerEnvelope {
        request_id: uuid::Uuid::new_v4().to_string(),
        payload: Some(Payload::ResourceCatalogPublished(
            ResourceCatalogPublished {
                catalog_revision,
                refresh_id,
                complete: scan.complete,
                entries: scan.entries,
                diagnostics: scan.diagnostics,
            },
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempTree {
        base: PathBuf,
        home: PathBuf,
        workspace: PathBuf,
    }

    impl TempTree {
        fn new(label: &str) -> Self {
            let base = std::env::temp_dir().join(format!(
                "nova-runner-resources-{label}-{}",
                uuid::Uuid::new_v4()
            ));
            fs::create_dir_all(&base).unwrap();
            let base = fs::canonicalize(&base).unwrap();
            let home = base.join("home");
            let workspace = base.join("workspace");
            fs::create_dir_all(&home).unwrap();
            fs::create_dir_all(&workspace).unwrap();
            Self {
                home: fs::canonicalize(&home).unwrap(),
                workspace: fs::canonicalize(&workspace).unwrap(),
                base,
            }
        }

        fn resources(&self) -> LocalResources {
            LocalResources::with_roots(
                Some(self.home.clone()),
                self.workspace.clone(),
                "ws-test".into(),
            )
        }

        fn write(&self, root: &Path, rel: &str, content: &str) -> PathBuf {
            let path = root.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, content).unwrap();
            path
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    #[cfg(windows)]
    fn make_symlink_dir(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_dir(target, link)
    }
    #[cfg(not(windows))]
    fn make_symlink_dir(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }
    #[cfg(windows)]
    fn make_symlink_file(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_file(target, link)
    }
    #[cfg(not(windows))]
    fn make_symlink_file(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    fn codes(diagnostics: &[LocalResourceDiagnostic]) -> Vec<&str> {
        diagnostics.iter().map(|item| item.code.as_str()).collect()
    }

    #[test]
    fn home_resolution_uses_os_user_directory() {
        // win32 上主目录来自 USERPROFILE（对应 Windows 用户目录），其余平台 HOME。
        let resolved = resolve_home_dir();
        #[cfg(windows)]
        let expected = std::env::var_os("USERPROFILE").map(PathBuf::from);
        #[cfg(not(windows))]
        let expected = std::env::var_os("HOME").map(PathBuf::from);
        if let (Some(actual), Some(expected)) = (resolved.as_ref(), expected.as_ref()) {
            if expected.is_dir() {
                assert_eq!(actual, expected);
            }
        }
        // 注入式路径构造保证技能根布局与平台无关（~ = 用户目录，含 Windows）。
        let tree = TempTree::new("home-layout");
        let skill = tree.write(
            &tree.home,
            ".nova/skills/win-path/SKILL.md",
            "---\nname: win-path\ndescription: home 根布局用例\n---\n正文\n",
        );
        assert!(skill.is_file());
        let scan = tree.resources().scan();
        let entry = scan
            .entries
            .iter()
            .find(|item| item.name == "win-path")
            .expect("global entry discovered under the injected home directory");
        assert_eq!(entry.scope, SCOPE_GLOBAL);
        assert!(entry.workspace_id.is_empty() && entry.relative_dir.is_empty());
    }

    #[test]
    fn missing_home_is_diagnosed_without_failing_the_scan() {
        let tree = TempTree::new("missing-home");
        tree.write(
            &tree.workspace,
            ".nova/skills/project-skill/SKILL.md",
            "---\nname: project-skill\ndescription: 项目层仍然可发现\n---\n",
        );
        let resources = LocalResources::with_roots(None, tree.workspace.clone(), "ws-test".into());
        let scan = resources.scan();
        assert!(!scan.complete);
        assert!(codes(&scan.diagnostics).contains(&code::MISSING_HOME));
        assert_eq!(scan.entries.len(), 1);
        assert_eq!(scan.entries[0].scope, SCOPE_PROJECT);
        // 全局读取在无主目录时明确报 Permission，不伪造可用。
        let read = resources.read_snapshot(&ReadResourceSnapshotRequest {
            kind: KIND_SKILL,
            scope: SCOPE_GLOBAL,
            name: "anything".into(),
            expected_sha256: "0".repeat(64),
            ..Default::default()
        });
        assert!(matches!(read, Err(ResourceError::Permission(_))));
    }

    #[test]
    fn kebab_case_names_are_validated() {
        assert!(is_valid_resource_name("abc"));
        assert!(is_valid_resource_name("a1-b2-c3"));
        assert!(is_valid_resource_name("spec"));
        assert!(!is_valid_resource_name(""));
        assert!(!is_valid_resource_name("Abc"));
        assert!(!is_valid_resource_name("abc-"));
        assert!(!is_valid_resource_name("-abc"));
        assert!(!is_valid_resource_name("a--b"));
        assert!(!is_valid_resource_name("a_b"));
        assert!(!is_valid_resource_name("中文名"));
        assert!(!is_valid_resource_name(&"a".repeat(65)));
        assert!(is_valid_resource_name(&"a".repeat(64)));
    }

    #[test]
    fn frontmatter_requires_block_and_top_level_scalars() {
        // 缺 frontmatter 块。
        assert!(parse_frontmatter(b"# just markdown\n").is_none());
        // 未闭合。
        assert!(parse_frontmatter(b"---\nname: a\n").is_none());
        // 嵌套结构冒充标量（缩进块）。
        assert!(parse_frontmatter(b"---\ndescription:\n  text: hidden\n---\n").is_none());
        // 列表项。
        assert!(parse_frontmatter(b"---\nname:\n  - a\n---\n").is_none());
        // 空标量。
        assert!(parse_frontmatter(b"---\ndescription:\n---\n").is_none());
        // 正常顶层标量 + 引号剥离 + 额外键忽略。
        let parsed = parse_frontmatter(
            b"---\nname: \"a-b\"\ndescription: 'say hi'\nmodelId: x\n---\nbody\n",
        )
        .unwrap();
        assert_eq!(parsed.get("name").map(String::as_str), Some("a-b"));
        assert_eq!(
            parsed.get("description").map(String::as_str),
            Some("say hi")
        );
        // CRLF 与 BOM。
        let parsed =
            parse_frontmatter("\u{feff}---\r\nname: a\r\ndescription: b\r\n---\r\n".as_bytes())
                .unwrap();
        assert_eq!(parsed.get("name").map(String::as_str), Some("a"));
    }

    #[test]
    fn invalid_frontmatter_entries_are_skipped_but_scan_continues() {
        let tree = TempTree::new("frontmatter");
        // 缺 description。
        tree.write(
            &tree.home,
            ".nova/skills/no-desc/SKILL.md",
            "---\nname: no-desc\n---\n",
        );
        // name 与目录不一致。
        tree.write(
            &tree.home,
            ".nova/skills/mismatch/SKILL.md",
            "---\nname: other\ndescription: ok\n---\n",
        );
        // name 非法字符。
        tree.write(
            &tree.home,
            ".nova/skills/bad-name/SKILL.md",
            "---\nname: Bad Name\ndescription: ok\n---\n",
        );
        // 合法条目不受影响。
        tree.write(
            &tree.home,
            ".nova/skills/good/SKILL.md",
            "---\nname: good\ndescription: fine\n---\n",
        );
        let scan = tree.resources().scan();
        assert_eq!(
            scan.entries.len(),
            1,
            "only the valid entry survives: {:?}",
            scan.entries
        );
        assert_eq!(scan.entries[0].name, "good");
        assert_eq!(
            codes(&scan.diagnostics)
                .iter()
                .filter(|item| **item == code::INVALID_FRONTMATTER)
                .count(),
            3
        );
        // 单条目数据问题不标不完整。
        assert!(scan.complete);
    }

    #[test]
    fn agents_take_name_from_file_and_need_description() {
        let tree = TempTree::new("agents");
        tree.write(
            &tree.home,
            ".nova/agents/reviewer.md",
            "---\ndescription: 审查\n---\n正文\n",
        );
        tree.write(
            &tree.home,
            ".nova/agents/no-desc.md",
            "---\nmodelId: m1\n---\n",
        );
        tree.write(
            &tree.home,
            ".nova/agents/Bad-Case.md",
            "---\ndescription: ok\n---\n",
        );
        tree.write(&tree.home, ".nova/agents/notes.txt", "ignored");
        let scan = tree.resources().scan();
        assert_eq!(scan.entries.len(), 1);
        assert_eq!(scan.entries[0].name, "reviewer");
        assert_eq!(scan.entries[0].kind, KIND_AGENT);
        assert_eq!(scan.entries[0].description, "审查");
        let mut rejects = scan
            .diagnostics
            .iter()
            .filter(|item| item.code == code::INVALID_FRONTMATTER)
            .map(|item| item.name.as_str())
            .collect::<Vec<_>>();
        rejects.sort_unstable();
        assert_eq!(rejects, ["Bad-Case", "no-desc"]);
    }

    #[test]
    fn duplicate_names_within_one_source_root_are_dropped_with_diagnostic() {
        let candidate = |name: &str, description: &str| Candidate {
            kind: KIND_SKILL,
            scope: SCOPE_GLOBAL,
            workspace_id: String::new(),
            relative_dir: String::new(),
            name: name.into(),
            description: description.into(),
            sha256: "a".repeat(64),
            size_bytes: 1,
        };
        let mut candidates = vec![
            candidate("same", "one"),
            candidate("same", "two"),
            candidate("unique", "keep"),
        ];
        let mut diagnostics = Vec::new();
        dedupe_candidates(&mut candidates, &mut diagnostics);
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].name, "unique");
        assert_eq!(diagnostics.len(), 2);
        assert!(
            diagnostics
                .iter()
                .all(|item| item.code == code::DUPLICATE_NAME)
        );
        assert!(diagnostics.iter().all(|item| item.path == "same/SKILL.md"));
    }

    #[test]
    fn oversized_entry_and_entry_cap_mark_truncation() {
        let tree = TempTree::new("limits");
        // 超过 256 KiB 的入口 → file_too_large 诊断并跳过。
        let mut big = "---\nname: big\ndescription: ok\n---\n".to_string();
        big.push_str(&"x".repeat(MAX_ENTRY_BYTES));
        tree.write(&tree.home, ".nova/skills/big/SKILL.md", &big);
        let scan = tree.resources().scan();
        assert!(codes(&scan.diagnostics).contains(&code::FILE_TOO_LARGE));
        assert!(scan.entries.iter().all(|item| item.name != "big"));
        assert!(
            scan.complete,
            "oversized entry alone does not invalidate the catalog"
        );
    }

    #[test]
    fn entry_cap_produces_truncated_incomplete_catalog() {
        let tree = TempTree::new("cap");
        let skills = tree.home.join(".nova/skills");
        fs::create_dir_all(&skills).unwrap();
        for index in 0..(MAX_ENTRIES + 8) {
            let dir = skills.join(format!("skill-{index:04}"));
            fs::create_dir_all(&dir).unwrap();
            fs::write(
                dir.join("SKILL.md"),
                format!("---\nname: skill-{index:04}\ndescription: cap\n---\n"),
            )
            .unwrap();
        }
        let scan = tree.resources().scan();
        assert!(!scan.complete);
        assert!(codes(&scan.diagnostics).contains(&code::TRUNCATED));
        assert!(!scan.entries.is_empty());
        assert!(scan.entries.len() <= MAX_ENTRIES);
    }

    #[test]
    fn symlink_escapes_are_rejected() {
        let tree = TempTree::new("symlink");
        let outside = tree.base.join("secret-outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(
            outside.join("SKILL.md"),
            "---\nname: sneaky\ndescription: escapes\n---\n",
        )
        .unwrap();
        let skills = tree.home.join(".nova/skills");
        fs::create_dir_all(skills.join("good")).unwrap();
        fs::write(
            skills.join("good/SKILL.md"),
            "---\nname: good\ndescription: ok\n---\n",
        )
        .unwrap();
        let linked = skills.join("sneaky");
        match make_symlink_dir(&outside, &linked) {
            Ok(()) => {
                let scan = tree.resources().scan();
                assert!(
                    codes(&scan.diagnostics).contains(&code::PATH_ESCAPE),
                    "symlinked skill dir must produce path_escape: {:?}",
                    scan.diagnostics
                );
                assert!(scan.entries.iter().all(|item| item.name != "sneaky"));
                assert!(scan.entries.iter().any(|item| item.name == "good"));
                // 快照读取同样拒绝该目标。
                let error = tree
                    .resources()
                    .read_snapshot(&ReadResourceSnapshotRequest {
                        kind: KIND_SKILL,
                        scope: SCOPE_GLOBAL,
                        name: "sneaky".into(),
                        expected_sha256: "0".repeat(64),
                        ..Default::default()
                    })
                    .expect_err("symlinked entry must not be readable");
                assert!(matches!(error, ResourceError::OutOfWorkspace(_)));
            }
            Err(error) => {
                // Windows 未开启开发者模式时可能无法创建符号链接；此处显式跳过
                // FS 级断言，非符号链接的越界定位仍由下面的 relative_dir 用例覆盖。
                eprintln!("symlink creation unsupported on this machine: {error}");
            }
        }
        // 目录逸出的 relative_dir 与非法定位。
        let escape = tree
            .resources()
            .read_snapshot(&ReadResourceSnapshotRequest {
                kind: KIND_SKILL,
                scope: SCOPE_PROJECT,
                workspace_id: "ws-test".into(),
                relative_dir: "../outside".into(),
                name: "good".into(),
                expected_sha256: "0".repeat(64),
                ..Default::default()
            });
        assert!(
            matches!(escape, Err(ResourceError::Invalid(_))),
            "{escape:?}"
        );
    }

    #[test]
    fn snapshot_read_requires_digest_and_conflict_reports_current() {
        let tree = TempTree::new("snapshot");
        let content = "---\nname: snap\ndescription: ok\n---\nhello\n";
        tree.write(&tree.home, ".nova/skills/snap/SKILL.md", content);
        let current = hex::encode(Sha256::digest(content.as_bytes()));
        // 缺 expected_sha256 → Invalid。
        let missing = tree
            .resources()
            .read_snapshot(&ReadResourceSnapshotRequest {
                kind: KIND_SKILL,
                scope: SCOPE_GLOBAL,
                name: "snap".into(),
                ..Default::default()
            });
        assert!(matches!(missing, Err(ResourceError::Invalid(_))));
        // 摘要不符 → CONFLICT，消息含当前摘要十六进制，不返回内容。
        let mismatch = tree
            .resources()
            .read_snapshot(&ReadResourceSnapshotRequest {
                kind: KIND_SKILL,
                scope: SCOPE_GLOBAL,
                name: "snap".into(),
                expected_sha256: "f".repeat(64),
                ..Default::default()
            });
        let Err(ResourceError::Conflict(message)) = mismatch else {
            panic!("expected conflict, got {mismatch:?}");
        };
        assert!(
            message.contains(&current),
            "conflict must carry current digest: {message}"
        );
        // 摘要匹配 → 返回内容 + 摘要 + 大小。
        let ok = tree
            .resources()
            .read_snapshot(&ReadResourceSnapshotRequest {
                kind: KIND_SKILL,
                scope: SCOPE_GLOBAL,
                name: "snap".into(),
                expected_sha256: current.clone(),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(ok.contents, content.as_bytes());
        assert_eq!(ok.sha256, current);
        assert_eq!(ok.size_bytes, content.len() as u64);
    }

    #[test]
    fn snapshot_read_validates_identity_and_relative_path() {
        let tree = TempTree::new("snapshot-identity");
        tree.write(
            &tree.workspace,
            ".nova/agents/helper.md",
            "---\ndescription: ok\n---\n",
        );
        let resources = tree.resources();
        // agent 入口路径推导为 <name>.md，传入不一致即拒绝。
        let wrong_path = resources.read_snapshot(&ReadResourceSnapshotRequest {
            kind: KIND_AGENT,
            scope: SCOPE_PROJECT,
            workspace_id: "ws-test".into(),
            name: "helper".into(),
            relative_path: "SKILL.md".into(),
            expected_sha256: "0".repeat(64),
            ..Default::default()
        });
        assert!(matches!(wrong_path, Err(ResourceError::Invalid(_))));
        // 传入一致的入口路径则可用。
        let content = "---\ndescription: ok\n---\n";
        let ok = resources.read_snapshot(&ReadResourceSnapshotRequest {
            kind: KIND_AGENT,
            scope: SCOPE_PROJECT,
            workspace_id: "ws-test".into(),
            name: "helper".into(),
            relative_path: "helper.md".into(),
            expected_sha256: hex::encode(Sha256::digest(content.as_bytes())),
            ..Default::default()
        });
        assert!(ok.is_ok());
        // 未注册 workspace → OutOfWorkspace。
        let wrong_ws = resources.read_snapshot(&ReadResourceSnapshotRequest {
            kind: KIND_AGENT,
            scope: SCOPE_PROJECT,
            workspace_id: "elsewhere".into(),
            name: "helper".into(),
            expected_sha256: "0".repeat(64),
            ..Default::default()
        });
        assert!(matches!(wrong_ws, Err(ResourceError::OutOfWorkspace(_))));
        // global 带 workspace / relative_dir → Invalid。
        let wrong_global = resources.read_snapshot(&ReadResourceSnapshotRequest {
            kind: KIND_AGENT,
            scope: SCOPE_GLOBAL,
            workspace_id: "ws-test".into(),
            name: "helper".into(),
            expected_sha256: "0".repeat(64),
            ..Default::default()
        });
        assert!(matches!(wrong_global, Err(ResourceError::Invalid(_))));
        // 非法名 / 非法 scope / kind。
        for request in [
            ReadResourceSnapshotRequest {
                kind: KIND_SKILL,
                scope: SCOPE_GLOBAL,
                name: "Bad/../Name".into(),
                expected_sha256: "0".repeat(64),
                ..Default::default()
            },
            ReadResourceSnapshotRequest {
                kind: KIND_SKILL,
                scope: SCOPE_UNSPECIFIED,
                name: "helper".into(),
                expected_sha256: "0".repeat(64),
                ..Default::default()
            },
            ReadResourceSnapshotRequest {
                kind: KIND_UNSPECIFIED,
                scope: SCOPE_GLOBAL,
                name: "helper".into(),
                expected_sha256: "0".repeat(64),
                ..Default::default()
            },
        ] {
            assert!(
                matches!(
                    resources.read_snapshot(&request),
                    Err(ResourceError::Invalid(_))
                ),
                "{request:?}"
            );
        }
        // 源根缺失（目录未创建）→ NotFound，不是伪造空内容。
        let none = resources.read_snapshot(&ReadResourceSnapshotRequest {
            kind: KIND_SKILL,
            scope: SCOPE_GLOBAL,
            name: "anything".into(),
            expected_sha256: "0".repeat(64),
            ..Default::default()
        });
        assert!(matches!(none, Err(ResourceError::NotFound(_))));
    }

    #[test]
    fn scan_covers_project_layers_and_refresh_targets() {
        let tree = TempTree::new("layers");
        tree.write(
            &tree.workspace,
            ".nova/skills/root-skill/SKILL.md",
            "---\nname: root-skill\ndescription: 根层\n---\n",
        );
        tree.write(
            &tree.workspace,
            "sub/app/.nova/skills/sub-skill/SKILL.md",
            "---\nname: sub-skill\ndescription: 子项目层\n---\n",
        );
        let mut resources = tree.resources();
        // 启动默认只扫全局 + 根项目层，子目录不递归发现。
        let initial = resources.scan();
        assert!(initial.entries.iter().any(|item| item.name == "root-skill"));
        assert!(!initial.entries.iter().any(|item| item.name == "sub-skill"));
        // 定向刷新 canonicalCwd 子目录后单独发现该层。
        resources
            .apply_refresh(&RefreshResourceCatalog {
                refresh_id: "r-1".into(),
                scope: SCOPE_PROJECT,
                workspace_id: "ws-test".into(),
                relative_dir: "sub/app".into(),
            })
            .unwrap();
        let after = resources.scan();
        let entry = after
            .entries
            .iter()
            .find(|item| item.name == "sub-skill")
            .expect("sub project layer discovered after targeted refresh");
        assert_eq!(entry.relative_dir, "sub/app");
        assert_eq!(entry.workspace_id, "ws-test");
        let root_entry = after
            .entries
            .iter()
            .find(|item| item.name == "root-skill")
            .unwrap();
        assert_eq!(root_entry.relative_dir, ".");
        // 非法定位：目录逸出、未注册 workspace、global 带 workspace。
        assert!(
            resources
                .apply_refresh(&RefreshResourceCatalog {
                    refresh_id: "r-2".into(),
                    scope: SCOPE_PROJECT,
                    workspace_id: "ws-test".into(),
                    relative_dir: "../outside".into(),
                })
                .is_err()
        );
        assert!(
            resources
                .apply_refresh(&RefreshResourceCatalog {
                    refresh_id: "r-3".into(),
                    scope: SCOPE_PROJECT,
                    workspace_id: "elsewhere".into(),
                    relative_dir: ".".into(),
                })
                .is_err()
        );
        assert!(
            resources
                .apply_refresh(&RefreshResourceCatalog {
                    refresh_id: "r-4".into(),
                    scope: SCOPE_GLOBAL,
                    workspace_id: "ws-test".into(),
                    ..Default::default()
                })
                .is_err()
        );
        // global 定向刷新合法（不新增层，仅触发重扫）。
        resources
            .apply_refresh(&RefreshResourceCatalog {
                refresh_id: "r-5".into(),
                scope: SCOPE_GLOBAL,
                ..Default::default()
            })
            .unwrap();
    }

    #[test]
    fn relative_dir_normalization_rules() {
        assert_eq!(normalize_relative_dir(".").as_deref(), Some("."));
        assert_eq!(
            normalize_relative_dir("sub/app").as_deref(),
            Some("sub/app")
        );
        assert_eq!(
            normalize_relative_dir("sub\\app").as_deref(),
            Some("sub/app")
        );
        assert_eq!(normalize_relative_dir("./sub"), None);
        assert_eq!(normalize_relative_dir(".."), None);
        assert_eq!(normalize_relative_dir("sub/../app"), None);
        assert_eq!(normalize_relative_dir(""), None);
        assert_eq!(normalize_relative_dir("/abs"), None);
        assert_eq!(normalize_relative_dir("nul\0"), None);
        // 盘符（Windows 绝对路径）必须被拒绝。
        assert_eq!(normalize_relative_dir("C:/windows"), None);
    }

    #[test]
    fn write_resource_creates_updates_and_enforces_cas() {
        let tree = TempTree::new("write");
        let mut resources = tree.resources();
        let content = "---\nname: created\ndescription: 新技能\n---\n正文\n";
        // 空 expected = 仅创建。
        let created = resources
            .write_resource(&WriteResourceFileRequest {
                kind: KIND_SKILL,
                scope: SCOPE_GLOBAL,
                name: "created".into(),
                contents: content.as_bytes().to_vec(),
                ..Default::default()
            })
            .unwrap();
        let digest = hex::encode(Sha256::digest(content.as_bytes()));
        assert_eq!(created.sha256, digest);
        assert_eq!(created.size_bytes, content.len() as u64);
        assert!(created.created);
        assert!(tree.home.join(".nova/skills/created/SKILL.md").is_file());
        // 再创建（expected 为空）→ EXISTS，且原内容未被覆盖。
        let again = resources.write_resource(&WriteResourceFileRequest {
            kind: KIND_SKILL,
            scope: SCOPE_GLOBAL,
            name: "created".into(),
            contents: content.as_bytes().to_vec(),
            ..Default::default()
        });
        assert!(matches!(again, Err(ResourceError::Exists(_))));
        // CAS：摘要不符 → CONFLICT 且消息含当前摘要。
        let updated = "---\nname: created\ndescription: 改后\n---\n新正文\n";
        let conflict = resources.write_resource(&WriteResourceFileRequest {
            kind: KIND_SKILL,
            scope: SCOPE_GLOBAL,
            name: "created".into(),
            contents: updated.as_bytes().to_vec(),
            expected_sha256: "a".repeat(64),
            ..Default::default()
        });
        let Err(ResourceError::Conflict(message)) = conflict else {
            panic!("expected CAS conflict: {conflict:?}");
        };
        assert!(message.contains(&digest));
        // CAS：摘要相符 → 更新成功，created=false。
        let replaced = resources
            .write_resource(&WriteResourceFileRequest {
                kind: KIND_SKILL,
                scope: SCOPE_GLOBAL,
                name: "created".into(),
                contents: updated.as_bytes().to_vec(),
                expected_sha256: digest.clone(),
                ..Default::default()
            })
            .unwrap();
        assert!(!replaced.created);
        assert_eq!(
            replaced.sha256,
            hex::encode(Sha256::digest(updated.as_bytes()))
        );
        // 项目层写入（含补建目录链）与 agent 写入。
        resources
            .write_resource(&WriteResourceFileRequest {
                kind: KIND_SKILL,
                scope: SCOPE_PROJECT,
                workspace_id: "ws-test".into(),
                relative_dir: "sub/app".into(),
                name: "project-write".into(),
                contents: b"---\nname: project-write\ndescription: ok\n---\n".to_vec(),
                ..Default::default()
            })
            .unwrap();
        assert!(
            tree.workspace
                .join("sub/app/.nova/skills/project-write/SKILL.md")
                .is_file()
        );
        resources
            .write_resource(&WriteResourceFileRequest {
                kind: KIND_AGENT,
                scope: SCOPE_GLOBAL,
                name: "reviewer".into(),
                contents: "---\ndescription: 审查者\n---\n".as_bytes().to_vec(),
                ..Default::default()
            })
            .unwrap();
        assert!(tree.home.join(".nova/agents/reviewer.md").is_file());
        // 更新不存在的目标且给了 expected → CONFLICT。
        let ghost = resources.write_resource(&WriteResourceFileRequest {
            kind: KIND_AGENT,
            scope: SCOPE_GLOBAL,
            name: "ghost".into(),
            contents: b"x".to_vec(),
            expected_sha256: "b".repeat(64),
            ..Default::default()
        });
        assert!(matches!(ghost, Err(ResourceError::Conflict(_))));
        // 写入后重新扫描：全局条目立即可发现（global 层始终扫描）。
        let scan = tree.resources().scan();
        assert!(scan.entries.iter().any(|item| item.name == "created"));
        assert!(scan.entries.iter().any(|item| item.name == "reviewer"));
        // 新写入的项目层条目需先定向刷新登记该层（P0-G3 流程：写入→刷新→发现）。
        resources
            .apply_refresh(&RefreshResourceCatalog {
                refresh_id: "after-write".into(),
                scope: SCOPE_PROJECT,
                workspace_id: "ws-test".into(),
                relative_dir: "sub/app".into(),
            })
            .unwrap();
        let scan = resources.scan();
        assert!(scan.entries.iter().any(|item| item.name == "project-write"));
    }

    #[test]
    fn write_resource_rejects_invalid_names_and_oversize() {
        let tree = TempTree::new("write-guard");
        let resources = tree.resources();
        // 非法名（目录/遍历字符、大写、连字符规则、超长）。
        for name in ["../evil", "Bad", "a--b", &"x".repeat(65)] {
            let result = resources.write_resource(&WriteResourceFileRequest {
                kind: KIND_SKILL,
                scope: SCOPE_GLOBAL,
                name: name.into(),
                contents: b"---\nname: x\ndescription: y\n---\n".to_vec(),
                ..Default::default()
            });
            assert!(
                matches!(result, Err(ResourceError::Invalid(_))),
                "name {name:?} must be rejected: {result:?}"
            );
        }
        // 非法 relative_path（非入口路径 / 遍历）。
        for path in [
            "references/extra.md",
            "references/../outside.md",
            "./SKILL.md",
        ] {
            let wrong = resources.write_resource(&WriteResourceFileRequest {
                kind: KIND_SKILL,
                scope: SCOPE_GLOBAL,
                name: "ok-name".into(),
                relative_path: path.into(),
                contents: b"x".to_vec(),
                ..Default::default()
            });
            assert!(
                matches!(wrong, Err(ResourceError::Invalid(_))),
                "relative_path {path:?} must be rejected"
            );
        }
        // 超过入口大小上限。
        let big = resources.write_resource(&WriteResourceFileRequest {
            kind: KIND_SKILL,
            scope: SCOPE_GLOBAL,
            name: "ok-name".into(),
            contents: vec![b'x'; MAX_ENTRY_BYTES + 1],
            ..Default::default()
        });
        assert!(matches!(big, Err(ResourceError::TooLarge(_))));
    }

    #[test]
    fn write_resource_refuses_to_follow_symlinked_entries() {
        let tree = TempTree::new("write-symlink");
        let resources = tree.resources();
        let real = tree.write(
            &tree.home,
            ".nova/skills/witness/SKILL.md",
            "---\nname: witness\ndescription: ok\n---\n",
        );
        let victim = tree.base.join("victim.md");
        fs::write(&victim, "keep-me\n").unwrap();
        // 把入口替换为指向源根外的符号链接后，CAS 写入必须被拒绝且不动目标外文件。
        let digest = hex::encode(Sha256::digest(fs::read(&real).unwrap()));
        fs::remove_file(&real).unwrap();
        match make_symlink_file(&victim, &real) {
            Ok(()) => {
                let result = resources.write_resource(&WriteResourceFileRequest {
                    kind: KIND_SKILL,
                    scope: SCOPE_GLOBAL,
                    name: "witness".into(),
                    contents: b"---\nname: witness\ndescription: ok\n---\n".to_vec(),
                    expected_sha256: digest,
                    ..Default::default()
                });
                assert!(
                    matches!(result, Err(ResourceError::OutOfWorkspace(_))),
                    "symlinked entry must be rejected: {result:?}"
                );
                assert_eq!(fs::read_to_string(&victim).unwrap(), "keep-me\n");
            }
            Err(error) => eprintln!("symlink creation unsupported on this machine: {error}"),
        }
    }

    #[test]
    fn published_frame_carries_revision_and_refresh_id() {
        let tree = TempTree::new("frame");
        tree.write(
            &tree.home,
            ".nova/skills/frame/SKILL.md",
            "---\nname: frame\ndescription: ok\n---\n",
        );
        let scan = tree.resources().scan();
        let frame = published_frame(scan, 7, "refresh-9".into());
        let Some(Payload::ResourceCatalogPublished(payload)) = frame.payload else {
            panic!("expected catalog publish payload");
        };
        assert_eq!(payload.catalog_revision, 7);
        assert_eq!(payload.refresh_id, "refresh-9");
        assert!(payload.complete);
        assert_eq!(payload.entries.len(), 1);
        // 发布内容绝不携带绝对路径或盘符。
        for entry in &payload.entries {
            assert!(!entry.relative_dir.contains(':') && !entry.relative_dir.contains('\\'));
        }
        for item in &payload.diagnostics {
            assert!(
                !item.path.contains(':'),
                "diagnostic path leaked: {}",
                item.path
            );
        }
    }

    #[test]
    fn revision_counter_increments_per_publish() {
        let tree = TempTree::new("revision");
        let mut resources = tree.resources();
        assert_eq!(resources.revision(), 0);
        assert_eq!(resources.next_revision(), 1);
        assert_eq!(resources.next_revision(), 2);
        assert_eq!(resources.revision(), 2);
    }
}
