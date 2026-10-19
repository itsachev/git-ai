import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
// Bundled (offline) variable fonts: Geist for UI, Geist Mono for refs, hashes and diffs.
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import App from "./App";
import { zoomReady } from "./lib/zoom";

// Data only refetches when the repo watcher says something changed.
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: Infinity, refetchOnWindowFocus: false } },
});
listen("repo-changed", () => queryClient.invalidateQueries());

// A click on a modal's backdrop closes it like Esc: fire `cancel`, so each dialog's onCancel decides.
// Popovers (popover="auto") light-dismiss natively. Press and release must both land on the backdrop,
// so a text selection dragged out of a field doesn't close the dialog.
const onBackdrop = (e: MouseEvent) => {
  const d = e.target;
  if (!(d instanceof HTMLDialogElement) || !d.open) return null;
  const r = d.getBoundingClientRect();
  return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom ? d : null;
};
let pressed: HTMLDialogElement | null = null;
document.addEventListener("pointerdown", (e) => { pressed = onBackdrop(e); });
document.addEventListener("click", (e) => {
  const d = onBackdrop(e);
  if (d && d === pressed && d.dispatchEvent(new Event("cancel", { cancelable: true }))) d.close();
});

// Themed tooltip for every `title` in the app (native ones are OS-drawn and ignore the theme).
// While hovered, the title moves to data-tip so the native one stays hidden; it comes back after,
// so it still names icon buttons for screen readers. A top-layer popover so it shows over dialogs.
const tip = Object.assign(document.createElement("div"), { className: "tip", popover: "manual" });
tip.setAttribute("role", "tooltip");
document.body.append(tip);
let tipEl: HTMLElement | null = null;
let tipTimer = 0;
const hideTip = () => {
  clearTimeout(tipTimer);
  if (tipEl && !tipEl.hasAttribute("title") && tipEl.dataset.tip) tipEl.title = tipEl.dataset.tip;
  delete tipEl?.dataset.tip;
  tipEl = null;
  if (tip.matches(":popover-open")) tip.hidePopover();
};
document.addEventListener("mouseover", (e) => {
  const el = (e.target as Element).closest?.<HTMLElement>("[title],[data-tip]") ?? null;
  if (el === tipEl) return;
  hideTip();
  if (!el?.title) return;
  tipEl = el;
  el.dataset.tip = el.title;
  el.removeAttribute("title");
  tipTimer = window.setTimeout(() => {
    tip.textContent = el.dataset.tip ?? "";
    // Disabled control (or a label around a disabled checkbox): the text is the reason, headed "Unavailable".
    tip.classList.toggle("off", el.matches(":disabled, :has(> input:disabled)"));
    tip.showPopover();
    // Below the element, or above it when there's no room; kept inside the window.
    const r = el.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
    const top = r.bottom + 6 + h > innerHeight ? r.top - 6 - h : r.bottom + 6;
    tip.style.top = `${Math.max(4, top)}px`;
    tip.style.left = `${Math.min(Math.max(4, r.left + r.width / 2 - w / 2), innerWidth - w - 4)}px`;
  }, 450);
});
document.addEventListener("mouseout", (e) => { if (!e.relatedTarget) hideTip(); });
for (const t of ["pointerdown", "keydown", "wheel"]) document.addEventListener(t, hideTip, true);
addEventListener("blur", hideTip);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);

// The window starts hidden (tauri.conf.json) so its resize to the work area and the blank
// webview never show. Reveal it once the first frame has painted.
zoomReady.then(() => requestAnimationFrame(() => requestAnimationFrame(() => getCurrentWindow().show())));
