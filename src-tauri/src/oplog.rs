//! Undo support: backups under `refs/git-ai/backup/<id>` plus one JSON line per op in `.git/git-ai/oplog.jsonl`.
use crate::errors::AppError;
use crate::git::cli::{git, git_env, rev};
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
    /// "discard", "amend", "merge", "cherry-pick", "abort <op>", "delete branch", "delete tag",
    /// "drop stash", "pull", "delete remote branch", or "undo <op>" for the undo of an op.
    pub op: String,
    /// HEAD (or `ref_name`) before the op; None = the ref didn't exist.
    pub head: Option<String>,
    /// HEAD (or `ref_name`) after the op, when the op moved it; None = deleted. Undo moves it back.
    pub new_head: Option<String>,
    /// The ref `head`/`new_head` belong to, when not HEAD (e.g. "refs/heads/feature").
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
fn snapshot(repo: &Path, op: &str, paths: &[String]) -> Result<OpEntry, AppError> {
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
    let op = format!("undo {}", e.op);
    let mut u = if let Some(backup) = &e.backup {
        let u = snapshot(repo, &op, &e.paths)?;
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
    } else if let ("delete remote branch", Some(oid), Some(r)) = (e.op.as_str(), &e.head, &e.ref_name) {
        crate::git::cli::restore_remote_branch(repo, r.strip_prefix("refs/remotes/").unwrap_or(r), oid)?;
        // Not undoable itself (no refs to swap back); delete the branch again from the sidebar instead.
        OpEntry::new(&op, None, None)
    } else if e.head.is_some() || e.new_head.is_some() {
        // Compare-and-swap back to `head`: "" as the old value means "must not exist", -d deletes.
        let r = e.ref_name.as_deref().unwrap_or("HEAD");
        // Rebase, pull, merge: files must follow HEAD back. `reset --keep` keeps local edits and
        // refuses when they'd be overwritten. Amend only moves HEAD (its changes stay staged).
        let files = r == "HEAD" && e.op.trim_start_matches("undo ") != "amend";
        let res = match (&e.head, &e.new_head) {
            (Some(old), Some(new)) if files && git(repo, &["rev-parse", "HEAD"])?.trim() == new => {
                git(repo, &["reset", "-q", "--keep", old]).map_err(|_| {
                    AppError::new("dirty", "Your uncommitted changes touch files this undo would change. Commit, stash or discard them first.")
                })?;
                Ok(String::new())
            }
            (Some(old), new) => git(repo, &["update-ref", "-m", "git-ai: undo", r, old, new.as_deref().unwrap_or("")]),
            (None, Some(new)) => git(repo, &["update-ref", "-m", "git-ai: undo", "-d", r, new]),
            (None, None) => unreachable!(),
        };
        res.map_err(|_| {
            let name = r.strip_prefix("refs/heads/").unwrap_or(r);
            AppError::new("moved", format!("{name} has changed since this operation (a newer commit, checkout or branch), so it can't be undone."))
        })?;
        let mut u = OpEntry::new(&op, e.new_head.clone(), e.head.clone());
        u.ref_name = e.ref_name.clone();
        u
    } else {
        return Err(AppError::new("not_undoable", "This operation can't be undone."));
    };
    u.undoes = Some(e.id);
    record(repo, u)
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
        assert_eq!(cli::reset_to(p, "other").unwrap_err().code, "dirty");
        assert_eq!(cli::rev(p, "HEAD").unwrap(), mine);
        git(p, &["checkout", "--", "a.txt"]).unwrap();

        cli::reset_to(p, "other").unwrap();
        assert_eq!(cli::rev(p, "HEAD").unwrap(), base);
        assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "base\n");
        let e = super::entries(p, 1).unwrap()[0].clone();
        assert_eq!(e.op, "reset");
        super::undo(p, &e.id).unwrap();
        assert_eq!(cli::rev(p, "HEAD").unwrap(), mine);
        assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "mine\n");
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
        cli::stash_save(p, "wip").unwrap();
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

        assert_eq!(cli::push(a).unwrap_err().code, "no_remote");
        git(a, &["remote", "add", "origin", bare_s]).unwrap();
        commit(a, "a.txt", "one");
        cli::push(a).unwrap();
        assert_eq!(git(a, &["config", "branch.main.merge"]).unwrap().trim(), "refs/heads/main");

        // A second clone pushes first, so a's push is rejected until it pulls (a merge, undoable).
        git(here, &["clone", "-q", bare_s, b_s]).unwrap();
        for kv in [["user.name", "t"], ["user.email", "t@t"], ["core.autocrlf", "false"]] {
            git(&b, &["config", kv[0], kv[1]]).unwrap();
        }
        commit(&b, "b.txt", "from b");
        cli::push(&b).unwrap();
        commit(a, "c.txt", "from a");
        let before = cli::rev(a, "HEAD").unwrap();
        assert_eq!(cli::push(a).unwrap_err().code, "rejected");
        cli::fetch(a).unwrap();
        assert_eq!(cli::rev(a, "origin/main").unwrap(), cli::rev(&b, "HEAD").unwrap());
        cli::pull(a).unwrap();
        assert_eq!(fs::read_to_string(a.join("b.txt")).unwrap(), "from b");
        assert_eq!(top().op, "pull");
        super::undo(a, &top().id).unwrap();
        assert_eq!(cli::rev(a, "HEAD").unwrap(), before);
        git(a, &["reset", "-q", "--hard"]).unwrap();
        cli::pull(a).unwrap();
        cli::push(a).unwrap();

        // Tag push.
        cli::create_tag(a, "v1", "HEAD", "").unwrap();
        cli::push_tag(a, "v1").unwrap();
        assert_eq!(cli::rev(&bare, "refs/tags/v1").unwrap(), cli::rev(a, "HEAD").unwrap());

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
        assert_eq!(cli::clone(s.to_str().unwrap(), &dest, |_| {}).unwrap_err().code, "git"); // dest not empty
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

        // Branches: create + switch, commit on it, unmerged delete needs force, undo brings it back.
        let base = git(p, &["branch", "--show-current"]).unwrap().trim().to_string();
        cli::create_branch(p, "feat", None, true).unwrap();
        cli::stage(p, &files(&["a.txt"])).unwrap();
        cli::commit(p, "on feat", false).unwrap();
        let tip = cli::rev(p, "feat").unwrap();
        // Start point: a branch made on feat from base points at base, and HEAD stays put.
        cli::create_branch(p, "off-base", Some(&base), false).unwrap();
        assert_eq!(cli::rev(p, "off-base").unwrap(), cli::rev(p, &base).unwrap());
        assert_eq!(cli::rev(p, "HEAD").unwrap(), tip);
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

        // b.txt differs between branches, so a plain switch refuses; carry brings the edit and the new file along.
        fs::write(dir.join("b.txt"), "b
mine
").unwrap();
        fs::write(dir.join("new.txt"), "new").unwrap();
        assert_eq!(cli::checkout(p, "feat", false, false).unwrap_err().code, "dirty");
        cli::checkout(p, "main", false, true).unwrap(); // same branch: stash round-trips, changes stay
        assert_eq!(fs::read_to_string(dir.join("b.txt")).unwrap(), "b
mine
");
        assert_eq!(cli::checkout(p, "feat", false, true).unwrap_err().code, "conflicts");
        assert_eq!(cli::status(p).unwrap().branch.as_deref(), Some("feat"));
        assert!(dir.join("new.txt").exists());
        assert_eq!(crate::git::read::refs(p).unwrap().stashes.len(), 1);

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

        // New branch from a start point that clashes with the changes: carried like a switch.
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
        assert_eq!(cli::create_branch(r, "nb", Some("feat"), true).unwrap_err().code, "conflicts");
        assert_eq!(cli::status(r).unwrap().branch.as_deref(), Some("nb"));
        assert_eq!(crate::git::read::refs(r).unwrap().stashes.len(), 1);
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
}
