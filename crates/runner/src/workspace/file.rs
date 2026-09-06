//! File operations. Runner-side implementation of docs/agent-core.md §3.4's `FileSystem`
//! surface, exposed over the wire as `ReadFile` / `WriteFile` / `FileOp` (proto.md §4.2).
//! All paths are resolved through `Workspace` first — this module never touches a path the
//! caller handed it directly. Destructive operations preserve the final symlink entry.

use std::fs::File as StdFile;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;
use std::time::UNIX_EPOCH;

use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use crate::error::RunnerError;
use crate::pb::execution::{DirEntry, FileInfo, FileKind, ReadTextResult};

use super::Workspace;

const DEFAULT_TEXT_LINES: u32 = 200;
const MAX_TEXT_LINES: u32 = 2_000;
const DEFAULT_TEXT_BYTES: u32 = 256 * 1024;
const MAX_TEXT_BYTES: u32 = 1024 * 1024;
const TEXT_PROBE_BYTES: usize = 8 * 1024;
const MAX_LIST_DEPTH: u32 = 8;
const MAX_LIST_ENTRIES: usize = 10_000;

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
    if depth > MAX_LIST_DEPTH {
        return Err(RunnerError::invalid(format!(
            "directory depth {depth} exceeds the maximum {MAX_LIST_DEPTH}"
        )));
    }
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
    let mut entries = std::fs::read_dir(dir)
        .map_err(RunnerError::from)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(RunnerError::from)?;
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for entry in entries {
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
        if out.len() > MAX_LIST_ENTRIES {
            return Err(RunnerError::new(
                crate::pb::common::ErrorCode::TooLarge,
                format!("directory listing exceeds {MAX_LIST_ENTRIES} entries"),
            ));
        }
        if file_type.is_dir() && depth_remaining > 1 {
            walk(root, &path, depth_remaining - 1, out)?;
        }
    }
    Ok(())
}

pub fn remove(workspace: &Workspace, path: &str, recursive: bool) -> Result<(), RunnerError> {
    let resolved = workspace.resolve_entry(path)?;
    if resolved == workspace.root() {
        return Err(RunnerError::invalid("workspace root cannot be removed"));
    }
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
    let from = workspace.resolve_entry(from)?;
    let to = workspace.resolve_entry(to)?;
    if from == workspace.root() {
        return Err(RunnerError::invalid("workspace root cannot be renamed"));
    }
    if std::fs::symlink_metadata(&to).is_ok() {
        return Err(RunnerError::new(
            crate::pb::common::ErrorCode::Exists,
            format!("rename destination {to:?} already exists"),
        ));
    }
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

/// Reads a bounded UTF-8 line window without loading or transferring the whole file.
/// `total_lines` stays unknown unless this request naturally reaches EOF; computing it by
/// scanning the remainder would defeat the purpose of a small window into a large file.
pub fn read_text(
    workspace: &Workspace,
    path: &str,
    offset: u64,
    limit: u32,
    max_bytes: u32,
) -> Result<ReadTextResult, RunnerError> {
    let start_line = offset.max(1);
    let limit = bounded_value(limit, DEFAULT_TEXT_LINES, MAX_TEXT_LINES, "line limit")?;
    let max_bytes = bounded_value(
        max_bytes,
        DEFAULT_TEXT_BYTES,
        MAX_TEXT_BYTES,
        "text byte limit",
    )? as usize;
    let resolved = workspace.resolve(path)?;
    let mut file = StdFile::open(&resolved).map_err(RunnerError::from)?;
    let total_size = file.metadata().map_err(RunnerError::from)?.len();
    ensure_text_prefix(&mut file)?;
    file.seek(SeekFrom::Start(0)).map_err(RunnerError::from)?;

    let mut reader = BufReader::new(file);
    let mut position = 0_u64;
    let mut line_number = 1_u64;

    while line_number < start_line {
        let line = read_bounded_line(&mut reader, 0)?;
        if line.bytes_consumed == 0 {
            return Ok(ReadTextResult {
                text: String::new(),
                start_line,
                end_line: line_number.saturating_sub(1),
                total_lines: Some(line_number.saturating_sub(1)),
                total_size,
                truncated: false,
                line_truncated: false,
            });
        }
        position += line.bytes_consumed;
        line_number += 1;
    }

    let mut text = String::new();
    let mut lines_read = 0_u32;
    let mut end_line = start_line.saturating_sub(1);
    let mut line_truncated = false;

    while lines_read < limit && position < total_size && text.len() < max_bytes {
        let remaining = max_bytes - text.len();
        let line = read_bounded_line(&mut reader, remaining)?;
        if line.bytes_consumed == 0 {
            break;
        }
        if line.data.contains(&0) {
            return Err(RunnerError::invalid(format!(
                "{path:?} is not a UTF-8 text file"
            )));
        }
        text.push_str(decode_text_prefix(&line.data, line.truncated, path)?);
        position += line.bytes_consumed;
        end_line = line_number;
        line_number += 1;
        lines_read += 1;
        line_truncated |= line.truncated;
    }

    let truncated = position < total_size;
    Ok(ReadTextResult {
        text,
        start_line,
        end_line,
        total_lines: (!truncated).then_some(end_line),
        total_size,
        truncated,
        line_truncated,
    })
}

fn bounded_value(value: u32, default: u32, max: u32, name: &str) -> Result<u32, RunnerError> {
    match value {
        0 => Ok(default),
        value if value <= max => Ok(value),
        value => Err(RunnerError::invalid(format!(
            "{name} {value} exceeds the maximum {max}"
        ))),
    }
}

fn ensure_text_prefix(file: &mut StdFile) -> Result<(), RunnerError> {
    let mut sample = [0_u8; TEXT_PROBE_BYTES];
    let read = file.read(&mut sample).map_err(RunnerError::from)?;
    let sample = &sample[..read];
    let invalid_utf8 = std::str::from_utf8(sample)
        .err()
        .is_some_and(|error| error.error_len().is_some());
    if sample.contains(&0) || invalid_utf8 {
        return Err(RunnerError::invalid("file is not UTF-8 text"));
    }
    Ok(())
}

pub(super) struct BoundedLine {
    pub data: Vec<u8>,
    pub bytes_consumed: u64,
    pub truncated: bool,
}

/// Consumes one physical line while retaining at most `max_capture` bytes. This keeps memory
/// bounded even for generated/minified files containing a single enormous line.
pub(super) fn read_bounded_line(
    reader: &mut impl BufRead,
    max_capture: usize,
) -> Result<BoundedLine, RunnerError> {
    let mut data = Vec::with_capacity(max_capture.min(8 * 1024));
    let mut bytes_consumed = 0_u64;
    let mut truncated = false;

    loop {
        let available = reader.fill_buf().map_err(RunnerError::from)?;
        if available.is_empty() {
            break;
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let consume = newline.map_or(available.len(), |index| index + 1);
        let remaining = max_capture.saturating_sub(data.len());
        let capture = remaining.min(consume);
        data.extend_from_slice(&available[..capture]);
        truncated |= capture < consume;
        reader.consume(consume);
        bytes_consumed += consume as u64;
        if newline.is_some() {
            break;
        }
    }

    Ok(BoundedLine {
        data,
        bytes_consumed,
        truncated,
    })
}

fn decode_text_prefix<'a>(
    data: &'a [u8],
    truncated: bool,
    path: &str,
) -> Result<&'a str, RunnerError> {
    match std::str::from_utf8(data) {
        Ok(text) => Ok(text),
        Err(error) if truncated && error.error_len().is_none() => {
            std::str::from_utf8(&data[..error.valid_up_to()])
                .map_err(|_| RunnerError::invalid(format!("{path:?} is not a UTF-8 text file")))
        }
        Err(_) => Err(RunnerError::invalid(format!(
            "{path:?} is not a UTF-8 text file"
        ))),
    }
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

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;

    #[test]
    fn reads_only_the_requested_window_from_a_large_text_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("large.txt");
        let mut source = StdFile::create(&path).unwrap();
        for line in 1..=10_000 {
            writeln!(source, "line-{line}").unwrap();
        }
        drop(source);
        let workspace = Workspace::new(directory.path().to_path_buf()).unwrap();

        let result = read_text(&workspace, "large.txt", 9_000, 2, 1024).unwrap();

        assert_eq!(result.text, "line-9000\nline-9001\n");
        assert_eq!(result.start_line, 9_000);
        assert_eq!(result.end_line, 9_001);
        assert_eq!(result.total_lines, None);
        assert!(result.truncated);
        assert!(!result.line_truncated);
    }

    #[test]
    fn bounds_a_single_enormous_line() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(
            directory.path().join("minified.js"),
            "x".repeat(2 * 1024 * 1024),
        )
        .unwrap();
        let workspace = Workspace::new(directory.path().to_path_buf()).unwrap();

        let result = read_text(&workspace, "minified.js", 1, 1, 1024).unwrap();

        assert_eq!(result.text.len(), 1024);
        assert_eq!(result.total_lines, Some(1));
        assert!(!result.truncated);
        assert!(result.line_truncated);
    }

    #[test]
    fn rejects_limits_above_the_runner_hard_bounds() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("source.rs"), "fn main() {}\n").unwrap();
        let workspace = Workspace::new(directory.path().to_path_buf()).unwrap();

        assert!(read_text(&workspace, "source.rs", 1, MAX_TEXT_LINES + 1, 0).is_err());
        assert!(read_text(&workspace, "source.rs", 1, 0, MAX_TEXT_BYTES + 1).is_err());
    }

    #[test]
    fn lists_recursively_in_deterministic_order() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(directory.path().join("a/nested")).unwrap();
        std::fs::write(directory.path().join("z.txt"), "z").unwrap();
        std::fs::write(directory.path().join("a/nested/source.rs"), "source").unwrap();
        let workspace = Workspace::new(directory.path().to_path_buf()).unwrap();

        let entries = list(&workspace, "", 3).unwrap();
        let names = entries
            .into_iter()
            .map(|entry| entry.name)
            .collect::<Vec<_>>();

        assert_eq!(names, ["a", "a/nested", "a/nested/source.rs", "z.txt"]);
        assert!(list(&workspace, "", MAX_LIST_DEPTH + 1).is_err());
    }

    #[test]
    fn refuses_to_remove_or_rename_the_workspace_root() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = Workspace::new(directory.path().to_path_buf()).unwrap();

        assert!(remove(&workspace, "", true).is_err());
        assert!(rename(&workspace, "", "renamed").is_err());
        assert!(workspace.root().is_dir());
    }

    fn symlink_file(original: &Path, link: &Path) -> bool {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(original, link).is_ok()
        }
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_file(original, link).is_ok()
        }
    }

    #[test]
    fn removing_a_symlink_does_not_remove_its_target() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("target.txt");
        let link = directory.path().join("link.txt");
        std::fs::write(&target, "keep me").unwrap();
        if !symlink_file(&target, &link) {
            eprintln!("skipping: this environment can't create symlinks");
            return;
        }
        let workspace = Workspace::new(directory.path().to_path_buf()).unwrap();

        remove(&workspace, "link.txt", false).unwrap();

        assert!(!link.exists());
        assert_eq!(std::fs::read_to_string(target).unwrap(), "keep me");
    }

    #[test]
    fn rename_does_not_overwrite_or_follow_a_symlink() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("target.txt");
        let link = directory.path().join("link.txt");
        let moved = directory.path().join("moved-link.txt");
        std::fs::write(&target, "keep me").unwrap();
        if !symlink_file(&target, &link) {
            eprintln!("skipping: this environment can't create symlinks");
            return;
        }
        let workspace = Workspace::new(directory.path().to_path_buf()).unwrap();

        assert!(rename(&workspace, "link.txt", "target.txt").is_err());
        rename(&workspace, "link.txt", "moved-link.txt").unwrap();

        assert!(!link.exists());
        assert!(
            std::fs::symlink_metadata(moved)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(std::fs::read_to_string(target).unwrap(), "keep me");
    }
}
