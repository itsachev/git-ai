import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { commitDetails, createBranch } from "../../lib/ipc";
import { Icon } from "../../lib/icons";
import { ModalHead } from "../../lib/modal";
import { statusQuery, useRun } from "../status/Changes";
import { refsQuery } from "./Sidebar";

// One dialog per repo view; the toolbar, the sidebar "+", branch menus and the palette open it.
// `from` = start point: null = HEAD, else a branch, remote branch or tag name.
let state: { from: string | null } | null = null;
const subs = new Set<() => void>();
export const openNewBranch = (from: string | null = null) => { state = { from }; subs.forEach((f) => f()); };
const close = () => { state = null; subs.forEach((f) => f()); };

export function NewBranchButton() {
  return (
    <button onClick={() => openNewBranch()} title="New branch (Ctrl+Shift+B)">
      <Icon name="branch" /><span className="btn-label">Branch</span>
    </button>
  );
}

const PREFIXES = ["feature/", "fix/", "chore/"];
const rel = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
export function ago(secs: number) {
  const s = secs - Date.now() / 1000;
  for (const [unit, n] of [["year", 31536000], ["month", 2592000], ["day", 86400], ["hour", 3600], ["minute", 60]] as const)
    if (Math.abs(s) >= n) return rel.format(Math.round(s / n), unit);
  return "just now";
}

/** Why git would reject `name` (git check-ref-format, the common rules), or null. */
function nameProblem(name: string, taken: Set<string>) {
  if (!name) return null;
  if (taken.has(name)) return `A branch named “${name}” already exists.`;
  if (/[\s~^:?*[\\\x00-\x1f\x7f]/.test(name)) return "Can't contain spaces or any of ~ ^ : ? * [ \\";
  if (name.startsWith("-") || name.startsWith("/") || name.startsWith(".")) return "Can't start with - / or .";
  if (/\.\.|\/\/|@\{|\/\./.test(name) || name === "@") return "Can't contain .. // @{ or a part starting with .";
  if (/[/.]$|\.lock$/.test(name)) return "Can't end with / . or .lock";
  return null;
}

export function NewBranchDialog({ path }: { path: string }) {
  const cur = useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => state);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialog.current;
    if (cur && !d?.open) d?.showModal();
    if (!cur && d?.open) d.close();
  }, [cur]);
  // Leaving the repo view while open must not leave the store set.
  useEffect(() => close, []);
  return (
    <dialog ref={dialog} className="modal new-branch-dialog" aria-labelledby="nb-title" onCancel={(e) => { e.preventDefault(); close(); }}>
      {/* Remounted per open, so the form starts fresh with the requested start point. */}
      {cur && <Form key={JSON.stringify(cur)} path={path} initial={cur.from} />}
    </dialog>
  );
}

function Form({ path, initial }: { path: string; initial: string | null }) {
  const refs = useQuery(refsQuery(path)).data;
  const status = useQuery(statusQuery(path)).data;
  const run = useRun();
  const [name, setName] = useState("");
  const [from, setFrom] = useState(initial ?? "");
  const [co, setCo] = useState(true);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const head = refs?.head ?? null;
  const all = [...(refs?.local ?? []), ...(refs?.remote ?? []), ...(refs?.tags ?? [])];
  const start = from || head;
  const oid = all.find((r) => r.name === start)?.oid;
  const commit = useQuery({ queryKey: ["commit", path, oid], queryFn: () => commitDetails(path, oid!), enabled: !!oid, staleTime: Infinity }).data;
  const isRemote = !!refs?.remote.some((r) => r.name === from);

  const taken = new Set(refs?.local.map((b) => b.name));
  const problem = nameProblem(name, taken);
  const ok = !!name && !problem && !busy;
  const changed = status ? status.staged.length + status.unstaged.length : 0;
  const cmd = `git ${co ? "switch -c" : "branch"} ${name || "<name>"}${from ? ` ${from}` : ""}`;

  // Spaces are never valid; typing one is almost always meant as a separator.
  const type = (v: string) => setName(v.replace(/\s/g, "-"));
  function prefix(p: string) {
    setName((n) => p + n.replace(new RegExp(`^(${PREFIXES.join("|")})`), ""));
    input.current?.focus();
  }
  async function submit() {
    if (!ok) return;
    setBusy(true);
    const done = await run(() => createBranch(path, name, from || null, co), co ? `Created and switched to ${name}` : `Created ${name}`);
    setBusy(false);
    if (done) close();
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ModalHead id="nb-title" icon="branch" title="New branch" sub="A branch is a movable name for a commit. Nothing is copied." />

      <div className="nb-field">
        <label htmlFor="nb-name">Name</label>
        <input id="nb-name" ref={input} autoFocus spellCheck={false} autoComplete="off" placeholder="feature/login-page"
          value={name} onChange={(e) => type(e.target.value)} aria-invalid={!!problem} aria-describedby="nb-name-hint" />
        <div className="nb-chips" role="group" aria-label="Prefix">
          {PREFIXES.map((p) => (
            <button key={p} type="button" className="chip" aria-pressed={name.startsWith(p)} onClick={() => prefix(p)}>{p}</button>
          ))}
        </div>
        <p id="nb-name-hint" className={problem ? "nb-hint error" : "nb-hint"} role={problem ? "alert" : undefined}>
          {problem ?? "Lowercase words with dashes. Use / to group, like feature/…"}
        </p>
      </div>

      <div className="nb-field">
        <label htmlFor="nb-from">Start from</label>
        <div className="select">
          <select id="nb-from" value={from} onChange={(e) => setFrom(e.target.value)}>
            <option value="">{head ? `Current branch (${head})` : "Current commit (HEAD)"}</option>
            {!!refs?.local.length && <optgroup label="Branches">{refs.local.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}</optgroup>}
            {!!refs?.remote.length && <optgroup label="Remote branches">{refs.remote.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}</optgroup>}
            {!!refs?.tags.length && <optgroup label="Tags">{refs.tags.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}</optgroup>}
          </select>
          <Icon name="chevron" />
        </div>
        {commit && (
          <div className="nb-commit">
            <span className="c-oid mono">{commit.oid.slice(0, 7)}</span>
            <span className="nb-msg" title={commit.message}>{commit.message.split("\n")[0]}</span>
            <small className="muted">{commit.author.replace(/\s*<.*>$/, "")} · {ago(commit.time)}</small>
          </div>
        )}
        {isRemote && <p className="nb-hint">Starts from the last fetched state of {from}. Fetch first for the newest commits.</p>}
      </div>

      <label className="nb-toggle">
        <input type="checkbox" role="switch" checked={co} onChange={(e) => setCo(e.target.checked)} />
        <span>
          <strong>Switch to it</strong>
          <small className="muted">
            {!co ? "Stay on the current branch." : changed ? `Your ${changed} uncommitted ${changed === 1 ? "change comes" : "changes come"} along.` : "Start working on it right away."}
          </small>
        </span>
      </label>

      <code className="nb-cmd" title="What git-ai runs">{cmd}</code>

      <div className="dialog-actions">
        <button type="button" onClick={close}>Cancel</button>
        <button className="primary" disabled={!ok}>{busy ? "Creating…" : "Create branch"}</button>
      </div>
    </form>
  );
}
