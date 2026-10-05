//! IPC surface.
use crate::errors::AppError;
use crate::git::{cli, read};
use crate::watch;
use serde_json::{json, Value};
use std::path::Path;
use tauri::AppHandle;
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
pub fn commit(path: String, message: String) -> Result<(), AppError> {
    cli::commit(Path::new(&path), &message)
}

#[tauri::command]
pub fn file_diff(path: String, file: String, staged: bool) -> Result<Option<String>, AppError> {
    read::file_diff(Path::new(&path), &file, staged)
}
