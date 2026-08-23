//! Workspace root binding and path containment. docs/runner.md §6:
//! "Runner 启动时指定一个 workspace root，所有路径操作在它之内。"
//!
//! Resolution order: join relative paths onto the root, lexically normalize `.`/`..`
//! (no filesystem access), canonicalize the longest *existing* ancestor (this is what
//! resolves symlinks — including ones on a prefix of a path whose leaf doesn't exist yet,
//! e.g. a new file about to be written), then re-append the non-existent tail and check
//! containment. Skipping the canonicalize step would let a symlink pointing outside the
//! workspace escape it (§6: "第 3 步不能省").

use std::path::{Path, PathBuf};

use crate::error::RunnerError;

pub mod file;
pub mod grep;

pub struct Workspace {
    root: PathBuf,
}

impl Workspace {
    /// `root` must already exist — the caller (config.rs) is responsible for that check;
    /// this only canonicalizes it once so every subsequent resolve() is cheap and consistent.
    pub fn new(root: PathBuf) -> std::io::Result<Self> {
        Ok(Self {
            root: std::fs::canonicalize(&root)?,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Resolve a (possibly relative, possibly absolute, possibly containing `..`) path
    /// against the workspace root, rejecting anything that ends up outside it.
    pub fn resolve(&self, input: &str) -> Result<PathBuf, RunnerError> {
        let candidate = if Path::new(input).is_absolute() {
            PathBuf::from(input)
        } else {
            self.root.join(input)
        };
        let normalized = normalize_lexically(&candidate);

        let mut existing: &Path = &normalized;
        let mut tail: Vec<std::ffi::OsString> = Vec::new();
        loop {
            if std::fs::symlink_metadata(existing).is_ok() {
                break;
            }
            let name = existing.file_name().map(|n| n.to_os_string());
            let parent = existing.parent();
            match (name, parent) {
                (Some(name), Some(parent)) => {
                    tail.push(name);
                    existing = parent;
                }
                _ => {
                    return Err(RunnerError::out_of_workspace(format!(
                        "{input:?} does not resolve within the workspace"
                    )));
                }
            }
        }

        let canonical_existing = std::fs::canonicalize(existing)?;
        let mut result = canonical_existing;
        for part in tail.into_iter().rev() {
            result.push(part);
        }

        if !result.starts_with(&self.root) {
            return Err(RunnerError::out_of_workspace(format!(
                "{input:?} escapes the workspace root"
            )));
        }
        Ok(result)
    }

    /// Portable, forward-slash-normalized path relative to the workspace root, used for
    /// values handed back to the client (`FileInfo.path`, `GrepMatch.file`, ...) so they
    /// stay stable regardless of how the caller originally phrased the request or which OS
    /// the Runner happens to run on.
    pub fn relative_string(&self, path: &Path) -> String {
        let relative = path.strip_prefix(&self.root).unwrap_or(path);
        relative.to_string_lossy().replace('\\', "/")
    }
}

fn normalize_lexically(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                if matches!(out.components().next_back(), Some(Component::Normal(_))) {
                    out.pop();
                }
                // Otherwise we're already at the root (or empty) — extra `..` has nowhere to go.
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace_in(dir: &Path) -> Workspace {
        Workspace::new(dir.to_path_buf()).expect("workspace root must exist")
    }

    #[test]
    fn resolves_nested_relative_path() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("src")).unwrap();
        let ws = workspace_in(dir.path());
        let resolved = ws.resolve("src/main.rs").unwrap();
        assert_eq!(
            resolved,
            std::fs::canonicalize(dir.path())
                .unwrap()
                .join("src")
                .join("main.rs")
        );
    }

    #[test]
    fn rejects_relative_escape() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace_in(dir.path());
        assert!(ws.resolve("../../etc/passwd").is_err());
    }

    #[test]
    fn rejects_absolute_escape() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace_in(dir.path());
        let outside = tempfile::tempdir().unwrap();
        assert!(ws.resolve(outside.path().to_str().unwrap()).is_err());
    }

    /// Creating symlinks on Windows needs Developer Mode or elevation; when the sandbox
    /// running these tests has neither, skip rather than fail on an unrelated permission error.
    fn symlink_dir(original: &Path, link: &Path) -> bool {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(original, link).is_ok()
        }
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_dir(original, link).is_ok()
        }
    }

    #[test]
    fn rejects_symlink_escape_for_new_file() {
        let outside = tempfile::tempdir().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let link = dir.path().join("escape");
        if !symlink_dir(outside.path(), &link) {
            eprintln!("skipping: this environment can't create symlinks");
            return;
        }

        let ws = workspace_in(dir.path());
        // "escape" is a symlink out of the workspace; "escape/new-file.txt" doesn't exist yet,
        // but resolving it must still follow the symlink and reject it.
        assert!(ws.resolve("escape/new-file.txt").is_err());
    }

    #[test]
    fn accepts_path_within_a_real_symlinked_subdir() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        std::fs::create_dir(&real).unwrap();
        let link = dir.path().join("linked");
        if !symlink_dir(&real, &link) {
            eprintln!("skipping: this environment can't create symlinks");
            return;
        }

        let ws = workspace_in(dir.path());
        let resolved = ws.resolve("linked/file.txt").unwrap();
        assert_eq!(
            resolved,
            std::fs::canonicalize(&real).unwrap().join("file.txt")
        );
    }
}
