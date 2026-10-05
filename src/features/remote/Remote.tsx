import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { askpassReply, cloneRepo, fetchAll, pull, push } from "../../lib/ipc";
import type { AskpassPrompt } from "../../bindings/AskpassPrompt";
import type { RepoInfo } from "../../bindings/RepoInfo";
import { errorText, useRun } from "../status/Changes";
import { refsQuery } from "../refs/Sidebar";

/** Fetch / Pull / Push for the current branch (Sourcetree's toolbar), with its behind/ahead counts. */
export function SyncButtons({ path }: { path: string }) {
  const refs = useQuery(refsQuery(path)).data;
  const cur = refs?.local.find((b) => b.name === refs.head);
  const [run, error] = useRun();
  const [busy, setBusy] = useState<string | null>(null);
  const ops = [
    ["Fetch", "Fetching…", () => fetchAll(path), ""],
    ["Pull", "Pulling…", () => pull(path), cur?.behind ? `↓${cur.behind}` : ""],
    ["Push", "Pushing…", () => push(path), cur?.ahead ? `↑${cur.ahead}` : ""],
  ] as const;
  return (
    <>
      <span className="sync">
        {ops.map(([label, doing, op, count]) => (
          <button key={label} disabled={!!busy} onClick={async () => { setBusy(doing); await run(op); setBusy(null); }}>
            {busy === doing ? doing : label} {count && <small className="ab">{count}</small>}
          </button>
        ))}
      </span>
      {error && <p className="error" role="alert">{error}</p>}
    </>
  );
}

/** URL + parent folder + folder name; shows git's latest progress line while cloning. */
export function CloneForm({ onCloned }: { onCloned: (repo: RepoInfo) => void }) {
  const [url, setUrl] = useState("");
  const [parent, setParent] = useState("");
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const off = listen<string>("clone-progress", (e) => setProgress(e.payload));
    return () => { off.then((f) => f()); };
  }, []);
  // "https://host/team/repo.git" or "git@host:team/repo.git" -> "repo"
  const guess = url.trim().replace(/[\/\\]+$/, "").split(/[\/\\:]/).pop()?.replace(/\.git$/, "") ?? "";
  const folder = nameEdited ? name : guess;
  const busy = progress !== null;
  async function browse() {
    const dir = await open({ directory: true, title: "Clone into folder" });
    if (dir) setParent(dir);
  }
  async function submit() {
    setError(null);
    setProgress("Starting…");
    try {
      onCloned(await cloneRepo(url.trim(), `${parent.replace(/[\/\\]+$/, "")}/${folder}`));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setProgress(null);
    }
  }
  return (
    <form className="clone" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <label>
        Repository URL
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/user/repo.git"
          autoFocus spellCheck={false} autoComplete="off" disabled={busy} />
      </label>
      <label>
        Parent folder
        <span className="pick-dir">
          <input value={parent} onChange={(e) => setParent(e.target.value)} spellCheck={false} disabled={busy} />
          <button type="button" onClick={browse} disabled={busy}>Browse…</button>
        </span>
      </label>
      <label>
        Folder name
        <input value={folder} onChange={(e) => { setName(e.target.value); setNameEdited(true); }} spellCheck={false} disabled={busy} />
      </label>
      <div className="commit-row">
        <span className="muted progress" role="status">{progress}</span>
        <button className="primary" disabled={busy || !url.trim() || !parent.trim() || !folder.trim()}>
          {busy ? "Cloning…" : "Clone"}
        </button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </form>
  );
}

/** Credential prompts from git (GIT_ASKPASS / SSH_ASKPASS), one at a time. Cancel makes git fail. */
export function AskpassDialog() {
  const [queue, setQueue] = useState<AskpassPrompt[]>([]);
  const [value, setValue] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const off = listen<AskpassPrompt>("askpass", (e) => setQueue((q) => [...q, e.payload]));
    return () => { off.then((f) => f()); };
  }, []);
  const cur = queue[0];
  useEffect(() => {
    if (cur) dialog.current?.showModal();
    else dialog.current?.close();
  }, [cur]);
  function answer(a: string | null) {
    if (!cur) return;
    askpassReply(cur.id, a);
    setQueue((q) => q.slice(1));
    setValue("");
  }
  // Usernames and ssh's host-key yes/no question are shown; passwords and passphrases are masked.
  const plain = !!cur && /username|yes\/no/i.test(cur.prompt);
  return (
    <dialog ref={dialog} className="askpass" onCancel={(e) => { e.preventDefault(); answer(null); }}>
      {cur && (
        <form onSubmit={(e) => { e.preventDefault(); answer(value); }}>
          <p id="askpass-prompt">{cur.prompt.trim()}</p>
          <input autoFocus key={cur.id} type={plain ? "text" : "password"} aria-labelledby="askpass-prompt"
            autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />
          <div className="dialog-actions">
            <button type="button" onClick={() => answer(null)}>Cancel</button>
            <button className="primary">OK</button>
          </div>
        </form>
      )}
    </dialog>
  );
}
