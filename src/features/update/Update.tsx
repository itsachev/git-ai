import { useEffect, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { Icon } from "../../lib/icons";

// Checks GitHub Releases once at startup. Offline, dev builds and missing
// releases fail the check; that is not worth bothering the user about.
export function UpdateBanner() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [state, setState] = useState<string | null>(null);

  useEffect(() => {
    check().then(setUpdate, () => {});
  }, []);

  if (!update) return null;

  const install = async () => {
    let total = 0, done = 0;
    setState("Downloading…");
    try {
      await update.downloadAndInstall((e) => {
        if (e.event === "Started") total = e.data.contentLength ?? 0;
        if (e.event === "Progress" && total) {
          done += e.data.chunkLength;
          setState(`Downloading… ${Math.round((done / total) * 100)}%`);
        }
        if (e.event === "Finished") setState("Restarting…");
      });
      // Windows exits inside downloadAndInstall to run the installer.
      await relaunch();
    } catch (err) {
      setState(`Update failed: ${err}`);
    }
  };

  return (
    <aside className="update toast tone-accent" role="status">
      <span className="modal-badge tone-accent"><Icon name="restart" /></span>
      <span className="toast-text">
        <strong>git-ai {update.version} is available</strong>
        {state && <small className={state.startsWith("Update failed") ? "error" : "muted"}>{state}</small>}
      </span>
      {!state && (
        <span className="toast-actions">
          <button className="small" onClick={() => setUpdate(null)}>Later</button>
          <button className="small primary" onClick={install}>Install & restart</button>
        </span>
      )}
    </aside>
  );
}
