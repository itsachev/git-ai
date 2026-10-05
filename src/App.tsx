import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import { checkout, openRepo, recentRepos, stage, undo, unstage } from "./lib/ipc";
import type { RepoInfo } from "./bindings/RepoInfo";
import type { AppError } from "./bindings/AppError";
import { Changes, opLabel, opLogQuery, pathsOf, statusQuery, useRun } from "./features/status/Changes";
import { History } from "./features/graph/History";
import { Sidebar, refsQuery } from "./features/refs/Sidebar";
import { AskpassDialog, CloneForm, SyncButtons, useSync } from "./features/remote/Remote";
import { GitHubAccount } from "./features/github/GitHub";
import { Palette, type Command } from "./features/palette/Palette";
import { UpdateBanner } from "./features/update/Update";
import "./App.css";

function App() {
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [cloning, setCloning] = useState(false);

  useEffect(() => {
    recentRepos().then(setRecent);
  }, []);

  async function load(path: string) {
    try {
      setError(null);
      setRepo(await openRepo(path));
      setRecent(await recentRepos());
    } catch (e) {
      setError((e as AppError).message ?? String(e));
    }
  }

  async function pick() {
    const dir = await open({ directory: true });
    if (dir) load(dir);
  }

  async function cloned(info: RepoInfo) {
    setCloning(false);
    setRepo(info);
    setRecent(await recentRepos());
  }

  const body = repo ? <RepoView repo={repo} onClose={() => setRepo(null)} /> : (
    <main className="page welcome">
      <h1>git-ai</h1>
      <div className="welcome-actions">
        <button className="primary" onClick={pick}>Open repository…</button>
        <button aria-expanded={cloning} onClick={() => setCloning((v) => !v)}>Clone…</button>
      </div>
      {cloning && <CloneForm onCloned={cloned} />}
      <GitHubAccount />
      {error && <p className="error" role="alert">{error}</p>}
      {recent.length > 0 && (
        <section>
          <h2>Recent</h2>
          <ul className="recent">
            {recent.map((p) => (
              <li key={p}>
                <button onClick={() => load(p)} title={p}>
                  <strong>{p.split(/[\/]/).pop()}</strong>
                  <small>{p}</small>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
  // One askpass dialog for both screens: clone runs from the welcome screen.
  return (
    <>
      {body}
      <AskpassDialog />
      <UpdateBanner />
    </>
  );
}

const SYNC_KEYS: Record<string, string> = { Fetch: "Ctrl+Shift+F", Pull: "Ctrl+Shift+L", Push: "Ctrl+Shift+U" };

function RepoView({ repo, onClose }: { repo: RepoInfo; onClose: () => void }) {
  const path = repo.path;
  // Branch comes from live status so checkouts made elsewhere show up.
  const status = useQuery(statusQuery(path)).data;
  const refs = useQuery(refsQuery(path)).data;
  const log = useQuery(opLogQuery(path)).data;
  const branch = status ? status.branch : repo.branch;
  const [tab, setTab] = useState<"status" | "history">("status");
  // Narrow windows show the sidebar instead of the body; wide ones show both.
  const [side, setSide] = useState(false);
  const [run, error] = useRun();
  const sync = useSync(path, run);
  const tabs = [["status", "File Status"], ["history", "History"]] as const;

  const show = (t: typeof tab) => { setTab(t); setSide(false); };
  const commands: Command[] = [
    { label: "Go to File Status", keys: "Ctrl+1", run: () => show("status") },
    { label: "Go to History", keys: "Ctrl+2", run: () => show("history") },
    { label: "Toggle branches", keys: "Ctrl+B", run: () => setSide((v) => !v) },
    // The textarea mounts after the tab switch renders.
    { label: "Write commit message", keys: "Ctrl+Shift+M", run: () => { show("status"); setTimeout(() => document.getElementById("commit-msg")?.focus()); } },
    ...sync.ops.map((o) => ({ label: o.label, keys: SYNC_KEYS[o.label], run: o.go })),
  ];
  if (status?.unstaged.length)
    commands.push({ label: "Stage all changes", keys: "Ctrl+Shift+S", run: () => run(() => stage(path, pathsOf(status.unstaged))) });
  if (status?.staged.length) commands.push({ label: "Unstage all", run: () => run(() => unstage(path, pathsOf(status.staged))) });
  if (log?.[0]) commands.push({ label: `Undo: ${opLabel(log[0])}`, run: () => run(() => undo(path, log[0].id)) });
  for (const b of refs?.local ?? [])
    if (b.name !== refs?.head) commands.push({ label: `Checkout ${b.name}`, run: () => run(() => checkout(path, b.name, false)) });
  commands.push({ label: "Close repository", run: onClose });

  return (
    <main className="page repo">
      <header className="bar">
        <button onClick={onClose}>← Repos</button>
        <h1 title={path}>{repo.name}</h1>
        <span className="branch">{branch ?? "detached HEAD"}</span>
        <SyncButtons sync={sync} />
        <Palette commands={commands} />
        <button className="side-toggle" aria-expanded={side} onClick={() => setSide((v) => !v)}>Branches</button>
        <nav className="tabs" role="tablist">
          {tabs.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>
          ))}
        </nav>
        {error && <p className="error" role="alert">{error}</p>}
      </header>
      <div className={`repo-main${side ? " show-side" : ""}`}>
        <Sidebar path={repo.path} />
        <div className="repo-body">{tab === "status" ? <Changes path={repo.path} /> : <History path={repo.path} />}</div>
      </div>
    </main>
  );
}

export default App;
