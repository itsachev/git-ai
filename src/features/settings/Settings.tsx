import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { aiHasKey, aiSetKey } from "../../lib/ipc";
import { Icon } from "../../lib/icons";
import { errorText } from "../status/Changes";

export const aiKeyQuery = { queryKey: ["ai-key"], queryFn: aiHasKey, staleTime: Infinity };

// One dialog for the whole app; anything can open it.
let open = false;
const subs = new Set<() => void>();
const set = (v: boolean) => { open = v; subs.forEach((f) => f()); };
export const openSettings = () => set(true);

export function SettingsButton() {
  return (
    <button className="icon-btn" onClick={openSettings} aria-label="Settings" title="Settings">
      <Icon name="settings" />
    </button>
  );
}

export function SettingsDialog() {
  const isOpen = useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => open);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialog.current;
    if (isOpen && !d?.open) d?.showModal();
    if (!isOpen && d?.open) d.close();
  }, [isOpen]);
  return (
    <dialog ref={dialog} className="settings" aria-labelledby="settings-title" onCancel={(e) => { e.preventDefault(); set(false); }}>
      <h2 id="settings-title">Settings</h2>
      {isOpen && <AiKey />}
      <div className="dialog-actions">
        <button onClick={() => set(false)}>Close</button>
      </div>
    </dialog>
  );
}

/** Gemini key (BYOK), stored in the OS keychain. */
function AiKey() {
  const qc = useQueryClient();
  const has = useQuery(aiKeyQuery).data;
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  async function save(k: string | null) {
    setError(null);
    try {
      await aiSetKey(k);
      setKey("");
      qc.invalidateQueries({ queryKey: aiKeyQuery.queryKey });
    } catch (e) {
      setError(errorText(e));
    }
  }
  return (
    <section className="setting">
      <h3>AI commit messages</h3>
      <p className="muted">
        Uses your own Google Gemini API key, kept in the OS keychain. Generating sends the staged diff to Gemini.{" "}
        <button type="button" className="link" onClick={() => openUrl("https://aistudio.google.com/apikey")}>Get a key</button>
      </p>
      <p>{has ? "A key is set." : "No key set."}</p>
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (key.trim()) save(key); }}>
        <input type="password" aria-label="Gemini API key" placeholder={has ? "Replace key" : "Gemini API key"}
          value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" />
        <button className="primary" disabled={!key.trim()}>Save</button>
        {has && <button type="button" onClick={() => save(null)}>Remove</button>}
      </form>
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
