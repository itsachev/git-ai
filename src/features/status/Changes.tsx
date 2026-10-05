import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ask } from "@tauri-apps/plugin-dialog";
import { commit, discard, fileDiff, repoStatus, stage, unstage } from "../../lib/ipc";
import type { FileChange } from "../../bindings/FileChange";
import type { AppError } from "../../bindings/AppError";

export const statusQuery = (path: string) => ({ queryKey: ["status", path], queryFn: () => repoStatus(path) });

type Selection = { file: string; staged: boolean };

const errorText = (e: unknown) => (e as AppError).message ?? String(e);
// A staged rename also needs its old path to be unstaged.
const pathsOf = (files: FileChange[]) => files.flatMap((f) => (f.orig_path ? [f.path, f.orig_path] : [f.path]));

export function Changes({ path }: { path: string }) {
  const qc = useQueryClient();
  const { data, error } = useQuery(statusQuery(path));
  const [sel, setSel] = useState<Selection | null>(null);
  const [opError, setOpError] = useState<string | null>(null);

  /** Runs a git op, shows its error, refreshes right away (the watcher would too, 300 ms later). */
  async function run(op: () => Promise<unknown>) {
    setOpError(null);
    try {
      await op();
      return true;
    } catch (e) {
      setOpError(errorText(e));
      return false;
    } finally {
      qc.invalidateQueries();
    }
  }

  async function confirmDiscard(files: FileChange[]) {
    const what = files.length === 1 ? files[0].path : `${files.length} files`;
    const ok = await ask(`Discard changes to ${what}? A backup is kept under refs/git-ai/backup.`, {
      title: "Discard changes",
      kind: "warning",
    });
    if (ok) run(() => discard(path, pathsOf(files)));
  }

  if (error) return <p className="error" role="alert">{errorText(error)}</p>;
  if (!data) return null;
  const empty = !data.staged.length && !data.unstaged.length && !data.conflicted.length;
  // Drop the selection once the file leaves its list (e.g. after staging it).
  const shown = sel && (sel.staged ? data.staged : [...data.unstaged, ...data.conflicted]).some((f) => f.path === sel.file);

  const list = { sel, onSelect: setSel };
  return (
    <div className="changes">
      <div className="side">
        <CommitBox canCommit={data.staged.length > 0} onCommit={(msg) => run(() => commit(path, msg))} />
        {opError && <p className="error" role="alert">{opError}</p>}
        {empty ? (
          <p className="muted">Nothing to commit, working tree clean.</p>
        ) : (
          <>
            <FileList {...list} title="Conflicts" files={data.conflicted} staged={false}
              action="Mark resolved" onAction={(fs) => run(() => stage(path, pathsOf(fs)))} />
            <FileList {...list} title="Staged" files={data.staged} staged
              action="Unstage" onAction={(fs) => run(() => unstage(path, pathsOf(fs)))} />
            <FileList {...list} title="Changes" files={data.unstaged} staged={false}
              action="Stage" onAction={(fs) => run(() => stage(path, pathsOf(fs)))} onDiscard={confirmDiscard} />
          </>
        )}
      </div>
      <Diff path={path} sel={shown ? sel : null} />
    </div>
  );
}

function CommitBox({ canCommit, onCommit }: { canCommit: boolean; onCommit: (msg: string) => Promise<boolean> }) {
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const ready = canCommit && msg.trim() !== "" && !busy;
  async function submit() {
    if (!ready) return;
    setBusy(true);
    if (await onCommit(msg)) setMsg("");
    setBusy(false);
  }
  return (
    <form className="commit" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <textarea
        aria-label="Commit message"
        placeholder="Commit message (Ctrl+Enter to commit)"
        value={msg}
        rows={3}
        onChange={(e) => setMsg(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit(); }}
      />
      <button className="primary" disabled={!ready}>{busy ? "Committing…" : "Commit"}</button>
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
        <h2>{title} ({files.length})</h2>
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

function Diff({ path, sel }: { path: string; sel: Selection | null }) {
  const { data, error } = useQuery({
    queryKey: ["diff", path, sel?.file, sel?.staged],
    queryFn: () => fileDiff(path, sel!.file, sel!.staged),
    enabled: !!sel,
  });
  if (!sel) return <section className="diff muted">Select a file to see its changes.</section>;
  if (error) return <section className="diff error" role="alert">{errorText(error)}</section>;
  if (data === undefined) return <section className="diff" />;
  if (data === null) return <section className="diff muted">Binary file or larger than 1 MB, no inline diff.</section>;
  // Skip the "diff --git / index / --- / +++" header; hunks start at the first "@@".
  const start = data.indexOf("\n@@");
  if (start < 0) return <section className="diff muted">No content changes.</section>;
  // ponytail: renders every line (≤ 1 MB file); virtualize if big diffs feel slow.
  const lines = data.slice(start + 1).replace(/\n$/, "").split("\n");
  return (
    <section className="diff">
      <pre aria-label={`Diff of ${sel.file}`}>
        {lines.map((l, i) => (
          <div key={i} className={l.startsWith("@@") ? "hunk" : l[0] === "+" ? "add" : l[0] === "-" ? "del" : undefined}>{l || " "}</div>
        ))}
      </pre>
    </section>
  );
}

// Two letters = conflict; "?" = untracked (shown like an add).
const kindClass = (k: string) => (k.length > 1 ? "k-X" : k === "?" ? "k-A" : `k-${k}`);
