<div align="center">

<img src="src-tauri/icons/128x128@2x.png" width="112" alt="git-ai logo" />

# git-ai

**A fast, local-first desktop Git GUI that explains itself.**

<h2>💯 Completely free. No subscription, no paywall, no account required.</h2>

The repository graph, staging and conflict handling you'd expect from a Sourcetree-style client, plus AI that writes your commit messages, explains commits and helps resolve conflicts. When git fails, you get the error in plain language.

[![CI](https://github.com/itsachev/git-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/itsachev/git-ai/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/itsachev/git-ai?sort=semver)](https://github.com/itsachev/git-ai/releases/latest)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](#license)
![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
![Tauri 2](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)
![React 19](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)

[**Download**](https://github.com/itsachev/git-ai/releases/latest) · [Features](#features) · [Build from source](#build-from-source) · [Architecture](#architecture)

</div>

> [!WARNING]
> **git-ai is in active development and has not officially launched.** Expect bugs, missing pieces and breaking changes between releases. Back up important work before using it on real repositories.

---

## Why git-ai

- **Free.** Every feature in the app costs nothing. AI features use your own key, so you pay your AI provider directly for those requests, or nothing at all with a local model.
- **Fast on big repos.** The commit graph is laid out in Rust and drawn on a virtualized canvas. On a 100k-commit repo the first page loads in about 0.8 s and later pages in about 6 ms.
- **Undo for destructive operations.** Before a reset, discard, force push or recreate, git-ai records the affected refs and backs up the content it is about to throw away. You can undo it from the sidebar.
- **Your repository is the database.** No commits or refs are copied into app storage. git-ai only keeps recent repos, settings and the undo log.
- **Uses your git setup.** Writes and network operations run your own `git` binary, so credential helpers (GCM, ssh-agent), hooks and config work the way they do in the terminal.
- **AI with your own key.** Use Gemini, Claude, OpenAI or any OpenAI-compatible server, including a local one such as Ollama. Keys are stored in your OS keychain.
- **Helpful errors.** Git's stderr is translated into plain language with a suggested fix, often one click away.

## Features

<table>
<tr><td valign="top" width="50%">

### 📁 Repositories
- Open, create (`git init`) and clone, with live progress
- Pick a repo to clone from your GitHub or GitLab account
- Recent repos list with a filter; moved or deleted folders are flagged

### ✏️ File Status
- Stage, unstage and discard **files, hunks or single lines**
- Commit and amend, with an **AI-generated commit message**
- Ignore files by name, extension or folder
- **Git LFS**: track or untrack patterns, download LFS files
- Binary files and files over 1 MB get no inline diff

### 🕸️ History
- Commit graph with all-branches or current-branch view and date or topological sort
- Commit details and diffs, **AI explanations**, file history and blame
- Right-click any commit to branch, merge, rebase, revert or reset (soft, mixed, keep or hard, all undoable)

</td><td valign="top" width="50%">

### 🌿 Branches, tags & stashes
- Create, switch (carrying your changes), rename, track, delete
- Merge, cherry-pick and **interactive rebase**
- **Drag and drop** a branch onto another to merge or rebase
- Tags and stashes, with AI explanations for branches and stashes

### ☁️ Remotes & hosting
- Fetch, pull (merge or rebase) and push, with ahead/behind counts
- Rejected-push dialog that offers pull-then-push or force push with lease
- GitHub and GitLab sign-in; open **PRs / MRs with AI-written descriptions**
- AI changelogs

### ⚔️ Conflicts
- Keep mine, theirs or both; open in your editor
- **AI resolve**: review the proposed file before applying it

### ⌨️ Everywhere
- Command palette (<kbd>Ctrl</kbd>+<kbd>K</kbd>) and keyboard shortcuts
- **Built-in terminal** in the repo folder (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd>), or open your own terminal app
- Light, dark or system theme; first-run setup; auto-update

</td></tr>
</table>

> The full list, with where to find each feature, is in the app under **ⓘ About** on the home screen.

## Install

Get the installer for your platform from the **[latest release](https://github.com/itsachev/git-ai/releases/latest)**:

| Platform | Package |
| --- | --- |
| Windows | `.msi` or `-setup.exe` |
| macOS (Apple Silicon / Intel) | `.dmg` |
| Linux | `.AppImage`, `.deb` or `.rpm` |

**Requirement:** [git](https://git-scm.com/downloads) **2.38 or newer** on your `PATH`.

> [!NOTE]
> The installers are not code-signed yet. Windows SmartScreen and macOS Gatekeeper will warn the first time you open the app. On macOS, right-click the app and choose **Open**.

Once installed, git-ai updates itself: when a new release is out, a banner offers to install it and restart.

## AI setup

AI features are optional and use your own key (BYOK). Open **Settings → AI**, pick a provider and model, and paste your key.

| Provider | Default model | Key env var (dev fallback) |
| --- | --- | --- |
| Google Gemini | `gemini-3.5-flash-lite` | `GEMINI_API_KEY` |
| Anthropic Claude | `claude-opus-5-5` | `ANTHROPIC_API_KEY` |
| OpenAI / compatible (Ollama, LM Studio, …) | `gpt-5-mini` | `OPENAI_API_KEY` |

> [!IMPORTANT]
> The providers and default models above are temporary choices for development. They will change before launch.

Data is only sent when you click an AI action, and it goes straight from your machine to the provider you picked. What gets sent is the relevant diff, commit messages or conflicted file. Diffs are cut at 100 KB. With a local OpenAI-compatible server, nothing leaves your computer.

## Build from source

**Prerequisites:** [Node.js](https://nodejs.org) 20+, [Rust](https://rustup.rs) (stable), git ≥ 2.38, and the [Tauri 2 system dependencies](https://v2.tauri.app/start/prerequisites/) for your OS.

```bash
git clone https://github.com/itsachev/git-ai.git
cd git-ai
npm install
npm run tauri dev      # native window with hot reload (first Rust build takes ~2 min)
```

| Command | What it does |
| --- | --- |
| `npm run tauri dev` | Runs the app with hot reload |
| `npm run tauri build` | Release build: `src-tauri/target/release/gitai` plus installers in `bundle/` |
| `cargo test --manifest-path src-tauri/Cargo.toml` | Runs the Rust tests and regenerates `src/bindings/*.ts` |
| `cargo test --release --manifest-path src-tauri/Cargo.toml big_graph -- --ignored --nocapture` | Benchmarks the graph on a generated 100k-commit repo |

> [!TIP]
> `npm run dev` alone serves only the frontend at `localhost:1420`. It has no Tauri backend, so git calls fail there. Use `npm run tauri dev`.

## Architecture

```
┌────────────────────────── React 19 + TypeScript (Vite) ──────────────────────────┐
│  src/features/<feature>/   per-feature UI      src/lib/ipc.ts   typed invoke()   │
│  TanStack Query cache  ◄── "repo-changed" event (notify file watcher)            │
└───────────────────────────────────────┬──────────────────────────────────────────┘
                                        │ Tauri IPC (types generated with ts-rs)
┌───────────────────────────────────────▼──────────────────────────────────────────┐
│  src-tauri/src/commands.rs                                                       │
│   ├─ git/read.rs   reads via libgit2 (log, diff, blame, refs)                    │
│   ├─ git/graph.rs  lane layout, computed once, served in pages of 500 rows       │
│   ├─ git/cli.rs    writes + network via system git (no shell, porcelain v2 -z)   │
│   ├─ oplog.rs      undo log + backup refs (refs/git-ai/backup/*)                 │
│   ├─ terminal.rs   built-in terminal (PTY) + launching terminal apps             │
│   └─ errors.rs     git stderr → error code + plain-language explanation          │
└──────────────────────────────────────────────────────────────────────────────────┘
```

- **Hybrid git access.** Reads go through `git2` for speed. Writes, network operations and working-tree status go through the `git` CLI, so behavior matches the terminal.
- **Rust types are the source of truth.** The TypeScript bindings are generated with `ts-rs`, never written by hand.
- **Credentials** go through git's own helpers, with `GIT_ASKPASS` pointing back at the app. Only GitHub and GitLab OAuth tokens and AI keys are stored, in the OS keychain.
- **Undo** writes to `.git/git-ai/oplog.jsonl` and restores refs with `git update-ref`.

## Contributing

Issues and pull requests are welcome. Before you open a PR:

1. Run `npm run build` and `cargo test --manifest-path src-tauri/Cargo.toml`.
2. Commit any regenerated `src/bindings/*.ts`. CI fails if they drift.
3. Click through your change in `npm run tauri dev`.

## License

[Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0). Open core: the desktop app is and stays free.
