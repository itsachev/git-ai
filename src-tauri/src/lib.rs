pub mod askpass;
mod commands;
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
        .setup(|app| Ok(askpass::start(app.handle().clone())?))
        .manage(watch::RepoWatcher::default())
        .manage(git::graph::GraphCache::default())
        .invoke_handler(tauri::generate_handler![
            commands::open_repo, commands::recent_repos, commands::repo_status,
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
            commands::abort,
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
            commands::github_start,
            commands::github_finish,
            commands::github_user,
            commands::github_sign_out,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
