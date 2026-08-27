/**
 * Retention (PLAN.md §2): prune at app launch, one pass, safe by construction
 * under R2 (events are self-contained; nothing references them).
 */
import type { AmbryDoc } from "../types";

export interface PruneResult {
  doc: AmbryDoc;
  eventsRemoved: number;
  extrasRemoved: number;
}

/**
 * Remove events older than settings.retention_days — EXCEPT each item's single
 * most recent event, kept for context. Hard-remove checked-off extras
 * (deleted_at) older than EXTRA_PRUNE_DAYS. Pure: returns a new doc when
 * anything changed (same doc reference when nothing did).
 */
export function pruneDoc(doc: AmbryDoc, nowIso: string): PruneResult {
  throw new Error("TODO: implement (workflow)");
}
