import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { blame, fileLog } from "../../lib/ipc";
import { ModalHead } from "../../lib/modal";
import { errorText } from "../status/Changes";
import { ago } from "../refs/NewBranch";
import { CommitDiff } from "./History";

// History and blame of one file as of commit `rev`. Opened from a file in a commit's file list.
let state: { rev: string; file: string } | null = null;
const subs = new Set<() => void>();
export const openFileHistory = (rev: string, file: string) => { state = { rev, file }; subs.forEach((f) => f()); };
const close = () => { state = null; subs.forEach((f) => f()); };

export function FileHistoryDialog({ path }: { path: string }) {
  const cur = useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => state);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialog.current;
    if (cur && !d?.open) d?.showModal();
    if (!cur && d?.open) d.close();
  }, [cur]);
  useEffect(() => close, []);
  return (
    <dialog ref={dialog} className="modal file-history" aria-labelledby="fh-title" onCancel={(e) => { e.preventDefault(); close(); }}>
      {cur && <Body key={cur.rev + cur.file} path={path} rev={cur.rev} file={cur.file} />}
    </dialog>
  );
}

function Body({ path, rev, file }: { path: string; rev: string; file: string }) {
  const [tab, setTab] = useState<"history" | "blame">("history");
  const [picked, setPicked] = useState<string | null>(null);
  // `rev` is an oid, so neither answer can change while open.
  const log = useQuery({ queryKey: ["file-log", path, rev, file], queryFn: () => fileLog(path, rev, file), staleTime: Infinity });
  const shown = log.data?.find((c) => c.oid === picked) ?? log.data?.[0];
  const name = file.slice(file.lastIndexOf("/") + 1);
  const show = (oid: string) => { setPicked(oid); setTab("history"); };

  return (
    <div className="fh">
      <ModalHead id="fh-title" icon="history" title={name} sub={<><span className="mono">{file}</span> as of <span className="mono">{rev.slice(0, 7)}</span></>} />
      <div className="nb-chips" role="group" aria-label="Show">
        <button type="button" className="chip" aria-pressed={tab === "history"} onClick={() => setTab("history")}>
          History{log.data && ` (${log.data.length === 2000 ? "2000+" : log.data.length})`}
        </button>
        <button type="button" className="chip" aria-pressed={tab === "blame"} onClick={() => setTab("blame")}>Blame</button>
      </div>
      {tab === "history" ? (
        <div className="fh-split">
          {log.error ? <p className="nb-hint error" role="alert">{errorText(log.error)}</p> : null}
          {log.isPending && <p className="nb-hint">Walking the history…</p>}
          {log.data && (
            <ol className="fh-list" aria-label="Commits that changed this file">
              {log.data.map((c) => {
                const on = c === shown;
                return (
                  <li key={c.oid} className={on ? "sel" : undefined}>
                    <button type="button" className="row" aria-pressed={on} onClick={() => setPicked(c.oid)}>
                      <strong>{c.subject}</strong>
                      <small><span className="mono">{c.oid.slice(0, 7)}</span> · {c.author} · {ago(c.time)}</small>
                      {c.path !== file && <small>as <span className="mono">{c.path}</span></small>}
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
          {shown && <CommitDiff path={path} oid={shown.oid} file={shown.path} />}
        </div>
      ) : (
        <BlameView path={path} rev={rev} file={file} onPick={show} />
      )}
      <div className="dialog-actions">
        <button type="button" onClick={close}>Close</button>
      </div>
    </div>
  );
}

function BlameView({ path, rev, file, onPick }: { path: string; rev: string; file: string; onPick: (oid: string) => void }) {
  const { data, error } = useQuery({ queryKey: ["blame", path, rev, file], queryFn: () => blame(path, rev, file), staleTime: Infinity });
  if (error) return <section className="diff error" role="alert">{errorText(error)}</section>;
  if (!data) return <p className="nb-hint">Blaming… (long-lived files can take a few seconds)</p>;
  if (data.text === null) return <section className="diff muted">Binary file or larger than 1 MB, no blame.</section>;
  const lines = data.text.replace(/\n$/, "").split("\n");
  // ponytail: renders every line (≤ 1 MB file), like the diff view; virtualize if big files feel slow.
  return (
    <section className="diff">
      <pre className="fh-blame" aria-label={`Blame of ${file}`}>
        {data.hunks.flatMap((h, k) =>
          Array.from({ length: h.lines }, (_, i) => {
            const n = h.start + i;
            return (
              <div key={n} className={`${k % 2 ? "alt" : ""}${i === 0 ? " first" : ""}`}>
                <span className="who">
                  {i === 0 && (
                    <button type="button" className="link" title={`${h.subject}\nShow this commit's change`} onClick={() => onPick(h.oid)}>
                      <span className="mono">{h.oid.slice(0, 7)}</span> {h.author} · {ago(h.time)}
                    </button>
                  )}
                </span>
                <span className="ln" aria-hidden="true"><span>{n}</span></span>
                {lines[n - 1] || " "}
              </div>
            );
          }),
        )}
      </pre>
    </section>
  );
}
