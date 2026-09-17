import { describe, expect, it } from "vitest";
import { purchaseAmounts } from "./purchases";
import type { HistoryEvent } from "../types";
const event = (id: string, fields: Partial<HistoryEvent> = {}): HistoryEvent => ({
  id, item_id: "cat", at: "2026-09-17T12:00:00.000Z", kind: "purchase", qty_before: 3, qty_after: 33, unit: "can", ...fields,
});
describe("purchase receipt amounts", () => {
  it("reports the amount bought, not the resulting inventory", () => {
    expect(purchaseAmounts([event("a")]).get("cat")).toEqual([{ amount: 30, unit: "can" }]);
  });
  it("totals repeat purchases, ignores recounts and pairs reversals at identical timestamps", () => {
    const events = [event("a"), event("b", { qty_before: 33, qty_after: 35 }), event("c", { kind: "recount", note: "put back", qty_before: 35, qty_after: 33 }), event("d", { qty_before: 33, qty_after: 34 }), event("e", { kind: "recount", qty_after: 100 })];
    expect(purchaseAmounts(events).get("cat")).toEqual([{ amount: 31, unit: "can" }]);
  });
  it("keeps historical units separate and never pairs another item's reversal", () => {
    const amounts = purchaseAmounts([event("a"), event("b", { unit: "g", qty_before: 100, qty_after: 300 }), event("c", { item_id: "rice", kind: "recount", note: "put back" })]);
    expect(amounts.get("cat")).toEqual([{ amount: 200, unit: "g" }, { amount: 30, unit: "can" }]);
  });
  it("keeps zero purchases and removes completely reversed purchases", () => {
    expect(purchaseAmounts([event("a", { qty_after: 3 })]).get("cat")).toEqual([{ amount: 0, unit: "can" }]);
    expect(purchaseAmounts([event("a"), event("b", { kind: "recount", note: "put back" })]).has("cat")).toBe(false);
  });
});
