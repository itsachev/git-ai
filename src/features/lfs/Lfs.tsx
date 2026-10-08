import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { lfs, lfsPull, lfsTrack } from "../../lib/ipc";
import { ModalHead } from "../../lib/modal";
import { errorText, useRun } from "../status/Changes";

export const lfsQuery = (path: string) => ({ queryKey: ["lfs", path], queryFn: () => lfs(path) });

// One dialog per repo view; the palette and the binary-file diff open it. `pattern` prefills the Track field.
let state: { pattern: string } | null = null;
const subs = new Set<() => void>();
export const openLfs = (pattern = "") => { state = { pattern }; subs.forEach((f) => f()); };
const close = () => { state = null; subs.forEach((f) => f()); };

/** "art/logo.psd" -> "*.psd"; "" for files without an extension. */
export const lfsPatternFor = (file: string) => {
  const name = file.slice(file.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `*${name.slice(dot)}` : "";
};

export function LfsDialog({ path }: { path: string }) {
  const cur = useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => state);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialog.current;
    if (cur && !d?.open) d?.showModal();
    if (!cur && d?.open) d.close();
  }, [cur]);
  useEffect(() => close, []);
  return (
    <dialog ref={dialog} className="modal lfs-dialog" aria-labelledby="lfs-title" onCancel={(e) => { e.preventDefault(); close(); }}>
      <ModalHead id="lfs-title" icon="stash" title="Git LFS" sub="Large files live on the LFS server; the repository keeps small pointers." />
      {cur && <Body key={JSON.stringify(cur)} path={path} initial={cur.pattern} />}
      <div className="dialog-actions"><button onClick={close}>Close</button></div>
    </dialog>
  );
}

function Body({ path, initial }: { path: string; initial: string }) {
  const { data, error, refetch } = useQuery(lfsQuery(path));
  const [pattern, setPattern] = useState(initial);
  const [pulling, setPulling] = useState(false);
  const run = useRun();
  if (error) return <p className="error" role="alert">{errorText(error)}</p>;
  if (!data) return null;
  if (!data.installed)
    return (
      <section className="setting">
        <p>Git LFS isn't installed. Install it, then check again.</p>
        <div className="row">
          <button className="primary" onClick={() => openUrl("https://git-lfs.com")}>Get Git LFS</button>
          <button onClick={() => refetch()}>Check again</button>
        </div>
      </section>
    );
  const track = async (e: React.FormEvent) => {
    e.preventDefault();
    const p = pattern.trim();
    if (p && await run(() => lfsTrack(path, p, true), `Tracking ${p} with LFS`)) setPattern("");
  };
  return (
    <>
      <section className="setting">
        <h3>Tracked patterns</h3>
        <p className="muted">Matching files go to LFS when you stage them. This edits .gitattributes, so commit it too.</p>
        {data.patterns.length ? (
          <ul className="lfs-list">
            {data.patterns.map((p) => (
              <li key={p}>
                <code>{p.split("[[:space:]]").join(" ")}</code>
                <button className="small" onClick={() => run(() => lfsTrack(path, p, false), `Stopped tracking ${p}`)}>Untrack</button>
              </li>
            ))}
          </ul>
        ) : <p>No patterns yet.</p>}
        <form className="row" onSubmit={track}>
          <input aria-label="Pattern to track" placeholder="*.psd" value={pattern} onChange={(e) => setPattern(e.target.value)} autoFocus />
          <button className="primary" disabled={!pattern.trim()}>Track</button>
        </form>
      </section>
      <section className="setting">
        <h3>Files</h3>
        <p className="muted">Download the LFS content of checked-out files that still show as pointers.</p>
        <button disabled={pulling} onClick={async () => {
          setPulling(true);
          await run(() => lfsPull(path), "Downloaded LFS files");
          setPulling(false);
        }}>{pulling ? "Downloading…" : "Download LFS files"}</button>
      </section>
    </>
  );
}
