//! AI features through Gemini (BYOK). The key comes from `GEMINI_API_KEY` (dev), else the OS keychain.
use crate::errors::AppError;
use crate::git::read;
use serde_json::{json, Value};
use std::path::Path;

const MODEL: &str = "gemini-3.5-flash-lite";
/// Diff text sent at most (bytes); the rest is cut with a note.
const MAX_DIFF: usize = 100_000;

const COMMIT_PROMPT: &str = "You write git commit messages. From the staged diff, write one message: \
an imperative subject line of at most 72 characters, then, only if the change needs explaining, a blank \
line and a short body (why, not a line-by-line what). Match the style of the recent subjects if given. \
Plain text only: no Markdown, no code fences, no quotes around the message.";

const EXPLAIN_PROMPT: &str = "You explain git commits to a developer reading the history. From the commit \
message and diff, say in plain words what the commit changes and, if the code shows it, why. Start with one \
sentence summary, then at most 5 short \"- \" bullets for the notable changes. Mention risky or surprising \
changes. Plain text only: no Markdown headings, no bold, no code fences.";

const PR_PROMPT: &str = "You write pull request descriptions. From the commit messages and the combined diff \
of a branch, write: a title of at most 72 characters on the first line, a blank line, then a description \
with a short \"## Summary\" paragraph (what and why) and a \"## Changes\" list of \"- \" bullets. Add a \
\"## Notes\" list only for risky changes, migrations or follow-ups the reviewer should know. GitHub Markdown, \
no code fences around the whole answer.";

const CHANGELOG_PROMPT: &str = "You write release changelogs for users of the software. From the commit messages \
and the combined diff of a release, write Markdown \"- \" bullets grouped under \"### Added\", \"### Changed\", \
\"### Fixed\" and \"### Removed\" (leave out empty groups). One line per user-visible change, in plain words; \
merge related commits, skip pure refactors, tests and CI unless they matter to users. No title, no code fences.";

fn keychain() -> Result<keyring::Entry, AppError> {
    keyring::Entry::new("git-ai", "gemini").map_err(|e| AppError::new("keychain", e.to_string()))
}

fn key() -> Option<String> {
    std::env::var("GEMINI_API_KEY").ok().or_else(|| keychain().ok()?.get_password().ok()).filter(|k| !k.trim().is_empty())
}

pub fn has_key() -> bool {
    key().is_some()
}

/// Stores the key in the keychain; None (or blank) removes it.
pub fn set_key(key: Option<String>) -> Result<(), AppError> {
    let entry = keychain()?;
    let res = match key.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
        Some(k) => entry.set_password(k),
        None => match entry.delete_credential() {
            Err(keyring::Error::NoEntry) => Ok(()),
            r => r,
        },
    };
    res.map_err(|e| AppError::new("keychain", e.to_string()))
}

/// Cuts `s` to at most `max` bytes on a char boundary.
fn clip(s: &str, max: usize) -> (&str, bool) {
    if s.len() <= max {
        return (s, false);
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    (&s[..end], true)
}

pub fn commit_message(repo: &Path) -> Result<String, AppError> {
    let diff = read::staged_patch(repo)?;
    if diff.trim().is_empty() {
        return Err(AppError::new("nothing_staged", "Stage some changes first, then generate a message."));
    }
    let (diff, cut) = clip(&diff, MAX_DIFF);
    let recent = read::recent_subjects(repo, 10).unwrap_or_default().join("\n");
    let mut input = String::new();
    if !recent.is_empty() {
        input += &format!("Recent commit subjects:\n{recent}\n\n");
    }
    input += &format!("Staged diff:\n{diff}");
    if cut {
        input += "\n[diff cut here, too long]";
    }
    let msg = generate(COMMIT_PROMPT, &input)?;
    Ok(msg.trim().trim_matches('`').trim().to_string())
}

/// Plain-language explanation of one commit (message + diff).
pub fn explain_commit(repo: &Path, oid: &str) -> Result<String, AppError> {
    let (message, diff) = read::commit_patch(repo, oid)?;
    let (diff, cut) = clip(&diff, MAX_DIFF);
    let mut input = format!("Commit message:\n{message}\n\nDiff:\n{diff}");
    if cut {
        input += "\n[diff cut here, too long]";
    }
    Ok(generate(EXPLAIN_PROMPT, &input)?.trim().to_string())
}

/// PR title + description (`kind` "pr") or changelog (`kind` "changelog") for what `head` adds on top of `base`.
pub fn write_range(repo: &Path, base: &str, head: &str, kind: &str) -> Result<String, AppError> {
    let prompt = match kind {
        "pr" => PR_PROMPT,
        "changelog" => CHANGELOG_PROMPT,
        _ => return Err(AppError::new("bad_kind", format!("Unknown kind {kind}."))),
    };
    let (messages, diff) = read::range_patch(repo, base, head, 300)?;
    if messages.is_empty() {
        return Err(AppError::new("nothing_in_range", format!("{head} has no commits that aren't already in {base}.")));
    }
    let (diff, cut) = clip(&diff, MAX_DIFF);
    let mut input = format!("Commit messages, oldest first:\n{}\n\nCombined diff:\n{diff}", messages.join("\n---\n"));
    if cut {
        input += "\n[diff cut here, too long]";
    }
    Ok(generate(prompt, &input)?.trim().to_string())
}

fn generate(system: &str, input: &str) -> Result<String, AppError> {
    let key = key().ok_or_else(|| AppError::new("ai_no_key", "Add a Gemini API key in Settings to use AI features."))?;
    let url = format!("https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent");
    let body = json!({
        "systemInstruction": { "parts": [{ "text": system }] },
        "contents": [{ "role": "user", "parts": [{ "text": input }] }],
    });
    let res = ureq::post(&url).header("x-goog-api-key", &key).send_json(body);
    let v: Value = match res {
        Ok(mut r) => r.body_mut().read_json().map_err(net)?,
        Err(ureq::Error::StatusCode(400 | 401 | 403)) => {
            return Err(AppError::new("ai_key", "Gemini didn't accept the API key. Check it, or replace it."))
        }
        Err(ureq::Error::StatusCode(429)) => {
            return Err(AppError::new("ai_limit", "Gemini's rate limit or quota is used up. Try again in a minute."))
        }
        Err(e) => return Err(net(e)),
    };
    v["candidates"][0]["content"]["parts"][0]["text"]
        .as_str()
        .map(String::from)
        .ok_or_else(|| AppError::new("ai_empty", "Gemini returned no text. Try again."))
}

fn net(e: ureq::Error) -> AppError {
    AppError::new("network", format!("Couldn't reach Gemini. Check your internet connection. ({e})"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clip_keeps_char_boundary() {
        assert_eq!(clip("abc", 5), ("abc", false));
        assert_eq!(clip("aé", 2), ("a", true));
    }

    /// Calls Gemini for real. Run: `GEMINI_API_KEY=… cargo test live_commit_message -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_commit_message() {
        let dir = std::env::temp_dir().join(format!("git-ai-ai-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let git = |args: &[&str]| crate::git::cli::git(&dir, args).unwrap();
        git(&["init", "-q"]);
        git(&["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "Initial commit"]);
        std::fs::write(dir.join("greet.py"), "def greet(name):\n    return f\"Hello, {name}!\"\n").unwrap();
        git(&["add", "--", "greet.py"]);
        let msg = commit_message(&dir).unwrap();
        println!("---\n{msg}\n---");
        assert!(!msg.is_empty() && msg.lines().next().unwrap().len() <= 72);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
