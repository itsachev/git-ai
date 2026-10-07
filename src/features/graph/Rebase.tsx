import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { rebase, rebaseCommits } from "../../lib/ipc";
import type { AppError } from "../../bindings/AppError";
import type { RebaseAction } from "../../bindings/RebaseAction";
import type { RebaseCommit } from "../../bindings/RebaseCommit";
import { Icon } from "../../lib/icons";
import { ModalHead } from "../../lib/modal";
import { errorText, statusQuery, useRun } from "../status/Changes";

// Interactive rebase of the commits after `base` on the current branch. Opened from History.
let state: { base: string } | null = null;
const subs = new Set<() => void>();
export const openRebase = (base: string) => { state = { base }; subs.forEach((f) => f()); };
const close = () => { state = null; subs.forEach((f) => f()); };

export function RebaseDialog({ path }: { path: string }) {
  const cur = useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => state);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialog.current;
    if (cur && !d?.open) d?.showModal();
    if (!cur && d?.open) d.close();
  }, [cur]);
  useEffect(() => close, []);
  return (
    <dialog ref={dialog} className="modal new-branch-dialog rebase-dialog" aria-labelledby="rb-title" onCancel={(e) => { e.preventDefault(); close(); }}>
      {cur && <Form key={cur.base} path={path} base={cur.base} />}
    </dialog>
  );
}

type Row = { c: RebaseCommit; action: RebaseAction; message: string };
const ACTIONS: [RebaseAction, string][] = [["Pick", "Keep"], ["Squash", "Squash"], ["Fixup", "Fixup"], ["Drop", "Drop"]];
const subjectOf = (m: string) => m.split("\n", 1)[0];

function Form({ path, base }: { path: string; base: string }) {
  // No refetch while open: the backend refuses a stale list anyway (code "stale").
  const list = useQuery({ queryKey: ["rebase", path, base], queryFn: () => rebaseCommits(path, base), staleTime: Infinity, gcTime: 0, retry: false });
  const dirty = useQuery(statusQuery(path)).data;
  const run = useRun();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (list.data) setRows(list.data.map((c) => ({ c, action: "Pick", message: c.message }))); }, [list.data]);

  const set = (i: number, r: Partial<Row>) => setRows((rs) => rs!.map((x, k) => (k === i ? { ...x, ...r } : x)));
  const move = (i: number, d: number) => setRows((rs) => { const n = [...rs!]; [n[i], n[i + d]] = [n[i + d], n[i]]; return n; });
  const firstKept = rows?.find((r) => r.action !== "Drop");
  const problem = !rows ? null
    : !rows.length ? "No commits after this one."
    : !firstKept ? "Every commit is dropped. Keep at least one."
    : firstKept.action !== "Pick" ? "The first kept commit can't be squashed: nothing above it to meld into."
    : null;
  const changed = !!rows?.some((r, i) => r.action !== "Pick" || r.message !== r.c.message || r.c.oid !== list.data![i].oid);
  const hasChanges = !!dirty && (dirty.staged.length > 0 || dirty.unstaged.length > 0);

  async function submit() {
    if (!rows || problem || !changed) return;
    setBusy(true);
    let stopped = false;
    const ok = await run(async () => {
      try {
        await rebase(path, base, rows.map((r) => ({ oid: r.c.oid, action: r.action, message: r.message !== r.c.message && r.message.trim() ? r.message : null })));
      } catch (e) {
        stopped = (e as AppError).code === "conflicts";
        throw e;
      }
    }, `Rebased ${rows.length} commit${rows.length === 1 ? "" : "s"}`);
    setBusy(false);
    // Stopped at a conflict: the rest happens in File Status.
    if (ok || stopped) close();
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ModalHead id="rb-title" icon="history" title="Rebase interactively"
        sub={`Rewrite the commits after ${base.slice(0, 7)}. Oldest first: squash and fixup meld into the commit above.`} />

      {list.error ? <p className="nb-hint error" role="alert">{errorText(list.error)}</p> : null}
      {rows && (
        <ol className="rb-list">
          {rows.map((r, i) => {
            const id = r.c.oid;
            const reworded = r.message !== r.c.message;
            return (
              <li key={id} className={r.action === "Drop" ? "dropped" : undefined}>
                <div className="rb-row">
                  <div className="select rb-action">
                    <select aria-label={`Action for ${subjectOf(r.c.message)}`} value={r.action}
                      onChange={(e) => set(i, { action: e.target.value as RebaseAction })}>
                      {ACTIONS.map(([a, label]) => <option key={a} value={a}>{label}</option>)}
                    </select>
                    <Icon name="chevron" />
                  </div>
                  <span className="rb-text">
                    <strong>{subjectOf(r.message)}{reworded && <em> (edited)</em>}</strong>
                    <small><span className="mono">{id.slice(0, 7)}</span> · {r.c.author}</small>
                  </span>
                  <span className="rb-btns">
                    <button type="button" className="small" aria-expanded={editing === id} disabled={r.action === "Drop"}
                      onClick={() => setEditing(editing === id ? null : id)}>Message</button>
                    <button type="button" className="small icon-btn up" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><Icon name="chevron" /></button>
                    <button type="button" className="small icon-btn" aria-label="Move down" disabled={i === rows.length - 1} onClick={() => move(i, 1)}><Icon name="chevron" /></button>
                  </span>
                </div>
                {editing === id && r.action !== "Drop" && (
                  <div className="nb-field">
                    <textarea aria-label="Commit message" value={r.message} rows={4} spellCheck={false} onChange={(e) => set(i, { message: e.target.value })} />
                    <p className="nb-hint">
                      {r.action === "Pick" ? "Message of this commit" : "Message of the combined commit"}
                      {reworded && <> · <button type="button" className="link" onClick={() => set(i, { message: r.c.message })}>Reset</button></>}
                    </p>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {problem && rows && <p className="nb-hint error">{problem}</p>}
      {hasChanges && <p className="nb-hint">Your uncommitted changes are stashed during the rebase and put back after.</p>}
      <p className="nb-hint">Rewrites history: don't rebase commits others already pulled. Undo history can put the branch back.</p>

      <div className="dialog-actions">
        <button type="button" onClick={close}>Cancel</button>
        <button className="primary" disabled={!rows || !!problem || !changed || busy}>{busy ? "Rebasing…" : "Rebase"}</button>
      </div>
    </form>
  );
}
