# git-ai — Progress

## App info
- **What:** Free, cross-platform desktop Git GUI (Sourcetree-like), local-first, open-core (Apache-2.0).
- **Users:** Power users first, beginner-friendly error explanations layered on.
- **Platforms:** Windows + macOS first, Linux best-effort.
- **Stack:** Tauri 2 + Rust core, React 19 + TypeScript + Vite frontend.
- **Git access (hybrid):** reads via `git2` (log, diff, blame, refs, graph); writes + network via system `git` binary (no shell, porcelain v2 `-z` parsing). Requires git ≥ 2.38.
- **Credentials:** git's own credential helpers (GCM, ssh-agent) via `GIT_ASKPASS`; provider OAuth tokens in OS keychain (`keyring`).
- **Undo:** op log in `.git/git-ai/oplog.jsonl` + backup refs under `refs/git-ai/backup/*`.
- **Graph:** lane layout in Rust (`src-tauri/src/git/graph.rs`), paged to a virtualized canvas (`src/features/graph/CommitGraph.tsx`).
- **Run/build:** `npm install`, then `npm run tauri dev`. It opens a native window and rebuilds as `src/` changes; the first Rust build takes ~2 min. `npm run dev` serves only the frontend at http://localhost:1420, where the Tauri IPC (git data, folder picker) does not work, so use the window. Release: `npm run tauri build` produces `src-tauri/target/release/gitai.exe` + installers in `bundle/`.

## Phases
- **MVP (wk 1–12):** clone/open/recent, staging (file/hunk/line), commit/amend, discard+undo, graph, branches, merge/cherry-pick/tags/stash, fetch/pull/push, basic conflict UI, GitHub OAuth, shortcuts + palette, auto-update.
- **v1:** interactive rebase, drag-drop branches, blame, file history, LFS, submodules, terminal, GitHub PRs, AI commit messages (BYO key), GitLab/Bitbucket OAuth.
- **v2:** 3-way merge editor, Azure/GitLab PRs, worktrees, sparse/partial clone UI, signing UI, plugins, paid team features.

## Log
### 2026-10-05
- Defined product plan: defaults chosen for licensing, team, git access, platform, integrations.
- Picked stack (Tauri + Rust + React), architecture, data model, folder layout, libraries, risks, 12-week roadmap, monetization.
- Drafted commit-graph lane algorithm + canvas renderer (in plan, not yet in repo, untested).
- Added `CLAUDE.md` (architecture rules, planned layout; commands to be added after scaffold).
- Initialized git repo (`main` branch), added `.gitignore` (node, dist, Rust target, env, OS/IDE files), initial commit `dd3f5dd`.
- Global `core.autocrlf` was converting LF→CRLF on Windows. Added `.gitattributes` (`* text=auto eol=lf`) so every OS checks out LF; renormalized.
- Scaffolded Tauri 2 + React 19 + TS + Vite via `create-tauri-app` (react-ts template, identifier `dev.gitai.app`). Merged into repo, kept existing `.gitignore` (+ `dist-ssr/`, `*.local`).
  - Files: `package.json`, `index.html`, `vite.config.ts`, `tsconfig*.json`, `src/`, `public/`, `src-tauri/`, `.vscode/`.
  - Window 1280x800, min 800x500. `mainBinaryName: "gitai"` so the release exe is `gitai.exe` (user requirement).
  - `npm run tauri dev` verified: compiled in ~2 min, app launched.

- Week 1 remainder: safe git runner, open repo, recent repos, CI.
  - `src-tauri/src/git/cli.rs`: `git(repo, args)` runs system git with `-C`, no shell, `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`, `CREATE_NO_WINDOW` on Windows; `ensure_version()` checks ≥ 2.38 once per process (`OnceLock`). Tests: version parsing + a real `git rev-parse`.
  - `src-tauri/src/git/read.rs`: `open(path)` via `git2::Repository::discover` → `RepoInfo { path, name, branch }`; bare repos rejected. git2 added with `default-features = false` (network goes through the CLI, so no OpenSSL/libssh2).
  - `src-tauri/src/errors.rs`: `AppError { code, message }`, maps git2 NotFound → `not_a_repo`.
  - `src-tauri/src/commands.rs`: `open_repo` (validates, pushes onto recents, max 10, deduped) and `recent_repos`, stored in `settings.json` via `tauri-plugin-store` from Rust only.
  - ts-rs: `.cargo/config.toml` sets `TS_RS_EXPORT_DIR` → `src/bindings/`; `cargo test` regenerates. Bindings are committed; CI fails if they drift.
  - Frontend: `src/lib/ipc.ts` typed wrappers; `App.tsx` welcome screen (Open via `tauri-plugin-dialog` folder picker, recent list, error line) and a placeholder repo header. Removed template assets. Light/dark via `prefers-color-scheme`; single-column layout, ellipsized paths.
  - `.github/workflows/ci.yml`: ubuntu/macos/windows matrix, `npm ci`, `npm run build`, `cargo test`, bindings drift check.
  - Verified: `cargo test` (4 pass), `npm run build` OK. Not yet clicked through in `tauri dev`; CI not yet run on GitHub (no remote).

- Week 2: working-tree status, watcher, TanStack Query.
  - `cli::status()`: `git --no-optional-locks status --porcelain=v2 -z --branch --untracked-files=all`, parsed into `Status { branch, staged, unstaged, conflicted }` of `FileChange { path, orig_path, kind }`. `--no-optional-locks` keeps status from rewriting the index (otherwise the watcher would trigger an endless refresh loop). Parser unit test covers types 1/2/u/?, renames, spaces, detached HEAD.
  - `src-tauri/src/watch.rs`: `notify-debouncer-mini` (300 ms) recursively watches the open repo and emits `repo-changed`. One watcher at a time (managed `RepoWatcher` state); `open_repo` starts it.
  - `repo_status` command + `repoStatus` IPC wrapper.
  - Frontend: `@tanstack/react-query`; `staleTime: Infinity`, no focus refetch; a global `repo-changed` listener in `main.tsx` invalidates queries, so only mounted queries refetch. `src/features/status/Changes.tsx` shows the Conflicts/Staged/Changes lists (kind badge, file name, then the dimmed dir, which is ellipsized). The header branch comes from the live status.
  - Fix: moved `.cargo/config.toml` to the repo root. Cargo reads config from the cwd, so `cargo test --manifest-path src-tauri/Cargo.toml` run from the root (CI, CLAUDE.md) was writing bindings to `src-tauri/bindings/`.
  - Verified: `cargo test` (7 pass), `npm run build` OK. Not yet clicked through in `tauri dev`.

- Week 3: stage/unstage/discard, backups + op log, file diff, commit box.
  - `cli.rs`: `stage` (`add -A --`), `unstage` (`reset -q --`, works before the first commit; staged renames pass both paths), `discard` (`restore --worktree --` for tracked, `clean -f --` for untracked, after a backup), `commit` (`commit -q -m`). `git_env()` runs git with extra env vars.
  - `src-tauri/src/oplog.rs`: `backup(repo, op, paths)` snapshots the working-tree content of the paths (tracked + untracked) with a throwaway `GIT_INDEX_FILE` (`read-tree HEAD`, `add -A`, `write-tree`, `commit-tree -p HEAD` with a fixed git-ai identity), stores it at `refs/git-ai/backup/<ms>`, appends `{id, op, head, paths, backup}` to `.git/git-ai/oplog.jsonl`. Deviates from the planned `git stash create` (it can't take paths or untracked files); CLAUDE.md updated.
  - `read.rs`: `file_diff(repo, file, staged)` via git2 (HEAD→index or index→workdir incl. untracked); `max_size(1 MB)` makes big files count as binary, so `None` = no inline diff.
  - Commands `stage`, `unstage`, `discard`, `commit`, `file_diff` + IPC wrappers.
  - UI (`Changes.tsx`): commit box (Ctrl/Cmd+Enter, disabled with nothing staged or empty message), per-file and "all" Stage/Unstage/Discard/Mark resolved buttons, discard asks via `tauri-plugin-dialog` `ask`. Clicking a file shows its diff (hunks only, +/- colored). Two columns from 52rem, stacked below; diff panel sticky and scrolls on its own.
  - Tests: temp-repo round trip (stage, unstage before first commit, commit, discard tracked + untracked, backup ref content, oplog line), diff smoke test. Test repo pins `core.autocrlf=false`.
  - Verified: `cargo test` (9 pass), `npm run build` OK. Not yet clicked through in `tauri dev`.
  - Skipped: hunk/line staging, amend (needs an oplog entry), rename detection in diffs, diff virtualization.

## Next
- Week 4: undo for discard (restore paths from the backup ref, UI entry from the op log), hunk/line staging, amend with oplog. Commands are sync (run on the main thread); make them async if slow hooks freeze the UI.
