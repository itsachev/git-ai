import { useEffect, useRef, useState } from "react";
import { CLEAN, MOTION, SplitText, gsap, useGSAP } from "../../lib/motion";
import { Icon, type IconName } from "../../lib/icons";
import { OPEN, type Command } from "../palette/Palette";

type Row = [keys: string, label: string];
type Area = { icon: IconName; hue: number; title: string; note: string; rows: Row[] };

/** Keys that only work in one place, so they are not palette commands. Alternatives split on " / ", keys on "+". */
const IN_PLACE: Omit<Area, "hue">[] = [
  { icon: "search", title: "Command palette", note: "While it is open.", rows: [["↑ / ↓", "Move through commands"], ["Enter", "Run the highlighted command"], ["Esc", "Close"]] },
  { icon: "changes", title: "File Status", note: "Commit box and file lists.", rows: [
    ["Ctrl+Enter", "Commit (in the message box)"],
    ["Ctrl+A", "Select every file in a list"],
    ["Shift+Click", "Select a range of files"],
    ["Ctrl+Click", "Add or remove one file"],
  ] },
  { icon: "history", title: "History", note: "Graph and commit search.", rows: [
    ["↑ / ↓", "Previous or next commit"],
    ["Page Up / Page Down", "Jump a screen of commits"],
    ["Ctrl+Click", "Compare another commit with the picked one"],
    ["Enter / Shift+Enter", "Next or previous search match"],
    ["Esc", "Clear the commit search"],
  ] },
  { icon: "more", title: "Elsewhere", note: "Forms, panels and tabs.", rows: [
    ["Enter", "Open the first match on the home screen"],
    ["Esc", "Cancel a name form, close the branches drawer"],
    ["Middle-click", "Close a repository tab"],
    ["Arrows", "Resize a focused panel divider"],
  ] },
];
const HUES = [175, 255, 145, 300, 45];

// The page is a repository view, so only an open repo can show it: it registers itself here for links outside it.
let opener: (() => void) | null = null;
export function onOpenShortcuts(f: () => void) {
  opener = f;
  return () => { if (opener === f) opener = null; };
}
export const canOpenShortcuts = () => !!opener;
export const openShortcuts = () => opener?.();

const mac = navigator.userAgent.includes("Mac");
const GLYPH: Record<string, string> = mac ? { Ctrl: "⌘", Shift: "⇧", Alt: "⌥" } : {};
const MODS = ["Ctrl", "Shift", "Alt"];
const mods = (keys: string) => MODS.filter((m) => keys.includes(`${m}+`)).join(" ").toLowerCase();

/** "Ctrl+K / Ctrl+Shift+P" as keycaps: each alternative a cap group, "or" between them. */
function Caps({ keys }: { keys: string }) {
  return (
    <span className="sc-caps" aria-label={keys.replace(/\+/g, " ").replace(/ \/ /g, " or ")}>
      {keys.split(" / ").map((alt, i) => (
        <span key={alt} className="sc-alt" aria-hidden="true">
          {i > 0 && <span className="sc-or">or</span>}
          {alt.split("+").map((k) => (
            <kbd key={k} className={`sc-cap${k.endsWith("lick") ? " mouse" : ""}`} data-k={k.toLowerCase()}>{GLYPH[k] ?? k}</kbd>
          ))}
        </span>
      ))}
    </span>
  );
}

/** Every shortcut: the palette's live commands that have keys, then the ones that only work in one place. */
export function Shortcuts({ commands }: { commands: Command[] }) {
  const root = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState("");
  const areas: Area[] = ([
    { icon: "command", title: "Anywhere", note: "In any repository view, unless a dialog is open.",
      rows: [[OPEN.join(" / "), "Open the command palette"], ...commands.filter((c) => c.keys).map((c): Row => [c.keys!, c.label])] },
    ...IN_PLACE,
  ] as Omit<Area, "hue">[]).map((a, i) => ({ ...a, hue: HUES[i] }));
  const total = areas.reduce((n, a) => n + a.rows.length, 0);
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = ([k, l]: Row) => terms.every((t) => `${l} ${k}`.toLowerCase().includes(t));
  const shown = areas.map((a) => ({ ...a, rows: a.rows.filter(hit) })).filter((a) => a.rows.length);

  // Held modifiers live in data attributes, so CSS presses the caps and dims the rest without a re-render.
  useEffect(() => {
    const el = root.current!;
    const sync = (e: KeyboardEvent) => {
      el.toggleAttribute("data-ctrl", e.ctrlKey || e.metaKey);
      el.toggleAttribute("data-shift", e.shiftKey);
      el.toggleAttribute("data-alt", e.altKey);
    };
    const clear = () => MODS.forEach((m) => el.removeAttribute(`data-${m.toLowerCase()}`));
    addEventListener("keydown", sync);
    addEventListener("keyup", sync);
    addEventListener("blur", clear);
    return () => { removeEventListener("keydown", sync); removeEventListener("keyup", sync); removeEventListener("blur", clear); };
  }, []);

  // Intro: headline out of its word masks, the hero caps drop in like struck keys, then the bands rise.
  useGSAP(() => {
    gsap.matchMedia().add(MOTION, () => {
      const words = SplitText.create(".sc-title", { type: "words", wordsClass: "w", mask: "words", aria: "auto" }).words;
      gsap.timeline({ defaults: { ease: "expo.out", duration: 0.8, clearProps: CLEAN } })
        .from(".sc-eyebrow", { opacity: 0, y: 8, duration: 0.5 })
        .from(words, { yPercent: 110, stagger: 0.055, duration: 0.9 }, 0.05)
        .from(".sc-lede, .sc-tools", { opacity: 0, y: 12, stagger: 0.08 }, 0.25)
        .from(".sc-hero-keys .sc-cap, .sc-hero-keys .sc-plus", { opacity: 0, y: -18, stagger: 0.07, ease: "back.out(2.2)", duration: 0.6 }, 0.2)
        .from(".sc-area", { opacity: 0, y: 18, stagger: 0.06 }, 0.35);
    });
  }, { scope: root });

  return (
    <div className="shortcuts" ref={root}>
      <header className="sc-hero">
        <p className="sc-eyebrow"><Icon name="command" />{total} shortcuts</p>
        <h2 className="sc-title">Every move, one keystroke away.</h2>
        <p className="sc-lede">Hold <kbd className="sc-cap" data-k="ctrl">{GLYPH.Ctrl ?? "Ctrl"}</kbd>, <kbd className="sc-cap" data-k="shift">{GLYPH.Shift ?? "Shift"}</kbd> or <kbd className="sc-cap" data-k="alt">{GLYPH.Alt ?? "Alt"}</kbd> to light up the shortcuts that use it.</p>
        <div className="sc-hero-keys" aria-hidden="true">
          <kbd className="sc-cap" data-k="ctrl">{GLYPH.Ctrl ?? "Ctrl"}</kbd><span className="sc-plus">+</span><kbd className="sc-cap" data-k="k">K</kbd>
          <span className="sc-hero-say"><b>Command palette</b><small>opens everything</small></span>
        </div>
        <label className="search sc-tools">
          <Icon name="search" />
          <input type="search" placeholder="Find a shortcut: “push”, “Ctrl+Shift”…" aria-label="Find a shortcut" spellCheck={false}
            value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape" && q) { e.preventDefault(); setQ(""); } }} />
        </label>
      </header>

      {shown.map((a) => (
        <section key={a.title} className="sc-area" style={{ "--h": a.hue } as React.CSSProperties} aria-labelledby={`sc-${a.hue}`}>
          <div className="sc-label">
            <span className="about-icon"><Icon name={a.icon} /></span>
            <h3 id={`sc-${a.hue}`}>{a.title} <small>{a.rows.length}</small></h3>
            <p>{a.note}</p>
          </div>
          <ul className="sc-rows">
            {a.rows.map(([k, l]) => (
              <li key={k + l} data-mods={mods(k)}><span>{l}</span><Caps keys={k} /></li>
            ))}
          </ul>
        </section>
      ))}
      {!shown.length && <p className="sc-empty">No shortcut matches “{q}”.</p>}
    </div>
  );
}
