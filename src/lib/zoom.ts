import { getCurrentWebview } from "@tauri-apps/api/webview";

// Whole-app zoom, like a browser or VS Code: Ctrl + / Ctrl - / Ctrl 0 and Ctrl+wheel (a trackpad pinch too).
// Text, icons and spacing scale together, so fixed-height rows and the graph keep their proportions.
// A per-window UI preference like the theme, so localStorage.
const KEY = "zoom";
const MIN = 0.5, MAX = 2, STEP = 0.1;

let zoom = 1;
try { zoom = Number(localStorage.getItem(KEY)) || 1; } catch { /* storage blocked */ }

function set(z: number) {
  zoom = Math.round(Math.min(MAX, Math.max(MIN, z)) * 10) / 10;
  try { localStorage.setItem(KEY, String(zoom)); } catch { /* storage blocked */ }
  return getCurrentWebview().setZoom(zoom).catch(() => {});
}

/** Resolves once the saved zoom is applied, so the window can show without a jump. */
export const zoomReady = zoom === 1 ? Promise.resolve() : set(zoom);

addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const d = e.key === "=" || e.key === "+" ? STEP : e.key === "-" || e.key === "_" ? -STEP : e.key === "0" ? 0 : null;
  if (d === null) return;
  e.preventDefault();
  set(d ? zoom + d : 1);
});

// One step per wheel notch (Chromium reports 100 px); line-mode deltas (WebKitGTK) count as 40 px a line.
let acc = 0;
addEventListener("wheel", (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  acc += e.deltaMode ? e.deltaY * 40 : e.deltaY;
  if (Math.abs(acc) < 50) return;
  set(zoom - Math.sign(acc) * STEP);
  acc = 0;
}, { passive: false });
