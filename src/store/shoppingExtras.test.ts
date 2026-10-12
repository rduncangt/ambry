import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryAdapter } from "./adapter";
import { shoppingList } from "./selectors";
import { createStore } from "./store";

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => vi.useRealTimers());

function setup() {
  let time = Date.parse("2026-10-11T12:00:00.000Z");
  const now = () => new Date(time).toISOString();
  const adapter = memoryAdapter();
  const store = createStore(adapter, { now });
  store.createItem({ name: "Butter", quantity: 10, unit: "stick" });
  return { store, adapter, now, advance: (ms: number) => { time += ms; } };
}

describe("removing shopping extras", () => {
  it.each([false, true])("soft-deletes an extra and restores its original cart status (carted=%s)", (carted) => {
    const { store, adapter, now, advance } = setup();
    const extra = store.addExtra("Birthday candles");
    if (carted) store.stageExtra(extra.id);
    const cartStamp = extra.carted_at;
    const before = structuredClone(store.getDoc());
    advance(1000);
    const removal = store.removeExtra(extra.id)!;
    expect(extra.deleted_at).toBe(now());
    expect(extra.updated_at).toBe(now());
    expect(extra.carted_at).toBeUndefined();
    expect(shoppingList(store.getDoc()).extras).toEqual([]);
    expect(shoppingList(store.getDoc()).cartExtras).toEqual([]);
    expect(store.buildExport().extras[0]?.deleted_at).toBe(now());
    store.flush();
    const reopened = createStore(adapter, { now });
    expect(reopened.getDoc().extras[0]?.deleted_at).toBe(now());
    expect(reopened.checkout()).toEqual({ ok: true, itemCount: 0, extras: [] });
    expect(store.getDoc().items).toEqual(before.items);
    expect(store.getDoc().events).toEqual(before.events);
    expect(store.getDoc().settings.last_trip_ended_at).toBe(before.settings.last_trip_ended_at);
    advance(1000);
    store.undoExtraRemoval(removal);
    expect(extra.deleted_at).toBeNull();
    expect(extra.carted_at).toBe(cartStamp);
    expect(extra.updated_at).toBe(now());
    expect(shoppingList(store.getDoc())[carted ? "cartExtras" : "extras"]).toEqual([extra]);
    store.flush();
    expect(createStore(adapter, { now }).getDoc().extras[0]).toEqual(extra);
    expect(store.getDoc().items).toEqual(before.items);
    expect(store.getDoc().events).toEqual(before.events);
    expect(store.getDoc().settings.last_trip_ended_at).toBe(before.settings.last_trip_ended_at);
    const writes = store.getDoc().settings.writes_since_export;
    store.undoExtraRemoval(removal);
    expect(store.getDoc().settings.writes_since_export).toBe(writes);
  });

  it("ignores deleted extras at checkout and retires Undo after a completed trip", () => {
    const { store } = setup();
    const removed = store.addExtra("Cancelled order");
    const purchased = store.addExtra("Birthday candles");
    store.stageExtra(removed.id);
    store.stageExtra(purchased.id);
    const removal = store.removeExtra(removed.id)!;
    const stock = structuredClone(store.getDoc().items);
    const events = structuredClone(store.getDoc().events);
    const outcome = store.checkout();
    expect(outcome.ok && outcome.extras.map((extra) => extra.id)).toEqual([purchased.id]);
    const completed = structuredClone(store.getDoc());
    store.undoExtraRemoval(removal);
    expect(store.getDoc()).toEqual(completed);
    expect(store.getDoc().items).toEqual(stock);
    expect(store.getDoc().events).toEqual(events);
    expect(store.checkout()).toEqual({ ok: true, itemCount: 0, extras: [] });
    expect(store.getDoc()).toEqual(completed);
  });

  it("cannot reuse an earlier Undo receipt after another removal, even at the same timestamp", () => {
    const { store } = setup();
    const extra = store.addExtra("Candles");
    const first = store.removeExtra(extra.id)!;
    expect(store.removeExtra(extra.id)).toBeNull();
    store.undoExtraRemoval(first);
    store.stageExtra(extra.id);
    const second = store.removeExtra(extra.id)!;
    const before = structuredClone(store.getDoc());
    store.undoExtraRemoval(first);
    expect(store.getDoc()).toEqual(before);
    store.undoExtraRemoval(second);
    expect(extra.deleted_at).toBeNull();
    expect(extra.carted_at).toBe(second.cartedAt);
  });

  it("does not resurrect an extra replaced by an import", () => {
    const { store } = setup();
    const extra = store.addExtra("Candles");
    const receipt = store.removeExtra(extra.id)!;
    expect(store.importReplace(structuredClone(store.getDoc())).ok).toBe(true);
    const imported = structuredClone(store.getDoc());
    store.undoExtraRemoval(receipt);
    expect(store.getDoc()).toEqual(imported);
  });

  it("leaves pruned removals alone without throwing", () => {
    const { store, advance } = setup();
    const extra = store.addExtra("Candles");
    const receipt = store.removeExtra(extra.id)!;
    advance(8 * 86_400_000);
    store.prune();
    const pruned = structuredClone(store.getDoc());
    expect(pruned.extras).toEqual([]);
    store.undoExtraRemoval(receipt);
    expect(store.getDoc()).toEqual(pruned);
  });
});
