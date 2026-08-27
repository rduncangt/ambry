/**
 * Search + duplicate candidates. Case/diacritic-folded SUBSTRING matching over
 * name + aliases (+ category), prefix-ranked. No fuzzy matching in v1 —
 * substring plus folding finds everything a human will type at 300 items
 * (PLAN.md §5). Pure functions; called on every keystroke over the full set.
 */
import type { Item } from "../types";

export interface SearchOptions {
  /** Include soft-deleted items (create-flow offers restore). Default false. */
  includeDeleted?: boolean;
}

/**
 * Ranked matches for a live query. Empty/whitespace query returns [].
 * Ranking: name-prefix matches, then name-substring, then alias/category
 * matches; alphabetical by name within each band. Soft-deleted items are
 * excluded unless opts.includeDeleted.
 */
export function searchItems(items: Item[], query: string, opts?: SearchOptions): Item[] {
  throw new Error("TODO: implement (workflow)");
}

/**
 * Create-time duplicate guard (PLAN.md §1.4): items — INCLUDING soft-deleted —
 * that likely mean the same thing as `name`: equal normalKey over name or any
 * alias, or one normalKey's token set contains the other's. Returned with live
 * items first.
 */
export function duplicateCandidates(items: Item[], name: string): Item[] {
  throw new Error("TODO: implement (workflow)");
}
