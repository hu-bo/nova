//! File operations. Runner-side implementation of docs/agent-core.md §3.4's `FileSystem`
//! surface, exposed over the wire as `ReadFile` / `WriteFile` / `FileOp` (proto.md §4.2).
//! All paths are resolved through `Workspace::resolve` first — this module never touches a
//! path the caller handed it directly.

use std::path::Path;
use std::time::UNIX_EPOCH;

use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use crate::error::RunnerError;
use crate::pb::execution::{DirEntry, FileInfo, FileKind};

use super::Workspace;

fn file_kind(file_type: std::fs::FileType) -> FileKind {
    if file_type.is_symlink() {
        FileKind::Symlink
    } else if file_type.is_dir() {
        FileKind::Dir
    } else {
        FileKind::File
    }
}

pub fn stat(workspace: &Workspace, path: &str) -> Result<FileInfo, RunnerError> {
    let resolved = workspace.resolve(path)?;
    let metadata = std::fs::metadata(&resolved).map_err(RunnerError::from)?;
    Ok(FileInfo {
        path: workspace.relative_string(&resolved),
        kind: file_kind(metadata.file_type()) as i32,
        size: metadata.len(),
        mtime: metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0),
    })
}

/// `depth` is the number of directory levels to recurse; 0 is treated as 1 (a single,
/// non-recursive listing) — tools.md §3 documents 1 as the effective default, and an
/// unbounded `0 = infinite` reading would be a footgun for a "list_dir" tool.
pub fn list(workspace: &Workspace, path: &str, depth: u32) -> Result<Vec<DirEntry>, RunnerError> {
    let resolved = workspace.resolve(path)?;
    let depth = if depth == 0 { 1 } else { depth };
    let mut out = Vec::new();
    walk(&resolved, &resolved, depth, &mut out)?;
    Ok(out)
}

fn walk(
    root: &Path,
    dir: &Path,
    depth_remaining: u32,
    out: &mut Vec<DirEntry>,
) -> Result<(), RunnerError> {
    let entries = std::fs::read_dir(dir).map_err(RunnerError::from)?;
    for entry in entries {
        let entry = entry.map_err(RunnerError::from)?;
        let file_type = entry.file_type().map_err(RunnerError::from)?;
        let path = entry.path();
        let relative = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        out.push(DirEntry {
            name: relative,
            kind: file_kind(file_type) as i32,
        });
        if file_type.is_dir() && depth_remaining > 1 {
            walk(root, &path, depth_remaining - 1, out)?;
        }
    }
    Ok(())
}

pub fn remove(workspace: &Workspace, path: &str, recursive: bool) -> Result<(), RunnerError> {
    let resolved = workspace.resolve(path)?;
    let metadata = std::fs::symlink_metadata(&resolved).map_err(RunnerError::from)?;
    if metadata.is_dir() {
        if recursive {
            std::fs::remove_dir_all(&resolved).map_err(RunnerError::from)
        } else {
            std::fs::remove_dir(&resolved).map_err(RunnerError::from)
        }
    } else {
        std::fs::remove_file(&resolved).map_err(RunnerError::from)
    }
}

pub fn rename(workspace: &Workspace, from: &str, to: &str) -> Result<(), RunnerError> {
    // `to` commonly doesn't exist yet — resolve() already handles non-existent leaves.
    let from = workspace.resolve(from)?;
    let to = workspace.resolve(to)?;
    std::fs::rename(&from, &to).map_err(RunnerError::from)
}

pub fn mkdir(workspace: &Workspace, path: &str) -> Result<(), RunnerError> {
    let resolved = workspace.resolve(path)?;
    std::fs::create_dir_all(&resolved).map_err(RunnerError::from)
}

/// Temp directories must live inside the workspace root — anything returned here later goes
/// back through `write()`/`read()` calls, which are workspace-scoped and would reject a path
/// outside it.
pub fn temp_dir(workspace: &Workspace, prefix: &str) -> Result<String, RunnerError> {
    let base = workspace.root().join(".nova-tmp");
    std::fs::create_dir_all(&base).map_err(RunnerError::from)?;
    let prefix = if prefix.is_empty() { "nova" } else { prefix };
    let dir = tempfile::Builder::new()
        .prefix(prefix)
        .tempdir_in(&base)
        .map_err(RunnerError::from)?
        .keep();
    Ok(workspace.relative_string(&dir))
}

/// Byte-range read for the `ReadFile` RPC. `limit == 0` means "to EOF". Returns the slice
/// plus the file's total size (informational, for `FileChunk.total_size`).
pub async fn read_range(
    workspace: &Workspace,
    path: &str,
    offset: u64,
    limit: u64,
) -> Result<(Vec<u8>, u64), RunnerError> {
    let resolved = workspace.resolve(path)?;
    let mut file = File::open(&resolved).await.map_err(RunnerError::from)?;
    let total_size = file.metadata().await.map_err(RunnerError::from)?.len();
    if offset > total_size {
        return Ok((Vec::new(), total_size));
    }
    file.seek(std::io::SeekFrom::Start(offset))
        .await
        .map_err(RunnerError::from)?;
    let want = if limit == 0 {
        total_size - offset
    } else {
        limit.min(total_size - offset)
    };
    let mut buf = vec![0u8; want as usize];
    file.read_exact(&mut buf).await.map_err(RunnerError::from)?;
    Ok((buf, total_size))
}

pub struct WriteHandle {
    file: File,
    pub created: bool,
    pub bytes_written: u64,
}

impl WriteHandle {
    pub async fn open(
        workspace: &Workspace,
        path: &str,
        append: bool,
    ) -> Result<Self, RunnerError> {
        let resolved = workspace.resolve(path)?;
        if let Some(parent) = resolved.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(RunnerError::from)?;
        }
        let created = tokio::fs::symlink_metadata(&resolved).await.is_err();
        let file = tokio::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(append)
            .truncate(!append)
            .open(&resolved)
            .await
            .map_err(RunnerError::from)?;
        Ok(Self {
            file,
            created,
            bytes_written: 0,
        })
    }

    pub async fn write_chunk(&mut self, data: &[u8]) -> Result<(), RunnerError> {
        self.file.write_all(data).await.map_err(RunnerError::from)?;
        self.bytes_written += data.len() as u64;
        Ok(())
    }
}
