/**
 * Package-size conversion and the guarded unit-change flow (PLAN.md §1.5).
 * The threshold, the history, and the package size are all denominated in the
 * item's mutable unit — so unit/package change is a MIGRATION FLOW, never a
 * bare field edit. Pure planning functions; the store applies plans.
 */
import type { Item } from "../types";

/** Units compare case-insensitively, ignoring surrounding whitespace. */
const normUnit = (u: string): string => u.trim().toLowerCase();

/**
 * A package_size is only usable as a conversion factor when its amount is a
 * positive finite number — otherwise dividing/inverting through it would mint
 * Infinity/NaN into quantities.
 */
function usablePackage(item: Item): { amount: number; unit: string } | null {
  const p = item.package_size;
  return p !== null && Number.isFinite(p.amount) && p.amount > 0 ? p : null;
}

/**
 * Convert an amount in a measure into the item's coarse unit via package_size.
 * Item unit "bag" with package {1000,"g"}: (432,"g") -> 0.432; (2,"bag") -> 2.
 * Returns null when no conversion exists. Result is NOT rounded (callers
 * round on write; display rounds separately).
 */
export function toItemUnit(item: Item, amount: number, measure: string): number | null {
  const m = normUnit(measure);
  // Already in the item's own unit: identity, package or not.
  if (m === normUnit(item.unit)) return amount;
  // 1 item.unit = pkg.amount pkg.unit, so an amount in pkg.unit divides down.
  const pkg = usablePackage(item);
  if (pkg !== null && m === normUnit(pkg.unit)) return amount / pkg.amount;
  return null;
}

/** Precise-side display: 0.4 of a {1000,"g"} bag -> { amount: 400, unit: "g" }. */
export function toPreciseUnit(item: Item): { amount: number; unit: string } | null {
  const pkg = usablePackage(item);
  if (pkg === null) return null;
  return { amount: item.quantity * pkg.amount, unit: pkg.unit };
}

export type UnitChangePlan =
  | {
      kind: "convert";
      /** Converted atomically together — never one without the other. */
      quantity: number;
      threshold: number | null;
      /** package_size re-expressed for the new unit, or null when it must be cleared. */
      package_size: { amount: number; unit: string } | null;
    }
  | {
      /** No conversion path: quantity AND threshold must be re-entered. */
      kind: "reenter";
    };

/**
 * Plan a unit change. A conversion exists only when old and new units are
 * related through package_size (unit <-> package measure, either direction).
 * Otherwise: reenter — the number is never carried across silently.
 */
export function planUnitChange(item: Item, newUnit: string): UnitChangePlan {
  const from = normUnit(item.unit);
  const to = normUnit(newUnit);

  // Same unit (modulo case/whitespace): a no-op "conversion" keeps everything.
  if (to === from) {
    return {
      kind: "convert",
      quantity: item.quantity,
      threshold: item.threshold,
      package_size: item.package_size,
    };
  }

  // The only conversion the model knows is the package relation
  // 1 item.unit = pkg.amount pkg.unit; changing to pkg.unit multiplies
  // quantity AND threshold through it (§1.5: never one without the other).
  const pkg = usablePackage(item);
  if (pkg !== null && to === normUnit(pkg.unit)) {
    return {
      kind: "convert",
      quantity: item.quantity * pkg.amount,
      threshold: item.threshold === null ? null : item.threshold * pkg.amount,
      // Re-express the SAME physical relation relative to the new unit
      // (bag->g with 1 bag = 1000 g becomes 1 g = 0.001 bag), so a later
      // change back to the old unit still has a conversion path.
      package_size: { amount: 1 / pkg.amount, unit: item.unit },
    };
  }

  return { kind: "reenter" };
}

/**
 * Plan a package-size edit ("1 bag = 1 kg" -> "1 bag = 2 kg").
 * keep = "amount": physical stock is unchanged, so quantity/threshold rescale
 * by oldAmount/newAmount (in the same measure). keep = "count": the numbers
 * stay, their physical meaning changes. Returns the resulting quantity and
 * threshold (unrounded).
 */
export function planPackageResize(
  item: Item,
  newPackage: { amount: number; unit: string },
  keep: "amount" | "count",
): { quantity: number; threshold: number | null } {
  const unchanged = { quantity: item.quantity, threshold: item.threshold };

  // keep-count: the numbers stay; only their physical meaning changes.
  if (keep === "count") return unchanged;

  // keep-amount needs a ratio in ONE measure: both packages usable and
  // denominated in the same measure unit. Without that there is no factor —
  // leave the numbers untouched rather than invent one (the store's guarded
  // flow should not offer keep-amount in that case).
  const pkg = usablePackage(item);
  const newOk = Number.isFinite(newPackage.amount) && newPackage.amount > 0;
  if (pkg === null || !newOk || normUnit(pkg.unit) !== normUnit(newPackage.unit)) {
    return unchanged;
  }

  const ratio = pkg.amount / newPackage.amount;
  return {
    quantity: item.quantity * ratio,
    threshold: item.threshold === null ? null : item.threshold * ratio,
  };
}
