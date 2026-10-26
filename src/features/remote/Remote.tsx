import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { askpassReply, cloneRepo, fetchAll, fetchUpstream, githubRepos, gitlabRepos, pull, push, remoteSet } from "../../lib/ipc";
import { gitlabUserQuery, userQuery } from "../github/GitHub";
import type { GhRepo } from "../../bindings/GhRepo";
import type { AskpassPrompt } from "../../bindings/AskpassPrompt";
import type { RepoInfo } from "../../bindings/RepoInfo";
import { errorText, type Run } from "../status/Changes";
import { RefMenu, refsQuery, remotesQuery, showMenu, usePaused } from "../refs/Sidebar";
import { Icon, type IconName } from "../../lib/icons";
import { Brand, Local, ModalHead, Remote as RemoteName, choose, confirm, prompt, type Choice } from "../../lib/modal";
import type { AppError } from "../../bindings/AppError";
import type { PushOpts } from "../../bindings/PushOpts";

export type Sync = ReturnType<typeof useSync>;
const PULL_KEY = "pull-mode";

/** Fetch / Pull / Push for the current branch with its behind/ahead counts; one at a time. */
export function useSync(path: string, run: Run) {
  const refs = useQuery(refsQuery(path)).data;
  const cur = refs?.local.find((b) => b.name === refs.head);
  const remoteList = useQuery(remotesQuery(path)).data;
  // Mid-merge/rebase: Pull and Push wait until it's finished or aborted. Fetch is still fine.
  const paused = usePaused(path);
  const [busy, setBusy] = useState<string | null>(null);
  // The Pull button's mode, last picked in its menu; kept in localStorage like the other per-window UI choices.
  const [rebase, setRebase] = useState(() => { try { return localStorage.getItem(PULL_KEY) === "rebase"; } catch { return false; } });
  const pickPull = (r: boolean) => {
    setRebase(r);
    try { localStorage.setItem(PULL_KEY, r ? "rebase" : "merge"); } catch { /* storage blocked */ }
  };
  useAutoFetch(path, !!cur?.upstream, busy);
  // `doing` fits the button; `notice` is the longer line for the toast ("Pushing main to origin/main…").
  const op = (label: string, doing: string, notice: React.ReactNode, done: React.ReactNode | (() => React.ReactNode), fn: () => Promise<unknown>, count = 0, badge = count > 0 ? String(count) : "", hint = `${count} to ${label.toLowerCase()}`) => ({
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
  let pushed: React.ReactNode;
  const head = refs?.head ? <Local name={refs.head} /> : "branch";
  const upstream = cur?.upstream ? <RemoteName name={cur.upstream} /> : "upstream";
  const target = <>{head}{cur?.upstream && <> to {upstream}</>}</>;
  const pullMerge = op("Pull", "Pulling…", <>Pulling {upstream} into {refs?.head ? head : "your branch"}…</>, <>Pulled {upstream}</>, () => pull(path), cur?.behind ?? 0);
  const pullRebase = op("Pull", "Pulling…", <>Pulling {upstream} with rebase…</>, <>Rebased onto {upstream}</>, () => pull(path, true), cur?.behind ?? 0);
  // Pull-then-push or force push, when a plain push can't land. `mine` (rebased/amended) picks the suggestion; undefined suggests neither.
  // The dialogs' command line for a push with `o` (none = to the upstream).
  const pushGit = (force: boolean, o?: PushOpts) => `git push${force ? " --force-with-lease" : ""}${o?.tags ? " --tags" : ""}${o?.remote ? ` ${o.remote} ${refs?.head}${o.branch && o.branch !== refs?.head ? `:${o.branch}` : ""}` : ""}`;
  const forcePush = async (to: React.ReactNode, opts?: PushOpts) => {
    if (!(await confirm(<>Force push {to}?</>, "The remote's commits that you don't have are replaced with yours. Undo history (sidebar) can push them back.", "Force push", "danger", pushGit(true, opts)))) return;
    await push(path, true, opts);
    pushed = <>Force pushed {to}</>;
  };
  const pushChoice = async (title: React.ReactNode, message: React.ReactNode, mine?: boolean, opts?: PushOpts) => {
    const pullThenPush: Choice = { label: "Pull, then push", icon: "pull", hint: "Brings the remote's new commits into your branch, then pushes. Right when someone else pushed.", suggested: mine === false, git: `git pull --no-rebase && ${pushGit(false, opts)}` };
    const force: Choice = { label: "Force push", icon: "push", tone: "danger", hint: "Replaces the remote's commits with yours. Right after a rebase, amend or moving the branch back. Undo history can put them back.", suggested: mine, git: pushGit(true, opts) };
    const choices = mine ? [force, pullThenPush] : [pullThenPush, force];
    const i = await choose(title, message, choices, "push", "warn");
    if (i < 0) return;
    if (choices[i] === force) {
      await forcePush(target, opts);
    } else {
      await pull(path);
      await push(path, false, opts);
      pushed = <>Pulled and pushed {target}</>;
    }
  };
  // `opts` from the Push dialog; none = a plain push to the upstream (or origin for a new branch).
  const pushWith = (opts?: PushOpts) => op("Push", "Pushing…", <>Pushing {target}…</>, () => pushed, async () => {
        pushed = undefined;
        try {
          const to = await push(path, false, opts);
          // Not on the remote before: this push created the remote branch.
          pushed = refs?.remote.some((r) => r.name === to) ? <>Pushed {head} to <RemoteName name={to} /></> : <>Created and pushed to branch <RemoteName name={to} /></>;
        } catch (e) {
          const code = (e as AppError).code;
          if (code !== "rejected" && code !== "rewritten") throw e;
          // "rewritten": the branch was rebased or amended after its last push, so force push is the likely fix.
          await pushChoice("Push rejected", errorText(e), code === "rewritten", opts);
        }
      }, cur?.ahead ?? 0,
        // No upstream: ahead is unknown (0), but the branch exists only here.
        ...(cur && !cur.upstream ? ["new", `${cur.name} isn't on the remote yet. Push publishes it.`] as const : []));
  const pushOp = pushWith();
  // Why Push is off, or "" when it can run. An upstream with 0 ahead is level with (or behind) the remote.
  // No upstream: nothing new when a branch on the remote Push uses (origin, else the first; as cli.rs
  // `default_remote`) already points at this tip, e.g. a branch just made from main.
  // ponytail: same-tip check only; a branch behind a remote branch still offers Push. merge-base if that matters.
  const pushTo = remoteList?.find((r) => r.name === "origin")?.name ?? remoteList?.[0]?.name;
  // Behind only: the branch was moved back (reset, rebase onto an older commit) or someone else pushed. A plain
  // push can't do either, so Push goes straight to the pull / force push choice.
  const behindOnly = !!cur?.upstream && !cur.ahead && !!cur.behind;
  const rewindOp = op("Push", "Pushing…", <>Pushing {target}…</>, () => pushed, async () => {
    pushed = undefined;
    const n = cur?.behind ?? 0;
    await pushChoice(<>{upstream} is ahead of {head}</>, <>
      <span className="diverge" role="img" aria-label={`${cur?.upstream} has ${n} commit${n === 1 ? "" : "s"} that ${refs?.head} doesn't`}>
        <code>{refs?.head}</code>
        <span className="diverge-track"><i />{Array.from({ length: Math.min(n, 4) }, (_, k) => <i key={k} />)}{n > 4 && <b>+{n - 4}</b>}</span>
        <code>{cur?.upstream}</code>
      </span>
      {upstream} has {n} commit{n === 1 ? "" : "s"} that {head} doesn't. Moved {head} back on purpose? Force push makes the remote match. Someone else pushed? Pull instead.
    </>);
  }, 0, "↺", `${cur?.upstream} has commits ${refs?.head} doesn't: pull, or force push to move the remote back`);
  const pushOff = paused ? paused
    : !refs?.local.length ? "Make a first commit to push"
    : !cur ? "Check out a branch to push it"
    : cur.upstream ? (cur.ahead || behindOnly ? "" : "Nothing to push: no new commits")
    : refs.remote.some((r) => r.oid === cur.oid && r.name.startsWith(`${pushTo}/`)) ? "Nothing to push: no new commits"
    : "";
  const pullOff = paused ? paused
    : !cur ? "Check out a branch to pull into it"
    : !cur.upstream ? `${cur.name} doesn't track a remote branch yet. Push publishes it, or pick one with Track remote branch… in its menu`
    : "";
  // No remote yet: the first push asks where to, adds it as origin, then pushes (and sets the upstream).
  // Asking and pushing are separate steps so Push after commit can ask before it commits.
  const askRemote = () => prompt("Push to a new remote", <>{cur ? <Local name={cur.name} /> : "This branch"} has nowhere to go yet. Paste the URL of the repository to push to, for example an empty one you just made on GitHub.</>,
    [{ label: "Name", value: "origin", placeholder: "origin" }, { label: "URL", placeholder: "https://github.com/owner/repo.git" }], "Add and push", "remote",
    (v) => `git remote add ${v[0] || "<name>"} ${v[1] || "<url>"} && git push -u ${v[0] || "<name>"} ${cur?.name ?? "HEAD"}`);
  const addRemoteAndPush = async (v: string[]) => { if (await run(() => remoteSet(path, v[0], v[1], false), `Added remote ${v[0]}`)) await pushOp.go(); };
  const firstPush = async () => { const v = await askRemote(); if (v) await addRemoteAndPush(v); };
  // The Push button: the dialog first, then a force push, the pull / force push choice (behind only, to the
  // upstream), or a plain push with the picked options.
  const upRemote = cur?.upstream && remoteList?.map((r) => r.name).filter((r) => cur.upstream!.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0];
  const askDialog = async () => !cur || !remoteList?.length ? null : askPush({
    branch: cur.name, remotes: remoteList.map((r) => r.name), ahead: cur.ahead, behind: cur.behind, upstream: cur.upstream ?? null,
    remote: upRemote || pushTo!, to: upRemote ? cur.upstream!.slice(upRemote.length + 1) : cur.name,
  });
  const pushAnswer = ({ force, ...opts }: PushAnswer) => {
    const to = <>{head} to <RemoteName name={`${opts.remote}/${opts.branch}`} /></>;
    if (force) return op("Push", "Pushing…", <>Force pushing {to}…</>, () => <>Force pushed {to}</>, () => push(path, true, opts)).go();
    if (behindOnly && `${opts.remote}/${opts.branch}` === cur?.upstream && !opts.tags) return rewindOp.go();
    return pushWith(opts).go();
  };
  const pushDialog = async () => { const a = await askDialog(); if (a) await pushAnswer(a); };
  return {
    busy, rebase, pickPull,
    /** For "Push after commit", before it commits: asks first where a push needs asking (no remote yet, or the
     *  Push dialog for a branch not on the remote yet), so Cancel commits nothing either. Resolves the push to
     *  run once the commit lands, or null on Cancel. Skips `pushOff`, whose refs predate the commit. */
    planPush: async (): Promise<(() => Promise<unknown>) | null> => {
      if (remoteList?.length === 0) { const v = await askRemote(); return v && (() => addRemoteAndPush(v)); }
      if (cur && !cur.upstream) { const a = await askDialog(); return a && (() => pushAnswer(a)); }
      return pushOp.go;
    },
    pullMerge: pullMerge.go,
    pullRebase: pullRebase.go,
    ops: [
      op("Fetch", "Fetching…", "Fetching from all remotes…", "Fetched all remotes", () => fetchAll(path)),
      { ...(rebase ? pullRebase : pullMerge), off: pullOff },
      behindOnly ? { ...rewindOp, off: paused, badge: paused ? "" : rewindOp.badge, go: () => paused || busy ? Promise.resolve() : pushDialog() }
        : { ...pushOp, badge: pushOff ? "" : pushOp.badge, off: pushOff, go: () => pushOff || busy ? Promise.resolve() : remoteList?.length === 0 ? firstPush() : pushDialog() },
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
    <>
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
    </>
  );
}

// Push dialog: where the current branch goes and how. `remote` / `to` are the defaults (upstream, else origin + same name).
type PushAsk = { branch: string; remotes: string[]; remote: string; to: string; upstream: string | null; ahead: number; behind: number };
type PushAnswer = PushOpts & { remote: string; branch: string; force: boolean };
let pushAsk: (PushAsk & { resolve: (a: PushAnswer | null) => void }) | null = null;
const pushSubs = new Set<() => void>();
const answerPush = (a: PushAnswer | null) => { pushAsk?.resolve(a); pushAsk = null; pushSubs.forEach((f) => f()); };
/** Resolves the picked options, or null on Cancel or Esc. */
function askPush(ask: PushAsk) {
  pushAsk?.resolve(null);
  return new Promise<PushAnswer | null>((resolve) => { pushAsk = { ...ask, resolve }; pushSubs.forEach((f) => f()); });
}

/** Mounted at the app root, outside the toolbar and the repo view's `.lock` fieldset: opened in the same frame the
 *  fieldset re-enables (Commit & push), a dialog inside it left the whole stage unlaid-out (blank) in WebView2. */
export function PushDialog() {
  const cur = useSyncExternalStore((f) => { pushSubs.add(f); return () => { pushSubs.delete(f); }; }, () => pushAsk);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialog.current;
    if (cur && !d?.open) d?.showModal();
    if (!cur && d?.open) d.close();
  }, [cur]);
  useEffect(() => () => answerPush(null), []);
  return (
    <dialog ref={dialog} className="modal new-branch-dialog" aria-labelledby="push-title" onCancel={(e) => { e.preventDefault(); answerPush(null); }}>
      {cur && <PushForm key={cur.branch + cur.remote + cur.to} ask={cur} />}
    </dialog>
  );
}

function PushForm({ ask }: { ask: PushAsk }) {
  const [remote, setRemote] = useState(ask.remote);
  const [to, setTo] = useState(ask.to);
  const [track, setTrack] = useState(!ask.upstream);
  const [tags, setTags] = useState(false);
  const [force, setForce] = useState(false);
  const dst = to.trim();
  const target = `${remote}/${dst}`;
  const toUpstream = target === ask.upstream;
  const bad = !dst || /[\s~^:?*[\\]|\.\.|^[-/.]|[/.]$|\.lock$/.test(dst);
  const n = ask.ahead;
  // Pushing to the upstream already tracks it: no switch, and no -u.
  const setsUpstream = track && !toUpstream;
  const cmd = `git push${force ? " --force-with-lease" : ""}${setsUpstream ? " -u" : ""}${tags ? " --tags" : ""} ${remote} ${ask.branch}${dst && dst !== ask.branch ? `:${dst}` : ""}`;
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (!bad) answerPush({ remote, branch: dst, track: setsUpstream, tags, force }); }}>
      <ModalHead id="push-title" icon="push" title={<>Push <Local name={ask.branch} /></>}
        sub={!ask.upstream ? "Not on a remote yet. Pushing publishes it."
          : toUpstream ? `${n ? `${n} commit${n === 1 ? "" : "s"} to push` : "No new commits"}${ask.behind ? `, ${ask.behind} on the remote you don't have` : ""}.`
          : <>Tracks <RemoteName name={ask.upstream} /></>} />
      <div className="push-target">
        <div className="nb-field">
          <label htmlFor="push-remote">Remote</label>
          <div className="select">
            <select id="push-remote" value={remote} onChange={(e) => setRemote(e.target.value)}>
              {ask.remotes.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <Icon name="chevron" />
          </div>
        </div>
        <div className="nb-field">
          <label htmlFor="push-to">Branch on the remote</label>
          <input id="push-to" autoFocus spellCheck={false} autoComplete="off" value={to} onChange={(e) => setTo(e.target.value.replace(/\s/g, "-"))} aria-invalid={!!dst && bad} />
        </div>
      </div>
      {!toUpstream && <label className="nb-toggle">
        <input type="checkbox" role="switch" checked={track} onChange={(e) => setTrack(e.target.checked)} />
        <span>
          <strong>Track it</strong>
          <small className="muted">{track ? <>Pull and Push use <RemoteName name={target} /> from now on.</> : ask.upstream ? <>Keeps tracking <RemoteName name={ask.upstream} />.</> : "Push without setting an upstream."}</small>
        </span>
      </label>}
      <label className="nb-toggle">
        <input type="checkbox" role="switch" checked={tags} onChange={(e) => setTags(e.target.checked)} />
        <span>
          <strong>Push all tags</strong>
          <small className="muted">Sends every local tag the remote doesn't have yet.</small>
        </span>
      </label>
      <label className="nb-toggle danger">
        <input type="checkbox" role="switch" checked={force} onChange={(e) => setForce(e.target.checked)} />
        <span>
          <strong>Force push</strong>
          <small className="muted">Replaces the remote branch with yours, only if nobody pushed since your last fetch. Undo history can put it back.</small>
        </span>
      </label>
      <code className="nb-cmd" title="What git-ai runs">{cmd}</code>
      <div className="dialog-actions">
        <button type="button" onClick={() => answerPush(null)}>Cancel</button>
        <button className={force ? "danger" : "primary"} disabled={bad}>{force ? "Force push" : "Push"}</button>
      </div>
    </form>
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
        <code className="nb-cmd" title="What git-ai runs">{`git clone --recurse-submodules ${url.trim() || "<url>"} ${parent.trim() && folder.trim() ? `"${parent.trim().replace(/[\/\\]+$/, "")}/${folder.trim()}"` : "<folder>"}`}</code>
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
    <dialog ref={dialog} className="modal alert askpass" aria-labelledby="askpass-title" onCancel={(e) => { e.preventDefault(); answer(null); }}>
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
