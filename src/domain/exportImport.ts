/**
 * Export/import — the only backup, so full fidelity is non-negotiable
 * (PLAN.md §1.1): tombstones, events, extras, settings all included.
 * Import is whole-file REPLACE, gated (PLAN.md §1.3): validate -> migrate ->
 * preview -> staleness guard -> snapshot current -> replace.
 */
import type { AmbryDoc, ExportEnvelope } from "../types";

/** Build the full-fidelity envelope. */
export function buildExport(doc: AmbryDoc, nowIso: string, deviceLabel?: string): ExportEnvelope {
  throw new Error("TODO: implement (workflow)");
}

/** "ambry-backup-2026-08-27-1930.json" — local time, sortable. */
export function exportFilename(d: Date): string {
  throw new Error("TODO: implement (workflow)");
}

export type ParseImportResult =
  | { ok: true; doc: AmbryDoc; envelope: { exported_at: string | null; device_label: string | null; counts: { items: number; events: number; extras: number } } }
  | { ok: false; error: "invalid" | "newer_schema"; detail: string };

/**
 * Parse + validate + migrate an import file's text into a current-shape doc.
 * Accepts both a full ExportEnvelope and a bare AmbryDoc (a raw doc snapshot
 * is also a valid restore source). Never throws.
 */
export function parseImport(text: string): ParseImportResult {
  throw new Error("TODO: implement (workflow)");
}

export interface StalenessCheck {
  /** true when the incoming file's newest edit is older than local's — refuse with loud override. */
  incomingIsOlder: boolean;
  localLatest: string | null;
  incomingLatest: string | null;
}

/**
 * Compare max updated_at (items + extras; falls back to events' `at`) between
 * the live doc and an incoming one. An empty local doc is never "newer".
 */
export function checkStaleness(local: AmbryDoc, incoming: AmbryDoc): StalenessCheck {
  throw new Error("TODO: implement (workflow)");
}
