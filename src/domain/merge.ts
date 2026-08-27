/**
 * Duplicate repair (PLAN.md §2 Merge): survivor keeps its ID; the loser gets
 * deleted_at + merged_into and donates its name+aliases as survivor aliases.
 * EVENTS ARE NEVER REWRITTEN — history views union over the merged_into chain,
 * and every event names its unit, so mixed-unit merged history displays
 * honestly. Pure planning/resolution; the store applies.
 */
import type { AmbryDoc, HistoryEvent, Item } from "../types";

/**
 * Follow merged_into pointers to the surviving item id. Cycle-safe (returns
 * the last id before a repeat). An id with no item returns itself.
 */
export function resolveMergeChain(items: Item[], id: string): string {
  throw new Error("TODO: implement (workflow)");
}

/**
 * The survivor's history view: events whose item_id resolves through the
 * merge chain to `itemId`, newest first.
 */
export function historyFor(doc: AmbryDoc, itemId: string): HistoryEvent[] {
  throw new Error("TODO: implement (workflow)");
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
  throw new Error("TODO: implement (workflow)");
}
