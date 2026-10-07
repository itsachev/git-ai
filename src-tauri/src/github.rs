//! GitHub sign-in through the OAuth device flow. The token lives only in the OS keychain; askpass
//! hands it to git when git asks for github.com HTTPS credentials (unless GCM answers first).
use crate::errors::AppError;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::thread;
use std::time::{Duration, Instant};
use ts_rs::TS;

/// `repo`: push to and (later) open PRs on private repos.
const SCOPE: &str = "repo";

/// Shown in the browser: the user types `user_code` at `verification_uri`.
#[derive(Debug, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    /// Seconds between polls.
    pub interval: u32,
    /// Seconds until the code expires.
    pub expires_in: u32,
}

/// The OAuth app's client id (public, not a secret): runtime env first, then the one baked in at build.
fn client_id() -> Result<String, AppError> {
    std::env::var("GITAI_GITHUB_CLIENT_ID")
        .ok()
        .or(option_env!("GITAI_GITHUB_CLIENT_ID").map(String::from))
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            AppError::new("github_not_configured", "GitHub sign-in isn't set up in this build (GITAI_GITHUB_CLIENT_ID is missing).")
        })
}

fn net(e: ureq::Error) -> AppError {
    AppError::new("network", format!("Couldn't reach GitHub. Check your internet connection. ({e})"))
}

fn keychain() -> Result<keyring::Entry, AppError> {
    keyring::Entry::new("git-ai", "github").map_err(|e| AppError::new("keychain", e.to_string()))
}

fn post_form(url: &str, form: &[(&str, &str)]) -> Result<Value, AppError> {
    let mut res = ureq::post(url).header("Accept", "application/json").send_form(form.iter().copied()).map_err(net)?;
    res.body_mut().read_json().map_err(net)
}

pub fn start() -> Result<DeviceCode, AppError> {
    let v = post_form("https://github.com/login/device/code", &[("client_id", &client_id()?), ("scope", SCOPE)])?;
    let s = |k: &str| v[k].as_str().map(String::from);
    let n = |k: &str, d| v[k].as_u64().map_or(d, |x| x as u32);
    match (s("device_code"), s("user_code"), s("verification_uri")) {
        (Some(device_code), Some(user_code), Some(verification_uri)) => Ok(DeviceCode {
            device_code,
            user_code,
            verification_uri,
            interval: n("interval", 5),
            expires_in: n("expires_in", 900),
        }),
        _ => Err(github_error(&v)),
    }
}

/// Polls until the user approves in the browser, stores the token and returns the login.
pub fn finish(code: &DeviceCode) -> Result<String, AppError> {
    let id = client_id()?;
    let deadline = Instant::now() + Duration::from_secs(code.expires_in.into());
    let mut interval = u64::from(code.interval.max(1));
    loop {
        thread::sleep(Duration::from_secs(interval));
        if Instant::now() > deadline {
            return Err(AppError::new("expired", "The sign-in code expired. Start again."));
        }
        let v = post_form(
            "https://github.com/login/oauth/access_token",
            &[("client_id", &id), ("device_code", &code.device_code), ("grant_type", "urn:ietf:params:oauth:grant-type:device_code")],
        )?;
        if let Some(token) = v["access_token"].as_str() {
            keychain()?.set_password(token).map_err(|e| AppError::new("keychain", e.to_string()))?;
            return user()?.ok_or_else(|| AppError::new("auth", "GitHub didn't accept the new token."));
        }
        match v["error"].as_str() {
            Some("authorization_pending") => {}
            Some("slow_down") => interval += 5,
            Some("access_denied") => return Err(AppError::new("denied", "Sign-in was cancelled on GitHub.")),
            Some("expired_token") => return Err(AppError::new("expired", "The sign-in code expired. Start again.")),
            _ => return Err(github_error(&v)),
        }
    }
}

fn github_error(v: &Value) -> AppError {
    let msg = v["error_description"].as_str().or(v["error"].as_str()).unwrap_or("unexpected response");
    AppError::new("github", format!("GitHub sign-in failed: {msg}"))
}

fn token() -> Option<String> {
    keychain().ok()?.get_password().ok()
}

/// The signed-in login; None when signed out. A token GitHub rejects (revoked) is forgotten.
pub fn user() -> Result<Option<String>, AppError> {
    let Some(token) = token() else { return Ok(None) };
    let res = ureq::get("https://api.github.com/user")
        .header("Authorization", format!("Bearer {token}"))
        .header("User-Agent", "git-ai")
        .header("Accept", "application/vnd.github+json")
        .call();
    match res {
        Ok(mut r) => Ok(r.body_mut().read_json::<Value>().map_err(net)?["login"].as_str().map(String::from)),
        Err(ureq::Error::StatusCode(401)) => {
            sign_out()?;
            Ok(None)
        }
        Err(e) => Err(net(e)),
    }
}

/// A repo the signed-in user can clone.
#[derive(Debug, Serialize, TS)]
#[ts(export)]
pub struct GhRepo {
    /// "owner/name".
    pub full_name: String,
    /// HTTPS URL; askpass answers it with the token.
    pub clone_url: String,
    pub private: bool,
    pub description: Option<String>,
}

/// Repos the user owns, collaborates on or reaches through an org, most recently pushed first.
/// Empty when signed out.
pub fn repos() -> Result<Vec<GhRepo>, AppError> {
    let Some(token) = token() else { return Ok(vec![]) };
    let mut out = Vec::new();
    // ponytail: stops at 1000 repos; follow the Link header past that if someone needs it.
    for page in 1..=10 {
        let url = format!("https://api.github.com/user/repos?per_page=100&sort=pushed&page={page}");
        let batch: Vec<Value> = ureq::get(&url)
            .header("Authorization", format!("Bearer {token}"))
            .header("User-Agent", "git-ai")
            .header("Accept", "application/vnd.github+json")
            .call()
            .map_err(net)?
            .body_mut()
            .read_json()
            .map_err(net)?;
        let n = batch.len();
        out.extend(batch.into_iter().filter_map(|r| {
            Some(GhRepo {
                full_name: r["full_name"].as_str()?.into(),
                clone_url: r["clone_url"].as_str()?.into(),
                private: r["private"].as_bool().unwrap_or(false),
                description: r["description"].as_str().map(String::from),
            })
        }));
        if n < 100 {
            break;
        }
    }
    Ok(out)
}

pub fn sign_out() -> Result<(), AppError> {
    match keychain()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::new("keychain", e.to_string())),
    }
}

/// Answers git's "Username/Password for 'https://github.com'" prompts with the token, if signed in.
pub fn askpass_answer(prompt: &str) -> Option<String> {
    let is_user = github_prompt(prompt)?;
    let token = token()?;
    // GitHub ignores the username when the password is a token.
    Some(if is_user { "x-access-token".into() } else { token })
}

/// Some(true) for a github.com username prompt, Some(false) for a password prompt, else None.
fn github_prompt(prompt: &str) -> Option<bool> {
    let is_user = prompt.starts_with("Username for '");
    if !is_user && !prompt.starts_with("Password for '") {
        return None;
    }
    let host = prompt.split('\'').nth(1)?.strip_prefix("https://")?.split('/').next()?;
    let host = host.rsplit_once('@').map_or(host, |(_, h)| h);
    host.eq_ignore_ascii_case("github.com").then_some(is_user)
}

#[cfg(test)]
mod tests {
    use super::github_prompt;

    #[test]
    fn prompts() {
        assert_eq!(github_prompt("Username for 'https://github.com': "), Some(true));
        assert_eq!(github_prompt("Password for 'https://x-access-token@github.com': "), Some(false));
        assert_eq!(github_prompt("Password for 'https://GitHub.com/team/repo.git': "), Some(false));
        assert_eq!(github_prompt("Password for 'https://github.com.evil.io': "), None);
        assert_eq!(github_prompt("Password for 'https://github.com@evil.io': "), None);
        assert_eq!(github_prompt("Password for 'http://github.com': "), None);
        assert_eq!(github_prompt("Enter passphrase for key '/home/u/.ssh/id_ed25519': "), None);
    }
}
