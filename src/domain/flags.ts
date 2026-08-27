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
  // Purchase is checked first and unconditionally: "stays up until I actually
  // buy the thing" means buying clears even when the resulting quantity is
  // still at or below the threshold (the next use re-crosses and re-flags),
  // even under never_prompt, and even when the item isn't flagged — the store
  // applies a clear on an unflagged item as a no-op.
  if (kind === "purchase") return "clear";

  // Edge-triggered raise: only a strict downward CROSSING raises. Level
  // evaluation would instantly re-flag an item bought back to exactly its
  // threshold ("flag butter at 1 stick, buy back to 1"). Landing exactly ON
  // the threshold counts as crossing (threshold >= after); starting at or
  // below it does not (before must be strictly above). An already-raised flag
  // never re-raises — it must first clear and rise above the threshold.
  if (
    item.threshold !== null &&
    !item.never_prompt &&
    !item.flagged &&
    before > item.threshold &&
    item.threshold >= after
  ) {
    return "raise";
  }

  // Everything else — upward moves, recounts, drops that never cross — leaves
  // the flag alone. In particular no non-purchase kind ever returns "clear":
  // that is the sticky rule (recount-up never lowers the flag).
  return "none";
}
