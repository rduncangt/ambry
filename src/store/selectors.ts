/**
 * Pure read-model selectors over the doc. Derived, never stored (the shopping
 * list is a VIEW — PLAN.md §1.6): no in_cart field; the in-cart section is
 * derived from today's purchase events, so mid-trip state survives page kills
 * for free.
 */
import type { AmbryDoc, Item, ShoppingExtra } from "../types";

/** Live (non-deleted) items. */
export function liveItems(doc: AmbryDoc): Item[] {
  throw new Error("TODO: implement (workflow)");
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
  throw new Error("TODO: implement (workflow)");
}

/** Inventory grouped by location (null -> "elsewhere"), alphabetical within. */
export function groupedInventory(doc: AmbryDoc): { location: string; items: Item[] }[] {
  throw new Error("TODO: implement (workflow)");
}

/** Distinct non-empty values in use (for pickers), alphabetical. */
export function valuesInUse(doc: AmbryDoc, field: "category" | "location" | "unit"): string[] {
  throw new Error("TODO: implement (workflow)");
}

/** Stalest-first for the reconcile flow: live items by verified_at ascending (nulls first). */
export function stalest(doc: AmbryDoc, location?: string): Item[] {
  throw new Error("TODO: implement (workflow)");
}

export type ExportNagLevel = "none" | "badge" | "banner";

/** Badge at EXPORT_NAG_WRITES writes or EXPORT_NAG_DAYS days; banner at double either. Never nags an empty doc. */
export function exportNag(doc: AmbryDoc, nowIso: string): ExportNagLevel {
  throw new Error("TODO: implement (workflow)");
}
