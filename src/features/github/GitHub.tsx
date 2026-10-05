import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { githubFinish, githubSignOut, githubStart, githubUser } from "../../lib/ipc";
import type { DeviceCode } from "../../bindings/DeviceCode";
import { errorText } from "../status/Changes";

const userQuery = { queryKey: ["github-user"], queryFn: githubUser, staleTime: Infinity, retry: false };

/** Sign in to GitHub (device flow): shows the one-time code, opens github.com/login/device, waits for approval. */
export function GitHubAccount() {
  const qc = useQueryClient();
  const user = useQuery(userQuery);
  const [code, setCode] = useState<DeviceCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Cancel just stops listening; the backend poll runs out on its own when the code expires.
  const attempt = useRef(0);

  async function signIn() {
    const n = ++attempt.current;
    setError(null);
    try {
      const c = await githubStart();
      if (n !== attempt.current) return;
      setCode(c);
      const login = await githubFinish(c);
      if (n === attempt.current) qc.setQueryData(userQuery.queryKey, login);
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
    await githubSignOut();
    qc.setQueryData(userQuery.queryKey, null);
  }

  // Offline or keychain trouble: no account row rather than an error on the home screen.
  if (user.isError || user.isPending) return null;
  return (
    <section className="github">
      {user.data ? (
        <p>
          GitHub: <strong>@{user.data}</strong> <button onClick={signOut}>Sign out</button>
        </p>
      ) : code ? (
        <div className="device" role="status">
          <p>Enter this code on GitHub:</p>
          <code className="user-code">{code.user_code}</code>
          <div className="welcome-actions">
            <button className="primary" onClick={() => copyAndOpen(code)}>Copy code &amp; open GitHub</button>
            <button onClick={() => { attempt.current++; setCode(null); }}>Cancel</button>
          </div>
          <p className="muted">Waiting for approval at {code.verification_uri}…</p>
        </div>
      ) : (
        <button onClick={signIn}>Sign in to GitHub</button>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
