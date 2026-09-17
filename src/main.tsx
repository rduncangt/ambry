import { render } from "preact";
import { localStorageAdapter } from "./store/adapter";
import { createStore } from "./store/store";
import { App } from "./ui/App";
import { announceUpdate, registerSW } from "./ui/sw-client";
import "./styles.css";

const store = createStore(localStorageAdapter());

// Launch-time retention pass (events past retention_days, stale checked-off
// extras). Safe by construction under R2.
store.prune();

// iOS kills backgrounded pages without ceremony — flush the debounced save on
// BOTH signals (pagehide is unreliable on iOS; visibilitychange->hidden is
// the one that actually fires before a kill).
window.addEventListener("pagehide", () => store.flush());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") store.flush();
});

// Best-effort eviction protection (PLAN.md §1.1): Apple does not promise this
// prevents anything, so the result is deliberately ignored — the install nag
// and export nag carry the real durability story.
void navigator.storage?.persist?.().catch(() => undefined);

// Service worker: production only (dev caching is a footgun). The App renders
// the "Update ready" pill via the announce/subscribe bridge in sw-client.
if (import.meta.env.PROD) {
  registerSW(announceUpdate, () => {
    store.flush();
    return !store.saveError() && !store.storageConflict();
  });
}

render(<App store={store} />, document.getElementById("app")!);
