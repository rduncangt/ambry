/**
 * Search + duplicate candidates. Case/diacritic-folded SUBSTRING matching over
 * name + aliases (+ category), prefix-ranked. No fuzzy matching in v1 —
 * substring plus folding finds everything a human will type at 300 items
 * (PLAN.md §5). Pure functions; called on every keystroke over the full set.
 */
import type { Item } from "../types";
import { fold, tokens } from "./normalize";

export interface SearchOptions {
  /**
   * Include soft-deleted items. Default false. No app flow sets this today —
   * tombstone surfacing for create-time restore is duplicateCandidates' job —
   * but the option stays for callers that want a search over everything.
   */
  includeDeleted?: boolean;
}

/** Ranking bands, in display order: lower is better. */
const BAND_NAME_PREFIX = 0;
const BAND_NAME_SUBSTRING = 1;
const BAND_ALIAS_OR_CATEGORY = 2;

/**
 * Ranked matches for a live query. Empty/whitespace query returns [].
 * Ranking: name-prefix matches, then name-substring, then alias/category
 * matches; alphabetical by name within each band. Soft-deleted items are
 * excluded unless opts.includeDeleted.
 */
export function searchItems(items: Item[], query: string, opts?: SearchOptions): Item[] {
  const q = fold(query);
  // A query that folds to nothing (whitespace, bare punctuation) would be a
  // substring of everything; returning [] keeps the live-search list quiet.
  if (q === "") return [];
  const includeDeleted = opts?.includeDeleted ?? false;

  const ranked: { item: Item; band: number; sortName: string }[] = [];
  for (const item of items) {
    if (item.deleted_at !== null && !includeDeleted) continue;
    const name = fold(item.name);
    let band: number;
    if (name.startsWith(q)) {
      band = BAND_NAME_PREFIX;
    } else if (name.includes(q)) {
      band = BAND_NAME_SUBSTRING;
    } else if (
      item.aliases.some((alias) => fold(alias).includes(q)) ||
      (item.category !== null && fold(item.category).includes(q))
    ) {
      band = BAND_ALIAS_OR_CATEGORY;
    } else {
      continue;
    }
    ranked.push({ item, band, sortName: name });
  }

  // Band first, then alphabetical by folded name so "Éclair" sorts with
  // "eclair"; raw name breaks ties deterministically.
  ranked.sort(
    (a, b) =>
      a.band - b.band ||
      compare(a.sortName, b.sortName) ||
      compare(a.item.name, b.item.name)
  );
  return ranked.map((r) => r.item);
}

/** Plain code-unit comparison — locale-independent, so ordering is stable everywhere. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Create-time duplicate guard (PLAN.md §1.4): items — INCLUDING soft-deleted —
 * that likely mean the same thing as `name`: equal normalKey over name or any
 * alias, or one normalKey's token set contains the other's. Returned with live
 * items first. Merge losers are excluded (see below).
 */
export function duplicateCandidates(items: Item[], name: string): Item[] {
  const queryTokens = new Set(tokens(name));
  // An empty token set is vacuously a subset of everything; bail instead of
  // flagging the whole pantry as duplicates of "".
  if (queryTokens.size === 0) return [];

  const matches = items.filter((item) => {
    // A tombstone that LOST a merge must never surface: the survivor already
    // carries its name as an alias (and matches here through it), and
    // offering to restore the loser would un-repair the merge — the pantry
    // would grow the duplicate back.
    if (item.deleted_at !== null && item.merged_into !== null) return false;
    return [item.name, ...item.aliases].some((label) => {
      const labelTokens = new Set(tokens(label));
      if (labelTokens.size === 0) return false;
      // Subset in either direction covers both contract cases: equal
      // normalKeys (mutual containment) and "canned tomatoes" vs "tomatoes".
      return isSubset(queryTokens, labelTokens) || isSubset(labelTokens, queryTokens);
    });
  });

  // Live items first (the open-it path); tombstones after (the restore path).
  // Input order is preserved within each group.
  return [
    ...matches.filter((item) => item.deleted_at === null),
    ...matches.filter((item) => item.deleted_at !== null),
  ];
}

/** True when every element of `a` is in `b`. */
function isSubset(a: Set<string>, b: Set<string>): boolean {
  for (const token of a) {
    if (!b.has(token)) return false;
  }
  return true;
}
