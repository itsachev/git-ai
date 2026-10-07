//! Finds installed text editors so a conflicted file can be opened in the user's pick, not just the OS default.
use crate::errors::AppError;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
use ts_rs::TS;

/// The "Choose another app" entry: the OS "Open with" dialog (Windows only).
pub const OTHER: &str = "Other app…";

#[derive(Debug, Serialize, TS)]
#[ts(export)]
pub struct Editors {
    /// Display names of the editors found, in a fixed order. On Windows the last is `OTHER`.
    pub found: Vec<String>,
    /// The last one used; None = the OS default app.
    pub chosen: Option<String>,
}

/// (name, executable or .app bundle) for every editor installed here.
fn detect() -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    let mut add = |name: &str, paths: &[PathBuf]| {
        if let Some(p) = paths.iter().find(|p| p.exists()) {
            out.push((name.to_string(), p.clone()));
        }
    };
    #[cfg(windows)]
    {
        let env = |k: &str| PathBuf::from(std::env::var_os(k).unwrap_or_default());
        let (local, pf, pf86) = (env("LOCALAPPDATA").join("Programs"), env("ProgramFiles"), env("ProgramFiles(x86)"));
        add("VS Code", &[local.join(r"Microsoft VS Code\Code.exe"), pf.join(r"Microsoft VS Code\Code.exe")]);
        add("Cursor", &[local.join(r"cursor\Cursor.exe")]);
        add("Windsurf", &[local.join(r"Windsurf\Windsurf.exe")]);
        add("VSCodium", &[local.join(r"VSCodium\VSCodium.exe"), pf.join(r"VSCodium\VSCodium.exe")]);
        add("Zed", &[local.join(r"Zed\Zed.exe")]);
        add("Sublime Text", &[pf.join(r"Sublime Text\sublime_text.exe"), pf.join(r"Sublime Text 3\sublime_text.exe")]);
        add("Notepad++", &[pf.join(r"Notepad++\notepad++.exe"), pf86.join(r"Notepad++\notepad++.exe")]);
        // JetBrains installs into versioned folders, e.g. "IntelliJ IDEA 2025.2\bin\idea64.exe".
        for dir in [pf.join("JetBrains"), local.clone()] {
            for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
                let bin = e.path().join("bin");
                let exe = std::fs::read_dir(&bin).into_iter().flatten().flatten().map(|f| f.path()).find(|f| {
                    let n = f.file_name().unwrap_or_default().to_string_lossy();
                    n.ends_with("64.exe") && !n.starts_with("fsnotifier") && !n.starts_with("elevator")
                });
                if let (Some(exe), true) = (exe, bin.join("idea.properties").exists()) {
                    add(&e.file_name().to_string_lossy(), &[exe]);
                }
            }
        }
        add("Notepad", &[env("SystemRoot").join(r"System32\notepad.exe")]);
    }
    #[cfg(target_os = "macos")]
    {
        let home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join("Applications");
        for name in ["Visual Studio Code", "Cursor", "Windsurf", "VSCodium", "Zed", "Sublime Text", "BBEdit", "Nova", "CotEditor", "TextEdit"] {
            let app = format!("{name}.app");
            add(name, &[Path::new("/Applications").join(&app), home.join(&app), Path::new("/System/Applications").join(&app)]);
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let path = std::env::var_os("PATH").unwrap_or_default();
        for (name, bin) in [("VS Code", "code"), ("Cursor", "cursor"), ("Windsurf", "windsurf"), ("VSCodium", "codium"),
            ("Zed", "zed"), ("Sublime Text", "subl"), ("Kate", "kate"), ("gedit", "gedit"),
            ("Text Editor", "gnome-text-editor"), ("Mousepad", "mousepad"), ("Xed", "xed")]
        {
            add(name, &std::env::split_paths(&path).map(|d| d.join(bin)).collect::<Vec<_>>());
        }
    }
    out
}

pub fn list(chosen: Option<String>) -> Editors {
    let mut found: Vec<String> = detect().into_iter().map(|(n, _)| n).collect();
    if cfg!(windows) {
        found.push(OTHER.into());
    }
    Editors { found, chosen }
}

/// Opens `file` in the editor called `name` (from `list`). Only names we detected are run, never a path from the UI.
pub fn open(name: &str, file: &Path) -> Result<(), AppError> {
    let fail = |e: std::io::Error| AppError::new("open", format!("Couldn't start {name}: {e}"));
    #[cfg(windows)]
    if name == OTHER {
        use std::os::windows::process::CommandExt;
        // OpenAs_RunDLL takes the rest of the command line as the path, unquoted.
        return Command::new("rundll32.exe")
            .raw_arg(format!("shell32.dll,OpenAs_RunDLL {}", file.display()))
            .spawn().map(drop).map_err(fail);
    }
    let Some((_, exe)) = detect().into_iter().find(|(n, _)| n == name) else {
        return Err(AppError::new("open", format!("{name} isn't installed anymore. Pick another editor.")));
    };
    let mut cmd = if cfg!(target_os = "macos") {
        let mut c = Command::new("open");
        c.arg("-a").arg(exe);
        c
    } else {
        Command::new(exe)
    };
    cmd.arg(file).spawn().map(drop).map_err(fail)
}

#[cfg(test)]
mod tests {
    #[test]
    fn lists_installed_editors() {
        let e = super::list(None);
        println!("{:?}", e.found);
        if cfg!(windows) {
            assert!(e.found.iter().any(|n| n == "Notepad"));
            assert_eq!(e.found.last().map(String::as_str), Some(super::OTHER));
        }
    }
}
