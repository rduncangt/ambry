/**
 * Export/import — the only backup, so full fidelity is non-negotiable
 * (PLAN.md §1.1): tombstones, events, extras, settings all included.
 * Import is whole-file REPLACE, gated (PLAN.md §1.3): validate -> migrate ->
 * preview -> staleness guard -> snapshot current -> replace.
 */
import type { AmbryDoc, ExportEnvelope } from "../types";
import { NewerSchemaError, migrateDoc } from "../store/migrations";

/** Build the full-fidelity envelope. */
export function buildExport(doc: AmbryDoc, nowIso: string, deviceLabel?: string): ExportEnvelope {
  return {
    app: "ambry",
    schema_version: doc.schema_version,
    exported_at: nowIso,
    device_label: deviceLabel ?? doc.settings.device_label,
    // Counts are for the human preview on re-import; they count everything
    // the arrays hold — tombstones included — because the arrays do.
    counts: {
      items: doc.items.length,
      events: doc.events.length,
      extras: doc.extras.length,
    },
    items: doc.items,
    events: doc.events,
    extras: doc.extras,
    settings: doc.settings,
  };
}

/** "ambry-backup-2026-08-27-1930.json" — local time, sortable. */
export function exportFilename(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  // Local time on purpose: the filename is for the human sorting a folder of
  // backups, and "1930" should match the clock on the wall when they tapped.
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `ambry-backup-${date}-${time}.json`;
}

export type ParseImportResult =
  | { ok: true; doc: AmbryDoc; envelope: { exported_at: string | null; device_label: string | null; counts: { items: number; events: number; extras: number } } }
  | { ok: false; error: "invalid" | "newer_schema"; detail: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Parse + validate + migrate an import file's text into a current-shape doc.
 * Accepts both a full ExportEnvelope and a bare AmbryDoc (a raw doc snapshot
 * is also a valid restore source). Never throws.
 */
export function parseImport(text: string): ParseImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      error: "invalid",
      detail: `Not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  let docRaw: unknown = parsed;
  let exported_at: string | null = null;
  let device_label: string | null = null;
  if (isPlainObject(parsed) && parsed.app === "ambry") {
    // Envelope: peel off the envelope-only metadata and hand the REST to the
    // migration pipeline, so any doc-level field an old export carried is
    // still there for its migration to consume.
    const { app: _app, exported_at: ea, device_label: dl, counts: _counts, ...rest } = parsed;
    docRaw = rest;
    exported_at = typeof ea === "string" ? ea : null;
    device_label = typeof dl === "string" ? dl : null;
  }

  let doc: AmbryDoc;
  try {
    // R3: import runs the exact same migration pipeline as load.
    doc = migrateDoc(docRaw);
  } catch (e) {
    if (e instanceof NewerSchemaError) {
      return { ok: false, error: "newer_schema", detail: e.message };
    }
    return {
      ok: false,
      error: "invalid",
      detail: e instanceof Error ? e.message : String(e),
    };
  }

  return {
    ok: true,
    doc,
    envelope: {
      exported_at,
      device_label,
      // Recomputed from the migrated arrays, never read from the file: the
      // preview must describe what would actually be imported, even when a
      // hand-edited envelope's stored counts lie.
      counts: {
        items: doc.items.length,
        events: doc.events.length,
        extras: doc.extras.length,
      },
    },
  };
}

export interface StalenessCheck {
  /** true when the incoming file's newest edit is older than local's — refuse with loud override. */
  incomingIsOlder: boolean;
  localLatest: string | null;
  incomingLatest: string | null;
}

/**
 * Newest human edit in a doc: max updated_at over items + extras (tombstones
 * included — soft delete bumps updated_at and IS an edit). Only when neither
 * array has a row do events' `at` stand in. ISO-8601 UTC strings compare
 * correctly as plain strings.
 */
function latestEdit(doc: AmbryDoc): string | null {
  let max: string | null = null;
  for (const it of doc.items) {
    if (max === null || it.updated_at > max) max = it.updated_at;
  }
  for (const ex of doc.extras) {
    if (max === null || ex.updated_at > max) max = ex.updated_at;
  }
  if (max === null) {
    for (const ev of doc.events) {
      if (max === null || ev.at > max) max = ev.at;
    }
  }
  return max;
}

/**
 * Compare max updated_at (items + extras; falls back to events' `at`) between
 * the live doc and an incoming one. An empty local doc is never "newer".
 */
export function checkStaleness(local: AmbryDoc, incoming: AmbryDoc): StalenessCheck {
  const localLatest = latestEdit(local);
  const incomingLatest = latestEdit(incoming);
  // Strictly-older only: equal timestamps are NOT older (re-importing the
  // backup you just made must not trip the guard). An empty local doc never
  // blocks a restore; an empty incoming file over real local data does.
  const incomingIsOlder =
    localLatest !== null && (incomingLatest === null || incomingLatest < localLatest);
  return { incomingIsOlder, localLatest, incomingLatest };
}

/**
 * Re-stamp a doc's item/extra timestamps to `nowIso`, IN PLACE. Built for the
 * bundled starter pantry: its JSON carries frozen build-time dates, so
 * without this a user starting fresh N days after the seed was generated
 * boots a minutes-old pantry that instantly claims "N days of data at risk",
 * fills "Needs a check", and reads fully stale. Events are deliberately NOT
 * touched — restamping history would falsify a real backup, and the seed
 * ships none. verified_at stays as-is (null in the seed: uncounted is true).
 */
export function restampDoc(doc: AmbryDoc, nowIso: string): void {
  for (const item of doc.items) {
    item.created_at = nowIso;
    item.updated_at = nowIso;
  }
  for (const extra of doc.extras) {
    extra.created_at = nowIso;
    extra.updated_at = nowIso;
  }
}
