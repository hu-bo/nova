//! Structured search primitive — runner.md §7: this is the one "specific command" exception,
//! because grep isn't spawned as a process (no `rg` binary, no cross-platform/escaping issues,
//! no `file:line:text` parsing ambiguity). `ignore` walks the tree respecting `.gitignore`;
//! matching is a plain `regex::Regex` over each line, no shell involved.

use globset::Glob;
use ignore::WalkBuilder;
use regex::Regex;

use crate::error::RunnerError;
use crate::pb::execution::GrepMatch;

use super::Workspace;

const DEFAULT_MAX_RESULTS: u32 = 100;
const HARD_MAX_RESULTS: u32 = 1000;

pub fn grep(
    workspace: &Workspace,
    pattern: &str,
    path: &str,
    glob: &str,
    max_results: u32,
) -> Result<(Vec<GrepMatch>, u32, bool), RunnerError> {
    let regex = Regex::new(pattern)
        .map_err(|err| RunnerError::invalid(format!("invalid pattern: {err}")))?;
    let glob_matcher = if glob.is_empty() {
        None
    } else {
        Some(
            Glob::new(glob)
                .map_err(|err| RunnerError::invalid(format!("invalid glob: {err}")))?
                .compile_matcher(),
        )
    };
    let search_root = if path.is_empty() {
        workspace.root().to_path_buf()
    } else {
        workspace.resolve(path)?
    };
    let max_results = match max_results {
        0 => DEFAULT_MAX_RESULTS,
        n => n.min(HARD_MAX_RESULTS),
    };

    let mut matches = Vec::new();
    let mut total: u32 = 0;
    for entry in WalkBuilder::new(&search_root).build() {
        let entry = entry.map_err(|err| RunnerError::io(err.to_string()))?;
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(workspace.root())
            .unwrap_or(entry.path());
        if let Some(matcher) = &glob_matcher {
            if !matcher.is_match(relative) {
                continue;
            }
        }
        let Ok(content) = std::fs::read_to_string(entry.path()) else {
            continue;
        }; // skip binary/unreadable
        let file_name = relative.to_string_lossy().replace('\\', "/");
        for (index, line) in content.lines().enumerate() {
            if !regex.is_match(line) {
                continue;
            }
            total += 1;
            if matches.len() < max_results as usize {
                matches.push(GrepMatch {
                    file: file_name.clone(),
                    line: (index + 1) as u32,
                    text: line.to_string(),
                });
            }
        }
    }

    let truncated = total > matches.len() as u32;
    Ok((matches, total, truncated))
}
