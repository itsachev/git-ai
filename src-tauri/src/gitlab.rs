//! GitLab (gitlab.com) sign-in through the OAuth device flow, mirroring `github.rs`. GitLab access
//! tokens last 2 hours, so the keychain holds the refresh token too and `token()` renews on demand.
// ponytail: gitlab.com only; self-managed instances need a host setting and their own OAuth app.
use crate::errors::AppError;
use crate::github::{DeviceCode, GhRepo};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const HOST: &str = "https://gitlab.com";
/// `api`: user, project list and merge requests. `write_repository`: clone/push over HTTPS.
const SCOPE: &str = "api write_repository";

/// The "git-ai" gitlab.com OAuth app (not confidential, device grant on). Client ids are public, not secrets.
const DEFAULT_CLIENT_ID: &str = "a52a0538edda1b08b01c64c25826bb7078186980d1994fbac20ff9ed9cddc116";

/// Runtime env first, then the one baked in at build, then the default app.
fn client_id() -> Result<String, AppError> {
    Ok(std::env::var("GITAI_GITLAB_CLIENT_ID")
        .ok()
        .or(option_env!("GITAI_GITLAB_CLIENT_ID").map(String::from))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_CLIENT_ID.into()))
}

fn net(e: ureq::Error) -> AppError {
    AppError::new("network", format!("Couldn't reach GitLab. Check your internet connection. ({e})"))
}

fn keychain() -> Result<keyring::Entry, AppError> {
    keyring::Entry::new("git-ai", "gitlab").map_err(|e| AppError::new("keychain", e.to_string()))
}

/// OAuth endpoints answer errors with 400 + a JSON body, so read the body whatever the status.
fn post_form(path: &str, form: &[(&str, &str)]) -> Result<Value, AppError> {
    let mut res = ureq::post(&format!("{HOST}{path}"))
        .config()
        .http_status_as_error(false)
        .build()
        .header("Accept", "application/json")
        .send_form(form.iter().copied())
        .map_err(net)?;
    res.body_mut().read_json().map_err(net)
}

fn gitlab_error(v: &Value) -> AppError {
    let msg = v["error_description"].as_str().or(v["error"].as_str()).unwrap_or("unexpected response");
    AppError::new("gitlab", format!("GitLab sign-in failed: {msg}"))
}

pub fn start() -> Result<DeviceCode, AppError> {
    let v = post_form("/oauth/authorize_device", &[("client_id", &client_id()?), ("scope", SCOPE)])?;
    let s = |k: &str| v[k].as_str().map(String::from);
    let n = |k: &str, d| v[k].as_u64().map_or(d, |x| x as u32);
    match (s("device_code"), s("user_code"), s("verification_uri")) {
        (Some(device_code), Some(user_code), Some(verification_uri)) => Ok(DeviceCode {
            device_code,
            user_code,
            verification_uri,
            interval: n("interval", 5),
            expires_in: n("expires_in", 300),
        }),
        _ => Err(gitlab_error(&v)),
    }
}

/// Polls until the user approves in the browser, stores the tokens and returns the username.
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
            "/oauth/token",
            &[("client_id", &id), ("device_code", &code.device_code), ("grant_type", "urn:ietf:params:oauth:grant-type:device_code")],
        )?;
        if v["access_token"].is_string() {
            save(&v)?;
            return user()?.ok_or_else(|| AppError::new("auth", "GitLab didn't accept the new token."));
        }
        match v["error"].as_str() {
            Some("authorization_pending") => {}
            Some("slow_down") => interval += 5,
            Some("access_denied") => return Err(AppError::new("denied", "Sign-in was cancelled on GitLab.")),
            Some("expired_token") => return Err(AppError::new("expired", "The sign-in code expired. Start again.")),
            _ => return Err(gitlab_error(&v)),
        }
    }
}

#[derive(Serialize, Deserialize)]
struct Tokens {
    access: String,
    refresh: String,
    /// Unix seconds.
    expires_at: u64,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// Stores a /oauth/token response.
fn save(v: &Value) -> Result<Tokens, AppError> {
    let t = Tokens {
        access: v["access_token"].as_str().unwrap_or_default().into(),
        refresh: v["refresh_token"].as_str().unwrap_or_default().into(),
        expires_at: now() + v["expires_in"].as_u64().unwrap_or(7200),
    };
    let json = serde_json::to_string(&t).map_err(|e| AppError::new("keychain", e.to_string()))?;
    keychain()?.set_password(&json).map_err(|e| AppError::new("keychain", e.to_string()))?;
    Ok(t)
}

/// A live access token, refreshed when it is within a minute of expiring. None when signed out or the
/// refresh is refused (then the stored tokens are forgotten).
fn token() -> Option<String> {
    // GitLab rotates the refresh token on use: two parallel refreshes would sign the user out.
    static LOCK: Mutex<()> = Mutex::new(());
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let t: Tokens = serde_json::from_str(&keychain().ok()?.get_password().ok()?).ok()?;
    if t.expires_at > now() + 60 {
        return Some(t.access);
    }
    let v = post_form("/oauth/token", &[("client_id", &client_id().ok()?), ("refresh_token", &t.refresh), ("grant_type", "refresh_token")]).ok()?;
    if v["access_token"].is_string() {
        return save(&v).ok().map(|t| t.access);
    }
    if v["error"].is_string() {
        let _ = sign_out();
    }
    None
}

fn api(path: &str, token: &str) -> Result<Value, ureq::Error> {
    ureq::get(&format!("{HOST}/api/v4{path}"))
        .header("Authorization", format!("Bearer {token}"))
        .header("User-Agent", "git-ai")
        .call()?
        .body_mut()
        .read_json()
}

/// The signed-in username; None when signed out. A token GitLab rejects (revoked) is forgotten.
pub fn user() -> Result<Option<String>, AppError> {
    let Some(token) = token() else { return Ok(None) };
    match api("/user", &token) {
        Ok(v) => Ok(v["username"].as_str().map(String::from)),
        Err(ureq::Error::StatusCode(401)) => {
            sign_out()?;
            Ok(None)
        }
        Err(e) => Err(net(e)),
    }
}

/// Projects the user is a member of, most recently active first. Empty when signed out.
pub fn repos() -> Result<Vec<GhRepo>, AppError> {
    let Some(token) = token() else { return Ok(vec![]) };
    let mut out = Vec::new();
    // ponytail: stops at 1000 projects, like the GitHub list.
    for page in 1..=10 {
        let v = api(&format!("/projects?membership=true&order_by=last_activity_at&per_page=100&page={page}"), &token).map_err(net)?;
        let batch = v.as_array().cloned().unwrap_or_default();
        let n = batch.len();
        out.extend(batch.into_iter().filter_map(|r| {
            Some(GhRepo {
                full_name: r["path_with_namespace"].as_str()?.into(),
                clone_url: r["http_url_to_repo"].as_str()?.into(),
                private: r["visibility"].as_str() != Some("public"),
                description: r["description"].as_str().filter(|s| !s.is_empty()).map(String::from),
            })
        }));
        if n < 100 {
            break;
        }
    }
    Ok(out)
}

/// "group/name" of a gitlab.com remote URL, if it is one.
pub fn remote_slug(remote_url: &str) -> Option<String> {
    crate::github::remote_path(remote_url, "gitlab.com")
}

/// Opens a merge request of `head` into `base` on the gitlab.com project behind `remote_url`; returns its web URL.
pub fn create_mr(remote_url: &str, head: &str, base: &str, title: &str, body: &str) -> Result<String, AppError> {
    let slug = remote_slug(remote_url).ok_or_else(|| AppError::new("not_hosted", format!("The remote ({remote_url}) isn't a gitlab.com project.")))?;
    let token = token().ok_or_else(|| AppError::new("signed_out", "Sign in to GitLab first."))?;
    let mut res = ureq::post(&format!("{HOST}/api/v4/projects/{}/merge_requests", slug.replace('/', "%2F")))
        .config()
        .http_status_as_error(false)
        .build()
        .header("Authorization", format!("Bearer {token}"))
        .header("User-Agent", "git-ai")
        .send_json(serde_json::json!({ "source_branch": head, "target_branch": base, "title": title, "description": body }))
        .map_err(net)?;
    let status = res.status().as_u16();
    let v: Value = res.body_mut().read_json().unwrap_or_default();
    if let Some(url) = v["web_url"].as_str().filter(|_| status == 201) {
        return Ok(url.into());
    }
    // "message" is a string or a list ("Another open merge request already exists for this source branch: !5").
    let msg = v["message"].as_str().or(v["message"][0].as_str()).or(v["error_description"].as_str()).unwrap_or("unexpected response");
    Err(match status {
        401 => AppError::new("signed_out", "GitLab no longer accepts your sign-in. Sign in again."),
        403 if v["error"] == "insufficient_scope" => {
            AppError::new("signed_out", "Your GitLab sign-in predates merge requests. Sign out of GitLab and sign in again.")
        }
        403 | 404 => AppError::new("gitlab", format!("GitLab refused: {msg}. Check that your account can push to {slug}.")),
        _ => AppError::new("gitlab", format!("GitLab refused the merge request: {msg}")),
    })
}

pub fn sign_out() -> Result<(), AppError> {
    match keychain()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::new("keychain", e.to_string())),
    }
}

/// Answers git's "Username/Password for 'https://gitlab.com'" prompts with the token, if signed in.
pub fn askpass_answer(prompt: &str) -> Option<String> {
    let is_user = crate::github::https_prompt(prompt, "gitlab.com")?;
    let token = token()?;
    // GitLab takes an OAuth token as the password with the username "oauth2".
    Some(if is_user { "oauth2".into() } else { token })
}
