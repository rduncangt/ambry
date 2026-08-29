/**
 * Schema migrations (R3): ordered pure functions, one per version bump,
 * run at load AND at import through the same pipeline — so a 2026 export
 * imports cleanly into the 2030 app. NEVER delete a migration function.
 */
import { DEFAULT_RETENTION_DAYS, SCHEMA_VERSION, type AmbryDoc } from "../types";

export class NewerSchemaError extends Error {
  constructor(public fileVersion: number) {
    super(`File schema_version ${fileVersion} is newer than app (${SCHEMA_VERSION}) — update the app first`);
  }
}

export class InvalidDocError extends Error {}

/**
 * MIGRATIONS[n] migrates a doc at schema_version n to n+1.
 * v1 is current; the list is empty rails today.
 */
export const MIGRATIONS: Record<number, (raw: Record<string, unknown>) => Record<string, unknown>> = {};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Finite integer >= min, or null when the value cannot be read as one. */
function coerceIntAtLeast(v: unknown, min: number): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const int = Math.floor(v);
  return int >= min ? int : null;
}

/**
 * Validate + migrate a parsed unknown value to the current AmbryDoc shape.
 * - Not an object / missing numeric schema_version / missing required arrays
 *   -> InvalidDocError.
 * - schema_version > SCHEMA_VERSION -> NewerSchemaError (never a parse error:
 *   the user is told to update the app, PLAN.md §2 Import).
 * - Older versions run forward through MIGRATIONS.
 * Structural validation is lenient but safe: items/events/extras must be
 * arrays, settings an object; unknown extra fields are preserved.
 */
export function migrateDoc(raw: unknown): AmbryDoc {
  if (!isPlainObject(raw)) {
    throw new InvalidDocError("Document is not a JSON object");
  }
  const version = raw.schema_version;
  // NaN/Infinity are "numbers" to typeof but can never match a migration
  // rung, so they are rejected up front rather than half-migrated.
  if (typeof version !== "number" || !Number.isFinite(version)) {
    throw new InvalidDocError("Missing or non-numeric schema_version");
  }
  if (version > SCHEMA_VERSION) {
    throw new NewerSchemaError(version);
  }

  // Walk forward one rung at a time. The loop counter — not whatever a step
  // writes into the doc — drives progress, so a migration that forgets to
  // bump schema_version cannot cause a re-run or an infinite loop.
  let doc: Record<string, unknown> = raw;
  for (let v = version; v < SCHEMA_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (step === undefined) {
      throw new InvalidDocError(`No migration path from schema_version ${v}`);
    }
    doc = step(doc);
  }
  if (version < SCHEMA_VERSION) {
    // Stamp the final version on a copy (steps are pure; so are we).
    doc = { ...doc, schema_version: SCHEMA_VERSION };
  }

  // Validate AFTER migrating: an old shape may legitimately lack arrays that
  // a migration step introduces. Checks stay top-level and lenient so that
  // future optional fields never brick old backups.
  for (const key of ["items", "events", "extras"] as const) {
    if (!Array.isArray(doc[key])) {
      throw new InvalidDocError(`Missing or non-array "${key}"`);
    }
  }
  if (!isPlainObject(doc.settings)) {
    throw new InvalidDocError('Missing or non-object "settings"');
  }

  // Coerce the settings numerics arithmetic depends on. A hand-edited backup
  // with a missing or garbage retention_days would make pruneDoc's cutoff
  // NaN — every date comparison goes false and history is silently dropped
  // or kept wholesale. Fallbacks, not errors: a backup must never be
  // rejected over a tunable.
  const settings = doc.settings;
  const retention = coerceIntAtLeast(settings.retention_days, 1) ?? DEFAULT_RETENTION_DAYS;
  const writes = coerceIntAtLeast(settings.writes_since_export, 0) ?? 0;
  // Older docs/backups predate the trip stamp; a valid ISO string passes
  // through, anything else (missing, junk) becomes null.
  const tripRaw = settings.last_trip_ended_at;
  const trip = typeof tripRaw === "string" && !Number.isNaN(Date.parse(tripRaw)) ? tripRaw : null;
  // Declared locations (empty-shelf cards): an array of non-blank strings,
  // trimmed, case-insensitively deduped keeping the first casing; anything
  // else (missing, junk, non-string entries) falls back to []. Fallbacks,
  // not errors — same rule as the numerics above.
  const declaredRaw = settings.declared_locations;
  const declared: string[] = [];
  if (Array.isArray(declaredRaw)) {
    const seen = new Set<string>();
    for (const entry of declaredRaw) {
      if (typeof entry !== "string") continue;
      const t = entry.trim();
      const key = t.toLowerCase();
      if (t === "" || seen.has(key)) continue;
      seen.add(key);
      declared.push(t);
    }
  }
  const declaredClean =
    Array.isArray(declaredRaw) &&
    declaredRaw.length === declared.length &&
    declared.every((v, i) => declaredRaw[i] === v);
  if (
    settings.retention_days !== retention ||
    settings.writes_since_export !== writes ||
    settings.last_trip_ended_at !== trip ||
    !declaredClean
  ) {
    // Copy, don't mutate: migrateDoc is pure, and when no migration ran
    // `doc` is still the caller's own object.
    doc = {
      ...doc,
      settings: {
        ...settings,
        retention_days: retention,
        writes_since_export: writes,
        last_trip_ended_at: trip,
        declared_locations: declared,
      },
    };
  }
  return doc as unknown as AmbryDoc;
}
