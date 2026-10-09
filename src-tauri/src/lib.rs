mod ai;
pub mod askpass;
mod commands;
mod editors;
mod errors;
mod git;
mod github;
mod gitlab;
mod oplog;
mod terminal;
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
            commands::reset_to,
            commands::revert, commands::rename_branch, commands::set_upstream, commands::remotes, commands::remote_set,
            commands::remote_remove, commands::ignore, commands::init_repo,
            commands::abort,
            commands::rebase_commits,
            commands::rebase,
            commands::lfs,
            commands::lfs_track,
            commands::lfs_pull,
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
            commands::write_resolved,
            commands::work_file,
            commands::open_file,
            commands::editors,
            commands::open_terminal,
            commands::terminals,
            commands::terminal_set,
            commands::pty_open,
            commands::pty_write,
            commands::pty_resize,
            commands::pty_close,
            commands::github_start,
            commands::github_finish,
            commands::github_user,
            commands::github_repos,
            commands::create_pr,
            commands::pr_provider,
            commands::github_sign_out,
            commands::gitlab_start,
            commands::gitlab_finish,
            commands::gitlab_user,
            commands::gitlab_repos,
            commands::gitlab_sign_out,
            commands::ssh_key,
            commands::ssh_key_set,
            commands::ssh_detect,
            commands::git_setup,
            commands::git_setup_set,
            commands::setup_done,
            commands::setup_finish,
            commands::ai_config,
            commands::ai_set_config,
            commands::ai_has_key,
            commands::ai_set_key,
            commands::ai_commit_message,
            commands::ai_explain_commit,
            commands::ai_explain_stash,
            commands::ai_write_range,
            commands::ai_resolve_conflict,
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
