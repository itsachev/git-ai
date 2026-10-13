import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { stashFiles, stashSave } from "../../lib/ipc";
import type { StashMode } from "../../bindings/StashMode";
import type { FileChange } from "../../bindings/FileChange";
import { ModalHead } from "../../lib/modal";
import { FileLabel, PaneNote, errorText, statusQuery, useRun } from "../status/Changes";
import { CommitDiff } from "../graph/History";

// "Stash changes": name, which changes, and whether to keep them in place. Opened by the toolbar Stash button,
// or from File Status with picked files (`paths`, empty = every file).
let saving: string[] | null = null;
const saveSubs = new Set<() => void>();
export const openStashSave = (paths: string[] = []) => { saving = paths; saveSubs.forEach((f) => f()); };
const closeSave = () => { saving = null; saveSubs.forEach((f) => f()); };

export function StashSaveDialog({ path }: { path: string }) {
  const open = useSyncExternalStore((f) => { saveSubs.add(f); return () => { saveSubs.delete(f); }; }, () => saving);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialog.current;
    if (open && !d?.open) d?.showModal();
    if (!open && d?.open) d.close();
  }, [open]);
  useEffect(() => closeSave, []);
  return (
    <dialog ref={dialog} className="modal stash-save-dialog" aria-labelledby="ss-title" onCancel={(e) => { e.preventDefault(); closeSave(); }}>
      {open && <SaveForm key={open.join("\n")} path={path} paths={open} />}
    </dialog>
  );
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function SaveForm({ path, paths }: { path: string; paths: string[] }) {
  const status = useQuery(statusQuery(path)).data;
  const only = new Set(paths);
  const mine = (fs: FileChange[] = []) => (paths.length ? fs.filter((f) => only.has(f.path)) : fs);
  const run = useRun();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [keep, setKeep] = useState(false);
  const staged = mine(status?.staged).length;
  const untracked = mine(status?.unstaged).filter((f) => f.kind === "?").length;
  // A file can be both staged and changed again: count it once.
  const tracked = new Set([...mine(status?.staged), ...mine(status?.unstaged).filter((f) => f.kind !== "?")].map((f) => f.path)).size;
  const modes: [StashMode, string, number, string, string][] = [
    ["All", "Everything", tracked + untracked, "-u", "All changes, new files included."],
    ["Tracked", "Tracked only", tracked, "", "Changed files git already knows. New files stay."],
    ["Staged", "Staged only", staged, "--staged", "Only what's staged. Everything else stays."],
  ];
  // Git mishandles --staged with paths (see `cli::stash_save`).
  if (paths.length) modes.pop();
  // Status may arrive after the first render: default from it until a mode is picked.
  const [pickedMode, setMode] = useState<StashMode | null>(null);
  const mode = pickedMode ?? (tracked + untracked || paths.length ? "All" : "Staged");
  const [, , count, flag, hint] = modes.find((m) => m[0] === mode)!;
  const branch = status?.branch ?? "HEAD";
  const msg = name.trim();
  const pathArgs = paths.length ? ` -- ${paths.length > 3 ? `${paths.slice(0, 3).join(" ")} …` : paths.join(" ")}` : "";
  const cmd = `git stash push ${flag}${flag && " "}${msg ? `-m "${msg}"` : ""}`.trim() + pathArgs + (keep ? " && git stash apply --index" : "");

  async function submit() {
    if (!count || busy) return;
    setBusy(true);
    const label = msg || `WIP on ${branch}`;
    const done = await run(() => stashSave(path, msg, mode, keep, paths), keep ? `Saved checkpoint “${label}”. Your changes are still here` : `Stashed ${plural(count, "file")} as “${label}”`);
    setBusy(false);
    if (done) closeSave();
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ModalHead id="ss-title" icon="stash" title={paths.length ? `Stash ${plural(paths.length, "file")}` : "Stash changes"}
        sub={paths.length ? <span title={paths.join("\n")}>Only the files you picked. Other changes stay.</span> : "Set work aside without committing. Apply or pop it later from Stashes in the sidebar."} />

      <div className="nb-field">
        <label htmlFor="ss-name">Name</label>
        <input id="ss-name" autoFocus spellCheck={false} autoComplete="off" placeholder={`WIP on ${branch}`} maxLength={200}
          value={name} onChange={(e) => setName(e.target.value)} aria-describedby="ss-name-hint" />
        <p id="ss-name-hint" className="nb-hint">Say what the work is, so you can find it later. Empty uses “WIP on {branch}”.</p>
      </div>

      <div className="nb-field">
        <span className="label" id="ss-what">What to stash</span>
        <div className="seg" role="group" aria-labelledby="ss-what">
          {modes.map(([m, label, n]) => (
            <button key={m} type="button" aria-pressed={mode === m} disabled={!n} onClick={() => setMode(m)}>{label} ({n})</button>
          ))}
        </div>
        <p className="nb-hint">{hint}</p>
      </div>

      <label className="nb-toggle">
        <input type="checkbox" role="switch" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
        <span>
          <strong>Keep changes in my files</strong>
          <small className="muted">{keep ? "Saves a checkpoint and leaves your work as it is." : "The stashed changes leave your files."}</small>
        </span>
      </label>

      <code className="nb-cmd" title="What git-ai runs">{cmd}</code>

      <div className="dialog-actions">
        <button type="button" onClick={closeSave}>Cancel</button>
        <button className="primary" disabled={!count || busy}>{busy ? "Stashing…" : keep ? "Save checkpoint" : "Stash"}</button>
      </div>
    </form>
  );
}

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
