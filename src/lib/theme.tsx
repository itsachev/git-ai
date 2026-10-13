import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Icon } from "./icons";

export type Theme = "system" | "light" | "dark";
const THEMES: Theme[] = ["system", "light", "dark"];
const NAME = { system: "System", light: "Light", dark: "Dark" } as const;
const ICON = { system: "monitor", light: "sun", dark: "moon" } as const;
const NEXT = { system: "light", light: "dark", dark: "system" } as const;
// A UI preference read before first paint (index.html), so localStorage rather than the settings store.
const KEY = "theme";
const dark = matchMedia("(prefers-color-scheme: dark)");

function saved(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return t === "light" || t === "system" ? t : "dark";
  } catch {
    return "dark";
  }
}

/** The chosen theme; "system" follows the OS. Also themes the native title bar. */
export function useTheme() {
  const [theme, setTheme] = useState(saved);
  const [osDark, setOsDark] = useState(dark.matches);
  useEffect(() => {
    const on = () => setOsDark(dark.matches);
    dark.addEventListener("change", on);
    return () => dark.removeEventListener("change", on);
  }, []);

  // Layout effect: the attribute is in place before children's effects read CSS vars (graph canvas).
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme === "system" ? (osDark ? "dark" : "light") : theme;
  }, [theme, osDark]);

  useEffect(() => {
    try { localStorage.setItem(KEY, theme); } catch { /* private storage: choice lasts this session */ }
    try {
      getCurrentWindow().setTheme(theme === "system" ? null : theme).catch(() => {});
    } catch { /* no Tauri window under plain `npm run dev` */ }
  }, [theme]);

  return [theme, setTheme] as const;
}

/** Accent hues (oklch). null = the built-in spruce teal. App.css turns the hue into fills and text colours. */
export const ACCENTS: [string, number | null][] = [
  ["Spruce", null], ["Blue", 255], ["Indigo", 280], ["Violet", 305], ["Rose", 0], ["Amber", 60], ["Green", 145],
];
const ACCENT_KEY = "accent";
const accentSubs = new Set<() => void>();
let accent = savedAccent();

/** The current accent hue; re-renders when Settings changes it. */
export const useAccent = () =>
  useSyncExternalStore((f) => { accentSubs.add(f); return () => { accentSubs.delete(f); }; }, () => accent);

function savedAccent(): number | null {
  try {
    const h = localStorage.getItem(ACCENT_KEY);
    return h ? Number(h) : null;
  } catch {
    return null;
  }
}

/** Applies and remembers the accent hue. index.html applies the saved one before first paint. */
export function setAccent(hue: number | null) {
  accent = hue;
  accentSubs.forEach((f) => f());
  const root = document.documentElement;
  if (hue === null) {
    delete root.dataset.accent;
    root.style.removeProperty("--ah");
  } else {
    root.dataset.accent = "";
    root.style.setProperty("--ah", String(hue));
  }
  try {
    if (hue === null) localStorage.removeItem(ACCENT_KEY);
    else localStorage.setItem(ACCENT_KEY, String(hue));
  } catch { /* private storage: choice lasts this session */ }
}

export const themeCommands =(theme: Theme, set: (t: Theme) => void) =>
  THEMES.filter((t) => t !== theme).map((t) => ({ label: `Theme: ${NAME[t]}`, run: () => set(t) }));

/** Cycles System → Light → Dark. `labeled`: show the theme name next to the icon. */
export function ThemeButton({ theme, onChange, labeled }: { theme: Theme; onChange: (t: Theme) => void; labeled?: boolean }) {
  const label = `Theme: ${NAME[theme]}. Switch to ${NAME[NEXT[theme]]}`;
  return (
    <button className={labeled ? "corner-btn" : "icon-btn"} onClick={() => onChange(NEXT[theme])} aria-label={label} title={label}>
      <Icon name={ICON[theme]} />
      {labeled && <span>{NAME[theme]} theme</span>}
    </button>
  );
}
