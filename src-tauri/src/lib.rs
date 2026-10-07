mod ai;
pub mod askpass;
mod commands;
mod editors;
mod errors;
mod git;
mod github;
mod oplog;
mod watch;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            #[cfg(desktop)]
            fit_to_work_area(app);
            askpass::set_ssh_key(commands::ssh_key(app.handle().clone()));
            Ok(askpass::start(app.handle().clone())?)
        })
        .manage(watch::RepoWatcher::default())
        .manage(git::graph::GraphCache::default())
        .invoke_handler(tauri::generate_handler![
            commands::open_repo, commands::recent_repos, commands::missing_repos,commands::forget_repo, commands::trash_repo, commands::repo_status,
            commands::stage,
            commands::unstage,
            commands::discard,
            commands::commit,
            commands::file_diff,
            commands::head_message,
            commands::apply_lines,
            commands::op_log,
            commands::undo,
            commands::graph_rows,
            commands::commit_details,
            commands::commit_file_diff,
            commands::refs,
            commands::checkout,
            commands::create_branch,
            commands::delete_branch,
            commands::merge,
            commands::rebase_onto,
            commands::abort,
            commands::rebase_commits,
            commands::rebase,
            commands::file_log,
            commands::blame,
            commands::create_tag,
            commands::delete_tag,
            commands::stash_save,
            commands::stash,
            commands::fetch,
            commands::pull,
            commands::push,
            commands::push_tag,
            commands::delete_remote_branch,
            commands::askpass_reply,
            commands::clone_repo,
            commands::resolve,
            commands::work_file,
            commands::open_file,
            commands::editors,
            commands::github_start,
            commands::github_finish,
            commands::github_user,
            commands::github_repos,
            commands::github_create_pr,
            commands::github_sign_out,
            commands::ssh_key,
            commands::ssh_key_set,
            commands::ssh_detect,
            commands::git_setup,
            commands::git_setup_set,
            commands::setup_done,
            commands::setup_finish,
            commands::ai_has_key,
            commands::ai_set_key,
            commands::ai_commit_message,
            commands::ai_explain_commit,
            commands::ai_write_range,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// The configured 1280x800 is logical; with display scaling it can exceed the
/// screen and slide under the taskbar. Shrink to 90% of the work area if so.
#[cfg(desktop)]
fn fit_to_work_area(app: &tauri::App) {
    use tauri::Manager;
    let Some(win) = app.get_webview_window("main") else { return };
    let (Ok(Some(mon)), Ok(size)) = (win.current_monitor(), win.outer_size()) else { return };
    let area = mon.work_area();
    let w = size.width.min(area.size.width * 9 / 10);
    let h = size.height.min(area.size.height * 9 / 10);
    if (w, h) != (size.width, size.height) {
        // set_size takes the inner size; the frame difference is small enough to ignore.
        let _ = win.set_size(tauri::PhysicalSize::new(w, h));
        let _ = win.center();
    }
}
