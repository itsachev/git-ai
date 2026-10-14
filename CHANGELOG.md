# Changelog

What's new in each git-ai release. Newest first.

## [Unreleased]

### Added
- **Find any file's history from Ctrl+K:** type part of a file name in the command palette and pick the file to open its history and blame. You no longer need to find a commit that changed it first.
- **Choose what History search looks at:** a menu next to the search box picks All, Message, Author, Commit id, or File or folder. With File or folder, type part of a path (for example `App.tsx` or `src/lib`) to highlight every commit that changed it.
- **See who you commit as:** the status bar at the bottom of a repository shows the name and email your commits in that repository will carry.
- **Open tabs come back:** repositories you had open in tabs reopen the next time you start git-ai, on the tab you were last using.

### Changed
- **Calmer dark theme:** text no longer glares white everywhere. Titles, commit subjects and the current branch stay bright; body text is a soft parchment, and dates, authors, hashes and labels step back. Easier to scan, easier on the eyes.
- **Coloured toolbar icons:** Fetch and Pull, Push, Stash and Branch each have their own icon colour, so you can find them at a glance.
- **Commit title in colour:** the selected commit's title in the details pane fades from your accent colour into white.
- **Better-looking dropdowns:** on Windows, every dropdown opens as a soft, translucent menu that matches the rest of the app, with group headings for branches, remote branches and tags, a highlight on the option you're pointing at and a check next to the current choice. They still work fully from the keyboard.
- **Syntax colours for many more languages:** diffs now colour nearly every programming language, about 190 in all (Elixir, Haskell, Scala, Dart, PowerShell, Clojure and more), plus Vue, Svelte and Astro components. Rarer languages load the first time you open such a file.
- **Ask before risky actions:** resetting a branch (after you pick Soft, Mixed, Keep or Hard), recreating a branch from its remote, merging or rebasing from a menu or by dragging a branch, force pushing, and undoing now each ask you to confirm first.
- **Merge commits read at a glance:** in commit details, the merged branch name shows in a color gradient and the branch it went into in the accent color.
- **Current branch stays in view:** in the sidebar's branch list, your current branch stays stuck at the top while you scroll through the others.
- **Blame opens at the commit you picked:** in a file's history, switching to Blame scrolls to the first lines that the selected commit last changed. Clicking a commit in Blame scrolls the History list to it.
- **Undo history keeps 30 days:** operations older than 30 days leave the undo list, and the backup copies kept for them are released so Git can free the disk space.
- **Roomier Settings, About and File history on big screens:** they open at 80% of the window, and Settings lays its sections out two by two with paired fields side by side. Small windows keep the stacked layout.

### Fixed
- The author picture on the selected commit no longer has its outline cut off on one side.
- Scrollbars in dialogs no longer stick out past their rounded corners.
- **Settings side list stays put:** scrolling the Settings window no longer nudges the section list on the left before it settles.
- Names of repository tabs you are not on now sit centred in the tab bar instead of slightly low.
- **Every graph dot names its branch:** hovering a commit that came in through a merge (including `git pull` merges) now shows the branch it was merged into, and dots far down the history show their branch too.
- Big headings on the home screen and the Keyboard shortcuts page are smaller and no longer clip the edges of letters such as "y" and "e".
- Error messages from Git hooks (such as lefthook or commitlint) no longer show garbled symbols like `[38;2;56;56;56m` where the hook used terminal colours.
- A finished notice like "Fetched all remotes" no longer pops up again each time you switch between open repositories.

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
- **Stashes:** stash everything, tracked files only, staged only or just the files you pick, under a name you choose, or save a checkpoint that keeps your changes in place. A notice confirms what was stashed. See what a stash holds, rename it, or turn it into a branch. Apply and Pop bring back what was staged too.
- **Git LFS** dialog for tracking large files.
- **Command palette** (Ctrl+K) that shows the git command behind each action, a keyboard shortcuts page (Ctrl+/), and Open in terminal.
- **Your look:** System, Light or Dark theme and seven app colors.
- **Auto-update**, first-run setup, an About guide to every feature, SSH key choice, and Git and Node versions in the status bar.
- **Portable Windows app:** `git-ai_<version>_x64-portable.exe` runs from any folder without installing.

[Unreleased]: https://github.com/itsachev/git-ai/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/itsachev/git-ai/releases/tag/v0.1.1
