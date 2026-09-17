/**
 * Service-worker client + platform detection. The worker itself is
 * public/sw.js (cache-first shell, SKIP_WAITING on message). Registration
 * happens in main.tsx (PROD only); the App renders the "Update ready" pill —
 * the announce/subscribe pair below bridges the two without either importing
 * the other.
 */

type Apply = () => void;
type UpdateListener = (apply: Apply) => void;

// -- update bridge (main.tsx announces, App subscribes) ---------------------

let pendingApply: Apply | null = null;
const updateListeners = new Set<UpdateListener>();

/** main.tsx passes this to registerSW: `registerSW(announceUpdate)`. */
export function announceUpdate(apply: Apply): void {
  pendingApply = apply;
  for (const listener of [...updateListeners]) listener(apply);
}

/**
 * App-side: called in a useEffect; fires immediately when an update was
 * announced before the subscriber mounted (registration can beat first
 * effects on a warm reload). Returns an unsubscribe.
 */
export function subscribeUpdate(listener: UpdateListener): () => void {
  updateListeners.add(listener);
  if (pendingApply !== null) listener(pendingApply);
  return () => void updateListeners.delete(listener);
}

// -- update checks ----------------------------------------------------------

export type UpdatePhase = "idle" | "checking" | "downloading" | "current" | "ready" | "error" | "unavailable";
export interface UpdateStatus { phase: UpdatePhase; checkedAt: string | null }
let status: UpdateStatus = { phase: "idle", checkedAt: null };
const statusListeners = new Set<(state: UpdateStatus) => void>();
let registration: Promise<ServiceWorkerRegistration | null> | null = null;
let checking: Promise<void> | null = null;
let prepareRestart: () => boolean = () => true;
let offerUpdate: ((worker: ServiceWorker) => void) | null = null;

export function getUpdateStatus(): UpdateStatus { return status; }
export function subscribeUpdateStatus(listener: (state: UpdateStatus) => void): () => void {
  statusListeners.add(listener);
  listener(status);
  return () => void statusListeners.delete(listener);
}
function publishStatus(phase: UpdatePhase, checkedAt = status.checkedAt): void {
  status = { phase, checkedAt };
  for (const listener of [...statusListeners]) listener(status);
}

/** Offer restarts only after the new shell has finished downloading. */
export function registerSW(onUpdateReady: UpdateListener, beforeRestart: () => boolean = () => true): void {
  prepareRestart = beforeRestart;
  if (!("serviceWorker" in navigator)) { publishStatus("unavailable"); return; }
  const container = navigator.serviceWorker;
  offerUpdate = (worker) => {
    if (worker.state !== "installed") return;
    const apply = () => {
      // Flush first; a failed save must never turn an update into data loss.
      if (!prepareRestart()) return;
      let reloaded = false;
      container.addEventListener("controllerchange", () => {
        if (reloaded) return;
        reloaded = true;
        location.reload();
      });
      worker.postMessage("SKIP_WAITING");
    };
    onUpdateReady(apply);
    publishStatus("ready");
  };
  registration = container.register("/sw.js", { updateViaCache: "none" }).then((reg) => {
    const watched = new WeakSet<ServiceWorker>();
    const watch = (worker: ServiceWorker) => {
      if (watched.has(worker)) return;
      watched.add(worker);
      const changed = () => {
        if (worker.state === "installed" && container.controller !== null) offerUpdate?.(worker);
        else if (worker.state === "redundant" && status.phase === "downloading") publishStatus("error");
      };
      worker.addEventListener("statechange", changed);
      changed();
    };
    if (reg.waiting !== null && container.controller !== null) offerUpdate?.(reg.waiting);
    if (reg.installing !== null) watch(reg.installing);
    reg.addEventListener("updatefound", () => {
      if (reg.installing !== null) {
        if (container.controller !== null) publishStatus("downloading");
        watch(reg.installing);
      }
    });
    return reg;
  }).catch(() => { publishStatus("error"); return null; });
}

/** A manual check waits for installation too: update() resolving alone does
 * not mean the new shell is cached. Offline, failed and timed-out checks
 * never claim that this version is current. Status survives tab changes. */
export function checkForUpdates(): Promise<void> {
  if (checking !== null) return checking;
  if (!("serviceWorker" in navigator) || !import.meta.env.PROD) {
    publishStatus("unavailable");
    return Promise.resolve();
  }
  if (pendingApply !== null && status.phase === "ready") return Promise.resolve();
  publishStatus("checking");
  checking = (async () => {
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cleanup = () => {};
    try {
      const work = async () => {
        let reg = await registration;
        if (reg === null) {
          registerSW(announceUpdate, prepareRestart);
          reg = await registration;
        }
        if (reg === null) throw new Error("Registration unavailable");
        if (expired) return;
        if (status.phase === "error") publishStatus("checking");
        await reg.update();
        if (expired) return;
        if (reg.waiting !== null) {
          offerUpdate?.(reg.waiting);
        } else if (reg.installing !== null) {
          publishStatus("downloading");
          const worker = reg.installing;
          await new Promise<void>((resolve, reject) => {
            const changed = () => {
              if (worker.state === "redundant") reject(new Error("Install failed"));
              else if (worker.state === "installed" || worker.state === "activated") resolve();
            };
            cleanup = () => worker.removeEventListener("statechange", changed);
            worker.addEventListener("statechange", changed);
            changed();
          });
          if (expired) return;
          if (worker.state === "installed") offerUpdate?.(worker);
        }
        // A fast failed install can already have cleared reg.installing by
        // the time update() resolves; the registration watcher caught it.
        if (status.phase === "error") throw new Error("Install failed");
        if (!expired) publishStatus(status.phase === "ready" ? "ready" : "current", new Date().toISOString());
      };
      await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { expired = true; reject(new Error("Check timed out")); }, 20000);
        }),
      ]);
    } catch {
      if (status.phase !== "ready") publishStatus("error");
    } finally {
      clearTimeout(timer);
      cleanup();
      checking = null;
    }
  })();
  return checking;
}

// -- platform detection -----------------------------------------------------

/** Installed-to-home-screen? (display-mode media query, or Safari's legacy flag.) */
export function isStandalone(): boolean {
  const media = window.matchMedia?.("(display-mode: standalone)").matches === true;
  const legacy = (navigator as { standalone?: boolean }).standalone === true;
  return media || legacy;
}

/** iPhone/iPad — the ITP-eviction platform the install nag exists for. */
export function isIOS(): boolean {
  const ua = navigator.userAgent;
  // iPadOS 13+ masquerades as macOS Safari; multi-touch gives it away.
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}
