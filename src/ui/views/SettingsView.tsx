/**
 * The "More" tab: backup gets top billing (PLAN.md §1.1 — export/import IS
 * the durability system), then the reconcile entry, install status,
 * housekeeping, and about. Every write goes through Store commands
 * (AGENTS.md rule 1); import is the gated whole-file REPLACE with the
 * §1.3 staleness guard.
 */
import { useState } from "preact/hooks";
import { checkStaleness, parseImport, type StalenessCheck } from "../../domain/exportImport";
import { fmtAge } from "../../domain/format";
import { SNAPSHOT_PREFIX, localStorageAdapter } from "../../store/adapter";
import { liveItems } from "../../store/selectors";
import { now, type AmbryDoc } from "../../types";
import { APP_VERSION } from "../../version";
import { useDoc, useNav, useStore, useToast } from "../hooks";
import { exportFlow, pickFile, readText } from "../share";
import { isIOS, isStandalone } from "../sw-client";
import "./settings.css";

export function SettingsView() {
  return (
    <section class="view">
      <h1 class="view-title">More</h1>
      <BackupSection />
      <ReconcileSection />
      <InstallSection />
      <HousekeepingSection />
      <AboutSection />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Backup — export via share sheet, gated import
// ---------------------------------------------------------------------------

/** A picked backup file, parsed and staleness-checked, awaiting the go-ahead. */
interface PendingImport {
  doc: AmbryDoc;
  exportedAt: string | null;
  deviceLabel: string | null;
  counts: { items: number; events: number; extras: number };
  staleness: StalenessCheck;
}

/** Typed-confirm word for importing a backup OLDER than local data (§1.3). */
const STALE_CONFIRM_WORD = "REPLACE";

function BackupSection() {
  const store = useStore();
  const doc = useDoc();
  const toast = useToast();
  const [pending, setPending] = useState<PendingImport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState("");

  const nowIso = now();
  const settings = doc.settings;

  async function doExport(): Promise<void> {
    const result = await exportFlow(store);
    if (result === "shared") toast("Backup exported");
    else if (result === "downloaded") toast("Backup downloaded");
    else toast("Export cancelled — no backup was made");
  }

  async function chooseImport(): Promise<void> {
    setError(null);
    setPending(null);
    setConfirmText("");
    const file = await pickFile("application/json,.json,text/plain");
    if (file === null) return;
    const text = await readText(file);
    const parsed = parseImport(text);
    if (!parsed.ok) {
      // Plain words, not error codes: "newer_schema" means THIS app is the
      // stale half of the pair.
      setError(
        parsed.error === "newer_schema"
          ? "This backup was made by a newer version of Ambry — update the app first, then import it."
          : `That file could not be read as an Ambry backup. (${parsed.detail})`,
      );
      return;
    }
    setPending({
      doc: parsed.doc,
      exportedAt: parsed.envelope.exported_at,
      deviceLabel: parsed.envelope.device_label,
      counts: parsed.envelope.counts,
      staleness: checkStaleness(store.getDoc(), parsed.doc),
    });
  }

  const staleOverrideOk = confirmText.trim().toUpperCase() === STALE_CONFIRM_WORD;

  function doReplace(): void {
    if (pending === null) return;
    // Belt and braces: the button is disabled too, but a stale import must
    // never slip through without the typed override.
    if (pending.staleness.incomingIsOlder && !staleOverrideOk) return;
    const outcome = store.importReplace(pending.doc);
    if (!outcome.ok) {
      setPending(null);
      setError("Import failed — the backup could not be saved on this device. Your current data is unchanged.");
      return;
    }
    // Whole-doc swap: every mounted view holds state derived from the old
    // doc, and importReplace already flushed synchronously — a clean reload
    // is the simplest correct recovery.
    window.location.reload();
  }

  const localeOrNone = (iso: string | null): string =>
    iso === null ? "none" : new Date(iso).toLocaleString();

  return (
    <section class="settings-section">
      <h2 class="settings-h">Backup</h2>
      <div class="settings-kv">
        <span class="settings-kv-label">Last backup</span>
        <span>{fmtAge(settings.last_export_at, nowIso)}</span>
      </div>
      <div class="settings-kv">
        <span class="settings-kv-label">Writes since backup</span>
        <span>{settings.writes_since_export}</span>
      </div>
      <p class="settings-note">
        Data since the last export is unprotected; the nag threshold bounds that window.
      </p>
      <div class="settings-stack">
        <button class="btn btn-primary btn-big" type="button" onClick={() => void doExport()}>
          Export backup
        </button>
        <p class="settings-note">
          From the share sheet, save to iCloud Drive or AirDrop to another
          device — a backup that stays on this phone dies with the phone.
        </p>
        {pending === null && (
          <button class="btn" type="button" onClick={() => void chooseImport()}>
            Import backup…
          </button>
        )}
        {error !== null && <p class="settings-error">{error}</p>}
        {pending !== null && (
          <div class="settings-import-card">
            <div>
              <div class="row-title">
                {pending.exportedAt !== null
                  ? `Backup from ${new Date(pending.exportedAt).toLocaleString()}`
                  : "Backup (no export date)"}
              </div>
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
                {doc.items.length} items · {doc.events.length} events · {doc.extras.length}{" "}
                extras — last edited {fmtAge(pending.staleness.localLatest, nowIso)}
              </div>
            </div>
            {pending.staleness.incomingIsOlder && (
              <div class="settings-import-stale" role="alert">
                <strong>This backup is OLDER than the data on this phone.</strong>
                <span>
                  Newest edit in the file: {localeOrNone(pending.staleness.incomingLatest)}. On
                  this phone: {localeOrNone(pending.staleness.localLatest)}. Importing it throws
                  away everything entered since. Type {STALE_CONFIRM_WORD} to allow it.
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
            <button
              class="btn"
              type="button"
              onClick={() => {
                setPending(null);
                setConfirmText("");
              }}
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Reconcile entry
// ---------------------------------------------------------------------------

/** UI-level hint only: how old an unconfirmed item counts as "stale" for the
 *  count beside the reconcile entry. Reconcile itself just sorts
 *  stalest-first — this number decides nothing in the domain. */
const STALE_HINT_DAYS = 30;
const DAY_MS = 86_400_000;

function ReconcileSection() {
  const doc = useDoc();
  const nav = useNav();
  const nowMs = Date.parse(now());
  const staleCount = liveItems(doc).filter(
    (i) =>
      i.verified_at === null || nowMs - Date.parse(i.verified_at) >= STALE_HINT_DAYS * DAY_MS,
  ).length;

  return (
    <section class="settings-section">
      <h2 class="settings-h">Reconcile</h2>
      <div class="settings-stack">
        <button class="btn btn-big" type="button" onClick={() => nav.setView("reconcile")}>
          Walk the shelves
        </button>
        <p class="settings-note">
          {staleCount === 0
            ? `Every item was confirmed within the last ${STALE_HINT_DAYS} days.`
            : `${staleCount} item${staleCount === 1 ? "" : "s"} not confirmed in ${STALE_HINT_DAYS}+ days — a two-minute pass keeps the counts honest.`}
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

interface SnapshotInfo {
  key: string;
  text: string;
  sizeKb: number;
}

/**
 * Read-only snapshot listing. The Store exposes no snapshot API, so this
 * reads through the adapter module directly — the one sanctioned storage
 * seam (R3). Display only: nothing here writes. try/catch because storage
 * access itself can throw (private mode, blocked site data).
 */
function listSnapshots(): SnapshotInfo[] {
  try {
    const adapter = localStorageAdapter();
    return adapter
      .keys()
      .filter((k) => k.startsWith(SNAPSHOT_PREFIX))
      .sort()
      .reverse() // reasons embed ISO timestamps, so string order ≈ newest first
      .map((key) => {
        const reason = key.slice(SNAPSHOT_PREFIX.length);
        return {
          key,
          text: snapshotLabel(reason),
          sizeKb: Math.max(1, Math.round((adapter.get(key) ?? "").length / 1024)),
        };
      });
  } catch {
    return [];
  }
}

/** "pre-import-<iso>" gets a human date; other reasons (pre-migrate-vN) show raw. */
function snapshotLabel(reason: string): string {
  const m = reason.match(/^pre-import-(.+)$/);
  if (m !== null) {
    const t = Date.parse(m[1] ?? "");
    if (Number.isFinite(t)) return `Before import — ${new Date(t).toLocaleString()}`;
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

  const snapshots = listSnapshots();

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
          Stamped into every backup file, so a folder of exports says which device wrote each
          one.
        </p>
        <button class="btn" type="button" onClick={pruneNow}>
          Prune now
        </button>
        {snapshots.length > 0 && (
          <div>
            <div class="settings-field-label">Snapshots on this device</div>
            {snapshots.map((s) => (
              <div class="settings-kv" key={s.key}>
                <span class="settings-kv-label">{s.text}</span>
                <span>{s.sizeKb} KB</span>
              </div>
            ))}
            <p class="settings-note">
              Automatic copies taken before imports and migrations. They live in this
              browser's storage only — they are not backups and die with the device.
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
  const live = liveItems(doc).length;
  const deleted = doc.items.length - live;
  // The doc IS one JSON string in storage, so its serialized length is the
  // honest footprint estimate (this data is ASCII-heavy: chars ≈ bytes).
  const sizeKb = Math.max(1, Math.round(JSON.stringify(doc).length / 1024));

  return (
    <section class="settings-section">
      <h2 class="settings-h">About</h2>
      <div class="settings-kv">
        <span class="settings-kv-label">Version</span>
        <span>{APP_VERSION}</span>
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
