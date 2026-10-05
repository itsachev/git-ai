//! Read-only repo access via libgit2.
use super::cli::FileChange;
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

/// The op that stopped halfway (conflicts) and waits for commit or abort: "merge", "cherry-pick",
/// "revert" or "rebase". None when nothing is in progress.
pub fn operation(repo: &Path) -> Result<Option<String>, AppError> {
    use git2::RepositoryState::*;
    Ok(match git2::Repository::discover(repo)?.state() {
        Merge => Some("merge"),
        CherryPick | CherryPickSequence => Some("cherry-pick"),
        Revert | RevertSequence => Some("revert"),
        Rebase | RebaseInteractive | RebaseMerge => Some("rebase"),
        _ => None,
    }
    .map(String::from))
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

/// Message of the HEAD commit (prefills the amend box). None before the first commit.
pub fn head_message(repo: &Path) -> Result<Option<String>, AppError> {
    let repo = git2::Repository::open(repo)?;
    let msg = repo.head().ok().and_then(|h| h.peel_to_commit().ok()).map(|c| String::from_utf8_lossy(c.message_bytes()).trim_end().to_string());
    Ok(msg)
}

#[derive(Debug, Serialize, TS)]
#[ts(export)]
pub struct CommitDetails {
    pub oid: String,
    pub parents: Vec<String>,
    /// "Name <email>".
    pub author: String,
    /// Author time, seconds since the epoch.
    #[ts(type = "number")]
    pub time: i64,
    pub committer: String,
    pub message: String,
    /// Changes against the first parent (the empty tree for a root commit).
    pub files: Vec<FileChange>,
}

pub fn commit_details(repo: &Path, oid: &str) -> Result<CommitDetails, AppError> {
    let repo = git2::Repository::open(repo)?;
    let c = repo.find_commit(git2::Oid::from_str(oid)?)?;
    let diff = commit_diff_all(&repo, &c)?;
    let files = diff
        .deltas()
        .map(|d| {
            use git2::Delta::*;
            let path = |f: git2::DiffFile| f.path().map(|p| p.to_string_lossy().replace('\\', "/"));
            let kind = match d.status() { Added => "A", Deleted => "D", Renamed => "R", Copied => "C", Typechange => "T", _ => "M" };
            let renamed = matches!(d.status(), Renamed | Copied);
            FileChange {
                path: path(d.new_file()).or_else(|| path(d.old_file())).unwrap_or_default(),
                orig_path: if renamed { path(d.old_file()) } else { None },
                kind: kind.into(),
            }
        })
        .collect();
    let sig = |s: git2::Signature| format!("{} <{}>", String::from_utf8_lossy(s.name_bytes()), String::from_utf8_lossy(s.email_bytes()));
    let author = c.author();
    Ok(CommitDetails {
        oid: c.id().to_string(),
        parents: c.parent_ids().map(|p| p.to_string()).collect(),
        time: author.when().seconds(),
        author: sig(author),
        committer: sig(c.committer()),
        message: String::from_utf8_lossy(c.message_bytes()).trim_end().to_string(),
        files,
    })
}

/// Unified diff of one file of a commit (the new path for renames). None when binary or over 1 MB.
pub fn commit_file_diff(repo: &Path, oid: &str, file: &str) -> Result<Option<String>, AppError> {
    let repo = git2::Repository::open(repo)?;
    let c = repo.find_commit(git2::Oid::from_str(oid)?)?;
    let diff = commit_diff_all(&repo, &c)?;
    let Some(idx) = diff.deltas().position(|d| {
        [d.new_file(), d.old_file()].iter().any(|f| f.path().is_some_and(|p| p.to_string_lossy().replace('\\', "/") == file))
    }) else {
        return Ok(Some(String::new()));
    };
    let text = match git2::Patch::from_diff(&diff, idx)? {
        Some(mut patch) if !patch.delta().flags().is_binary() => Some(String::from_utf8_lossy(&patch.to_buf()?).into_owned()),
        _ => None,
    };
    Ok(text)
}

/// First parent → commit, with rename detection.
fn commit_diff_all<'r>(repo: &'r git2::Repository, c: &git2::Commit) -> Result<git2::Diff<'r>, AppError> {
    let parent = c.parent(0).ok().map(|p| p.tree()).transpose()?;
    let mut opts = git2::DiffOptions::new();
    opts.max_size(1 << 20);
    let mut diff = repo.diff_tree_to_tree(parent.as_ref(), Some(&c.tree()?), Some(&mut opts))?;
    diff.find_similar(None)?;
    Ok(diff)
}

#[derive(Debug, Serialize, TS)]
#[ts(export)]
pub struct RefItem {
    /// Short name ("main", "origin/main", "v1.0"), or the message for a stash.
    pub name: String,
    pub oid: String,
    /// Upstream short name of a local branch.
    pub upstream: Option<String>,
    /// Commits ahead of / behind the upstream.
    pub ahead: u32,
    pub behind: u32,
}

#[derive(Debug, Serialize, TS)]
#[ts(export)]
pub struct Refs {
    /// Current branch; None when HEAD is detached or unborn.
    pub head: Option<String>,
    pub local: Vec<RefItem>,
    pub remote: Vec<RefItem>,
    pub tags: Vec<RefItem>,
    /// Newest first (stash@{0} first).
    pub stashes: Vec<RefItem>,
}

/// Branches, remote branches, tags and stashes for the sidebar, each sorted by name.
pub fn refs(repo: &Path) -> Result<Refs, AppError> {
    let mut repo = git2::Repository::open(repo)?;
    let head = repo.head().ok().filter(|h| h.is_branch()).and_then(|h| h.shorthand().ok().map(String::from));
    let item = |name: String, oid: git2::Oid| RefItem { name, oid: oid.to_string(), upstream: None, ahead: 0, behind: 0 };
    let (mut local, mut remote, mut tags) = (vec![], vec![], vec![]);
    for r in repo.references()?.flatten() {
        let (Ok(full), Ok(short)) = (r.name(), r.shorthand()) else { continue };
        let Ok(c) = r.peel_to_commit() else { continue };
        let mut it = item(short.to_string(), c.id());
        if full.starts_with("refs/heads/") {
            let up = git2::Branch::wrap(r).upstream().ok();
            if let Some(up) = up.as_ref().and_then(|u| u.get().target()) {
                (it.ahead, it.behind) = repo.graph_ahead_behind(c.id(), up).map(|(a, b)| (a as u32, b as u32)).unwrap_or_default();
            }
            it.upstream = up.and_then(|u| u.name().ok().flatten().map(String::from));
            local.push(it);
        } else if full.starts_with("refs/remotes/") && !full.ends_with("/HEAD") {
            remote.push(it);
        } else if full.starts_with("refs/tags/") {
            tags.push(it);
        }
    }
    for v in [&mut local, &mut remote, &mut tags] {
        v.sort_by(|a, b| a.name.cmp(&b.name));
    }
    let mut stashes = vec![];
    // No stash ref yet is not an error.
    let _ = repo.stash_foreach(|_, msg, oid| {
        stashes.push(item(msg.to_string(), *oid));
        true
    });
    Ok(Refs { head, local, remote, tags, stashes })
}

#[cfg(test)]
mod tests {
    #[test]
    fn reads_commits_and_graph() {
        let dir = std::env::temp_dir().join(format!("git-ai-read-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let repo = git2::Repository::init(&dir).unwrap();
        let sig = git2::Signature::now("T", "t@example.com").unwrap();
        // Commits a tree holding just `name` → `text`.
        let commit = |name: &str, text: &str, parents: &[&git2::Commit]| {
            let blob = repo.blob(text.as_bytes()).unwrap();
            let mut tb = repo.treebuilder(None).unwrap();
            tb.insert(name, blob, 0o100644).unwrap();
            let tree = repo.find_tree(tb.write().unwrap()).unwrap();
            let oid = repo.commit(Some("HEAD"), &sig, &sig, "msg\n\nbody", &tree, parents).unwrap();
            repo.find_commit(oid).unwrap()
        };
        let first = commit("a.txt", "one\ntwo\nthree\n", &[]);
        let second = commit("b.txt", "one\ntwo\nthree\n", &[&first]);

        let d = super::commit_details(&dir, &first.id().to_string()).unwrap();
        assert!(d.parents.is_empty());
        assert_eq!(d.message, "msg\n\nbody");
        assert_eq!((d.files[0].path.as_str(), d.files[0].kind.as_str()), ("a.txt", "A"));
        let d = super::commit_details(&dir, &second.id().to_string()).unwrap();
        assert_eq!((d.files[0].kind.as_str(), d.files[0].orig_path.as_deref()), ("R", Some("a.txt")));
        assert!(super::commit_file_diff(&dir, &first.id().to_string(), "a.txt").unwrap().unwrap().ends_with("+one\n+two\n+three\n"));

        let page = crate::git::graph::rows(&Default::default(), &dir, 0, 500).unwrap();
        assert_eq!((page.total, page.lanes), (2, 1));
        assert!(page.rows[0].head && page.rows[0].oid == second.id().to_string());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn diffs_own_files() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        // Clean or not, a known text file must give a text (possibly empty) diff, never "binary".
        assert!(super::file_diff(root, "progress.md", false).unwrap().is_some());
        assert!(super::file_diff(root, "progress.md", true).unwrap().is_some());
    }
}
