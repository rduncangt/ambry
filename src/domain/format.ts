/**
 * Display formatting. Converted values are rounded AT DISPLAY TIME so
 * 0.432 bags never renders as 431.999... g (PLAN.md §1.5).
 */
import type { Item } from "../types";
import type { LadderRung } from "../types";

/** Trim to <= 3 decimals, no trailing zeros: 0.5 -> "0.5", 2 -> "2". */
export function fmtQty(n: number): string {
  throw new Error("TODO: implement (workflow)");
}

/**
 * Naive pluralized unit: alphabetic units gain "s" when qty !== 1 unless they
 * already end in "s" or are metric-ish symbols (g, kg, ml, l, count as bare
 * number). "2 bag" -> "2 bags"; "432 g" stays. unit "count" renders bare: "3".
 */
export function fmtQtyUnit(qty: number, unit: string): string {
  throw new Error("TODO: implement (workflow)");
}

/** "Full", "Half", "Low", "Out"; qty > 1 -> "Full +N" (N = qty-1, fmtQty'd). */
export function ladderLabel(qty: number, rung: LadderRung): string {
  throw new Error("TODO: implement (workflow)");
}

/** Both sides when package_size exists: "0.4 bags (400 g)". */
export function fmtQtyBoth(item: Item): string {
  throw new Error("TODO: implement (workflow)");
}

/** Relative age from an ISO timestamp: "3d ago", "2h ago", "just now"; null -> "never". */
export function fmtAge(iso: string | null, nowIso: string): string {
  throw new Error("TODO: implement (workflow)");
}
