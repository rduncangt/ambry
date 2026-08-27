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

// -- registration -----------------------------------------------------------

/**
 * Register /sw.js and report when an updated worker is waiting — both a
 * worker left waiting from a previous visit (registration.waiting) and one
 * that finishes installing while the page is open (updatefound → installed).
 * `apply` posts SKIP_WAITING and reloads once the new worker takes control.
 */
export function registerSW(onUpdateReady: UpdateListener): void {
  if (!("serviceWorker" in navigator)) return;
  const container = navigator.serviceWorker;

  const makeApply = (worker: ServiceWorker): Apply => () => {
    let reloaded = false;
    container.addEventListener("controllerchange", () => {
      // Guard: controllerchange can fire more than once; one reload only.
      if (reloaded) return;
      reloaded = true;
      location.reload();
    });
    worker.postMessage("SKIP_WAITING");
  };

  container
    .register("/sw.js")
    .then((reg) => {
      if (reg.waiting !== null && container.controller !== null) {
        onUpdateReady(makeApply(reg.waiting));
      }
      reg.addEventListener("updatefound", () => {
        const installing = reg.installing;
        if (installing === null) return;
        installing.addEventListener("statechange", () => {
          // "installed" with an existing controller = an update is waiting.
          // Without a controller it is the FIRST install — nothing to offer.
          if (installing.state === "installed" && container.controller !== null) {
            onUpdateReady(makeApply(installing));
          }
        });
      });
    })
    .catch(() => {
      // Registration failure (private mode, flaky network) must never take
      // the app down — the page just runs uncached.
    });
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
