import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { compareFile, compareFiles, mergeBase } from "../../lib/ipc";
import { ModalHead } from "../../lib/modal";
import { FileLabel, PaneNote, errorText, useDiffView } from "../status/Changes";
import { ReadDiff } from "./History";
import { refsQuery } from "../refs/Sidebar";
import { RefOptions } from "../refs/WriteUp";
import { Icon } from "../../lib/icons";

// Every file that differs between two branches, tags, commits or the working copy (""), and each file's diff.
// `since`: start from where the two split, so only what `to` added shows (like a pull request).
// Opened from branch and tag menus, a commit row's menu, Ctrl+click on a second commit, and the palette.
type State = { from: string; to: string; since: boolean };
let state: State | null = null;
const subs = new Set<() => void>();
export const openCompare = (from: string, to: string, since = true) => { state = { from, to, since }; subs.forEach((f) => f()); };
const close = () => { state = null; subs.forEach((f) => f()); };

const isOid = (v: string) => /^[0-9a-f]{40}$/.test(v);
const name = (v: string) => (v === "" ? "the working copy" : isOid(v) ? v.slice(0, 7) : v);

export function CompareDialog({ path }: { path: string }) {
  const cur = useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => state);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialog.current;
    if (cur && !d?.open) d?.showModal();
    if (!cur && d?.open) d.close();
  }, [cur]);
  useEffect(() => close, []);
  return (
    <dialog ref={dialog} className="modal file-history" aria-labelledby="cmp-title" onCancel={(e) => { e.preventDefault(); close(); }}>
      {cur && <Body key={JSON.stringify(cur)} path={path} initial={cur} />}
    </dialog>
  );
}

function Body({ path, initial }: { path: string; initial: State }) {
  const refs = useQuery(refsQuery(path)).data;
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [since, setSince] = useState(initial.since);
  const [picked, setPicked] = useState<string | null>(null);
  const { ws } = useDiffView();
  // The working copy isn't a commit, so it has no split point with anything.
  const canSince = !!from && !!to && from !== to;
  const useSince = since && canSince;
  // Fetched whenever there is one (not only for `since`): it also tells which side is older.
  const base = useQuery({ queryKey: ["merge-base", path, from, to], queryFn: () => mergeBase(path, from, to), enabled: canSince });
  // −/+ read as removed/added only when the old side is on the left. If `to` is behind `from` (the split point is
  // `to` itself, e.g. origin/main vs unpushed commits), swap them, once: ⇄ can still put them back.
  const flipped = useRef(false);
  const oidOf = (v: string) => (isOid(v) ? v : [...(refs?.local ?? []), ...(refs?.remote ?? []), ...(refs?.tags ?? [])].find((r) => r.name === v)?.oid);
  const toOid = oidOf(to);
  useEffect(() => {
    if (flipped.current || !base.data || !toOid || base.data !== toOid || oidOf(from) === toOid) return;
    flipped.current = true;
    setFrom(to); setTo(from);
  });
  // The `from` side actually diffed: the split point, the picked revision, or null = working copy. undefined while loading.
  const a = useSince ? base.data : from || null;
  const files = useQuery({ queryKey: ["compare-files", path, a, to], queryFn: () => compareFiles(path, a!, to || null), enabled: a !== undefined });
  const shown = files.data?.find((f) => f.path === picked) ?? files.data?.[0];
  const diff = useQuery({
    queryKey: ["compare", path, a, to, shown?.path, shown?.orig_path, ws],
    queryFn: () => compareFile(path, a!, to || null, shown!.path, ws, shown!.orig_path),
    enabled: !!shown && a !== undefined,
  });
  const n = files.data?.length;
  // Commit ids (or HEAD) it was opened with aren't in the ref lists.
  const known = new Set([...(refs?.local ?? []), ...(refs?.remote ?? []), ...(refs?.tags ?? [])].map((r) => r.name));
  const ids = [...new Set([initial.from, initial.to])].filter((v) => v && !known.has(v));
  const pick = (id: string, label: string, value: string, set: (v: string) => void) => (
    <div className="nb-field">
      <label htmlFor={id}>{label}</label>
      <div className="select">
        <select id={id} value={value} onChange={(e) => { flipped.current = true; set(e.target.value); setPicked(null); }}>
          <option value="">Working copy</option>
          {ids.map((o) => <option key={o} value={o}>{isOid(o) ? `Commit ${o.slice(0, 7)}` : o}</option>)}
          <RefOptions refs={refs} />
        </select>
        <Icon name="chevron" />
      </div>
    </div>
  );
  const error = base.error ?? files.error;
  // Diff column labels. With "only what it added" on, the old side is the split point, not `from` itself.
  const label = (v: string) => (v === "" ? "Working copy" : name(v));
  const sides: [string, string] = [useSince ? `${label(from)} where it split${base.data ? ` · ${base.data.slice(0, 7)}` : ""}` : label(from), label(to)];
  return (
    <div className="fh">
      <ModalHead id="cmp-title" icon="branch" title="Compare"
        sub={<>{useSince ? <>What <span className="mono">{name(to)}</span> changed since it split from <span className="mono">{name(from)}</span></>
          : <><span className="mono">{name(from)}</span> → <span className="mono">{name(to)}</span></>}
          {n !== undefined && ` · ${n} file${n === 1 ? "" : "s"}`}</>} />
      <div className="cmp-opts">
        <div className="fh-range">
          {pick("cmp-from", "From", from, setFrom)}
          <button type="button" className="small ghost" title="Swap sides" aria-label="Swap sides" onClick={() => { flipped.current = true; setFrom(to); setTo(from); setPicked(null); }}>⇄</button>
          {pick("cmp-to", "To", to, setTo)}
        </div>
        <label className="nb-toggle" title={canSince ? undefined : "Needs two different branches, tags or commits"}>
          <input type="checkbox" role="switch" checked={useSince} disabled={!canSince} onChange={(e) => setSince(e.target.checked)} />
          <span>
            <strong>Only what {name(to)} added</strong>
            <small className="muted">{useSince
              ? `Starts where the two split, like a pull request. Changes made on ${name(from)} since then are left out.`
              : `Every difference between the two, whichever side made it.`}</small>
          </span>
        </label>
      </div>
      <div className="fh-split">
        {error ? <p className="nb-hint error" role="alert">{errorText(error)}</p>
          : !files.data ? <p className="nb-hint">Comparing…</p>
          : (
            <ul className="files" aria-label="Changed files">
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
        {shown ? <ReadDiff file={shown.path} kind={shown.kind} data={diff.data} error={diff.error} sides={sides} />
          : files.data && <section className="diff">
            {/* Since the split point, `to` changed nothing (often: it is behind `from`). `from` may still have more. */}
            {useSince
              ? <PaneNote icon="check" title={`${name(to)} added nothing new`}>
                  <p>Since the two split, <span className="mono">{name(to)}</span> has no changes of its own. Turn off the switch above, or swap the sides, to see what <span className="mono">{name(from)}</span> has that it doesn't.</p>
                </PaneNote>
              : <PaneNote icon="check" title="No differences"><p>Both sides have the same files.</p></PaneNote>}
          </section>}
      </div>
      <div className="dialog-actions">
        <button type="button" onClick={close}>Close</button>
      </div>
    </div>
  );
}
