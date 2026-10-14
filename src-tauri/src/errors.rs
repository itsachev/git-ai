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
        let stripped = strip_ansi(stderr);
        let stderr = stripped.as_str();
        // The second is `reset --keep` refusing to touch an edited file.
        if stderr.contains("would be overwritten by") || stderr.contains("not uptodate. Cannot merge") {
            return Self::new("dirty", "You have uncommitted changes. Stash, commit or discard them, then try again.");
        }
        if stderr.contains("[rejected]") && (stderr.contains("(fetch first)") || stderr.contains("(non-fast-forward)")) {
            return Self::new("rejected", "The remote has commits you don't have yet. Pull first, then push again.");
        }
        if stderr.contains("git-lfs") && (stderr.contains("not found") || stderr.contains("is not a git command")) {
            return Self::new("lfs_missing", "This repository uses Git LFS, but Git LFS isn't installed. Install it from git-lfs.com, then try again.");
        }
        if stderr.contains("already exists and is not an empty directory") {
            return Self::new("exists", "That folder already exists and isn't empty. Pick another folder name.");
        }
        Self::new("git", stderr.trim())
    }
}

/// Drops terminal escape sequences (colours, cursor moves, hyperlinks) that hooks like lefthook print even into a pipe.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        match chars.next() {
            // CSI: parameters, then one final byte in @..~.
            Some('[') => {
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            // OSC: ends at BEL or ESC \.
            Some(']') => {
                while let Some(c) = chars.next() {
                    if c == '\x07' || (c == '\x1b' && chars.next_if_eq(&'\\').is_some()) {
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
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
        assert!(e.message.starts_with("You have uncommitted changes"), "{}", e.message);
        assert_eq!(AppError::from_stderr("fatal: nope
").code, "git");
        let lfs = "git-lfs filter-process: git-lfs: command not found\nfatal: the remote end hung up unexpectedly\n";
        assert_eq!(AppError::from_stderr(lfs).code, "lfs_missing");
        assert_eq!(AppError::from_stderr("This repository is configured for Git LFS but 'git-lfs' was not found on your path.").code, "lfs_missing");
        assert_eq!(AppError::from_stderr("fatal: destination path 'x' already exists and is not an empty directory.\n").code, "exists");
    }

    #[test]
    fn hook_colours_stripped() {
        let e = AppError::from_stderr("\x1b[38;2;56;56;56m\u{2502} \x1b[0mlefthook  hook: \x1b[1mcommit-msg\x1b[0m\n\x1b]8;;https://x\x07link\x1b]8;;\x1b\\\n");
        assert_eq!(e.message, "\u{2502} lefthook  hook: commit-msg\nlink");
    }

    #[test]
    fn rejected_push() {
        let e = AppError::from_stderr("To C:/remote.git
 ! [rejected]        main -> main (fetch first)
error: failed to push some refs to 'C:/remote.git'
hint: Updates were rejected because the remote contains work that you do not
");
        assert_eq!(e.code, "rejected");
        assert_eq!(AppError::from_stderr(" ! [rejected]        main -> main (non-fast-forward)
").code, "rejected");
    }
}
