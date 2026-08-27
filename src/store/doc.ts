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
  throw new Error("TODO: implement (workflow)");
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
