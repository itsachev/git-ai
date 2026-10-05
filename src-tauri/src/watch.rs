//! Watches the open repo and emits `repo-changed` (payload: repo path) so the UI refetches.
use crate::errors::AppError;
use notify_debouncer_mini::{new_debouncer, notify::RecommendedWatcher, notify::RecursiveMode, Debouncer};
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// The single active watcher; replacing it drops (stops) the previous one.
#[derive(Default)]
pub struct RepoWatcher(Mutex<Option<Debouncer<RecommendedWatcher>>>);

// ponytail: watches the whole tree incl. build dirs, so busy builds cause extra (cheap) status refreshes; filter by .gitignore if it shows up in profiles.
pub fn watch(app: &AppHandle, path: &str) -> Result<(), AppError> {
    let err = |e: notify_debouncer_mini::notify::Error| AppError::new("watch", e.to_string());
    let (handle, repo) = (app.clone(), path.to_string());
    let mut debouncer = new_debouncer(Duration::from_millis(300), move |res: notify_debouncer_mini::DebounceEventResult| {
        if res.is_ok() {
            let _ = handle.emit("repo-changed", &repo);
        }
    })
    .map_err(err)?;
    debouncer.watcher().watch(Path::new(path), RecursiveMode::Recursive).map_err(err)?;
    *app.state::<RepoWatcher>().0.lock().unwrap() = Some(debouncer);
    Ok(())
}
