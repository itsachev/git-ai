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
- **Run/build:** not scaffolded yet.

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
- Initialized git repo (`main` branch), added `.gitignore` (node, dist, Rust target, env, OS/IDE files), initial commit.
- **Next:** Week 1 — Tauri scaffold, CI on 3 OSes, safe git runner, open repo, recent repos.
