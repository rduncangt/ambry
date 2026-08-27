/**
 * Package-size conversion and the guarded unit-change flow (PLAN.md §1.5).
 * The threshold, the history, and the package size are all denominated in the
 * item's mutable unit — so unit/package change is a MIGRATION FLOW, never a
 * bare field edit. Pure planning functions; the store applies plans.
 */
import type { Item } from "../types";

/**
 * Convert an amount in a measure into the item's coarse unit via package_size.
 * Item unit "bag" with package {1000,"g"}: (432,"g") -> 0.432; (2,"bag") -> 2.
 * Returns null when no conversion exists. Result is NOT rounded (callers
 * round on write; display rounds separately).
 */
export function toItemUnit(item: Item, amount: number, measure: string): number | null {
  throw new Error("TODO: implement (workflow)");
}

/** Precise-side display: 0.4 of a {1000,"g"} bag -> { amount: 400, unit: "g" }. */
export function toPreciseUnit(item: Item): { amount: number; unit: string } | null {
  throw new Error("TODO: implement (workflow)");
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
  throw new Error("TODO: implement (workflow)");
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
  throw new Error("TODO: implement (workflow)");
}
