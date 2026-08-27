/**
 * Retention (PLAN.md §2): prune at app launch, one pass, safe by construction
 * under R2 (events are self-contained; nothing references them).
 */
import type { AmbryDoc } from "../types";
import { EXTRA_PRUNE_DAYS } from "../types";

const DAY_MS = 86_400_000;

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
  const now = Date.parse(nowIso);
  // "Older than N days" is strict: an event exactly N days old is kept.
  const eventCutoff = now - doc.settings.retention_days * DAY_MS;
  const extraCutoff = now - EXTRA_PRUNE_DAYS * DAY_MS;

  // Locate each item's single most recent event, keyed by the event's own
  // item_id — NOT by the items list — so events for soft-deleted, merged, or
  // even vanished items get the same keep-latest protection. Ties on `at`
  // resolve to the later array position (the log is append-only, so a later
  // index is the later write).
  const latest = new Map<string, { at: number; index: number }>();
  doc.events.forEach((e, i) => {
    const t = Date.parse(e.at);
    const prev = latest.get(e.item_id);
    if (prev === undefined || t >= prev.at) {
      latest.set(e.item_id, { at: t, index: i });
    }
  });

  const events = doc.events.filter(
    (e, i) => Date.parse(e.at) >= eventCutoff || latest.get(e.item_id)?.index === i,
  );

  // Live extras (deleted_at null) are never pruned — only checked-off entries
  // whose deletion is older than the grace window are hard-removed.
  const extras = doc.extras.filter(
    (x) => x.deleted_at === null || Date.parse(x.deleted_at) >= extraCutoff,
  );

  const eventsRemoved = doc.events.length - events.length;
  const extrasRemoved = doc.extras.length - extras.length;
  if (eventsRemoved === 0 && extrasRemoved === 0) {
    // Same reference on no-op so callers can cheaply detect "nothing to save".
    return { doc, eventsRemoved: 0, extrasRemoved: 0 };
  }
  return {
    doc: {
      ...doc,
      // Keep the untouched array's identity too, for the same cheap-diff reason.
      events: eventsRemoved > 0 ? events : doc.events,
      extras: extrasRemoved > 0 ? extras : doc.extras,
    },
    eventsRemoved,
    extrasRemoved,
  };
}
