import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ask } from "@tauri-apps/plugin-dialog";
import { aiCommitMessage, abortOp, applyLines, commit, discard, fileDiff, headMessage, openFile, opLog, repoStatus, resolve, stage, undo, unstage, workFile } from "../../lib/ipc";
import type { FileChange } from "../../bindings/FileChange";
import type { AppError } from "../../bindings/AppError";
import type { LineOp } from "../../bindings/LineOp";
import type { OpEntry } from "../../bindings/OpEntry";
import { Icon } from "../../lib/icons";
import { Splitter } from "../../lib/splitter";
import { aiKeyQuery, openSettings } from "../settings/Settings";

export const statusQuery = (path: string) => ({ queryKey: ["status", path], queryFn: () => repoStatus(path) });
export const opLogQuery = (path: string) => ({ queryKey: ["oplog", path], queryFn: () => opLog(path) });

type Selection = { file: string; staged: boolean };
export type Run = (op: () => Promise<unknown>, done?: string) => Promise<boolean>;

export const errorText = (e: unknown) => (e as AppError).message ?? String(e);
// A staged rename also needs its old path to be unstaged.
export const pathsOf = (files: FileChange[]) => files.flatMap((f) => (f.orig_path ? [f.path, f.orig_path] : [f.path]));
const confirmDiscard = (what: string) =>
  ask(`Discard changes to ${what}? A backup is kept, use Undo history to restore it.`, { title: "Discard changes", kind: "warning" });

/** `run(op)` runs a git op, refreshes right away (the watcher would too, 300 ms later).
 * A failure shows in `OpErrorDialog` until OK. */
let opGen = 0;
let opError: { title: string; text: string } | null = null;
const opSubs = new Set<() => void>();
const subscribeOps = (f: () => void) => { opSubs.add(f); return () => { opSubs.delete(f); }; };

// `run(op, done)`: on success `done` ("Pushed main") shows in `Notice` until the next op or for a few seconds.
let notice: { text: string; gen: number } | null = null;

export function useRun() {
  const qc = useQueryClient();
  async function run(op: () => Promise<unknown>, done?: string) {
    const mine = ++opGen;
    notice = null;
    opSubs.forEach((f) => f());
    try {
      await op();
      if (done && mine === opGen) {
        notice = { text: done, gen: mine };
        opSubs.forEach((f) => f());
      }
      return true;
    } catch (e) {
      opError = { title: (e as { title?: string }).title ?? "Something went wrong", text: errorText(e) };
      opSubs.forEach((f) => f());
      return false;
    } finally {
      qc.invalidateQueries();
    }
  }
  return run;
}

/** Modal for the last failed op; OK (or Esc) dismisses it. */
export function OpErrorDialog() {
  const err = useSyncExternalStore(subscribeOps, () => opError);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (err) dialog.current?.showModal();
    else dialog.current?.close();
  }, [err]);
  const close = () => { opError = null; opSubs.forEach((f) => f()); };
  return (
    <dialog ref={dialog} className="op-error" role="alertdialog" aria-labelledby="op-error-title" aria-describedby="op-error-text"
      onCancel={(e) => { e.preventDefault(); close(); }}>
      <form method="dialog" onSubmit={(e) => { e.preventDefault(); close(); }}>
        <h2 id="op-error-title"><Icon name="warn" />{err?.title}</h2>
        <p id="op-error-text">{err?.text}</p>
        <div className="dialog-actions"><button className="primary" autoFocus>OK</button></div>
      </form>
    </dialog>
  );
}

/** Short success line for the last op (`run`'s `done`); fades out after 4 s. */
export function Notice() {
  // The snapshot must be `notice` itself: a success changes it but not `opGen`.
  const shown = useSyncExternalStore(subscribeOps, () => notice);
  const [hidden, setHidden] = useState<number | null>(null);
  const cur = shown && hidden !== shown.gen ? shown : null;
  useEffect(() => {
    if (!cur) return;
    const t = setTimeout(() => setHidden(cur.gen), 4000);
    return () => clearTimeout(t);
  }, [cur]);
  return <p className="notice" role="status">{cur && <span key={cur.gen}><Icon name="check" />{cur.text}</span>}</p>;
}

export function Changes({ path }: { path: string }) {
  const { data, error } = useQuery(statusQuery(path));
  const [sel, setSel] = useState<Selection | null>(null);
  const run = useRun();

  async function discardFiles(files: FileChange[]) {
    if (await confirmDiscard(files.length === 1 ? files[0].path : `${files.length} files`)) run(() => discard(path, pathsOf(files)));
  }

  if (error) return <p className="error" role="alert">{errorText(error)}</p>;
  if (!data) return null;
  const empty = !data.staged.length && !data.unstaged.length && !data.conflicted.length;
  // Drop the selection once the file leaves its list (e.g. after staging it).
  const shown = sel && (sel.staged ? data.staged : [...data.unstaged, ...data.conflicted]).some((f) => f.path === sel.file);
  const conflicted = !!sel && !sel.staged && data.conflicted.some((f) => f.path === sel.file);

  const list = { sel, onSelect: setSel };
  return (
    <div className="changes">
      <div className="side">
        {data.operation && (
          <div className="banner" role="status">
            <Icon name="warn" />
            <span>
              {data.operation[0].toUpperCase() + data.operation.slice(1)} in progress.{" "}
              {data.conflicted.length ? "Resolve the conflicts, then commit." : "Commit to finish it."}
            </span>
            <button className="small" onClick={async () => {
              if (await ask(`Abort the ${data.operation}? Changed files are backed up first (Undo history).`, { title: "Abort", kind: "warning" }))
                run(() => abortOp(path));
            }}>Abort</button>
          </div>
        )}
        <div className="lists">
        {empty ? (
          <p className="empty"><Icon name="changes" />Nothing to commit, working tree clean.</p>
        ) : (
          <>
            <FileList {...list} title="Conflicts" files={data.conflicted} staged={false}
              action="Mark resolved" onAction={(fs) => run(() => stage(path, pathsOf(fs)))} />
            <FileList {...list} title="Staged" files={data.staged} staged
              action="Unstage" onAction={(fs) => run(() => unstage(path, pathsOf(fs)))} />
            <FileList {...list} title="Changes" files={data.unstaged} staged={false}
              action="Stage" onAction={(fs) => run(() => stage(path, pathsOf(fs)))} onDiscard={discardFiles} />
          </>
        )}
        <History path={path} run={run} />
        </div>
        <CommitBox path={path} canCommit={data.staged.length > 0} finishing={!!data.operation} run={run}
          onCommit={(msg, amend) => run(() => commit(path, msg, amend))} />
      </div>
      <Splitter name="side-w" axis="x" label="Resize file list" />
      {conflicted ? <Conflict path={path} file={sel.file} run={run} /> : <Diff path={path} sel={shown ? sel : null} run={run} />}
    </div>
  );
}

/** `finishing`: a merge/cherry-pick is in progress; committing finishes it, an empty message uses git's. */
type CommitProps = { path: string; canCommit: boolean; finishing: boolean; run: Run; onCommit: (msg: string, amend: boolean) => Promise<boolean> };

function CommitBox({ path, canCommit, finishing, run, onCommit }: CommitProps) {
  const [msg, setMsg] = useState("");
  const [amend, setAmend] = useState(false);
  const [busy, setBusy] = useState(false);
  const [writing, setWriting] = useState(false);
  const hasKey = useQuery(aiKeyQuery).data;
  // Generates from the staged diff only, so not for amend (the message would miss HEAD's changes) or merges.
  async function generate() {
    if (!hasKey) return openSettings();
    setWriting(true);
    await run(async () => {
      try {
        setMsg(await aiCommitMessage(path));
      } catch (e) {
        if ((e as AppError).code === "ai_key") openSettings();
        throw e;
      }
    });
    setWriting(false);
  }
  const head = useQuery({ queryKey: ["head", path], queryFn: () => headMessage(path) }).data;
  // Amend may just reword, so it doesn't need staged changes.
  // A merge commit may have nothing staged (all conflicts resolved to "ours").
  const ready = amend ? msg.trim() !== "" : finishing || (canCommit && msg.trim() !== "");
  const ok = ready && !busy;
  function toggleAmend(on: boolean) {
    setAmend(on);
    if (on && !msg.trim() && head) setMsg(head);
    if (!on && msg === head) setMsg("");
  }
  async function submit() {
    if (!ok) return;
    setBusy(true);
    if (await onCommit(msg, amend)) {
      setMsg("");
      setAmend(false);
    }
    setBusy(false);
  }
  return (
    <form className="commit" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <textarea
        id="commit-msg"
        aria-label="Commit message"
        placeholder={finishing ? "Leave empty to use git's message (Ctrl+Enter to commit)" : "Commit message (Ctrl+Enter to commit)"}
        value={msg}
        rows={3}
        onChange={(e) => setMsg(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit(); }}
      />
      <div className="commit-row">
        <button type="button" className="small" disabled={!canCommit || amend || finishing || writing} onClick={generate}
          title={hasKey ? "Write a message from the staged changes (sent to Gemini)" : "Add a Gemini API key in Settings first"}>
          {writing ? "Writing…" : "Generate message"}
        </button>
        <label className="check">
          <input type="checkbox" checked={amend} disabled={!head || finishing} onChange={(e) => toggleAmend(e.target.checked)} />
          Amend last commit
        </label>
        <button className="primary" disabled={!ok}>{busy ? "Committing…" : amend ? "Amend" : "Commit"}</button>
      </div>
    </form>
  );
}

type ListProps = {
  title: string;
  files: FileChange[];
  staged: boolean;
  action: string;
  onAction: (files: FileChange[]) => void;
  onDiscard?: (files: FileChange[]) => void;
  sel: Selection | null;
  onSelect: (s: Selection) => void;
};

function FileList({ title, files, staged, action, onAction, onDiscard, sel, onSelect }: ListProps) {
  if (!files.length) return null;
  return (
    <section>
      <div className="list-head">
        <h2>{title} <span className="count">{files.length}</span></h2>
        {onDiscard && <button className="small" onClick={() => onDiscard(files)}>Discard all</button>}
        <button className="small" onClick={() => onAction(files)}>{action} all</button>
      </div>
      <ul className="files">
        {files.map((f) => {
          const slash = f.path.lastIndexOf("/");
          const selected = sel?.file === f.path && sel.staged === staged;
          return (
            <li key={f.path} className={selected ? "sel" : undefined}>
              <button className="row" aria-pressed={selected} onClick={() => onSelect({ file: f.path, staged })}
                title={f.orig_path ? `${f.orig_path} → ${f.path}` : f.path}>
                <span className={`kind ${kindClass(f.kind)}`}>{f.kind}</span>
                <span className="path">
                  <strong>{f.path.slice(slash + 1)}</strong>
                  {slash > 0 && <small>{f.path.slice(0, slash)}</small>}
                </span>
              </button>
              {onDiscard && <button className="small" onClick={() => onDiscard([f])}>Discard</button>}
              <button className="small" onClick={() => onAction([f])}>{action}</button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** A conflicted file with its markers, plus whole-file resolutions. Edits in between happen in an editor. */
function Conflict({ path, file, run }: { path: string; file: string; run: Run }) {
  const { data, error } = useQuery({ queryKey: ["work", path, file], queryFn: () => workFile(path, file) });
  let side: "" | "ours" | "base" | "theirs" = "";
  return (
    <section className="diff">
      <div className="diff-bar">
        <span>Conflict in <strong>{file}</strong></span>
        <button className="small" onClick={() => run(() => resolve(path, [file], "Ours"))}
          title="Keep the current branch's version (backed up first)">Take ours</button>
        <button className="small" onClick={() => run(() => resolve(path, [file], "Theirs"))}
          title="Keep the incoming version (backed up first)">Take theirs</button>
        <button className="small" onClick={() => run(() => openFile(path, file))}>Open file</button>
        <button className="small" onClick={() => run(() => stage(path, [file]))}>Mark resolved</button>
      </div>
      <p className="muted legend">
        <span className="ours">Ours</span> = current branch, <span className="theirs">theirs</span> = incoming.
        Edit the file to combine them, then Mark resolved.
      </p>
      {error ? <p className="error" role="alert">{errorText(error)}</p>
        : data === null ? <p className="muted">Binary file or larger than 1 MB, take a side or open it.</p>
        : data !== undefined && (
          <pre aria-label={`Conflicts in ${file}`}>
            {data.replace(/\n$/, "").split("\n").map((l, i) => {
              // Marker lines switch the region; diff3 style adds a "|||||||" base section.
              const marker = /^(<{7}|\|{7}|={7}|>{7})( |$)/.exec(l)?.[1][0];
              if (marker) side = marker === "<" ? "ours" : marker === "|" ? "base" : marker === "=" ? "theirs" : "";
              return <div key={i} className={marker ? "marker" : side}>{l || " "}</div>;
            })}
          </pre>
        )}
    </section>
  );
}

type DiffProps = { path: string; sel: Selection | null; run: Run };

function Diff({ path, sel, run }: DiffProps) {
  const { data, error } = useQuery({
    queryKey: ["diff", path, sel?.file, sel?.staged],
    queryFn: () => fileDiff(path, sel!.file, sel!.staged),
    enabled: !!sel,
  });
  // Picked +/- lines, as indices into the diff text's lines (what `applyLines` expects).
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  useEffect(() => {
    setPicked(new Set());
    setAnchor(null);
  }, [data, sel?.file, sel?.staged]);

  if (!sel) return <section className="diff muted">Select a file to see its changes.</section>;
  if (error) return <section className="diff error" role="alert">{errorText(error)}</section>;
  if (data === undefined) return <section className="diff" />;
  if (data === null) return <section className="diff muted">Binary file or larger than 1 MB, no inline diff.</section>;
  const all = data.replace(/\n$/, "").split("\n");
  // Skip the "diff --git / index / --- / +++" header; hunks start at the first "@@".
  const start = all.findIndex((l) => l.startsWith("@@"));
  if (start < 0) return <section className="diff muted">No content changes.</section>;

  const file = sel.file;
  const isChange = (i: number) => all[i][0] === "+" || all[i][0] === "-";
  const ops: [LineOp, string][] = sel.staged ? [["Unstage", "Unstage"]] : [["Stage", "Stage"], ["Discard", "Discard"]];
  async function apply(op: LineOp, lines: number[], what: string) {
    if (op === "Discard" && !(await confirmDiscard(`${what} in ${file}`))) return;
    run(() => applyLines(path, file, op, lines));
  }
  function hunkLines(h: number) {
    const out = [];
    for (let i = h + 1; i < all.length && !all[i].startsWith("@@"); i++) if (isChange(i)) out.push(i);
    return out;
  }
  function toggle(i: number, range: boolean) {
    const next = new Set(picked);
    const on = !picked.has(i);
    const [a, b] = range && anchor !== null ? [Math.min(anchor, i), Math.max(anchor, i)] : [i, i];
    for (let j = a; j <= b; j++) if (isChange(j)) on ? next.add(j) : next.delete(j);
    setPicked(next);
    setAnchor(i);
  }

  // ponytail: renders every line (≤ 1 MB file); virtualize if big diffs feel slow.
  return (
    <section className="diff">
      <div className="diff-bar">
        {picked.size ? (
          <>
            <span>{picked.size} line{picked.size > 1 ? "s" : ""} selected</span>
            {ops.map(([op, label]) => (
              <button key={op} className="small" onClick={() => apply(op, [...picked], "the selected lines")}>{label} lines</button>
            ))}
            <button className="small" onClick={() => setPicked(new Set())}>Clear</button>
          </>
        ) : (
          <span className="muted">Click changed lines to select them, Shift+click for a range.</span>
        )}
      </div>
      <pre aria-label={`Diff of ${file}`}>
        {lineNumbers(all, start).map(([o, n], k) => {
          const i = start + k;
          const l = all[i];
          if (l.startsWith("@@"))
            return (
              <div key={i} className="hunk">
                {ops.map(([op, label]) => (
                  <button key={op} className="small" onClick={() => apply(op, hunkLines(i), "this hunk")}>{label} hunk</button>
                ))}
                {l}
              </div>
            );
          if (!isChange(i)) return <div key={i}><Gutter o={o} n={n} />{l || " "}</div>;
          const on = picked.has(i);
          return (
            <div key={i} role="checkbox" aria-checked={on}
              className={`${l[0] === "+" ? "add" : "del"} pick${on ? " on" : ""}`}
              onMouseDown={(e) => e.shiftKey && e.preventDefault()} // no text selection on Shift+click
              onClick={(e) => toggle(i, e.shiftKey)}>
              <Gutter o={o} n={n} />{l}
            </div>
          );
        })}
      </pre>
    </section>
  );
}

/** Old/new line numbers for each diff line from `start` (the first "@@ -a,b +c,d @@"); "" where a side has none. */
export function lineNumbers(lines: string[], start: number) {
  let o = 0, n = 0;
  return lines.slice(start).map((l): [number | "", number | ""] => {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(l);
    if (h) { o = +h[1]; n = +h[2]; return ["", ""]; }
    if (l[0] === "+") return ["", n++];
    if (l[0] === "-") return [o++, ""];
    if (l[0] === "\\") return ["", ""]; // "\ No newline at end of file"
    return [o++, n++];
  });
}

export const Gutter = ({ o, n }: { o: number | ""; n: number | "" }) => <span className="ln" aria-hidden="true"><span>{o}</span><span>{n}</span></span>;

function History({ path, run }: { path: string; run: Run }) {
  const { data } = useQuery(opLogQuery(path));
  if (!data?.length) return null;
  return (
    <details className="history">
      <summary><Icon name="undo" />Undo history <span className="count">{data.length}</span></summary>
      <ul className="files">
        {data.map((e) => (
          <li key={e.id}>
            <span className="path">
              <strong>{opLabel(e)}</strong>
              <small>{new Date(Number(e.id)).toLocaleString()}</small>
            </span>
            <button className="small" onClick={() => run(() => undo(path, e.id))}>Undo</button>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function opLabel(e: OpEntry): string {
  // "undo undo x" re-applies x: odd depth = Undo, even = Redo.
  const depth = e.op.match(/^(undo )*/)![0].length / 5;
  if (depth) return `${depth % 2 ? "Undo" : "Redo"}: ${opLabel({ ...e, op: e.op.slice(depth * 5) })}`;
  const what = e.paths.length === 1 ? e.paths[0] : `${e.paths.length} files`;
  const name = e.ref_name?.replace(/^refs\/(heads|tags)\//, "");
  const labels: Record<string, string> = {
    discard: `Discard ${what}`,
    amend: "Amend commit",
    merge: "Merge",
    "cherry-pick": "Cherry-pick",
    "delete branch": `Delete branch ${name}`,
    "delete tag": `Delete tag ${name}`,
    "drop stash": "Drop stash",
  };
  if (e.op.startsWith("take ")) return `${e.op[0].toUpperCase()}${e.op.slice(1)} for ${what}`;
  if (e.op.startsWith("abort ")) return `Abort ${e.op.slice(6)} (backup of ${what})`;
  return labels[e.op] ?? e.op;
}

// Two letters = conflict; "?" = untracked (shown like an add).
export const kindClass = (k: string) => (k.length > 1 ? "k-X" : k === "?" ? "k-A" : `k-${k}`);
