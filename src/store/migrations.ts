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
  throw new Error("TODO: implement (workflow)");
}
