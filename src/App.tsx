import { Fragment, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CLEAN, MOTION, SplitText, gsap, useGSAP } from "./lib/motion";
import { open } from "@tauri-apps/plugin-dialog";
import { forgetRepo, gitIdentity, initRepo, missingRepos, openRepo, openTerminal, recentRepos, stage, toolVersions, trashRepo, undo, unstage } from "./lib/ipc";
import { Icon } from "./lib/icons";
import { Splitter } from "./lib/splitter";
import { Brand, ConfirmDialog, ModalHead } from "./lib/modal";
import { ThemeButton, themeCommands, useTheme, type Theme } from "./lib/theme";
import type { RepoInfo } from "./bindings/RepoInfo";
import type { AppError } from "./bindings/AppError";
import { Changes, Notice, OpErrorDialog, confirmUndo, opLabel, opLogQuery, pathsOf, statusQuery, undoHint, useOpBusy, useRun } from "./features/status/Changes";
import { History } from "./features/graph/History";
import { Sidebar, refsQuery, switchTo } from "./features/refs/Sidebar";
import { NewBranchButton, NewBranchDialog, openNewBranch } from "./features/refs/NewBranch";
import { WriteUpDialog, openWriteUp } from "./features/refs/WriteUp";
import { RebaseDialog } from "./features/graph/Rebase";
import { FileHistoryDialog } from "./features/graph/FileHistory";
import { StashDialog, StashSaveDialog, openStashSave } from "./features/refs/Stash";
import { AskpassDialog, CloneDialog, SyncButtons, useSync } from "./features/remote/Remote";
import { GitHubAccount, GitLabAccount } from "./features/github/GitHub";
import { Backdrop } from "./features/home/Backdrop";
import { AboutButton } from "./features/about/About";
import { Palette, type Command } from "./features/palette/Palette";
import { Shortcuts, onOpenShortcuts } from "./features/shortcuts/Shortcuts";
import { LfsDialog, openLfs } from "./features/lfs/Lfs";
import { SettingsButton, SettingsDialog, openSettings } from "./features/settings/Settings";
import { SetupWizard, openSetup } from "./features/setup/Setup";
import { UpdateBanner } from "./features/update/Update";
import bg from "./assets/app_bg.jpg";
import "./App.css";

// The first frames are busy (font swap, decoding the backdrop JPEG, the first IPC round-trips), so an intro played
// through them stutters. Reveals start once fonts and backdrop are ready, plus a beat. Later reveals start at once.
const settled = (() => {
  const img = new Image();
  img.src = bg;
  return Promise.all([document.fonts.ready, img.decode().catch(() => {})]).then(() => new Promise<void>((r) => setTimeout(r, 250)));
})();
/** Hold a paused reveal until the app has settled; returns the matchMedia cleanup so a revert first cancels it. */
function playSettled(t: gsap.core.Animation) {
  let live = true;
  settled.then(() => { if (live) t.play(); });
  return () => { live = false; };
}

/** Brand mark: a trunk with one branch forking off; the live commit in the signal color. */
function Mark() {
  return (
    <svg className="mark" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 5v14M7 16c0-5 10-3 10-9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="7" cy="19" r="2.5" fill="currentColor" />
      <circle cx="7" cy="5" r="2.5" fill="currentColor" />
      <circle cx="17" cy="6" r="3" fill="var(--accent)" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

/** Remove a recent repo from the list, or also move its folder to the OS trash. */
function RemoveRepoDialog({ path, missing, onClose, onDone }: { path: string | null; missing: boolean; onClose: () => void; onDone: (error: string | null) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  // Keep the text through the close transition.
  const last = useRef(path);
  if (path) last.current = path;
  useEffect(() => {
    if (path) dialog.current?.showModal();
    else dialog.current?.close();
  }, [path]);
  async function go(fn: (p: string) => Promise<void>) {
    if (!path) return;
    setBusy(true);
    let err: string | null = null;
    try { await fn(path); } catch (e) { err = (e as AppError).message ?? String(e); }
    setBusy(false);
    onClose();
    onDone(err);
  }
  const p = last.current ?? "";
  return (
    <dialog ref={dialog} className="modal tone-danger" aria-labelledby="remove-title" aria-describedby="remove-text"
      onCancel={(e) => { e.preventDefault(); if (!busy) onClose(); }}>
      <ModalHead id="remove-title" icon="warn" tone="danger" title={missing ? `${p.split(/[\\/]/).pop()} was deleted` : `Remove ${p.split(/[\\/]/).pop()}?`} sub={p} />
      {missing ? (
        <p id="remove-text" className="modal-text">
          This folder no longer exists on disk. It was deleted or moved outside <Brand />.
          Remove it from this list. If you moved it, use Open repository to add it from its new place.
        </p>
      ) : (
        <p id="remove-text" className="modal-text">
          Remove it from this list only, or also move the folder to the {navigator.userAgent.includes("Windows") ? "Recycle Bin" : "Trash"}.
          Deleting from disk loses anything not pushed (unpushed commits, stashes, uncommitted changes) unless you restore the folder from there.
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" autoFocus disabled={busy} onClick={onClose}>Cancel</button>
        <button type="button" className="primary" disabled={busy} onClick={() => go(forgetRepo)}>Remove from list</button>
        {!missing && <button type="button" className="danger" disabled={busy} onClick={() => go(trashRepo)}>{busy ? "Deleting…" : "Delete from disk"}</button>}
      </div>
    </dialog>
  );
}

/** One tab per open repo, plus "+" back to the repository list. Middle-click closes a tab. */
function RepoTabs({ tabs, active, onSelect, onClose, onNew }: { tabs: RepoInfo[]; active: string; onSelect: (path: string) => void; onClose: (path: string) => void; onNew: () => void }) {
  // Many tabs scroll sideways: keep the active one in view.
  useEffect(() => { document.querySelector(".tab[aria-current]")?.scrollIntoView({ block: "nearest", inline: "nearest" }); }, [active]);
  return (
    <nav className="tabs" aria-label="Open repositories">
      {tabs.map((t) => (
        <div key={t.path} className="tab" aria-current={t.path === active ? "page" : undefined}
          onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }} onAuxClick={(e) => { if (e.button === 1) onClose(t.path); }}>
          <button className="tab-name" onClick={() => onSelect(t.path)} title={t.path}><Icon name="folder" /><span>{t.name}</span><TabSync path={t.path} live={t.path === active} /></button>
          <button className="icon-btn" onClick={() => onClose(t.path)} title="Close tab (Ctrl+W)" aria-label={`Close ${t.name}`}><Icon name="close" /></button>
        </div>
      ))}
      <button className="icon-btn tab-new" onClick={onNew} title="Open another repository (Ctrl+T)" aria-label="Open another repository"><Icon name="add" /></button>
    </nav>
  );
}

/** Commits to push/pull on the tab's current branch. Inactive tabs show their last cached refs, so no extra git work. */
function TabSync({ path, live }: { path: string; live: boolean }) {
  const refs = useQuery({ ...refsQuery(path), enabled: live }).data;
  const cur = refs?.local.find((b) => b.name === refs.head);
  if (!cur || !(cur.ahead || cur.behind)) return null;
  const label = [cur.ahead && `${cur.ahead} to push`, cur.behind && `${cur.behind} to pull`].filter(Boolean).join(", ");
  // key on the count: a changed number replays the pop-in.
  return (
    <span className="tab-sync" title={label} aria-label={label}>
      {cur.ahead > 0 && <b key={`a${cur.ahead}`} aria-hidden>↑{cur.ahead}</b>}
      {cur.behind > 0 && <b key={`b${cur.behind}`} aria-hidden className="behind">↓{cur.behind}</b>}
    </span>
  );
}

/** Open tabs and the active one, kept across restarts (a per-window convenience, like the other UI choices). */
const TABS_KEY = "gitai.tabs";
function savedTabs(): { tabs: RepoInfo[]; active: string | null } {
  try {
    const s = JSON.parse(localStorage.getItem(TABS_KEY) ?? "null");
    if (Array.isArray(s?.tabs)) return { tabs: s.tabs, active: s.tabs.some((t: RepoInfo) => t.path === s.active) ? s.active : null };
  } catch { /* storage blocked or corrupt */ }
  return { tabs: [], active: null };
}
const saved = savedTabs();

function App() {
  // Open repos as tabs. Only the active one is mounted: the backend watches one repo at a time.
  const [tabs, setTabs] = useState<RepoInfo[]>(saved.tabs);
  const [active, setActive] = useState<string | null>(saved.active);
  const repo = tabs.find((t) => t.path === active) ?? null;
  const qc = useQueryClient();
  const [recent, setRecent] = useState<string[]>([]);
  const [missing, setMissing] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [cloning, setCloning] = useState(false);
  const [filter, setFilter] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const [theme, setTheme] = useTheme();
  const home = useRef<HTMLElement>(null);
  const hasRecent = recent.length > 0;

  // Home intro: headline word by word out of its masks, then lede, actions, recents and corner pills.
  useGSAP(() => {
    if (repo) return;
    gsap.matchMedia().add(MOTION, () => {
      const words = SplitText.create("h1", { type: "words", wordsClass: "w", mask: "words", aria: "auto" }).words;
      const tl = gsap.timeline({ paused: true, defaults: { ease: "expo.out", duration: 0.8, clearProps: CLEAN } })
        .from(".brand", { opacity: 0, y: 8, duration: 0.6 })
        .from(words, { yPercent: 110, stagger: 0.06, duration: 0.9 }, 0.05)
        .from(".lede", { opacity: 0, y: 12 }, 0.2)
        .from(".tile", { opacity: 0, y: 16, stagger: 0.06 }, 0.25)
        .from(".home-recent > :not(.recent)", { opacity: 0, x: 16, stagger: 0.05 }, 0.25)
        .from(".corner > *", { opacity: 0, y: 8, stagger: 0.05, duration: 0.6 }, 0.4);
      return playSettled(tl);
    });
  }, { scope: home, dependencies: [!!repo], revertOnUpdate: true });

  // Recents arrive over IPC after the first paint: cascade the rows in on arrival (only the ones on screen).
  useGSAP(() => {
    if (repo || !hasRecent) return;
    gsap.matchMedia().add(MOTION, () => {
      // Delay: on first load they follow the Recent header in the intro.
      return playSettled(gsap.timeline({ paused: true }).from(gsap.utils.toArray<HTMLElement>(".recent li").slice(0, 14),
        { opacity: 0, x: 16, stagger: 0.035, duration: 0.7, ease: "expo.out", clearProps: CLEAN }, 0.3));
    });
  }, { scope: home, dependencies: [!!repo, hasRecent], revertOnUpdate: true });

  async function refresh() {
    const [r, m] = await Promise.all([recentRepos(), missingRepos()]);
    setRecent(r);
    setMissing(m);
  }

  useEffect(() => {
    try { localStorage.setItem(TABS_KEY, JSON.stringify({ tabs, active })); } catch { /* storage blocked */ }
  }, [tabs, active]);

  // Re-check on focus: folders get deleted outside the app.
  useEffect(() => {
    // Restored tabs: point the watcher at the active one. Inactive ones get checked when selected (select()).
    if (saved.active) openRepo(saved.active).catch((e) => {
      setError((e as AppError).message ?? String(e));
      drop(saved.active!);
      setActive(null);
    });
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  // Data cached for a repo went unwatched while it wasn't shown: mark it all stale, so the mounting view refetches.
  function show(info: RepoInfo) {
    setTabs((ts) => (ts.some((t) => t.path === info.path) ? ts : [...ts, info]));
    setActive(info.path);
    qc.invalidateQueries({ refetchType: "none" });
    refresh();
  }

  async function load(path: string) {
    if (missing.includes(path)) return setRemoving(path);
    try {
      setError(null);
      show(await openRepo(path));
    } catch (e) {
      setError((e as AppError).message ?? String(e));
      drop(path);
      refresh();
    }
  }

  // Switching tabs shows the repo at once; open_repo then points the watcher at it. If that fails (folder gone), back home.
  function select(path: string) {
    if (path === active) return;
    setActive(path);
    qc.invalidateQueries({ refetchType: "none" });
    openRepo(path).then(refresh, (e) => {
      setError((e as AppError).message ?? String(e));
      drop(path);
      setActive(null);
      refresh();
    });
  }

  const drop = (path: string) => setTabs((ts) => ts.filter((t) => t.path !== path));

  // Closing the active tab shows its right neighbour, else its left one, else the repository list.
  function close(path: string) {
    const i = tabs.findIndex((t) => t.path === path);
    const rest = tabs.filter((t) => t.path !== path);
    setTabs(rest);
    if (path !== active) return;
    const next = rest[Math.min(i, rest.length - 1)];
    if (next) select(next.path);
    else setActive(null);
  }

  const cycle = (d: number) => select(tabs[(tabs.findIndex((t) => t.path === active) + d + tabs.length) % tabs.length].path);
  const tabCommands: Command[] = [
    { label: "Open another repository", keys: "Ctrl+T", run: () => setActive(null) },
    { label: "Close tab", keys: "Ctrl+W", run: () => active && close(active) },
  ];
  if (tabs.length > 1)
    tabCommands.push({ label: "Next tab", keys: "Ctrl+Tab", run: () => cycle(1) }, { label: "Previous tab", keys: "Ctrl+Shift+Tab", run: () => cycle(-1) },
      ...tabs.filter((t) => t.path !== active).map((t) => ({ label: `Switch to ${t.name}`, run: () => select(t.path) })));

  async function pick() {
    const dir = await open({ directory: true });
    if (dir) load(dir);
  }

  async function create() {
    const dir = await open({ directory: true, title: "Folder for the new repository" });
    if (!dir) return;
    try {
      setError(null);
      show(await initRepo(dir));
    } catch (e) {
      setError((e as AppError).message ?? String(e));
    }
  }

  async function cloned(info: RepoInfo) {
    setCloning(false);
    show(info);
  }

  const f = filter.trim().toLowerCase();
  const shown = recent.filter((p) => p.toLowerCase().includes(f));
  const body = repo ? (
    <div className="workspace">
      <RepoTabs tabs={tabs} active={repo.path} onSelect={select} onClose={close} onNew={() => setActive(null)} />
      <RepoView key={repo.path} repo={repo} onHome={() => setActive(null)} tabCommands={tabCommands} theme={theme} setTheme={setTheme} />
    </div>
  ) : (
    <main className="home" ref={home}>
      <Backdrop />
      <section className="home-intro">
        <p className="brand"><Mark /> <Brand /></p>
        <h1>Git that explains itself.</h1>
        <p className="lede">Local-first. Discards, branch deletes and merges are recorded, so each one can be undone.</p>
        <div className="tiles" onPointerMove={(e) => {
          const t = (e.target as HTMLElement).closest<HTMLElement>(".tile"), r = t?.getBoundingClientRect();
          if (t && r) { t.style.setProperty("--mx", `${e.clientX - r.left}px`); t.style.setProperty("--my", `${e.clientY - r.top}px`); }
        }}>
          <button className="tile primary" onClick={pick}>
            <Icon name="open" />
            <span><strong>Open repository</strong><small>A folder that contains .git</small></span>
          </button>
          <button className="tile" aria-haspopup="dialog" onClick={() => setCloning(true)}>
            <Icon name="clone" />
            <span><strong>Clone</strong><small>From a URL</small></span>
          </button>
          <button className="tile" onClick={create}>
            <Icon name="add" />
            <span><strong>Create</strong><small>A new, empty repository</small></span>
          </button>
        </div>
        {cloning && <CloneDialog onCloned={cloned} onClose={() => setCloning(false)} />}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="accounts" aria-label="Accounts" role="group">
          <GitHubAccount />
          <GitLabAccount />
        </div>
      </section>
      <section className="home-recent" aria-labelledby="recent-title">
        <div className="section-head">
          <h2 id="recent-title">Recent</h2>
          {recent.length > 0 && <span className="count">{recent.length}</span>}
        </div>
        {recent.length > 3 && (
          <label className="search">
            <Icon name="search" />
            <input type="search" placeholder="Filter repositories" aria-label="Filter repositories" value={filter} onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && shown.length) load(shown[0]); }} />
          </label>
        )}
        {!recent.length && <p className="empty">Repositories you open or clone show up here.</p>}
        {recent.length > 0 && !shown.length && <p className="empty">No repository matches “{filter}”.</p>}
        <ul className="recent">
          {shown.map((p) => {
            const gone = missing.includes(p), opened = tabs.some((t) => t.path === p);
            return (
            <li key={p} className={gone ? "missing" : opened ? "opened" : undefined} onContextMenu={(e) => { e.preventDefault(); setRemoving(p); }}>
              <button onClick={() => load(p)} title={gone ? `Deleted from disk: ${p}` : p}>
                <Icon name={gone ? "warn" : "folder"} />
                <span>
                  <strong>{p.split(/[\\/]/).pop()}</strong>
                  <small>{gone ? <><em>Deleted from disk</em> · {p}</> : opened ? <><em>Open</em> · {p}</> : p}</small>
                </span>
              </button>
              <button className="icon-btn" onClick={() => setRemoving(p)} title="Remove…" aria-label={`Remove ${p}`}>
                <Icon name="more" />
              </button>
            </li>
            );
          })}
        </ul>
      </section>
      <div className="corner top-right"><SettingsButton labeled /></div>
      <div className="corner bottom-left"><ThemeButton theme={theme} onChange={setTheme} labeled /></div>
      <div className="corner bottom-right"><AboutButton /></div>
      <RemoveRepoDialog path={removing} missing={!!removing && missing.includes(removing)} onClose={() => setRemoving(null)} onDone={(e) => { setError(e); if (!e && removing) drop(removing); refresh(); }} />
    </main>
  );
  // One askpass dialog for both screens: clone runs from the welcome screen.
  return (
    <>
      {body}
      <AskpassDialog />
      <SettingsDialog />
      <SetupWizard theme={theme} setTheme={setTheme} />
      <ConfirmDialog />
      <UpdateBanner />
    </>
  );
}

const SYNC_KEYS: Record<string, string> = { Fetch: "Ctrl+Shift+F", Pull: "Ctrl+Shift+L", Push: "Ctrl+Shift+U" };
const SYNC_GIT: Record<string, string> = { Fetch: "git fetch --all --prune", Pull: "git pull --no-rebase", Push: "git push" };
const PULL_REBASE_GIT = "git pull --rebase --autostash";

/** Installed git and Node versions, read once per app run, plus who commits in this repo. */
function Versions({ path }: { path: string }) {
  const [git, node] = useQuery({ queryKey: ["tool-versions"], queryFn: toolVersions, staleTime: Infinity }).data ?? [];
  // Under "git-setup" so saving the identity in Settings refreshes it.
  const id = useQuery({ queryKey: ["git-setup", path], queryFn: () => gitIdentity(path) }).data;
  const g = git?.replace(/^git version /, "").replace(/\.windows.*$/, "");
  const n = node?.replace(/^v/, "");
  const who = id && (id[0] || id[1] ? <><b>Committing as</b> {[id[0], id[1] && `<${id[1]}>`].filter(Boolean).join(" ")}</> : "No commit name or email set");
  const parts = [g && <><b>Git</b> {g}</>, n && <><b>Node</b> {n}</>, who].filter(Boolean);
  return <span className="versions" title={[git, node && `node ${node}`].filter(Boolean).join("\n")}>{parts.map((p, i) => <Fragment key={i}>{i > 0 && " · "}{p}</Fragment>)}</span>;
}

type RepoProps = { repo: RepoInfo; onHome: () => void; tabCommands: Command[]; theme: Theme; setTheme: (t: Theme) => void };

function RepoView({ repo, onHome, tabCommands, theme, setTheme }: RepoProps) {
  const path = repo.path;
  // Branch comes from live status so checkouts made elsewhere show up.
  const status = useQuery(statusQuery(path)).data;
  const refs = useQuery(refsQuery(path)).data;
  const log = useQuery(opLogQuery(path)).data;
  const branch = status ? status.branch : repo.branch;
  const [tab, setTab] = useState<"status" | "history" | "shortcuts">("history");
  // Narrow windows show the rail as a drawer over the body; wide ones show both.
  const [side, setSide] = useState(false);
  const run = useRun();
  const sync = useSync(path, run);
  // Also true between the two steps of a rejected push (sync.busy covers the choice dialog in between).
  const busy = useOpBusy() || !!sync.busy;
  const changed = status ? status.staged.length + status.unstaged.length + status.conflicted.length : 0;
  const views = [["status", "File Status", "changes"], ["history", "History", "history"]] as const;
  const shell = useRef<HTMLDivElement>(null);

  // Opening a repo: the rail head and views cascade in from the left, the toolbar drops in (the Sidebar reveals itself
  // when its refs arrive). The branch chips keep their own CSS pop.
  useGSAP(() => {
    gsap.matchMedia().add(MOTION, () => {
      gsap.timeline({ defaults: { ease: "expo.out", duration: 0.8, clearProps: CLEAN } })
        .from(".rail-head > *, .views button", { opacity: 0, x: -14, stagger: 0.04 })
        .from(".toolbar > :not(.branch-chip)", { opacity: 0, y: -8, stagger: 0.03 }, 0.05);
    });
  }, { scope: shell, dependencies: [path], revertOnUpdate: true });

  const show = (t: typeof tab) => { setTab(t); setSide(false); };
  useEffect(() => onOpenShortcuts(() => show("shortcuts")), []);
  // Escape closes the drawer, unless a dialog or menu on top takes it first.
  useEffect(() => {
    if (!side) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.querySelector("dialog[open], :popover-open")) setSide(false); };
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, [side]);
  // A merge/rebase/... that just paused at conflicts: go where they get resolved.
  const nConflicts = status?.conflicted.length ?? 0;
  const hadConflicts = useRef(nConflicts > 0);
  useEffect(() => {
    if (nConflicts && !hadConflicts.current) setTab("status");
    hadConflicts.current = nConflicts > 0;
  }, [nConflicts]);
  const commands: Command[] = [
    { label: "Go to File Status", keys: "Ctrl+1", git: "git status", run: () => show("status") },
    { label: "Go to History", keys: "Ctrl+2", git: "git log --graph --oneline --all", run: () => show("history") },
    { label: "Search commits", keys: "Ctrl+F", git: "git log --all -i --grep=<text>", run: () => { show("history"); setTimeout(() => document.getElementById("commit-search")?.focus()); } },
    { label: "Keyboard shortcuts", keys: "Ctrl+/", run: () => show("shortcuts") },
    { label: "Toggle branches", keys: "Ctrl+B", git: "git branch -a", run: () => setSide((v) => !v) },
    { label: "New branch", keys: "Ctrl+Shift+B", git: "git switch -c <name>", run: () => openNewBranch() },
    { label: "Create pull request…", git: "gh pr create", run: () => openWriteUp("pr") },
    { label: "Write changelog (AI)", run: () => openWriteUp("changelog") },
    { label: "Explain current branch (AI)", run: () => openWriteUp("explain") },
    { label: "Git LFS…", git: "git lfs track", run: () => openLfs() },
    { label: "Open in terminal", run: () => run(() => openTerminal(path)) },
    // The textarea mounts after the tab switch renders.
    { label: "Write commit message", keys: "Ctrl+Shift+M", git: 'git commit -m "<message>"', run: () => { show("status"); setTimeout(() => document.getElementById("commit-msg")?.focus()); } },
    ...sync.ops.map((o) => ({ label: o.label, keys: SYNC_KEYS[o.label], git: o.label === "Pull" && sync.rebase ? PULL_REBASE_GIT : SYNC_GIT[o.label], run: o.go })),
    sync.rebase ? { label: "Pull (merge)", git: SYNC_GIT.Pull, run: sync.pullMerge } : { label: "Pull with rebase", git: PULL_REBASE_GIT, run: sync.pullRebase },
  ];
  if (status?.unstaged.length)
    commands.push({ label: "Stage all changes", keys: "Ctrl+Shift+S", git: "git add -A", run: () => run(() => stage(path, pathsOf(status.unstaged))) });
  if (changed) commands.push({ label: "Stash changes…", git: "git stash push -u -m <name>", run: () => openStashSave() });
  if (status?.staged.length) commands.push({ label: "Unstage all", git: "git reset", run: () => run(() => unstage(path, pathsOf(status.staged))) });
  // The label is what the new entry will be: undoing an undo is a redo.
  if (log?.[0]) commands.push({ label: opLabel({ ...log[0], op: `undo ${log[0].op}` }), git: undoHint(log[0]), run: async () => (await confirmUndo(log[0])) && run(() => undo(path, log[0].id)) });
  for (const b of refs?.local ?? [])
    if (b.name !== refs?.head) commands.push({ label: `Checkout ${b.name}`, git: `git switch ${b.name}`, run: () => run(() => switchTo(path, b.name, false)) });
  commands.push(...themeCommands(theme, setTheme), { label: "Settings", run: openSettings }, { label: "Run first-time setup", run: openSetup }, ...tabCommands);

  return (
    <div ref={shell} className={`shell${side ? " show-side" : ""}`}>
      {/* While Commit/Fetch/Pull/Push runs, every control in the rail and the stage is disabled (`.lock`). Askpass and the
          push-rejected choice mount outside RepoView, so they stay usable. */}
      <aside className="rail" aria-label="Repository">
        <fieldset className="lock" disabled={busy}>
        <div className="rail-head">
          {/* Arrow and repo name are one target: either goes back to the repository list. */}
          <button className="back" onClick={onHome} title={`Back to repositories\n${path}`} aria-label={`${repo.name}: back to repositories`}>
            <Icon name="back" /><strong>{repo.name}</strong>
          </button>
          <span className="branch-chip" key={branch ?? ""} title="Current branch"><Icon name="branch" /><span>{branch ?? "detached HEAD"}</span></span>
        </div>
        <nav className="views" aria-label="Views">
          {views.map(([id, label, icon]) => (
            <button key={id} aria-current={tab === id ? "page" : undefined} onClick={() => show(id)}
              className={id === "status" && status?.conflicted.length ? "conflict" : undefined}>
              <Icon name={icon} />
              <span>{label}</span>
              {id === "status" && changed > 0 && <span className="count" aria-label={`${changed} changed files${status?.conflicted.length ? `, ${status.conflicted.length} with conflicts` : ""}`}>{changed}</span>}
            </button>
          ))}
        </nav>
        <Sidebar path={path} />
        </fieldset>
      </aside>
      <Splitter name="rail-w" axis="x" label="Resize sidebar" />
      <div className="scrim" aria-hidden="true" onClick={() => setSide(false)} />
      <main className="stage">
        <fieldset className="lock" disabled={busy}>
        <header className="toolbar">
          <button className="icon-btn menu" aria-label="Branches and views" aria-expanded={side} onClick={() => setSide((v) => !v)}><Icon name="menu" /></button>
          <h1>{tab === "status" ? "File Status" : tab === "history" ? "History" : "Keyboard shortcuts"}</h1>
          <SyncButtons sync={sync}>
            <button disabled={!changed} onClick={() => openStashSave()} title={changed ? "Stash changes: name it, pick which ones" : "No changes to stash"}>
              <Icon name="stash" /><span className="btn-label">Stash</span>
            </button>
            <NewBranchButton />
            <button onClick={() => run(() => openTerminal(path))} title="Open this repository in a terminal">
              <Icon name="terminal" /><span className="btn-label">Terminal</span>
            </button>
          </SyncButtons>
          <ThemeButton theme={theme} onChange={setTheme} />
          <SettingsButton />
        </header>
        <Notice />
        <OpErrorDialog path={repo.path} />
        <NewBranchDialog path={path} />
        <WriteUpDialog path={path} />
        <RebaseDialog path={path} />
        <FileHistoryDialog path={path} />
        <StashDialog path={path} />
        <StashSaveDialog path={path} />
        <LfsDialog path={path} />
        <div className="stage-body" key={tab}>{tab === "status" ? <Changes path={path} push={sync.pushNow} /> : tab === "history" ? <History path={path} /> : <Shortcuts commands={commands} />}</div>
        {/* No shortcuts or palette commands while busy. */}
        <footer className="statusbar"><Versions path={path} /><Palette commands={busy ? [] : commands} path={busy ? undefined : path} /></footer>
        </fieldset>
      </main>
    </div>
  );
}

export default App;
