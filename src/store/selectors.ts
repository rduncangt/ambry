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
  /** Items with a `purchase` event since local midnight — the dimmed in-cart section. */
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
  // back for 1 more) must not duplicate the row.
  const seen = new Set<string>();
  const inCart: Item[] = [];
  for (const e of doc.events) {
    if (e.kind !== "purchase") continue;
    if (Date.parse(e.at) < midnight) continue;
    if (seen.has(e.item_id)) continue;
    seen.add(e.item_id);
    const item = liveById.get(e.item_id);
    if (item !== undefined) inCart.push(item);
  }

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

/**
 * Seeded-but-never-counted: a zero no human ever observed (the "?" badge
 * rule). NOT "out" — absence was never verified, so it must never read as a
 * shortage or bury the rows that carry real counts.
 */
export function isUncounted(item: Item): boolean {
  return item.quantity === 0 && item.verified_at === null;
}

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

/**
 * The "Low & flagged" attention list: live items needing action — flagged
 * ones first (oldest flagged_at first, the shopping list's rule), then
 * unflagged low items by name. A flag is a human act, so flagged items
 * appear even while uncounted — the Shopping tab counts them, and this list
 * must agree. The uncounted guard protects only the threshold-derived branch
 * (it lives inside isLow): a pile of seeded "?" rows must not drown the real
 * shortages, and threshold flags only raise on quantity writes, so the
 * seeded pile can never flood in through the flagged branch either.
 */
export function attentionItems(doc: AmbryDoc): Item[] {
  const flagged: Item[] = [];
  const low: Item[] = [];
  for (const item of doc.items) {
    if (item.deleted_at !== null) continue;
    if (item.flagged) flagged.push(item);
    else if (isLow(item)) low.push(item);
  }
  flagged.sort((a, b) => isoAsc(a.flagged_at, b.flagged_at));
  low.sort((a, b) => alpha(a.name, b.name));
  return [...flagged, ...low];
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
