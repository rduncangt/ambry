/**
 * Sticky resupply flag semantics (PLAN.md §1.2, revised 2026-08-28), made
 * mechanical:
 * - Auto-raise fires when a quantity write LANDS at or below the threshold
 *   (`after <= threshold`) AND the write is either a genuine downward move
 *   (`after < before`) or the item's FIRST OBSERVATION (`verified_at` still
 *   null on the pre-write item). The original strict-crossing test
 *   (before > threshold >= after) had two dead zones, both confirmed on
 *   device and both contradicting the UI's "auto-flags at or below N"
 *   promise: an item first-counted AT its threshold never flagged (its
 *   seeded `before` of 0 is not above the threshold), and an item sitting
 *   exactly at its threshold that then dropped below never flagged either
 *   (`before > threshold` is false when before === threshold).
 * - The first-observation disjunct means a first count landing at or below
 *   the threshold — including a first count of exactly 0 — flags
 *   immediately: "we only have 3 left, better buy more."
 * - Upward writes on counted items never raise (no nag on corrections):
 *   with `verified_at` set, only `after < before` can open the gate.
 * - Buying back to exactly the threshold still does not instantly re-raise:
 *   purchase always returns "clear", and the next write only raises if it
 *   lands at-or-below moving DOWN.
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
 *   the next downward write re-raises).
 * - landing at/below the threshold on a downward move OR first observation,
 *   with !never_prompt, not already flagged -> "raise".
 * - otherwise "none".
 */
export function flagTransition(item: Item, before: number, after: number, kind: EventKind): FlagTransition {
  // Purchase is checked first and unconditionally: "stays up until I actually
  // buy the thing" means buying clears even when the resulting quantity is
  // still at or below the threshold (the next downward write re-flags), even
  // under never_prompt, and even when the item isn't flagged — the store
  // applies a clear on an unflagged item as a no-op.
  if (kind === "purchase") return "clear";

  // Raise rule (see the module comment for the two dead zones this fixes):
  // the write must LAND at or below the threshold, and must be either a
  // genuine downward move or the item's first observation (never-verified
  // pre-write — a recount landing low IS the news that stock is low). An
  // already-raised flag never re-raises — it must first clear.
  if (
    !item.never_prompt &&
    item.threshold !== null &&
    !item.flagged &&
    after <= item.threshold &&
    (after < before || item.verified_at === null)
  ) {
    return "raise";
  }

  // Everything else — upward moves on counted items, drops that stay above
  // the threshold — leaves the flag alone. In particular no non-purchase
  // kind ever returns "clear": that is the sticky rule (recount-up never
  // lowers the flag).
  return "none";
}
