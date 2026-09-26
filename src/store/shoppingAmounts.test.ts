import { describe, expect, it } from "vitest";
import { parseImport } from "../domain/exportImport";
import { planUnitChange } from "../domain/units";
import { memoryAdapter } from "./adapter";
import { migrateDoc } from "./migrations";
import { createStore } from "./store";

function setup() {
  const adapter = memoryAdapter();
  let time = Date.parse("2026-09-13T12:00:00.000Z");
  const deps = { now: () => new Date(time++).toISOString() };
  const store = createStore(adapter, deps);
  const item = store.createItem({ name: "Wet Cat Food", quantity: 3, unit: "can", restock_amount: 1 });
  store.flagManual(item.id);
  return { adapter, deps, store, item };
}

describe("shopping amounts", () => {
  it("saves a plan across reopen and backup restore without claiming stock was bought", () => {
    const { adapter, deps, store, item } = setup();
    const before = structuredClone(item);
    const events = structuredClone(store.getDoc().events);
    const writes = store.getDoc().settings.writes_since_export;
    store.setShoppingAmount(item.id, 30);
    expect(item).toEqual({ ...before, shopping_amount: 30, updated_at: item.updated_at });
    expect(item.updated_at > before.updated_at).toBe(true);
    expect(store.getDoc().events).toEqual(events);
    expect(store.getDoc().settings.writes_since_export).toBe(writes + 1);
    store.flush();

    const reopened = createStore(adapter, deps);
    expect(reopened.getDoc().items[0]?.shopping_amount).toBe(30);
    const backup = parseImport(JSON.stringify(reopened.buildExport()));
    expect(backup.ok).toBe(true);
    if (!backup.ok) throw new Error(backup.detail);
    const restored = createStore(memoryAdapter(), deps);
    expect(restored.importReplace(backup.doc).ok).toBe(true);
    restored.purchase(item.id);
    expect(restored.getDoc().items[0]?.quantity).toBe(33);
    expect(restored.getDoc().items[0]?.restock_amount).toBe(1);
  });

  it("keeps independent plans for the two items shown in the recording", () => {
    const { adapter, deps, store, item } = setup();
    const mango = store.createItem({ name: "Mango Cup", quantity: 2, unit: "cup" });
    store.flagManual(mango.id);
    store.setShoppingAmount(item.id, 30);
    store.setShoppingAmount(mango.id, 8);
    store.editItem(mango.id, { category: "Fruit" });
    store.flush();
    const reopened = createStore(adapter, deps);
    reopened.purchase(mango.id);
    reopened.purchase(item.id);
    expect(reopened.getDoc().items.map((i) => i.quantity)).toEqual([33, 10]);
  });

  it("keeps plans for staging undo and put-back, resetting only checked-out items", () => {
    const { store, item } = setup();
    const unbought = store.createItem({ name: "Mango Cup" });
    store.flagManual(unbought.id);
    store.setShoppingAmount(unbought.id, 8);
    store.setShoppingAmount(item.id, 30);
    store.stageItem(item.id);
    store.putBackItem(item.id);
    expect(item.shopping_amount).toBe(30);
    expect(item.flagged).toBe(true);
    expect(item.quantity).toBe(3);
    store.stageItem(item.id);
    store.checkout();
    const bought = store.getDoc().items.find((i) => i.id === item.id)!;
    expect(bought.shopping_amount).toBeUndefined();
    expect(store.getDoc().items.find((i) => i.id === unbought.id)?.shopping_amount).toBe(8);
    expect(bought.quantity).toBe(33);
    store.flagManual(item.id);
    store.stageItem(item.id);
    store.checkout();
    expect(store.getDoc().items.find((i) => i.id === item.id)?.quantity).toBe(34);
    store.flush();
  });

  it("uses the usual amount for old documents and honors an explicit purchase override", () => {
    const { adapter, deps, store, item } = setup();
    store.flush();
    const reopened = createStore(adapter, deps);
    reopened.purchase(item.id);
    expect(reopened.getDoc().items[0]?.quantity).toBe(4);
    reopened.flagManual(item.id);
    reopened.setShoppingAmount(item.id, 30);
    reopened.purchase(item.id, 2);
    expect(reopened.getDoc().items[0]?.quantity).toBe(6);
    reopened.flush();
  });

  it("allows zero and fractional plans, rejecting invalid amounts without a write", () => {
    const { store, item } = setup();
    store.setShoppingAmount(item.id, 1.23456);
    expect(item.shopping_amount).toBe(1.235);
    const writes = store.getDoc().settings.writes_since_export;
    for (const value of [NaN, Infinity, Number.MAX_VALUE, -1, 1.235]) store.setShoppingAmount(item.id, value);
    expect(store.getDoc().settings.writes_since_export).toBe(writes);
    store.setShoppingAmount(item.id, 0);
    store.purchase(item.id);
    expect(item.quantity).toBe(3);
    expect(item.flagged).toBe(false);
    store.flush();
  });

  it("discards cancelled plans and ignores edits to deleted or unlisted items", () => {
    const { store, item } = setup();
    store.setShoppingAmount(item.id, 30);
    store.clearFlag(item.id);
    expect(item.shopping_amount).toBeUndefined();
    store.setShoppingAmount(item.id, 8);
    expect(item.shopping_amount).toBeUndefined();
    store.flagManual(item.id);
    store.setShoppingAmount(item.id, 30);
    store.softDelete(item.id);
    expect(item.shopping_amount).toBeUndefined();
    store.setShoppingAmount(item.id, 8);
    expect(item.shopping_amount).toBeUndefined();
    store.flush();
  });

  it("ignores malformed imported plans without mutating the input or rejecting the backup", () => {
    const { store, item } = setup();
    for (const shopping_amount of [null, "30", -1, Infinity, NaN, {}]) {
      const raw = { ...store.getDoc(), items: [{ ...item, shopping_amount }] };
      const migrated = migrateDoc(raw);
      expect(migrated.items[0]?.shopping_amount).toBeUndefined();
      expect(raw.items[0]?.shopping_amount).toEqual(shopping_amount);
    }
    for (const shopping_amount of [0, 1.25, 30]) {
      const raw = { ...store.getDoc(), items: [{ ...item, shopping_amount }] };
      expect(migrateDoc(raw).items[0]?.shopping_amount).toBe(shopping_amount);
    }
    store.flush();
  });

  it("converts plans with unit and package changes, discarding incompatible denominations", () => {
    const { store, item } = setup();
    store.resizePackage(item.id, { amount: 100, unit: "g" }, "count");
    store.setShoppingAmount(item.id, 30);
    store.resizePackage(item.id, { amount: 200, unit: "g" }, "amount");
    expect(item.shopping_amount).toBe(15);
    store.changeUnit(item.id, "g", planUnitChange(item, "g"));
    expect(item.shopping_amount).toBe(3000);
    store.changeUnit(item.id, "can", planUnitChange(item, "can"));
    expect(item.shopping_amount).toBe(15);
    store.changeUnit(item.id, "box", planUnitChange(item, "box"), {
      quantity: 1, threshold: null, package_size: null,
    });
    expect(item.shopping_amount).toBeUndefined();
    store.flush();
  });
});
