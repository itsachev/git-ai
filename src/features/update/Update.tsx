import { useEffect, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

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
    <aside className="update" role="status">
      <span>git-ai {update.version} is available.</span>
      {state ? <span className={state.startsWith("Update failed") ? "error" : undefined}>{state}</span> : (
        <>
          <button onClick={install}>Install & restart</button>
          <button onClick={() => setUpdate(null)}>Later</button>
        </>
      )}
    </aside>
  );
}
