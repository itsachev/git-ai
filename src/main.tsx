import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
// Bundled (offline) variable fonts: Geist for UI, Geist Mono for refs, hashes and diffs.
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import App from "./App";

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

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
