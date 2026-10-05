//! IPC surface.
use crate::errors::AppError;
use crate::git::{cli, graph, read};
use crate::oplog;
use crate::watch;
use serde_json::{json, Value};
use std::path::Path;
use tauri::{AppHandle, State};
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

#[tauri::command]
pub fn undo(path: String, id: String) -> Result<(), AppError> {
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
