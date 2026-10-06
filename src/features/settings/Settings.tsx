import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { open as pickFile } from "@tauri-apps/plugin-dialog";
import { homeDir, join } from "@tauri-apps/api/path";
import { aiHasKey, aiSetKey, sshKey, sshKeySet } from "../../lib/ipc";
import { Icon } from "../../lib/icons";
import { ModalHead } from "../../lib/modal";
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
    <dialog ref={dialog} className="modal settings" aria-labelledby="settings-title" onCancel={(e) => { e.preventDefault(); set(false); }}>
      <ModalHead id="settings-title" icon="settings" title="Settings" sub="Stored on this computer only." />
      {isOpen && <><SshKey /><AiKey /></>}
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

/** Private key for fetch/pull/push/clone. Only the path is stored; ssh reads the file. */
function SshKey() {
  const qc = useQueryClient();
  const key = useQuery({ queryKey: ["ssh-key"], queryFn: sshKey }).data;
  const [error, setError] = useState<string | null>(null);
  async function save(path: string | null) {
    setError(null);
    try {
      await sshKeySet(path);
      qc.invalidateQueries({ queryKey: ["ssh-key"] });
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function choose() {
    const defaultPath = await join(await homeDir(), ".ssh").catch(() => undefined);
    const path = await pickFile({ title: "Choose your SSH private key", defaultPath });
    if (typeof path === "string") save(path);
  }
  return (
    <section className="setting">
      <h3>SSH key</h3>
      <p className="muted">
        Remotes connect over SSH (git@host:owner/repo.git). Pick the private key, not the .pub file.
        Without one, ssh uses ssh-agent and the default keys in ~/.ssh.
      </p>
      <p className="mono ssh-key-path">{key ?? "Using ssh defaults."}</p>
      <div className="row">
        <button className="primary" onClick={choose}>{key ? "Change key" : "Choose key"}</button>
        {key && <button onClick={() => save(null)}>Use ssh defaults</button>}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

/** Shown once per launch: only SSH remotes are supported for now. */
export function SshNotice() {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const close = () => dialog.current?.close();
  return (
    <dialog ref={dialog} className="modal" aria-labelledby="ssh-notice-title" aria-describedby="ssh-notice-text">
      <ModalHead id="ssh-notice-title" icon="remote" title="SSH remotes only, for now" />
      <p id="ssh-notice-text" className="modal-text">
        git-ai currently supports connecting to remote repositories over SSH only (URLs like git@github.com:owner/repo.git).
        HTTPS remotes may not sign in. Add your SSH key in Settings, or leave it to ssh-agent and ~/.ssh.
      </p>
      <div className="dialog-actions">
        <button onClick={() => { close(); openSettings(); }}>Set up SSH key</button>
        <button className="primary" autoFocus onClick={close}>OK</button>
      </div>
    </dialog>
  );
}
