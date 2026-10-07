import { useEffect, useLayoutEffect, useState } from "react";
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

export const themeCommands = (theme: Theme, set: (t: Theme) => void) =>
  THEMES.filter((t) => t !== theme).map((t) => ({ label: `Theme: ${NAME[t]}`, run: () => set(t) }));

/** Cycles System → Light → Dark. */
export function ThemeButton({ theme, onChange }: { theme: Theme; onChange: (t: Theme) => void }) {
  const label = `Theme: ${NAME[theme]}. Switch to ${NAME[NEXT[theme]]}`;
  return (
    <button className="icon-btn" onClick={() => onChange(NEXT[theme])} aria-label={label} title={label}>
      <Icon name={ICON[theme]} />
    </button>
  );
}
