import { describe, expect, it } from "vitest";
import { memoryAdapter } from "./adapter";
import { createStore } from "./store";
import { shoppingList } from "./selectors";

function setup() {
  const adapter = memoryAdapter();
  let t = Date.parse("2026-09-17T12:00:00Z");
  const now = () => new Date(t++).toISOString();
  const store = createStore(adapter, { now });
  const a = store.createItem({ name: "Peas", quantity: 3, location: "pantry", category: "cans" });
  const b = store.createItem({ name: "Beans", quantity: 2, location: "pantry" });
  store.flagManual(a.id); store.setShoppingAmount(a.id, 5);
  return { store, adapter, a, b, now };
}
describe("organizeItems command", () => {
  it("commits the batch once, preserves stock/history/flags, persists, and undoes together", () => {
    const { store, adapter, a, b } = setup();
    const before = structuredClone([a,b]);
    const events = structuredClone(store.getDoc().events);
    const writes = store.getDoc().settings.writes_since_export;
    let notifications = 0;
    store.subscribe(() => notifications++);
    const changes = store.organizeItems([a.id,b.id], { location: "fridge", category: "Vegetables" });
    expect(notifications).toBe(1);
    expect(store.getDoc().settings.writes_since_export).toBe(writes + 1);
    expect(store.getDoc().events).toEqual(events);
    expect([a,b]).toEqual(before.map((i) => ({ ...i, location: "fridge", category: "Vegetables", updated_at: a.updated_at })));
    store.flush();
    expect(createStore(adapter).getDoc().items.map((i) => i.location)).toEqual(["fridge","fridge"]);
    store.undoOrganization(changes);
    expect([a,b]).toEqual(before.map((i) => ({ ...i, updated_at: a.updated_at })));
    expect(notifications).toBe(2);
    store.flush();
  });
  it("rejects stale selections atomically and doesn't count unchanged edits", () => {
    const { store, a } = setup();
    const before = JSON.stringify(store.getDoc());
    expect(() => store.organizeItems([a.id,"missing"], { location: "fridge" })).toThrow();
    expect(JSON.stringify(store.getDoc())).toBe(before);
    expect(store.organizeItems([a.id], { location: "pantry" })).toEqual([]);
    expect(JSON.stringify(store.getDoc())).toBe(before);
    store.flush();
  });
  it("a staged amount survives organization and inventory corrections until checkout", () => {
    const { store, a } = setup();
    store.stageItem(a.id);
    store.organizeItems([a.id], { location: "fridge" });
    store.setQuantity(a.id, 40);
    expect(shoppingList(store.getDoc()).inCart[0]?.shopping_amount).toBe(5);
    store.checkout();
    expect(shoppingList(store.getDoc()).inCart).toEqual([]);
    expect(store.getDoc().items.find((i) => i.id === a.id)?.quantity).toBe(45);
    store.flush();
  });
});
