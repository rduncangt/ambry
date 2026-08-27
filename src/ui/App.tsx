/**
 * App shell: boot gate → banner stack → current view → overlays → tab bar.
 * All state flows from useDoc(); all writes go through the Store commands.
 */
import { useEffect, useState } from "preact/hooks";
import { exportNag, shoppingList } from "../store/selectors";
import type { Store } from "../store/store";
import { now } from "../types";
import { BootScreen } from "./BootScreen";
import { Banner, Sheet } from "./components";
import {
  NavProvider,
  StoreProvider,
  ToastProvider,
  useDoc,
  useNav,
  useStore,
  useToast,
} from "./hooks";
import { exportFlow } from "./share";
import { isIOS, isStandalone, subscribeUpdate } from "./sw-client";
import { InventoryView } from "./views/InventoryView";
import { CreateSheet, ItemView } from "./views/ItemView";
import { ReconcileView } from "./views/ReconcileView";
import { SettingsView } from "./views/SettingsView";
import { ShoppingView } from "./views/ShoppingView";

export function App(props: { store: Store }) {
  return (
    <StoreProvider store={props.store}>
      <NavProvider>
        <ToastProvider>
          <Root />
        </ToastProvider>
      </NavProvider>
    </StoreProvider>
  );
}

/** Boot gate: "empty" and "corrupt" boots stop at the restore-first screen
 *  (PLAN.md §2 boot rule) until the user restores or explicitly starts new. */
function Root() {
  const store = useStore();
  const [booted, setBooted] = useState(() => {
    const s = store.bootStatus();
    return s !== "empty" && s !== "corrupt";
  });

  if (!booted) {
    return (
      <BootScreen
        status={store.bootStatus() === "corrupt" ? "corrupt" : "empty"}
        onDone={() => setBooted(true)}
      />
    );
  }
  return <Shell />;
}

function Shell() {
  const store = useStore();
  const doc = useDoc();
  const nav = useNav();
  const toast = useToast();

  // Update pill: main.tsx registered the SW; the bridge hands us apply().
  const [applyUpdate, setApplyUpdate] = useState<(() => void) | null>(null);
  useEffect(() => subscribeUpdate((apply) => setApplyUpdate(() => apply)), []);

  // Install nag: session-dismissable only — it must come back next launch
  // until standalone mode is detected (PLAN.md §1.1).
  const [installDismissed, setInstallDismissed] = useState(false);
  const showInstall = isIOS() && !isStandalone() && !installDismissed;

  const nowIso = now();
  const nag = exportNag(doc, nowIso);
  const toBuyCount = shoppingList(doc, nowIso).toBuy.length;

  async function doExport(): Promise<void> {
    const result = await exportFlow(store);
    if (result !== "cancelled") toast("Backup exported");
  }

  const openItem =
    nav.openItemId !== null ? doc.items.find((i) => i.id === nav.openItemId) : undefined;

  const tabClass = (active: boolean): string => `tab${active ? " tab-active" : ""}`;

  return (
    <div class="app">
      <div class="banners">
        {applyUpdate !== null && (
          <Banner kind="info" action="Restart" onAction={applyUpdate}>
            Update ready.
          </Banner>
        )}
        {showInstall && (
          <Banner kind="warn" action="Got it" onAction={() => setInstallDismissed(true)}>
            <strong>Install Ambry before entering data.</strong> iOS deletes an uninstalled
            web app's data after about 7 days without a visit. In Safari: tap Share, then
            "Add to Home Screen". The installed app's storage is <em>separate</em> from this
            Safari tab — install first, then enter data here only to export and restore there.
          </Banner>
        )}
        {nag === "banner" && (
          <Banner kind="warn" action="Export" onAction={() => void doExport()}>
            Your backup is stale — everything entered since the last export is unprotected.
          </Banner>
        )}
      </div>

      <main class="content">
        {nav.view === "pantry" && <InventoryView />}
        {nav.view === "shopping" && <ShoppingView />}
        {nav.view === "more" && <SettingsView />}
        {nav.view === "reconcile" && (
          <div>
            {/* Standalone mode has no browser chrome: every screen needs an
                in-app way back. Reconcile is reached from More. */}
            <header class="screen-head">
              <button class="back-btn" type="button" onClick={() => nav.setView("more")}>
                ‹ More
              </button>
            </header>
            <ReconcileView />
          </div>
        )}
      </main>

      {nav.openItemId !== null && (
        <div class="overlay">
          <header class="screen-head">
            <button class="back-btn" type="button" onClick={nav.closeItem}>
              ‹ Back
            </button>
            <div class="screen-title">{openItem?.name ?? "Item"}</div>
          </header>
          <div class="overlay-body">
            <ItemView id={nav.openItemId} />
          </div>
        </div>
      )}

      {nav.creating && <CreateSheet />}

      <nav class="tabbar">
        <button
          type="button"
          class={tabClass(nav.view === "pantry")}
          onClick={() => nav.setView("pantry")}
        >
          Pantry
        </button>
        <button
          type="button"
          class={tabClass(nav.view === "shopping")}
          onClick={() => nav.setView("shopping")}
        >
          Shopping
          {toBuyCount > 0 && <span class="tab-badge">{toBuyCount}</span>}
        </button>
        <button
          type="button"
          // Reconcile lives under More, so More stays lit while walking shelves.
          class={tabClass(nav.view === "more" || nav.view === "reconcile")}
          onClick={() => nav.setView("more")}
        >
          More
          {/* Subtle export-nag chip at badge level (banner level shows both). */}
          {nag !== "none" && <span class="tab-dot" title="Backup recommended" />}
        </button>
      </nav>
    </div>
  );
}

