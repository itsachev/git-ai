# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

Tauri scaffold in place (create-tauri-app react-ts template). The plan and the step log live in `progress.md`. Read it first, and append an entry for every implementation step.

## Commands

- `npm install`: install frontend deps.
- `npm run tauri dev`: run the app in a native window with hot reload (first Rust build takes ~2 min). Plain `npm run dev` (http://localhost:1420) has no Tauri backend, so IPC calls fail there.
- `npm run tauri build`: release build. Output: `src-tauri/target/release/gitai.exe` plus MSI/NSIS installers under `src-tauri/target/release/bundle/`.
- `cargo test --manifest-path src-tauri/Cargo.toml`: Rust tests; also regenerates `src/bindings/*.ts` (commit them).
- `cargo test --release --manifest-path src-tauri/Cargo.toml big_graph -- --ignored --nocapture`: times the graph on a generated 100k-commit repo (last run: 0.77 s first page, 6 ms cached page).
- The exe name comes from `mainBinaryName` in `src-tauri/tauri.conf.json`. Keep it `gitai`.

## What this is

git-ai is a cross-platform desktop Git GUI (Sourcetree-like). It is local-first and open-core under Apache-2.0. Stack: Tauri 2 (Rust core) with a React 19 + TypeScript + Vite frontend.

## Architecture rules (decided, don't re-litigate)

- **Hybrid git access.**
  - Reads (log, diff, blame, refs, graph) use `git2` in `src-tauri/src/git/read.rs`.
  - Writes and network operations (commit, merge, rebase, push, fetch, clone, LFS) run the system `git` binary from `src-tauri/src/git/cli.rs`:
    - Use `Command::new("git").args([...])` and never a shell.
    - Put `--` before paths.
    - Set `GIT_TERMINAL_PROMPT=0` and `LC_ALL=C`.
    - Parse `--porcelain=v2 -z` output.
  - Working-tree status always comes from the CLI, not libgit2.
  - Requires git ≥ 2.38.
- **The repo is the database.** Never copy commits or refs into app storage. App-owned state is limited to recent repos and settings (`tauri-plugin-store`) and the op log.
- **Credentials.** Git operations go through git's own helpers (GCM, ssh-agent), with `GIT_ASKPASS` pointing back at the app. Only provider OAuth tokens go in the OS keychain (`keyring`).
- **Undo.** Before any destructive operation:
  - Record the affected refs in `.git/git-ai/oplog.jsonl`.
  - Before a discard, snapshot the working-tree content of the affected paths into `refs/git-ai/backup/<id>` (`oplog::backup`: throwaway `GIT_INDEX_FILE` + `commit-tree`, because `git stash create` can't take paths or untracked files).
  - Undo restores the recorded refs with `git update-ref`.
- **Types.** The Rust structs are the source of truth. Generate the TypeScript types with `ts-rs`; don't hand-write duplicates.
- **UI data flow.** The `notify` file watcher emits a repo-changed event, which marks TanStack Query data stale, and only the open views fetch again.
- **Commit graph.**
  - Rust (`src-tauri/src/git/graph.rs`) computes lane layout once per repo, in topological order, and returns `GraphRow { oid, col, edges: [(from_col, to_col)] }`. Each edge runs from the previous row's center to this row's center.
  - The frontend (`src/features/graph/CommitGraph.tsx`) fetches rows in pages of 500 through the `graph_rows` command and draws only the visible rows on a single sticky canvas.
  - Must stay fast on repos with 100k+ commits.
- **Large files.** No inline diff for binary files or files over 1 MB. LFS pointer files are shown as files.

## UI reference

`sources/*.png` are Sourcetree screenshots to model the UI on: `home_screen.png` (local repo list with search, Clone/Add/Create) and `selected_repo.png` (toolbar, sidebar with File Status/History and branches, commit table with graph/description/date/author/hash, commit details + file list + diff below). Match their layout and information density, adapted to narrow windows.

## Planned layout

- `src-tauri/src/`: `git/{read,cli,graph}.rs`, `commands.rs` (the IPC surface), `oplog.rs`, `errors.rs` (maps git stderr to an error code plus a beginner-friendly explanation).
- `src/features/<feature>/`: per-feature UI. `src/lib/ipc.ts` holds the typed `invoke` wrappers.
