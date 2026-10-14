import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "../../lib/icons";
import { FileIcon } from "../../lib/fileIcon";
import { trackedFiles } from "../../lib/ipc";
import { openFileHistory } from "../graph/FileHistory";

/** `keys` like "Ctrl+Shift+F": also a global shortcut. Ctrl means Cmd on macOS too. `git`: the terminal equivalent, shown as a hint. */
export type Command = { label: string; keys?: string; git?: string; run: () => void };
type Item = Command & { file?: boolean };

const MAX_FILES = 50;

export const OPEN = ["Ctrl+K", "Ctrl+Shift+P"];
const mac = navigator.userAgent.includes("Mac");
const show = (keys: string) => (mac ? keys.replace("Ctrl+", "⌘").replace("Shift+", "⇧") : keys);

function combo(e: KeyboardEvent) {
  const k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  return `${e.ctrlKey || e.metaKey ? "Ctrl+" : ""}${e.altKey ? "Alt+" : ""}${e.shiftKey ? "Shift+" : ""}${k}`;
}

/** Header button + Ctrl+K dialog listing `commands`, plus the repo's files at `path` (open their history);
 *  also runs the commands' shortcuts while no dialog is open. */
export function Palette({ commands, path }: { commands: Command[]; path?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  // The window listener reads the latest commands without re-subscribing on every render.
  const latest = useRef(commands);
  latest.current = commands;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // A modal (askpass, this palette) owns the keyboard while open.
      if (e.repeat || document.querySelector("dialog[open]")) return;
      const c = combo(e);
      const cmd = latest.current.find((x) => x.keys === c);
      if (!OPEN.includes(c) && !cmd) return;
      e.preventDefault();
      if (cmd) cmd.run();
      else setOpen(true);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) return dialog.current?.close();
    setQ("");
    setI(0);
    dialog.current?.showModal();
  }, [open]);

  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  // Loaded on the first typed letter; repo-changed marks it stale, refetched only while the palette is open.
  const files = useQuery({ queryKey: ["tracked-files", path], queryFn: () => trackedFiles(path!), enabled: open && !!path && !!terms.length }).data;
  const lower = useMemo(() => files?.map((f) => f.toLowerCase()), [files]);
  const shown: Item[] = commands.filter((c) => terms.every((t) => `${c.label} ${c.git ?? ""}`.toLowerCase().includes(t)));
  if (terms.length && files && lower) {
    // File name hits before folder-only hits, then shorter paths. ponytail: one substring scan per keystroke (~10 ms per 100k files).
    const hit: [number, number][] = [];
    lower.forEach((f, k) => {
      if (!terms.every((t) => f.includes(t))) return;
      const name = f.slice(f.lastIndexOf("/") + 1);
      hit.push([k, (terms.some((t) => name.includes(t)) ? 0 : 1e6) + f.length]);
    });
    hit.sort((a, b) => a[1] - b[1]);
    for (const [k] of hit.slice(0, MAX_FILES)) {
      const f = files[k];
      shown.push({ label: f, file: true, run: () => openFileHistory("HEAD", f) });
    }
  }
  const at = Math.min(i, shown.length - 1);
  useEffect(() => { document.getElementById(`cmd-${at}`)?.scrollIntoView({ block: "nearest" }); }, [at]);

  function pick(c: Item | undefined) {
    if (!c) return;
    setOpen(false);
    c.run();
  }
  function onKeyDown(e: React.KeyboardEvent) {
    const n = shown.length;
    if (e.key === "Enter") pick(shown[at]);
    else if (e.key === "ArrowDown" && n) setI((at + 1) % n);
    else if (e.key === "ArrowUp" && n) setI((at - 1 + n) % n);
    else return;
    e.preventDefault();
  }

  return (
    <>
      <button className="palette-trigger" onClick={() => setOpen(true)} title={`Command palette (${show("Ctrl+K")})`}>
        <Icon name="command" />
        <span className="btn-label">Commands</span>
        <kbd>{show("Ctrl+K")}</kbd>
      </button>
      <dialog ref={dialog} className="palette" onCancel={(e) => { e.preventDefault(); setOpen(false); }}>
        {open && (
          <>
            <label className="palette-field"><Icon name="search" /><input role="combobox" aria-expanded aria-controls="cmd-list" aria-label="Command" placeholder={path ? "Type a command or file name" : "Type a command"}
              aria-activedescendant={at >= 0 ? `cmd-${at}` : undefined} spellCheck={false} autoComplete="off"
              value={q} onChange={(e) => { setQ(e.target.value); setI(0); }} onKeyDown={onKeyDown} /></label>
            <ul id="cmd-list" role="listbox" aria-label="Commands">
              {shown.map((c, k) => {
                const slash = c.label.lastIndexOf("/");
                return (
                  <li key={(c.file ? "f:" : "c:") + c.label} id={`cmd-${k}`} role="option" aria-selected={k === at}
                    className={c.file && !shown[k - 1]?.file ? "first-file" : undefined}
                    onMouseMove={() => setI(k)} onClick={() => pick(c)}>
                    {c.file ? <>
                      <FileIcon file={c.label} />
                      <span className="path"><strong>{c.label.slice(slash + 1)}</strong>{slash > 0 && <small>{c.label.slice(0, slash)}</small>}</span>
                      <span className="cmd-hint">History</span>
                    </> : <>
                      <span className="cmd-text">
                        <span>{c.label}</span>
                        {c.git && <code title="Terminal equivalent">$ {c.git}</code>}
                      </span>
                      {c.keys && <kbd>{show(c.keys)}</kbd>}
                    </>}
                  </li>
                );
              })}
              {!shown.length && <li className="muted">{path ? "No matching command or file" : "No matching command"}</li>}
            </ul>
          </>
        )}
      </dialog>
    </>
  );
}
