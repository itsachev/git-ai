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
    /// What that operation is applying right now, see `read::op_step`.
    pub step: Option<String>,
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
    s.step = s.operation.as_deref().and_then(|op| crate::git::read::op_step(repo, op));
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
/// Returns a note for the user when a rebase dropped the commit (see `continue_rebase`).
pub fn commit(repo: &Path, message: &str, amend: bool) -> Result<Option<String>, AppError> {
    let op = if amend { Some("amend".to_string()) } else { crate::git::read::operation(repo)? };
    let Some(op) = op else {
        return git(repo, &["commit", "-q", "-m", message]).map(|_| None);
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
    log_head_move(repo, &op, || git(repo, &args).map(drop)).map(|_| None)
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

/// Replays the current branch's own commits on top of `onto`. Conflicts pause it like the
/// interactive rebase (Continue rebase / abort).
pub fn rebase_onto(repo: &Path, onto: &str) -> Result<(), AppError> {
    ref_arg(onto)?;
    log_head_move(repo, "rebase", || {
        git(repo, &["rebase", "--autostash", onto]).map(drop).map_err(|e| stopped(repo, "rebase", e))
    })
}

/// Moves the current branch to `rev`, dropping its commits that `rev` lacks ("recreate from the remote").
/// `reset --keep` keeps local edits and refuses when they'd be overwritten. Logged; undo moves it back.
pub fn reset_to(repo: &Path, rev_name: &str) -> Result<(), AppError> {
    ref_arg(rev_name)?;
    log_head_move(repo, "reset", || git(repo, &["reset", "-q", "--keep", rev_name]).map(drop))
}

/// Adds a commit that undoes `oid`. A merge commit is reverted against its first parent (the branch it
/// was merged into). Logged like a merge; conflicts leave the revert in progress for commit or `abort`.
pub fn revert(repo: &Path, oid: &str) -> Result<(), AppError> {
    ref_arg(oid)?;
    let mut args = vec!["revert", "--no-edit"];
    if rev(repo, &format!("{oid}^2")).is_ok() {
        args.extend(["-m", "1"]);
    }
    args.push(oid);
    log_head_move(repo, "revert", || git(repo, &args).map(drop).map_err(|e| stopped(repo, "revert", e)))
}

/// When git stopped halfway (the op is still in progress), says so instead of git's raw error.
fn stopped(repo: &Path, op: &str, e: AppError) -> AppError {
    match crate::git::read::operation(repo) {
        Ok(Some(_)) if op == "rebase" => {
            let at = crate::git::read::op_step(repo, op).map(|s| format!(" at {s}")).unwrap_or_default();
            AppError::new("conflicts", format!("The rebase paused{at} because of a conflict. Resolve it in File Status, then Continue rebase (or abort it)."))
        }
        Ok(Some(_)) => AppError::new("conflicts", format!("The {op} paused because of conflicts. Resolve them in File Status, then commit to finish (or abort the {op}).")),
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
/// whole rebase for undo once it finishes. When the resolution leaves the commit with no changes, git
/// drops it without a word; the returned note (or the next stop's error) says so.
fn continue_rebase(repo: &Path) -> Result<Option<String>, AppError> {
    let orig = git(repo, &["rev-parse", "--git-path", "rebase-merge/orig-head"])
        .ok()
        .and_then(|p| std::fs::read_to_string(repo.join(p.trim())).ok())
        .map(|s| s.trim().to_string());
    // `diff --cached --quiet` succeeds when the index matches HEAD.
    let skipped = git(repo, &["diff", "--cached", "--quiet"]).is_ok().then(|| {
        let subject = git(repo, &["log", "-1", "--format=%s", "REBASE_HEAD"]).map(|s| format!("“{}”", s.trim())).unwrap_or("this commit".into());
        format!("Skipped {subject}: with your resolution it changes nothing.")
    });
    git_env(repo, &["rebase", "--continue"], &[("GIT_EDITOR", OsStr::new("true"))]).map_err(|e| {
        let mut e = stopped(repo, "rebase", e);
        if let Some(note) = &skipped {
            e.message = format!("{note} {}", e.message);
        }
        e
    })?;
    if crate::git::read::operation(repo)?.is_none() {
        crate::oplog::record(repo, crate::oplog::OpEntry::new("rebase", orig, Some(rev(repo, "HEAD")?)))?;
    }
    Ok(skipped)
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

/// Brings the upstream into the current branch: merges it, or with `rebase` replays local commits on top
/// (changed files carried with `--autostash`). Logged, so undo moves HEAD back; conflicts leave it in progress.
pub fn pull(repo: &Path, rebase: bool) -> Result<(), AppError> {
    let (op, args): (&str, &[&str]) = if rebase {
        ("rebase", &["pull", "-q", "--rebase", "--autostash"])
    } else {
        ("merge", &["pull", "-q", "--no-rebase", "--no-edit"])
    };
    log_head_move(repo, "pull", || git_net(repo, args).map(drop).map_err(|e| stopped(repo, op, e)))
}

/// Pushes the current branch to its upstream. Without one it goes to the same name on `origin` (or the
/// first remote) and becomes the upstream.
pub fn push(repo: &Path) -> Result<(), AppError> {
    push_branch(repo, &current_branch(repo)?, &|_| Ok(())).map(drop)
}

/// Checks a remote URL before anything is pushed to it.
type UrlCheck<'a> = &'a dyn Fn(&str) -> Result<(), AppError>;

fn current_branch(repo: &Path) -> Result<String, AppError> {
    Ok(git(repo, &["symbolic-ref", "-q", "--short", "HEAD"])
        .map_err(|_| AppError::new("detached", "Check out a branch to push it."))?
        .trim()
        .to_string())
}

/// Pushes local `branch` as `push` does; returns the remote and the branch name there.
fn push_branch(repo: &Path, branch: &str, check: UrlCheck) -> Result<(String, String), AppError> {
    let config = |key: &str| git(repo, &["config", "--get", &format!("branch.{branch}.{key}")]).ok().map(|s| s.trim().to_string());
    let src = format!("refs/heads/{branch}");
    let (remote, dst, new) = match (config("remote"), config("merge")) {
        (Some(remote), Some(dst)) => (remote, dst, false),
        _ => (default_remote(repo)?, src.clone(), true),
    };
    ref_arg(&remote)?;
    check(git(repo, &["remote", "get-url", "--", &remote])?.trim())?;
    let spec = format!("{src}:{dst}");
    let mut args = vec!["push", "-q", &remote, &spec];
    if new {
        args.insert(2, "-u");
    }
    git_net(repo, &args)?;
    Ok((remote, dst.strip_prefix("refs/heads/").unwrap_or(&dst).to_string()))
}

/// Readies `head` for a pull request into `base`. A local branch ("" = current) is pushed first; a remote
/// branch ("origin/feat") is used as is. Returns the head's remote URL and the bare head and base names.
// ponytail: head and base on the same GitHub repo; PRs from a fork to its upstream need an owner:branch head.
pub fn pr_branches(repo: &Path, head: &str, base: &str, check: UrlCheck) -> Result<(String, String, String), AppError> {
    let remote_branch = |n: &str| split_remote(repo, n).ok().filter(|_| rev(repo, &format!("refs/remotes/{n}")).is_ok());
    let (remote, head) = match remote_branch(head) {
        Some(rb) => rb,
        None => {
            let b = if head.is_empty() { current_branch(repo)? } else { head.to_string() };
            rev(repo, &format!("refs/heads/{b}"))
                .map_err(|_| AppError::new("not_branch", format!("'{b}' isn't a branch. Pick a branch to open the pull request from.")))?;
            push_branch(repo, &b, check)?
        }
    };
    let base = remote_branch(base).map_or_else(|| base.to_string(), |(_, b)| b);
    let url = git(repo, &["remote", "get-url", "--", &remote])?.trim().to_string();
    Ok((url, head, base))
}

/// Pushes one tag to `origin` (or the first remote).
pub fn push_tag(repo: &Path, name: &str) -> Result<(), AppError> {
    ref_arg(name)?;
    git_net(repo, &["push", "-q", &default_remote(repo)?, &format!("refs/tags/{name}")]).map(drop)
}

#[derive(Debug, Serialize, TS)]
#[ts(export)]
pub struct Lfs {
    /// `git lfs` runs (git-lfs is on PATH).
    pub installed: bool,
    /// Tracked patterns as `git lfs track` lists them (spaces show as `[[:space:]]`).
    pub patterns: Vec<String>,
}

/// Git LFS state of the repo. Not installed = no patterns (git-lfs is what reads them).
pub fn lfs(repo: &Path) -> Result<Lfs, AppError> {
    #[derive(Deserialize)]
    struct Out {
        patterns: Option<Vec<Pat>>,
    }
    #[derive(Deserialize)]
    struct Pat {
        pattern: String,
        tracked: bool,
    }
    let Ok(out) = git(repo, &["lfs", "track", "--json"]) else {
        return Ok(Lfs { installed: false, patterns: vec![] });
    };
    let out: Out = serde_json::from_str(&out).map_err(|e| AppError::new("git", format!("Unexpected `git lfs track` output: {e}")))?;
    let patterns = out.patterns.unwrap_or_default().into_iter().filter(|p| p.tracked).map(|p| p.pattern).collect();
    Ok(Lfs { installed: true, patterns })
}

/// Tracks (or untracks) `pattern` with LFS. Only edits `.gitattributes` (left unstaged); files already
/// committed stay as they are until they change.
pub fn lfs_track(repo: &Path, pattern: &str, track: bool) -> Result<(), AppError> {
    if pattern.trim().is_empty() {
        return Err(AppError::new("bad_pattern", "Enter a pattern, e.g. *.psd"));
    }
    git(repo, &["lfs", if track { "track" } else { "untrack" }, "--", pattern]).map(drop)
}

/// Downloads the LFS content of the checked-out files (after a clone without git-lfs, or skipped smudge).
pub fn lfs_pull(repo: &Path) -> Result<(), AppError> {
    git_net(repo, &["lfs", "pull"]).map(drop)
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

pub fn default_remote_url(repo: &Path) -> Result<String, AppError> {
    Ok(git(repo, &["remote", "get-url", "--", &default_remote(repo)?])?.trim().to_string())
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
    /// Both sides of every conflict block, ours first.
    OursThenTheirs,
    /// Both sides of every conflict block, theirs first.
    TheirsThenOurs,
}

/// Replaces each conflict block in `text` with both sides (a diff3 base section is dropped).
/// None when there is no complete block.
fn union(text: &str, ours_first: bool) -> Option<String> {
    let (mut out, mut ours, mut theirs) = (String::new(), String::new(), String::new());
    // 0 = outside, 1 = ours, 2 = base, 3 = theirs.
    let (mut state, mut found) = (0, false);
    for line in text.split_inclusive('\n') {
        let bare = line.trim_end_matches(['\r', '\n']);
        let marker = |c: char| bare.len() >= 7 && bare[..7].chars().all(|x| x == c) && matches!(bare[7..].chars().next(), None | Some(' '));
        match state {
            0 if marker('<') => state = 1,
            1 | 2 if marker('=') => state = 3,
            1 if marker('|') => state = 2,
            3 if marker('>') => {
                let (a, b) = if ours_first { (&ours, &theirs) } else { (&theirs, &ours) };
                out.push_str(a);
                out.push_str(b);
                ours.clear();
                theirs.clear();
                (state, found) = (0, true);
            }
            0 => out.push_str(line),
            1 => ours.push_str(line),
            3 => theirs.push_str(line),
            _ => {}
        }
    }
    (found && state == 0).then_some(out)
}

/// Resolves conflicted files by taking one side whole (a side that deleted the file deletes it),
/// or both sides of each block in order, then marks them resolved. The working-tree content
/// (conflict markers, edits) is backed up first.
pub fn resolve(repo: &Path, paths: &[String], side: Side) -> Result<(), AppError> {
    // The undo label speaks the UI's "mine"/"theirs": during a rebase git's "theirs" is your commit.
    let rebasing = crate::git::read::operation(repo)?.as_deref() == Some("rebase");
    let (mine, other) = if rebasing { ("theirs", "mine") } else { ("mine", "theirs") };
    let (flag, op) = match side {
        Side::Ours => ("--ours", format!("take {mine}")),
        Side::Theirs => ("--theirs", format!("take {other}")),
        Side::OursThenTheirs => ("", format!("take {mine} then {other}")),
        Side::TheirsThenOurs => ("", format!("take {other} then {mine}")),
    };
    let op = op.as_str();
    crate::oplog::backup(repo, op, paths)?;
    if flag.is_empty() {
        for p in paths {
            let file = repo.join(p);
            let text = std::fs::read_to_string(&file).map_err(|e| AppError::new("io", e.to_string()))?;
            let merged = union(&text, matches!(side, Side::OursThenTheirs))
                .ok_or_else(|| AppError::new("no_markers", format!("{p} has no conflict markers to combine; take one side or edit it.")))?;
            std::fs::write(&file, merged).map_err(|e| AppError::new("io", e.to_string()))?;
            git(repo, &["add", "--", p])?;
        }
        return Ok(());
    }
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

/// Writes `text` as the resolved content of the conflicted `path` (backed up first) and marks it resolved.
pub fn write_resolved(repo: &Path, path: &str, text: &str) -> Result<(), AppError> {
    // "take …" so undo also brings back the conflict state, not just the markers.
    crate::oplog::backup(repo, "take AI resolution", &[path.to_string()])?;
    std::fs::write(repo.join(path), text).map_err(|e| AppError::new("io", e.to_string()))?;
    git(repo, &["add", "--", path]).map(drop)
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
    switch_carrying(repo, args, name)
}

/// Runs the switch in `args` with the uncommitted changes stashed, then puts them back on `name`.
/// If they clash there, the stash is kept and the conflicts show.
fn switch_carrying(repo: &Path, args: &[&str], name: &str) -> Result<(), AppError> {
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
    match git(repo, &args) {
        // The start point differs where the changes are: carry them like a branch switch does.
        Err(e) if checkout && e.code == "dirty" => switch_carrying(repo, &args, name),
        r => r.map(drop),
    }
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

/// Renames a local branch; its upstream and reflog move with it.
pub fn rename_branch(repo: &Path, name: &str, new_name: &str) -> Result<(), AppError> {
    ref_arg(name)?;
    ref_arg(new_name)?;
    git(repo, &["branch", "-m", name, new_name]).map(drop)
}

/// Sets which remote branch ("origin/main") `branch` pulls from and pushes to; None stops tracking.
pub fn set_upstream(repo: &Path, branch: &str, upstream: Option<&str>) -> Result<(), AppError> {
    ref_arg(branch)?;
    match upstream {
        Some(u) => {
            ref_arg(u)?;
            git(repo, &["branch", &format!("--set-upstream-to={u}"), branch])
        }
        None => git(repo, &["branch", "--unset-upstream", branch]),
    }
    .map(drop)
}

#[derive(Debug, PartialEq, Serialize, TS)]
#[ts(export)]
pub struct Remote {
    pub name: String,
    pub url: String,
}

pub fn remotes(repo: &Path) -> Result<Vec<Remote>, AppError> {
    git(repo, &["remote"])?
        .lines()
        .map(|name| Ok(Remote { name: name.into(), url: git(repo, &["remote", "get-url", "--", name])?.trim().into() }))
        .collect()
}

/// Adds remote `name` at `url`, or with `edit` points the existing one at `url`.
pub fn remote_set(repo: &Path, name: &str, url: &str, edit: bool) -> Result<(), AppError> {
    ref_arg(name)?;
    let url = url.trim();
    if url.is_empty() || url.starts_with('-') {
        return Err(AppError::new("bad_url", format!("'{url}' is not a valid remote URL.")));
    }
    git(repo, &["remote", if edit { "set-url" } else { "add" }, "--", name, url]).map(drop)
}

/// Removes remote `name` with its remote branches; local branches stop tracking it.
pub fn remote_remove(repo: &Path, name: &str) -> Result<(), AppError> {
    ref_arg(name)?;
    git(repo, &["remote", "remove", "--", name]).map(drop)
}

/// Creates an empty repository in `dir` (made if missing); the first branch follows `init.defaultBranch`.
pub fn init(dir: &Path) -> Result<(), AppError> {
    let dir = dir.to_str().ok_or_else(|| AppError::new("bad_path", "That folder name can't be used."))?;
    run(None, &["init", "-q", "--", dir], &[], None).map(drop)
}

/// Appends `pattern` to the top-level .gitignore (created if missing), matching its line endings.
/// Left unstaged, like any edit.
pub fn ignore(repo: &Path, pattern: &str) -> Result<(), AppError> {
    if pattern.trim().is_empty() || pattern.contains(['\r', '\n']) {
        return Err(AppError::new("bad_pattern", format!("'{pattern}' is not a valid ignore pattern.")));
    }
    let file = repo.join(".gitignore");
    let mut text = std::fs::read_to_string(&file).unwrap_or_default();
    if text.lines().any(|l| l.trim_end() == pattern) {
        return Ok(());
    }
    let nl = if text.contains("\r\n") { "\r\n" } else { "\n" };
    if !text.is_empty() && !text.ends_with('\n') {
        text.push_str(nl);
    }
    text.push_str(pattern);
    text.push_str(nl);
    std::fs::write(&file, text).map_err(|e| AppError::new("io", e.to_string()))
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

/// The user's global git setup: commit identity and where git keeps HTTPS sign-ins.
#[derive(Debug, Serialize, TS)]
#[ts(export)]
pub struct GitSetup {
    pub name: Option<String>,
    pub email: Option<String>,
    /// `credential.helper`, e.g. "manager" (Git Credential Manager). None = git asks every time.
    pub helper: Option<String>,
    /// What `set_global` would set as the helper on this OS; None where there's no safe default.
    pub helper_default: Option<String>,
}

fn config(scope: &str, key: &str) -> Option<String> {
    ensure_version().ok()?;
    run(None, &["config", scope, "--get", key], &[], None).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

// ponytail: Linux has no helper that's both safe and always installed (libsecret varies), so none is offered there.
const HELPER_DEFAULT: Option<&str> = if cfg!(windows) { Some("manager") } else if cfg!(target_os = "macos") { Some("osxkeychain") } else { None };

pub fn global(key: &str) -> Option<String> {
    config("--global", key)
}

/// Git for Windows sets the helper in the system config, so look there too.
fn helper() -> Option<String> {
    global("credential.helper").or_else(|| config("--system", "credential.helper"))
}

pub fn git_setup() -> GitSetup {
    GitSetup { name: global("user.name"), email: global("user.email"), helper: helper(), helper_default: HELPER_DEFAULT.map(String::from) }
}

/// Sets the global identity, and the OS credential helper when `helper` is true and none is set.
pub fn set_global(name: &str, email: &str, helper: bool) -> Result<(), AppError> {
    ensure_version()?;
    for (k, v) in [("user.name", name.trim()), ("user.email", email.trim())] {
        if v.is_empty() {
            return Err(AppError::new("identity", "Enter both a name and an email."));
        }
        run(None, &["config", "--global", k, v], &[], None)?;
    }
    if let (true, None, Some(h)) = (helper, self::helper(), HELPER_DEFAULT) {
        run(None, &["config", "--global", "credential.helper", h], &[], None)?;
    }
    Ok(())
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
    fn unions_conflicts() {
        let t = "a\n<<<<<<< HEAD\no\n||||||| base\nb\n=======\nt\n>>>>>>> x\nz\n";
        assert_eq!(union(t, true).as_deref(), Some("a\no\nt\nz\n"));
        assert_eq!(union(t, false).as_deref(), Some("a\nt\no\nz\n"));
        assert_eq!(union("plain\n", true), None);
        assert_eq!(union("<<<<<<< HEAD\no\n=======\n", true), None);
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
    fn lfs_patterns() {
        let dir = std::env::temp_dir().join(format!("git-ai-test-lfs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.as_path();
        git(p, &["init", "-q"]).unwrap();
        if !lfs(p).unwrap().installed {
            return eprintln!("git-lfs not installed, skipped");
        }
        assert!(lfs(p).unwrap().patterns.is_empty());
        lfs_track(p, "*.psd", true).unwrap();
        lfs_track(p, "my file.bin", true).unwrap();
        lfs_track(p, "-x", true).unwrap(); // `--` keeps it from reading as a flag
        let pats = lfs(p).unwrap().patterns;
        assert_eq!(pats, ["*.psd", "my[[:space:]]file.bin", "-x"]);
        lfs_track(p, &pats[1], false).unwrap();
        assert_eq!(lfs(p).unwrap().patterns, ["*.psd", "-x"]);
        assert_eq!(lfs_track(p, " ", true).unwrap_err().code, "bad_pattern");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn repo_actions() {
        let dir = std::env::temp_dir().join(format!("git-ai-test-actions-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let p = dir.join("new repo");
        init(&p).unwrap();
        git(&p, &["config", "user.name", "T"]).unwrap();
        git(&p, &["config", "user.email", "t@example.com"]).unwrap();
        git(&p, &["config", "core.autocrlf", "false"]).unwrap();
        std::fs::write(p.join("a.txt"), "one\n").unwrap();
        git(&p, &["add", "a.txt"]).unwrap();
        git(&p, &["commit", "-q", "-m", "one"]).unwrap();
        std::fs::write(p.join("a.txt"), "two\n").unwrap();
        git(&p, &["commit", "-q", "-am", "two"]).unwrap();
        // revert: content back, logged for undo
        revert(&p, &rev(&p, "HEAD").unwrap()).unwrap();
        assert_eq!(std::fs::read_to_string(p.join("a.txt")).unwrap(), "one\n");
        assert_eq!(crate::oplog::entries(&p, 1).unwrap()[0].op, "revert");
        // rename, remotes, upstream
        let b = current_branch(&p).unwrap();
        rename_branch(&p, &b, "trunk").unwrap();
        assert_eq!(current_branch(&p).unwrap(), "trunk");
        assert_eq!(rename_branch(&p, "-x", "y").unwrap_err().code, "bad_name");
        remote_set(&p, "origin", "https://example.com/a.git", false).unwrap();
        remote_set(&p, "origin", "https://example.com/b.git", true).unwrap();
        assert_eq!(remotes(&p).unwrap(), [Remote { name: "origin".into(), url: "https://example.com/b.git".into() }]);
        assert_eq!(remote_set(&p, "x", "--upload-pack=evil", false).unwrap_err().code, "bad_url");
        git(&p, &["update-ref", "refs/remotes/origin/trunk", "HEAD"]).unwrap();
        set_upstream(&p, "trunk", Some("origin/trunk")).unwrap();
        assert_eq!(git(&p, &["rev-parse", "--abbrev-ref", "trunk@{u}"]).unwrap().trim(), "origin/trunk");
        set_upstream(&p, "trunk", None).unwrap();
        assert!(git(&p, &["rev-parse", "--abbrev-ref", "trunk@{u}"]).is_err());
        remote_remove(&p, "origin").unwrap();
        assert!(remotes(&p).unwrap().is_empty());
        // ignore: appended once, CRLF kept
        std::fs::write(p.join(".gitignore"), "x\r\ny").unwrap();
        ignore(&p, "/build/").unwrap();
        ignore(&p, "/build/").unwrap();
        assert_eq!(std::fs::read_to_string(p.join(".gitignore")).unwrap(), "x\r\ny\r\n/build/\r\n");
        assert_eq!(ignore(&p, "a\nb").unwrap_err().code, "bad_pattern");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn runs_git() {
        ensure_version().unwrap();
        let out = git(Path::new("."), &["rev-parse", "--is-inside-work-tree"]).unwrap();
        assert_eq!(out.trim(), "true");
        status(Path::new(".")).unwrap();
    }
}
