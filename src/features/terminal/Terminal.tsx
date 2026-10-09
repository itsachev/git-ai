import { useEffect, useRef } from "react";
import { Channel } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { ptyClose, ptyOpen, ptyResize, ptyWrite, terminals } from "../../lib/ipc";
import { Icon } from "../../lib/icons";
import { errorText } from "../status/Changes";

export const terminalsQuery = { queryKey: ["terminals"], queryFn: terminals, staleTime: Infinity };
/** Mirrors `terminal::BUILT_IN`. */
export const BUILT_IN = "Built-in panel";

/** xterm's default ANSI colors are made for dark backgrounds (PowerShell's yellow/white vanish on white): darker ones, all readable on white. */
const LIGHT_ANSI = {
  black: "#1f2328", red: "#c4252a", green: "#1a7f37", yellow: "#8a6100", blue: "#0550ae", magenta: "#8250df", cyan: "#0e7490", white: "#57606a",
  brightBlack: "#6e7781", brightRed: "#a40e26", brightGreen: "#116329", brightYellow: "#6f4b00", brightBlue: "#0a3069", brightMagenta: "#6639ba", brightCyan: "#155e75", brightWhite: "#24292f",
};

/** xterm colors from the app's tokens, so the panel follows light/dark. */
function colors() {
  const css = getComputedStyle(document.documentElement);
  const v = (k: string) => css.getPropertyValue(k).trim();
  const base = { background: v("--panel"), foreground: v("--fg"), cursor: v("--accent"), selectionBackground: `${v("--accent")}55` };
  return document.documentElement.dataset.theme === "light" ? { ...base, ...LIGHT_ANSI } : base;
}

/** A shell in the repo folder, under the current view. Closing it (or `exit`) ends the shell. */
export function TerminalPanel({ path, onClose }: { path: string; onClose: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const t = new Terminal({ fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--mono"), fontSize: 13, cursorBlink: true, theme: colors() });
    const fit = new FitAddon();
    t.loadAddon(fit);
    t.open(host.current!);
    fit.fit();
    t.focus();
    // Light/dark switches (also the OS's, under "system") flip data-theme on <html>.
    const themed = new MutationObserver(() => { t.options.theme = colors(); });
    themed.observe(document.documentElement, { attributeFilter: ["data-theme"] });
    // Ctrl+C copies when text is selected (else it interrupts, as usual); Ctrl+V pastes via the browser.
    // Ctrl+Shift keys are the app's shortcuts (Ctrl+Shift+T closes the panel), not the shell's.
    t.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown" || !e.ctrlKey) return true;
      const k = e.key.toLowerCase();
      if (k === "c" && t.hasSelection()) {
        navigator.clipboard.writeText(t.getSelection()).catch(() => {});
        t.clearSelection();
        return false;
      }
      return k !== "v" && !e.shiftKey;
    });

    let id: number | null = null;
    let gone = false;
    const out = new Channel<string | null>();
    // After cleanup (closed, or StrictMode's dev remount) the killed shell's "exited" must not close the new panel.
    out.onmessage = (s) => {
      if (gone) return;
      if (s === null) close.current();
      else t.write(s);
    };
    // Input before the id arrives is queued: on Windows the shell's first output asks for the cursor position,
    // xterm answers at once, and the shell waits for that answer.
    let queued = "";
    const send = (d: string) => { if (id === null) queued += d; else ptyWrite(id, d).catch(() => {}); };
    ptyOpen(path, t.cols, t.rows, out)
      .then((n) => {
        if (gone) return ptyClose(n);
        id = n;
        if (queued) send(queued);
        queued = "";
      })
      .catch((e) => t.write(`\x1b[31m${errorText(e)}\x1b[0m\r\n`));
    const input = t.onData(send);
    const ro = new ResizeObserver(() => {
      fit.fit();
      if (id !== null) ptyResize(id, t.cols, t.rows).catch(() => {});
    });
    ro.observe(host.current!);
    return () => {
      gone = true;
      ro.disconnect();
      themed.disconnect();
      input.dispose();
      if (id !== null) ptyClose(id);
      t.dispose();
    };
  }, [path]);

  return (
    <section className="term-panel" aria-label="Terminal">
      <header>
        <Icon name="terminal" />
        <strong>Terminal</strong>
        <span className="muted mono" title={path}>{path}</span>
        <button className="icon-btn" onClick={onClose} aria-label="Close terminal" title="Close terminal (Ctrl+Shift+T)"><Icon name="chevron" /></button>
      </header>
      <div ref={host} className="term-host" />
    </section>
  );
}
