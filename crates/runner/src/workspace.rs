use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::{ErrorKind, Write},
    path::{Component, Path, PathBuf},
};
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum WorkspaceError {
    #[error("path is outside the registered workspace")]
    OutOfWorkspace,
    #[error("file was not found")]
    NotFound,
    #[error("file already exists")]
    Exists,
    #[error("path is a directory")]
    IsDirectory,
    #[error("path is not a directory")]
    NotDirectory,
    #[error("file exceeds the operation limit")]
    TooLarge,
    #[error("file digest did not match")]
    Conflict,
    #[error("path is not valid UTF-8 text")]
    InvalidText,
    #[error("path is not a valid workspace-relative request")]
    InvalidPath,
    #[error("operation was cancelled")]
    Cancelled,
    #[error("operation deadline expired")]
    Expired,
    #[error("workspace I/O failed")]
    Io(#[from] std::io::Error),
}

pub fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

pub fn resolve(root: &Path, raw: &str) -> Result<PathBuf, WorkspaceError> {
    if raw.contains('\0') {
        return Err(WorkspaceError::OutOfWorkspace);
    }
    let input = Path::new(raw);
    if input.is_absolute() {
        return Err(WorkspaceError::OutOfWorkspace);
    }
    let mut parts = Vec::new();
    for component in input.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(part) => parts.push(part),
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(WorkspaceError::OutOfWorkspace);
            }
        }
    }
    let joined = parts
        .iter()
        .fold(root.to_path_buf(), |path, part| path.join(part));
    let checked = if joined.exists() {
        fs::canonicalize(&joined)?
    } else {
        let parent = joined.parent().ok_or(WorkspaceError::OutOfWorkspace)?;
        let canonical_parent = fs::canonicalize(parent)?;
        if !canonical_parent.starts_with(root) {
            return Err(WorkspaceError::OutOfWorkspace);
        }
        canonical_parent.join(joined.file_name().ok_or(WorkspaceError::OutOfWorkspace)?)
    };
    if !checked.starts_with(root) {
        return Err(WorkspaceError::OutOfWorkspace);
    }
    Ok(checked)
}

pub fn ensure_parent(root: &Path, path: &Path) -> Result<(), WorkspaceError> {
    let parent = path.parent().ok_or(WorkspaceError::OutOfWorkspace)?;
    if !parent.starts_with(root) {
        return Err(WorkspaceError::OutOfWorkspace);
    }
    let mut current = root.to_path_buf();
    for component in parent
        .strip_prefix(root)
        .map_err(|_| WorkspaceError::OutOfWorkspace)?
        .components()
    {
        let Component::Normal(part) = component else {
            return Err(WorkspaceError::OutOfWorkspace);
        };
        current.push(part);
        if !current.exists() {
            fs::create_dir(&current)?;
        }
        let canonical = fs::canonicalize(&current)?;
        if !canonical.starts_with(root) || !canonical.is_dir() {
            return Err(WorkspaceError::OutOfWorkspace);
        }
    }
    Ok(())
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), WorkspaceError> {
    let parent = path.parent().ok_or(WorkspaceError::OutOfWorkspace)?;
    let temp = parent.join(format!(".nova-{}.tmp", Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)?;
    let operation = (|| -> Result<(), WorkspaceError> {
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        replace_file(&temp, path)?;
        if let Ok(dir) = OpenOptions::new().read(true).open(parent) {
            let _ = dir.sync_all();
        }
        Ok(())
    })();
    if operation.is_err() {
        let _ = fs::remove_file(&temp);
    }
    operation
}

#[cfg(not(windows))]
fn replace_file(source: &Path, target: &Path) -> Result<(), WorkspaceError> {
    fs::rename(source, target)?;
    Ok(())
}

#[cfg(windows)]
fn replace_file(source: &Path, target: &Path) -> Result<(), WorkspaceError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };
    let from: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: both paths are NUL-terminated UTF-16 and stay alive for the call.
    let moved = unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}

/// §5.2：工作区初始化流程统一保障注册工作区根 `.gitignore` 含独立一行 `.nova/`，
/// 技能不自行修改 `.gitignore`。幂等：
/// - 文件不存在 → 创建仅含该行；
/// - 存在但缺该行 → 在文件末尾追加（保留原内容；原文件不以换行结尾时先补一个换行，
///   保证 `.nova/` 独立成行，新追加行自身以 `\n` 结尾）；
/// - 已含该行 → 不改动文件。
/// `.gitignore` 本身是符号链接或非普通文件时跳过并返回诊断原因（绝不跟随写目标）；
/// 调用方只记诊断日志，不阻断 Runner 连接与其它 RPC。
pub fn ensure_nova_gitignored(root: &Path) -> Result<(), String> {
    const LINE: &[u8] = b".nova/";
    let target = root.join(".gitignore");
    match fs::symlink_metadata(&target) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(".gitignore is a symbolic link; not following it".into());
        }
        Ok(metadata) if !metadata.is_file() => {
            return Err(".gitignore is not a regular file".into());
        }
        Ok(_) => {
            let contents =
                fs::read(&target).map_err(|error| format!("could not read .gitignore: {error}"))?;
            let has_line = contents
                .split(|byte| *byte == b'\n')
                .any(|line| line.strip_suffix(b"\r").unwrap_or(line) == LINE);
            if has_line {
                return Ok(());
            }
            let mut file = OpenOptions::new()
                .append(true)
                .open(&target)
                .map_err(|error| format!("could not open .gitignore for append: {error}"))?;
            if !contents.is_empty() && !contents.ends_with(b"\n") {
                file.write_all(b"\n")
                    .map_err(|error| format!("could not append to .gitignore: {error}"))?;
            }
            file.write_all(LINE)
                .and_then(|()| file.write_all(b"\n"))
                .map_err(|error| format!("could not append to .gitignore: {error}"))?;
            Ok(())
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {
            // create_new：并发下另一进程先创建时失败返回诊断，下轮重试幂等成功。
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)
                .map_err(|error| format!("could not create .gitignore: {error}"))?;
            file.write_all(LINE)
                .and_then(|()| file.write_all(b"\n"))
                .map_err(|error| format!("could not write .gitignore: {error}"))?;
            Ok(())
        }
        Err(error) => Err(format!("could not inspect .gitignore: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_workspace(label: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("nova-runner-gitignore-{label}-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        fs::canonicalize(&path).unwrap()
    }

    fn gitignore(root: &Path) -> String {
        fs::read_to_string(root.join(".gitignore")).unwrap()
    }

    #[cfg(windows)]
    fn make_symlink_file(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_file(target, link)
    }
    #[cfg(not(windows))]
    fn make_symlink_file(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    #[test]
    fn gitignore_created_when_missing() {
        let root = temp_workspace("create");
        ensure_nova_gitignored(&root).unwrap();
        assert_eq!(gitignore(&root), ".nova/\n");
        ensure_nova_gitignored(&root).unwrap();
        assert_eq!(gitignore(&root), ".nova/\n", "repeat call touches nothing");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn gitignore_appended_preserving_content_with_newline_normalization() {
        // 原内容无行尾换行：先补换行再独立成行。
        let root = temp_workspace("append");
        fs::write(root.join(".gitignore"), "node_modules/").unwrap();
        ensure_nova_gitignored(&root).unwrap();
        assert_eq!(gitignore(&root), "node_modules/\n.nova/\n");
        let _ = fs::remove_dir_all(&root);

        let root = temp_workspace("append-newline");
        fs::write(root.join(".gitignore"), "target/\n").unwrap();
        ensure_nova_gitignored(&root).unwrap();
        assert_eq!(gitignore(&root), "target/\n.nova/\n", "不得出现双倍空行");
        let _ = fs::remove_dir_all(&root);

        let root = temp_workspace("append-empty");
        fs::write(root.join(".gitignore"), "").unwrap();
        ensure_nova_gitignored(&root).unwrap();
        assert_eq!(gitignore(&root), ".nova/\n");
        let _ = fs::remove_dir_all(&root);

        let root = temp_workspace("append-crlf");
        fs::write(root.join(".gitignore"), "build/\r\n").unwrap();
        ensure_nova_gitignored(&root).unwrap();
        assert_eq!(gitignore(&root), "build/\r\n.nova/\n");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn gitignore_existing_line_is_left_untouched() {
        let root = temp_workspace("existing");
        fs::write(root.join(".gitignore"), "dist/\n.nova/\nruns/\n").unwrap();
        ensure_nova_gitignored(&root).unwrap();
        assert_eq!(
            gitignore(&root),
            "dist/\n.nova/\nruns/\n",
            "已有 .nova/ 行：零改动"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn gitignore_near_miss_lines_do_not_count_as_present() {
        // 缺斜杠或带锚点前缀的行不算「独立一行 .nova/」，仍需追加。
        let root = temp_workspace("near-miss");
        fs::write(root.join(".gitignore"), ".nova\n/.nova/\n").unwrap();
        ensure_nova_gitignored(&root).unwrap();
        assert_eq!(gitignore(&root), ".nova\n/.nova/\n.nova/\n");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn gitignore_symbolic_link_is_skipped_not_followed() {
        let base = temp_workspace("symlink");
        let root = base.join("workspace");
        fs::create_dir_all(&root).unwrap();
        let victim = base.join("victim.gitignore");
        fs::write(&victim, "keep-me\n").unwrap();
        let link = root.join(".gitignore");
        let created = make_symlink_file(&victim, &link);
        match created {
            Ok(()) => {
                let outcome = ensure_nova_gitignored(&fs::canonicalize(&root).unwrap());
                assert!(
                    outcome.is_err(),
                    "symbolic link must be skipped: {outcome:?}"
                );
                assert!(fs::symlink_metadata(&link).map_or(false, |m| m.file_type().is_symlink()));
                assert_eq!(
                    fs::read_to_string(&victim).unwrap(),
                    "keep-me\n",
                    "目标未被写入"
                );
            }
            Err(error) => {
                // 未开启开发者模式/权限的 Windows 无法创建符号链接：跳过 FS 断言。
                eprintln!("symlink creation unsupported on this machine: {error}");
            }
        }
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn gitignore_non_file_or_io_failure_is_reported_not_fatal() {
        // `.gitignore` 是目录：返回诊断原因，不 panic、不写入。
        let root = temp_workspace("dir");
        fs::create_dir(root.join(".gitignore")).unwrap();
        assert!(ensure_nova_gitignored(&root).is_err());
        let _ = fs::remove_dir_all(&root);
        // 工作区根不可用：同样只返回诊断字符串（调用方记日志，不阻断接入）。
        let missing = temp_workspace("missing-root-removed");
        fs::remove_dir_all(&missing).unwrap();
        assert!(ensure_nova_gitignored(&missing).is_err());
    }
}
