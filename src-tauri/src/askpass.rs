//! Credential prompts for network git. Git runs this same exe as GIT_ASKPASS / SSH_ASKPASS with the
//! prompt as argv[1]; `GITAI_ASKPASS` ("<port> <token>") tells `main` to run `client()` instead of the
//! app. The client forwards the prompt over localhost to the running app, which emits "askpass" to the
//! UI and waits for `reply`. The answer is printed for git; exit 1 = cancelled.
use serde::Serialize;
use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use ts_rs::TS;

/// Payload of the "askpass" event; answer it with the `askpass_reply` command.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct AskpassPrompt {
    pub id: u32,
    /// git's or ssh's prompt, e.g. "Password for 'https://x@github.com': ".
    pub prompt: String,
}

/// "<port> <token>", set once the listener runs.
static ENV: OnceLock<String> = OnceLock::new();
static PENDING: Mutex<Vec<(u32, Sender<Option<String>>)>> = Mutex::new(Vec::new());

/// Listens on a random localhost port for the lifetime of the app.
pub fn start(app: AppHandle) -> io::Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let token = token();
    let _ = ENV.set(format!("{} {token}", listener.local_addr()?.port()));
    thread::spawn(move || {
        for conn in listener.incoming().flatten() {
            let (app, token) = (app.clone(), token.clone());
            thread::spawn(move || serve(conn, &token, |prompt| ask(&app, prompt)));
        }
    });
    Ok(())
}

/// Env for network git commands. Empty until `start` ran (tests), so git fails instead of prompting.
pub fn env() -> Vec<(&'static str, OsString)> {
    let (Some(v), Ok(exe)) = (ENV.get(), std::env::current_exe()) else { return vec![] };
    vec![
        ("GIT_ASKPASS", exe.clone().into()),
        ("SSH_ASKPASS", exe.into()),
        ("SSH_ASKPASS_REQUIRE", "force".into()),
        ("GITAI_ASKPASS", v.into()),
    ]
}

/// Delivers the UI's answer; None cancels.
pub fn reply(id: u32, answer: Option<String>) {
    if let Some((_, tx)) = PENDING.lock().unwrap().iter().find(|(i, _)| *i == id) {
        let _ = tx.send(answer);
    }
}

fn ask(app: &AppHandle, prompt: String) -> Option<String> {
    static NEXT: AtomicU32 = AtomicU32::new(0);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = mpsc::channel();
    PENDING.lock().unwrap().push((id, tx));
    let answer = match app.emit("askpass", AskpassPrompt { id, prompt }) {
        // Gives up after 5 min so a forgotten prompt doesn't hang git forever.
        Ok(()) => rx.recv_timeout(Duration::from_secs(300)).ok().flatten(),
        Err(_) => None,
    };
    PENDING.lock().unwrap().retain(|(i, _)| *i != id);
    answer
}

/// The askpass process: prints the answer for git. Returns the exit code.
pub fn client() -> i32 {
    let prompt = std::env::args().nth(1).unwrap_or_default();
    match std::env::var("GITAI_ASKPASS").ok().and_then(|env| request(&env, &prompt)) {
        Some(answer) => {
            println!("{answer}");
            0
        }
        None => 1,
    }
}

/// Request: "<token>\n<prompt>", then EOF. Reply: "1<answer>", or "0" for cancel / wrong token.
fn request(env: &str, prompt: &str) -> Option<String> {
    let (port, token) = env.split_once(' ')?;
    let mut s = TcpStream::connect(("127.0.0.1", port.parse::<u16>().ok()?)).ok()?;
    write!(s, "{token}\n{prompt}").ok()?;
    s.shutdown(Shutdown::Write).ok()?;
    let mut out = String::new();
    s.read_to_string(&mut out).ok()?;
    out.strip_prefix('1').map(String::from)
}

fn serve(mut s: TcpStream, token: &str, ask: impl FnOnce(String) -> Option<String>) -> io::Result<()> {
    s.set_read_timeout(Some(Duration::from_secs(10)))?;
    let mut req = String::new();
    (&mut s).take(64 * 1024).read_to_string(&mut req)?;
    let answer = match req.split_once('\n') {
        Some((t, prompt)) if t == token => ask(prompt.to_string()),
        _ => None,
    };
    s.write_all(answer.map_or("0".into(), |a| format!("1{a}")).as_bytes())
}

/// 128 bits from std's randomly keyed SipHash, so other local processes can't post prompts.
fn token() -> String {
    use std::hash::{BuildHasher, Hasher};
    let h = || std::collections::hash_map::RandomState::new().build_hasher().finish();
    format!("{:016x}{:016x}", h(), h())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            for _ in 0..3 {
                let (s, _) = l.accept().unwrap();
                serve(s, "tok", |p| (p != "cancel").then(|| format!("hi {p}"))).unwrap();
            }
        });
        assert_eq!(request(&format!("{port} tok"), "Password: ").as_deref(), Some("hi Password: "));
        assert_eq!(request(&format!("{port} bad"), "Password: "), None);
        assert_eq!(request(&format!("{port} tok"), "cancel"), None);
        server.join().unwrap();
        assert_ne!(token(), token());
    }
}
