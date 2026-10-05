use serde::Serialize;
use ts_rs::TS;

/// Error sent to the frontend: a stable code plus a beginner-friendly message.
#[derive(Debug, Serialize, TS)]
#[ts(export)]
pub struct AppError {
    pub code: String,
    pub message: String,
}

impl AppError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into() }
    }
}

impl From<git2::Error> for AppError {
    fn from(e: git2::Error) -> Self {
        match e.code() {
            git2::ErrorCode::NotFound => Self::new("not_a_repo", "This folder is not a Git repository."),
            _ => Self::new("git", e.message()),
        }
    }
}
