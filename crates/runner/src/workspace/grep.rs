//! Structured search primitive — runner.md §7: this is the one "specific command" exception,
//! because grep isn't spawned as a process (no `rg` binary, no cross-platform/escaping issues,
//! no `file:line:text` parsing ambiguity). `ignore` walks the tree respecting `.gitignore`;
//! matching is a plain `regex::Regex` over each line, no shell involved.

use globset::Glob;
use ignore::WalkBuilder;
use regex::bytes::Regex;
use std::fs::File;
use std::io::BufReader;

use crate::error::RunnerError;
use crate::pb::execution::GrepMatch;

use super::Workspace;
use super::file::read_bounded_line;

const DEFAULT_MAX_RESULTS: u32 = 100;
const HARD_MAX_RESULTS: u32 = 1000;
const MAX_LINE_BYTES: usize = 1024 * 1024;

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
    let mut incomplete = false;
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
        let Ok(file) = File::open(entry.path()) else {
            continue;
        };
        let mut reader = BufReader::new(file);
        let file_name = relative.to_string_lossy().replace('\\', "/");
        let mut line_number = 0_u32;
        loop {
            let line = read_bounded_line(&mut reader, MAX_LINE_BYTES)?;
            if line.bytes_consumed == 0 {
                break;
            }
            line_number = line_number.saturating_add(1);
            if line.data.contains(&0) {
                break;
            }
            incomplete |= line.truncated;
            let text = line.data.strip_suffix(b"\n").unwrap_or(&line.data);
            let text = text.strip_suffix(b"\r").unwrap_or(text);
            if !regex.is_match(text) {
                continue;
            }
            total = total.saturating_add(1);
            if matches.len() < max_results as usize {
                matches.push(GrepMatch {
                    file: file_name.clone(),
                    line: line_number,
                    text: String::from_utf8_lossy(text).into_owned(),
                });
            } else {
                return Ok((matches, total, true));
            }
        }
    }

    Ok((matches, total, incomplete))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stops_after_confirming_one_match_beyond_the_limit() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(
            directory.path().join("source.rs"),
            "match one\nmatch two\nmatch three\n",
        )
        .unwrap();
        let workspace = Workspace::new(directory.path().to_path_buf()).unwrap();

        let (matches, total, truncated) = grep(&workspace, "match", "", "", 2).unwrap();

        assert_eq!(matches.len(), 2);
        assert_eq!(total, 3);
        assert!(truncated);
    }

    #[test]
    fn marks_search_incomplete_when_a_line_exceeds_the_bound() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(
            directory.path().join("minified.js"),
            format!("needle{}", "x".repeat(MAX_LINE_BYTES + 1)),
        )
        .unwrap();
        let workspace = Workspace::new(directory.path().to_path_buf()).unwrap();

        let (matches, total, truncated) = grep(&workspace, "needle", "", "", 10).unwrap();

        assert_eq!(matches.len(), 1);
        assert_eq!(total, 1);
        assert!(truncated);
    }
}
