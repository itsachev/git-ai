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
const MAX_RECENT: usize = 10;

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
    oplog::entries(Path::new(&path), 20)
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
pub fn checkout(path: String, name: String, track: bool) -> Result<(), AppError> {
    cli::checkout(Path::new(&path), &name, track)
}

#[tauri::command]
pub fn create_branch(path: String, name: String, checkout: bool) -> Result<(), AppError> {
    cli::create_branch(Path::new(&path), &name, checkout)
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

/// Opens a repo file in its default app (e.g. to resolve a conflict in an editor).
#[tauri::command]
pub fn open_file(app: AppHandle, path: String, file: String) -> Result<(), AppError> {
    use tauri_plugin_opener::OpenerExt;
    // Only paths inside the repo; `file` comes from the status list.
    let rel = Path::new(&file);
    if rel.is_absolute() || rel.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(AppError::new("bad_path", format!("'{file}' is not inside the repository.")));
    }
    let full = Path::new(&path).join(rel);
    app.opener().open_path(full.to_string_lossy(), None::<&str>).map_err(|e| AppError::new("open", e.to_string()))
}

#[tauri::command]
pub fn askpass_reply(id: u32, answer: Option<String>) {
    crate::askpass::reply(id, answer)
}
