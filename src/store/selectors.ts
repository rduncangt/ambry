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

/** Case-insensitive alphabetical, exact string as the tiebreaker. */
function alpha(a: string, b: string): number {
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

/** Inventory grouped by location (null -> "elsewhere"), alphabetical within. */
export function groupedInventory(doc: AmbryDoc): { location: string; items: Item[] }[] {
  const groups = new Map<string, Item[]>();
  for (const item of doc.items) {
    if (item.deleted_at !== null) continue;
    const location = item.location ?? "elsewhere";
    const bucket = groups.get(location);
    if (bucket === undefined) groups.set(location, [item]);
    else bucket.push(item);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => {
      // Real locations alphabetical; the null-bucket "elsewhere" always sinks
      // to the end (the un-filed pile belongs after the named shelves).
      if (a === "elsewhere" && b !== "elsewhere") return 1;
      if (b === "elsewhere" && a !== "elsewhere") return -1;
      return alpha(a, b);
    })
    .map(([location, items]) => ({ location, items: items.sort((a, b) => alpha(a.name, b.name)) }));
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

/** Badge at EXPORT_NAG_WRITES writes or EXPORT_NAG_DAYS days; banner at double either. Never nags an empty doc. */
export function exportNag(doc: AmbryDoc, nowIso: string): ExportNagLevel {
  // Nothing entered yet = nothing at risk; nagging before the first item
  // would be entry friction for no protection gained.
  if (doc.items.length === 0 && doc.events.length === 0 && doc.extras.length === 0) {
    return "none";
  }

  const writes = doc.settings.writes_since_export;

  // Backup age. Never exported: the backup is as old as the data itself, so
  // the earliest record's timestamp stands in for last_export_at.
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
  const days = ref === null ? 0 : (Date.parse(nowIso) - Date.parse(ref)) / DAY_MS;

  if (writes >= EXPORT_NAG_WRITES * 2 || days >= EXPORT_NAG_DAYS * 2) return "banner";
  if (writes >= EXPORT_NAG_WRITES || days >= EXPORT_NAG_DAYS) return "badge";
  return "none";
}
