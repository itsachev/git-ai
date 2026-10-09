import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { open as pickFile } from "@tauri-apps/plugin-dialog";
import { homeDir, join } from "@tauri-apps/api/path";
import { aiConfig, aiHasKey, aiSetConfig, aiSetKey, gitSetup, gitSetupSet, sshDetect, sshKey, sshKeySet } from "../../lib/ipc";
import { Icon } from "../../lib/icons";
import { ModalHead } from "../../lib/modal";
import { errorText } from "../status/Changes";
import { openSetup } from "../setup/Setup";

export const aiKeyQuery = { queryKey: ["ai-key"], queryFn: aiHasKey, staleTime: Infinity };
export const aiConfigQuery = { queryKey: ["ai-config"], queryFn: aiConfig, staleTime: Infinity };

// One dialog for the whole app; anything can open it.
let open = false;
const subs = new Set<() => void>();
const set = (v: boolean) => { open = v; subs.forEach((f) => f()); };
export const openSettings = () => set(true);

export function SettingsButton({ labeled }: { labeled?: boolean }) {
  return (
    <button className={labeled ? "corner-btn" : "icon-btn"} onClick={openSettings} aria-label="Settings" title="Settings">
      <Icon name="settings" />
      {labeled && <span>Settings</span>}
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
      {isOpen && (
        <div className="settings-layout">
          <SettingsNav />
          <div className="settings-cards">
            {SECTIONS.map(({ id, hue, Body }, i) => (
              <div key={id} id={id} className="settings-card" style={{ "--h": hue, "--i": i } as React.CSSProperties}><Body /></div>
            ))}
          </div>
        </div>
      )}
      <div className="dialog-actions">
        <button type="button" className="link setup-again" onClick={() => { set(false); openSetup(); }}>Run setup again</button>
        <button onClick={() => set(false)}>Close</button>
      </div>
    </dialog>
  );
}

const SECTIONS = [
  { id: "settings-identity", title: "Git identity", icon: "user", hue: 265, Body: () => <GitIdentity /> },
  { id: "settings-ssh", title: "SSH key", icon: "key", hue: 165, Body: () => <SshKey /> },
  { id: "settings-ai", title: "AI features", icon: "sparkle", hue: 320, Body: () => <AiKey /> },
] as const;

/** Setup at a glance: each section's current value and whether it's ready. Clicking jumps to the card. */
function SettingsNav() {
  const setup = useQuery(gitSetupQuery).data;
  const ssh = useQuery(sshKeyQuery).data;
  const cfg = useQuery(aiConfigQuery).data;
  const has = useQuery(aiKeyQuery).data;
  const ai = PROVIDERS[cfg && cfg.provider in PROVIDERS ? cfg.provider : "gemini"];
  const local = cfg?.provider === "openai" && !!cfg.base_url.trim();
  // [value, state]: ok = set up, idle = fine as is, todo = needs doing.
  const status: Record<string, [string, "ok" | "idle" | "todo"]> = {
    "settings-identity": setup?.name && setup.email ? [`${setup.name} · ${setup.email}`, "ok"] : ["Not set", "todo"],
    "settings-ssh": ssh ? [ssh.split(/[\\/]/).pop()!, "ok"] : ["ssh defaults", "idle"],
    "settings-ai": [`${ai.name} · ${local ? "local server" : has ? "key set" : "no key"}`, local || has ? "ok" : "todo"],
  };
  function go(id: string) {
    const card = document.getElementById(id);
    card?.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    // Restart the flash on repeat clicks.
    card?.classList.remove("lit");
    void card?.offsetWidth;
    card?.classList.add("lit");
  }
  return (
    <nav className="settings-nav" aria-label="Settings sections">
      {SECTIONS.map(({ id, title, icon, hue }, i) => {
        const [value, state] = status[id];
        return (
          <button key={id} type="button" className={`state-${state}`} style={{ "--h": hue, "--i": i } as React.CSSProperties} onClick={() => go(id)}>
            <span className="about-icon"><Icon name={icon} /></span>
            <span className="settings-nav-text"><strong>{title}</strong><small>{value}</small></span>
            <span className="settings-dot" role="img" aria-label={state === "todo" ? "Needs setup" : state === "ok" ? "Set up" : "Using defaults"} />
          </button>
        );
      })}
    </nav>
  );
}

export const gitSetupQuery = { queryKey: ["git-setup"], queryFn: gitSetup };
const sshKeyQuery = { queryKey: ["ssh-key"], queryFn: sshKey };
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
      <h3><span className="about-icon"><Icon name="user" /></span>Git identity</h3>
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

/** Defaults mirror `AiConfig::model` in `src-tauri/src/ai.rs`. */
const PROVIDERS: Record<string, { name: string; model: string; keyUrl: string }> = {
  gemini: { name: "Google Gemini", model: "gemini-3.5-flash-lite", keyUrl: "https://aistudio.google.com/apikey" },
  anthropic: { name: "Anthropic Claude", model: "claude-opus-5-5", keyUrl: "https://console.anthropic.com/settings/keys" },
  openai: { name: "OpenAI or compatible", model: "gpt-5-mini", keyUrl: "https://platform.openai.com/api-keys" },
};

/** AI provider, model and key (BYOK). The key goes to the OS keychain, the rest to the settings store. */
export function AiKey() {
  const qc = useQueryClient();
  const has = useQuery(aiKeyQuery).data;
  const cfg = useQuery(aiConfigQuery).data;
  const provider = cfg && cfg.provider in PROVIDERS ? cfg.provider : "gemini";
  const p = PROVIDERS[provider];
  const [key, setKey] = useState("");
  const [model, setModel] = useState<string | null>(null);
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const m = model ?? cfg?.model ?? "";
  const url = baseUrl ?? cfg?.base_url ?? "";
  async function act(f: () => Promise<void>) {
    setError(null);
    try {
      await f();
      qc.invalidateQueries({ queryKey: aiKeyQuery.queryKey });
      qc.invalidateQueries({ queryKey: aiConfigQuery.queryKey });
    } catch (e) {
      setError(errorText(e));
    }
  }
  const removeKey = () => act(() => aiSetKey(provider, null));
  // Switching provider resets the model, since model names don't carry over.
  const pick = (next: string) => act(async () => {
    await aiSetConfig({ provider: next, model: "", base_url: url });
    setModel(null); setSaved(false);
  });
  // One Save for both stores: model and URL go to settings, a typed key to the OS keychain.
  const save = () => act(async () => {
    if (model !== null || baseUrl !== null) await aiSetConfig({ provider, model: m.trim(), base_url: url.trim() });
    if (key.trim()) await aiSetKey(provider, key.trim());
    setModel(null); setBaseUrl(null); setKey(""); setSaved(true);
  });
  const local = provider === "openai" && !!url.trim();
  return (
    <section className="setting">
      <h3><span className="about-icon"><Icon name="sparkle" /></span>AI features</h3>
      <p className="muted">
        Uses your own API key, kept in the OS keychain. AI features send diffs and commit messages to the provider you pick.{" "}
        {!local && <button type="button" className="link" onClick={() => openUrl(p.keyUrl)}>Get a key</button>}
      </p>
      <form className="identity" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <label>Provider
          <span className="select">
            <select value={provider} onChange={(e) => pick(e.target.value)}>
              {Object.entries(PROVIDERS).map(([id, x]) => <option key={id} value={id}>{x.name}</option>)}
            </select>
            <Icon name="chevron" />
          </span>
        </label>
        <label>Model<input value={m} onChange={(e) => { setModel(e.target.value); setSaved(false); }} placeholder={p.model} autoComplete="off" spellCheck={false} /></label>
        {provider === "openai" && (
          <label>Server URL
            <input value={url} onChange={(e) => { setBaseUrl(e.target.value); setSaved(false); }} placeholder="https://api.openai.com/v1"
              autoComplete="off" spellCheck={false} inputMode="url" />
            <span className="muted">For Ollama, LM Studio or OpenRouter, e.g. http://localhost:11434/v1. Local servers need no key.</span>
          </label>
        )}
        <label>API key
          <span className="row key-row">
            <input type="password" aria-label="API key" placeholder={has && !local ? "Saved. Type to replace it" : `${p.name} API key`}
              value={key} onChange={(e) => { setKey(e.target.value); setSaved(false); }} autoComplete="off" />
            {has && !local && <button type="button" onClick={removeKey}>Remove</button>}
          </span>
          <span className="muted">{local ? "No key needed for a custom server URL (add one if it asks)." : has ? "A key is set." : "No key set."}</span>
        </label>
        <div className="row">
          <button className="primary" disabled={model === null && baseUrl === null && !key.trim()}>Save</button>
          {saved && <span className="saved" role="status"><Icon name="check" /> Saved</span>}
        </div>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

/** Private key for fetch/pull/push/clone. Only the path is stored; ssh reads the file. */
export function SshKey() {
  const qc = useQueryClient();
  const key = useQuery(sshKeyQuery).data;
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
      <h3><span className="about-icon"><Icon name="key" /></span>SSH key</h3>
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
