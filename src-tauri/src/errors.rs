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

    /// A failed git command: known failures get a code and a plain explanation, the rest keep git's text (code "git").
    pub fn from_stderr(stderr: &str) -> Self {
        if stderr.contains("would be overwritten by") {
            // git lists the files tab-indented under the error line.
            let files: Vec<&str> = stderr.lines().filter(|l| l.starts_with('\t')).map(str::trim).collect();
            let what = if files.is_empty() { "some files".to_string() } else { files.join(", ") };
            return Self::new("dirty", format!("This would overwrite your uncommitted changes to {what}. Commit or stash them first, then try again."));
        }
        Self::new("git", stderr.trim())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dirty_checkout() {
        let e = AppError::from_stderr("error: Your local changes to the following files would be overwritten by checkout:
	a.txt
	dir/b.txt
Please commit your changes or stash them before you switch branches.
Aborting
");
        assert_eq!(e.code, "dirty");
        assert!(e.message.contains("a.txt, dir/b.txt"), "{}", e.message);
        assert_eq!(AppError::from_stderr("fatal: nope
").code, "git");
    }
}
