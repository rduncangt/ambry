/**
 * Document lifecycle: empty doc, load (with migration + corrupt handling),
 * save, snapshots. The BOOT RULE (PLAN.md §2): the app never silently starts
 * fresh — empty storage is indistinguishable from eviction from inside the
 * sandbox, so the UI must offer Restore-first. loadDoc reports which case
 * we're in; corrupt raw text is stashed to a snapshot key before anything
 * else happens (never destroyed).
 */
import { DEFAULT_RETENTION_DAYS, SCHEMA_VERSION, now, type AmbryDoc } from "../types";
import { DOC_KEY, SNAPSHOT_PREFIX, type StorageAdapter } from "./adapter";
import { migrateDoc } from "./migrations";

export type BootStatus = "loaded" | "empty" | "migrated" | "corrupt";

export interface LoadResult {
  doc: AmbryDoc;
  status: BootStatus;
}

export function emptyDoc(deviceLabel = "phone"): AmbryDoc {
  return {
    schema_version: SCHEMA_VERSION,
    items: [],
    events: [],
    extras: [],
    settings: {
      retention_days: DEFAULT_RETENTION_DAYS,
      last_export_at: null,
      writes_since_export: 0,
      last_trip_ended_at: null,
      device_label: deviceLabel,
    },
  };
}

/**
 * Load the document.
 * - No key -> { emptyDoc, "empty" } (UI shows the restore-first boot screen).
 * - Parse/validation failure -> stash the raw string at
 *   SNAPSHOT_PREFIX + "corrupt-<iso>" and return { emptyDoc, "corrupt" }.
 * - Older schema -> migrate; write a pre-migrate snapshot of the RAW text
 *   first (SNAPSHOT_PREFIX + "pre-migrate-v<from>"); save migrated; "migrated".
 * - Current schema -> { doc, "loaded" }.
 */
export function loadDoc(adapter: StorageAdapter): LoadResult {
  const raw = adapter.get(DOC_KEY);
  if (raw === null) {
    return { doc: emptyDoc(), status: "empty" };
  }

  try {
    const parsed: unknown = JSON.parse(raw);

    // Peek at the version BEFORE migrating: the pre-migrate snapshot must
    // hold the original bytes, so a buggy migration can never be the thing
    // that destroyed the only copy of the data.
    const version =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).schema_version
        : undefined;
    const needsMigration = typeof version === "number" && version < SCHEMA_VERSION;
    if (needsMigration) {
      try {
        writeSnapshot(adapter, `pre-migrate-v${version}`, raw);
      } catch {
        // Quota: the safety copy could not be written. Degrade rather than
        // crash the boot — the original bytes still sit at DOC_KEY until the
        // post-migrate save below replaces them.
      }
    }

    const doc = migrateDoc(parsed);
    if (needsMigration) {
      try {
        // Persist the migrated shape immediately so every later read this
        // session — and the next boot — sees the current schema.
        saveDoc(adapter, doc);
      } catch {
        // Quota at boot must degrade, not crash createStore: this session
        // still gets the migrated doc, and the store's own save path (with
        // its retry + saveError surface) owns persistence from here.
      }
      return { doc, status: "migrated" };
    }
    return { doc, status: "loaded" };
  } catch {
    // Parse OR validation failure (a newer-schema doc lands here too: the
    // running app cannot use it either way). Stash first — the stash is the
    // recovery path; the empty doc is only a placeholder for the boot screen.
    try {
      writeSnapshot(adapter, "corrupt-" + now(), raw);
    } catch {
      // Even the stash can fail (quota). The original bytes still sit at
      // DOC_KEY — and the boot rule keeps the placeholder unpersisted — so
      // returning the corrupt boot screen loses nothing.
    }
    return { doc: emptyDoc(), status: "corrupt" };
  }
}

export function saveDoc(adapter: StorageAdapter, doc: AmbryDoc): void {
  adapter.set(DOC_KEY, JSON.stringify(doc));
}

/** Stash a full copy (used before import-replace and before migration). */
export function writeSnapshot(adapter: StorageAdapter, reason: string, raw: string): void {
  adapter.set(SNAPSHOT_PREFIX + reason, raw);
}

export function listSnapshots(adapter: StorageAdapter): string[] {
  return adapter
    .keys()
    .filter((k) => k.startsWith(SNAPSHOT_PREFIX))
    .sort();
}
