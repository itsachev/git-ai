mod commands;
mod errors;
mod git;
mod oplog;
mod watch;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
