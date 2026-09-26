import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseImport } from "../domain/exportImport";
import { planUnitChange } from "../domain/units";
import { DOC_KEY, memoryAdapter, type StorageAdapter } from "./adapter";
import { shoppingList } from "./selectors";
import { createStore } from "./store";

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => vi.useRealTimers());

function setup(adapter: StorageAdapter = memoryAdapter()) {
  let time = Date.parse("2026-09-26T23:59:00.000Z");
  const now = () => new Date(time++).toISOString();
  const store = createStore(adapter, { now });
  const item = store.createItem({ name: "Beans", quantity: 3, unit: "can", restock_amount: 2 });
  store.flagManual(item.id);
  const current = () => store.getDoc().items.find((i) => i.id === item.id)!;
  return { store, item, current, adapter, now, advance: (ms: number) => { time += ms; } };
}

describe("cart staging", () => {
  it("captures the amount without changing stock, observation, flags or history", () => {
    const { store, item } = setup();
    const before = structuredClone(item);
    const events = structuredClone(store.getDoc().events);
    expect(store.stageItem(item.id)).toBe(true);
    expect(item).toEqual({ ...before, shopping_amount: 2, carted_at: item.updated_at, updated_at: item.updated_at });
    expect(store.getDoc().events).toEqual(events);
    expect(shoppingList(store.getDoc()).toBuy).toEqual([]);
    expect(shoppingList(store.getDoc()).inCart).toEqual([item]);
    // A later change to the usual default cannot silently change this cart.
    store.editItem(item.id, { restock_amount: 10 });
    expect(item.shopping_amount).toBe(2);
    const writes = store.getDoc().settings.writes_since_export;
    expect(store.stageItem(item.id)).toBe(false);
    expect(store.getDoc().settings.writes_since_export).toBe(writes);
  });

  it("persists edited cart amounts through reopening, midnight, pruning and backup restore", () => {
    const { store, item, adapter, now, advance } = setup();
    store.setShoppingAmount(item.id, 30);
    store.stageItem(item.id);
    store.setShoppingAmount(item.id, 8);
    store.flush();
    advance(3 * 86_400_000);
    const reopened = createStore(adapter, { now });
    reopened.prune();
    const staged = shoppingList(reopened.getDoc(), now()).inCart[0]!;
    expect(staged.shopping_amount).toBe(8);
    expect(staged.quantity).toBe(3);
    const parsed = parseImport(JSON.stringify(reopened.buildExport()));
    if (!parsed.ok) throw new Error(parsed.detail);
    const restored = createStore(memoryAdapter(), { now });
    expect(restored.importReplace(parsed.doc).ok).toBe(true);
    expect(shoppingList(restored.getDoc()).inCart).toHaveLength(1);
    expect(restored.checkout().ok).toBe(true);
    expect(restored.getDoc().items[0]?.quantity).toBe(11);
  });

  it("puts back or undoes staging without overwriting an intervening count", () => {
    const { store, item } = setup();
    store.setShoppingAmount(item.id, 5);
    const flags = [item.flagged, item.flag_source, item.flagged_at];
    store.stageItem(item.id);
    store.setQuantity(item.id, 10);
    const events = structuredClone(store.getDoc().events);
    const verified = item.verified_at;
    store.putBackItem(item.id);
    expect(item.quantity).toBe(10);
    expect(item.verified_at).toBe(verified);
    expect([item.flagged, item.flag_source, item.flagged_at]).toEqual(flags);
    expect(item.shopping_amount).toBe(5);
    expect(item.carted_at).toBeUndefined();
    expect(store.getDoc().events).toEqual(events);
    expect(shoppingList(store.getDoc()).toBuy).toEqual([item]);
    const writes = store.getDoc().settings.writes_since_export;
    store.putBackItem(item.id);
    expect(store.getDoc().settings.writes_since_export).toBe(writes);
    // Undoing Put back stages the same amount again.
    store.stageItem(item.id);
    expect(item.shopping_amount).toBe(5);
    expect(item.quantity).toBe(10);
  });

  it("cancels staging on list removal or deletion, including delete then restore", () => {
    const { store, item } = setup();
    store.stageItem(item.id);
    store.clearFlag(item.id);
    expect(item.carted_at).toBeUndefined();
    expect(store.stageItem(item.id)).toBe(false);
    store.flagManual(item.id);
    store.stageItem(item.id);
    store.softDelete(item.id);
    expect(item.carted_at).toBeUndefined();
    expect(store.stageItem(item.id)).toBe(false);
    store.restore(item.id);
    expect(shoppingList(store.getDoc()).inCart).toEqual([]);
    expect(store.checkout()).toEqual({ ok: true, itemCount: 0, extras: [] });
    expect(item.quantity).toBe(3);
  });

  it("converts a staged amount with its unit, but requires restaging after incompatible re-entry", () => {
    const { store, item } = setup();
    store.resizePackage(item.id, { amount: 100, unit: "g" }, "count");
    store.stageItem(item.id);
    store.changeUnit(item.id, "g", planUnitChange(item, "g"));
    expect(item.shopping_amount).toBe(200);
    expect(shoppingList(store.getDoc()).inCart).toEqual([item]);
    store.resizePackage(item.id, { amount: 0.02, unit: "can" }, "amount");
    expect(item.shopping_amount).toBe(100);
    store.changeUnit(item.id, "box", planUnitChange(item, "box"), {
      quantity: 1, threshold: null, package_size: null,
    });
    expect(item.carted_at).toBeUndefined();
    expect(item.shopping_amount).toBeUndefined();
    expect(shoppingList(store.getDoc()).toBuy).toEqual([item]);
  });

  it("never checks out a staged merge loser", () => {
    const { store, item, current } = setup();
    const survivor = store.createItem({ name: "Canned beans", quantity: 1, unit: "can" });
    store.stageItem(item.id);
    store.mergeItems(survivor.id, item.id, 4);
    expect(item.carted_at).toBeUndefined();
    expect(store.checkout()).toEqual({ ok: true, itemCount: 0, extras: [] });
    expect(current().deleted_at).not.toBeNull();
    expect(survivor.quantity).toBe(4);
    expect(survivor.flagged).toBe(true);
  });

  it("stages extras without deleting them and allows put-back before checkout", () => {
    const { store } = setup();
    const extra = store.addExtra("Candles");
    expect(store.stageExtra(extra.id)).toBe(true);
    expect(store.stageExtra(extra.id)).toBe(false);
    expect(extra.deleted_at).toBeNull();
    expect(shoppingList(store.getDoc()).extras).toEqual([]);
    expect(shoppingList(store.getDoc()).cartExtras).toEqual([extra]);
    store.putBackExtra(extra.id);
    expect(extra.carted_at).toBeUndefined();
    expect(shoppingList(store.getDoc()).extras).toEqual([extra]);
  });

  it("refuses malformed usual amounts rather than putting an unusable line in the cart", () => {
    const { store, item } = setup();
    for (const amount of [NaN, Infinity, Number.MAX_VALUE, -1]) {
      store.editItem(item.id, { restock_amount: amount });
      expect(store.stageItem(item.id)).toBe(false);
      expect(item.carted_at).toBeUndefined();
      expect(item.quantity).toBe(3);
    }
  });
});

describe("checkout", () => {
  it("books all staged lines in one save and notification; leaves unbought plans alone", () => {
    const memory = memoryAdapter();
    let saves = 0;
    const adapter = { ...memory, set: (k: string, v: string) => { if (k === DOC_KEY) saves++; memory.set(k, v); } };
    const { store, item, current } = setup(adapter);
    const second = store.createItem({ name: "Rice", quantity: 0.5, unit: "bag" });
    const later = store.createItem({ name: "Milk", quantity: 1 });
    store.flagManual(second.id); store.flagManual(later.id);
    store.setShoppingAmount(item.id, 30);
    store.setShoppingAmount(second.id, 1.5);
    store.setShoppingAmount(later.id, 8);
    store.stageItem(item.id); store.stageItem(second.id);
    const extra = store.addExtra("Candles");
    const extraLater = store.addExtra("Batteries");
    store.stageExtra(extra.id);
    const beforeEvents = store.getDoc().events.length;
    const beforeWrites = store.getDoc().settings.writes_since_export;
    // Deliberately leave staging inside the debounce window.
    const seen: number[][] = [];
    store.subscribe(() => seen.push(store.getDoc().items.map((i) => i.quantity)));
    expect(store.checkout()).toEqual({ ok: true, itemCount: 2, extras: [extra] });
    expect(saves).toBe(1);
    expect(seen).toEqual([[33, 2, 1]]);
    expect(JSON.parse(memory.get(DOC_KEY)!)).toEqual(store.getDoc());
    expect(store.getDoc().events.slice(beforeEvents)).toMatchObject([
      { item_id: item.id, kind: "purchase", qty_before: 3, qty_after: 33, unit: "can" },
      { item_id: second.id, kind: "purchase", qty_before: 0.5, qty_after: 2, unit: "bag" },
    ]);
    expect(current().flagged).toBe(false);
    expect(current().carted_at).toBeUndefined();
    expect(current().shopping_amount).toBeUndefined();
    expect(current().verified_at).toBeNull();
    expect(store.getDoc().settings.writes_since_export).toBe(beforeWrites + 1);
    expect(store.getDoc().settings.last_trip_ended_at).not.toBeNull();
    expect(shoppingList(store.getDoc()).toBuy.map((i) => [i.id, i.shopping_amount])).toEqual([[later.id, 8]]);
    expect(shoppingList(store.getDoc()).inCart).toEqual([]);
    expect(shoppingList(store.getDoc()).extras).toEqual([extraLater]);
    expect(store.getDoc().extras.find((x) => x.id === extra.id)?.deleted_at).not.toBeNull();
    vi.runAllTimers();
    expect(saves).toBe(1);
  });

  it("adds the staged amount to the latest count and cannot apply it twice, even after reload", () => {
    const { store, item, current, adapter, now } = setup();
    store.stageItem(item.id);
    store.setQuantity(item.id, 20);
    expect(store.checkout().ok).toBe(true);
    expect(current().quantity).toBe(22);
    const saved = adapter.get(DOC_KEY);
    expect(store.checkout()).toEqual({ ok: true, itemCount: 0, extras: [] });
    expect(adapter.get(DOC_KEY)).toBe(saved);
    const reopened = createStore(adapter, { now });
    expect(reopened.checkout()).toEqual({ ok: true, itemCount: 0, extras: [] });
    expect(adapter.get(DOC_KEY)).toBe(saved);
    reopened.flagManual(item.id);
    reopened.stageItem(item.id);
    reopened.checkout();
    expect(reopened.getDoc().items[0]?.quantity).toBe(24);
  });

  it("supports an extras-only checkout", () => {
    const { store, item, current } = setup();
    const extra = store.addExtra("Candles");
    store.stageExtra(extra.id);
    expect(store.checkout()).toEqual({ ok: true, itemCount: 0, extras: [extra] });
    expect(current().quantity).toBe(3);
    expect(current().flagged).toBe(true);
    expect(shoppingList(store.getDoc()).toBuy.map((i) => i.id)).toEqual([item.id]);
    expect(shoppingList(store.getDoc()).cartExtras).toEqual([]);
  });

  it("allows a zero-amount purchase only when explicitly checked out", () => {
    const { store, item, current } = setup();
    store.setShoppingAmount(item.id, 0);
    store.stageItem(item.id);
    expect(item.flagged).toBe(true);
    expect(store.checkout().ok).toBe(true);
    expect(current().quantity).toBe(3);
    expect(current().flagged).toBe(false);
    expect(store.getDoc().events.at(-1)).toMatchObject({ kind: "purchase", qty_before: 3, qty_after: 3 });
  });

  it("retains the whole cart and all prior stock after a failed save, then retries exactly once", () => {
    const memory = memoryAdapter();
    let fail = false;
    const adapter = { ...memory, set: (k: string, v: string) => {
      if (fail && k === DOC_KEY) throw new Error("QuotaExceededError");
      memory.set(k, v);
    } };
    const { store, item, current } = setup(adapter);
    store.stageItem(item.id);
    const extra = store.addExtra("Candles");
    store.stageExtra(extra.id);
    store.flush();
    const beforeDoc = store.getDoc();
    const beforeRaw = memory.get(DOC_KEY);
    fail = true;
    expect(store.checkout().ok).toBe(false);
    expect(store.saveError()).toBe(true);
    expect(store.getDoc()).toBe(beforeDoc);
    expect(memory.get(DOC_KEY)).toBe(beforeRaw);
    expect(item.quantity).toBe(3);
    expect(extra.deleted_at).toBeNull();
    expect(shoppingList(store.getDoc()).inCart).toEqual([item]);
    fail = false;
    expect(store.checkout().ok).toBe(true);
    expect(store.saveError()).toBe(false);
    expect(current().quantity).toBe(5);
    expect(store.getDoc().events.filter((e) => e.kind === "purchase")).toHaveLength(1);
  });

  it("refuses a checkout when another tab changed storage", () => {
    const { store, item, adapter } = setup();
    store.stageItem(item.id); store.flush();
    const foreign = JSON.stringify({ ...store.getDoc(), settings: { ...store.getDoc().settings, device_label: "other" } });
    adapter.set(DOC_KEY, foreign);
    const before = JSON.stringify(store.getDoc());
    expect(store.checkout().ok).toBe(false);
    expect(store.storageConflict()).toBe(true);
    expect(JSON.stringify(store.getDoc())).toBe(before);
    expect(adapter.get(DOC_KEY)).toBe(foreign);
  });

  it("never turns historical purchases into another checkout on upgrade/import", () => {
    const { store, item, adapter, now } = setup();
    store.purchase(item.id, 30); // the previous app already applied this
    store.flush();
    const raw = adapter.get(DOC_KEY);
    const reopened = createStore(adapter, { now });
    expect(shoppingList(reopened.getDoc()).inCart).toEqual([]);
    expect(reopened.checkout()).toEqual({ ok: true, itemCount: 0, extras: [] });
    expect(reopened.getDoc().items[0]?.quantity).toBe(33);
    expect(adapter.get(DOC_KEY)).toBe(raw);
  });
});
