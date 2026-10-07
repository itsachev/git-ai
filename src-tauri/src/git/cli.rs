//! Runs the system `git` binary. No shell, no prompts, C locale.
use crate::errors::AppError;
use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use ts_rs::TS;

const MIN_VERSION: (u32, u32) = (2, 38);

/// Run `git -C <repo> <args>` and return stdout. Callers must put `--` before paths.
pub fn git(repo: &Path, args: &[&str]) -> Result<String, AppError> {
    git_env(repo, args, &[])
}

/// `git` with extra environment variables.
pub fn git_env(repo: &Path, args: &[&str], env: &[(&str, &OsStr)]) -> Result<String, AppError> {
    ensure_version()?;
    run(Some(repo), args, env, None)
}

/// `git` with `input` piped to stdin.
pub fn git_input(repo: &Path, args: &[&str], input: &str) -> Result<String, AppError> {
    ensure_version()?;
    run(Some(repo), args, &[], Some(input))
}

fn command(repo: Option<&Path>, args: &[&str], env: &[(&str, &OsStr)]) -> Command {
    let mut cmd = Command::new("git");
    if let Some(repo) = repo {
        cmd.arg("-C").arg(repo);
    }
    cmd.args(args).env("GIT_TERMINAL_PROMPT", "0").env("LC_ALL", "C");
    for (k, v) in env {
        cmd.env(k, v);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flash
    }
    cmd
}

fn missing(_: std::io::Error) -> AppError {
    AppError::new("git_missing", "Git is not installed or not on PATH.")
}

fn run(repo: Option<&Path>, args: &[&str], env: &[(&str, &OsStr)], input: Option<&str>) -> Result<String, AppError> {
    let mut cmd = command(repo, args, env);
    let out = match input {
        None => cmd.output().map_err(missing)?,
        Some(input) => {
            let mut child = cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(missing)?;
            // ponytail: writes all input before reading output; fine for patches, deadlocks only if git floods stdout first.
            child.stdin.take().unwrap().write_all(input.as_bytes()).map_err(|e| AppError::new("io", e.to_string()))?;
            child.wait_with_output().map_err(missing)?
        }
    };
    if !out.status.success() {
        return Err(AppError::from_stderr(&String::from_utf8_lossy(&out.stderr)));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[derive(Debug, Default, Serialize, TS)]
#[ts(export)]
pub struct Status {
    /// Current branch, or None when HEAD is detached.
    pub branch: Option<String>,
    pub staged: Vec<FileChange>,
    /// Unstaged changes plus untracked files (kind "?").
    pub unstaged: Vec<FileChange>,
    pub conflicted: Vec<FileChange>,
    /// Merge/cherry-pick/... waiting for commit or abort, see `read::operation`.
    pub operation: Option<String>,
}

#[derive(Debug, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct FileChange {
    pub path: String,
    /// Source path of a rename/copy.
    pub orig_path: Option<String>,
    /// Porcelain letter: M A D R C T, "?" for untracked, two letters (e.g. "UU") for conflicts.
    pub kind: String,
}

/// Working-tree status. `--no-optional-locks` so status never rewrites the index (which would retrigger the watcher).
pub fn status(repo: &Path) -> Result<Status, AppError> {
    let out = git(repo, &["--no-optional-locks", "status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"])?;
    let mut s = parse_status(&out);
    s.operation = crate::git::read::operation(repo)?;
    Ok(s)
}

fn parse_status(out: &str) -> Status {
    let mut s = Status::default();
    let change = |path: &str, orig_path: Option<&str>, kind: &str| FileChange {
        path: path.into(),
        orig_path: orig_path.map(String::from),
        kind: kind.into(),
    };
    let mut recs = out.split('\0');
    while let Some(rec) = recs.next() {
        let f: Vec<&str> = match rec.as_bytes().first() {
            Some(b'1') => rec.splitn(9, ' ').collect(),
            Some(b'2') => rec.splitn(10, ' ').collect(),
            Some(b'u') => rec.splitn(11, ' ').collect(),
            Some(b'?') => {
                s.unstaged.push(change(&rec[2..], None, "?"));
                continue;
            }
            Some(b'#') => {
                if let Some(head) = rec.strip_prefix("# branch.head ") {
                    s.branch = (head != "(detached)").then(|| head.into());
                }
                continue;
            }
            _ => continue,
        };
        let (Some(xy), Some(path)) = (f.get(1), f.last()) else { continue };
        if rec.starts_with('u') {
            s.conflicted.push(change(path, None, xy));
            continue;
        }
        // Type 2 (rename/copy): the source path is the next NUL-separated field.
        let orig = if rec.starts_with('2') { recs.next() } else { None };
        let (x, y) = xy.split_at(1);
        if x != "." {
            s.staged.push(change(path, orig, x));
        }
        if y != "." {
            s.unstaged.push(change(path, None, y));
        }
    }
    s
}

/// `git add -A` also records deletions and adds untracked files.
pub fn stage(repo: &Path, paths: &[String]) -> Result<(), AppError> {
    git(repo, &with_paths(&["add", "-A", "--"], paths)).map(drop)
}

/// `reset` rather than `restore --staged` because it also works before the first commit.
/// For a staged rename, pass both paths.
pub fn unstage(repo: &Path, paths: &[String]) -> Result<(), AppError> {
    git(repo, &with_paths(&["reset", "-q", "--"], paths)).map(drop)
}

/// Drops unstaged changes (tracked files go back to the index version, untracked files are deleted).
/// The working-tree content is backed up first, see `oplog::backup`.
pub fn discard(repo: &Path, paths: &[String]) -> Result<(), AppError> {
    let st = status(repo)?;
    let untracked: Vec<&str> = st.unstaged.iter().filter(|f| f.kind == "?").map(|f| f.path.as_str()).collect();
    let (untracked, tracked): (Vec<String>, Vec<String>) = paths.iter().cloned().partition(|p| untracked.contains(&p.as_str()));
    crate::oplog::backup(repo, "discard", paths)?;
    if !tracked.is_empty() {
        git(repo, &with_paths(&["restore", "--worktree", "--"], &tracked))?;
    }
    if !untracked.is_empty() {
        git(repo, &with_paths(&["clean", "-f", "-q", "--"], &untracked))?;
    }
    Ok(())
}

/// With `amend`, or when it finishes a merge/cherry-pick, HEAD before and after is logged so the commit
/// can be undone. An empty message while an op is in progress uses git's prepared message.
pub fn commit(repo: &Path, message: &str, amend: bool) -> Result<(), AppError> {
    let op = if amend { Some("amend".to_string()) } else { crate::git::read::operation(repo)? };
    let Some(op) = op else {
        return git(repo, &["commit", "-q", "-m", message]).map(drop);
    };
    if op == "rebase" {
        return continue_rebase(repo);
    }
    let mut args = vec!["commit", "-q"];
    if amend {
        args.push("--amend");
    }
    if message.trim().is_empty() && !amend {
        args.push("--no-edit");
    } else {
        args.extend(["-m", message]);
    }
    log_head_move(repo, &op, || git(repo, &args).map(drop))
}

/// Runs `f` and, when it moved HEAD, logs the move so it can be undone.
fn log_head_move(repo: &Path, op: &str, f: impl FnOnce() -> Result<(), AppError>) -> Result<(), AppError> {
    let head = rev(repo, "HEAD").ok();
    f()?;
    let new_head = rev(repo, "HEAD")?;
    if head.as_ref() == Some(&new_head) {
        return Ok(());
    }
    crate::oplog::record(repo, crate::oplog::OpEntry::new(op, head, Some(new_head)))
}

/// Merges a branch, tag or commit into the current branch, or with `cherry_pick` applies that one
/// commit on top. Conflicts leave the op in progress (code "conflicts") for commit or `abort`.
pub fn merge(repo: &Path, rev_name: &str, cherry_pick: bool) -> Result<(), AppError> {
    ref_arg(rev_name)?;
    let (op, args): (&str, &[&str]) =
        if cherry_pick { ("cherry-pick", &["cherry-pick", rev_name]) } else { ("merge", &["merge", "--no-edit", rev_name]) };
    log_head_move(repo, op, || {
        git(repo, args).map(drop).map_err(|e| stopped(repo, op, e))
    })
}

/// When git stopped halfway (the op is still in progress), says so instead of git's raw error.
fn stopped(repo: &Path, op: &str, e: AppError) -> AppError {
    match crate::git::read::operation(repo) {
        Ok(Some(_)) if op == "rebase" => AppError::new("conflicts", "The rebase stopped at a conflict. Resolve it in File Status, then commit to continue (or abort the rebase)."),
        Ok(Some(_)) => AppError::new("conflicts", format!("The {op} has conflicts. Resolve them in File Status, then commit (or abort the {op}).")),
        _ => e,
    }
}

/// What to do with one commit in an interactive rebase.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize, TS)]
#[ts(export)]
pub enum RebaseAction {
    Pick,
    /// Meld into the commit above, keeping both messages.
    Squash,
    /// Meld into the commit above, dropping this message.
    Fixup,
    Drop,
}

#[derive(Debug, Deserialize, TS)]
#[ts(export)]
pub struct RebaseStep {
    pub oid: String,
    pub action: RebaseAction,
    /// New message for the resulting commit (for squash: the combined one); None keeps git's.
    pub message: Option<String>,
}

/// Rewrites `base..HEAD` as `steps` (oldest first; must list exactly those commits, in any order).
/// Rewording runs `git commit --amend -F` from an `exec` line, so git never opens an editor. Changed
/// files are carried with `--autostash`. Conflicts leave the rebase in progress; `commit` continues it.
pub fn rebase(repo: &Path, base: &str, steps: &[RebaseStep]) -> Result<(), AppError> {
    ref_arg(base)?;
    let mut want: Vec<String> = crate::git::read::rebase_commits(repo, base)?.into_iter().map(|c| c.oid).collect();
    let mut got: Vec<String> = steps.iter().map(|s| s.oid.clone()).collect();
    want.sort();
    got.sort();
    if want != got {
        return Err(AppError::new("stale", "The branch changed since the list was made. Open the rebase again."));
    }
    let kept: Vec<&RebaseStep> = steps.iter().filter(|s| s.action != RebaseAction::Drop).collect();
    if kept.first().is_some_and(|s| s.action != RebaseAction::Pick) {
        return Err(AppError::new("bad_squash", "The first commit can't be squashed: there is nothing above it to meld into."));
    }
    let dir = crate::oplog::git_ai_dir(repo)?;
    let quoted = |p: &Path| {
        let s = p.to_string_lossy().replace('\\', "/");
        if s.contains('\'') {
            return Err(AppError::new("bad_path", "The repository path contains ', which the rebase can't handle."));
        }
        Ok(format!("'{s}'"))
    };
    // A reword runs after the last squash/fixup that melds into the same commit.
    let mut todo = String::new();
    let mut pending: Option<String> = None;
    for (i, s) in steps.iter().enumerate() {
        let word = match s.action {
            RebaseAction::Pick => "pick",
            RebaseAction::Squash => "squash",
            RebaseAction::Fixup => "fixup",
            RebaseAction::Drop => "drop",
        };
        if matches!(s.action, RebaseAction::Pick) {
            todo.push_str(&pending.take().unwrap_or_default());
        }
        todo.push_str(&format!("{word} {}\n", s.oid));
        if let (Some(msg), true) = (&s.message, s.action != RebaseAction::Drop) {
            let file = dir.join(format!("rebase-msg-{i}"));
            std::fs::write(&file, msg).map_err(|e| AppError::new("io", e.to_string()))?;
            pending = Some(format!("exec git commit --amend -q --allow-empty -F {}\n", quoted(&file)?));
        }
    }
    todo.push_str(&pending.unwrap_or_default());
    let todo_file = dir.join("rebase-todo");
    std::fs::write(&todo_file, todo).map_err(|e| AppError::new("io", e.to_string()))?;
    // git runs the editors through its own sh: the todo editor copies ours over git's, `true` keeps squash messages.
    let seq = std::ffi::OsString::from(format!("cp {}", quoted(&todo_file)?));
    let env = [("GIT_SEQUENCE_EDITOR", seq.as_os_str()), ("GIT_EDITOR", OsStr::new("true"))];
    log_head_move(repo, "rebase", || {
        git_env(repo, &["rebase", "-i", "--autostash", "--empty=drop", base], &env).map(drop).map_err(|e| stopped(repo, "rebase", e))
    })
}

/// Continues a stopped rebase with the staged resolution, keeping the commit's message. Logs the
/// whole rebase for undo once it finishes.
fn continue_rebase(repo: &Path) -> Result<(), AppError> {
    let orig = git(repo, &["rev-parse", "--git-path", "rebase-merge/orig-head"])
        .ok()
        .and_then(|p| std::fs::read_to_string(repo.join(p.trim())).ok())
        .map(|s| s.trim().to_string());
    git_env(repo, &["rebase", "--continue"], &[("GIT_EDITOR", OsStr::new("true"))]).map_err(|e| stopped(repo, "rebase", e))?;
    if crate::git::read::operation(repo)?.is_some() {
        return Ok(());
    }
    crate::oplog::record(repo, crate::oplog::OpEntry::new("rebase", orig, Some(rev(repo, "HEAD")?)))
}

/// Network git: credential prompts go to the app UI (see `askpass`), common failures are explained.
fn git_net(repo: &Path, args: &[&str]) -> Result<String, AppError> {
    let env = crate::askpass::env();
    let env: Vec<(&str, &OsStr)> = env.iter().map(|(k, v)| (*k, v.as_os_str())).collect();
    git_env(repo, args, &env).map_err(net_error)
}

/// Gives the usual network failures a code and a plain explanation; git's last line stays in the message.
fn net_error(e: AppError) -> AppError {
    if e.code != "git" {
        return e;
    }
    let m = e.message.as_str();
    let has = |pats: &[&str]| pats.iter().any(|p| m.contains(p));
    let (code, text) = if has(&["[rejected]", "non-fast-forward", "fetch first"]) {
        ("rejected", "The remote has commits you don't have yet. Pull first, then push.")
    } else if has(&["Authentication failed", "Permission denied", "could not read Username", "could not read Password", "Host key verification failed"]) {
        ("auth", "Signing in to the remote failed. Check your credentials or SSH key.")
    } else if has(&["Could not resolve host", "unable to access", "Connection timed out", "Connection refused", "Could not read from remote repository"]) {
        ("network", "Can't reach the remote. Check your connection and the remote URL.")
    } else if has(&["no tracking information"]) {
        ("no_upstream", "This branch has no remote branch yet. Push it first.")
    } else {
        return e;
    };
    let last = m.lines().last().unwrap_or_default().trim();
    AppError::new(code, format!("{text} (git: {last})"))
}

/// Clones `url` into `dest` (must not exist or be empty). git's progress lines ("Receiving objects:  42% …")
/// go to `progress` as they come; they end in '\r' while a phase runs, '\n' when it is done.
pub fn clone(url: &str, dest: &Path, mut progress: impl FnMut(&str)) -> Result<(), AppError> {
    use std::io::Read;
    ensure_version()?;
    if url.trim().is_empty() || url.starts_with('-') {
        return Err(AppError::new("bad_url", format!("'{url}' is not a valid repository URL.")));
    }
    let env = crate::askpass::env();
    let env: Vec<(&str, &OsStr)> = env.iter().map(|(k, v)| (*k, v.as_os_str())).collect();
    let dest_s = dest.to_string_lossy();
    let mut cmd = command(None, &["clone", "--progress", "--", url, &dest_s], &env);
    let mut child = cmd.stdout(Stdio::null()).stderr(Stdio::piped()).spawn().map_err(missing)?;
    let mut stderr = child.stderr.take().unwrap();
    let (mut all, mut line, mut buf) = (String::new(), Vec::new(), [0u8; 4096]);
    while let Ok(n @ 1..) = stderr.read(&mut buf) {
        for &b in &buf[..n] {
            if b == b'\r' || b == b'\n' {
                let l = String::from_utf8_lossy(&line);
                if !l.trim().is_empty() {
                    progress(l.trim());
                    // ponytail: keeps every line for the error text; progress lines are few hundred at most.
                    all.push_str(&l);
                    all.push('\n');
                }
                line.clear();
            } else {
                line.push(b);
            }
        }
    }
    let status = child.wait().map_err(missing)?;
    if !status.success() {
        return Err(net_error(AppError::new("git", all.trim())));
    }
    Ok(())
}

/// Fetches all remotes, pruning remote branches that were deleted there.
pub fn fetch(repo: &Path) -> Result<(), AppError> {
    git_net(repo, &["fetch", "-q", "--all", "--prune"]).map(drop)
}

/// Merges the upstream into the current branch (never rebases). Logged like a merge, so undo is a soft
/// reset; conflicts leave the merge in progress.
pub fn pull(repo: &Path) -> Result<(), AppError> {
    log_head_move(repo, "pull", || {
        git_net(repo, &["pull", "-q", "--no-rebase", "--no-edit"]).map(drop).map_err(|e| stopped(repo, "merge", e))
    })
}

/// Pushes the current branch to its upstream. Without one it goes to the same name on `origin` (or the
/// first remote) and becomes the upstream.
pub fn push(repo: &Path) -> Result<(), AppError> {
    let branch = git(repo, &["symbolic-ref", "-q", "--short", "HEAD"])
        .map_err(|_| AppError::new("detached", "Check out a branch to push it."))?;
    let branch = branch.trim();
    let config = |key: &str| git(repo, &["config", "--get", &format!("branch.{branch}.{key}")]).ok().map(|s| s.trim().to_string());
    let src = format!("refs/heads/{branch}");
    match (config("remote"), config("merge")) {
        (Some(remote), Some(dst)) => {
            ref_arg(&remote)?;
            git_net(repo, &["push", "-q", &remote, &format!("{src}:{dst}")])
        }
        _ => git_net(repo, &["push", "-q", "-u", &default_remote(repo)?, &format!("{src}:{src}")]),
    }
    .map(drop)
}

/// Pushes one tag to `origin` (or the first remote).
pub fn push_tag(repo: &Path, name: &str) -> Result<(), AppError> {
    ref_arg(name)?;
    git_net(repo, &["push", "-q", &default_remote(repo)?, &format!("refs/tags/{name}")]).map(drop)
}

/// Deletes remote branch `name` ("origin/feat") on the remote. The tip is logged, and kept under
/// `refs/git-ai/kept/<id>` so gc can't drop the commits; undo pushes it back (`restore_remote_branch`).
pub fn delete_remote_branch(repo: &Path, name: &str) -> Result<(), AppError> {
    let (remote, branch) = split_remote(repo, name)?;
    let tracking = format!("refs/remotes/{name}");
    let oid = rev(repo, &tracking)?;
    git_net(repo, &["push", "-q", &remote, "--delete", &format!("refs/heads/{branch}")])?;
    let mut e = crate::oplog::OpEntry::new("delete remote branch", Some(oid.clone()), None);
    git(repo, &["update-ref", &format!("refs/git-ai/kept/{}", e.id), &oid])?;
    e.ref_name = Some(tracking);
    crate::oplog::record(repo, e)
}

/// Recreates remote branch `name` ("origin/feat") at `oid`. Fails if it exists again and moved on.
pub fn restore_remote_branch(repo: &Path, name: &str, oid: &str) -> Result<(), AppError> {
    let (remote, branch) = split_remote(repo, name)?;
    git_net(repo, &["push", "-q", &remote, &format!("{oid}:refs/heads/{branch}")]).map(drop)
}

/// "origin/feat" -> ("origin", "feat"), matched against the configured remotes (names may contain '/').
fn split_remote(repo: &Path, name: &str) -> Result<(String, String), AppError> {
    git(repo, &["remote"])?
        .lines()
        .filter_map(|r| Some((r, name.strip_prefix(r)?.strip_prefix('/')?)))
        .max_by_key(|(r, _)| r.len())
        .map(|(r, b)| (r.to_string(), b.to_string()))
        .ok_or_else(|| AppError::new("no_remote", format!("'{name}' is not a branch of a configured remote.")))
}

/// `origin` if it exists, else the first remote.
fn default_remote(repo: &Path) -> Result<String, AppError> {
    let out = git(repo, &["remote"])?;
    let remotes: Vec<&str> = out.lines().collect();
    let remote = remotes.iter().find(|r| **r == "origin").or(remotes.first());
    remote.map(|r| r.to_string()).ok_or_else(|| AppError::new("no_remote", "This repository has no remote yet (add one with `git remote add`)."))
}

/// Aborts the in-progress merge/cherry-pick/revert/rebase. Changed files are backed up first, since
/// abort throws away conflict resolutions.
pub fn abort(repo: &Path) -> Result<(), AppError> {
    let st = status(repo)?;
    let op = st.operation.ok_or_else(|| AppError::new("nothing_to_abort", "No merge or cherry-pick is in progress."))?;
    let mut paths: Vec<String> = st.staged.iter().chain(&st.unstaged).chain(&st.conflicted).map(|f| f.path.clone()).collect();
    paths.dedup();
    if !paths.is_empty() {
        crate::oplog::backup(repo, &format!("abort {op}"), &paths)?;
    }
    git(repo, &[op.as_str(), "--abort"]).map(drop)
}

/// Which side of a conflict to keep.
#[derive(Debug, Clone, Copy, Deserialize, TS)]
#[ts(export)]
pub enum Side {
    /// The current branch (HEAD).
    Ours,
    /// The commit being merged / cherry-picked in.
    Theirs,
}

/// Resolves conflicted files by taking one side whole, then marks them resolved. A side that deleted
/// the file deletes it. The working-tree content (conflict markers, edits) is backed up first.
pub fn resolve(repo: &Path, paths: &[String], side: Side) -> Result<(), AppError> {
    let (flag, op) = match side {
        Side::Ours => ("--ours", "take ours"),
        Side::Theirs => ("--theirs", "take theirs"),
    };
    crate::oplog::backup(repo, op, paths)?;
    for p in paths {
        match git(repo, &["checkout", flag, "--", p]) {
            Ok(_) => git(repo, &["add", "--", p])?,
            // "path 'x' does not have our version": that side deleted it.
            Err(e) if e.message.contains("does not have") => git(repo, &["rm", "-q", "--", p])?,
            Err(e) => return Err(e),
        };
    }
    Ok(())
}

/// Tag at `target` (a commit oid or ref): annotated when `message` isn't empty, else lightweight.
pub fn create_tag(repo: &Path, name: &str, target: &str, message: &str) -> Result<(), AppError> {
    ref_arg(name)?;
    ref_arg(target)?;
    let args: &[&str] = if message.trim().is_empty() { &["tag", name, target] } else { &["tag", "-a", "-m", message, name, target] };
    git(repo, args).map(drop)
}

/// The tag (object) oid is logged so undo can recreate it.
pub fn delete_tag(repo: &Path, name: &str) -> Result<(), AppError> {
    ref_arg(name)?;
    let full = format!("refs/tags/{name}");
    let oid = rev(repo, &full)?;
    git(repo, &["tag", "-d", name])?;
    let mut e = crate::oplog::OpEntry::new("delete tag", Some(oid), None);
    e.ref_name = Some(full);
    crate::oplog::record(repo, e)
}

/// Stashes all changes, untracked files included.
pub fn stash_save(repo: &Path, message: &str) -> Result<(), AppError> {
    let args: &[&str] = if message.trim().is_empty() { &["stash", "push", "-q", "-u"] } else { &["stash", "push", "-q", "-u", "-m", message] };
    git(repo, args).map(drop)
}

/// What to do with `stash@{index}`.
#[derive(Debug, Clone, Copy, Deserialize, TS)]
#[ts(export)]
pub enum StashOp {
    Apply,
    /// Apply, then drop when it applied cleanly.
    Pop,
    Drop,
}

/// `oid` must still be `stash@{index}` (stash indices shift). A dropped stash is logged so undo can
/// store it back.
pub fn stash(repo: &Path, op: StashOp, index: usize, oid: &str) -> Result<(), AppError> {
    let name = format!("stash@{{{index}}}");
    if rev(repo, &name).ok().as_deref() != Some(oid) {
        return Err(AppError::new("stale", "The stash list changed. Try again."));
    }
    let verb = match op {
        StashOp::Apply => "apply",
        StashOp::Pop => "pop",
        StashOp::Drop => "drop",
    };
    let res = git(repo, &["stash", verb, "-q", &name]).map(drop);
    let still_there = git(repo, &["stash", "list", "--format=%H"])?.lines().any(|l| l == oid);
    if !still_there {
        crate::oplog::record(repo, crate::oplog::OpEntry::new("drop stash", Some(oid.to_string()), None))?;
    }
    res.map_err(|e| if status(repo).is_ok_and(|s| !s.conflicted.is_empty()) {
        AppError::new("conflicts", "The stash applied with conflicts and was kept. Resolve them in File Status.")
    } else {
        e
    })
}

/// Switches to a local branch, or with `track` creates a local branch tracking the remote branch `name`.
/// Git refuses (code "dirty", no data lost) when local changes would be overwritten. With `carry`, the
/// changes are stashed, the branch switched, and the stash popped on top; a conflicting pop keeps the stash.
pub fn checkout(repo: &Path, name: &str, track: bool, carry: bool) -> Result<(), AppError> {
    ref_arg(name)?;
    let args: &[&str] = if track { &["switch", "-q", "--track", name] } else { &["switch", "-q", name] };
    if !carry {
        return git(repo, args).map(drop);
    }
    let before = rev(repo, "refs/stash").ok();
    git(repo, &["stash", "push", "-q", "-u", "-m", &format!("carried to {name}")])?;
    let stashed = rev(repo, "refs/stash").ok() != before;
    let switched = git(repo, args).map(drop);
    if !stashed {
        return switched;
    }
    // Switch failed: pop back where we started.
    // ponytail: no --index, so staged changes come back unstaged; add it if people miss their staging.
    let popped = git(repo, &["stash", "pop", "-q"]);
    switched?;
    popped.map(drop).map_err(|e| if status(repo).is_ok_and(|s| !s.conflicted.is_empty()) {
        AppError::new("conflicts", "Switched, but your changes conflict with this branch. They were kept as a stash; resolve the conflicts in File Status.")
    } else {
        e
    })
}

/// New branch at HEAD, optionally switched to.
/// `from` is the start point (branch, remote branch, tag or commit); None = HEAD. A branch started
/// from a remote branch doesn't track it: its first push sets the upstream.
pub fn create_branch(repo: &Path, name: &str, from: Option<&str>, checkout: bool) -> Result<(), AppError> {
    ref_arg(name)?;
    let mut args = if checkout { vec!["switch", "-q", "--no-track", "-c", name] } else { vec!["branch", "--no-track", name] };
    if let Some(f) = from {
        ref_arg(f)?;
        args.push(f);
    }
    git(repo, &args).map(drop)
}

/// Deletes a local branch; its tip is logged so undo can recreate it. Without `force`, git refuses
/// a branch that isn't merged (code "not_merged").
pub fn delete_branch(repo: &Path, name: &str, force: bool) -> Result<(), AppError> {
    ref_arg(name)?;
    let full = format!("refs/heads/{name}");
    let oid = rev(repo, &full)?;
    git(repo, &["branch", if force { "-D" } else { "-d" }, name]).map_err(|e| {
        if e.message.contains("not fully merged") {
            AppError::new("not_merged", format!("Branch '{name}' has commits that are not merged anywhere else."))
        } else {
            e
        }
    })?;
    let mut e = crate::oplog::OpEntry::new("delete branch", Some(oid), None);
    e.ref_name = Some(full);
    crate::oplog::record(repo, e)
}

/// Ref names go in as plain args (switch/branch take no `--`), so a leading '-' would read as an option.
fn ref_arg(name: &str) -> Result<(), AppError> {
    if name.is_empty() || name.starts_with('-') {
        return Err(AppError::new("bad_name", format!("'{name}' is not a valid name.")));
    }
    Ok(())
}

pub fn rev(repo: &Path, rev: &str) -> Result<String, AppError> {
    Ok(git(repo, &["rev-parse", "-q", "--verify", rev])?.trim().to_string())
}

#[derive(Debug, Clone, Copy, Deserialize, TS)]
#[ts(export)]
pub enum LineOp {
    /// Unstaged diff lines into the index.
    Stage,
    /// Staged diff lines back out of the index.
    Unstage,
    /// Unstaged diff lines out of the working tree (backed up first).
    Discard,
}

/// Stages, unstages or discards some lines of one file. `lines` index into the lines of `read::file_diff`.
pub fn apply_lines(repo: &Path, file: &str, op: LineOp, lines: &[usize]) -> Result<(), AppError> {
    let diff = crate::git::read::file_diff(repo, file, matches!(op, LineOp::Unstage))?
        .ok_or_else(|| AppError::new("binary", "Binary files can only be staged as a whole."))?;
    let reverse = !matches!(op, LineOp::Stage);
    let patch = select_lines(&diff, lines, reverse)
        .ok_or_else(|| AppError::new("stale_diff", "The selected lines are gone. The file changed, try again."))?;
    let mut args = vec!["apply", "--recount", "--whitespace=nowarn"];
    match op {
        LineOp::Stage => args.push("--cached"),
        LineOp::Unstage => args.extend(["--cached", "-R"]),
        LineOp::Discard => {
            crate::oplog::backup(repo, "discard", &[file.to_string()])?;
            args.push("-R");
        }
    }
    args.push("-");
    git_input(repo, &args, &patch).map(drop)
}

/// Keeps only the selected +/- lines of a one-file diff (indices into its lines).
/// Unselected changes turn into context or are dropped, so the patch still applies forward onto the
/// old side, or with `reverse` (`git apply -R`) backward onto the new side. Hunk counts are left
/// stale for `git apply --recount`. None when nothing selected is a change line.
pub fn select_lines(diff: &str, selected: &[usize], reverse: bool) -> Option<String> {
    let mut out = String::new();
    let mut hunk = String::new();
    let mut hunk_has_change = false;
    let mut any = false;
    let mut prev_kept = false;
    let flush = |out: &mut String, hunk: &mut String, has: &mut bool| {
        if *has {
            out.push_str(hunk);
        }
        hunk.clear();
        *has = false;
    };
    for (i, line) in diff.split_inclusive('\n').enumerate() {
        if line.starts_with("@@") {
            flush(&mut out, &mut hunk, &mut hunk_has_change);
            hunk.push_str(line);
            continue;
        }
        if hunk.is_empty() {
            out.push_str(line); // file header
            continue;
        }
        let picked = selected.contains(&i);
        // An unselected change stays as context when its side is the one the patch applies onto.
        let kept = match line.as_bytes().first() {
            Some(b'+') | Some(b'-') if picked => {
                hunk_has_change = true;
                any = true;
                hunk.push_str(line);
                true
            }
            Some(b'+') if reverse => { hunk.push(' '); hunk.push_str(&line[1..]); true }
            Some(b'-') if !reverse => { hunk.push(' '); hunk.push_str(&line[1..]); true }
            Some(b'+') | Some(b'-') => false,
            Some(b'\\') => {
                if prev_kept { hunk.push_str(line); }
                prev_kept
            }
            _ => { hunk.push_str(line); true }
        };
        prev_kept = kept;
    }
    flush(&mut out, &mut hunk, &mut hunk_has_change);
    any.then_some(out)
}

fn with_paths<'a>(args: &[&'a str], paths: &'a [String]) -> Vec<&'a str> {
    args.iter().copied().chain(paths.iter().map(String::as_str)).collect()
}

/// Checks `git --version` once per process.
pub fn ensure_version() -> Result<(), AppError> {
    static CHECK: OnceLock<Result<(), String>> = OnceLock::new();
    CHECK
        .get_or_init(|| {
            let out = run(None, &["--version"], &[], None).map_err(|e| e.message)?;
            match parse_version(&out) {
                Some(v) if v >= MIN_VERSION => Ok(()),
                _ => Err(format!("git-ai needs Git {}.{} or newer (found: {}).", MIN_VERSION.0, MIN_VERSION.1, out.trim())),
            }
        })
        .clone()
        .map_err(|m| AppError::new("git_too_old", m))
}

/// "git version 2.45.1.windows.1" -> (2, 45)
fn parse_version(s: &str) -> Option<(u32, u32)> {
    let mut it = s.trim().strip_prefix("git version ")?.split('.');
    Some((it.next()?.parse().ok()?, it.next()?.parse().ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_versions() {
        assert_eq!(parse_version("git version 2.45.1.windows.1\n"), Some((2, 45)));
        assert_eq!(parse_version("git version 2.38.0"), Some((2, 38)));
        assert_eq!(parse_version("nope"), None);
    }

    #[test]
    fn parses_status() {
        let out = "# branch.oid abc\0# branch.head main\01 M. N... 100644 100644 100644 a b src/a b.rs\01 .M N... 100644 100644 100644 a b x.txt\02 R. N... 100644 100644 100644 a b R100 new.rs\0old.rs\0u UU N... 100644 100644 100644 100644 a b c conflict.rs\0? dir/untracked.md\0";
        let s = parse_status(out);
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!(s.staged, vec![change("src/a b.rs", None, "M"), change("new.rs", Some("old.rs"), "R")]);
        assert_eq!(s.unstaged, vec![change("x.txt", None, "M"), change("dir/untracked.md", None, "?")]);
        assert_eq!(s.conflicted, vec![change("conflict.rs", None, "UU")]);
        assert_eq!(parse_status("# branch.head (detached)\0").branch, None);
    }

    fn change(path: &str, orig: Option<&str>, kind: &str) -> FileChange {
        FileChange { path: path.into(), orig_path: orig.map(String::from), kind: kind.into() }
    }

    #[test]
    fn runs_git() {
        ensure_version().unwrap();
        let out = git(Path::new("."), &["rev-parse", "--is-inside-work-tree"]).unwrap();
        assert_eq!(out.trim(), "true");
        status(Path::new(".")).unwrap();
    }
}
