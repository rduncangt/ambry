import { describe, expect, it } from "vitest";
import { emptyDoc } from "../store/doc";
import type { Item } from "../types";
import { planCheckout, validShoppingAmount } from "./shopping";

const item = (id: string, fields: Partial<Item> = {}) => ({
  id, name: id, quantity: 3, shopping_amount: 2, carted_at: "2026-09-26T12:00:00.000Z",
  flagged: true, deleted_at: null, ...fields,
}) as Item;

describe("checkout planning", () => {
  it("uses current stock plus the saved amount without mutating the document", () => {
    const doc = { ...emptyDoc(), items: [item("beans"), item("rice", { quantity: 0.1, shopping_amount: 0.2 })] };
    const before = structuredClone(doc);
    expect(planCheckout(doc).purchases).toEqual([
      { itemId: "beans", quantity: 5 }, { itemId: "rice", quantity: 0.3 },
    ]);
    expect(doc).toEqual(before);
  });

  it.each([undefined, -1, NaN, Infinity, Number.MAX_VALUE])("rejects a bad staged amount (%s) before any purchase is booked", (amount) => {
    const doc = { ...emptyDoc(), items: [item("valid"), item("invalid", { shopping_amount: amount })] };
    const before = structuredClone(doc);
    expect(() => planCheckout(doc)).toThrow(/amount/);
    expect(doc).toEqual(before);
  });

  it("rejects overflow even when stock and planned amount are individually representable", () => {
    const doc = { ...emptyDoc(), items: [item("large", { quantity: 1e305, shopping_amount: 1e305 })] };
    expect(() => planCheckout(doc)).toThrow(/too large/);
  });

  it("ignores unstaged, deleted and removed lines; accepts an explicit zero", () => {
    const doc = { ...emptyDoc(), items: [
      item("unstaged", { carted_at: undefined }), item("deleted", { deleted_at: "2026-09-26" }),
      item("removed", { flagged: false }), item("zero", { shopping_amount: 0 }),
    ] };
    expect(planCheckout(doc).purchases).toEqual([{ itemId: "zero", quantity: 3 }]);
  });

  it("accepts only finite nonnegative amounts that remain finite after rounding", () => {
    for (const bad of [null, "2", -1, NaN, Infinity, Number.MAX_VALUE, {}]) {
      expect(validShoppingAmount(bad)).toBe(false);
    }
    for (const good of [0, 0.25, 30]) expect(validShoppingAmount(good)).toBe(true);
  });
});
