//! Read-only repo access via libgit2.
use crate::errors::AppError;
use serde::Serialize;
use std::path::Path;
use ts_rs::TS;

#[derive(Debug, Serialize, TS)]
#[ts(export)]
pub struct RepoInfo {
    /// Absolute path of the working tree root.
    pub path: String,
    pub name: String,
    /// Current branch, or None when HEAD is detached or unborn.
    pub branch: Option<String>,
}

/// Opens the repo containing `path` (walks up like git does). Bare repos are rejected.
pub fn open(path: &Path) -> Result<RepoInfo, AppError> {
    let repo = git2::Repository::discover(path)?;
    let root = repo
        .workdir()
        .ok_or_else(|| AppError::new("bare_repo", "Bare repositories are not supported."))?;
    let root = root.to_string_lossy().trim_end_matches(['/', '\\']).to_string();
    let branch = repo.head().ok().filter(|h| h.is_branch()).and_then(|h| h.shorthand().ok().map(String::from));
    let name = Path::new(&root).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(RepoInfo { path: root, name, branch })
}

/// Unified diff of one file: staged (HEAD → index) or unstaged (index → working tree, untracked included).
/// None when the file is binary or over 1 MB (libgit2 treats blobs above `max_size` as binary).
pub fn file_diff(repo: &Path, file: &str, staged: bool) -> Result<Option<String>, AppError> {
    let repo = git2::Repository::open(repo)?;
    let mut opts = git2::DiffOptions::new();
    opts.pathspec(file)
        .disable_pathspec_match(true)
        .max_size(1 << 20)
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true);
    let diff = if staged {
        let head = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
        repo.diff_tree_to_index(head.as_ref(), None, Some(&mut opts))?
    } else {
        repo.diff_index_to_workdir(None, Some(&mut opts))?
    };
    if diff.deltas().len() == 0 {
        return Ok(Some(String::new()));
    }
    // ponytail: no rename detection, so a staged rename shows as an add of the new path.
    let text = match git2::Patch::from_diff(&diff, 0)? {
        Some(mut patch) if !patch.delta().flags().is_binary() => Some(String::from_utf8_lossy(&patch.to_buf()?).into_owned()),
        _ => None,
    };
    Ok(text)
}

#[cfg(test)]
mod tests {
    #[test]
    fn diffs_own_files() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        // Clean or not, a known text file must give a text (possibly empty) diff, never "binary".
        assert!(super::file_diff(root, "progress.md", false).unwrap().is_some());
        assert!(super::file_diff(root, "progress.md", true).unwrap().is_some());
    }
}
