/**
 * Display formatting. Converted values are rounded AT DISPLAY TIME so
 * 0.432 bags never renders as 431.999... g (PLAN.md §1.5).
 */
import { QTY_DECIMALS, type Item, type LadderRung } from "../types";
import { toPreciseUnit } from "./units";

/** Same normalization as units.ts: case-insensitive, whitespace-trimmed. */
const normUnit = (u: string): string => u.trim().toLowerCase();

/** Metric-ish symbols never pluralize: "432 g", not "432 gs". */
const METRIC_UNITS = new Set(["g", "kg", "mg", "ml", "l"]);

const RUNG_LABELS: Record<LadderRung, string> = {
  full: "Full",
  half: "Half",
  low: "Low",
  out: "Out",
};

/** Trim to <= 3 decimals, no trailing zeros: 0.5 -> "0.5", 2 -> "2". */
export function fmtQty(n: number): string {
  // Round (not truncate) so 431.999... converted values display as 432;
  // String() of the rounded number drops trailing zeros for free.
  const f = 10 ** QTY_DECIMALS;
  const r = Math.round(n * f) / f;
  // r === 0 covers -0, which would otherwise render as "0" anyway but keeps
  // the value canonical.
  return String(r === 0 ? 0 : r);
}

/**
 * Naive pluralized unit: alphabetic units gain "s" when qty !== 1 unless they
 * already end in "s" or are metric-ish symbols (g, kg, ml, l, count as bare
 * number). "2 bag" -> "2 bags"; "432 g" stays. unit "count" renders bare: "3".
 */
export function fmtQtyUnit(qty: number, unit: string): string {
  const q = fmtQty(qty);
  const u = unit.trim();
  const nu = normUnit(unit);
  // "count" is a pseudo-unit — 3 count of eggs is just "3". An empty unit
  // likewise renders as the bare number.
  if (nu === "count" || u === "") return q;
  // Pluralize on the DISPLAYED value, not the raw one, so a float hair above
  // 1 (shown as "1") never reads "1 bags".
  const plural =
    q !== "1" && /^[a-z]+$/i.test(u) && !nu.endsWith("s") && !METRIC_UNITS.has(nu);
  return `${q} ${plural ? `${u}s` : u}`;
}

/** "Full", "Half", "Low", "Out"; qty > 1 -> "Full +N" (N = qty-1, fmtQty'd). */
export function ladderLabel(qty: number, rung: LadderRung): string {
  // Above one container the surplus must stay visible (§1.7) — "Full +2"
  // instead of a bare "Full" hiding two backups.
  if (qty > 1) return `Full +${fmtQty(qty - 1)}`;
  return RUNG_LABELS[rung];
}

/** Both sides when package_size exists: "0.4 bags (400 g)". */
export function fmtQtyBoth(item: Item): string {
  const main = fmtQtyUnit(item.quantity, item.unit);
  const precise = toPreciseUnit(item);
  if (precise === null) return main;
  // The derived side is rounded by fmtQty inside fmtQtyUnit, so float noise
  // from the multiplication (0.432 * 1000) never reaches the screen.
  return `${main} (${fmtQtyUnit(precise.amount, precise.unit)})`;
}

/** Relative age from an ISO timestamp: "3d ago", "2h ago", "just now"; null -> "never". */
export function fmtAge(iso: string | null, nowIso: string): string {
  if (iso === null) return "never";
  const ms = Date.parse(nowIso) - Date.parse(iso);
  // Unparseable input and clock skew (future timestamps) both collapse to
  // "just now" — never render a negative or NaN age.
  if (!Number.isFinite(ms) || ms < 60_000) return "just now";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}
