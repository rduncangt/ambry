/**
 * App shell: boot gate → banner stack → current view → overlays → tab bar.
 * All state flows from useDoc(); all writes go through the Store commands.
 */
import { useEffect, useState, useRef } from "preact/hooks";
import { backupAgeDays, exportNag, shoppingList } from "../store/selectors";
import type { Store } from "../store/store";
import { EXPORT_NAG_DAYS, now , type AmbryDoc } from "../types";
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
import { doExportWithToast } from "./share";
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
  // The toast pill is tap-through EXCEPT its Undo button — which must never
  // sit on a banner's action (Export/Reload). Publish the banner stack's
  // live height as a CSS var; the pill docks below it (styles.css .toast).
  const bannersRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = bannersRef.current;
    if (el === null) return;
    const root = document.documentElement;
    const publish = (): void =>
      root.style.setProperty("--banners-h", `${Math.ceil(el.getBoundingClientRect().height)}px`);
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.setProperty("--banners-h", "0px");
    };
  }, []);

  // Update pill: main.tsx registered the SW; the bridge hands us apply().
  const [applyUpdate, setApplyUpdate] = useState<(() => void) | null>(null);
  useEffect(() => subscribeUpdate((apply) => setApplyUpdate(() => apply)), []);

  // Install nag: session-dismissable only — it must come back next launch
  // until standalone mode is detected (PLAN.md §1.1).
  const [installDismissed, setInstallDismissed] = useState(false);
  const showInstall = isIOS() && !isStandalone() && !installDismissed;

  const nowIso = now();
  const nag = exportNag(doc, nowIso);
  const shopping = shoppingList(doc);
  const toBuyCount = shopping.toBuy.length + shopping.inCart.length + shopping.extras.length + shopping.cartExtras.length;

  const openItem =
    nav.openItemId !== null ? doc.items.find((i) => i.id === nav.openItemId) : undefined;

  const tabClass = (active: boolean): string => `tab${active ? " tab-active" : ""}`;

  return (
    <div class="app">
      <div class="banners" ref={bannersRef}>
        {/* Storage banners read the store directly each render — the store
            notifies subscribers when either flag flips, and useDoc() above
            already re-renders this component on every notify. */}
        {store.storageConflict() && (
          <Banner kind="warn" action="Reload" onAction={() => location.reload()}>
            This pantry was changed in another tab — reload to continue.
          </Banner>
        )}
        {store.saveError() && (
          <Banner kind="warn" action="Save file" onAction={() => void doExportWithToast(store, toast)}>
            <strong>Storage full — changes are NOT being saved.</strong> Save your inventory file now,
            then free space by deleting old snapshots in More → Housekeeping.
          </Banner>
        )}
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
          // ONE short line: a taller banner scroll-sheared into an orphaned
          // half-sentence above the sticky Pantry header. The what's-at-risk
          // sentence lives in Settings next to the same numbers; the banner
          // names whichever threshold actually fired (age or write count).
          <Banner kind="warn" action="Save file" onAction={() => void doExportWithToast(store, toast)}>
            {bannerCopy(doc, nowIso)}
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
          {/* Sticky: deep in a long item page, "which item is this?" must
              stay answered — the header pins below the status-bar inset and
              rows slide under it (styles.css .overlay-head). */}
          <header class="screen-head overlay-head">
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

/** One honest line for the export banner. Never exported: say so plainly —
 *  "backup is N days old" would send the user hunting iCloud for a file that
 *  does not exist — with day counts clamped (clock skew can go negative) and
 *  pluralized ("1 days" shipped once). */
function bannerCopy(doc: AmbryDoc, nowIso: string): string {
  const d = Math.max(0, Math.floor(backupAgeDays(doc, nowIso)));
  if (doc.settings.last_export_at === null) {
    if (d === 0) return "No backup yet — less than a day of data at risk.";
    return `No backup yet — ${d} ${d === 1 ? "day" : "days"} of data at risk.`;
  }
  if (d >= EXPORT_NAG_DAYS * 2) return `Backup is ${d} ${d === 1 ? "day" : "days"} old.`;
  return `${doc.settings.writes_since_export} changes since the last backup.`;
}
