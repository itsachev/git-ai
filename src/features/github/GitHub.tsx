import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  githubFinish, githubSignOut, githubStart, githubUser, gitlabFinish, gitlabSignOut, gitlabStart, gitlabUser,
} from "../../lib/ipc";
import type { DeviceCode } from "../../bindings/DeviceCode";
import { errorText } from "../status/Changes";
import { Icon } from "../../lib/icons";

export const userQuery = { queryKey: ["github-user"], queryFn: githubUser, staleTime: Infinity, retry: false };
export const gitlabUserQuery = { queryKey: ["gitlab-user"], queryFn: gitlabUser, staleTime: Infinity, retry: false };

const providers = {
  github: { name: "GitHub", query: userQuery, start: githubStart, finish: githubFinish, signOut: githubSignOut },
  gitlab: { name: "GitLab", query: gitlabUserQuery, start: gitlabStart, finish: gitlabFinish, signOut: gitlabSignOut },
};

export const GitHubAccount = () => <Account provider="github" />;
export const GitLabAccount = () => <Account provider="gitlab" />;

/** Sign in (device flow): shows the one-time code, opens the provider's device page, waits for approval. */
function Account({ provider }: { provider: keyof typeof providers }) {
  const p = providers[provider];
  const qc = useQueryClient();
  const user = useQuery(p.query);
  const [code, setCode] = useState<DeviceCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Cancel just stops listening; the backend poll runs out on its own when the code expires.
  const attempt = useRef(0);

  async function signIn() {
    const n = ++attempt.current;
    setError(null);
    try {
      const c = await p.start();
      if (n !== attempt.current) return;
      setCode(c);
      const login = await p.finish(c);
      if (n === attempt.current) qc.setQueryData(p.query.queryKey, login);
    } catch (e) {
      if (n === attempt.current) setError(errorText(e));
    } finally {
      if (n === attempt.current) setCode(null);
    }
  }

  async function copyAndOpen(c: DeviceCode) {
    await navigator.clipboard.writeText(c.user_code).catch(() => {});
    openUrl(c.verification_uri);
  }

  async function signOut() {
    await p.signOut();
    qc.setQueryData(p.query.queryKey, null);
  }

  // Offline or keychain trouble: no account row rather than an error on the home screen.
  if (user.isError || user.isPending) return null;
  return (
    <div className="account">
      {user.data ? (
        <div className="account-chip signed-in">
          <Icon name={provider} />
          <span><strong>@{user.data}</strong><small>{p.name}</small></span>
          <button className="icon-btn" onClick={signOut} title={`Sign out of ${p.name}`} aria-label={`Sign out of ${p.name}`}>
            <Icon name="logout" />
          </button>
        </div>
      ) : code ? (
        <div className="device" role="status">
          <p>Enter this code on {p.name}:</p>
          <code className="user-code">{code.user_code}</code>
          <div className="welcome-actions">
            <button className="primary" onClick={() => copyAndOpen(code)}>Copy code &amp; open {p.name}</button>
            <button onClick={() => { attempt.current++; setCode(null); }}>Cancel</button>
          </div>
          <p className="muted">Waiting for approval at {code.verification_uri}…</p>
        </div>
      ) : (
        <button className="account-chip" onClick={signIn}>
          <Icon name={provider} />
          <span><strong>Sign in to {p.name}</strong><small>Clone your repos</small></span>
        </button>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}
