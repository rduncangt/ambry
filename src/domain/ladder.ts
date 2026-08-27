/**
 * Qualitative ladder (PLAN.md §1.7): a DISPLAY MODE over the single quantity
 * number. Read buckets: >= 0.75 full, >= 0.35 half, > 0 low, 0 out; qty > 1
 * renders as "Full +N". Write: a rung tap is a recount to 1.0/0.5/0.2/0 and
 * requires confirmation when quantity > 1 (multi-container guard).
 */
import { LADDER_READ, LADDER_WRITE, type LadderRung } from "../types";

/** Which rung a quantity displays as. */
export function readRung(qty: number): LadderRung {
  // Boundaries are inclusive on the named buckets (0.75 IS full, 0.35 IS
  // half) so the write values 1.0/0.5 always read back as the rung tapped.
  if (qty >= LADDER_READ.full) return "full";
  if (qty >= LADDER_READ.half) return "half";
  if (qty > 0) return "low";
  return "out";
}

/** The quantity a rung tap writes. */
export function rungValue(rung: LadderRung): number {
  return LADDER_WRITE[rung];
}

/**
 * True when a rung tap must confirm before writing: quantity > 1 means rung
 * values (fractions of ONE container) would destroy a multi-container count.
 */
export function rungNeedsConfirm(qty: number): boolean {
  // Strictly > 1: rung values describe exactly one container, so a tap at 1
  // is a same-scale write and needs no ceremony.
  return qty > 1;
}
