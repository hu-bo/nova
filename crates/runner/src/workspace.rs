use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::Write,
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
