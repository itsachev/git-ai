import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { commitDetails, reflog } from "../../lib/ipc";
import { Brand, ModalHead } from "../../lib/modal";
import { Icon } from "../../lib/icons";
import { FileLabel, PaneNote, errorText } from "../status/Changes";
import { CommitDiff } from "../graph/History";
import { ago, openNewBranch } from "./NewBranch";

// Recent moves of HEAD (the reflog): commits, checkouts, resets, rebases, also those made outside the app.
// A commit no branch has anymore (dropped by a reset or rebase) can be brought back with a new branch.
// Opened from the sidebar's Undo history and the palette.
let open = false;
const subs = new Set<() => void>();
export const openReflog = () => { open = true; subs.forEach((f) => f()); };
const close = () => { open = false; subs.forEach((f) => f()); };

export function ReflogDialog({ path }: { path: string }) {
  const cur = useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => open);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialog.current;
    if (cur && !d?.open) d?.showModal();
    if (!cur && d?.open) d.close();
  }, [cur]);
  useEffect(() => close, []);
  return (
    <dialog ref={dialog} className="modal file-history" aria-labelledby="rl-title" onCancel={(e) => { e.preventDefault(); close(); }}>
      {cur && <Body path={path} />}
    </dialog>
  );
}

/** "reset: moving to HEAD~2" → ["Reset", "moving to HEAD~2"]; "rebase (finish): …" → ["Rebase (finish)", …]. */
function parse(action: string): [string, string] {
  const m = /^([^:]+): (.*)$/s.exec(action);
  return m ? [m[1][0].toUpperCase() + m[1].slice(1), m[2]] : [action || "Moved", ""];
}

function Body({ path }: { path: string }) {
  const log = useQuery({ queryKey: ["reflog", path], queryFn: () => reflog(path) });
  const [lostOnly, setLostOnly] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  // Index into the full list: the same commit can show up many times.
  const rows = (log.data ?? []).map((e, i) => [e, i] as const).filter(([e]) => !lostOnly || e.lost);
  const shown = rows.find(([, i]) => i === picked) ?? rows[0];
  const lost = log.data?.filter((e) => e.lost).length ?? 0;
  return (
    <div className="fh">
      <ModalHead id="rl-title" icon="history" title="Recover lost commits"
        sub={<>Where HEAD has been: every commit, checkout, reset and rebase, also ones done outside <Brand />. Branch from a commit to bring it back.</>} />
      <div className="nb-chips" role="group" aria-label="Show">
        <button type="button" className="chip" aria-pressed={!lostOnly} onClick={() => setLostOnly(false)}>All moves{log.data && ` (${log.data.length})`}</button>
        <button type="button" className="chip" aria-pressed={lostOnly} onClick={() => setLostOnly(true)}>Only lost commits{log.data && ` (${lost})`}</button>
      </div>
      <div className="fh-split">
        {log.error ? <p className="nb-hint error" role="alert">{errorText(log.error)}</p> : null}
        {log.isPending && <p className="nb-hint">Reading the reflog…</p>}
        {log.data && (
          <ol className="fh-list" aria-label="HEAD moves, newest first">
            {rows.map(([e, i]) => {
              const on = shown?.[1] === i;
              const [what, detail] = parse(e.action);
              return (
                <li key={i} className={on ? "sel" : undefined}>
                  <button type="button" className="row" aria-pressed={on} onClick={() => setPicked(i)} title={e.action}>
                    <strong>{e.lost && <span className="ci-tag lost">Lost</span>}{what}{detail && <span className="muted"> · {detail}</span>}</strong>
                    <small><span className="mono">{e.oid.slice(0, 7)}</span> · {e.subject} · {ago(e.time)}</small>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
        {shown ? <Picked key={shown[1]} path={path} oid={shown[0].oid} lost={shown[0].lost} />
          : log.data && <section className="diff"><PaneNote icon="check" title={lostOnly ? "Nothing lost" : "No moves yet"}>
              <p>{lostOnly ? "Every commit HEAD has been on is still on a branch, tag or remote branch." : "HEAD hasn't moved in this repository yet."}</p></PaneNote></section>}
      </div>
      <div className="dialog-actions">
        <button type="button" onClick={close}>Close</button>
      </div>
    </div>
  );
}

/** The picked commit: Branch from here, its files and the picked file's diff. */
function Picked({ path, oid, lost }: { path: string; oid: string; lost: boolean }) {
  const d = useQuery({ queryKey: ["commit", path, oid], queryFn: () => commitDetails(path, oid), staleTime: Infinity });
  const [file, setFile] = useState<string | null>(null);
  const shown = d.data?.files.find((f) => f.path === file) ?? d.data?.files[0];
  return (
    <div className="rl-pick">
      <div className="rl-head">
        <span>
          <strong>{d.data?.message.split("\n")[0]}</strong>
          <small className="muted">{lost ? "No branch has this commit anymore." : "Still on a branch or tag."}</small>
        </span>
        <button type="button" className={`small${lost ? " primary" : ""}`} onClick={() => openNewBranch(oid)}
          title="Start a new branch at this commit, which keeps it (and the commits before it)"><Icon name="branch" />Branch from here…</button>
      </div>
      {d.error ? <p className="nb-hint error" role="alert">{errorText(d.error)}</p> : null}
      {d.data && (
        <ul className="files" aria-label="Files this commit changed">
          {d.data.files.map((f) => {
            const on = f === shown;
            return (
              <li key={f.path} className={on ? "sel" : undefined}>
                <button className="row" aria-pressed={on} onClick={() => setFile(f.path)} title={f.orig_path ? `${f.orig_path} → ${f.path}` : f.path}><FileLabel f={f} /></button>
              </li>
            );
          })}
        </ul>
      )}
      {shown ? <CommitDiff path={path} oid={oid} file={shown.path} kind={shown.kind} />
        : d.data && <section className="diff"><PaneNote icon="info" title="No file changes"><p>This commit changes no files.</p></PaneNote></section>}
    </div>
  );
}
