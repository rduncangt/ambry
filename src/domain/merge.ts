/**
 * Duplicate repair (PLAN.md §2 Merge): survivor keeps its ID; the loser gets
 * deleted_at + merged_into and donates its name+aliases as survivor aliases.
 * EVENTS ARE NEVER REWRITTEN — history views union over the merged_into chain,
 * and every event names its unit, so mixed-unit merged history displays
 * honestly. Pure planning/resolution; the store applies.
 */
import type { AmbryDoc, HistoryEvent, Item } from "../types";
import { roundQty } from "../types";

/**
 * Follow merged_into pointers to the surviving item id. Cycle-safe (returns
 * the last id before a repeat). An id with no item returns itself.
 */
export function resolveMergeChain(items: Item[], id: string): string {
  const byId = new Map(items.map((item) => [item.id, item]));
  // The seen-set makes a corrupt pointer cycle terminate instead of hanging;
  // a well-formed doc never has one, but resolution must not trust the doc.
  const seen = new Set<string>();
  let current = id;
  for (;;) {
    seen.add(current);
    const next = byId.get(current)?.merged_into;
    if (next == null || seen.has(next)) return current;
    current = next;
  }
}

/**
 * The survivor's history view: events whose item_id resolves through the
 * merge chain to `itemId`, newest first.
 */
export function historyFor(doc: AmbryDoc, itemId: string): HistoryEvent[] {
  // Loser events keep their original item_id (R2: events are never
  // rewritten); they reach the survivor's view via resolution only.
  // Memoized per distinct item_id — event lists are long, item ids few.
  const resolved = new Map<string, string>();
  const resolve = (id: string): string => {
    let end = resolved.get(id);
    if (end === undefined) {
      end = resolveMergeChain(doc.items, id);
      resolved.set(id, end);
    }
    return end;
  };
  // filter() copies before sort(), so doc.events is never mutated.
  return doc.events
    .filter((e) => resolve(e.item_id) === itemId)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

export interface MergePlan {
  /** aliases for the survivor: union of both names+aliases minus survivor.name, deduped, order-stable. */
  aliases: string[];
  /** OR of both flags (a raised need is sticky through a merge). */
  flagged: boolean;
  /** Sum when units are identical; otherwise survivor's quantity (with needsQtyPrompt). */
  defaultQuantity: number;
  /** Units differ: the UI must prompt (default shows survivor's value + set-to-actual nudge). */
  needsQtyPrompt: boolean;
}

/** Plan a merge of `loser` into `survivor`. Throws if ids are equal. */
export function planMerge(survivor: Item, loser: Item): MergePlan {
  if (survivor.id === loser.id) {
    throw new Error("Cannot merge an item into itself");
  }

  // Alias union: every name the pair has ever answered to, minus the one the
  // survivor already displays — so the repaired duplicate immunizes future
  // searches against its recurrence. Case-insensitive dedupe, first-seen
  // casing wins, source order preserved.
  const seenKeys = new Set<string>([survivor.name.toLowerCase()]);
  const aliases: string[] = [];
  for (const candidate of [...survivor.aliases, loser.name, ...loser.aliases]) {
    const key = candidate.toLowerCase();
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    aliases.push(candidate);
  }

  // Quantities only sum when they are denominated in the same unit; "bag" vs
  // "g" summed would be nonsense, so the UI must prompt with the survivor's
  // value as the default.
  const sameUnit = survivor.unit.trim().toLowerCase() === loser.unit.trim().toLowerCase();

  return {
    aliases,
    // A raised need is sticky through a merge: if either half was flagged,
    // the combined item still needs buying.
    flagged: survivor.flagged || loser.flagged,
    // roundQty kills float noise (0.1 + 0.2) before the plan is applied.
    defaultQuantity: sameUnit ? roundQty(survivor.quantity + loser.quantity) : survivor.quantity,
    needsQtyPrompt: !sameUnit,
  };
}
