/**
 * The "More" tab: backup gets top billing (PLAN.md §1.1 — export/import IS
 * the durability system), then the reconcile entry, install status,
 * housekeeping, and about. Every write goes through Store commands
 * (AGENTS.md rule 1); import is the gated whole-file REPLACE with the
 * §1.3 staleness guard — and snapshot restores reuse the same gate.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { checkStaleness, INVENTORY_FILENAME, parseImport, type ExportKind, type StalenessCheck } from "../../domain/exportImport";
import { fmtAge } from "../../domain/format";
import { SNAPSHOT_PREFIX } from "../../store/adapter";
import { STALE_DAYS, liveItems, staleCount } from "../../store/selectors";
import { now, type AmbryDoc } from "../../types";
import { APP_VERSION } from "../../version";
import { useDoc, useNav, useStore, useToast } from "../hooks";
import { doExportWithToast, exportMessage, pickFile, readText, supportsSaveFilePicker, type ExportResult } from "../share";
import { checkForUpdates, getUpdateStatus, isIOS, isStandalone, subscribeUpdate, subscribeUpdateStatus, type UpdatePhase } from "../sw-client";
import "./settings.css";

export function SettingsView() {
  return (
    <section class="view">
      <h1 class="view-title">More</h1>
      <InventoryFileSection />
      <ReconcileSection />
      <InstallSection />
      <HousekeepingSection />
      <AboutSection />
    </section>
  );
}

// ---------------------------------------------------------------------------
// The gated import/restore flow (shared by Backup and snapshot Restore)
// ---------------------------------------------------------------------------

/** Parsed candidate data (backup file or on-device snapshot), staleness-checked, awaiting the go-ahead. */
interface PendingImport {
  /** Card heading naming where these bytes came from. */
  title: string;
  doc: AmbryDoc;
  deviceLabel: string | null;
  counts: { items: number; events: number; extras: number };
  staleness: StalenessCheck;
}

/** Typed-confirm word for importing data OLDER than local (§1.3). */
const STALE_CONFIRM_WORD = "REPLACE";

/**
 * Parse text into a PendingImport with the §1.3 staleness check. `title`
 * overrides the default backup-file heading (snapshot restores name the
 * snapshot instead). Callers word their own failure message from the error.
 */
function parsePending(
  text: string,
  localDoc: AmbryDoc,
  title: string | null,
): { ok: true; pending: PendingImport } | { ok: false; error: "invalid" | "newer_schema"; detail: string } {
  const parsed = parseImport(text);
  if (!parsed.ok) return { ok: false, error: parsed.error, detail: parsed.detail };
  return {
    ok: true,
    pending: {
      title:
        title ??
        (parsed.envelope.exported_at !== null
          ? `Backup from ${new Date(parsed.envelope.exported_at).toLocaleString()}`
          : "Backup (no export date)"),
      doc: parsed.doc,
      deviceLabel: parsed.envelope.device_label,
      counts: parsed.envelope.counts,
      staleness: checkStaleness(localDoc, parsed.doc),
    },
  };
}

/**
 * THE preview/confirm card for every whole-file REPLACE: counts on both
 * sides, the loud older-than-local guard with its typed override, then
 * importReplace (which snapshots current data first). One component so a
 * snapshot restore can never grow a laxer gate than a file import.
 */
function ImportPreview(props: {
  pending: PendingImport;
  onCancel: () => void;
  /** Called INSTEAD of success handling when the replace could not persist. */
  onError: (message: string) => void;
}) {
  const store = useStore();
  const doc = useDoc();
  const [confirmText, setConfirmText] = useState("");
  const pending = props.pending;
  const nowIso = now();

  const staleOverrideOk = confirmText.trim().toUpperCase() === STALE_CONFIRM_WORD;

  const localeOrNone = (iso: string | null): string =>
    iso === null ? "none" : new Date(iso).toLocaleString();

  function doReplace(): void {
    // Belt and braces: the button is disabled too, but a stale import must
    // never slip through without the typed override.
    if (pending.staleness.incomingIsOlder && !staleOverrideOk) return;
    const outcome = store.importReplace(pending.doc);
    if (!outcome.ok) {
      props.onError(
        "Import failed — the data could not be saved on this device. Your current data is unchanged.",
      );
      return;
    }
    // Whole-doc swap: every mounted view holds state derived from the old
    // doc, and importReplace already flushed synchronously — a clean reload
    // is the simplest correct recovery.
    window.location.reload();
  }

  return (
    <div class="settings-import-card">
      <div>
        <div class="row-title">{pending.title}</div>
        {pending.deviceLabel !== null && pending.deviceLabel !== "" && (
          <div class="row-sub">Device: {pending.deviceLabel}</div>
        )}
        <div class="row-sub">
          {pending.counts.items} items · {pending.counts.events} events ·{" "}
          {pending.counts.extras} extras
        </div>
      </div>
      <div>
        <div class="row-title">Replaces current data</div>
        <div class="row-sub">
          {doc.items.length} items · {doc.events.length} events · {doc.extras.length} extras
          — last edited {fmtAge(pending.staleness.localLatest, nowIso)}
        </div>
      </div>
      {pending.staleness.incomingIsOlder && (
        <div class="settings-import-stale" role="alert">
          <strong>This data is OLDER than the data on this phone.</strong>
          <span>
            Newest edit in it: {localeOrNone(pending.staleness.incomingLatest)}. On this
            phone: {localeOrNone(pending.staleness.localLatest)}. Importing it throws away
            everything entered since. Type {STALE_CONFIRM_WORD} to allow it.
          </span>
          <input
            class="field-input"
            type="text"
            autocomplete="off"
            aria-label={`Type ${STALE_CONFIRM_WORD} to confirm`}
            placeholder={STALE_CONFIRM_WORD}
            value={confirmText}
            onInput={(e) => setConfirmText(e.currentTarget.value)}
          />
        </div>
      )}
      <p class="settings-note">
        A snapshot of the current data is kept on this device before anything is replaced.
      </p>
      <button
        class={`btn btn-big ${pending.staleness.incomingIsOlder ? "btn-danger" : "btn-primary"}`}
        type="button"
        disabled={pending.staleness.incomingIsOlder && !staleOverrideOk}
        onClick={doReplace}
      >
        Replace current data
      </button>
      <button class="btn" type="button" onClick={props.onCancel}>
        Cancel
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inventory file — routine replacement, optional archive, gated restore
// ---------------------------------------------------------------------------

function InventoryFileSection() {
  const store = useStore();
  const doc = useDoc();
  const toast = useToast();
  const [pending, setPending] = useState<PendingImport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<ExportKind | null>(null);
  const savingRef = useRef(false);
  const [result, setResult] = useState<{ outcome: ExportResult; kind: ExportKind } | null>(null);

  const nowIso = now();
  const settings = doc.settings;
  const changes = settings.writes_since_export;
  const hasCopy = settings.last_export_at !== null;

  async function save(kind: ExportKind): Promise<void> {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(kind);
    setResult(null);
    const outcome = await doExportWithToast(store, toast, kind);
    setResult({ outcome, kind });
    setSaving(null);
    savingRef.current = false;
  }

  async function chooseImport(): Promise<void> {
    setError(null);
    setPending(null);
    const file = await pickFile("application/json,.json,text/plain");
    if (file === null) return;
    const text = await readText(file);
    const outcome = parsePending(text, store.getDoc(), null);
    if (!outcome.ok) {
      // Plain words, not error codes: "newer_schema" means THIS app is the
      // stale half of the pair.
      setError(
        outcome.error === "newer_schema"
          ? "This backup was made by a newer version of Ambry — update the app first, then import it."
          : `That file could not be read as an Ambry backup. (${outcome.detail})`,
      );
      return;
    }
    setPending(outcome.pending);
  }

  return (
    <section class="settings-section">
      <h2 class="settings-h">Inventory file</h2>
      <div class="settings-file-card">
        <div>
          <div class="settings-file-name">{INVENTORY_FILENAME}</div>
          <p class="settings-note">One file to keep up to date. Includes your pantry, shopping list and history.</p>
        </div>
        <div class="settings-file-status">
          <span>{hasCopy ? `Last copy: ${fmtAge(settings.last_export_at, nowIso)}` : "No file saved yet"}</span>
          {hasCopy && <span>{changes === 0 ? "No changes since then" : `${changes} ${changes === 1 ? "change" : "changes"} since then`}</span>}
        </div>
        <button
          class="btn btn-primary btn-big"
          type="button"
          disabled={saving !== null}
          onClick={() => void save("inventory")}
        >
          {saving === "inventory" ? "Saving…" : hasCopy ? "Update inventory file" : "Save inventory file"}
        </button>
        <p class="settings-note">
          {supportsSaveFilePicker()
            ? "Choose your existing file to replace it, or create it the first time. A cloud folder keeps it available on your other devices."
            : isIOS()
              ? <>Choose <strong>Save to Files</strong>, use the same folder, then <strong>Replace</strong> when asked. iCloud Drive keeps a copy off this phone.</>
              : "Save to the same folder and replace the old file when asked. If your browser downloads a separate copy, move it over the old one."}
        </p>
      </div>
      <p class="settings-note settings-file-local">Changes stay in Ambry as you go. Update this file when you want a fresh copy outside the app.</p>

      <details class="settings-file-copy">
        <summary>Keep a separate copy</summary>
        <div class="settings-stack">
          <p class="settings-note">Save this version with a date in the filename, so you can keep it alongside your regular inventory file.</p>
          <button class="btn" type="button" disabled={saving !== null} onClick={() => void save("dated-copy")}>
            {saving === "dated-copy" ? "Saving…" : "Save a dated copy"}
          </button>
        </div>
      </details>
      {result !== null && (
        <p class={result.outcome === "failed" ? "settings-error settings-file-result" : "settings-note settings-file-result"}
          role={result.outcome === "failed" ? "alert" : "status"}>
          {exportMessage(result.outcome, result.kind)}
        </p>
      )}

      <div class="settings-stack settings-file-restore">
        {pending === null && (
          <>
            <button class="btn" type="button" disabled={saving !== null} onClick={() => void chooseImport()}>
              Restore from a file…
            </button>
            <p class="settings-note">Use an inventory file or an older backup to replace this pantry. You’ll review it before anything changes.</p>
          </>
        )}
        {error !== null && <p class="settings-error">{error}</p>}
        {pending !== null && (
          <ImportPreview
            pending={pending}
            onCancel={() => setPending(null)}
            onError={(message) => {
              setPending(null);
              setError(message);
            }}
          />
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Reconcile entry
// ---------------------------------------------------------------------------

function ReconcileSection() {
  const doc = useDoc();
  const nav = useNav();
  // The canonical staleness rule (selectors.staleCount) — the same count the
  // pantry's stale line shows, so the two nudges can never disagree.
  const stale = staleCount(doc, now());

  return (
    <section class="settings-section">
      <h2 class="settings-h">Reconcile</h2>
      <div class="settings-stack">
        <button class="btn btn-big" type="button" onClick={() => nav.setView("reconcile")}>
          Walk the shelves
        </button>
        <p class="settings-note">
          {stale === 0
            ? `Every item was confirmed within the last ${STALE_DAYS} days.`
            : `${stale} item${stale === 1 ? "" : "s"} not confirmed in ${STALE_DAYS}+ days — a two-minute pass keeps the counts honest.`}
        </p>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

function InstallSection() {
  return (
    <section class="settings-section">
      <h2 class="settings-h">Install</h2>
      {isStandalone() ? (
        <p class="settings-note">Installed ✓</p>
      ) : (
        <div class="settings-stack">
          {isIOS() ? (
            <p>
              In Safari: tap <strong>Share</strong>, then <strong>"Add to Home Screen"</strong>.
            </p>
          ) : (
            <p>Install from your browser's menu ("Install app" or "Add to Home Screen").</p>
          )}
          <p class="settings-note">
            Why it matters: iOS deletes an uninstalled web app's data after about 7 days
            without a visit. The installed app also gets its own storage, separate from this
            browser tab — so install first, then export here and restore there, or anything
            entered here stays behind.
          </p>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

/** "pre-import-<iso>"/"corrupt-<iso>" get a human date; other reasons (pre-migrate-vN) show raw. */
function snapshotLabel(key: string): string {
  const reason = key.slice(SNAPSHOT_PREFIX.length);
  const m = reason.match(/^(pre-import|corrupt)-(.+)$/);
  if (m !== null) {
    const t = Date.parse(m[2] ?? "");
    if (Number.isFinite(t)) {
      const when = new Date(t).toLocaleString();
      return m[1] === "corrupt" ? `Damaged data — ${when}` : `Before import — ${when}`;
    }
  }
  return reason;
}

function HousekeepingSection() {
  const store = useStore();
  const doc = useDoc();
  const toast = useToast();
  // Draft input state, seeded from settings once; commits on blur. The doc
  // reference is stable (store mutates in place), so no resync effect needed.
  const [retention, setRetention] = useState(() => String(doc.settings.retention_days));
  const [label, setLabel] = useState(() => doc.settings.device_label);
  // Snapshot-restore flow state: the pending card renders next to the list,
  // through the SAME gated ImportPreview the backup import uses.
  const [snapPending, setSnapPending] = useState<PendingImport | null>(null);
  const [snapError, setSnapError] = useState<string | null>(null);

  function commitRetention(): void {
    const n = Number(retention.trim());
    if (!Number.isInteger(n) || n < 1) {
      // Invalid entry snaps back to the stored value — nonsense never persists.
      setRetention(String(doc.settings.retention_days));
      return;
    }
    if (n === doc.settings.retention_days) return;
    store.updateSettings({ retention_days: n });
    toast(`History kept for ${n} days`);
  }

  function commitLabel(): void {
    const trimmed = label.trim();
    setLabel(trimmed);
    if (trimmed === doc.settings.device_label) return;
    store.updateSettings({ device_label: trimmed });
    toast("Device label saved");
  }

  function pruneNow(): void {
    // prune() returns nothing; diff the counts around it for an honest toast.
    const before = store.getDoc();
    const beforeEvents = before.events.length;
    const beforeExtras = before.extras.length;
    store.prune();
    const after = store.getDoc();
    const events = beforeEvents - after.events.length;
    const extras = beforeExtras - after.extras.length;
    const parts: string[] = [];
    if (events > 0) parts.push(`${events} old event${events === 1 ? "" : "s"}`);
    if (extras > 0) parts.push(`${extras} checked-off extra${extras === 1 ? "" : "s"}`);
    toast(parts.length === 0 ? "Nothing to prune" : `Pruned ${parts.join(" and ")}`);
  }

  // -- snapshot actions -----------------------------------------------------
  // On an installed iPhone this list is the ONLY way to reach these bytes —
  // BootScreen promises "nothing was destroyed", so a snapshot must be
  // shareable (raw bytes off-device, even when too damaged to parse),
  // restorable (through the gated import), and deletable (frees quota).

  async function shareSnapshot(key: string): Promise<void> {
    const text = store.snapshotText(key);
    if (text === null) {
      setSnapError("That snapshot is no longer in storage.");
      return;
    }
    // Named after the key so a folder of shared snapshots stays traceable to
    // what each one was. application/json even for corrupt stashes — the
    // receiver decides what to make of the bytes.
    const file = new File([text], `${key}.json`, { type: "application/json" });
    if (typeof navigator.share === "function" && navigator.canShare?.({ files: [file] }) === true) {
      try {
        await navigator.share({ files: [file] });
        toast("Snapshot shared");
        return;
      } catch (e) {
        // AbortError = the user closed the sheet: nothing left the device.
        if (e instanceof DOMException && e.name === "AbortError") return;
        // Any other share failure: fall through to the download path below.
      }
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke later, not synchronously — some engines abort the save if the
    // URL dies before the download pipeline picks it up.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    toast("Snapshot downloaded");
  }

  function restoreSnapshot(key: string): void {
    setSnapError(null);
    setSnapPending(null);
    const text = store.snapshotText(key);
    if (text === null) {
      setSnapError("That snapshot is no longer in storage.");
      return;
    }
    const outcome = parsePending(text, store.getDoc(), `Snapshot: ${snapshotLabel(key)}`);
    if (!outcome.ok) {
      // A corrupt stash may genuinely not parse — Share still gets the raw
      // bytes off the device for repair elsewhere.
      setSnapError(
        outcome.error === "newer_schema"
          ? "This snapshot was written by a newer version of Ambry — update the app first."
          : `This snapshot can't be restored directly (${outcome.detail}). Share it to move the raw bytes off this phone.`,
      );
      return;
    }
    setSnapPending(outcome.pending);
  }

  function deleteSnapshot(key: string): void {
    const ok = window.confirm(
      `Delete the snapshot "${snapshotLabel(key)}"? This frees storage and cannot be undone.`,
    );
    if (!ok) return;
    store.deleteSnapshot(key);
    setSnapPending(null);
    setSnapError(null);
    toast("Snapshot deleted");
  }

  // All snapshot access goes through the Store's read-only snapshot API —
  // the UI never touches the storage adapter (AGENTS.md rule 1's spirit).
  let snapshots: { key: string; bytes: number }[];
  try {
    snapshots = store.listSnapshots();
  } catch {
    // Storage access itself can throw (private mode, blocked site data);
    // an empty list beats a crashed More tab.
    snapshots = [];
  }

  return (
    <section class="settings-section">
      <h2 class="settings-h">Housekeeping</h2>
      <div class="settings-stack">
        <label class="settings-field">
          <span class="settings-field-label">History retention (days)</span>
          <input
            class="field-input"
            type="text"
            inputMode="numeric"
            autocomplete="off"
            value={retention}
            onInput={(e) => setRetention(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            onBlur={commitRetention}
          />
        </label>
        <p class="settings-note">
          History events older than this are removed at launch; each item's most recent event
          is always kept, so nothing loses its last known context. Longer keeps richer
          history — shorter keeps the on-device document small.
        </p>
        <label class="settings-field">
          <span class="settings-field-label">Device label</span>
          <input
            class="field-input"
            type="text"
            autocomplete="off"
            value={label}
            onInput={(e) => setLabel(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            onBlur={commitLabel}
          />
        </label>
        <p class="settings-note">
          Included inside saved files so you can tell which device they came from.
        </p>
        <button class="btn" type="button" onClick={pruneNow}>
          Prune now
        </button>
        {snapshots.length > 0 && (
          <div>
            <div class="settings-field-label">Snapshots on this device</div>
            {snapshots.map((s) => (
              <div class="settings-snap" key={s.key}>
                <div class="settings-kv">
                  <span class="settings-kv-label">{snapshotLabel(s.key)}</span>
                  <span>{Math.max(1, Math.round(s.bytes / 1024))} KB</span>
                </div>
                <div class="settings-snap-acts">
                  <button class="btn" type="button" onClick={() => void shareSnapshot(s.key)}>
                    Share…
                  </button>
                  <button class="btn" type="button" onClick={() => restoreSnapshot(s.key)}>
                    Restore…
                  </button>
                  <button
                    class="btn settings-snap-delete"
                    type="button"
                    onClick={() => deleteSnapshot(s.key)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
            {snapError !== null && <p class="settings-error">{snapError}</p>}
            {snapPending !== null && (
              <ImportPreview
                pending={snapPending}
                onCancel={() => setSnapPending(null)}
                onError={(message) => {
                  setSnapPending(null);
                  setSnapError(message);
                }}
              />
            )}
            <p class="settings-note">
              Automatic copies taken before imports and migrations, or when damaged data was
              found at launch. They live in this browser's storage only — share one to get
              its raw bytes off the device, restore to make it the live data (gated like any
              import), delete to free space.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// About
// ---------------------------------------------------------------------------

function AboutSection() {
  const doc = useDoc();
  const [update, setUpdate] = useState(getUpdateStatus);
  const [restart, setRestart] = useState<(() => void) | null>(null);
  useEffect(() => subscribeUpdateStatus(setUpdate), []);
  useEffect(() => subscribeUpdate((apply) => setRestart(() => apply)), []);
  const updateText: Record<UpdatePhase, string> = {
    idle: "Check whether a newer version is available.",
    checking: "Checking for updates…",
    downloading: "Downloading an update…",
    current: "You're up to date.",
    ready: "Update ready — restart to install it.",
    error: "Could not check or download the update. Check your connection and try again.",
    unavailable: "Update checks aren't available in this browser or development build.",
  };
  const live = liveItems(doc).length;
  const deleted = doc.items.length - live;
  // The doc IS one JSON string in storage, so its serialized length is the
  // honest footprint estimate (this data is ASCII-heavy: chars ≈ bytes).
  const sizeKb = Math.max(1, Math.round(JSON.stringify(doc).length / 1024));

  return (
    <section class="settings-section">
      <h2 class="settings-h">About</h2>
      <div class="settings-kv">
        <span class="settings-kv-label">Installed version</span>
        <span>{APP_VERSION}</span>
      </div>
      <div class="settings-updates">
        <p class="settings-note" role="status">{updateText[update.phase]}</p>
        {update.checkedAt !== null && <p class="settings-note">Last checked {new Date(update.checkedAt).toLocaleString()}</p>}
        {update.phase === "ready" && restart !== null ? (
          <button class="btn btn-primary" type="button" onClick={restart}>Restart to update</button>
        ) : (
          <button class="btn" type="button" disabled={update.phase === "checking" || update.phase === "downloading"} onClick={() => void checkForUpdates()}>Check for updates</button>
        )}
      </div>
      <div class="settings-kv">
        <span class="settings-kv-label">Items</span>
        <span>{deleted > 0 ? `${live} (+${deleted} deleted)` : String(live)}</span>
      </div>
      <div class="settings-kv">
        <span class="settings-kv-label">History events</span>
        <span>{doc.events.length}</span>
      </div>
      <div class="settings-kv">
        <span class="settings-kv-label">Storage used</span>
        <span>≈ {sizeKb} KB</span>
      </div>
      <p class="settings-note">
        Ambry — a local-first pantry log. No server, no accounts; your data lives on this
        device and in the backups you export. Built with Preact.
      </p>
    </section>
  );
}
