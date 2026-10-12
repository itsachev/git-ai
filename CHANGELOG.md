# Changelog

What's new in each git-ai release. Newest first.

## [Unreleased]

### Added
- **Portable Windows app.** Every release now includes `git-ai_<version>_x64-portable.exe`. It runs from any folder without installing.
- **Select several files at once in File Status.** Use Ctrl+click, Shift+click, Ctrl+A, or drag over the rows. Stage, Unstage and Discard then act on all the selected files.

### Changed
- **Easier-to-scan file lists.** File Status lists now have a thin line between files.
- **Counters stand out.** Every count badge (changed files, branches, remotes, tags, stashes, undo history) is now filled in the accent colour.

### Fixed
- **Big repositories no longer freeze the app.** Opening a repo with a long history and thousands of tags or remote branches could hang the window for minutes. It now opens in about a second.
- **Faster branch switching.** The window stays responsive during a switch, and the app refreshes once afterwards instead of several times.
- **Faster History.** On a repo with 85,000 commits, the commit graph loads about 3× faster (1.7 s → 0.5 s). Clicking a commit that isn't on your current branch now opens instantly (it took almost a second before).

## [0.2.0] - 2026-10-10

### Added
- **AI built in.** Write a commit message from your changes, explain a commit, a branch or a stash, draft a pull request description, write a changelog since a tag, and get help resolving merge conflicts. Choose your AI provider in Settings.
- **Pull requests.** Create GitHub pull requests and GitLab merge requests from the branch menu, with an AI-written description.
- **GitLab sign-in**, alongside GitHub. When you clone, pick from a list of your GitHub and GitLab repos.
- **Interactive rebase** from any commit in History. Reorder commits by dragging them or with ▲/▼, and reword, squash, fixup or drop them.
- **File history and blame** from any file in a commit.
- **Search commits** in History (Ctrl+F): by message, author, email or commit id.
- **History options:** show all branches or just the current one, show or hide remote branches, and sort by date or by ancestry.
- **Drag and drop a branch** onto another to merge or rebase.
- **Reset from a commit's menu:** soft, mixed, keep or hard.
- **Switch branches with uncommitted changes:** bring them along, or stash them and switch.
- **Stash button** in the toolbar.
- **Git LFS** dialog for tracking large files.
- **Conflict tools:** keep mine, keep theirs, or keep both sides. Open the file in your editor, and finish the merge from the conflict bar.
- **Command palette shows the git command** behind each action, so you can learn the terminal equivalent.
- **First-run setup**, an **About** guide to every feature, a choice of **SSH key** in Settings, and a right-click menu for recent repos (remove from the list, or move to the trash).

### Changed
- New look: dark theme by default, the Geist typeface, an animated home screen, and redesigned File Status, commit details and Settings.
- Pull is now a split button, so you can see the Pull with rebase option.
- Clearer error messages that suggest the likely fix (for example when a push is rejected). A rejected push offers a safe force push (with lease).

### Fixed
- A "bring changes" branch switch that clashes now cancels cleanly and leaves your changes where they were. Before, it left conflict markers in your files.
- Line-ending (CRLF) conflicts, and a clash when creating a new branch.
- Gemini API keys were wrongly blamed for every request error.

## [0.1.1] - 2026-10-05

### Changed
- Maintenance release that tests the in-app auto-update.

## [0.1.0] - 2026-10-05

First release.

### Added
- File Status: stage and unstage files, hunks or single lines, discard changes (with backup), commit and amend.
- Commit graph and History view.
- Branches, tags and stashes in the sidebar. Merge and cherry-pick.
- Undo for destructive operations.
- Fetch, pull and push, clone with progress, and a conflict view.
- GitHub sign-in. The token is kept in your OS keychain.
- Keyboard shortcuts and a command palette.
- Auto-update, and a System/Light/Dark theme switch.

[Unreleased]: https://github.com/itsachev/git-ai/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/itsachev/git-ai/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/itsachev/git-ai/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/itsachev/git-ai/releases/tag/v0.1.0
