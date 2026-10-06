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
- **v1:** interactive rebase, drag-drop branches, blame, file history, LFS, submodules, terminal, GitHub PRs, AI features (see below), GitLab/Bitbucket OAuth.
- **v2:** 3-way merge editor, Azure/GitLab PRs, worktrees, sparse/partial clone UI, signing UI, plugins, paid team features.

## AI features (planned, v1)
- **AI commit & PR generator:** generate commit messages from the staged diff, plus PR titles, PR descriptions and release changelogs (from a commit range or between tags).
- **AI code explanations:** explain a commit, the changes on a branch (vs. its base) and a stash.
- **AI tokens & model choice:**
  - Weekly token allowance per tier (e.g. 250k to 2M+ tokens).
  - Custom model configuration (provider, model, parameters).
  - Bring Your Own Key (BYOK). BYOK keys go in the OS keychain (`keyring`), never in settings.
- **Dev-phase model:** Gemini 3.5 Flash Lite for all AI features during development.
- **Gemini key storage:** OS keychain, service `git-ai`, user `gemini` (same as the GitHub token), set from an in-app field. Dev fallback: `GEMINI_API_KEY` env var, read before the keychain. Never in the repo, settings or docs.
- Open questions: hosted proxy for tier tokens (metering, abuse limits); what diff content is sent and how users opt in; size limits for large diffs (reuse the 1 MB / binary skip).

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

- Week 4: undo, hunk/line staging, amend.
  - `oplog.rs`: typed `OpEntry { id, op, head, new_head, paths, backup, undoes }` (ts-rs), `record`, `entries` (newest first, undone entries hidden), `undo(id)`. Undo of a backup entry snapshots the current content of the paths first, then `restore --source <backup> --worktree --` (also deletes paths missing from the backup). Undo of a HEAD move (amend) is a compare-and-swap `update-ref HEAD <old> <new>`, so it refuses once HEAD moved. Undo is itself logged as op "undo", so it can be undone too. Snapshot skips paths that are neither on disk nor in HEAD (`git add` would fail on them).
  - `cli.rs`: `git_input` pipes stdin. `commit(.., amend)` logs HEAD before/after. `apply_lines(file, op, lines)` with `LineOp::{Stage, Unstage, Discard}`: rebuilds the file diff, `select_lines` keeps the picked +/- lines and turns the rest into context or drops them (rule flips for reverse application), then `git apply --recount [--cached] [-R] -`. Discard backs up the file first. `lines` index into the `file_diff` text lines.
  - `read.rs`: `head_message` (prefills the amend box).
  - Commands `head_message`, `apply_lines`, `op_log`, `undo`; `commit` takes `amend`.
  - UI: "Amend last commit" checkbox (prefills HEAD message, allows reword with nothing staged). Diff: per-hunk Stage/Discard or Unstage buttons, click/Shift+click line selection with a bar for the selected lines; disabled for conflicted files. Discards (file, hunk, lines) ask first. Collapsible "Undo history" list under the file lists.
  - Tests: round trip extended with undo discard, amend + undo, stage/unstage/discard of single lines. 11 pass, `npm run build` OK. Not yet clicked through in `tauri dev`.
  - Known gaps: line selection is mouse-only (hunk buttons are keyboard reachable); picking only some lines of a deleted file (stage) or of a newly added file (unstage, discard) fails in `git apply` because the patch keeps the delete/new-file header (whole hunk works); op ids are ms timestamps (two ops in one ms would collide).

- Week 5: commit graph + History view (modeled on `sources/selected_repo.png`, Sourcetree).
  - Added `sources/` UI reference screenshots (Sourcetree home + repo History view); CLAUDE.md points at them.
  - `src-tauri/src/git/graph.rs`: revwalk over branches, remote branches, tags (peeled) and HEAD, `TOPOLOGICAL | TIME`. `layout()` assigns lanes: each lane waits for an oid and remembers which previous-row lanes feed it, so merges/forks come out as `(from_col, to_col)` edges; trailing free lanes are dropped. Layout cached in managed `GraphCache` keyed by repo + sorted tip oids, so it is recomputed only when a ref moves (not for refs/git-ai backups). `rows(offset, limit)` adds summary, author, time, ref names, head flag per page.
  - `read.rs`: `commit_details` (parents, author/committer, message, files vs first parent with rename detection) and `commit_file_diff` (1 MB/binary → None).
  - Commands `graph_rows`, `commit_details`, `commit_file_diff` are async (off the main thread).
  - UI: header tabs File Status / History; repo view now fills the window. `src/features/graph/CommitGraph.tsx`: virtualized table (24 px rows, pages of 500 via `useQueries`, page 0 always loaded for the total), one canvas drawn only for the visible rows (bezier for lane changes, hollow dot = HEAD), graph width capped at 16 lanes. Columns Graph/Description (ref badges)/Date/Author/Commit; date+author hide below 48rem, hash below 30rem. Arrow/Page keys move the selection; first commit auto-selected. `History.tsx`: details + file list left, read-only diff right (stacked below 52rem).
  - Tests: lane layout (linear, merge, two tips), temp repo (details, rename detection, commit diff, graph page). 16 pass, `npm run build` OK. Not yet clicked through in `tauri dev`; 100k-commit speed not measured yet.
  - Skipped: branch/tag badge colors (names only), clicking parents to jump, filters (all branches / remote toggle / date vs ancestor order), search.
- Planning: added the AI feature set (commit/PR/changelog generation, code explanations, token tiers + model choice + BYOK) to the plan under "AI features"; v1 phase now points there.

- Week 6: branches sidebar, checkout, create/delete branch.
  - `read.rs`: `refs()` → `Refs { head, local, remote, tags, stashes }` of `RefItem { name, oid, upstream, ahead, behind }` (git2; ahead/behind via `graph_ahead_behind`, stashes via `stash_foreach`).
  - `cli.rs`: `checkout(name, track)` (`switch`, or `switch --track origin/x` to create the local tracking branch), `create_branch(name, checkout)` (`switch -c` / `branch`), `delete_branch(name, force)` (`branch -d/-D`; "not fully merged" → code `not_merged`). `switch`/`branch` take no `--`, so names starting with `-` are rejected (`bad_name`).
  - `oplog.rs`: `OpEntry.ref_name` (default HEAD). Branch delete logs the tip; undo is a compare-and-swap `update-ref <ref> <old> ""` (recreate) or `update-ref -d <ref> <new>` (delete), so undo-of-undo works too. Op ids are now strictly increasing per process (fixes the same-ms collision from week 4).
  - Commands `refs`, `checkout`, `create_branch`, `delete_branch` + IPC wrappers. `useRun()` (op runner + error state) extracted from `Changes.tsx` and shared.
  - UI `src/features/refs/Sidebar.tsx`: filter box, collapsible Branches (current ●, ahead ↑/behind ↓, "+ New" inline form with "Check out" option), Remotes grouped by remote, Tags, Stashes (list only). Double-click or the Checkout button checks out; a remote branch checks out its local namesake (created tracking if missing). Delete asks first, asks again to force when unmerged; Undo history shows branch deletes. Row buttons show on hover/focus (opacity, so still tabbable), always on touch. Sidebar is a 14rem column from 48rem; below that a "Branches" header button swaps it in for the body.
  - Tests: oplog round trip extended (create+switch, commit, unmerged delete refused, force delete, undo, undo of undo, bad name, refs listing). 18 pass, `npm run build` OK. Not yet clicked through in `tauri dev`.
  - Skipped: branch from a picked commit, rename, delete remote branches/tags, stash apply/drop (week 7), click a ref to jump to its commit in the graph.

- Week 7: merge, cherry-pick, tags, stash.
  - `read.rs`: `operation()` (git2 `state()`: "merge" / "cherry-pick" / "revert" / "rebase"), added to `Status.operation`.
  - `cli.rs`: `merge(rev, cherry_pick)` (`merge --no-edit` / `cherry-pick`); when git stops halfway the error is code `conflicts` and the op stays in progress. `commit()` while an op is in progress finishes it (empty message → `--no-edit`, git's prepared message). `abort()` backs up all changed files (`oplog::backup`, op "abort merge") then runs `git <op> --abort`. `create_tag` (annotated when a message is given), `delete_tag` (logs the tag object oid). `stash_save` (`push -u`), `stash(op, index, oid)` for Apply/Pop/Drop: refuses with `stale` when `stash@{index}` is no longer `oid`; a stash that disappears is logged as "drop stash".
  - Undo: merge, cherry-pick and the finishing commit log HEAD before/after (`log_head_move`), so undo is a soft reset (the merged changes stay staged, discard them if wanted). Tag delete undoes via the generic ref CAS. "drop stash" undo runs `git stash store` with the stash's own subject. Undo entries are now named `undo <op>` (old entries say just "undo"), labels render as "Undo: <label>".
  - Commands `merge`, `abort`, `create_tag`, `delete_tag`, `stash_save`, `stash` + IPC wrappers, `StashOp` binding.
  - UI: File Status shows a banner "Merge in progress…" with Abort (asks first); commit box allows an empty message then. Sidebar rows take a generic `actions` list: branches Checkout/Merge/Delete, remote branches Checkout/Merge, tags Delete, stashes Apply/Pop/Drop (drop asks), "+ Stash" form. The inline form is now `NameForm` (shared with History). Row actions overlay the right end of the name on hover (name keeps full width), sit in flow and wrap on touch. History: Cherry-pick / Merge into current / Tag… on the selected commit.
  - Tests: new `merge_tag_stash` (conflicting merge + abort with backup, finish with git's message, undo merge, cherry-pick, annotated tag delete + undo, stash save/stale/drop/undo/pop). 20 pass, `npm run build` OK. Not yet clicked through in `tauri dev`.
  - Skipped: cherry-pick of merge commits (`-m`), conflict editor (only "Mark resolved" via stage), stash apply `--index`, tag push, revert/rebase start (abort covers them if begun elsewhere).

- Week 8: fetch/pull/push, credential prompts, remote branch delete, tag push.
  - `src-tauri/src/askpass.rs`: the app listens on a random `127.0.0.1` port (`setup`). Network git gets `GIT_ASKPASS` = `SSH_ASKPASS` = the app's own exe, `SSH_ASKPASS_REQUIRE=force`, `GITAI_ASKPASS="<port> <token>"`. `main.rs` sees `GITAI_ASKPASS` and runs `askpass::client()` instead of the app: it sends token + prompt, the app emits `askpass` `{id, prompt}`, the UI answers via `askpass_reply` (null = cancel, exit 1; 5 min timeout). Token = 128 bits from std's randomly keyed SipHash (no new dep). Unset in tests, so git fails instead of prompting.
  - `cli.rs`: `git_net` (askpass env + `net_error`: codes `rejected`, `auth`, `network`, `no_upstream` with a plain explanation plus git's last line). `fetch` (`--all --prune`), `pull` (`--no-rebase --no-edit`, logged as "pull" via `log_head_move`, so undo = soft reset; conflicts → code `conflicts`), `push` (current branch to `branch.<b>.remote`/`merge`; without upstream to `origin` or the first remote with `-u`), `push_tag`, `delete_remote_branch` ("origin/feat"; remote matched against `git remote`, longest prefix). Shared `stopped()` conflict mapping extracted from `merge`. `git_env` takes `&OsStr` values.
  - Undo of "delete remote branch": tip logged and pinned at `refs/git-ai/kept/<id>` (gc-safe); undo pushes it back (`restore_remote_branch`). That undo isn't undoable itself.
  - Commands `fetch`, `pull`, `push`, `push_tag`, `delete_remote_branch` are async; `undo` is now async too (it may push). Sync commands run on the main thread, which would block askpass events.
  - UI: `src/features/remote/Remote.tsx`. `SyncButtons` in the header: Fetch / Pull ↓n / Push ↑n (counts from the current branch's upstream), busy label, error on its own line under the header. `AskpassDialog`: native `<dialog>`, one prompt at a time, input masked unless the prompt mentions a username or yes/no, Esc = cancel. Sidebar: remote branches get Delete (asks), tags get Push. `refsQuery` exported from `Sidebar.tsx`.
  - Tests: `askpass::round_trip` (answer, wrong token, cancel), `remote_ops` against a local bare remote (no-remote push, push sets upstream, rejected push, fetch, pull + undo, tag push, remote branch delete + undo). 23 pass, `npm run build` OK. Not yet clicked through in `tauri dev`; askpass not yet tried against a real HTTPS/SSH remote.
  - Skipped: force push (`--force-with-lease`), pull with rebase, push/fetch of a picked remote, remote tag delete, progress output, cancel of a running network op.

- Week 9: clone with progress, basic conflict UI.
  - `cli.rs`: `command()` builds the git `Command` (shared by `run` and clone). `clone(url, dest, progress)`: `clone --progress -- <url> <dest>` with the askpass env, reads stderr byte by byte and hands each line (split on `\r` or `\n`) to `progress`; failure goes through `net_error`. URLs starting with `-` are rejected (`bad_url`). `resolve(paths, Side::{Ours, Theirs})`: backs up the paths (op "take ours"/"take theirs", so undo brings back the markers and edits), `checkout --ours/--theirs --` + `add`; when that side deleted the file ("does not have our version") it runs `rm` instead.
  - `read.rs`: `work_file` (working-tree text, None when binary or over 1 MB) to show a conflicted file with its markers.
  - Commands `clone_repo` (async; emits `clone-progress` with each line, then runs `open_repo`), `resolve`, `work_file`, `open_file` (opens a repo file in its default app via `tauri-plugin-opener` from Rust, so no JS path scope is needed; rejects absolute paths and `..`).
  - UI: welcome screen has Clone… next to Open. `CloneForm` (in `Remote.tsx`): URL, parent folder (text + Browse…), folder name guessed from the URL until edited, git's latest progress line beside the Clone button, error below. `AskpassDialog` moved to the App root so clone can prompt for credentials too. File Status: selecting a conflicted file shows `Conflict` instead of the diff: the file with marker lines dimmed, ours / base (diff3) / theirs regions tinted, legend, and Take ours / Take theirs / Open file / Mark resolved. Undo history labels "Take theirs for a.txt". `Diff` lost its `editable` flag (conflicts no longer reach it).
  - Tests: `clone_and_resolve` (clone from a local repo with progress lines, non-empty dest and `-x` URL refused, edit/edit + edit/delete conflict, take theirs on both, finish the merge). 25 pass, `npm run build` OK. Not yet clicked through in `tauri dev`.
  - Undo of a take-side restores the file content but not the conflict state in the index (the file stays resolved; stage it again after editing).
  - Skipped: clone cancel, shallow/branch/recursive clone options, per-hunk conflict picking (v2: 3-way merge editor), resolve several files at once in the UI.

- Week 10: GitHub sign-in (OAuth device flow), token in the OS keychain.
  - New deps: `ureq` 3 (`json`, rustls) for HTTPS, `keyring` 3 (`apple-native`, `windows-native`, `sync-secret-service`).
  - `src-tauri/src/github.rs`: `start` (POST `login/device/code`, scope `repo`), `finish` (polls `login/oauth/access_token` every `interval` s, +5 s on `slow_down`; codes `expired` / `denied`; stores the token under keychain service `git-ai`, user `github`), `user` (GET `api.github.com/user`; a 401 forgets the token), `sign_out`. Client id comes from `GITAI_GITHUB_CLIENT_ID` (runtime env, else baked in at build); missing = code `github_not_configured`.
  - askpass: `ask()` first tries `github::askpass_answer`: git's "Username/Password for 'https://github.com…'" prompts get `x-access-token` / the token when signed in, else the dialog as before. Only reached when no credential helper (GCM) answers.
  - Commands `github_start`, `github_finish`, `github_user` (async), `github_sign_out` + IPC wrappers, `DeviceCode` binding.
  - UI: `src/features/github/GitHub.tsx` on the welcome screen: "Sign in to GitHub", then the code in large type, "Copy code & open GitHub" (clipboard + `openUrl`), Cancel, "Waiting for approval…"; signed in shows `@login` + Sign out. Hidden when the user check fails (offline).
  - Tests: `github::prompts` (host matching: github.com only, rejects `github.com.evil.io`, `github.com@evil.io`, http, ssh passphrase). 27 pass, `npm run build` OK. Not tried against GitHub: needs an OAuth app with device flow enabled.
  - A revoked-but-cached token makes HTTPS git fail with an auth error until the next `github_user` check (on app start) forgets it, or Sign out.
  - Skipped: GitLab/Bitbucket (v1), account in the repo header, cancelling the backend poll (it stops at code expiry, ~15 min).

- Week 11: keyboard shortcuts + command palette (frontend only).
  - `src/features/palette/Palette.tsx`: `Command { label, keys?, run }`. A "Commands" header button, Ctrl+K or Ctrl+Shift+P opens a native `<dialog>`: text field (combobox), list filtered by every typed word, ↑/↓ wrap, Enter runs, Esc / backdrop click closes, shortcut shown on each row (⌘/⇧ on macOS). One window `keydown` listener runs a command's `keys` (Ctrl = Ctrl or Cmd), ignored while any dialog is open (askpass, the palette itself) and on key repeat.
  - Commands (built in `RepoView`, `App.tsx`): File Status Ctrl+1, History Ctrl+2, Toggle branches Ctrl+B, Write commit message Ctrl+Shift+M (switches tab, focuses `#commit-msg`), Fetch Ctrl+Shift+F, Pull Ctrl+Shift+L, Push Ctrl+Shift+U, Stage all Ctrl+Shift+S, and without keys: Unstage all, Undo the latest op (label from `opLabel`), Checkout <local branch>, Close repository. Commands that don't apply (nothing to stage, no oplog) are left out.
  - `Remote.tsx`: fetch/pull/push state moved into `useSync(path, run)` so the toolbar and the palette share the busy flag; `SyncButtons` only renders it. The op error now shows under the header from `RepoView`'s `useRun`.
  - `Changes.tsx`: exports `Run`, `pathsOf`, `opLabel`, `opLogQuery` (shared query def for the undo list and the palette).
  - Verified: `npm run build` OK. Not yet clicked through in `tauri dev`.
  - Skipped: rebinding shortcuts, palette on the welcome screen (open/clone/recent), Ctrl+Z for undo (clashes with text fields), checkout of remote branches from the palette.

- Week 12: auto-update (2026-10-05).
  - Remote `origin` = `https://github.com/itsachev/git-ai` (pushed `main`).
  - New deps: `tauri-plugin-updater` (registered in `setup`, desktop only), `tauri-plugin-process` (relaunch); JS `@tauri-apps/plugin-updater`, `@tauri-apps/plugin-process`. Capabilities `updater:default`, `process:allow-restart`.
  - `tauri.conf.json` `plugins.updater`: minisign pubkey + endpoint `https://github.com/itsachev/git-ai/releases/latest/download/latest.json`. Signing key generated without password at `~/.tauri/gitai.key` (NOT in the repo; losing it means shipped apps can never update again, back it up).
  - `.github/workflows/release.yml`: on tag `v*`, `tauri-action` builds Windows, Linux, macOS arm64 + x64 into a draft release with `latest.json`. `createUpdaterArtifacts` is turned on only there via `--config`, so local `npm run tauri build` needs no private key. Needs repo secret `TAURI_SIGNING_PRIVATE_KEY` (contents of `~/.tauri/gitai.key`). Release = bump version in `tauri.conf.json` (+ `Cargo.toml`, `package.json`), tag, push tag, publish the draft.
  - UI: `src/features/update/Update.tsx` `UpdateBanner` at the App root (both screens): checks once at startup, failures ignored (offline/dev/no release). Shows "git-ai X is available" + Install & restart / Later, download percent, error inline. Fixed bottom-right, wraps on narrow windows.
  - Verified: `npm run build` OK, 27 tests pass. Not tried end to end: needs two published releases.
  - Skipped: code signing of installers (Windows Authenticode, macOS notarization: unsigned macOS builds get Gatekeeper warnings), periodic re-check, release notes in the banner, update channel setting.

- Planning (2026-10-05): MVP code complete. Next order agreed: harden the MVP (click-through in `tauri dev`, 100k-commit graph speed, v0.1.0 → v0.1.1 update test), then v1 starting with AI commit messages (BYOK, Gemini 3.5 Flash Lite in dev), interactive rebase, blame + file history, GitHub PRs. Dev Gemini key received; kept out of the repo (see "AI features").

- UI redesign (2026-10-05, frontend only): "instrument panel" direction.
  - Tokens in `src/App.css` (rewritten): graphite surfaces, one acid-lime signal (`--accent` fill, `--accent-ink` text on it, `--accent-fg` as text/outline) for HEAD, the selection and primary actions. Light + dark. Native type (Segoe Variable / SF, Cascadia / JetBrains Mono), no web fonts, so it works offline. 13 px base; `--ctl` control height grows to 2.75rem on `pointer: coarse`.
  - Icons: `src/lib/icons.tsx`, Solar linear set (CC BY 4.0) + mdi:github inlined from the Iconify API; no icon dependency, no network.
  - Home: two columns from 60rem (brand mark, headline, Open/Clone tiles, GitHub | Recent with a filter shown at > 3 repos), stacked below. Recent names now split on `\` too (Windows paths showed the full path).
  - Repo view: full-height left rail (back, repo + branch, File Status / History nav with change count, refs sidebar). Toolbar: view title, segmented Fetch/Pull/Push with icons (spinning icon while busy), command-palette pill with its shortcut. Below 48rem the rail is an off-canvas drawer with a scrim (`visibility: hidden` when closed, so it is not tabbable) and toolbar labels become screen-reader only.
  - File Status: lists scroll, commit box pinned under them; per-file buttons show on hover/focus/selection (always on touch). Diffs (both views) get old/new line-number gutters (`lineNumbers`, `Gutter` in `Changes.tsx`), sticky while scrolling sideways.
  - History: commit subject as a heading, body below, then actions, metadata, files. Graph lane colors retuned for both themes; canvas reads `--panel` for the hollow HEAD dot.
  - Motion is CSS only: view fade, drawer slide, dialog pop, form rise, all off under `prefers-reduced-motion`. No GSAP / smooth scroll / WebGL: smooth scroll would fight the virtualized graph.
  - Verified: `npm run build` OK. Screenshots (headless Edge, IPC faked with `@tauri-apps/api/mocks` in a throwaway harness) of home, File Status, History, light/dark, 320/390 px and the drawer. Not yet clicked through in `tauri dev`.

- Theme switch (2026-10-05): System / Light / Dark instead of OS-only dark.
  - `src/App.css`: dark tokens moved from `@media (prefers-color-scheme: dark)` to `:root[data-theme="dark"]`, plus `color-scheme` so scrollbars and native controls follow.
  - `index.html` inline script sets `data-theme` before first paint (no light flash). `src/lib/theme.tsx`: `useTheme` (state in `App`, layout effect sets the attribute before the graph canvas reads `--panel`, follows OS changes in System mode, `getCurrentWindow().setTheme` themes the native title bar), `ThemeButton` (cycles, Solar sun/moon/monitor icons), `themeCommands` for the palette.
  - Choice is kept in `localStorage`, not `tauri-plugin-store`: the pre-paint script must read it synchronously. Capability `core:window:allow-set-theme` added.
  - Button on the home brand row and in the repo toolbar; palette lists "Theme: …".
  - Verified: `tsc` + `npm run build` OK. Not yet clicked in `tauri dev`.

- macOS look (2026-10-05, frontend only): replaces the acid-lime "instrument panel" palette.
  - `src/App.css` tokens: macOS window/content/sidebar surfaces (`--rail`, `--pick`), hairline rgba separators, system blue accent (#007aff / #0a84ff dark), Apple system greens/oranges/reds. SF Pro / SF Mono first in the font stacks, Segoe/Cascadia as fallback on Windows.
  - Controls: push buttons with hairline shadow instead of borders, gradient default (primary) button, darken on press (no scale), default cursor, soft accent focus halo, inset text fields, grey rounded search wells, thin overlay scrollbars.
  - Lists: Finder-style sidebar (grey pill selection, accent icon, sentence-case section headers; all uppercase headers gone). File lists, commit table and palette rows use accent-fill selection with white text (selected HEAD ref chip inverted). Fetch/Pull/Push is one segmented control.
  - Palette is Spotlight-like (frosted `backdrop-filter`, 1.55rem light input, no backdrop dim); update toast is a frosted notification. Graph lanes use macOS system colors (`CommitGraph.tsx` `COLORS`).
  - Verified: `npm run build` OK; headless Edge screenshots of home in light and dark. Repo views not re-screenshotted (needs the IPC mock harness), not clicked in `tauri dev`.
  - Skipped: native vibrancy (`windowEffects` sidebar/mica + transparent window), faked traffic lights (wrong on Windows/Linux), unfocused-grey selection.
- Sidebar header fix (2026-10-05): repo name and branch chip overlapped. `src/App.css`: `.repo-id` gets `gap: 0.2rem`, repo name and `.branch-chip` get line-height 1.3.
- Toolbar buttons (2026-10-05): Fetch/Pull/Push and Commands get top-lit gradient backgrounds per theme (`--tool`, `--tool-hover`, `--tool-lit`, `--tool-edge` in `src/App.css`). Pull/Push show behind/ahead as accent `.count` pills (`Remote.tsx`), only when > 0.
- All push buttons (2026-10-05): one dark top-lit gradient with white text in both themes (`button` uses `--tool*` tokens, defined once in `:root`; `--btn`/`--btn-edge` removed). Transparent row buttons (`.recent`, `.files .row`, `.views`, `.icon-btn`) keep inheriting text color. Primary buttons stay blue.
- Bold labels (2026-10-05): one `font-weight: 700` rule at the end of `src/App.css` for column headers, section/list headings, sidebar and history summaries, commit-info terms, clone form labels. Graph header cells no longer pick up the `.c-oid` mono font from their column classes. Nested branch-folder summaries stay 500 mono.
- Release v0.1.0 (2026-10-05): repo secret `TAURI_SIGNING_PRIVATE_KEY` added on GitHub; tag `v0.1.0` pushed to start `release.yml`. Next: publish the draft, install it, then cut v0.1.1 to test the update banner.
- Release v0.1.1 (2026-10-05): version bumped in `package.json`, `package-lock.json`, `tauri.conf.json`, `Cargo.toml`, `Cargo.lock`; tag `v0.1.1` pushed. v0.1.0 published and installed. Test: publish the v0.1.1 draft, open the installed 0.1.0, expect the update banner.
- Auto-update verified (2026-10-05): installed 0.1.0 showed the 0.1.1 banner, Install & restart came back as 0.1.1. Week 12 done end to end.
- Initial window size (2026-10-05): 1280x800 logical overflowed the screen under display scaling (bottom hidden behind the taskbar). `fit_to_work_area` in `src-tauri/src/lib.rs` shrinks the window to at most 90% of the monitor work area at startup and centers it; `center: true` in `tauri.conf.json`.
- Graph speed (2026-10-06): `big_graph` test in `src-tauri/src/git/graph.rs` (`#[ignore]`) builds a 100k-commit repo with `git fast-import` (main + a 3-commit topic merged every 50) and times `rows`. Release build: first page (revwalk + layout + 500 rows) 0.77 s, cached page at offset 60k 6 ms. Good enough; the commit-graph-file upgrade noted in `compute` is not needed yet. Run: `cargo test --release --manifest-path src-tauri/Cargo.toml big_graph -- --ignored --nocapture`.
  - Not measured: wide graphs (many parallel lanes; layout is O(lanes) per row), frontend scroll fps on the 100k list.

## Next
- Click through weeks 2–11 in `tauri dev`; try askpass with an HTTPS remote without GCM and an SSH key with a passphrase; clone a real HTTPS repo to see the progress line; check no shortcut clashes with WebView2/WKWebView defaults.
- Create a GitHub OAuth app (enable device flow), run with `GITAI_GITHUB_CLIENT_ID=<id>`, sign in, push to an HTTPS remote with GCM off (`git config --global --unset credential.helper` in a test profile).
- Installer code signing (Authenticode, Apple notarization).
- v1 start: AI commit message from the staged diff (Gemini 3.5 Flash Lite, key from keychain / `GEMINI_API_KEY`, skip binary + >1 MB files).
