//! IPC surface.
use crate::errors::AppError;
use crate::git::{cli, graph, read};
use crate::oplog;
use crate::watch;
use serde_json::{json, Value};
use std::path::Path;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_store::StoreExt;

const STORE: &str = "settings.json";
const MAX_RECENT: usize = 100;

#[tauri::command]
pub fn open_repo(app: AppHandle, path: String) -> Result<read::RepoInfo, AppError> {
    cli::ensure_version()?;
    let info = read::open(Path::new(&path))?;
    let mut recent = recent_repos(app.clone());
    recent.retain(|p| p != &info.path);
    recent.insert(0, info.path.clone());
    recent.truncate(MAX_RECENT);
    let store = app.store(STORE).map_err(|e| AppError::new("store", e.to_string()))?;
    store.set("recent", json!(recent));
    watch::watch(&app, &info.path)?;
    Ok(info)
}

#[tauri::command]
pub fn recent_repos(app: AppHandle) -> Vec<String> {
    app.store(STORE)
        .ok()
        .and_then(|s| s.get("recent"))
        .and_then(|v: Value| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

/// Recent repos whose folder no longer exists (deleted or moved outside the app).
#[tauri::command]
pub fn missing_repos(app: AppHandle) -> Vec<String> {
    recent_repos(app).into_iter().filter(|p| !Path::new(p).exists()).collect()
}

/// Drops `path` from the recent list; the folder stays on disk.
#[tauri::command]
pub fn forget_repo(app: AppHandle, path: String) -> Result<(), AppError> {
    let mut recent = recent_repos(app.clone());
    recent.retain(|p| p != &path);
    let store = app.store(STORE).map_err(|e| AppError::new("store", e.to_string()))?;
    store.set("recent", json!(recent));
    Ok(())
}

/// Moves a recent repo's folder to the OS trash (recoverable from there), then forgets it.
/// Only paths already in the recent list, so IPC can't trash arbitrary folders.
#[tauri::command]
pub fn trash_repo(app: AppHandle, path: String) -> Result<(), AppError> {
    if !recent_repos(app.clone()).contains(&path) {
        return Err(AppError::new("not_recent", "That folder isn't in your recent repositories."));
    }
    watch::stop(&app);
    if Path::new(&path).exists() {
        trash::delete(&path)
            .map_err(|e| AppError::new("trash", format!("Couldn't move the folder to the trash. Is a file in it open in another program? ({e})")))?;
    }
    forget_repo(app, path)
}

#[tauri::command]
pub fn repo_status(path: String) -> Result<cli::Status, AppError> {
    cli::status(Path::new(&path))
}

#[tauri::command]
pub fn stage(path: String, paths: Vec<String>) -> Result<(), AppError> {
    cli::stage(Path::new(&path), &paths)
}

#[tauri::command]
pub fn unstage(path: String, paths: Vec<String>) -> Result<(), AppError> {
    cli::unstage(Path::new(&path), &paths)
}

#[tauri::command]
pub fn discard(path: String, paths: Vec<String>) -> Result<(), AppError> {
    cli::discard(Path::new(&path), &paths)
}

#[tauri::command]
pub fn commit(path: String, message: String, amend: bool) -> Result<(), AppError> {
    cli::commit(Path::new(&path), &message, amend)
}

#[tauri::command]
pub fn head_message(path: String) -> Result<Option<String>, AppError> {
    read::head_message(Path::new(&path))
}

#[tauri::command]
pub fn apply_lines(path: String, file: String, op: cli::LineOp, lines: Vec<usize>) -> Result<(), AppError> {
    cli::apply_lines(Path::new(&path), &file, op, &lines)
}

#[tauri::command]
pub fn op_log(path: String) -> Result<Vec<oplog::OpEntry>, AppError> {
    oplog::entries(Path::new(&path), 500)
}

/// Async: undoing a remote branch delete pushes.
#[tauri::command]
pub async fn undo(path: String, id: String) -> Result<(), AppError> {
    oplog::undo(Path::new(&path), &id)
}

/// Async so the first layout of a big repo runs off the main thread.
#[tauri::command]
pub async fn graph_rows(
    cache: State<'_, graph::GraphCache>,
    path: String,
    offset: usize,
    limit: usize,
) -> Result<graph::GraphPage, AppError> {
    graph::rows(&cache, Path::new(&path), offset, limit)
}

#[tauri::command]
pub async fn commit_details(path: String, oid: String) -> Result<read::CommitDetails, AppError> {
    read::commit_details(Path::new(&path), &oid)
}

#[tauri::command]
pub async fn commit_file_diff(path: String, oid: String, file: String) -> Result<Option<String>, AppError> {
    read::commit_file_diff(Path::new(&path), &oid, &file)
}

#[tauri::command]
pub fn refs(path: String) -> Result<read::Refs, AppError> {
    read::refs(Path::new(&path))
}

#[tauri::command]
pub fn checkout(path: String, name: String, track: bool, carry: bool) -> Result<(), AppError> {
    cli::checkout(Path::new(&path), &name, track, carry)
}

#[tauri::command]
pub fn create_branch(path: String, name: String, from: Option<String>, checkout: bool) -> Result<(), AppError> {
    cli::create_branch(Path::new(&path), &name, from.as_deref(), checkout)
}

#[tauri::command]
pub fn delete_branch(path: String, name: String, force: bool) -> Result<(), AppError> {
    cli::delete_branch(Path::new(&path), &name, force)
}

#[tauri::command]
pub fn file_diff(path: String, file: String, staged: bool) -> Result<Option<String>, AppError> {
    read::file_diff(Path::new(&path), &file, staged)
}

#[tauri::command]
pub fn merge(path: String, rev: String, cherry_pick: bool) -> Result<(), AppError> {
    cli::merge(Path::new(&path), &rev, cherry_pick)
}

#[tauri::command]
pub fn rebase_onto(path: String, onto: String) -> Result<(), AppError> {
    cli::rebase_onto(Path::new(&path), &onto)
}

#[tauri::command]
pub fn abort(path: String) -> Result<(), AppError> {
    cli::abort(Path::new(&path))
}

#[tauri::command]
pub fn create_tag(path: String, name: String, target: String, message: String) -> Result<(), AppError> {
    cli::create_tag(Path::new(&path), &name, &target, &message)
}

#[tauri::command]
pub fn delete_tag(path: String, name: String) -> Result<(), AppError> {
    cli::delete_tag(Path::new(&path), &name)
}

#[tauri::command]
pub fn stash_save(path: String, message: String) -> Result<(), AppError> {
    cli::stash_save(Path::new(&path), &message)
}

#[tauri::command]
pub fn stash(path: String, op: cli::StashOp, index: usize, oid: String) -> Result<(), AppError> {
    cli::stash(Path::new(&path), op, index, &oid)
}

// Network ops are async (off the main thread) so the UI, and with it askpass prompts, keep working.

#[tauri::command]
pub async fn fetch(path: String) -> Result<(), AppError> {
    cli::fetch(Path::new(&path))
}

#[tauri::command]
pub async fn pull(path: String) -> Result<(), AppError> {
    cli::pull(Path::new(&path))
}

#[tauri::command]
pub async fn push(path: String) -> Result<(), AppError> {
    cli::push(Path::new(&path))
}

#[tauri::command]
pub async fn push_tag(path: String, name: String) -> Result<(), AppError> {
    cli::push_tag(Path::new(&path), &name)
}

#[tauri::command]
pub async fn delete_remote_branch(path: String, name: String) -> Result<(), AppError> {
    cli::delete_remote_branch(Path::new(&path), &name)
}

/// Clones into `dest`, emitting git's progress lines as "clone-progress", then opens it like `open_repo`.
#[tauri::command]
pub async fn clone_repo(app: AppHandle, url: String, dest: String) -> Result<read::RepoInfo, AppError> {
    cli::clone(&url, Path::new(&dest), |line| {
        let _ = app.emit("clone-progress", line);
    })?;
    open_repo(app, dest)
}

#[tauri::command]
pub fn resolve(path: String, paths: Vec<String>, side: cli::Side) -> Result<(), AppError> {
    cli::resolve(Path::new(&path), &paths, side)
}

#[tauri::command]
pub fn work_file(path: String, file: String) -> Result<Option<String>, AppError> {
    read::work_file(Path::new(&path), &file)
}

/// Editors installed here plus the last one picked for `open_file`.
#[tauri::command]
pub fn editors(app: AppHandle) -> crate::editors::Editors {
    crate::editors::list(app.store(STORE).ok().and_then(|s| s.get("editor")).and_then(|v| v.as_str().map(String::from)))
}

/// Opens a repo file (e.g. to resolve a conflict) in `editor` (a name from `editors`), or its default app when None.
/// The choice is remembered for next time.
#[tauri::command]
pub fn open_file(app: AppHandle, path: String, file: String, editor: Option<String>) -> Result<(), AppError> {
    use tauri_plugin_opener::OpenerExt;
    // Only paths inside the repo; `file` comes from the status list.
    let rel = Path::new(&file);
    if rel.is_absolute() || rel.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(AppError::new("bad_path", format!("'{file}' is not inside the repository.")));
    }
    let full = Path::new(&path).join(rel);
    if let Ok(store) = app.store(STORE) {
        match &editor {
            Some(e) => store.set("editor", json!(e)),
            None => drop(store.delete("editor")),
        }
    }
    match editor {
        Some(e) => crate::editors::open(&e, &full),
        None => app.opener().open_path(full.to_string_lossy(), None::<&str>).map_err(|e| AppError::new("open", e.to_string())),
    }
}

#[tauri::command]
pub fn askpass_reply(id: u32, answer: Option<String>) {
    crate::askpass::reply(id, answer)
}

// GitHub sign-in (device flow); async because each call goes over the network.
#[tauri::command]
pub async fn github_start() -> Result<crate::github::DeviceCode, AppError> {
    crate::github::start()
}

/// Waits until the user approves the code in the browser (or it expires); returns the login.
#[tauri::command]
pub async fn github_finish(code: crate::github::DeviceCode) -> Result<String, AppError> {
    crate::github::finish(&code)
}

#[tauri::command]
pub async fn github_user() -> Result<Option<String>, AppError> {
    crate::github::user()
}

#[tauri::command]
pub async fn github_repos() -> Result<Vec<crate::github::GhRepo>, AppError> {
    crate::github::repos()
}

/// Pushes `head` (a local branch, "" = current; a remote branch is used as is), then opens a pull request
/// into `base` on GitHub. Returns the PR's web URL.
#[tauri::command]
pub async fn github_create_pr(path: String, head: String, base: String, title: String, body: String) -> Result<String, AppError> {
    let (url, head, base) = cli::pr_branches(Path::new(&path), &head, &base)?;
    crate::github::create_pr(&url, &head, &base, &title, &body)
}

#[tauri::command]
pub fn github_sign_out() -> Result<(), AppError> {
    crate::github::sign_out()
}

// SSH key for network git (path only; the key file stays where it is).
#[tauri::command]
pub fn ssh_key(app: AppHandle) -> Option<String> {
    app.store(STORE).ok()?.get("ssh_key")?.as_str().map(String::from)
}

/// Checks that `path` is a private key file, saves it and uses it from the next network op. None = ssh defaults.
#[tauri::command]
pub fn ssh_key_set(app: AppHandle, path: Option<String>) -> Result<(), AppError> {
    let path = path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
    if let Some(p) = &path {
        let bad = |m: &str| Err(AppError::new("ssh_key", m));
        if p.contains('\'') {
            return bad("The key path can't contain a ' character. Move or rename the key.");
        }
        if p.ends_with(".pub") {
            return bad("That's the public key. Pick the private key: the same file without .pub.");
        }
        let Ok(text) = std::fs::read_to_string(p) else { return bad("Can't read that file.") };
        if !text.contains("PRIVATE KEY") {
            return bad("That file isn't an SSH private key.");
        }
    }
    let store = app.store(STORE).map_err(|e| AppError::new("store", e.to_string()))?;
    match &path {
        Some(p) => store.set("ssh_key", json!(p)),
        None => drop(store.delete("ssh_key")),
    }
    crate::askpass::set_ssh_key(path);
    Ok(())
}

#[tauri::command]
pub fn git_setup() -> cli::GitSetup {
    cli::git_setup()
}

#[tauri::command]
pub fn git_setup_set(name: String, email: String, helper: bool) -> Result<(), AppError> {
    cli::set_global(&name, &email, helper)
}

/// Whether the first-run setup was finished or skipped.
#[tauri::command]
pub fn setup_done(app: AppHandle) -> bool {
    app.store(STORE).ok().and_then(|s| s.get("setup_done")).is_some_and(|v| v == json!(true))
}

#[tauri::command]
pub fn setup_finish(app: AppHandle) -> Result<(), AppError> {
    app.store(STORE).map_err(|e| AppError::new("store", e.to_string()))?.set("setup_done", json!(true));
    Ok(())
}

/// Private keys in ~/.ssh, the default names (id_ed25519, id_ecdsa, id_rsa) first.
#[tauri::command]
pub fn ssh_detect(app: AppHandle) -> Vec<String> {
    use tauri::Manager;
    let Ok(dir) = app.path().home_dir().map(|h| h.join(".ssh")) else { return vec![] };
    let mut keys: Vec<String> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.extension().is_none_or(|x| x != "pub")
                && p.metadata().is_ok_and(|m| m.is_file() && m.len() < 32_000)
                && std::fs::read_to_string(p).is_ok_and(|t| t.contains("PRIVATE KEY"))
        })
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    let rank = |k: &String| ["id_ed25519", "id_ecdsa", "id_rsa"].iter().position(|n| k.ends_with(n)).unwrap_or(3);
    keys.sort_by_key(|k| (rank(k), k.clone()));
    keys
}

// AI (Gemini, BYOK).
#[tauri::command]
pub fn ai_has_key() -> bool {
    crate::ai::has_key()
}

#[tauri::command]
pub fn ai_set_key(key: Option<String>) -> Result<(), AppError> {
    crate::ai::set_key(key)
}

/// Sends the staged diff to Gemini; async because it goes over the network.
#[tauri::command]
pub async fn ai_commit_message(path: String) -> Result<String, AppError> {
    crate::ai::commit_message(Path::new(&path))
}

/// Sends one commit's message and diff to Gemini.
#[tauri::command]
pub async fn ai_explain_commit(path: String, oid: String) -> Result<String, AppError> {
    crate::ai::explain_commit(Path::new(&path), &oid)
}

/// Sends one stash's changes (untracked files too) to Gemini.
#[tauri::command]
pub async fn ai_explain_stash(path: String, oid: String) -> Result<String, AppError> {
    crate::ai::explain_stash(Path::new(&path), &oid)
}

/// Sends a commit range (messages + combined diff) to Gemini for a PR description, changelog or explanation.
#[tauri::command]
pub async fn ai_write_range(path: String, base: String, head: String, kind: String) -> Result<String, AppError> {
    crate::ai::write_range(Path::new(&path), &base, &head, &kind)
}

/// Commits in `base..HEAD` (oldest first) for the interactive rebase dialog.
#[tauri::command]
pub fn rebase_commits(path: String, base: String) -> Result<Vec<read::RebaseCommit>, AppError> {
    read::rebase_commits(Path::new(&path), &base)
}

/// Async: walks the whole history reachable from `rev`.
#[tauri::command]
pub async fn file_log(path: String, rev: String, file: String) -> Result<Vec<read::FileCommit>, AppError> {
    read::file_log(Path::new(&path), &rev, &file, 2000)
}

/// Async: libgit2 blame can take seconds on a long-lived file.
#[tauri::command]
pub async fn blame(path: String, rev: String, file: String) -> Result<read::Blame, AppError> {
    read::blame(Path::new(&path), &rev, &file)
}

#[tauri::command]
pub fn rebase(path: String, base: String, steps: Vec<cli::RebaseStep>) -> Result<(), AppError> {
    cli::rebase(Path::new(&path), &base, &steps)
}
