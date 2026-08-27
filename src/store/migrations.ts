/**
 * Schema migrations (R3): ordered pure functions, one per version bump,
 * run at load AND at import through the same pipeline — so a 2026 export
 * imports cleanly into the 2030 app. NEVER delete a migration function.
 */
import { SCHEMA_VERSION, type AmbryDoc } from "../types";

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
  return doc as unknown as AmbryDoc;
}
