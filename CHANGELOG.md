# Changelog

What's new in each git-ai release. Newest first.

## [Unreleased]

## [0.1.1] - 2026-10-13

First release. Windows only for now: macOS and Linux installers will follow once the macOS app is code-signed and the Linux build is tested.

### Added
- **File Status:** stage and unstage files, hunks or single lines, and discard changes (with a backup). Commit and amend. Select several files at once with Ctrl+click, Shift+click, Ctrl+A or by dragging. A greyed-out Commit button tells you why on hover.
- **History:** a commit graph that stays fast on repositories with 100,000+ commits. Search commits (Ctrl+F), show all branches or just the current one, show only a branch's own commits, and hover a graph dot to see its branch.
- **Several repositories at once, in tabs** (Ctrl+T, Ctrl+Tab, Ctrl+W).
- **Branches, tags and stashes** in the sidebar, with the current branch pinned on top. Merge, rebase (also by dragging one branch onto another), cherry-pick, revert and reset. Merge and Revert ask first. Switch branches with uncommitted changes by bringing them along or stashing them.
- **Interactive rebase:** reorder commits, and reword, squash, fixup or drop them.
- **Undo** for destructive operations.
- **Fetch, Pull and Push** with a live progress card. Pull remembers merge or rebase. A rejected push offers a safe force push (with lease). Push is greyed out when there is nothing to push, no branch is checked out, or the repository has no remote.
- **Clone** with progress, picking from your GitHub and GitLab repositories after you sign in. Sign-in tokens are kept in your OS keychain.
- **AI built in (bring your own key):** write commit messages, explain a commit, branch or stash, draft pull request descriptions, write a changelog since a tag, and get help resolving merge conflicts.
- **Pull requests:** create GitHub pull requests and GitLab merge requests from the branch menu.
- **Conflict tools:** keep mine, keep theirs or keep both sides. Open the file in your editor, and finish the merge from the conflict bar.
- **Diffs** with syntax colours, file-type icons, file history and blame, and comparing a file between any two branches or tags.
- **Stashes:** a toolbar button, and see what a stash holds.
- **Git LFS** dialog for tracking large files.
- **Command palette** (Ctrl+K) that shows the git command behind each action, a keyboard shortcuts page (Ctrl+/), and Open in terminal.
- **Your look:** System, Light or Dark theme and seven app colors.
- **Auto-update**, first-run setup, an About guide to every feature, SSH key choice, and Git and Node versions in the status bar.
- **Portable Windows app:** `git-ai_<version>_x64-portable.exe` runs from any folder without installing.

[Unreleased]: https://github.com/itsachev/git-ai/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/itsachev/git-ai/releases/tag/v0.1.1
