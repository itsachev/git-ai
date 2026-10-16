import { Fragment, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { askpassReply, cloneRepo, fetchAll, fetchUpstream, githubRepos, gitlabRepos, pull, push, remoteSet } from "../../lib/ipc";
import { gitlabUserQuery, userQuery } from "../github/GitHub";
import type { GhRepo } from "../../bindings/GhRepo";
import type { AskpassPrompt } from "../../bindings/AskpassPrompt";
import type { RepoInfo } from "../../bindings/RepoInfo";
import { errorText, type Run } from "../status/Changes";
import { RefMenu, refsQuery, remotesQuery, showMenu } from "../refs/Sidebar";
import { Icon, type IconName } from "../../lib/icons";
import { Brand, ModalHead, choose, confirm, prompt, type Choice } from "../../lib/modal";
import type { AppError } from "../../bindings/AppError";

export type Sync = ReturnType<typeof useSync>;
const PULL_KEY = "pull-mode";

/** Fetch / Pull / Push for the current branch with its behind/ahead counts; one at a time. */
export function useSync(path: string, run: Run) {
  const refs = useQuery(refsQuery(path)).data;
  const cur = refs?.local.find((b) => b.name === refs.head);
  const remoteList = useQuery(remotesQuery(path)).data;
  const [busy, setBusy] = useState<string | null>(null);
  // The Pull button's mode, last picked in its menu; kept in localStorage like the other per-window UI choices.
  const [rebase, setRebase] = useState(() => { try { return localStorage.getItem(PULL_KEY) === "rebase"; } catch { return false; } });
  const pickPull = (r: boolean) => {
    setRebase(r);
    try { localStorage.setItem(PULL_KEY, r ? "rebase" : "merge"); } catch { /* storage blocked */ }
  };
  useAutoFetch(path, !!cur?.upstream, busy);
  // `doing` fits the button; `notice` is the longer line for the toast ("Pushing main to origin/main…").
  const op = (label: string, doing: string, notice: string, done: string | (() => string | undefined), fn: () => Promise<unknown>, count = 0, badge = count > 0 ? String(count) : "", hint = `${count} to ${label.toLowerCase()}`) => ({
    label, doing, badge, hint, off: "",
    go: async () => {
      if (busy) return;
      setBusy(doing);
      // A background fetch holds the remote-tracking ref lock; let it finish first.
      await autoFetching.get(path);
      await run(fn, done, notice);
      setBusy(null);
    },
  });
  let pushed: string | undefined;
  const target = `${refs?.head ?? "branch"}${cur?.upstream ? ` to ${cur.upstream}` : ""}`;
  const pullMerge = op("Pull", "Pulling…", `Pulling ${cur?.upstream ?? "upstream"} into ${refs?.head ?? "your branch"}…`, `Pulled ${cur?.upstream ?? "upstream"}`, () => pull(path), cur?.behind ?? 0);
  const pullRebase = op("Pull", "Pulling…", `Pulling ${cur?.upstream ?? "upstream"} with rebase…`, `Rebased onto ${cur?.upstream ?? "upstream"}`, () => pull(path, true), cur?.behind ?? 0);
  const pushOp = op("Push", "Pushing…", `Pushing ${target}…`, () => pushed, async () => {
        pushed = undefined;
        try {
          await push(path);
          pushed = `Pushed ${target}`;
        } catch (e) {
          const code = (e as AppError).code;
          if (code !== "rejected" && code !== "rewritten") throw e;
          // "rewritten": the branch was rebased or amended after its last push, so force push is the likely fix.
          const mine = code === "rewritten";
          const pullThenPush: Choice = { label: "Pull, then push", hint: "Brings the remote's new commits into your branch, then pushes. Right when someone else pushed.", suggested: !mine };
          const force: Choice = { label: "Force push", tone: "danger", hint: "Replaces the remote's commits with yours. Right after a rebase or amend. Undo history can put them back.", suggested: mine };
          const choices = mine ? [force, pullThenPush] : [pullThenPush, force];
          const i = await choose("Push rejected", errorText(e), choices);
          if (i < 0) return;
          if (choices[i] === force) {
            if (!(await confirm(`Force push ${target}?`, "The remote's commits that you don't have are replaced with yours. Undo history (sidebar) can push them back.", "Force push", "danger"))) return;
            await push(path, true);
            pushed = `Force pushed ${target}`;
          } else {
            await pull(path);
            await push(path);
            pushed = `Pulled and pushed ${target}`;
          }
        }
      }, cur?.ahead ?? 0,
        // No upstream: ahead is unknown (0), but the branch exists only here.
        ...(cur && !cur.upstream ? ["new", `${cur.name} isn't on the remote yet. Push publishes it.`] as const : []));
  // Why Push is off, or "" when it can run. An upstream with 0 ahead is level with (or behind) the remote.
  // No upstream: nothing new when a branch on the remote Push uses (origin, else the first; as cli.rs
  // `default_remote`) already points at this tip, e.g. a branch just made from main.
  // ponytail: same-tip check only; a branch behind a remote branch still offers Push. merge-base if that matters.
  const pushTo = remoteList?.find((r) => r.name === "origin")?.name ?? remoteList?.[0]?.name;
  const pushOff = !refs?.local.length ? "Make a first commit to push"
    : !cur ? "Check out a branch to push it"
    : cur.upstream ? (cur.ahead ? "" : "Nothing to push: no new commits")
    : refs.remote.some((r) => r.oid === cur.oid && r.name.startsWith(`${pushTo}/`)) ? "Nothing to push: no new commits"
    : "";
  const pullOff = !cur ? "Check out a branch to pull into it"
    : !cur.upstream ? `${cur.name} doesn't track a remote branch yet. Push publishes it, or pick one with Track remote branch… in its menu`
    : "";
  // No remote yet: the first push asks where to, adds it as origin, then pushes (and sets the upstream).
  const firstPush = async () => {
    const v = await prompt("Push to a new remote", `${cur?.name ?? "This branch"} has nowhere to go yet. Paste the URL of the repository to push to, for example an empty one you just made on GitHub.`,
      [{ label: "Name", value: "origin", placeholder: "origin" }, { label: "URL", placeholder: "https://github.com/owner/repo.git" }], "Add and push", "remote");
    if (v && await run(() => remoteSet(path, v[0], v[1], false), `Added remote ${v[0]}`)) await pushOp.go();
  };
  return {
    busy, rebase, pickPull,
    // For "Push after commit": skips `pushOff`, whose refs predate the commit just made.
    pushNow: () => remoteList?.length === 0 ? firstPush() : pushOp.go(),
    pullMerge: pullMerge.go,
    pullRebase: pullRebase.go,
    ops: [
      op("Fetch", "Fetching…", "Fetching from all remotes…", "Fetched all remotes", () => fetchAll(path)),
      { ...(rebase ? pullRebase : pullMerge), off: pullOff },
      { ...pushOp, badge: pushOff ? "" : pushOp.badge, off: pushOff, go: () => pushOff ? Promise.resolve() : remoteList?.length === 0 ? firstPush() : pushOp.go() },
    ],
  };
}

const AUTO_FETCH_EVERY = 5 * 60_000;
const AUTO_FETCH_GAP = 60_000;
// Per repo, across tab switches (RepoView remounts): when it last ran, and the run in flight.
const autoFetched = new Map<string, number>();
const autoFetching = new Map<string, Promise<void>>();

/** Keeps behind/ahead current: fetches the branch's upstream on open, every 5 min, and on window focus,
 *  at most once a minute. Silent: skipped while hidden or busy, failures (offline, sign-in) ignored. */
function useAutoFetch(path: string, tracked: boolean, busy: string | null) {
  const qc = useQueryClient();
  const busyRef = useRef(busy);
  busyRef.current = busy;
  useEffect(() => {
    if (!tracked) return;
    const tick = () => {
      if (document.hidden || busyRef.current || autoFetching.has(path) || Date.now() - (autoFetched.get(path) ?? 0) < AUTO_FETCH_GAP) return;
      autoFetched.set(path, Date.now());
      autoFetching.set(path, fetchUpstream(path)
        .then(() => qc.invalidateQueries({ queryKey: ["refs", path] }), () => {})
        .finally(() => autoFetching.delete(path)));
    };
    tick();
    const t = setInterval(tick, AUTO_FETCH_EVERY);
    window.addEventListener("focus", tick);
    return () => { clearInterval(t); window.removeEventListener("focus", tick); };
  }, [path, tracked, qc]);
}

/** Sourcetree's toolbar buttons for `useSync`. */
export const SYNC_KEYS: Record<string, string> = { Fetch: "Ctrl+Shift+F", Pull: "Ctrl+Shift+L", Push: "Ctrl+Shift+U" };

export function SyncButtons({ sync, children }: { sync: Sync; children?: React.ReactNode }) {
  const pullPop = useRef<HTMLDivElement>(null);
  return (
    <span className="sync">
      {sync.ops.map((o) => (
        <Fragment key={o.label}>
          <button disabled={!!sync.busy || !!o.off} onClick={o.go} aria-busy={sync.busy === o.doing}
            title={o.off || `${o.label === "Pull" ? `Pull with ${sync.rebase ? "rebase" : "merge"}` : o.label} (${SYNC_KEYS[o.label]})${o.label === "Pull" ? "\nRight-click to change" : ""}`}
            onContextMenu={o.label === "Pull" ? (e) => showMenu(pullPop.current, e) : undefined}>
            <Icon name={o.label.toLowerCase() as IconName} />
            <span className="btn-label">{sync.busy === o.doing ? o.doing : o.label === "Pull" && sync.rebase ? "Pull (rebase)" : o.label}</span>
            {o.badge && <span className="count" title={o.hint}>{o.badge}</span>}
          </button>
          {o.label === "Pull" && (
            <button className="split-menu"disabled={!!sync.busy} aria-label="Pull options" title="Pull options"
              aria-haspopup="menu" onClick={(e) => showMenu(pullPop.current, e)}>
              <Icon name="chevron" />
            </button>
          )}
        </Fragment>
      ))}
      {/* Picking a mode only sets the button's default; the button itself pulls. */}
      <RefMenu pop={pullPop} label="Pull" actions={[
        [`${sync.rebase ? "" : "✓ "}Pull (merge)`, () => sync.pickPull(false)],
        [`${sync.rebase ? "✓ " : ""}Pull with rebase`, () => sync.pickPull(true)],
      ]} />
      {children}
    </span>
  );
}

/** Clone modal: URL + parent folder + folder name; shows git's latest progress line while cloning.
 *  Mounted only while open. Can't be dismissed mid-clone, so `onCloned` never fires after a close. */
export function CloneDialog({ onCloned, onClose }: { onCloned: (repo: RepoInfo) => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
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
  useEffect(() => { dialog.current?.showModal(); }, []);
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
    <dialog ref={dialog} className="modal clone-dialog" aria-labelledby="clone-title" onCancel={(e) => { e.preventDefault(); if (!busy) onClose(); }}>
      <form className="clone" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <ModalHead id="clone-title" icon="clone" title="Clone a repository" sub="Copy a remote repository into a folder on this computer." />
        <fieldset className="clone-step" disabled={busy}>
          <legend><span>1</span>Source</legend>
          <label>
            Repository URL
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/user/repo.git"
              autoFocus spellCheck={false} autoComplete="off" />
          </label>
          <div className="clone-pair">
            <RepoPicker name="GitHub" query={userQuery} list={githubRepos} url={url} setUrl={setUrl} busy={busy} />
            <RepoPicker name="GitLab" query={gitlabUserQuery} list={gitlabRepos} url={url} setUrl={setUrl} busy={busy} />
          </div>
        </fieldset>
        <fieldset className="clone-step" disabled={busy}>
          <legend><span>2</span>Destination</legend>
          <div className="clone-pair">
            <label>
              Parent folder
              <span className="pick-dir">
                <input value={parent} onChange={(e) => setParent(e.target.value)} placeholder="Choose a folder" spellCheck={false} />
                <button type="button" onClick={browse}><Icon name="folder" />Browse…</button>
              </span>
            </label>
            <label>
              Folder name
              <input value={folder} onChange={(e) => { setName(e.target.value); setNameEdited(true); }} placeholder="repo" spellCheck={false} />
            </label>
          </div>
          <p className="clone-path">{parent.trim() && folder.trim() && <>Clones into <code>{`${parent.trim().replace(/[\/\\]+$/, "")}/${folder.trim()}`}</code></>}</p>
        </fieldset>
        {error && <p className="error" role="alert">{error}</p>}
        <p className="muted progress" role="status">{progress}</p>
        <div className="dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary" disabled={busy || !url.trim() || !parent.trim() || !folder.trim()}
            title={!url.trim() ? "Enter a repository URL" : !parent.trim() ? "Choose a parent folder" : !folder.trim() ? "Enter a folder name" : undefined}>
            {busy ? "Cloning…" : "Clone"}
          </button>
        </div>
      </form>
    </dialog>
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
