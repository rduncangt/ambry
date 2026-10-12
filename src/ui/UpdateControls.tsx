/** Update access shared by normal settings and restore-first recovery. */
import { useEffect, useState } from "preact/hooks";
import { checkForUpdates, getUpdateStatus, subscribeUpdate, subscribeUpdateStatus, type UpdatePhase } from "./sw-client";
import { useDoc, useStore } from "./hooks";

export function UpdateControls() {
  const store = useStore();
  useDoc(); // failed restart saves/conflicts must also be visible during recovery
  const [update, setUpdate] = useState(getUpdateStatus);
  const [restart, setRestart] = useState<(() => void) | null>(null);
  useEffect(() => subscribeUpdateStatus(setUpdate), []);
  useEffect(() => subscribeUpdate((apply) => setRestart(() => apply)), []);
  const text: Record<UpdatePhase, string> = {
    idle: "Check whether a newer version is available.",
    checking: "Checking for updates…",
    downloading: "Downloading an update…",
    current: "You're up to date.",
    ready: "Update ready — restart to install it.",
    error: "Could not check or download the update. Check your connection and try again.",
    unavailable: "Update checks aren't available in this browser or development build.",
  };
  return (
    <div class="settings-updates">
      <p class="settings-note" role="status">{text[update.phase]}</p>
      {update.checkedAt !== null && <p class="settings-note">Last checked {new Date(update.checkedAt).toLocaleString()}</p>}
      {store.storageConflict() && (
        <div>
          <p role="alert">Restart blocked: this pantry changed in another tab. Reload to continue safely.</p>
          <button class="btn" type="button" onClick={() => location.reload()}>Reload app</button>
        </div>
      )}
      {store.saveError() && <p role="alert">Restart blocked: pending changes could not be saved. Free storage and try again.</p>}
      {update.phase === "ready" && restart !== null ? (
        <button class="btn btn-primary" type="button" onClick={restart}>Restart to update</button>
      ) : (
        <button class="btn" type="button" disabled={update.phase === "checking" || update.phase === "downloading"}
          onClick={() => void checkForUpdates()}>Check for updates</button>
      )}
    </div>
  );
}
