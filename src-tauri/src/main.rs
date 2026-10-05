// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Launched by git as GIT_ASKPASS / SSH_ASKPASS: forward the prompt to the running app.
    if std::env::var_os("GITAI_ASKPASS").is_some() {
        std::process::exit(git_ai_lib::askpass::client());
    }
    git_ai_lib::run()
}
