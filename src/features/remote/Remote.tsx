import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { askpassReply, cloneRepo, fetchAll, githubRepos, gitlabRepos, pull, push } from "../../lib/ipc";
import { gitlabUserQuery, userQuery } from "../github/GitHub";
import type { GhRepo } from "../../bindings/GhRepo";
import type { AskpassPrompt } from "../../bindings/AskpassPrompt";
import type { RepoInfo } from "../../bindings/RepoInfo";
import { errorText, type Run } from "../status/Changes";
import { refsQuery } from "../refs/Sidebar";
import { Icon, type IconName } from "../../lib/icons";
import { Brand, ModalHead } from "../../lib/modal";

export type Sync = ReturnType<typeof useSync>;

/** Fetch / Pull / Push for the current branch with its behind/ahead counts; one at a time. */
export function useSync(path: string, run: Run) {
  const refs = useQuery(refsQuery(path)).data;
  const cur = refs?.local.find((b) => b.name === refs.head);
  const [busy, setBusy] = useState<string | null>(null);
  const op = (label: string, doing: string, done: string, fn: () => Promise<unknown>, count = 0, badge = count > 0 ? String(count) : "", hint = `${count} to ${label.toLowerCase()}`) => ({
    label, doing, badge, hint,
    go: async () => {
      if (busy) return;
      setBusy(doing);
      await run(fn, done);
      setBusy(null);
    },
  });
  return {
    busy,
    ops: [
      op("Fetch", "Fetching…", "Fetched all remotes", () => fetchAll(path)),
      op("Pull", "Pulling…", `Pulled ${cur?.upstream ?? "upstream"}`, () => pull(path), cur?.behind ?? 0),
      op("Push", "Pushing…", `Pushed ${refs?.head ?? "branch"}${cur?.upstream ? ` to ${cur.upstream}` : ""}`, () => push(path), cur?.ahead ?? 0,
        // No upstream: ahead is unknown (0), but the branch exists only here.
        ...(cur && !cur.upstream ? ["new", `${cur.name} isn't on the remote yet. Push publishes it.`] as const : [])),
    ],
  };
}

/** Sourcetree's toolbar buttons for `useSync`. */
export function SyncButtons({ sync, children }: { sync: Sync; children?: React.ReactNode }) {
  return (
    <span className="sync">
      {sync.ops.map((o) => (
        <button key={o.label} disabled={!!sync.busy} onClick={o.go} aria-busy={sync.busy === o.doing} title={o.label}>
          <Icon name={o.label.toLowerCase() as IconName} />
          <span className="btn-label">{sync.busy === o.doing ? o.doing : o.label}</span>
          {o.badge && <span className="count" title={o.hint}>{o.badge}</span>}
        </button>
      ))}
      {children}
    </span>
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
      <RepoPicker name="GitHub" query={userQuery} list={githubRepos} url={url} setUrl={setUrl} busy={busy} />
      <RepoPicker name="GitLab" query={gitlabUserQuery} list={gitlabRepos} url={url} setUrl={setUrl} busy={busy} />
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
    <dialog ref={dialog} className="modal askpass" aria-labelledby="askpass-title" onCancel={(e) => { e.preventDefault(); answer(null); }}>
      {cur && (
        <form onSubmit={(e) => { e.preventDefault(); answer(value); }}>
          <ModalHead id="askpass-title" icon="remote" title="Git needs your input" sub={<>Your answer goes straight to git. <Brand /> doesn't store it.</>} />
          <p id="askpass-prompt" className="modal-text">{cur.prompt.trim()}</p>
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

/** Signed in to `name`: picking one of the user's repos fills in the clone URL. */
function RepoPicker({ name, query, list, url, setUrl, busy }: {
  name: string; query: { queryKey: string[]; queryFn: () => Promise<string | null> }; list: () => Promise<GhRepo[]>;
  url: string; setUrl: (u: string) => void; busy: boolean;
}) {
  const login = useQuery(query).data;
  const repos = useQuery({ queryKey: [...query.queryKey, "repos", login], queryFn: list, enabled: !!login, staleTime: 5 * 60_000 });
  if (!login) return null;
  return (
    <label>
      Your {name} repos (@{login})
      {repos.isError ? <span className="error">{errorText(repos.error)}</span> : (
        <span className="select">
          <select value={repos.data?.some((r) => r.clone_url === url) ? url : ""} onChange={(e) => setUrl(e.target.value)}
            disabled={busy || !repos.data?.length}>
            <option value="">{repos.isPending ? "Loading…" : repos.data?.length ? "Pick a repository…" : "No repositories"}</option>
            {repos.data?.map((r) => (
              <option key={r.clone_url} value={r.clone_url}>{r.full_name}{r.private ? " (private)" : ""}</option>
            ))}
          </select>
          <Icon name="chevron" />
        </span>
      )}
    </label>
  );
}
