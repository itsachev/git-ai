//! Terminals: the built-in panel (a shell on a pseudo-terminal, drawn by xterm.js) or an installed terminal app.
use crate::errors::AppError;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::ipc::Channel;
use ts_rs::TS;

/// The choice that opens the panel inside the app instead of a terminal app.
pub const BUILT_IN: &str = "Built-in panel";

#[derive(Debug, Serialize, TS)]
#[ts(export)]
pub struct Terminals {
    /// `BUILT_IN` first, then the terminal apps installed here.
    pub found: Vec<String>,
    /// The one the Terminal button opens.
    pub chosen: String,
}

/// (name, executable, args); "{dir}" in an arg becomes the repo folder.
type App = (&'static str, PathBuf, &'static [&'static str]);

fn detect() -> Vec<App> {
    let mut out: Vec<App> = Vec::new();
    let mut add = |name, paths: &[PathBuf], args| {
        if let Some(p) = paths.iter().find(|p| p.exists()) {
            out.push((name, p.clone(), args));
        }
    };
    #[cfg(windows)]
    {
        let env = |k: &str| PathBuf::from(std::env::var_os(k).unwrap_or_default());
        let (local, pf, sys) = (env("LOCALAPPDATA"), env("ProgramFiles"), env("SystemRoot").join("System32"));
        add("Windows Terminal", &[local.join(r"Microsoft\WindowsApps\wt.exe")], &["-d", "{dir}"]);
        add("Git Bash", &[pf.join(r"Git\git-bash.exe"), local.join(r"Programs\Git\git-bash.exe")], &["--cd={dir}"]);
        add("PowerShell 7", &[pf.join(r"PowerShell\7\pwsh.exe")], &["-NoLogo"]);
        add("Windows PowerShell", &[sys.join(r"WindowsPowerShell\v1.0\powershell.exe")], &["-NoLogo"]);
        add("Command Prompt", &[sys.join("cmd.exe")], &[]);
    }
    #[cfg(target_os = "macos")]
    {
        // Launched with `open -a <app> <dir>`, which opens a window in that folder.
        let home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join("Applications");
        add("Terminal", &[PathBuf::from("/System/Applications/Utilities/Terminal.app")], &[]);
        for name in ["iTerm", "Warp", "Ghostty", "WezTerm"] {
            let app = format!("{name}.app");
            add(name, &[Path::new("/Applications").join(&app), home.join(&app)], &[]);
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let path = std::env::var_os("PATH").unwrap_or_default();
        for (name, bin, args) in [
            ("GNOME Terminal", "gnome-terminal", &["--working-directory={dir}"][..]),
            ("Ptyxis", "ptyxis", &["--new-window", "--working-directory={dir}"]),
            ("Konsole", "konsole", &["--workdir", "{dir}"]),
            ("Xfce Terminal", "xfce4-terminal", &["--working-directory={dir}"]),
            ("kitty", "kitty", &["--directory", "{dir}"]),
            ("Alacritty", "alacritty", &["--working-directory", "{dir}"]),
            ("WezTerm", "wezterm", &["start", "--cwd", "{dir}"]),
            ("xterm", "xterm", &[]),
        ] {
            add(name, &std::env::split_paths(&path).map(|d| d.join(bin)).collect::<Vec<_>>(), args);
        }
    }
    out
}

/// `chosen`: the stored pick; None or an app that's gone means the built-in panel.
pub fn list(chosen: Option<String>) -> Terminals {
    let apps: Vec<String> = detect().into_iter().map(|(n, ..)| n.to_string()).collect();
    let chosen = chosen.filter(|c| apps.contains(c)).unwrap_or_else(|| BUILT_IN.into());
    Terminals { found: std::iter::once(BUILT_IN.to_string()).chain(apps).collect(), chosen }
}

/// Opens the terminal app called `name` (from `list`) in `dir`. Only detected apps run, never a path from the UI.
pub fn open_app(name: &str, dir: &Path) -> Result<(), AppError> {
    if !dir.is_dir() {
        return Err(AppError::new("open", format!("'{}' is not a folder.", dir.display())));
    }
    let Some((_, exe, args)) = detect().into_iter().find(|(n, ..)| *n == name) else {
        return Err(AppError::new("open", format!("{name} isn't installed anymore. Pick another terminal in Settings.")));
    };
    let d = dir.to_string_lossy();
    let mut cmd = if cfg!(target_os = "macos") {
        let mut c = Command::new("open");
        c.arg("-a").arg(exe).arg(dir);
        c
    } else {
        Command::new(exe)
    };
    cmd.args(args.iter().map(|a| a.replace("{dir}", &d))).current_dir(dir);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Shells get their own console, shown in the default terminal app; GUI apps ignore the flag.
        const CREATE_NEW_CONSOLE: u32 = 0x10;
        cmd.creation_flags(CREATE_NEW_CONSOLE);
    }
    cmd.spawn().map(drop).map_err(|e| AppError::new("open", format!("Couldn't start {name}: {e}")))
}

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

static SESSIONS: Mutex<Option<HashMap<u32, Session>>> = Mutex::new(None);
static NEXT: AtomicU32 = AtomicU32::new(1);

fn with<T>(id: u32, f: impl FnOnce(&mut Session) -> std::io::Result<T>) -> Result<T, AppError> {
    let mut all = SESSIONS.lock().unwrap();
    let s = all.get_or_insert_with(HashMap::new).get_mut(&id).ok_or_else(|| AppError::new("pty", "The terminal has closed."))?;
    f(s).map_err(|e| AppError::new("pty", e.to_string()))
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { cols: cols.max(2), rows: rows.max(1), pixel_width: 0, pixel_height: 0 }
}

/// The user's shell: PowerShell 7 or Windows PowerShell on Windows, `$SHELL` (login) elsewhere.
fn shell() -> CommandBuilder {
    #[cfg(windows)]
    {
        let pwsh = PathBuf::from(std::env::var_os("ProgramFiles").unwrap_or_default()).join(r"PowerShell\7\pwsh.exe");
        let mut c = CommandBuilder::new(if pwsh.exists() { pwsh.into_os_string() } else { "powershell.exe".into() });
        c.arg("-NoLogo");
        c
    }
    #[cfg(unix)]
    {
        let mut c = CommandBuilder::new(std::env::var_os("SHELL").unwrap_or_else(|| "/bin/sh".into()));
        c.arg("-l");
        c.env("TERM", "xterm-256color");
        c
    }
}

/// Starts a shell in `dir`. Output streams to `out` (UTF-8 text); `None` once the shell exits. Returns the session id.
pub fn open(dir: &Path, cols: u16, rows: u16, out: Channel<Option<String>>) -> Result<u32, AppError> {
    let pair = native_pty_system().openpty(size(cols, rows)).map_err(fail)?;
    let mut cmd = shell();
    cmd.cwd(dir);
    let child = pair.slave.spawn_command(cmd).map_err(fail)?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(fail)?;
    let writer = pair.master.take_writer().map_err(fail)?;
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    SESSIONS.lock().unwrap().get_or_insert_with(HashMap::new).insert(id, Session { master: pair.master, writer, child });
    std::thread::spawn(move || {
        let (mut buf, mut carry) = ([0u8; 8192], Vec::new());
        while let Ok(n @ 1..) = reader.read(&mut buf) {
            carry.extend_from_slice(&buf[..n]);
            let text = take_utf8(&mut carry);
            if !text.is_empty() && out.send(Some(text)).is_err() {
                break;
            }
        }
        let _ = out.send(None);
        close(id);
    });
    Ok(id)
}

fn fail(e: impl std::fmt::Display) -> AppError {
    AppError::new("pty", format!("Couldn't start the terminal: {e}"))
}

/// Removes and returns the complete UTF-8 text at the front of `buf`; a character cut off at the end stays for the next read.
fn take_utf8(buf: &mut Vec<u8>) -> String {
    let keep = match std::str::from_utf8(buf) {
        Ok(_) => buf.len(),
        Err(e) if e.error_len().is_none() => e.valid_up_to(),
        Err(_) => buf.len(), // invalid bytes, not a cut: replaced below
    };
    let rest = buf.split_off(keep);
    let text = String::from_utf8_lossy(buf).into_owned();
    *buf = rest;
    text
}

pub fn write(id: u32, data: &str) -> Result<(), AppError> {
    with(id, |s| s.writer.write_all(data.as_bytes()))
}

pub fn resize(id: u32, cols: u16, rows: u16) -> Result<(), AppError> {
    with(id, |s| s.master.resize(size(cols, rows)).map_err(std::io::Error::other))
}

/// Ends the shell (if still running) and forgets the session.
pub fn close(id: u32) {
    if let Some(mut s) = SESSIONS.lock().unwrap().as_mut().and_then(|m| m.remove(&id)) {
        let _ = s.child.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_cut_utf8_for_next_read() {
        let mut b = "aé".as_bytes().to_vec();
        let last = b.pop().unwrap();
        assert_eq!(take_utf8(&mut b), "a");
        b.push(last);
        assert_eq!(take_utf8(&mut b), "é");
        assert!(b.is_empty());
        let mut bad = vec![b'x', 0xff, b'y'];
        assert_eq!(take_utf8(&mut bad), "x\u{fffd}y");
    }

    #[test]
    fn lists_terminals() {
        let t = list(Some("nope".into()));
        println!("{:?}", t.found);
        assert_eq!(t.found[0], BUILT_IN);
        assert_eq!(t.chosen, BUILT_IN);
        if cfg!(windows) {
            assert!(t.found.iter().any(|n| n == "Command Prompt"));
        }
    }

    #[test]
    fn runs_a_shell() {
        let dir = std::env::temp_dir();
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        let out = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(j) = body {
                let _ = tx.send(j);
            }
            Ok(())
        });
        let id = open(&dir, 80, 24, out).unwrap();
        // The echoed input never contains "gitai-ok"; only the shell's output does.
        write(id, if cfg!(windows) { "echo ('gitai'+'-ok')\r" } else { "echo gitai''-ok\r" }).unwrap();
        resize(id, 100, 30).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        let mut seen = String::new();
        while !seen.contains("gitai-ok") && std::time::Instant::now() < deadline {
            if let Ok(s) = rx.recv_timeout(std::time::Duration::from_millis(200)) {
                // ConPTY asks where the cursor is and waits for the answer (xterm.js answers in the app).
                if s.contains("\\u001b[6n") {
                    write(id, "\x1b[1;1R").unwrap();
                }
                seen.push_str(&s);
            }
        }
        close(id);
        assert!(seen.contains("gitai-ok"), "no echo in: {seen}");
    }
}
