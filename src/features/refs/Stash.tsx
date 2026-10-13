import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { stashFiles } from "../../lib/ipc";
import { ModalHead } from "../../lib/modal";
import { FileLabel, PaneNote, errorText } from "../status/Changes";
import { CommitDiff } from "../graph/History";

// A stash's files (untracked ones too) and their diffs. Opened by clicking a stash in the sidebar.
let state: { oid: string; label: string } | null = null;
const subs = new Set<() => void>();
export const openStash = (oid: string, label: string) => { state = { oid, label }; subs.forEach((f) => f()); };
const close = () => { state = null; subs.forEach((f) => f()); };

export function StashDialog({ path }: { path: string }) {
  const cur = useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => state);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialog.current;
    if (cur && !d?.open) d?.showModal();
    if (!cur && d?.open) d.close();
  }, [cur]);
  useEffect(() => close, []);
  return (
    <dialog ref={dialog} className="modal file-history" aria-labelledby="st-title" onCancel={(e) => { e.preventDefault(); close(); }}>
      {cur && <Body key={cur.oid} path={path} oid={cur.oid} label={cur.label} />}
    </dialog>
  );
}

function Body({ path, oid, label }: { path: string; oid: string; label: string }) {
  const [picked, setPicked] = useState<string | null>(null);
  // A stash commit never changes.
  const files = useQuery({ queryKey: ["stash-files", path, oid], queryFn: () => stashFiles(path, oid), staleTime: Infinity });
  const shown = files.data?.find((f) => f.path === picked) ?? files.data?.[0];
  const n = files.data?.length;
  return (
    <div className="fh stash">
      <ModalHead id="st-title" icon="stash" title={label}
        sub={<><span className="mono">{oid.slice(0, 7)}</span>{n !== undefined && ` · ${n} file${n === 1 ? "" : "s"}`}</>} />
      <div className="fh-split">
        {files.error ? <p className="nb-hint error" role="alert">{errorText(files.error)}</p> : null}
        {files.data && (
          <ul className="files" aria-label="Stashed files">
            {files.data.map((f) => {
              const on = f === shown;
              return (
                <li key={f.path} className={on ? "sel" : undefined}>
                  <button className="row" aria-pressed={on} onClick={() => setPicked(f.path)} title={f.orig_path ? `${f.orig_path} → ${f.path}` : f.path}>
                    <FileLabel f={f} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {shown ? <CommitDiff path={path} oid={oid} file={shown.path} kind={shown.kind} stash />
          : files.data && <section className="diff"><PaneNote icon="info" title="Empty stash"><p>This stash holds no file changes.</p></PaneNote></section>}
      </div>
      <div className="dialog-actions">
        <button type="button" onClick={close}>Close</button>
      </div>
    </div>
  );
}
