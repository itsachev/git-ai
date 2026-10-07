import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { open as pickFile } from "@tauri-apps/plugin-dialog";
import { homeDir, join } from "@tauri-apps/api/path";
import { aiHasKey, aiSetKey, gitSetup, gitSetupSet, sshDetect, sshKey, sshKeySet } from "../../lib/ipc";
import { Icon } from "../../lib/icons";
import { ModalHead } from "../../lib/modal";
import { errorText } from "../status/Changes";
import { openSetup } from "../setup/Setup";

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
      {isOpen && <><GitIdentity /><SshKey /><AiKey /></>}
      <div className="dialog-actions">
        <button type="button" className="link setup-again" onClick={() => { set(false); openSetup(); }}>Run setup again</button>
        <button onClick={() => set(false)}>Close</button>
      </div>
    </dialog>
  );
}

export const gitSetupQuery = { queryKey: ["git-setup"], queryFn: gitSetup };
const HELPER_NAMES: Record<string, string> = { manager: "Git Credential Manager", "manager-core": "Git Credential Manager", osxkeychain: "the macOS keychain" };
export const helperName = (h: string) => HELPER_NAMES[h] ?? h;

/**
 * Global commit identity, plus turning on git's own credential helper so HTTPS sign-ins are asked once
 * and saved by git (the app never sees or stores the password). `formId` + `onSaved`: the wizard
 * submits it from its own footer instead of the Save button.
 */
export function GitIdentity({ formId, onSaved }: { formId?: string; onSaved?: () => void }) {
  const qc = useQueryClient();
  const setup = useQuery(gitSetupQuery).data;
  const [name, setName] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [helper, setHelper] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const n = name ?? setup?.name ?? "";
  const e = email ?? setup?.email ?? "";
  async function save(ev: React.FormEvent) {
    ev.preventDefault();
    setError(null);
    try {
      await gitSetupSet(n, e, helper);
      await qc.invalidateQueries({ queryKey: gitSetupQuery.queryKey });
      setSaved(true);
      onSaved?.();
    } catch (err) {
      setError(errorText(err));
    }
  }
  return (
    <section className="setting">
      <h3>Git identity</h3>
      <p className="muted">Your name and email go into every commit you make, on any computer that reads the history.</p>
      <form id={formId} className="identity" onSubmit={save}>
        <label>Name<input value={n} onChange={(x) => { setName(x.target.value); setSaved(false); }} autoComplete="name" placeholder="Ada Lovelace" required /></label>
        <label>Email<input type="email" value={e} onChange={(x) => { setEmail(x.target.value); setSaved(false); }} autoComplete="email" placeholder="ada@example.com" required /></label>
        {setup?.helper ? (
          <p className="helper-note"><Icon name="check" /> HTTPS sign-ins are saved by {helperName(setup.helper)}. Git asks once, then never again.</p>
        ) : setup?.helper_default ? (
          <label className="check">
            <input type="checkbox" checked={helper} onChange={(x) => setHelper(x.target.checked)} />
            <span>Save HTTPS sign-ins with {helperName(setup.helper_default)}, so git asks for a password once and never again.</span>
          </label>
        ) : null}
        {!formId && (
          <div className="row">
            <button className="primary" disabled={!n.trim() || !e.trim()}>Save</button>
            {saved && <span className="saved" role="status"><Icon name="check" /> Saved</span>}
          </div>
        )}
      </form>
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

/** Gemini key (BYOK), stored in the OS keychain. */
export function AiKey() {
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
export function SshKey() {
  const qc = useQueryClient();
  const key = useQuery({ queryKey: ["ssh-key"], queryFn: sshKey }).data;
  const found = useQuery({ queryKey: ["ssh-detect"], queryFn: sshDetect, enabled: !key }).data ?? [];
  const [pick, setPick] = useState<string | null>(null);
  const offer = pick ?? found[0];
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
      {!key && offer && (
        <div className="found" role="group" aria-label="SSH key found">
          <p><Icon name="sparkle" /> {found.length > 1 ? `We found ${found.length} keys in ~/.ssh.` : "We found a key in ~/.ssh."}</p>
          {found.length > 1 ? (
            <select aria-label="Found SSH key" value={offer} onChange={(x) => setPick(x.target.value)}>
              {found.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          ) : (
            <code className="ssh-key-path">{offer}</code>
          )}
          <button className="primary" onClick={() => save(offer)}>Use this key</button>
        </div>
      )}
      <div className="row">
        <button className={offer ? undefined : "primary"} onClick={choose}>{key ? "Change key" : offer ? "Choose another key" : "Choose key"}</button>
        {key && <button onClick={() => save(null)}>Use ssh defaults</button>}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
