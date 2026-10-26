# Changelog

What's new in each git-ai release. Newest first.

## [Unreleased]

### Added

- Right-click a changed file to stage it or discard its changes, or a staged file to unstage it. With several files selected, it acts on all of them.

### Changed

- The selected repo tab is now filled with the app's accent colour, so it's easy to tell which repo you're in.
- Commit with Push ticked on a branch that isn't on the remote yet now opens the Push dialog first, like the Push button, so you can pick the remote, the branch name there and whether to track it. The commit happens when you click Push; Cancel commits nothing. Branches already on the remote still commit and push straight away.
- Entrance animations are quicker: opening a repo, the home screen and the shortcuts page settle in about half the time.
- Right-clicking the branch you're on now shows Switch / Checkout greyed out ("Already on …") instead of leaving it out, so the menu keeps the same layout for every branch.
- In History, the label of the branch you're on is now bold and always the highlighted one, even when other branches or tags point at the same commit. Branch labels are also a little taller.
- Dialog buttons now appear right away instead of sliding in after the dialog opens.
- The shifting colours on the git-ai name now play only on the home screen, so the app does less work while it sits idle.
- Long lines in diffs now wrap inside the pane instead of scrolling sideways, in both unified and side-by-side views. Wrapped text lines up after the line numbers. Very large diffs (over 1,500 lines) still scroll sideways.

## [0.3.0] - 2026-10-24

### Added

- Push now opens a dialog first: pick the remote and the branch name there, choose whether to track it, push all tags, or force push. Push after commit still pushes straight away.
- Right-click an entry in Undo history to undo it or delete it from the history (its backup is removed too).
- Confirmation and input dialogs now show the git command they run (like Push, New branch and Stash already did): merge, rebase, reset, revert, delete branch or tag, rename, track, remotes, stashes, discard, abort, undo, interactive rebase, Git LFS and Clone. Dialogs with several options show the command under each one.
- Undo history now records every action. Commits, pushes, new branches and new tags can be undone: undoing a commit keeps its changes staged, and undoing a push puts the remote branch back where it was (or removes it if the push created it). Switching branches, fetching, stashing, renaming branches, remote and upstream changes, ignoring files and pushing tags are listed too, for reference.

### Changed

- Undo history now keeps actions for two weeks instead of 30 days. Older ones leave the list and their backup copies are released so Git can free the space.
- Right-click menus have a cleaner look: the item under the pointer gets a tinted highlight, and delete or reset actions sit apart in red below a single divider.
- Dialogs have a calmer, more refined look: frosted glass over a lightly blurred page, soft depth, a diagonal colour gradient across the background, a gradient stripe along the top, a frosted header, a quiet tinted icon, settings-style switch rows grouped into one card, and a lighter button bar. Dialog buttons and switches have gradient fills and animated hover effects: a lift, a glow, and a light sweep across the main button.
- While a merge or rebase is paused on conflicts, Undo is greyed out too (undo history, the Undo bar and the command palette), since undoing then would tangle with the paused operation.

### Fixed

- Scrollbars no longer run into the rounded corners of panels, lists and cards: every scrollbar now stops short of the corners at both ends.
- The Remove repository dialog keeps its three buttons on one row, and stacks them neatly on narrow windows instead of dropping "Delete from disk" onto a line of its own.
- Pushing a tag that the remote already has on a different commit no longer says to pull first. It now asks whether to replace the remote's tag (force push). With no remote set up yet, it asks for one first, like Push does.
- Right-click menus near the bottom or right edge of the window now open above or beside the pointer instead of covering it, and long branch or file names in them end in "…" instead of spilling out of the menu.
- The button bar at the bottom of dialogs now reaches the dialog's right edge instead of stopping a little short.
- Dialogs with nothing between their title and buttons, like Explain stash, no longer show an empty strip there.
- In confirmation dialogs (like Delete remote branch) the title's icon no longer touches the edge of the strip behind it.
- The coloured line along the top of dialogs now follows their rounded corners instead of ending in a square notch.

## [0.2.0] - 2026-10-19

### Added

- Zoom the whole app with Ctrl + and Ctrl − (⌘ on macOS) or Ctrl + mouse wheel; Ctrl 0 resets it. The zoom level is remembered.

### Changed

- Pushing a branch that isn't on the remote yet now says so when it finishes: "Created and pushed to branch origin/…".
- Opening History, or switching branches while it's open, now selects the current branch's newest commit and scrolls the commit list to it. The sidebar scrolls the current branch into view too.
- Double-clicking a local branch (or right-click → Switch / Checkout) switches to it straight away again, even when its remote has newer commits. To bring those in, check out the remote branch or use Switch / Checkout origin/… in the branch's menu.
- Checkout is now called Switch / Checkout everywhere (branch menus, graph labels, command palette).
- "Create pull request" is now "Create pull/merge request" everywhere, since it opens a merge request on GitLab.
- Switching branches stops whenever you have uncommitted changes, and asks whether to bring them along or stash them. Before, changes that didn't clash were moved to the other branch without a word.
- Dialogs have a new look: a warm tinted sheet instead of plain white, a coloured header with a dot pattern, and a shelf at the bottom for the buttons. Options in choice dialogs carry a gradient in their own colour (blue for safe, orange for careful, red for destructive) that brightens on hover. Buttons are flatter and crisper, with clearer main and danger actions.
- Branch names are highlighted the same way in every dialog and notification (local branches in the accent colour, remote ones in blue), including dialog titles, option labels and the messages after an action finishes.
- While a merge, rebase, cherry-pick or revert is paused on conflicts, actions that can't run until it's finished or aborted (Pull, Push, Stash, New branch, Switch / Checkout, Merge, Rebase, Reset, Cherry-pick, Revert, applying stashes) are greyed out, with a note saying why. Fetch still works.
- Repository tabs have a new look: each tab fills the whole tab bar with clear edges, and gets its own colour so you can tell repos apart at a glance.

### Fixed

- Aborting a rebase or merge no longer leaves File Status blank (toolbar, file list and diff all missing until the app was reloaded).
- Aborting a merge or rebase while a conflicted file was open no longer marks that file as resolved and stages it.
- The progress notification at the bottom ("Pushing … to origin/…") no longer breaks into narrow, letter-wrapped columns when it shows branch names.
- Push, pull and fetch over HTTPS no longer hang forever when the connection drops: after a minute with nothing getting through, they stop with a "connection stalled" message and a Try again button.
- Checking out a remote branch that has no local copy now asks first, and says when the new local branch is created.
- Choice dialogs no longer misplace the arrow on options without an icon, and show options in two columns when the window is wide enough.
- Undo history no longer offers an Undo button that always fails on steps that can't be reversed again (undoing a dropped stash, a deleted remote branch or a force push).

## [0.1.0] - 2026-10-17

First release. Windows only for now: macOS and Linux installers will follow once the macOS app is code-signed and the Linux build is tested.

### Added

- The home screen's recent list shows each repository's current branch, with how many commits are waiting to push (↑) and to pull (↓).
- Compare labels both sides of the diff: in Split view each column is headed with what it shows (for example your commit on the left, origin/main on the right), and the single-column view shows which side the − and + lines come from.
- Compare puts the older side on the left: when the second pick is behind the first (for example origin/main next to your unpushed commits), the two are swapped, so + really means added and − removed. ⇄ still swaps them back.
- Compare lives in right-click menus: Compare with another branch (or "Compare with a branch" on tags and commits) in the sidebar or in History (now including the current branch, which starts against its remote branch: what you haven't pushed or pulled). The Compare… button under commit details is gone.
- Right-click menus are redesigned: an option's text lights up in an accent gradient as you point at it, and destructive ones (Reset, Delete, Discard, Drop, Force push) sit together at the bottom in red. A thin line separates every option. Options are written out in full instead of ending in "…", and the arrow keys, Home and End move between them.
- **Feature tour after first-run setup:** the last setup step invites you to see everything git-ai can do. Show me the superpowers opens the feature list; Skip the tour goes straight to the app.
- **Delete the remote branch too:** when you delete a local branch that also exists on the remote, the confirm box has an "Also delete … on the remote" checkbox, so both go in one step. Deleting a remote branch works the same way: an "Also delete local branch …" checkbox removes your local copy with it (not offered for the branch you're on).
- Branch names in delete confirmations are bold and colored: local in teal, remote in blue.
- **Refreshed repository view:** File Status and History get a cleaner look.
  - The toolbar says where you stand, for example "4 changes on main · 2 to push", and Push lights up when you have commits to push.
  - After a discard, branch delete or other risky step, a strip under the toolbar keeps it one click from undone for 30 minutes.
  - The commit box shows the exact git command it will run.
  - The selected file is highlighted without hiding its colors, and the diff header shows how big the change is.
- **Push after commit:** a Push toggle under the commit message pushes your branch as soon as the commit lands. git-ai remembers your choice. The Commit button says so, for example "Commit 3 files & push". A rejected push offers the same choices as the toolbar's Push button.
- **Push and pull counts on repository tabs:** each tab shows how many commits its current branch has to push (↑) and pull (↓). The open tab updates live. Other tabs keep the counts from when you last viewed them.
- **Auto fetch:** git-ai checks the remote for new commits on your current branch when you open a repository, every 5 minutes, and when you come back to the window. Pull counts stay up to date without pressing Fetch. It only fetches your branch, so big repositories stay fast. It never asks for a password, and failures (offline, signed out) stay silent.
- **Compare branches and commits:** see every file that differs between two branches, tags, commits or your working copy, with each file's diff. "Only what it added" starts from where the two split, like a pull request, so it answers "what does this branch have that main doesn't?". Open it from a branch or tag menu (Compare with …), the Compare button on a commit, Ctrl+click on a second commit in History, or "Compare branches…" in the command palette.
- **Side-by-side diffs:** the Split button on any diff shows the old version on the left and the new one on the right. You can still pick lines to stage in File Status.
- **Ignore whitespace:** a button on any diff hides changes that only add or remove spaces and tabs, so re-indented code shows only its real changes. Turn it off to stage single lines. Both choices are remembered.
- **Recover lost commits:** a list of every place your branch pointer has been (commits, checkouts, resets, rebases), also ones done in a terminal. Commits no branch has anymore are marked Lost; pick one to see its changes, then "Branch from here" brings it back. Open it from the clock button on Undo history in the sidebar, or "Recover lost commits…" in the command palette.
- **Submodules:** repositories with submodules list them in the sidebar, marked when one isn't cloned yet or needs an update. Update one or all of them, or open one in its own tab. Cloning now brings submodules along.
- **Find any file's history from Ctrl+K:** type part of a file name in the command palette and pick the file to open its history and blame. You no longer need to find a commit that changed it first.
- **Choose what History search looks at:** a menu next to the search box picks All, Message, Author, Commit id, or File or folder. With File or folder, type part of a path (for example `App.tsx` or `src/lib`) to highlight every commit that changed it.
- **See who you commit as:** the status bar at the bottom of a repository shows the name and email your commits in that repository will carry.
- **Open tabs come back:** repositories you had open in tabs reopen the next time you start git-ai, on the tab you were last using.
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

### Changed

- Dialogs that ask you to pick a way forward now list the options as cards with an icon and an arrow, and the suggested one stands out. When your branch is behind its remote, the Push dialog draws the gap: your branch, the commits only the remote has, then the remote branch.
- Sidebar section headings, branch, remote and tag names, and the status bar's version and identity line now use the same typeface as the rest of the interface.
- The current branch in the sidebar now stands out as a card with an accent wash, with its ahead/behind counts shown as small badges.
- The light theme has more depth and warmth: a stone backdrop with a soft accent glow, a lightly tinted sidebar, and panels that sit on it as raised cards instead of one flat white sheet. The home screen artwork now sits on the same warm, glowing backdrop instead of a white wash.
- Dialogs fit their content. Confirmations, errors and password prompts are small, focused boxes instead of stretching across most of the window. Settings, About, file history and other big views keep their large size.
- **Feature search in About:** the "Find a feature" box now sits in the dialog's header, so it is visible right away and stays in reach while you scroll.
- **New app icon:** a dark tile with a teal branch-and-merge glyph replaces the default Tauri logo in the taskbar, Start menu, Dock and installer.
- **Redesigned commit box:** the message and its tools (Generate, Amend, Push) now sit in one field. Amend and Push are toggle chips. A full-width Commit button names exactly what will happen and shows the keyboard shortcut.
- **Easier-to-read status bar:** the Git and Node versions, your commit identity and the Commands button use larger, darker text. "Commands" is now bold.
- **Big diffs open instantly:** diffs, file history and blame of long files (thousands of lines, such as lock files) show at once and scroll smoothly. Before, a 25,000-line diff froze the window for over a second.
- **Calmer dark theme:** text no longer glares white everywhere. Titles, commit subjects and the current branch stay bright; body text is a soft parchment, and dates, authors, hashes and labels step back. Easier to scan, easier on the eyes.
- **Coloured toolbar icons:** Fetch and Pull, Push, Stash and Branch each have their own icon colour, so you can find them at a glance.
- **Colourful feature names in About:** each feature name in the About dialog now shows in its area's colour, with a small marker in front, so the list is no longer a wall of white.
- **Tidier Clone and Create buttons:** on the home screen their titles now sit next to their icons.
- **Commit title in colour:** the selected commit's title in the details pane fades from your accent colour into white.
- **Push works before you have a remote:** in a repository with no remote yet, Push asks for the repository URL, adds it as origin, and pushes your branch there. Push stays greyed out when there's nothing new to send, including a fresh branch that still matches a branch on the remote you push to. Pull is greyed out, with the reason, when your branch doesn't track a remote branch yet.
- **Revert any commit:** Revert in commit details now works on commits from other branches too, not only the current one.
- **Themed hover hints:** the hints that appear when you hover a button now match the app's light or dark theme, instead of the plain system box. Greyed-out buttons say why when you hover them: nothing to stash, no search matches, a field still empty, already explained, and so on.
- **Greyed-out menu items say why:** in a branch's menu, an option you can't use right now shows the reason underneath it, instead of in a plain pop-up you had to hover for.
- **Better-looking dropdowns:** on Windows, every dropdown opens as a soft, translucent menu that matches the rest of the app, with group headings for branches, remote branches and tags, a highlight on the option you're pointing at and a check next to the current choice. They still work fully from the keyboard.
- **Syntax colours for many more languages:** diffs now colour nearly every programming language, about 190 in all (Elixir, Haskell, Scala, Dart, PowerShell, Clojure and more), plus Vue, Svelte and Astro components. Rarer languages load the first time you open such a file.
- **Ask before risky actions:** resetting a branch (after you pick Soft, Mixed, Keep or Hard), recreating a branch from its remote, merging or rebasing from a menu or by dragging a branch, force pushing, and undoing now each ask you to confirm first.
- **Merge commits read at a glance:** in commit details, the merged branch name shows in a color gradient and the branch it went into in the accent color.
- **Current branch stays in view:** in the sidebar's branch list, your current branch stays stuck at the top while you scroll through the others.
- **Blame opens at the commit you picked:** in a file's history, switching to Blame scrolls to the first lines that the selected commit last changed. Clicking a commit in Blame scrolls the History list to it.
- **Undo history keeps 30 days:** operations older than 30 days leave the undo list, and the backup copies kept for them are released so Git can free the disk space.
- **Roomier Settings, About and File history on big screens:** they open at 80% of the window, and Settings lays its sections out two by two with paired fields side by side. Small windows keep the stacked layout.

### Fixed

- Push no longer greys out after you move a branch back to an older commit (for example a reset or a rebase onto an older commit). It asks whether to force push, so the remote moves back too, or to pull instead when someone else pushed.
- Checking out a local branch (right-click → Checkout or double-click) that is behind its remote now asks what to do: bring in the remote commits, recreate the branch from the remote, switch as is, or start a new branch. Before, it switched without asking.
- The window no longer flickers or jumps when the app starts. It now appears once, at its final size and position.
- Compare with "Only what … added" on no longer claims both sides are the same when the other branch simply has nothing new (for example origin/main when you have unpushed commits); it says so and points to how to see your own changes.
- The scrollbars in the diff and commit graph no longer run into the panel's rounded corners.
- In a narrow commit details panel, the last action button (such as Explain) no longer stretches across a row by itself.
- Buttons with a keyboard shortcut now show it on hover: Fetch, Pull, Push, File Status, History, the branches menu, Stage all, Commit, commit search and Keyboard shortcuts in Settings.
- The author picture on the selected commit no longer has its outline cut off on one side.
- Scrollbars in dialogs no longer stick out past their rounded corners.
- **Settings side list stays put:** scrolling the Settings window no longer nudges the section list on the left before it settles.
- Names of repository tabs you are not on now sit centred in the tab bar instead of slightly low.
- **Every graph dot names its branch:** hovering a commit that came in through a merge (including `git pull` merges) now shows the branch it was merged into, and dots far down the history show their branch too.
- Big headings on the home screen and the Keyboard shortcuts page are smaller and no longer clip the edges of letters such as "y" and "e".
- Error messages from Git hooks (such as lefthook or commitlint) no longer show garbled symbols like `[38;2;56;56;56m` where the hook used terminal colours.
- A finished notice like "Fetched all remotes" no longer pops up again each time you switch between open repositories.

[Unreleased]: https://github.com/itsachev/git-ai/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/itsachev/git-ai/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/itsachev/git-ai/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/itsachev/git-ai/releases/tag/v0.1.0
