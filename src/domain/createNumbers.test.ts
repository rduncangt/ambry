import { describe, expect, it } from "vitest";
import { parseCreateNumbers, type CreateNumberDrafts } from "./createNumbers";

const blank: CreateNumberDrafts = { quantity: "", threshold: "", packageAmount: "", packageUnit: "" };

describe("numeric drafts for new items", () => {
  it("keeps blank fields absent so creation retains its existing defaults", () => {
    expect(parseCreateNumbers(blank)).toEqual({ ok: true, values: {} });
    expect(parseCreateNumbers({ quantity: " ", threshold: "\t", packageAmount: " ", packageUnit: " " }))
      .toEqual({ ok: true, values: {} });
  });

  it("distinguishes explicit zero stock/threshold from blank defaults", () => {
    expect(parseCreateNumbers({ ...blank, quantity: "0", threshold: "0" }))
      .toEqual({ ok: true, values: { quantity: 0, threshold: 0 } });
  });

  it.each(["-3", "-0.5", "cookies", "1.2.3", "NaN", "Infinity", "1e309", "1e308"])(
    "rejects explicit invalid quantity %j without offering a substitute quantity",
    (quantity) => {
      const result = parseCreateNumbers({ ...blank, quantity });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.quantity).toContain("0 or more");
      expect(result).not.toHaveProperty("values");
    },
  );

  it.each(["-1", "no", "Infinity"])("does not silently discard invalid threshold %j", (threshold) => {
    const result = parseCreateNumbers({ ...blank, quantity: "4", threshold });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.threshold).toBeDefined();
  });

  it.each([
    ["0", "g", "packageAmount"],
    ["-10", "g", "packageAmount"],
    ["many", "g", "packageAmount"],
    ["Infinity", "g", "packageAmount"],
    ["", "g", "packageAmount"],
    ["500", "", "packageUnit"],
  ] as const)("rejects incomplete/invalid package %j %j", (packageAmount, packageUnit, field) => {
    const result = parseCreateNumbers({ ...blank, packageAmount, packageUnit });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[field]).toBeDefined();
  });

  it("parses fractional quantities, zero threshold and decimal-comma package amounts", () => {
    const drafts = { quantity: " 4.25 ", threshold: "0", packageAmount: "0,5", packageUnit: " kg " };
    const before = { ...drafts };
    expect(parseCreateNumbers(drafts)).toEqual({ ok: true, values: {
      quantity: 4.25, threshold: 0, package_size: { amount: 0.5, unit: "kg" },
    } });
    expect(drafts).toEqual(before);
  });

  it("retains invalid drafts, reports every invalid field, and accepts a later correction", () => {
    const drafts = { quantity: "-3", threshold: "oops", packageAmount: "-2", packageUnit: "" };
    const before = { ...drafts };
    const result = parseCreateNumbers(drafts);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.errors)).toEqual(["quantity", "threshold", "packageAmount", "packageUnit"]);
    expect(drafts).toEqual(before);
    expect(parseCreateNumbers({ ...drafts, quantity: "3", threshold: "", packageAmount: "" }))
      .toEqual({ ok: true, values: { quantity: 3 } });
  });
});
