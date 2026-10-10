//! AI features, bring your own key: Gemini, Claude, or any OpenAI-compatible server (OpenAI, OpenRouter,
//! Ollama, LM Studio). A provider's key comes from its env var (dev), else the OS keychain.
use crate::errors::AppError;
use crate::git::read;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;
use ts_rs::TS;

/// Which provider and model AI features use. Saved in the settings store; keys stay in the keychain.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AiConfig {
    /// "gemini" (also when empty), "anthropic" or "openai" (any OpenAI-compatible server).
    pub provider: String,
    /// Empty = the provider's default model.
    pub model: String,
    /// "openai" only: server base URL, e.g. http://localhost:11434/v1. Empty = api.openai.com. A custom URL
    /// needs no key (local servers).
    pub base_url: String,
}

impl AiConfig {
    fn provider(&self) -> &str {
        match self.provider.as_str() {
            p @ ("anthropic" | "openai") => p,
            _ => "gemini",
        }
    }
    fn name(&self) -> &'static str {
        match self.provider() {
            "anthropic" => "Claude",
            "openai" if !self.base_url.trim().is_empty() => "the AI server",
            "openai" => "OpenAI",
            _ => "Gemini",
        }
    }
    fn model(&self) -> &str {
        match (self.model.trim(), self.provider()) {
            ("", "anthropic") => "claude-opus-5-5",
            ("", "openai") => "gpt-5-mini",
            ("", _) => "gemini-3.5-flash-lite",
            (m, _) => m,
        }
    }
    fn keyless(&self) -> bool {
        self.provider() == "openai" && !self.base_url.trim().is_empty()
    }
}
/// Diff text sent at most (bytes); the rest is cut with a note.
const MAX_DIFF: usize = 100_000;

const COMMIT_PROMPT: &str = "You write git commit messages. From the diff, write one message: \
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

const STASH_PROMPT: &str = "You explain a git stash (set-aside uncommitted work) to the developer who made it \
and forgot what it was. From the stash message and its changes, say in plain words what the work in progress \
does and how far along it looks. Start with one sentence summary, then at most 5 short \"- \" bullets. Plain \
text only: no Markdown headings, no bold, no code fences.";

const BRANCH_PROMPT: &str = "You explain a branch to a developer who hasn't read it. From the commit messages \
and the combined diff of what the branch adds on top of its base, say in plain words what the branch does and, \
if the code shows it, why. Start with a one or two sentence summary, then at most 7 short \"- \" bullets for the \
notable changes. Mention risky or surprising changes and anything unfinished. Plain text only: no Markdown \
headings, no bold, no code fences.";

const CHANGELOG_PROMPT: &str = "You write release changelogs for users of the software. From the commit messages \
and the combined diff of a release, write Markdown \"- \" bullets grouped under \"### Added\", \"### Changed\", \
\"### Fixed\" and \"### Removed\" (leave out empty groups). One line per user-visible change, in plain words; \
merge related commits, skip pure refactors, tests and CI unless they matter to users. No title, no code fences.";

const CONFLICT_PROMPT: &str = "You resolve git merge conflicts. The file below contains conflict blocks \
between <<<<<<< and >>>>>>> markers (a ||||||| section, if present, is the common base). For each block, combine \
both sides so the intent of each change is kept; if they truly contradict, prefer the side that looks newer and \
more complete. Leave everything outside the blocks exactly as it is. Reply with the whole resolved file only: no \
conflict markers, no explanation, no code fences.";

/// Keychain entry `git-ai`/<provider>.
fn keychain(provider: &str) -> Result<keyring::Entry, AppError> {
    keyring::Entry::new("git-ai", provider).map_err(|e| AppError::new("keychain", e.to_string()))
}

fn key(provider: &str) -> Option<String> {
    let var = match provider {
        "anthropic" => "ANTHROPIC_API_KEY",
        "openai" => "OPENAI_API_KEY",
        _ => "GEMINI_API_KEY",
    };
    std::env::var(var).ok().or_else(|| keychain(provider).ok()?.get_password().ok()).filter(|k| !k.trim().is_empty())
}

/// AI features can run: a key is set, or none is needed.
pub fn ready(cfg: &AiConfig) -> bool {
    cfg.keyless() || key(cfg.provider()).is_some()
}

/// Stores `provider`'s key in the keychain; None (or blank) removes it.
pub fn set_key(provider: &str, key: Option<String>) -> Result<(), AppError> {
    let cfg = AiConfig { provider: provider.into(), ..Default::default() };
    let entry = keychain(cfg.provider())?;
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

pub fn commit_message(cfg: &AiConfig, repo: &Path) -> Result<String, AppError> {
    // Nothing staged: describe every change, staged or not.
    let mut diff = read::staged_patch(repo)?;
    if diff.trim().is_empty() {
        diff = read::work_patch(repo)?;
    }
    if diff.trim().is_empty() {
        return Err(AppError::new("nothing_staged", "No changes to describe."));
    }
    let (diff, cut) = clip(&diff, MAX_DIFF);
    let recent = read::recent_subjects(repo, 10).unwrap_or_default().join("\n");
    let mut input = String::new();
    if !recent.is_empty() {
        input += &format!("Recent commit subjects:\n{recent}\n\n");
    }
    input += &format!("Diff:\n{diff}");
    if cut {
        input += "\n[diff cut here, too long]";
    }
    let msg = generate(cfg, COMMIT_PROMPT, &input)?;
    Ok(msg.trim().trim_matches('`').trim().to_string())
}

/// Plain-language explanation of one commit (message + diff).
pub fn explain_commit(cfg: &AiConfig, repo: &Path, oid: &str) -> Result<String, AppError> {
    let (message, diff) = read::commit_patch(repo, oid)?;
    let (diff, cut) = clip(&diff, MAX_DIFF);
    let mut input = format!("Commit message:\n{message}\n\nDiff:\n{diff}");
    if cut {
        input += "\n[diff cut here, too long]";
    }
    Ok(generate(cfg, EXPLAIN_PROMPT, &input)?.trim().to_string())
}

/// Plain-language explanation of a stash (tracked changes + untracked files).
pub fn explain_stash(cfg: &AiConfig, repo: &Path, oid: &str) -> Result<String, AppError> {
    let (message, diff) = read::stash_patch(repo, oid)?;
    let (diff, cut) = clip(&diff, MAX_DIFF);
    let mut input = format!("Stash message:
{message}

Stashed changes:
{diff}");
    if cut {
        input += "
[diff cut here, too long]";
    }
    Ok(generate(cfg, STASH_PROMPT, &input)?.trim().to_string())
}

/// PR title + description (`kind` "pr"), changelog ("changelog") or plain explanation ("explain") for what `head` adds on top of `base`.
pub fn write_range(cfg: &AiConfig, repo: &Path, base: &str, head: &str, kind: &str) -> Result<String, AppError> {
    let prompt = match kind {
        "pr" => PR_PROMPT,
        "changelog" => CHANGELOG_PROMPT,
        "explain" => BRANCH_PROMPT,
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
    Ok(generate(cfg, prompt, &input)?.trim().to_string())
}

/// A proposed resolution of the conflicted `file` (the whole file, markers gone). Nothing is written.
pub fn resolve_conflict(cfg: &AiConfig, repo: &Path, file: &str) -> Result<String, AppError> {
    let text = read::work_file(repo, file)?
        .ok_or_else(|| AppError::new("too_big", "Binary files and files over 1 MB can't be resolved with AI."))?;
    if !has_markers(&text) {
        return Err(AppError::new("no_markers", format!("{file} has no conflict markers to resolve.")));
    }
    if text.len() > MAX_DIFF {
        return Err(AppError::new("too_big", format!("{file} is too long to send whole; resolve it in an editor.")));
    }
    let out = generate(cfg, CONFLICT_PROMPT, &format!("File: {file}\n\n{text}"))?;
    let out = strip_fence(&out);
    if has_markers(&out) {
        return Err(AppError::new("ai_error", format!("{} left conflict markers in. Try again or resolve by hand.", cfg.name())));
    }
    Ok(match_eol(&text, &out))
}

/// `out` with `text`'s line endings (CRLF or LF) and trailing-newline convention.
fn match_eol(text: &str, out: &str) -> String {
    let mut out = out.replace("\r\n", "\n").trim_end_matches('\n').to_string();
    if text.ends_with('\n') {
        out.push('\n');
    }
    if text.contains("\r\n") { out.replace('\n', "\r\n") } else { out }
}

fn has_markers(s: &str) -> bool {
    s.lines().any(|l| (l.starts_with("<<<<<<<") || l.starts_with(">>>>>>>")) && matches!(l.as_bytes().get(7), None | Some(b' ')))
}

/// Drops a ```lang ... ``` wrapper the model may add despite the prompt.
fn strip_fence(s: &str) -> &str {
    let t = s.trim();
    match (t.strip_prefix("```"), t.ends_with("```")) {
        (Some(rest), true) if t.len() >= 6 => rest.split_once('\n').map_or("", |(_, body)| body).trim_end().strip_suffix("```").unwrap_or(""),
        _ => s,
    }
}

fn generate(cfg: &AiConfig, system: &str, input: &str) -> Result<String, AppError> {
    let name = cfg.name();
    let key = key(cfg.provider());
    if key.is_none() && !cfg.keyless() {
        return Err(AppError::new("ai_no_key", format!("Add your {name} API key in Settings to use AI features.")));
    }
    let key = key.unwrap_or_default();
    let model = cfg.model();
    let (url, body) = match cfg.provider() {
        "anthropic" => {
            let mut body = json!({
                "model": model,
                "max_tokens": 16000,
                "system": system,
                "messages": [{ "role": "user", "content": input }],
            });
            if has_fallbacks(model) {
                body["fallbacks"] = json!("default");
            }
            ("https://api.anthropic.com/v1/messages".to_string(), body)
        }
        "openai" => {
            let base = cfg.base_url.trim().trim_end_matches('/');
            let base = if base.is_empty() { "https://api.openai.com/v1" } else { base };
            let body = json!({
                "model": model,
                "messages": [{ "role": "system", "content": system }, { "role": "user", "content": input }],
            });
            (format!("{base}/chat/completions"), body)
        }
        _ => {
            let body = json!({
                "systemInstruction": { "parts": [{ "text": system }] },
                "contents": [{ "role": "user", "parts": [{ "text": input }] }],
            });
            (format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"), body)
        }
    };
    let mut req = ureq::post(&url).config().http_status_as_error(false).build();
    req = match cfg.provider() {
        "anthropic" => {
            req = req.header("x-api-key", &key).header("anthropic-version", "2023-06-01");
            if has_fallbacks(model) { req.header("anthropic-beta", "server-side-fallback-2026-07-01") } else { req }
        }
        "openai" if key.is_empty() => req,
        "openai" => req.header("Authorization", &format!("Bearer {key}")),
        _ => req.header("x-goog-api-key", &key),
    };
    let mut res = req.send_json(body).map_err(|e| net(name, e))?;
    let status = res.status().as_u16();
    let v: Value = res.body_mut().read_json().unwrap_or_default();
    if status != 200 {
        return Err(api_error(name, status, &v));
    }
    if v["stop_reason"] == "refusal" {
        return Err(AppError::new("ai_error", format!("{name} declined this request.")));
    }
    let text: Option<String> = match cfg.provider() {
        // Claude may put thinking or fallback blocks before the text.
        "anthropic" => v["content"].as_array().map(|c| c.iter().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect()),
        "openai" => v["choices"][0]["message"]["content"].as_str().map(String::from),
        _ => v["candidates"][0]["content"]["parts"][0]["text"].as_str().map(String::from),
    };
    text.filter(|t| !t.trim().is_empty())
        .ok_or_else(|| AppError::new("ai_empty", format!("{name} returned no text. Try again.")))
}

/// Claude models that take server-side refusal fallbacks (`fallbacks: "default"`); others reject the field.
fn has_fallbacks(model: &str) -> bool {
    matches!(model, "claude-fable-5-1" | "claude-opus-5-5" | "claude-opus-5" | "claude-sonnet-5-5")
}

/// Only a rejected key is `ai_key` (the UI opens Settings for it). Other 400s (model gone, bad request)
/// show the provider's own message, so a saved, working key isn't blamed.
fn api_error(name: &str, status: u16, v: &Value) -> AppError {
    let reason_is = |r: &str| v["error"]["details"].as_array().is_some_and(|d| d.iter().any(|x| x["reason"] == r));
    if status == 401 || reason_is("API_KEY_INVALID") {
        return AppError::new("ai_key", format!("{name} didn't accept the API key. Check it, or replace it."));
    }
    if status == 429 {
        return AppError::new("ai_limit", format!("{name}'s rate limit or quota is used up. Try again in a minute."));
    }
    // OpenAI-compatible local servers (Ollama) may send `{"error": "..."}`.
    let msg = v["error"]["message"].as_str().or(v["error"].as_str()).unwrap_or("no details");
    AppError::new("ai_error", format!("{name} returned an error ({status}): {msg}"))
}

fn net(name: &str, e: ureq::Error) -> AppError {
    AppError::new("network", format!("Couldn't reach {name}. Check your internet connection or the server URL. ({e})"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clip_keeps_char_boundary() {
        assert_eq!(clip("abc", 5), ("abc", false));
        assert_eq!(clip("aé", 2), ("a", true));
    }

    #[test]
    fn conflict_output_checks() {
        assert!(has_markers("a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> x\n"));
        assert!(!has_markers("a\n<<<<<<<<< not one\n"));
        assert_eq!(strip_fence("```rust\nfn a() {}\n```"), "fn a() {}\n");
        assert_eq!(strip_fence("plain\n"), "plain\n");
        assert_eq!(match_eol("a\r\nb\r\n", "x\ny"), "x\r\ny\r\n");
        assert_eq!(match_eol("a\nb", "x\r\ny\n\n"), "x\ny");
    }

    #[test]
    fn only_a_bad_key_blames_the_key() {
        let bad_key = json!({"error": {"message": "API key not valid.", "details": [{"reason": "API_KEY_INVALID"}]}});
        assert_eq!(api_error("Gemini", 400, &bad_key).code, "ai_key");
        let bad_model = json!({"error": {"message": "models/x is not found"}});
        let e = api_error("Gemini", 404, &bad_model);
        assert_eq!(e.code, "ai_error");
        assert!(e.message.contains("is not found"));
        assert_eq!(api_error("Gemini", 400, &json!({})).code, "ai_error");
        assert_eq!(api_error("Gemini", 429, &json!({})).code, "ai_limit");
        assert!(api_error("the AI server", 404, &json!({"error": "model not found"})).message.contains("model not found"));
    }

    /// Real merge conflict through Gemini, then apply it. Run: `cargo test live_resolve_conflict -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_resolve_conflict() {
        let dir = std::env::temp_dir().join(format!("git-ai-conflict-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let git = |args: &[&str]| crate::git::cli::git(&dir, args);
        let commit = |msg: &str| git(&["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-qam", msg]).unwrap();
        let write = |s: &str| std::fs::write(dir.join("app.js"), s).unwrap();
        git(&["init", "-q", "-b", "main"]).unwrap();
        write("function greet(name) {\n  return \"Hello, \" + name;\n}\n\nfunction add(a, b) {\n  return a + b;\n}\n");
        git(&["add", "--", "app.js"]).unwrap();
        commit("Initial");
        git(&["switch", "-qc", "feature"]).unwrap();
        write("function greet(name) {\n  return `Hello, ${name}!`;\n}\n\nfunction add(a, b) {\n  return Number(a) + Number(b);\n}\n");
        commit("Template greeting, numeric add");
        git(&["switch", "-q", "main"]).unwrap();
        write("function greet(name) {\n  return \"Hi, \" + name.trim();\n}\n\nfunction add(a, b) {\n  return (a + b) | 0;\n}\n");
        commit("Trim name, integer add");
        assert!(git(&["merge", "feature"]).is_err(), "merge should conflict");

        let out = resolve_conflict(&AiConfig::default(), &dir, "app.js").unwrap();
        println!("---\n{out}---");
        assert!(!has_markers(&out) && out.ends_with('\n') && out.contains("function add"));
        crate::git::cli::write_resolved(&dir, "app.js", &out).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("app.js")).unwrap(), out);
        let status = git(&["status", "--porcelain"]).unwrap();
        assert!(status.contains("M  app.js"), "staged, no longer conflicted: {status}");
        let backups = git(&["for-each-ref", "refs/git-ai/backup/"]).unwrap();
        assert!(!backups.trim().is_empty(), "backup ref made");
        let entry = crate::oplog::entries(&dir, 20).unwrap().remove(0);
        crate::oplog::undo(&dir, &entry.id).unwrap(); // markers and the conflict are back
        assert!(has_markers(&std::fs::read_to_string(dir.join("app.js")).unwrap()));
        assert_eq!(crate::git::cli::status(&dir).unwrap().conflicted[0].kind, "UU");
        let _ = std::fs::remove_dir_all(&dir);
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
        let msg = commit_message(&AiConfig::default(), &dir).unwrap();
        println!("---\n{msg}\n---");
        assert!(!msg.is_empty() && msg.lines().next().unwrap().len() <= 72);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
