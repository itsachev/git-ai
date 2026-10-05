//! Undo support: backups under `refs/git-ai/backup/<id>` plus one JSON line per op in `.git/git-ai/oplog.jsonl`.
use crate::errors::AppError;
use crate::git::cli::{git, git_env};
use serde_json::json;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Snapshots the working-tree content of `paths` (tracked and untracked) as a commit on top of HEAD,
/// stores it at `refs/git-ai/backup/<id>` and logs the op. Returns the backup ref.
/// Uses a throwaway index instead of `git stash create`, which can't take paths or untracked files.
pub fn backup(repo: &Path, op: &str, paths: &[String]) -> Result<String, AppError> {
    let dir = git_ai_dir(repo)?;
    let index = dir.join("backup.index");
    let _ = fs::remove_file(&index);
    let env = [("GIT_INDEX_FILE", index.as_path())];
    let head = git(repo, &["rev-parse", "-q", "--verify", "HEAD"]).ok().map(|s| s.trim().to_string());
    if let Some(head) = &head {
        git_env(repo, &["read-tree", head], &env)?;
    }
    let add: Vec<&str> = ["add", "-A", "--"].into_iter().chain(paths.iter().map(String::as_str)).collect();
    git_env(repo, &add, &env)?;
    let tree = git_env(repo, &["write-tree"], &env)?;
    let _ = fs::remove_file(&index);

    let id = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis().to_string();
    let msg = format!("git-ai backup: {op}");
    // Fixed identity so backups work even when user.name/email aren't configured.
    let mut args = vec!["-c", "user.name=git-ai", "-c", "user.email=git-ai@localhost", "commit-tree", tree.trim(), "-m", &msg];
    if let Some(head) = &head {
        args.extend(["-p", head]);
    }
    let commit = git(repo, &args)?;
    let backup = format!("refs/git-ai/backup/{id}");
    git(repo, &["update-ref", &backup, commit.trim()])?;

    let line = json!({ "id": id, "op": op, "head": head, "paths": paths, "backup": backup });
    let mut log = fs::OpenOptions::new().create(true).append(true).open(dir.join("oplog.jsonl")).map_err(io)?;
    writeln!(log, "{line}").map_err(io)?;
    Ok(backup)
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
        cli::commit(p, "first").unwrap();

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
        let _ = fs::remove_dir_all(&dir);
    }
}
