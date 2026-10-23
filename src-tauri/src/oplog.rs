//! Undo support: backups under `refs/git-ai/backup/<id>` plus one JSON line per op in `.git/git-ai/oplog.jsonl`.
use crate::errors::AppError;
use crate::git::cli::{git, git_env, git_input, rev};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use ts_rs::TS;

const LOG: &str = "oplog.jsonl";

/// One line of the op log.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct OpEntry {
    /// Unix time in ms, also the backup ref name.
    pub id: String,
    /// "discard", "commit", "amend", "merge", "cherry-pick", "abort <op>", "create branch", "delete branch",
    /// "create tag", "delete tag", "drop stash", "pull", "push", "delete remote branch", "force push",
    /// "undo <op>" for the undo of an op, or a `note` ("switch", "fetch", ...).
    pub op: String,
    /// HEAD (or `ref_name`) before the op; None = the ref didn't exist.
    pub head: Option<String>,
    /// HEAD (or `ref_name`) after the op, when the op moved it; None = deleted. Undo moves it back.
    pub new_head: Option<String>,
    /// The ref `head`/`new_head` belong to, when not HEAD (e.g. "refs/heads/feature"). For a `note`, just the name shown.
    #[serde(default)]
    pub ref_name: Option<String>,
    #[serde(default)]
    pub paths: Vec<String>,
    /// Working-tree snapshot of `paths` taken before the op. Undo restores it.
    pub backup: Option<String>,
    /// For "undo": the id of the undone entry.
    pub undoes: Option<String>,
}

impl OpEntry {
    pub fn new(op: &str, head: Option<String>, new_head: Option<String>) -> Self {
        // Strictly increasing so two ops in the same ms still get distinct ids.
        // ponytail: unique per process only; two app instances on one repo could still collide.
        static LAST: Mutex<u128> = Mutex::new(0);
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis();
        let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
        *last = now.max(*last + 1);
        let id = last.to_string();
        Self { id, op: op.into(), head, new_head, ref_name: None, paths: vec![], backup: None, undoes: None }
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
pub(crate) fn snapshot(repo: &Path, op: &str, paths: &[String]) -> Result<OpEntry, AppError> {
    let index = git_ai_dir(repo)?.join("backup.index");
    let _ = fs::remove_file(&index);
    let env = [("GIT_INDEX_FILE", index.as_os_str())];
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

/// Logs an op undo can't reverse (switch, fetch, ...), so the history shows every action. `name` = what it
/// acted on ("" = nothing). Best effort: the op itself already succeeded.
pub fn note(repo: &Path, op: &str, name: &str) {
    let mut e = OpEntry::new(op, None, None);
    e.ref_name = (!name.is_empty()).then(|| name.to_string());
    let _ = record(repo, e);
}

pub fn record(repo: &Path, e: OpEntry) -> Result<(), AppError> {
    let line = serde_json::to_string(&e).map_err(|e| AppError::new("io", e.to_string()))?;
    let path = git_ai_dir(repo)?.join(LOG);
    let mut log = fs::OpenOptions::new().create(true).append(true).open(&path).map_err(io)?;
    writeln!(log, "{line}").map_err(io)?;
    drop(log);
    // The op itself succeeded; a failed cleanup just retries on the next one.
    let _ = prune(repo, &path, e.id.parse::<u128>().unwrap_or(0).saturating_sub(KEEP_MS));
    Ok(())
}

/// How long ops stay undoable.
const KEEP_MS: u128 = 30 * 24 * 60 * 60 * 1000;

/// Drops log entries older than `cutoff` (ms) and deletes their backup/kept refs so gc can free the content.
/// Only reads the first line when nothing has expired.
fn prune(repo: &Path, path: &Path, cutoff: u128) -> Result<(), AppError> {
    use std::io::BufRead;
    let id = |l: &str| serde_json::from_str::<OpEntry>(l).ok().and_then(|e| e.id.parse::<u128>().ok());
    let first = std::io::BufReader::new(fs::File::open(path).map_err(io)?).lines().next().and_then(Result::ok);
    if first.as_deref().and_then(id).is_some_and(|t| t >= cutoff) {
        return Ok(());
    }
    let text = fs::read_to_string(path).map_err(io)?;
    let kept: String = text.lines().filter(|l| id(l).is_some_and(|t| t >= cutoff)).map(|l| format!("{l}\n")).collect();
    // Write then rename, so a crash mid-write can't truncate the log.
    let tmp = path.with_extension("jsonl.tmp");
    fs::write(&tmp, kept).map_err(io)?;
    fs::rename(&tmp, path).map_err(io)?;
    let refs = git(repo, &["for-each-ref", "--format=%(refname)", "refs/git-ai/backup/", "refs/git-ai/kept/"])?;
    let old: String = refs
        .lines()
        .filter(|r| r.rsplit('/').next().and_then(|t| t.parse::<u128>().ok()).is_some_and(|t| t < cutoff))
        .map(|r| format!("delete {r}\n"))
        .collect();
    if !old.is_empty() {
        git_input(repo, &["update-ref", "--stdin"], &old)?;
    }
    Ok(())
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
    let op = format!("undo {}", e.op);
    let moved = |r: &str| {
        let name = r.strip_prefix("refs/heads/").unwrap_or(r);
        AppError::new("moved", format!("{name} has changed since this operation (a newer commit, checkout or branch), so it can't be undone."))
    };
    let dirty = || AppError::new("dirty", "Your uncommitted changes touch files this undo would change. Commit, stash or discard them first.");
    let mut u = if let Some(backup) = &e.backup {
        let u = snapshot(repo, &op, &e.paths)?;
        // reset --hard: HEAD goes back first, then the backed-up changes on top.
        if let (Some(old), Some(new)) = (&e.head, &e.new_head) {
            if git(repo, &["rev-parse", "HEAD"])?.trim() != new {
                return Err(moved("HEAD"));
            }
            git(repo, &["reset", "-q", "--keep", old]).map_err(|_| dirty())?;
        }
        let args: Vec<&str> = ["restore", "--source", backup, "--worktree", "--"]
            .into_iter()
            .chain(e.paths.iter().map(String::as_str))
            .collect();
        git(repo, &args)?;
        if e.op.starts_with("take ") {
            // Taking a side marked the file resolved; git keeps the conflict stages (resolve-undo), put them back.
            let args: Vec<&str> = ["update-index", "--unresolve", "--"].into_iter().chain(e.paths.iter().map(String::as_str)).collect();
            git(repo, &args)?;
        }
        u
    } else if let ("drop stash", Some(oid)) = (e.op.as_str(), &e.head) {
        let msg = git(repo, &["log", "-1", "--format=%s", oid])?;
        git(repo, &["stash", "store", "-m", msg.trim(), oid])?;
        OpEntry::new(&op, None, None)
    } else if let ("delete remote branch" | "force push" | "push", Some(r)) = (e.op.as_str(), &e.ref_name) {
        // A push is undone by force-pushing the old tip back, only while the remote is still at ours.
        // No old tip: the push created the remote branch, and the "" oid deletes it.
        let old = e.head.as_deref().unwrap_or("");
        crate::git::cli::restore_remote_branch(repo, r.strip_prefix("refs/remotes/").unwrap_or(r), old, e.new_head.as_deref())?;
        // Not undoable itself (no refs to swap back); delete or force push again instead.
        OpEntry::new(&op, None, None)
    } else if e.head.is_some() || e.new_head.is_some() {
        // Compare-and-swap back to `head`: "" as the old value means "must not exist", -d deletes.
        let r = e.ref_name.as_deref().unwrap_or("HEAD");
        // Rebase, pull, merge: files must follow HEAD back. `reset --keep` keeps local edits and
        // refuses when they'd be overwritten. Amend and soft/mixed resets left their changes in the
        // index / working tree, so the same mode puts HEAD (and index) back without touching files.
        let mode = match e.op.trim_start_matches("undo ") {
            "commit" | "amend" | "reset --soft" => "--soft",
            "reset --mixed" => "--mixed",
            _ => "--keep",
        };
        // Undoing "create branch" on the checked-out branch would leave HEAD pointing at nothing.
        if e.head.is_none() && r != "HEAD" && git(repo, &["symbolic-ref", "-q", "HEAD"]).is_ok_and(|h| h.trim() == r) {
            let name = r.strip_prefix("refs/heads/").unwrap_or(r);
            return Err(AppError::new("current", format!("{name} is checked out. Switch to another branch first, then undo.")));
        }
        let res = match (&e.head, &e.new_head) {
            (Some(old), Some(new)) if r == "HEAD" && git(repo, &["rev-parse", "HEAD"])?.trim() == new => {
                git(repo, &["reset", "-q", mode, old]).map_err(|_| dirty())?;
                Ok(String::new())
            }
            (Some(old), new) => git(repo, &["update-ref", "-m", "git-ai: undo", r, old, new.as_deref().unwrap_or("")]),
            (None, Some(new)) => git(repo, &["update-ref", "-m", "git-ai: undo", "-d", r, new]),
            (None, None) => unreachable!(),
        };
        res.map_err(|_| moved(r))?;
        let mut u = OpEntry::new(&op, e.new_head.clone(), e.head.clone());
        u.ref_name = e.ref_name.clone();
        u
    } else {
        return Err(AppError::new("not_undoable", "This operation can't be undone."));
    };
    // Keeps the name for the label ("Undo: Force push origin/main").
    u.ref_name = u.ref_name.or_else(|| e.ref_name.clone());
    u.undoes = Some(e.id);
    record(repo, u)
}

/// Removes one entry from the history for good, with the entries it undid (else they'd show again),
/// and deletes their backup/kept refs.
pub fn forget(repo: &Path, id: &str) -> Result<(), AppError> {
    let path = git_ai_dir(repo)?.join(LOG);
    let text = fs::read_to_string(&path).unwrap_or_default();
    let all: Vec<(&str, Option<OpEntry>)> = text.lines().map(|l| (l, serde_json::from_str(l).ok())).collect();
    let mut gone = vec![id.to_string()];
    let mut next = Some(id.to_string());
    while let Some(cur) = next.take() {
        next = all.iter().filter_map(|(_, e)| e.as_ref()).find(|e| e.id == cur).and_then(|e| e.undoes.clone());
        gone.extend(next.clone());
    }
    let kept: String = all
        .iter()
        .filter(|(_, e)| !e.as_ref().is_some_and(|e| gone.contains(&e.id)))
        .map(|(l, _)| format!("{l}\n"))
        .collect();
    let tmp = path.with_extension("jsonl.tmp");
    fs::write(&tmp, kept).map_err(io)?;
    fs::rename(&tmp, &path).map_err(io)?;
    // `delete <ref>` with no old value is a no-op when the ref doesn't exist.
    let refs: String = gone.iter().flat_map(|g| [format!("delete refs/git-ai/backup/{g}\n"), format!("delete refs/git-ai/kept/{g}\n")]).collect();
    git_input(repo, &["update-ref", "--stdin"], &refs)?;
    Ok(())
}

pub(crate) fn git_ai_dir(repo: &Path) -> Result<PathBuf, AppError> {
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

    fn temp_repo(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("git-ai-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let p = dir.as_path();
        git(p, &["init", "-q", "-b", "main"]).unwrap();
        git(p, &["config", "user.name", "t"]).unwrap();
        git(p, &["config", "user.email", "t@t"]).unwrap();
        git(p, &["config", "core.autocrlf", "false"]).unwrap();
        dir
    }

    /// Merge (conflict, abort, finish), cherry-pick, tags and stashes, with undo.
    #[test]
    fn reset_to_and_undo() {
        use cli::ResetMode::*;
        let dir = temp_repo("reset");
        let p = dir.as_path();
        let commit = |text: &str| {
            fs::write(dir.join("a.txt"), text).unwrap();
            cli::stage(p, &["a.txt".to_string()]).unwrap();
            cli::commit(p, text, false).unwrap();
        };
        commit("base\n");
        let base = cli::rev(p, "HEAD").unwrap();
        cli::create_branch(p, "other", None, false).unwrap();
        commit("mine\n");
        let mine = cli::rev(p, "HEAD").unwrap();

        // An edit to a file the reset changes: refused, nothing moves.
        fs::write(dir.join("a.txt"), "edit\n").unwrap();
        assert_eq!(cli::reset_to(p, "other", Keep).unwrap_err().code, "dirty");
        assert_eq!(cli::rev(p, "HEAD").unwrap(), mine);
        git(p, &["checkout", "--", "a.txt"]).unwrap();

        cli::reset_to(p, "other", Keep).unwrap();
        assert_eq!(cli::rev(p, "HEAD").unwrap(), base);
        assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "base\n");
        let top = || super::entries(p, 1).unwrap()[0].clone();
        assert_eq!(top().op, "reset");
        super::undo(p, &top().id).unwrap();
        assert_eq!(cli::rev(p, "HEAD").unwrap(), mine);
        assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "mine\n");
        let clean = || git(p, &["status", "--porcelain"]).unwrap();

        // Soft: the dropped change stays staged; mixed: unstaged. Undo leaves a clean tree at `mine`.
        for (mode, st) in [(Soft, "M  a.txt\n"), (Mixed, " M a.txt\n")] {
            cli::reset_to(p, &base, mode).unwrap();
            assert_eq!((cli::rev(p, "HEAD").unwrap(), clean()), (base.clone(), st.to_string()));
            super::undo(p, &top().id).unwrap();
            assert_eq!((cli::rev(p, "HEAD").unwrap(), clean()), (mine.clone(), String::new()));
        }

        // Hard: edits to tracked files are wiped (untracked stay); one undo brings back HEAD and the edits.
        fs::write(dir.join("a.txt"), "edit\n").unwrap();
        fs::write(dir.join("u.txt"), "untracked\n").unwrap();
        cli::reset_to(p, &base, Hard).unwrap();
        assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "base\n");
        assert_eq!((cli::rev(p, "HEAD").unwrap(), clean()), (base.clone(), "?? u.txt\n".to_string()));
        assert_eq!(top().op, "reset --hard");
        super::undo(p, &top().id).unwrap();
        assert_eq!(cli::rev(p, "HEAD").unwrap(), mine);
        assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "edit\n");
    }

    #[test]
    fn merge_tag_stash() {
        let dir = temp_repo("merge");
        let p = dir.as_path();
        let commit = |file: &str, text: &str, msg: &str| {
            fs::write(dir.join(file), text).unwrap();
            cli::stage(p, &[file.to_string()]).unwrap();
            cli::commit(p, msg, false).unwrap();
        };
        let top = || super::entries(p, 20).unwrap()[0].clone();
        commit("a.txt", "base
", "base");
        cli::create_branch(p, "feat", None, true).unwrap();
        commit("a.txt", "feat
", "feat change");
        commit("b.txt", "b
", "add b");
        let feat_b = cli::rev(p, "HEAD").unwrap();
        cli::checkout(p, "main", false, false).unwrap();
        commit("a.txt", "main
", "main change");
        let main = cli::rev(p, "HEAD").unwrap();

        // Conflicting merge stays in progress; abort restores main and backs up the conflicted file.
        assert_eq!(cli::merge(p, "feat", false).unwrap_err().code, "conflicts");
        assert_eq!(cli::status(p).unwrap().operation.as_deref(), Some("merge"));
        assert_eq!(cli::status(p).unwrap().step.as_deref(), Some("Merge branch 'feat'"));
        cli::abort(p).unwrap();
        assert_eq!(cli::status(p).unwrap().operation, None);
        assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "main
");
        assert_eq!(top().op, "abort merge");

        // Resolve and commit with git's message; undo moves main back.
        cli::merge(p, "feat", false).unwrap_err();
        commit("a.txt", "both
", "");
        assert_eq!(git(p, &["log", "-1", "--format=%s"]).unwrap().trim(), "Merge branch 'feat'");
        assert_eq!(top().op, "merge");
        super::undo(p, &top().id).unwrap();
        assert_eq!(cli::rev(p, "HEAD").unwrap(), main);
        assert_eq!(top().op, "undo merge");
        git(p, &["reset", "-q", "--hard"]).unwrap();

        // Clean cherry-pick is logged.
        cli::merge(p, &feat_b, true).unwrap();
        assert_eq!(fs::read_to_string(dir.join("b.txt")).unwrap(), "b
");
        assert_eq!(top().op, "cherry-pick");

        // Clean merge by commit id (History's "Merge into current"): merge commit, logged, undoable.
        cli::create_branch(p, "side", None, true).unwrap();
        commit("c.txt", "c\n", "add c");
        let side = cli::rev(p, "HEAD").unwrap();
        cli::checkout(p, "main", false, false).unwrap();
        commit("d.txt", "d\n", "add d");
        let before = cli::rev(p, "HEAD").unwrap();
        cli::merge(p, &side, false).unwrap();
        assert_eq!(git(p, &["rev-list", "--parents", "-n1", "HEAD"]).unwrap().split_whitespace().count(), 3);
        assert_eq!(fs::read_to_string(dir.join("c.txt")).unwrap(), "c\n");
        assert_eq!(top().op, "merge");
        super::undo(p, &top().id).unwrap();
        assert_eq!(cli::rev(p, "HEAD").unwrap(), before);
        git(p, &["reset", "-q", "--hard"]).unwrap();

        // Tags: annotated delete + undo brings back the same tag object.
        cli::create_tag(p, "v1", &main, "release").unwrap();
        let tag = cli::rev(p, "refs/tags/v1").unwrap();
        cli::delete_tag(p, "v1").unwrap();
        assert!(cli::rev(p, "refs/tags/v1").is_err());
        super::undo(p, &top().id).unwrap();
        assert_eq!(cli::rev(p, "refs/tags/v1").unwrap(), tag);

        // Stash: save, stale index refused, drop + undo, pop.
        fs::write(dir.join("a.txt"), "wip
").unwrap();
        fs::write(dir.join("new.txt"), "new
").unwrap();
        cli::stash_save(p, "wip", cli::StashMode::All, false, &[]).unwrap();
        assert!(!dir.join("new.txt").exists());
        let oid = cli::rev(p, "stash@{0}").unwrap();
        assert_eq!(cli::stash(p, cli::StashOp::Drop, 0, "nope").unwrap_err().code, "stale");
        cli::stash(p, cli::StashOp::Drop, 0, &oid).unwrap();
        assert!(cli::rev(p, "stash@{0}").is_err());
        super::undo(p, &top().id).unwrap();
        assert_eq!(cli::rev(p, "stash@{0}").unwrap(), oid);
        cli::stash(p, cli::StashOp::Pop, 0, &oid).unwrap();
        assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "wip
");
        assert_eq!(fs::read_to_string(dir.join("new.txt")).unwrap(), "new
");
        assert_eq!(top().op, "drop stash");

        // Checkpoint keeps the files; staged-only leaves the rest; nothing to stash is an error.
        cli::stash_save(p, "", cli::StashMode::All, true, &[]).unwrap();
        assert!(dir.join("new.txt").exists());
        assert!(cli::rev(p, "stash@{0}").is_ok());
        git(p, &["add", "a.txt"]).unwrap();
        cli::stash_save(p, "staged", cli::StashMode::Staged, false, &[]).unwrap();
        assert_ne!(fs::read_to_string(dir.join("a.txt")).unwrap(), "wip\n");
        assert!(dir.join("new.txt").exists());
        assert_eq!(cli::stash_save(p, "", cli::StashMode::Staged, false, &[]).unwrap_err().code, "empty");

        // Only some paths; rename; pop brings staging back; branch from a stash.
        cli::stash_save(p, "one", cli::StashMode::All, false, &["new.txt".into()]).unwrap();
        assert!(!dir.join("new.txt").exists());
        let one = cli::rev(p, "stash@{0}").unwrap();
        cli::stash(p, cli::StashOp::Pop, 2, &cli::rev(p, "stash@{2}").unwrap()).unwrap(); // the checkpoint
        cli::stash_rename(p, 1, &cli::rev(p, "stash@{1}").unwrap(), "On main: renamed").unwrap();
        assert_eq!(git(p, &["stash", "list", "--format=%gs"]).unwrap(), "On main: renamed
On main: one
");
        assert_eq!(cli::rev(p, "stash@{1}").unwrap(), one);
        git(p, &["reset", "-q", "--hard"]).unwrap();
        cli::stash_branch(p, 0, &cli::rev(p, "stash@{0}").unwrap(), "from-stash").unwrap();
        assert_eq!(git(p, &["branch", "--show-current"]).unwrap().trim(), "from-stash");
        assert!(git(p, &["diff", "--cached", "--name-only"]).unwrap().contains("a.txt"), "staging restored");
        assert_eq!(top().op, "drop stash");
        let _ = fs::remove_dir_all(&dir);
    }

    /// Push (sets upstream), fetch, rejected push, pull, tag push and remote branch delete + undo,
    /// against a local bare remote.
    #[test]
    fn remote_ops() {
        let tmp = std::env::temp_dir();
        let bare = tmp.join(format!("git-ai-test-bare-{}", std::process::id()));
        let b = tmp.join(format!("git-ai-test-rb-{}", std::process::id()));
        for d in [&bare, &b] {
            let _ = fs::remove_dir_all(d);
        }
        let (bare_s, b_s) = (bare.to_str().unwrap(), b.to_str().unwrap());
        let here = std::path::Path::new(".");
        git(here, &["init", "-q", "--bare", "-b", "main", bare_s]).unwrap();
        let a = temp_repo("ra");
        let a = a.as_path();
        let commit = |repo: &std::path::Path, file: &str, msg: &str| {
            fs::write(repo.join(file), msg).unwrap();
            cli::stage(repo, &[file.to_string()]).unwrap();
            cli::commit(repo, msg, false).unwrap();
        };
        let top = || super::entries(a, 20).unwrap()[0].clone();

        assert_eq!(cli::push(a, false, &Default::default()).unwrap_err().code, "no_remote");
        git(a, &["remote", "add", "origin", bare_s]).unwrap();
        commit(a, "a.txt", "one");
        cli::push(a, false, &Default::default()).unwrap();
        assert_eq!(git(a, &["config", "branch.main.merge"]).unwrap().trim(), "refs/heads/main");

        // A second clone pushes first, so a's push is rejected until it pulls (a merge, undoable).
        git(here, &["clone", "-q", bare_s, b_s]).unwrap();
        for kv in [["user.name", "t"], ["user.email", "t@t"], ["core.autocrlf", "false"]] {
            git(&b, &["config", kv[0], kv[1]]).unwrap();
        }
        commit(&b, "b.txt", "from b");
        cli::push(&b, false, &Default::default()).unwrap();
        commit(a, "c.txt", "from a");
        let before = cli::rev(a, "HEAD").unwrap();
        assert_eq!(cli::push(a, false, &Default::default()).unwrap_err().code, "rejected");
        // Upstream-only fetch (auto fetch) moves origin/main like a full fetch.
        cli::fetch_upstream(a).unwrap();
        assert_eq!(cli::rev(a, "origin/main").unwrap(), cli::rev(&b, "HEAD").unwrap());
        cli::fetch(a).unwrap();
        cli::pull(a, false).unwrap();
        assert_eq!(fs::read_to_string(a.join("b.txt")).unwrap(), "from b");
        assert_eq!(top().op, "pull");
        super::undo(a, &top().id).unwrap();
        assert_eq!(cli::rev(a, "HEAD").unwrap(), before);
        git(a, &["reset", "-q", "--hard"]).unwrap();
        cli::pull(a, false).unwrap();
        cli::push(a, false, &Default::default()).unwrap();

        // Tag push.
        cli::create_tag(a, "v1", "HEAD", "").unwrap();
        cli::push_tag(a, "v1", false).unwrap();
        assert_eq!(cli::rev(&bare, "refs/tags/v1").unwrap(), cli::rev(a, "HEAD").unwrap());
        // The tag moved here: a plain push is refused as tag_exists, force replaces it.
        let tip = cli::rev(a, "HEAD").unwrap();
        commit(a, "d.txt", "after v1");
        git(a, &["tag", "-f", "v1"]).unwrap();
        assert_eq!(cli::push_tag(a, "v1", false).unwrap_err().code, "tag_exists");
        assert_eq!(cli::rev(&bare, "refs/tags/v1").unwrap(), tip);
        cli::push_tag(a, "v1", true).unwrap();
        assert_eq!(cli::rev(&bare, "refs/tags/v1").unwrap(), cli::rev(a, "HEAD").unwrap());
        cli::push(a, false, &Default::default()).unwrap();

        // Push dialog options: another branch name, all tags, upstream left as it was.
        cli::create_tag(a, "v2", "HEAD", "").unwrap();
        let opts = cli::PushOpts { remote: Some("origin".into()), branch: Some("copy".into()), track: Some(false), tags: true };
        assert_eq!(cli::push(a, false, &opts).unwrap(), "origin/copy");
        assert_eq!(cli::rev(&bare, "refs/heads/copy").unwrap(), cli::rev(a, "HEAD").unwrap());
        assert!(cli::rev(&bare, "refs/tags/v2").is_ok());
        assert_eq!(git(a, &["config", "branch.main.merge"]).unwrap().trim(), "refs/heads/main");
        // That push created origin/copy, so its undo deletes it there.
        let pushed = super::entries(a, 1).unwrap()[0].clone();
        assert_eq!((pushed.op.as_str(), pushed.head.as_deref()), ("push", None));
        super::undo(a, &pushed.id).unwrap();
        assert!(cli::rev(&bare, "refs/heads/copy").is_err());

        // PR target: a local branch is pushed (and tracks), a remote branch is used as is.
        cli::create_branch(a, "pr", None, false).unwrap();
        let any = &|_: &str| Ok(());
        // A remote the check refuses (not on GitHub) gets nothing pushed.
        let no = &|_: &str| Err(crate::errors::AppError::new("not_github", "no"));
        assert_eq!(cli::pr_branches(a, "pr", "origin/main", no).unwrap_err().code, "not_github");
        assert!(cli::rev(&bare, "refs/heads/pr").is_err());
        assert_eq!(cli::pr_branches(a, "pr", "origin/main", any).unwrap(), (bare_s.to_string(), "pr".into(), "main".into()));
        assert_eq!(cli::rev(&bare, "refs/heads/pr").unwrap(), cli::rev(a, "pr").unwrap());
        assert_eq!(cli::pr_branches(a, "origin/pr", "main", any).unwrap().1, "pr");
        assert_eq!(cli::pr_branches(a, "", "pr", any).unwrap().1, "main");
        assert_eq!(cli::pr_branches(a, "v1", "main", any).unwrap_err().code, "not_branch");

        // Remote branch delete; undo pushes it back; that undo itself can't be undone.
        git(a, &["push", "-q", "origin", "main:refs/heads/feat"]).unwrap();
        let tip = cli::rev(a, "origin/feat").unwrap();
        assert_eq!(cli::delete_remote_branch(a, "nope/feat").unwrap_err().code, "no_remote");
        cli::delete_remote_branch(a, "origin/feat").unwrap();
        assert!(cli::rev(&bare, "refs/heads/feat").is_err());
        assert!(cli::rev(a, "refs/remotes/origin/feat").is_err());
        assert_eq!(top().op, "delete remote branch");
        super::undo(a, &top().id).unwrap();
        assert_eq!(cli::rev(&bare, "refs/heads/feat").unwrap(), tip);
        assert_eq!(top().op, "undo delete remote branch");
        assert_eq!(super::undo(a, &top().id).unwrap_err().code, "not_undoable");

        // Force push: refused while a hasn't seen b's commit (lease), then overwrites; undo puts b's tip back.
        git(&b, &["pull", "-q", "--no-rebase"]).unwrap();
        commit(&b, "d.txt", "from b again");
        cli::push(&b, false, &Default::default()).unwrap();
        let theirs = cli::rev(&b, "HEAD").unwrap();
        commit(a, "e.txt", "rewritten");
        // Someone else pushed: a plain "rejected" (pull is the fix).
        assert_eq!(cli::push(a, false, &Default::default()).unwrap_err().code, "rejected");
        assert_eq!(cli::push(a, true, &Default::default()).unwrap_err().code, "stale_remote");
        cli::fetch(a).unwrap();
        cli::push(a, true, &Default::default()).unwrap();
        assert_eq!(cli::rev(&bare, "refs/heads/main").unwrap(), cli::rev(a, "HEAD").unwrap());
        // a rewrote what it pushed: "rewritten" (force push is the fix). Nothing is pushed.
        git(a, &["commit", "-q", "--amend", "-m", "rewritten again"]).unwrap();
        assert_eq!(cli::push(a, false, &Default::default()).unwrap_err().code, "rewritten");
        git(a, &["reset", "-q", "--hard", "HEAD@{1}"]).unwrap();
        assert_eq!(top().op, "force push");
        super::undo(a, &top().id).unwrap();
        assert_eq!(cli::rev(&bare, "refs/heads/main").unwrap(), theirs);
        for d in [&bare, &b, &a.to_path_buf()] {
            let _ = fs::remove_dir_all(d);
        }
    }

    /// Clone with progress, then conflicts resolved by taking a side (edit/edit and edit/delete).
    #[test]
    fn clone_and_resolve() {
        let src = temp_repo("clsrc");
        let s = src.as_path();
        let commit = |file: &str, text: Option<&str>, msg: &str| {
            match text {
                Some(t) => fs::write(src.join(file), t).unwrap(),
                None => fs::remove_file(src.join(file)).unwrap(),
            }
            cli::stage(s, &[file.to_string()]).unwrap();
            cli::commit(s, msg, false).unwrap();
        };
        commit("a.txt", Some("base\n"), "base");
        commit("b.txt", Some("base\n"), "add b");

        let dest = std::env::temp_dir().join(format!("git-ai-test-cldst-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dest);
        let mut lines = Vec::new();
        cli::clone(s.to_str().unwrap(), &dest, |l| lines.push(l.to_string())).unwrap();
        assert_eq!(fs::read_to_string(dest.join("b.txt")).unwrap().trim_end(), "base"); // global autocrlf may add CR
        assert!(!lines.is_empty(), "no progress lines");
        assert_eq!(cli::clone(s.to_str().unwrap(), &dest, |_| {}).unwrap_err().code, "exists"); // dest not empty
        assert_eq!(cli::clone("-x", &dest, |_| {}).unwrap_err().code, "bad_url");

        // feat edits a.txt and deletes b.txt; main edits both.
        cli::create_branch(s, "feat", None, true).unwrap();
        commit("a.txt", Some("feat\n"), "feat a");
        commit("b.txt", None, "feat rm b");
        cli::checkout(s, "main", false, false).unwrap();
        commit("a.txt", Some("main\n"), "main a");
        commit("b.txt", Some("main\n"), "main b");
        cli::merge(s, "feat", false).unwrap_err();
        let kinds: Vec<_> = cli::status(s).unwrap().conflicted.into_iter().map(|f| (f.path, f.kind)).collect();
        assert_eq!(kinds, [("a.txt".into(), "UU".into()), ("b.txt".into(), "UD".into())]);
        assert!(crate::git::read::work_file(s, "a.txt").unwrap().unwrap().contains("<<<<<<<"));

        cli::resolve(s, &["a.txt".into()], cli::Side::Theirs).unwrap();
        assert_eq!(fs::read_to_string(src.join("a.txt")).unwrap(), "feat\n");
        let take = super::entries(s, 20).unwrap().remove(0);
        assert_eq!(take.op, "take theirs");
        super::undo(s, &take.id).unwrap(); // conflict is back: markers and UU
        assert!(fs::read_to_string(src.join("a.txt")).unwrap().contains("<<<<<<<"));
        assert_eq!(cli::status(s).unwrap().conflicted[0].kind, "UU");
        cli::resolve(s, &["a.txt".into()], cli::Side::Theirs).unwrap();
        cli::resolve(s, &["b.txt".into()], cli::Side::Theirs).unwrap(); // theirs deleted it
        assert!(!src.join("b.txt").exists());
        let st = cli::status(s).unwrap();
        assert!(st.conflicted.is_empty());
        cli::commit(s, "", false).unwrap();
        for d in [&src, &dest] {
            let _ = fs::remove_dir_all(d);
        }
    }

    /// Entries older than KEEP_MS leave the log on the next op, along with their backup/kept refs.
    #[test]
    fn prune_old_entries() {
        let dir = temp_repo("prune");
        let p = dir.as_path();
        fs::write(dir.join("a.txt"), "a\n").unwrap();
        cli::stage(p, &["a.txt".into()]).unwrap();
        // Raw git: a logged commit would sit before the old entry, and prune only checks the first line.
        git(p, &["commit", "-q", "-m", "c"]).unwrap();
        let head = cli::rev(p, "HEAD").unwrap();
        for r in ["refs/git-ai/backup/1000", "refs/git-ai/kept/1000"] {
            git(p, &["update-ref", r, &head]).unwrap();
        }
        let mut old = super::OpEntry::new("discard", None, None);
        old.id = "1000".into();
        super::record(p, old).unwrap();
        assert_eq!(super::entries(p, 20).unwrap().len(), 1);
        let new = super::OpEntry::new("discard", None, None);
        let id = new.id.clone();
        super::record(p, new).unwrap();
        let ids: Vec<_> = super::entries(p, 20).unwrap().into_iter().map(|e| e.id).collect();
        assert_eq!(ids, [id.clone()]);
        assert_eq!(git(p, &["for-each-ref", "refs/git-ai/"]).unwrap(), "");

        // Forget: the entry, the ones it undid (so they don't reappear) and their backups go.
        fs::write(dir.join("a.txt"), "edit\n").unwrap();
        cli::discard(p, &["a.txt".into()]).unwrap();
        let discard = super::entries(p, 1).unwrap()[0].id.clone();
        super::undo(p, &discard).unwrap();
        let undo = super::entries(p, 1).unwrap()[0].id.clone();
        super::forget(p, &undo).unwrap();
        let ids: Vec<_> = super::entries(p, 20).unwrap().into_iter().map(|e| e.id).collect();
        assert_eq!(ids, [id]);
        assert_eq!(git(p, &["for-each-ref", "refs/git-ai/"]).unwrap(), "");
        let _ = fs::remove_dir_all(&dir);
    }

    /// Stage, unstage, commit, discard (with backup) on a throwaway repo.
    #[test]
    fn write_ops_round_trip() {
        let dir = temp_repo("ops");
        let p = dir.as_path();
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
        let diff = crate::git::read::file_diff(p, "a.txt", false, false).unwrap().unwrap();
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

        // Branches: create + switch, commit on it, unmerged delete needs force, undo brings it back.
        let base = git(p, &["branch", "--show-current"]).unwrap().trim().to_string();
        cli::create_branch(p, "feat", None, true).unwrap();
        cli::stage(p, &files(&["a.txt"])).unwrap();
        cli::commit(p, "on feat", false).unwrap();
        let tip = cli::rev(p, "feat").unwrap();
        // A plain commit is logged: undo puts HEAD back with the change staged, redo puts it back.
        let c = super::entries(p, 1).unwrap()[0].clone();
        assert_eq!(c.op, "commit");
        super::undo(p, &c.id).unwrap();
        assert_ne!(cli::rev(p, "HEAD").unwrap(), tip);
        assert_eq!(cli::status(p).unwrap().staged.len(), 1);
        super::undo(p, &super::entries(p, 1).unwrap()[0].id).unwrap();
        assert_eq!(cli::rev(p, "HEAD").unwrap(), tip);
        // Undoing "create branch" is refused while it is checked out.
        let created = super::entries(p, 20).unwrap().into_iter().find(|e| e.op == "create branch").unwrap();
        assert_eq!(created.ref_name.as_deref(), Some("refs/heads/feat"));
        assert_eq!(super::undo(p, &created.id).unwrap_err().code, "current");
        // Start point: a branch made on feat from base points at base, and HEAD stays put.
        cli::create_branch(p, "off-base", Some(&base), false).unwrap();
        assert_eq!(cli::rev(p, "off-base").unwrap(), cli::rev(p, &base).unwrap());
        assert_eq!(cli::rev(p, "HEAD").unwrap(), tip);
        // Elsewhere, undoing "create branch" deletes it.
        super::undo(p, &super::entries(p, 1).unwrap()[0].id).unwrap();
        assert!(cli::rev(p, "refs/heads/off-base").is_err());
        cli::create_branch(p, "off-base", Some(&base), false).unwrap();
        cli::delete_branch(p, "off-base", false).unwrap();
        cli::checkout(p, &base, false, false).unwrap();
        assert_eq!(cli::delete_branch(p, "feat", false).unwrap_err().code, "not_merged");
        cli::delete_branch(p, "feat", true).unwrap();
        assert!(cli::rev(p, "refs/heads/feat").is_err());
        let del = super::entries(p, 20).unwrap()[0].clone();
        super::undo(p, &del.id).unwrap();
        assert_eq!(cli::rev(p, "refs/heads/feat").unwrap(), tip);
        // Undo the undo: deleted again.
        let undo = super::entries(p, 20).unwrap()[0].clone();
        super::undo(p, &undo.id).unwrap();
        assert!(cli::rev(p, "refs/heads/feat").is_err());
        assert_eq!(cli::create_branch(p, "-x", None, false).unwrap_err().code, "bad_name");
        let refs = crate::git::read::refs(p).unwrap();
        assert_eq!((refs.head.as_deref(), refs.local.len()), (Some(base.as_str()), 1));
        let _ = fs::remove_dir_all(&dir);
    }

    /// Checkout with conflicting local changes: refused, then carried over (clean and conflicting pop).
    #[test]
    fn checkout_carry() {
        let dir = temp_repo("carry");
        let p = dir.as_path();
        let commit = |file: &str, text: &str| {
            fs::write(dir.join(file), text).unwrap();
            cli::stage(p, &[file.to_string()]).unwrap();
            cli::commit(p, "c", false).unwrap();
        };
        commit("a.txt", "base
");
        commit("b.txt", "b
");
        cli::create_branch(p, "feat", None, true).unwrap();
        commit("b.txt", "feat
");
        cli::checkout(p, "main", false, false).unwrap();

        // Any change stops a plain switch, even one git could carry; carry brings the edit and the new file along.
        fs::write(dir.join("new.txt"), "new").unwrap();
        assert_eq!(cli::checkout(p, "feat", false, false).unwrap_err().code, "dirty");
        fs::write(dir.join("b.txt"), "b
mine
").unwrap();
        fs::write(dir.join("new.txt"), "new").unwrap();
        assert_eq!(cli::checkout(p, "feat", false, false).unwrap_err().code, "dirty");
        cli::checkout(p, "main", false, true).unwrap(); // same branch: stash round-trips, changes stay
        assert_eq!(fs::read_to_string(dir.join("b.txt")).unwrap(), "b
mine
");
        // Clash: rolled back to main with the changes, no conflict markers, no stash left.
        assert_eq!(cli::checkout(p, "feat", false, true).unwrap_err().code, "clash");
        let st = cli::status(p).unwrap();
        assert_eq!(st.branch.as_deref(), Some("main"));
        assert!(st.conflicted.is_empty());
        assert_eq!(fs::read_to_string(dir.join("b.txt")).unwrap(), "b
mine
");
        assert_eq!(fs::read_to_string(dir.join("new.txt")).unwrap(), "new");
        assert!(crate::git::read::refs(p).unwrap().stashes.is_empty());

        // Non-conflicting edit: clean carry, no stash left behind.
        let dir2 = temp_repo("carry2");
        let q = dir2.as_path();
        fs::write(dir2.join("a.txt"), "a
").unwrap();
        cli::stage(q, &["a.txt".into()]).unwrap();
        cli::commit(q, "c", false).unwrap();
        cli::create_branch(q, "feat", None, false).unwrap();
        fs::write(dir2.join("a.txt"), "edit
").unwrap();
        cli::checkout(q, "feat", false, true).unwrap();
        assert_eq!(fs::read_to_string(dir2.join("a.txt")).unwrap(), "edit
");
        assert!(crate::git::read::refs(q).unwrap().stashes.is_empty());

        // New branch from a start point that clashes with the changes: rolled back, branch not left behind.
        let dir3 = temp_repo("carry3");
        let r = dir3.as_path();
        let commit = |text: &str| {
            fs::write(dir3.join("a.txt"), text).unwrap();
            cli::stage(r, &["a.txt".into()]).unwrap();
            cli::commit(r, "c", false).unwrap();
        };
        commit("base\n");
        cli::create_branch(r, "feat", None, true).unwrap();
        commit("feat\n");
        cli::checkout(r, "main", false, false).unwrap();
        fs::write(dir3.join("a.txt"), "mine\n").unwrap();
        assert_eq!(cli::create_branch(r, "nb", Some("feat"), true).unwrap_err().code, "clash");
        assert_eq!(cli::status(r).unwrap().branch.as_deref(), Some("main"));
        assert_eq!(fs::read_to_string(dir3.join("a.txt")).unwrap(), "mine\n");
        let refs = crate::git::read::refs(r).unwrap();
        assert!(refs.stashes.is_empty() && !refs.local.iter().any(|b| b.name == "nb"));
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&dir2);
        let _ = fs::remove_dir_all(&dir3);
    }

    /// Interactive rebase: reorder, reword, squash, fixup, drop, undo; then a conflict continued by commit.
    #[test]
    fn interactive_rebase() {
        use cli::{RebaseAction::*, RebaseStep};
        let dir = temp_repo("rebase");
        let p = dir.as_path();
        let commit = |file: &str, text: &str, msg: &str| {
            fs::write(dir.join(file), text).unwrap();
            cli::stage(p, &[file.to_string()]).unwrap();
            cli::commit(p, msg, false).unwrap();
            cli::rev(p, "HEAD").unwrap()
        };
        let base = commit("a.txt", "a\n", "base");
        let [c1, c2, c3, c4, c5] = [("1", "one"), ("2", "two"), ("3", "three"), ("4", "four"), ("5", "five")]
            .map(|(f, m)| commit(&format!("{f}.txt"), f, m));
        let step = |oid: &str, action, message: Option<&str>| RebaseStep { oid: oid.into(), action, message: message.map(Into::into) };
        let log = || git(p, &["log", "--format=%B--", &format!("{base}..HEAD")]).unwrap().replace('\n', "|");
        let before = cli::rev(p, "HEAD").unwrap();

        // A stale list (missing c5) is refused.
        let steps = vec![step(&c1, Pick, None)];
        assert_eq!(cli::rebase(p, &base, &steps).unwrap_err().code, "stale");
        assert_eq!(cli::rebase(p, &base, &[step(&c1, Squash, None), step(&c2, Pick, None), step(&c3, Pick, None), step(&c4, Pick, None), step(&c5, Pick, None)]).unwrap_err().code, "bad_squash");

        fs::write(dir.join("a.txt"), "dirty\n").unwrap(); // carried by --autostash
        let steps = [
            step(&c3, Pick, Some("THREE")),
            step(&c1, Pick, None),
            step(&c2, Squash, Some("one+two")),
            step(&c4, Fixup, None),
            step(&c5, Drop, None),
        ];
        cli::rebase(p, &base, &steps).unwrap();
        assert_eq!(log(), "one+two|--|THREE|--|");
        assert!(dir.join("4.txt").exists() && !dir.join("5.txt").exists());
        assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "dirty\n");
        assert_eq!(super::entries(p, 1).unwrap()[0].op, "rebase");
        super::undo(p, &super::entries(p, 1).unwrap()[0].id).unwrap();
        assert_eq!(cli::rev(p, "HEAD").unwrap(), before);
        // Files follow HEAD back (5.txt returns), the local edit stays.
        assert_eq!(git(p, &["status", "--porcelain"]).unwrap(), " M a.txt\n");
        git(p, &["reset", "-q", "--hard"]).unwrap();

        // Swapping two edits of the same line conflicts; resolving and committing continues the rebase.
        let x1 = commit("a.txt", "x1\n", "x1");
        let x2 = commit("a.txt", "x2\n", "x2");
        let head = cli::rev(p, "HEAD").unwrap();
        let steps = [step(&x2, Pick, None), step(&x1, Pick, Some("x1 again"))];
        assert_eq!(cli::rebase(p, &before, &steps).unwrap_err().code, "conflicts");
        assert_eq!(cli::status(p).unwrap().operation.as_deref(), Some("rebase"));
        let st = cli::status(p).unwrap().step.unwrap();
        assert!(st.starts_with("commit 1 of ") && st.ends_with(": “x2”"), "{st}");
        // Resolved as "x2"; continuing then stops at x1.
        fs::write(dir.join("a.txt"), "x2\n").unwrap();
        cli::stage(p, &["a.txt".into()]).unwrap();
        assert_eq!(cli::commit(p, "", false).unwrap_err().code, "conflicts");
        // Keep mine = git's --theirs during a rebase (the replayed x1); the undo label says "mine".
        cli::resolve(p, &["a.txt".into()], cli::Side::Theirs).unwrap();
        assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap().trim_end(), "x1");
        assert_eq!(super::entries(p, 1).unwrap()[0].op, "take mine");
        cli::commit(p, "", false).unwrap();
        assert_eq!(cli::status(p).unwrap().operation, None);
        assert_eq!(git(p, &["log", "-2", "--format=%s"]).unwrap(), "x1 again\nx2\n");
        let e = &super::entries(p, 1).unwrap()[0];
        assert_eq!((e.op.as_str(), e.head.as_deref()), ("rebase", Some(head.as_str())));
        let _ = fs::remove_dir_all(&dir);
    }

    /// Resolving a rebase conflict to what the new base already has empties the commit: git drops it, `commit` says so.
    #[test]
    fn rebase_skips_emptied_commit() {
        let dir = temp_repo("rebase-empty");
        let p = dir.as_path();
        let commit = |text: &str, msg: &str| {
            fs::write(dir.join("a.txt"), text).unwrap();
            cli::stage(p, &["a.txt".into()]).unwrap();
            assert_eq!(cli::commit(p, msg, false).unwrap(), None);
        };
        commit("base\n", "base");
        let main = git(p, &["branch", "--show-current"]).unwrap().trim().to_string();
        git(p, &["switch", "-qc", "side"]).unwrap();
        commit("side\n", "side");
        git(p, &["switch", "-q", &main]).unwrap();
        commit("main\n", "main");
        git(p, &["switch", "-q", "side"]).unwrap();
        assert_eq!(cli::rebase_onto(p, &main).unwrap_err().code, "conflicts");
        fs::write(dir.join("a.txt"), "main\n").unwrap();
        cli::stage(p, &["a.txt".into()]).unwrap();
        assert_eq!(cli::commit(p, "", false).unwrap().as_deref(), Some("Skipped “side”: with your resolution it changes nothing."));
        assert_eq!(cli::status(p).unwrap().operation, None);
        assert_eq!(cli::rev(p, "HEAD").unwrap(), cli::rev(p, &main).unwrap());
        assert_eq!(super::entries(p, 1).unwrap()[0].op, "rebase");
        let _ = fs::remove_dir_all(&dir);
    }
}
