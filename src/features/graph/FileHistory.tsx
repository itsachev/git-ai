import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { blame, compareFile, fileLog } from "../../lib/ipc";
import { ModalHead } from "../../lib/modal";
import { errorText } from "../status/Changes";
import { ago } from "../refs/NewBranch";
import { CommitDiff, ReadDiff } from "./History";
import { refsQuery } from "../refs/Sidebar";
import { RefOptions } from "../refs/WriteUp";
import { Icon } from "../../lib/icons";
import { Lines, widest } from "../../lib/Lines";

// History, blame and branch compare of one file as of `rev` (an oid, or "HEAD" from File Status).
// Opened from a file in a commit's file list, or by right-clicking a file in File Status.
type Tab = "history" | "blame" | "compare";
let state: { rev: string; file: string; tab: Tab } | null = null;
const subs = new Set<() => void>();
export const openFileHistory = (rev: string, file: string, tab: Tab = "history") => { state = { rev, file, tab }; subs.forEach((f) => f()); };
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
      {cur && <Body key={cur.rev + cur.file + cur.tab} path={path} rev={cur.rev} file={cur.file} initial={cur.tab} />}
    </dialog>
  );
}

function Body({ path, rev, file, initial }: { path: string; rev: string; file: string; initial: Tab }) {
  const [tab, setTab] = useState(initial);
  const [picked, setPicked] = useState<string | null>(null);
  // An oid never changes; "HEAD" is refetched on repo-changed like every query.
  const log = useQuery({ queryKey: ["file-log", path, rev, file], queryFn: () => fileLog(path, rev, file), staleTime: Infinity });
  const shown = log.data?.find((c) => c.oid === picked) ?? log.data?.[0];
  const name = file.slice(file.lastIndexOf("/") + 1);
  const show = (oid: string) => { setPicked(oid); setTab("history"); };
  // A commit picked from Blame may be far down the list.
  const selRow = useRef<HTMLLIElement>(null);
  useEffect(() => { selRow.current?.scrollIntoView({ block: "nearest" }); }, [shown, tab]);

  return (
    <div className="fh">
      <ModalHead id="fh-title" icon="history" title={name} sub={<><span className="mono">{file}</span> as of <span className="mono">{rev === "HEAD" ? "HEAD" : rev.slice(0, 7)}</span></>} />
      <div className="nb-chips" role="group" aria-label="Show">
        <button type="button" className="chip" aria-pressed={tab === "history"} onClick={() => setTab("history")}>
          History{log.data && ` (${log.data.length === 2000 ? "2000+" : log.data.length})`}
        </button>
        <button type="button" className="chip" aria-pressed={tab === "blame"} onClick={() => setTab("blame")}>Blame</button>
        <button type="button" className="chip" aria-pressed={tab === "compare"} onClick={() => setTab("compare")}>Compare</button>
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
                  <li key={c.oid} ref={on ? selRow : undefined} className={on ? "sel" : undefined}>
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
      ) : tab === "blame" ? (
        <BlameView path={path} rev={rev} file={file} onPick={show} focus={shown?.oid} />
      ) : (
        <CompareView path={path} rev={rev} file={file} />
      )}
      <div className="dialog-actions">
        <button type="button" onClick={close}>Close</button>
      </div>
    </div>
  );
}

/** The file on two branches, tags or the working copy ("" in the pickers). */
function CompareView({ path, rev, file }: { path: string; rev: string; file: string }) {
  const refs = useQuery(refsQuery(path)).data;
  // Default: another branch → what was open (the working copy from File Status, else the commit).
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState(rev === "HEAD" ? "" : rev);
  const a = from ?? (refs && (refs.local.find((b) => b.name !== refs.head)?.name ?? refs.head ?? "HEAD"));
  const diff = useQuery({
    queryKey: ["compare", path, a, to, file],
    queryFn: () => compareFile(path, a || null, to || null, file),
    enabled: a != null,
  });
  const name = (v: string) => (v === "" ? "working copy" : v === rev ? rev.slice(0, 7) : v);
  const pick = (id: string, label: string, value: string, set: (v: string) => void) => (
    <div className="nb-field">
      <label htmlFor={id}>{label}</label>
      <div className="select">
        <select id={id} value={value} onChange={(e) => set(e.target.value)}>
          <option value="">Working copy</option>
          {rev !== "HEAD" && <option value={rev}>This commit ({rev.slice(0, 7)})</option>}
          <RefOptions refs={refs} />
        </select>
        <Icon name="chevron" />
      </div>
    </div>
  );
  return (
    <div className="fh-compare">
      <div className="fh-range">
        {pick("fh-from", "From", a ?? "", setFrom)}
        <button type="button" className="small ghost" title="Swap sides" aria-label="Swap sides" disabled={a == null}
          onClick={() => { setFrom(to); setTo(a!); }}>⇄</button>
        {pick("fh-to", "To", to, setTo)}
      </div>
      <p className="nb-hint"><span className="del-mark">−</span> lines only on {name(a ?? "")}, <span className="add-mark">+</span> lines only on {name(to)}.</p>
      <ReadDiff file={file} data={diff.data} error={diff.error} />
    </div>
  );
}

/** `focus`: the commit picked in History; its first lines scroll to the top. */
function BlameView({ path, rev, file, onPick, focus }: { path: string; rev: string; file: string; onPick: (oid: string) => void; focus?: string }) {
  const { data, error } = useQuery({ queryKey: ["blame", path, rev, file], queryFn: () => blame(path, rev, file), staleTime: Infinity });
  if (error) return <section className="diff error" role="alert">{errorText(error)}</section>;
  if (!data) return <p className="nb-hint">Blaming… (long-lived files can take a few seconds)</p>;
  if (data.text === null) return <section className="diff muted">Binary file or larger than 1 MB, no blame.</section>;
  const lines = data.text.replace(/\n$/, "").split("\n");
  // Hunk of each line (line n is index n - 1).
  const of = new Int32Array(lines.length);
  data.hunks.forEach((h, k) => of.fill(k, h.start - 1, h.start - 1 + h.lines));
  const focused = data.hunks.find((h) => h.oid === focus);
  return (
    <section className="diff">
      <Lines key={file} className="fh-blame" label={`Blame of ${file}`} n={lines.length} width={widest(lines) + 30} at={focused && focused.start - 1}
        row={(j) => {
          const k = of[j], h = data.hunks[k], first = j === h.start - 1;
          return (
            <div key={j} className={`${k % 2 ? "alt" : ""}${first ? " first" : ""}`}>
              <span className="who">
                {first && (
                  <button type="button" className="link" title={`${h.subject}\nShow this commit's change`} onClick={() => onPick(h.oid)}>
                    <span className="mono">{h.oid.slice(0, 7)}</span> {h.author} · {ago(h.time)}
                  </button>
                )}
              </span>
              <span className="ln" aria-hidden="true"><span>{j + 1}</span></span>
              {lines[j] || " "}
            </div>
          );
        }} />
    </section>
  );
}
