/**
 * Pure read-model selectors over the doc. Derived, never stored (the shopping
 * list is a VIEW — PLAN.md §1.6): no in_cart field; the in-cart section is
 * derived from today's purchase events, so mid-trip state survives page kills
 * for free.
 */
import type { AmbryDoc, Item, ShoppingExtra } from "../types";
import { EXPORT_NAG_DAYS, EXPORT_NAG_WRITES } from "../types";

const DAY_MS = 86_400_000;

/** ISO strings compare correctly as plain strings; null sorts as oldest. */
function isoAsc(a: string | null, b: string | null): number {
  const sa = a ?? "";
  const sb = b ?? "";
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** Case-insensitive alphabetical, exact string as the tiebreaker. Exported
 *  so view-side re-sorts (InventoryView's visit partition) can never drift
 *  from the selectors' own row order. */
export function alpha(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la < lb) return -1;
  if (la > lb) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Live (non-deleted) items. */
export function liveItems(doc: AmbryDoc): Item[] {
  return doc.items.filter((i) => i.deleted_at === null);
}

export interface ShoppingList {
  /** flagged && !deleted, oldest flagged_at first. */
  toBuy: Item[];
  /** Live extras, oldest first. */
  extras: ShoppingExtra[];
  /**
   * Items with a `purchase` event since local midnight — the dimmed in-cart
   * section. Currently-flagged items are excluded: a put-back (or re-flagged)
   * item belongs to To Buy and must never appear in both sections at once.
   */
  inCart: Item[];
}

export function shoppingList(doc: AmbryDoc, nowIso: string): ShoppingList {
  // Oldest-flagged first: the longest-standing need tops the list. filter()
  // already copied, so sort() never mutates doc.items.
  const toBuy = doc.items
    .filter((i) => i.flagged && i.deleted_at === null)
    .sort((a, b) => isoAsc(a.flagged_at, b.flagged_at));

  const extras = doc.extras
    .filter((x) => x.deleted_at === null)
    .sort((a, b) => isoAsc(a.created_at, b.created_at));

  // "Today" is the shopper's calendar day, not UTC's: local midnight of
  // nowIso. new Date(iso) then setHours(0,...) lands on 00:00 in the
  // environment's local timezone — a purchase at 11 pm must still be
  // "in cart" at 11:30 pm even when UTC has already rolled over.
  const midnightLocal = new Date(nowIso);
  midnightLocal.setHours(0, 0, 0, 0);
  const midnight = midnightLocal.getTime();

  const liveById = new Map<string, Item>();
  for (const item of doc.items) {
    if (item.deleted_at === null) liveById.set(item.id, item);
  }
  // First qualifying purchase decides order; a re-purchase (bought 2, went
  // back for 1 more) must not duplicate the row. Flagged items are excluded:
  // unpurchase re-raises the flag, so a put-back row moves (whole, not
  // duplicated) back to the To Buy section above.
  // Reversal-aware: per item, the LATEST of today's {purchase, "put back"
  // reversal recount} decides. Without this, a reversed check-off resurfaces
  // as "in the cart" the moment its re-raised flag is later cleared — a dim
  // row claiming stock that never came home. Both reversal paths (Put back
  // and the undo toast) mark their compensating recount with note "put back".
  const inCart: Item[] = [];
  const decided = new Set<string>();
  for (let i = doc.events.length - 1; i >= 0; i--) {
    const e = doc.events[i];
    if (e === undefined || decided.has(e.item_id)) continue;
    if (Date.parse(e.at) < midnight) continue;
    const isPurchase = e.kind === "purchase";
    const isReversal = e.kind === "recount" && e.note === "put back";
    if (!isPurchase && !isReversal) continue;
    decided.add(e.item_id);
    if (!isPurchase) continue; // latest word on this item today: reversed
    const item = liveById.get(e.item_id);
    if (item !== undefined && !item.flagged) inCart.push(item);
  }
  inCart.reverse(); // newest-first scan flipped: rows order by each item's LATEST purchase, oldest of those first

  return { toBuy, extras, inCart };
}

export interface CategoryGroup {
  /** null = the uncategorized bucket (renders as "other"), always last. */
  category: string | null;
  items: Item[];
}

/**
 * Store-aisle grouping for the shopping list: items bucketed by category,
 * categories alphabetical (case-insensitive, folding "Dairy"/"dairy" into
 * ONE group under the first-seen casing — resolveVocabValue guards entry,
 * but imported data may still carry both), the uncategorized bucket last,
 * items alphabetical by name within each group. Blank/whitespace categories
 * count as uncategorized, matching valuesInUse's idea of "no value".
 */
export function groupByCategory(items: Item[]): CategoryGroup[] {
  const groups = new Map<string | null, CategoryGroup>();
  for (const item of items) {
    const cat = item.category !== null && item.category.trim() !== "" ? item.category : null;
    const key = cat === null ? null : cat.toLowerCase();
    let group = groups.get(key);
    if (group === undefined) {
      group = { category: cat, items: [] };
      groups.set(key, group);
    }
    group.items.push(item);
  }
  for (const group of groups.values()) {
    group.items.sort((a, b) => alpha(a.name, b.name));
  }
  return [...groups.values()].sort((a, b) => {
    if (a.category === null) return 1;
    if (b.category === null) return -1;
    return alpha(a.category, b.category);
  });
}

// Canonical definition moved to src/domain/format.ts (fmtLevel needs it and
// domain must not import the store layer); re-exported here so UI call sites
// keep their one accustomed import path.
export { isUncounted } from "../domain/format";
import { isUncounted } from "../domain/format";

/**
 * Genuinely low: a live, counted item at or under its threshold. Uncounted
 * zeros are excluded — an unverified 0 is a question, not a shortage.
 */
export function isLow(item: Item): boolean {
  return (
    item.deleted_at === null &&
    !isUncounted(item) &&
    item.threshold !== null &&
    item.quantity <= item.threshold
  );
}

/** The physical walk order of the standard shelves; everything else follows alphabetically. */
const LOCATION_ORDER = ["pantry", "fridge", "freezer", "countertop"];

export interface LocationSummary {
  /** null = the no-location "elsewhere" bucket. */
  location: string | null;
  total: number;
  /** Items a human has counted (everything not `isUncounted`). */
  counted: number;
  low: number;
  flagged: number;
  uncounted: number;
}

/**
 * One card per location over live items, in walking order: the physical
 * pantry → fridge → freezer → countertop sequence first (when present,
 * matched case-insensitively so an "iOS-capitalized" seed still ranks),
 * remaining locations alphabetically, the null-location bucket last.
 */
export function locationSummaries(doc: AmbryDoc): LocationSummary[] {
  const rows = new Map<string | null, LocationSummary>();
  for (const item of doc.items) {
    if (item.deleted_at !== null) continue;
    let row = rows.get(item.location);
    if (row === undefined) {
      row = { location: item.location, total: 0, counted: 0, low: 0, flagged: 0, uncounted: 0 };
      rows.set(item.location, row);
    }
    row.total++;
    if (isUncounted(item)) row.uncounted++;
    else row.counted++;
    if (isLow(item)) row.low++;
    if (item.flagged) row.flagged++;
  }
  const rank = (loc: string | null): number => {
    // The un-filed pile belongs after every named shelf.
    if (loc === null) return LOCATION_ORDER.length + 1;
    const i = LOCATION_ORDER.indexOf(loc.toLowerCase());
    return i === -1 ? LOCATION_ORDER.length : i;
  };
  return [...rows.values()].sort((a, b) => {
    const diff = rank(a.location) - rank(b.location);
    if (diff !== 0) return diff;
    return alpha(a.location ?? "", b.location ?? "");
  });
}

/**
 * The items behind one location card (null = the "elsewhere" bucket), split
 * counted vs uncounted so the seeded-but-never-counted pile can sit behind a
 * collapsed divider instead of burying the real shelf. Alphabetical within.
 */
export function itemsInLocation(
  doc: AmbryDoc,
  location: string | null,
): { counted: Item[]; uncounted: Item[] } {
  const counted: Item[] = [];
  const uncounted: Item[] = [];
  for (const item of doc.items) {
    if (item.deleted_at !== null || item.location !== location) continue;
    (isUncounted(item) ? uncounted : counted).push(item);
  }
  counted.sort((a, b) => alpha(a.name, b.name));
  uncounted.sort((a, b) => alpha(a.name, b.name));
  return { counted, uncounted };
}

/** Distinct non-empty values in use (for pickers), alphabetical. */
export function valuesInUse(doc: AmbryDoc, field: "category" | "location" | "unit"): string[] {
  const values = new Set<string>();
  for (const item of doc.items) {
    // "In use" means live items: a tombstone's vocabulary should not keep
    // resurfacing in pickers.
    if (item.deleted_at !== null) continue;
    const v = item[field];
    if (v !== null && v.trim() !== "") values.add(v);
  }
  return [...values].sort(alpha);
}

/** An item is "stale" once its last observation is more than this many days old. */
export const STALE_DAYS = 30;

/**
 * The canonical staleness rule: live items whose last human observation is
 * more than STALE_DAYS days before nowIso. Never-verified items fall back to
 * created_at — a freshly seeded pantry is not instantly "stale"; items age
 * INTO the reconcile nudge instead.
 */
export function staleCount(doc: AmbryDoc, nowIso: string): number {
  const staleBefore = Date.parse(nowIso) - STALE_DAYS * DAY_MS;
  let count = 0;
  for (const item of doc.items) {
    if (item.deleted_at !== null) continue;
    if (Date.parse(item.verified_at ?? item.created_at) < staleBefore) count++;
  }
  return count;
}

/**
 * Resolve a typed vocabulary value (category/location/unit) against the
 * values already in use: a case-insensitive match returns the EXISTING
 * casing, otherwise the trimmed typed value stands. Guards against iOS
 * auto-capitalization minting "Fridge" as a second location beside "fridge".
 */
export function resolveVocabValue(existing: string[], typed: string): string {
  const t = typed.trim();
  const lower = t.toLowerCase();
  for (const value of existing) {
    if (value.toLowerCase() === lower) return value;
  }
  return t;
}

/** Stalest-first for the reconcile flow: live items by verified_at ascending (nulls first). */
export function stalest(doc: AmbryDoc, location?: string): Item[] {
  return doc.items
    .filter(
      (i) => i.deleted_at === null && (location === undefined || i.location === location),
    )
    // null verified_at = never confirmed by a human — stalest of all, first.
    .sort((a, b) => isoAsc(a.verified_at, b.verified_at));
}

/**
 * A count confirmed within this many days is trusted: reconcile stops asking
 * about it. This is the FLOOR under the micro-audit — without it, a "stalest
 * 10" always produces ten rows even in a freshly counted pantry, and
 * confirming items checked 47 minutes ago is mindless clicking that trains
 * the ✓ into a reflex. STALE_DAYS (30) stays the "stale" messaging threshold;
 * FRESH_DAYS is the younger bound below which nothing needs a check at all.
 */
export const FRESH_DAYS = 7;

/**
 * Live items NOT confirmed within FRESH_DAYS of nowIso — the reconcile
 * micro-audit's worklist. Same observation clock as staleCount:
 * verified_at with a created_at fallback, so a freshly seeded item is
 * trusted for its first week and ages INTO the check instead of demanding
 * one on day zero. Boundary matches staleCount's: exactly FRESH_DAYS old is
 * still fresh (strictly more than). Stalest first via the existing ordering.
 */
export function needsCheck(doc: AmbryDoc, nowIso: string, location?: string): Item[] {
  const freshAfter = Date.parse(nowIso) - FRESH_DAYS * DAY_MS;
  return stalest(doc, location).filter(
    (i) => Date.parse(i.verified_at ?? i.created_at) < freshAfter,
  );
}

export type ExportNagLevel = "none" | "badge" | "banner";

/**
 * Age of the backup in (fractional) days. Never exported: the backup is as
 * old as the data itself, so the earliest record's timestamp stands in for
 * last_export_at; an empty doc has no reference and reads 0. Exported so the
 * banner's "Backup is N days old" line and exportNag's thresholds can never
 * disagree about the same clock.
 */
export function backupAgeDays(doc: AmbryDoc, nowIso: string): number {
  let ref = doc.settings.last_export_at;
  if (ref === null) {
    for (const item of doc.items) {
      if (ref === null || item.created_at < ref) ref = item.created_at;
    }
    for (const extra of doc.extras) {
      if (ref === null || extra.created_at < ref) ref = extra.created_at;
    }
    for (const event of doc.events) {
      if (ref === null || event.at < ref) ref = event.at;
    }
  }
  return ref === null ? 0 : (Date.parse(nowIso) - Date.parse(ref)) / DAY_MS;
}

/** Badge at EXPORT_NAG_WRITES writes or EXPORT_NAG_DAYS days; banner at double either. Never nags an empty doc. */
export function exportNag(doc: AmbryDoc, nowIso: string): ExportNagLevel {
  // Nothing entered yet = nothing at risk; nagging before the first item
  // would be entry friction for no protection gained.
  if (doc.items.length === 0 && doc.events.length === 0 && doc.extras.length === 0) {
    return "none";
  }

  const writes = doc.settings.writes_since_export;
  const days = backupAgeDays(doc, nowIso);

  if (writes >= EXPORT_NAG_WRITES * 2 || days >= EXPORT_NAG_DAYS * 2) return "banner";
  if (writes >= EXPORT_NAG_WRITES || days >= EXPORT_NAG_DAYS) return "badge";
  return "none";
}
