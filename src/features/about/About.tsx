import { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "../../lib/icons";
import { Brand, ModalHead } from "../../lib/modal";

/** [name, where to find it, what it is for and what it does]. */
type Feature = [string, string, string];

// Keep in step with the app: add an entry here after every feature passes its click-through (see CLAUDE.md).
const FEATURES: [IconName, string, Feature[]][] = [
  ["folder", "Repositories", [
    ["Open a repository", "Home → Open repository", "Pick any folder that contains a .git folder. It is added to Recent, so next time it is one click away."],
    ["Create a repository", "Home → Create", "Starts a new, empty repository in a folder you pick (the folder is made if needed) and opens it."],
    ["Clone", "Home → Clone", "Copies a repository from a URL into a folder you choose, with live progress. Signed in to GitHub or GitLab, pick one of your own repos from a list instead of pasting the URL."],
    ["Recent repositories", "Home → Recent", "Every repository you have opened, with a filter box. Folders that were deleted or moved outside the app are flagged."],
    ["Remove from the list", "Right-click a recent repo, or its ⋯ button", "Takes the repository off the list, or also moves its folder to the Recycle Bin / Trash. You are warned first, because unpushed work goes with the folder."],
    ["GitHub sign-in", "Home → Sign in to GitHub", "Connects your GitHub account so you can clone your repos from a list and create pull requests. The token stays in your OS keychain."],
    ["GitLab sign-in", "Home → Sign in to GitLab", "Connects your gitlab.com account so you can clone your projects from a list, push without typing a password and create merge requests. The token stays in your OS keychain and renews itself."],
  ]],
  ["changes", "File Status", [
    ["See what changed", "File Status tab · Ctrl+1", "Lists your Staged files, unstaged Changes and Conflicts, and shows the diff of the file you click. Refreshes by itself the moment anything changes on disk."],
    ["Stage and unstage", "Stage / Unstage on a file, Stage all · Ctrl+Shift+S", "Staging picks which changes go into the next commit. Unstage takes a file back out without losing the edit."],
    ["Stage hunks or single lines", "In the diff: Stage hunk, or click lines → Stage lines", "Commit only part of a file: one block of changes, or exactly the lines you picked. Unstage and discard work the same way."],
    ["Discard", "Discard on a file, Discard all, or per hunk / lines", "Throws away uncommitted edits to get back to the last commit. The content is backed up first, so Undo can bring it back."],
    ["Commit", "Commit box under the file lists · Ctrl+Enter", "Saves the staged changes as a new commit with your message: a snapshot you can always come back to."],
    ["Amend the last commit", "Commit box → Amend last commit", "Fixes the most recent commit instead of adding a new one: correct its message or add a forgotten file. Recorded, so it can be undone."],
    ["AI commit message", "Commit box → Generate message · Ctrl+Shift+M jumps to the box", "The AI reads your staged diff and writes the commit message for you to review. Needs AI set up in Settings."],
    ["Ignore files", "Ignore on an untracked file", "Adds that file, every file with its extension, or its folder to .gitignore, so git stops listing them. Commit .gitignore like any file."],
    ["Large and binary files", "Automatic", "No inline diff for binary files or files over 1 MB, and LFS pointer files show as files, so big repositories stay fast."],
    ["Git LFS", "Ctrl+K → Git LFS… · or Track *.ext with Git LFS… under a big file", "Stores large files on the LFS server and keeps small pointers in the repository. Track or untrack file patterns, and download LFS files that still show as pointers."],
  ]],
  ["history", "History", [
    ["Commit graph", "History tab · Ctrl+2", "Every commit, with lanes that show where branches split and merge, and branch and tag labels. Arrow keys and Page Up / Down move the selection. Fast on 100k+ commits."],
    ["History options", "Options above the graph", "Show all branches or just the current one, hide or show remote branches, and sort by date or ancestor order."],
    ["Commit details", "Click a commit", "Its message, author, date, parent commits, the files it changed and each file's diff."],
    ["Cherry-pick", "Click a commit → Cherry-pick", "Copies that one commit's change onto your current branch as a new commit. Use it to bring a single fix over from another branch without merging everything else."],
    ["Revert a commit", "Click a commit on your branch → Revert", "Adds a new commit that undoes that one's change, without rewriting history, so it is safe on shared branches. Recorded, so it can be undone."],
    ["Reset branch to a commit", "Right-click a commit → Reset to here…", "Moves your branch back (or forward) to that commit. Soft keeps the changes staged, Mixed keeps them as edits, Keep updates files but leaves your edits, Hard makes files match the commit. Undo history can reverse it; a hard reset backs up your edits first."],
    ["Merge a commit", "Click a commit → Merge into current", "Brings that commit, and everything before it, into the branch you are on."],
    ["Tag a commit", "Click a commit → Tag…", "Gives the commit a permanent name such as v1.2, usually to mark a release."],
    ["Interactive rebase", "Click a commit → Rebase from here…", "Tidies up the commits after it before you share them: reorder them, edit messages, squash or fixup several into one, or drop one."],
    ["Explain a commit (AI)", "Click a commit → Explain", "A plain-words summary of what the commit does and why. Its message and diff are sent to your AI provider."],
    ["File history and blame", "Commit details → History next to a file", "Every commit that touched the file, with its diff, and Blame: who last changed each line and in which commit."],
    ["Labels in the graph", "Right-click a branch or tag label", "The same menu as the sidebar, right where you see the label: checkout, merge, rebase onto it, branch from it and more."],
    ["Commit menu", "Right-click any commit row", "The label's menu, or for a commit without one: new branch from it, merge it, rebase onto it, reset to it. Actions that would do nothing are greyed out."],
  ]],
  ["branch", "Branches, tags and stashes", [
    ["Sidebar", "Always visible on wide windows · Ctrl+B or ☰ on narrow ones", "Local and remote branches, tags, stashes and undo history, with a filter. ↑ and ↓ counts show commits waiting to be pushed or pulled."],
    ["Check out a branch", "Double-click a branch, right-click → Checkout, or Ctrl+K → Checkout", "Switches your files to that branch. Uncommitted changes come along when git can. A remote branch becomes a local branch that tracks it. If the remote branch is ahead of yours, pick: fast-forward or merge, recreate yours from it, switch as is, or branch off."],
    ["New branch", "Branch button, + in the sidebar, Ctrl+Shift+B, or right-click → New branch from here", "A branch is a movable name for a line of work. Start from any branch, tag or commit, use feature/ fix/ chore/ prefixes, and switch to it right away. The dialog shows the exact git command."],
    ["Merge a branch", "Right-click a branch → Merge <branch> into <current>", "Combines that branch's work into the branch you are on."],
    ["Drag and drop branches", "Drag a branch onto the current branch, or the current branch onto another", "Drop to pick Merge or Rebase, the same as the right-click menu. Remote branches work too."],
    ["Rebase onto a branch","Right-click a branch → Rebase <current> onto it", "Replays your commits on top of the other branch, for a straight history without a merge commit."],
    ["Rename a branch", "Right-click a local branch → Rename…", "Gives the branch a new name. What it tracks on the remote stays the same."],
    ["Track a remote branch", "Right-click a local branch → Track remote branch…", "Picks which remote branch Pull and Push use for it, or stops tracking."],
    ["Delete a branch", "Right-click a branch → Delete", "Removes a local branch (asks again if its work is not merged anywhere) or a branch on the remote. Both can be undone."],
    ["Tags", "Sidebar → Tags, right-click a tag", "Push a tag to the remote, delete it, branch from it, or write an AI changelog since it."],
    ["Stashes", "Sidebar → Stashes → +", "Parks your uncommitted changes so you get a clean folder, e.g. to switch branches. Apply brings them back and keeps the stash, Pop brings them back and removes it, Drop deletes it."],
    ["Explain a branch (AI)", "Right-click a local branch → Explain branch (AI), or Ctrl+K", "A plain-words summary of what the branch changes compared with another branch. Its commits and diff are sent to your AI provider."],
    ["Explain a stash (AI)", "Right-click a stash → Explain (AI)", "A plain-words summary of what the stash holds, new untracked files included. Its diff is sent to your AI provider."],
  ]],
  ["remote", "Remotes and GitHub", [
    ["Fetch", "Fetch button · Ctrl+Shift+F", "Downloads new commits from the remote without touching your files, so the graph and counts are up to date."],
    ["Pull", "Pull button · Ctrl+Shift+L", "Fetches and brings the new commits into your current branch. The badge shows how many are waiting."],
    ["Pull with rebase", "Right-click the Pull button, or Ctrl+K", "Puts your new commits on top of the remote's instead of adding a merge commit, for a straight history. Uncommitted changes are set aside and put back."],
    ["Push", "Push button · Ctrl+Shift+U", "Uploads your new commits to the remote. The badge shows how many, or \"new\" when the branch isn't on the remote yet."],
    ["Force push", "Push → rejected → Force push", "After a rebase or amend, replaces the remote's commits with yours, but only if nobody pushed since your last fetch. Undo history can push the old commits back."],
    ["Manage remotes", "Sidebar → Remotes → + or a remote's ⋯", "Add a remote by name and URL, change its URL, or remove it. Removing only forgets it here; nothing changes on the server."],
    ["Passwords and SSH keys", "Asked when git needs them", "Sign-in goes through git's own credential helpers and your SSH key. When git asks for a password or passphrase, your answer goes straight to git and is never stored by the app."],
    ["Pull / merge request", "Right-click a local branch → Create pull request…, or Ctrl+K", "Opens a pull request on GitHub, or a merge request when the repo is on gitlab.com, with a title and description written by AI from the branch's commits. Needs GitHub or GitLab sign-in."],
    ["Changelog (AI)", "Right-click a tag → Changelog since this tag, or Ctrl+K", "Release notes written by AI from the commits between two points, ready to copy."],
  ]],
  ["warn", "Conflicts", [
    ["Paused operations", "Shown automatically", "When a merge, rebase or cherry-pick stops on conflicts, the app switches to File Status and shows a banner. Abort to go back to how things were, or commit to finish once every file is resolved."],
    ["Resolve a file", "Click a conflicted file", "Keep mine, Keep theirs, or keep both in either order. The app explains which side is which (it flips during a rebase) and backs the file up first."],
    ["Resolve with AI", "Conflicted file → Resolve with AI", "The AI proposes a merge of both sides. You review it, then Apply (backed up first, undoable) or Discard. The file is sent to your AI provider."],
    ["Fix by hand", "Conflicted file → Open in…", "Opens the file in your editor of choice; once you fix and save it, it is marked resolved."],
  ]],
  ["undo", "Undo", [
    ["Undo history", "Sidebar → Undo history, or Ctrl+K → Undo", "Discards, branch and tag deletes, merges, rebases, pulls, amends and conflict picks are recorded. Undo puts your branches back exactly where they were."],
    ["Backups before discarding", "Automatic", "Discarded file content is saved before it goes, so undoing a discard brings the content back too."],
  ]],
  ["command", "Everywhere", [
    ["Command palette", "Ctrl+K or Ctrl+Shift+P", "Type to find any action by name and see its shortcut and the git command it runs: switch views, check out a branch, change theme and more."],
    ["Theme", "Theme button, or Ctrl+K", "System, light or dark."],
    ["Settings", "Gear button", "A status overview shows what is set up and what still needs doing; click one to jump to it. Your git name and email, saving HTTPS sign-ins, your SSH key and your AI provider (Gemini, Claude, OpenAI or a local model) with its key. Stored on this computer only."],
    ["First-run setup", "On first launch, or Settings → Run setup again", "A short walkthrough of the settings above."],
    ["Plain-language errors", "Automatic", "When git fails, you get what went wrong and what to do next, not just git's raw message."],
    ["Updates", "Notice in the bottom-right corner", "When a new version is out, install it and restart with one click, or later."],
    ["Resizable panes", "Drag the dividers", "Resize the commit list, details and diff. Sizes are remembered."],
  ]],
];

// One hue per area, used for its icon and card accent (oklch keeps them equally bright).
const HUES = [265, 150, 205, 300, 230, 40, 15, 180];
const ALL = FEATURES.flatMap(([, , items]) => items);
const SHORTCUTS = new Set(ALL.flatMap(([, how]) => how.match(/Ctrl\+(?:Shift\+)?\w+/g) ?? [])).size;
const TITLE = ["Everything", null, "can", "do."];

/** Wraps shortcuts like "Ctrl+Shift+F" in <kbd>. */
const keys = (s: string) => s.split(/(Ctrl\+(?:Shift\+)?\w+)/).map((p, i) => (i % 2 ? <kbd key={i}>{p}</kbd> : p));
/** "A → B · Ctrl+X" as a path: steps joined by arrows, shortcuts as keys. */
const path = (how: string) => how.split(" → ").flatMap((step, i) => [i ? <span key={`a${i}`} className="arr" aria-hidden="true">›</span> : null, <span key={i}>{keys(step)}</span>]);
/** Highlights `q` inside `text`. */
function hit(text: string, q: string) {
  if (!q) return text;
  return text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "i")).map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : p));
}
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const smooth = () => (matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");

/** Bottom-right info button: what git-ai is and what it can do. */
export function AboutButton() {
  const dialog = useRef<HTMLDialogElement>(null);
  const nav = useRef<HTMLElement>(null);
  // The item picked in the nav; wins at the bottom (where it can't scroll under the header) until the user scrolls.
  const picked = useRef<string | null>(null);
  const [q, setQ] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const [lit, setLit] = useState<string | null>(null);
  const f = q.trim().toLowerCase();
  const groups = FEATURES.map(([icon, title, items], i) => ({ icon, title, hue: HUES[i], items: items.filter((x) => x.join(" ").toLowerCase().includes(f)) }))
    .filter((g) => g.items.length);

  // Scroll spy: the active feature is the last one whose top has passed just under the sticky header,
  // in document order; side-by-side items in a row tie, and the first (left) one wins. At the bottom, the last item.
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    let frame = 0;
    const spy = () => {
      frame = 0;
      const items = d.querySelectorAll<HTMLElement>(".about-grid li[id]");
      if (!items.length) return setActive(null);
      const line = d.getBoundingClientRect().top + (d.querySelector<HTMLElement>(".modal-head")?.offsetHeight ?? 80) + 48;
      let id = items[0].id, top = -Infinity;
      for (const el of items) {
        const t = el.getBoundingClientRect().top;
        if (t <= line && t > top + 1) { id = el.id; top = t; }
      }
      if (d.scrollTop + d.clientHeight >= d.scrollHeight - 2) id = picked.current ?? items[items.length - 1].id;
      setActive(id);
    };
    const onScroll = () => { frame ||= requestAnimationFrame(spy); };
    const unpick = () => { picked.current = null; };
    d.addEventListener("scroll", onScroll, { passive: true });
    for (const t of ["wheel", "touchstart", "keydown"]) d.addEventListener(t, unpick, { passive: true });
    spy();
    return () => {
      d.removeEventListener("scroll", onScroll);
      for (const t of ["wheel", "touchstart", "keydown"]) d.removeEventListener(t, unpick);
      cancelAnimationFrame(frame);
    };
  }, [f]);
  // Keep the active link in view inside the nav (scrolls only the nav, never the dialog).
  useEffect(() => {
    const n = nav.current, a = n?.querySelector<HTMLElement>('[aria-current="true"]');
    if (n && a && (a.offsetTop < n.scrollTop || a.offsetTop > n.scrollTop + n.clientHeight - 40))
      n.scrollTo({ top: a.offsetTop - n.clientHeight / 3, behavior: smooth() });
  }, [active]);

  function open() {
    const d = dialog.current;
    d?.showModal();
    // The nav sticks just under the sticky header, whatever height the header wraps to.
    requestAnimationFrame(() => d?.style.setProperty("--head", `${d.querySelector<HTMLElement>(".modal-head")?.offsetHeight ?? 80}px`));
  }
  function go(id: string) {
    picked.current = id.startsWith("feat-") ? id : null;
    document.getElementById(id)?.scrollIntoView({ block: "start", behavior: smooth() });
    setLit(null);
    requestAnimationFrame(() => setLit(id));
  }
  const areaOf = (id: string | null) => groups.find((g) => g.items.some(([n]) => `feat-${slug(n)}` === id))?.title;

  return (
    <>
      <button className="corner-btn" onClick={open} aria-label="About git-ai" title="About git-ai">
        <Icon name="info" />
        <span>About &amp; features</span>
      </button>
      <dialog ref={dialog} className="modal about" aria-labelledby="about-title" onClose={() => { setQ(""); setActive(null); }}>
        <ModalHead id="about-title" icon="info" title={<>About <Brand /></>} sub="A free desktop Git client. Open source under Apache-2.0." />
        <div className="about-layout">
          <nav ref={nav} className="about-nav" aria-label="All features">
            {groups.map((g) => (
              <div key={g.title} className={areaOf(active) === g.title ? "on" : undefined} style={{ "--h": g.hue } as React.CSSProperties}>
                <button type="button" className="about-nav-area" onClick={() => go(`about-${slug(g.title)}`)}>
                  <span className="about-icon"><Icon name={g.icon} /></span>{g.title}<small>{g.items.length}</small>
                </button>
                <ul>
                  {g.items.map(([name]) => {
                    const id = `feat-${slug(name)}`;
                    return <li key={name}><button type="button" aria-current={active === id} onClick={() => go(id)}>{name}</button></li>;
                  })}
                </ul>
              </div>
            ))}
          </nav>
          <div className="about-body">
            <header className="about-hero">
              {/* Words rise one by one; the heading's accessible name stays whole. */}
              <h3 className="about-title" aria-label="Everything git-ai can do.">
                {TITLE.map((w, i) => (
                  <span key={i} className="word" aria-hidden="true" style={{ "--i": i } as React.CSSProperties}>{w ?? <Brand />}{i < TITLE.length - 1 ? " " : ""}</span>
                ))}
              </h3>
              <p>
                <Brand /> shows your repository at a glance: changes, history graph and branches side by side.
                It is local-first: your repository is the only database. Risky operations are recorded so each one can be undone,
                and git's errors are explained in plain words. Here is every feature, where to find it, and what it is for.
              </p>
              <dl className="about-stats">
                <div><dt>Features</dt><dd>{ALL.length}</dd></div>
                <div><dt>Areas</dt><dd>{FEATURES.length}</dd></div>
                <div><dt>Shortcuts</dt><dd>{SHORTCUTS}</dd></div>
                <div><dt>License</dt><dd>Apache-2.0</dd></div>
              </dl>
            </header>
            <div className="about-tools">
              <label className="search about-search"><Icon name="search" />
                <input type="search" placeholder="Find a feature, e.g. cherry-pick" aria-label="Find a feature" value={q} onChange={(e) => setQ(e.target.value)} />
              </label>
              {/* Narrow windows hide the side nav; these chips jump to an area instead. */}
              <div className="about-jump" role="group" aria-label="Feature areas">
                {groups.map((g) => (
                  <button key={g.title} type="button" className="chip" style={{ "--h": g.hue } as React.CSSProperties} onClick={() => go(`about-${slug(g.title)}`)}>
                    <Icon name={g.icon} />{g.title}<small>{g.items.length}</small>
                  </button>
                ))}
              </div>
            </div>
            <div className="about-grid">
              {groups.map((g, i) => (
                <section key={g.title} id={`about-${slug(g.title)}`} className={lit === `about-${slug(g.title)}` ? "lit" : undefined}
                  style={{ "--i": i, "--h": g.hue } as React.CSSProperties}>
                  <h3><span className="about-icon"><Icon name={g.icon} /></span>{g.title}</h3>
                  <ul>
                    {g.items.map(([name, how, what]) => {
                      const id = `feat-${slug(name)}`;
                      return (
                        <li key={name} id={id} className={lit === id ? "lit" : undefined}>
                          <strong>{hit(name, f)}</strong>
                          <span className="feat-how"><span className="sr-only">Where: </span>{path(how)}</span>
                          <p>{hit(what, f)}</p>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
            {!groups.length && <p className="about-none" role="status">No feature matches “{q.trim()}”. Try a git word like merge, stash or blame.</p>}
          </div>
        </div>
        <div className="dialog-actions">
          <button autoFocus onClick={() => dialog.current?.close()}>Close</button>
        </div>
      </dialog>
    </>
  );
}
