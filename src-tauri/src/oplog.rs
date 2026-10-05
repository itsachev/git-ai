//! Undo support: backups under `refs/git-ai/backup/<id>` plus one JSON line per op in `.git/git-ai/oplog.jsonl`.
use crate::errors::AppError;
use crate::git::cli::{git, git_env, rev};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use ts_rs::TS;

const LOG: &str = "oplog.jsonl";

/// One line of the op log.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct OpEntry {
    /// Unix time in ms, also the backup ref name.
    pub id: String,
    /// "discard", "amend" or "undo".
    pub op: String,
    /// HEAD before the op.
    pub head: Option<String>,
    /// HEAD after the op, when the op moved it. Undo moves it back.
    pub new_head: Option<String>,
    #[serde(default)]
    pub paths: Vec<String>,
    /// Working-tree snapshot of `paths` taken before the op. Undo restores it.
    pub backup: Option<String>,
    /// For "undo": the id of the undone entry.
    pub undoes: Option<String>,
}

impl OpEntry {
    pub fn new(op: &str, head: Option<String>, new_head: Option<String>) -> Self {
        let id = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis().to_string();
        Self { id, op: op.into(), head, new_head, paths: vec![], backup: None, undoes: None }
    }
}

/// Snapshots the working-tree content of `paths` and logs the op. Returns the backup ref.
pub fn backup(repo: &Path, op: &str, paths: &[String]) -> Result<String, AppError> {
    let e = snapshot(repo, op, paths)?;
    let backup = e.backup.clone().unwrap_or_default();
    record(repo, e)?;
    Ok(backup)
}

/// Commits the working-tree content of `paths` (tracked and untracked) on top of HEAD and stores it at
/// `refs/git-ai/backup/<id>`. Uses a throwaway index instead of `git stash create`, which can't take
/// paths or untracked files.
fn snapshot(repo: &Path, op: &str, paths: &[String]) -> Result<OpEntry, AppError> {
    let index = git_ai_dir(repo)?.join("backup.index");
    let _ = fs::remove_file(&index);
    let env = [("GIT_INDEX_FILE", index.as_path())];
    let head = rev(repo, "HEAD").ok();
    if let Some(head) = &head {
        git_env(repo, &["read-tree", head], &env)?;
    }
    // `git add` fails on a path that is neither on disk nor in HEAD (e.g. an untracked file that's gone); skip those.
    let (on_disk, gone): (Vec<&str>, Vec<&str>) = paths.iter().map(String::as_str).partition(|p| repo.join(p).exists());
    let mut keep = on_disk;
    let tracked;
    if !gone.is_empty() {
        tracked = git_env(repo, &[&["ls-files", "-z", "--"], gone.as_slice()].concat(), &env)?;
        keep.extend(tracked.split('\0').filter(|p| !p.is_empty()));
    }
    if !keep.is_empty() {
        git_env(repo, &[&["add", "-A", "--"], keep.as_slice()].concat(), &env)?;
    }
    let tree = git_env(repo, &["write-tree"], &env)?;
    let _ = fs::remove_file(&index);

    let mut e = OpEntry::new(op, head, None);
    let msg = format!("git-ai backup: {op}");
    // Fixed identity so backups work even when user.name/email aren't configured.
    let mut args = vec!["-c", "user.name=git-ai", "-c", "user.email=git-ai@localhost", "commit-tree", tree.trim(), "-m", &msg];
    if let Some(head) = &e.head {
        args.extend(["-p", head]);
    }
    let commit = git(repo, &args)?;
    let backup = format!("refs/git-ai/backup/{}", e.id);
    git(repo, &["update-ref", &backup, commit.trim()])?;
    e.paths = paths.to_vec();
    e.backup = Some(backup);
    Ok(e)
}

pub fn record(repo: &Path, e: OpEntry) -> Result<(), AppError> {
    let line = serde_json::to_string(&e).map_err(|e| AppError::new("io", e.to_string()))?;
    let mut log = fs::OpenOptions::new().create(true).append(true).open(git_ai_dir(repo)?.join(LOG)).map_err(io)?;
    writeln!(log, "{line}").map_err(io)
}

/// Newest first, without entries that were already undone.
pub fn entries(repo: &Path, limit: usize) -> Result<Vec<OpEntry>, AppError> {
    let text = fs::read_to_string(git_ai_dir(repo)?.join(LOG)).unwrap_or_default();
    let all: Vec<OpEntry> = text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
    let undone: Vec<&str> = all.iter().filter_map(|e| e.undoes.as_deref()).collect();
    Ok(all.iter().rev().filter(|e| !undone.contains(&e.id.as_str())).take(limit).cloned().collect())
}

/// Reverts one op: restores its backup into the working tree (snapshotting the current content
/// first), or moves HEAD back with a compare-and-swap `update-ref`. Logged as an "undo" op.
pub fn undo(repo: &Path, id: &str) -> Result<(), AppError> {
    let text = fs::read_to_string(git_ai_dir(repo)?.join(LOG)).unwrap_or_default();
    let e = text
        .lines()
        .filter_map(|l| serde_json::from_str::<OpEntry>(l).ok())
        .find(|e| e.id == id)
        .ok_or_else(|| AppError::new("not_found", "That operation is no longer in the undo history."))?;
    let mut u = if let Some(backup) = &e.backup {
        let u = snapshot(repo, "undo", &e.paths)?;
        let args: Vec<&str> = ["restore", "--source", backup, "--worktree", "--"]
            .into_iter()
            .chain(e.paths.iter().map(String::as_str))
            .collect();
        git(repo, &args)?;
        u
    } else if let (Some(old), Some(new)) = (&e.head, &e.new_head) {
        git(repo, &["update-ref", "-m", "git-ai: undo", "HEAD", old, new]).map_err(|_| {
            AppError::new("moved", "HEAD has moved since this operation (a newer commit or checkout), so it can't be undone.")
        })?;
        OpEntry::new("undo", Some(new.clone()), Some(old.clone()))
    } else {
        return Err(AppError::new("not_undoable", "This operation can't be undone."));
    };
    u.undoes = Some(e.id);
    record(repo, u)
}

fn git_ai_dir(repo: &Path) -> Result<PathBuf, AppError> {
    let dir = PathBuf::from(git(repo, &["rev-parse", "--absolute-git-dir"])?.trim()).join("git-ai");
    fs::create_dir_all(&dir).map_err(io)?;
    Ok(dir)
}

fn io(e: std::io::Error) -> AppError {
    AppError::new("io", e.to_string())
}

#[cfg(test)]
mod tests {
    use crate::git::cli::{self, git};
    use std::fs;

    /// Stage, unstage, commit, discard (with backup) on a throwaway repo.
    #[test]
    fn write_ops_round_trip() {
        let dir = std::env::temp_dir().join(format!("git-ai-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let p = dir.as_path();
        git(p, &["init", "-q"]).unwrap();
        git(p, &["config", "user.name", "t"]).unwrap();
        git(p, &["config", "user.email", "t@t"]).unwrap();
        git(p, &["config", "core.autocrlf", "false"]).unwrap();
        let files = |names: &[&str]| names.iter().map(|s| s.to_string()).collect::<Vec<_>>();

        fs::write(dir.join("a.txt"), "one\n").unwrap();
        cli::stage(p, &files(&["a.txt"])).unwrap();
        assert_eq!(cli::status(p).unwrap().staged.len(), 1);
        cli::unstage(p, &files(&["a.txt"])).unwrap(); // before the first commit
        assert_eq!(cli::status(p).unwrap().staged.len(), 0);
        cli::stage(p, &files(&["a.txt"])).unwrap();
        cli::commit(p, "first", false).unwrap();

        fs::write(dir.join("a.txt"), "two\n").unwrap();
        fs::write(dir.join("new.txt"), "untracked\n").unwrap();
        cli::discard(p, &files(&["a.txt", "new.txt"])).unwrap();
        assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "one\n");
        assert!(!dir.join("new.txt").exists());

        let backup = git(p, &["for-each-ref", "--format=%(refname)", "refs/git-ai/backup"]).unwrap();
        let backup = backup.trim();
        assert_eq!(git(p, &["show", &format!("{backup}:a.txt")]).unwrap(), "two\n");
        assert_eq!(git(p, &["show", &format!("{backup}:new.txt")]).unwrap(), "untracked\n");
        let log = fs::read_to_string(dir.join(".git/git-ai/oplog.jsonl")).unwrap();
        assert!(log.contains(backup));

        // Undo the discard: both files come back, and the undone entry leaves the history.
        let id = super::entries(p, 20).unwrap()[0].id.clone();
        super::undo(p, &id).unwrap();
        assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "two\n");
        assert_eq!(fs::read_to_string(dir.join("new.txt")).unwrap(), "untracked\n");
        assert!(super::entries(p, 20).unwrap().iter().all(|e| e.id != id));
        fs::remove_file(dir.join("new.txt")).unwrap();

        // Amend, then undo it: HEAD goes back, the amended change stays staged.
        let before = cli::rev(p, "HEAD").unwrap();
        cli::stage(p, &files(&["a.txt"])).unwrap();
        cli::commit(p, "first, amended", true).unwrap();
        assert_ne!(cli::rev(p, "HEAD").unwrap(), before);
        let amend = super::entries(p, 20).unwrap()[0].clone();
        assert_eq!(amend.op, "amend");
        super::undo(p, &amend.id).unwrap();
        assert_eq!(cli::rev(p, "HEAD").unwrap(), before);
        assert_eq!(cli::status(p).unwrap().staged.len(), 1);
        cli::unstage(p, &files(&["a.txt"])).unwrap();

        // Line ops. Diff of a.txt ("one" to "x, two, y") has lines: 4 header, @@, -one, +x, +two, +y.
        fs::write(dir.join("a.txt"), "x\ntwo\ny\n").unwrap();
        let diff = crate::git::read::file_diff(p, "a.txt", false).unwrap().unwrap();
        let lines: Vec<&str> = diff.lines().collect();
        assert_eq!(&lines[5..], ["-one", "+x", "+two", "+y"]);
        cli::apply_lines(p, "a.txt", cli::LineOp::Stage, &[5, 7]).unwrap();
        assert_eq!(git(p, &["show", ":a.txt"]).unwrap(), "two\n");
        // Staged diff is now -one +two (lines 5, 6); unstage just the +two: "one" removed, nothing added.
        cli::apply_lines(p, "a.txt", cli::LineOp::Unstage, &[6]).unwrap();
        assert_eq!(git(p, &["show", ":a.txt"]).unwrap(), "");
        // Unstaged diff is now +x +two +y (lines 5..8); discard +y only.
        cli::apply_lines(p, "a.txt", cli::LineOp::Discard, &[7]).unwrap();
        assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "x\ntwo\n");
        let _ = fs::remove_dir_all(&dir);
    }
}
