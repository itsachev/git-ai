import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import { openRepo, recentRepos } from "./lib/ipc";
import type { RepoInfo } from "./bindings/RepoInfo";
import type { AppError } from "./bindings/AppError";
import { Changes, statusQuery } from "./features/status/Changes";
import { History } from "./features/graph/History";
import "./App.css";

function App() {
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

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

  if (repo) return <RepoView repo={repo} onClose={() => setRepo(null)} />;

  return (
    <main className="page welcome">
      <h1>git-ai</h1>
      <button className="primary" onClick={pick}>Open repository…</button>
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
}

function RepoView({ repo, onClose }: { repo: RepoInfo; onClose: () => void }) {
  // Branch comes from live status so checkouts made elsewhere show up.
  const status = useQuery(statusQuery(repo.path)).data;
  const branch = status ? status.branch : repo.branch;
  const [tab, setTab] = useState<"status" | "history">("status");
  const tabs = [["status", "File Status"], ["history", "History"]] as const;
  return (
    <main className="page repo">
      <header className="bar">
        <button onClick={onClose}>← Repos</button>
        <h1 title={repo.path}>{repo.name}</h1>
        <span className="branch">{branch ?? "detached HEAD"}</span>
        <nav className="tabs" role="tablist">
          {tabs.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>
          ))}
        </nav>
      </header>
      <div className="repo-body">{tab === "status" ? <Changes path={repo.path} /> : <History path={repo.path} />}</div>
    </main>
  );
}

export default App;
