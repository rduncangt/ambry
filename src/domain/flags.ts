/**
 * Sticky resupply flag semantics (PLAN.md §1.2), made mechanical:
 * - Auto-raise is EDGE-TRIGGERED: only a downward crossing
 *   (before > threshold >= after) raises, never level evaluation — so buying
 *   back to exactly the threshold does not instantly re-raise.
 * - Only a purchase (or explicit manual clear) lowers the flag; recount-up
 *   never does.
 * - never_prompt suppresses auto-raise ONLY.
 * Pure function; the store applies transitions inside the mutation command.
 */
import type { EventKind, Item } from "../types";

export type FlagTransition = "raise" | "clear" | "none";

/**
 * Evaluate the flag transition for a quantity write on `item` (state BEFORE
 * the write) moving quantity from `before` to `after` via `kind`.
 * - kind "purchase" -> "clear" (always clears, even if still <= threshold —
 *   next use re-crosses and re-flags).
 * - downward crossing with a threshold, !never_prompt, not already flagged
 *   -> "raise".
 * - otherwise "none".
 */
export function flagTransition(item: Item, before: number, after: number, kind: EventKind): FlagTransition {
  throw new Error("TODO: implement (workflow)");
}
