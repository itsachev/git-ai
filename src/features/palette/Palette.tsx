import { useEffect, useRef, useState } from "react";
import { Icon } from "../../lib/icons";

/** `keys` like "Ctrl+Shift+F": also a global shortcut. Ctrl means Cmd on macOS too. `git`: the terminal equivalent, shown as a hint. */
export type Command = { label: string; keys?: string; git?: string; run: () => void };

const OPEN = ["Ctrl+K", "Ctrl+Shift+P"];
const mac = navigator.userAgent.includes("Mac");
const show = (keys: string) => (mac ? keys.replace("Ctrl+", "⌘").replace("Shift+", "⇧") : keys);

function combo(e: KeyboardEvent) {
  const k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  return `${e.ctrlKey || e.metaKey ? "Ctrl+" : ""}${e.altKey ? "Alt+" : ""}${e.shiftKey ? "Shift+" : ""}${k}`;
}

/** Header button + Ctrl+K dialog listing `commands`; also runs their shortcuts while no dialog is open. */
export function Palette({ commands }: { commands: Command[] }) {
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
      // In the terminal, plain Ctrl keys belong to the shell (Ctrl+K, Ctrl+R…); only Ctrl+Shift ones reach the app.
      if ((e.target as Element | null)?.closest?.(".xterm") && !c.startsWith("Ctrl+Shift+")) return;
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
  const shown = commands.filter((c) => terms.every((t) => `${c.label} ${c.git ?? ""}`.toLowerCase().includes(t)));
  const at = Math.min(i, shown.length - 1);
  useEffect(() => { document.getElementById(`cmd-${at}`)?.scrollIntoView({ block: "nearest" }); }, [at]);

  function pick(c: Command | undefined) {
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
            <label className="palette-field"><Icon name="search" /><input role="combobox" aria-expanded aria-controls="cmd-list" aria-label="Command" placeholder="Type a command"
              aria-activedescendant={at >= 0 ? `cmd-${at}` : undefined} spellCheck={false} autoComplete="off"
              value={q} onChange={(e) => { setQ(e.target.value); setI(0); }} onKeyDown={onKeyDown} /></label>
            <ul id="cmd-list" role="listbox" aria-label="Commands">
              {shown.map((c, k) => (
                <li key={c.label} id={`cmd-${k}`} role="option" aria-selected={k === at}
                  onMouseMove={() => setI(k)} onClick={() => pick(c)}>
                  <span className="cmd-text">
                    <span>{c.label}</span>
                    {c.git && <code title="Terminal equivalent">$ {c.git}</code>}
                  </span>
                  {c.keys && <kbd>{show(c.keys)}</kbd>}
                </li>
              ))}
              {!shown.length && <li className="muted">No matching command</li>}
            </ul>
          </>
        )}
      </dialog>
    </>
  );
}
