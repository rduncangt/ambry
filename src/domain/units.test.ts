import { describe, expect, it } from "vitest";
import { planPackageResize, planUnitChange, toPreciseUnit } from "./units";
import type { Item } from "../types";

/** Minimal valid Item; tests override the fields they exercise. */
function makeItem(over: Partial<Item> = {}): Item {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    name: "flour",
    aliases: [],
    notes: "",
    category: null,
    location: null,
    unit: "bag",
    quantity: 1,
    package_size: { amount: 1000, unit: "g" },
    display_mode: "number",
    threshold: 1,
    flagged: false,
    flag_source: null,
    flagged_at: null,
    restock_amount: 1,
    never_prompt: false,
    expiry: null,
    barcodes: [],
    verified_at: null,
    merged_into: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    deleted_at: null,
    ...over,
  };
}

describe("toPreciseUnit", () => {
  it("multiplies quantity through the package: 0.4 bag of {1000,g} -> 400 g", () => {
    const item = makeItem({ quantity: 0.4 });
    const precise = toPreciseUnit(item);
    expect(precise).not.toBeNull();
    expect(precise!.unit).toBe("g");
    expect(precise!.amount).toBeCloseTo(400, 10);
  });

  it("returns null without a package_size", () => {
    expect(toPreciseUnit(makeItem({ package_size: null }))).toBeNull();
  });

  it("returns null for an unusable (zero-amount) package", () => {
    expect(toPreciseUnit(makeItem({ package_size: { amount: 0, unit: "g" } }))).toBeNull();
  });
});

describe("planUnitChange", () => {
  it("bag -> g converts quantity AND threshold together and inverts the package", () => {
    const item = makeItem({ quantity: 0.432, threshold: 1 });
    const plan = planUnitChange(item, "g");
    expect(plan.kind).toBe("convert");
    if (plan.kind !== "convert") return;
    expect(plan.quantity).toBeCloseTo(432, 8);
    expect(plan.threshold).toBeCloseTo(1000, 8);
    // Same physical relation re-expressed for the new unit: 1 g = 0.001 bag
    expect(plan.package_size).not.toBeNull();
    expect(plan.package_size!.unit).toBe("bag");
    expect(plan.package_size!.amount).toBeCloseTo(0.001, 12);
  });

  it("g -> bag converts back through an inverted package", () => {
    const item = makeItem({
      unit: "g",
      quantity: 432,
      threshold: 1000,
      package_size: { amount: 0.001, unit: "bag" },
    });
    const plan = planUnitChange(item, "bag");
    expect(plan.kind).toBe("convert");
    if (plan.kind !== "convert") return;
    expect(plan.quantity).toBeCloseTo(0.432, 8);
    expect(plan.threshold).toBeCloseTo(1, 8);
    expect(plan.package_size!.unit).toBe("g");
    expect(plan.package_size!.amount).toBeCloseTo(1000, 6);
  });

  it("round-trips bag -> g -> bag to the original values", () => {
    const item = makeItem({ quantity: 0.432, threshold: 0.25 });
    const there = planUnitChange(item, "g");
    expect(there.kind).toBe("convert");
    if (there.kind !== "convert") return;
    const asGrams = makeItem({
      unit: "g",
      quantity: there.quantity,
      threshold: there.threshold,
      package_size: there.package_size,
    });
    const back = planUnitChange(asGrams, "bag");
    expect(back.kind).toBe("convert");
    if (back.kind !== "convert") return;
    expect(back.quantity).toBeCloseTo(0.432, 8);
    expect(back.threshold).toBeCloseTo(0.25, 8);
    // the original package relation is restored: {1000, "g"}
    expect(back.package_size!.amount).toBeCloseTo(1000, 6);
    expect(back.package_size!.unit).toBe("g");
  });

  it("null threshold passes through as null on the convert path", () => {
    const plan = planUnitChange(makeItem({ threshold: null }), "g");
    expect(plan.kind).toBe("convert");
    if (plan.kind !== "convert") return;
    expect(plan.threshold).toBeNull();
  });

  it("unit matching is case-insensitive-trimmed", () => {
    const plan = planUnitChange(makeItem({ quantity: 1 }), " G ");
    expect(plan.kind).toBe("convert");
    if (plan.kind !== "convert") return;
    expect(plan.quantity).toBeCloseTo(1000, 8);
  });

  it("same unit (modulo case) is a no-op convert, not a reenter", () => {
    const item = makeItem({ quantity: 2.5, threshold: 1 });
    const plan = planUnitChange(item, " BAG ");
    expect(plan).toEqual({
      kind: "convert",
      quantity: 2.5,
      threshold: 1,
      package_size: { amount: 1000, unit: "g" },
    });
  });

  const reenterCases: Array<[string, Partial<Item>, string]> = [
    ["unrelated unit", {}, "lb"],
    ["no package_size at all", { package_size: null }, "g"],
    ["unusable zero-amount package", { package_size: { amount: 0, unit: "g" } }, "g"],
  ];
  it.each(reenterCases)("forces re-entry: %s", (_name, over, newUnit) => {
    expect(planUnitChange(makeItem(over), newUnit)).toEqual({ kind: "reenter" });
  });
});

describe("planPackageResize", () => {
  // 1 bag = 1 kg, holding 3 bags, flag at 1 bag
  const base = makeItem({ package_size: { amount: 1, unit: "kg" }, quantity: 3, threshold: 1 });

  it("keep-amount rescales: 1 bag=1kg -> 2kg halves quantity and threshold", () => {
    const plan = planPackageResize(base, { amount: 2, unit: "kg" }, "amount");
    expect(plan.quantity).toBeCloseTo(1.5, 10);
    expect(plan.threshold).toBeCloseTo(0.5, 10);
  });

  it("keep-count is identity: the numbers stay, their meaning changes", () => {
    const plan = planPackageResize(base, { amount: 2, unit: "kg" }, "count");
    expect(plan).toEqual({ quantity: 3, threshold: 1 });
  });

  it("keep-amount passes a null threshold through as null", () => {
    const item = makeItem({ package_size: { amount: 1, unit: "kg" }, quantity: 3, threshold: null });
    const plan = planPackageResize(item, { amount: 2, unit: "kg" }, "amount");
    expect(plan.quantity).toBeCloseTo(1.5, 10);
    expect(plan.threshold).toBeNull();
  });

  it("keep-amount measure matching is case-insensitive-trimmed", () => {
    const plan = planPackageResize(base, { amount: 2, unit: " KG " }, "amount");
    expect(plan.quantity).toBeCloseTo(1.5, 10);
  });

  const noFactorCases: Array<[string, Item, { amount: number; unit: string }]> = [
    // Different measure unit: no conversion table exists between g and kg here
    ["measure unit changed", base, { amount: 2, unit: "g" }],
    ["no existing package", makeItem({ package_size: null, quantity: 3, threshold: 1 }), { amount: 2, unit: "kg" }],
    ["zero old amount", makeItem({ package_size: { amount: 0, unit: "kg" }, quantity: 3, threshold: 1 }), { amount: 2, unit: "kg" }],
    ["zero new amount", base, { amount: 0, unit: "kg" }],
  ];
  it.each(noFactorCases)("keep-amount without a usable ratio leaves numbers untouched: %s", (_name, item, newPkg) => {
    expect(planPackageResize(item, newPkg, "amount")).toEqual({ quantity: 3, threshold: 1 });
  });

  it("results are unrounded — callers round on write", () => {
    const item = makeItem({ package_size: { amount: 1, unit: "kg" }, quantity: 1, threshold: null });
    const plan = planPackageResize(item, { amount: 3, unit: "kg" }, "amount");
    expect(plan.quantity).toBe(1 / 3);
  });
});
