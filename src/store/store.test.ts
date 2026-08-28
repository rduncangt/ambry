import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LADDER_DEFAULT_THRESHOLD,
  SCHEMA_VERSION,
  type AmbryDoc,
  type HistoryEvent,
} from "../types";
import { DOC_KEY, SNAPSHOT_PREFIX, memoryAdapter, type StorageAdapter } from "./adapter";
import { emptyDoc } from "./doc";
import { COALESCE_MS, SAVE_DEBOUNCE_MS, createStore, type Store } from "./store";
import { historyFor } from "../domain/merge";
import { planUnitChange } from "../domain/units";
import { parseImport } from "../domain/exportImport";

// ---------------------------------------------------------------------------
// Deterministic deps
// ---------------------------------------------------------------------------

const START_ISO = "2026-08-27T12:00:00.000Z";

function makeClock(startIso = START_ISO) {
  let t = Date.parse(startIso);
  return {
    now: (): string => new Date(t).toISOString(),
    advance(ms: number): void {
      t += ms;
    },
    set(iso: string): void {
      t = Date.parse(iso);
    },
  };
}

function makeUuid(): () => string {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
}

function fresh(initial?: Record<string, string>): {
  adapter: StorageAdapter;
  clock: ReturnType<typeof makeClock>;
  store: Store;
} {
  const adapter = memoryAdapter(initial);
  const clock = makeClock();
  const store = createStore(adapter, { now: clock.now, uuid: makeUuid() });
  return { adapter, clock, store };
}

function lastEvent(store: Store): HistoryEvent {
  const events = store.getDoc().events;
  const e = events[events.length - 1];
  if (e === undefined) throw new Error("no events");
  return e;
}

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

describe("createStore boot", () => {
  it("empty storage boots 'empty' and persists NOTHING (boot rule)", () => {
    const { adapter, store } = fresh();
    expect(store.bootStatus()).toBe("empty");
    expect(store.getDoc()).toEqual(emptyDoc());
    // flush with no mutations must not write the placeholder doc — from the
    // sandbox, eviction is indistinguishable from first run.
    store.flush();
    expect(adapter.keys()).toEqual([]);
  });

  it("existing current-schema doc boots 'loaded' with the doc", () => {
    const doc = emptyDoc("test-device");
    doc.settings.writes_since_export = 5;
    const { store } = fresh({ [DOC_KEY]: JSON.stringify(doc) });
    expect(store.bootStatus()).toBe("loaded");
    expect(store.getDoc().settings.writes_since_export).toBe(5);
    expect(store.getDoc().settings.device_label).toBe("test-device");
  });

  it("corrupt storage boots 'corrupt' with an empty doc", () => {
    const { adapter, store } = fresh({ [DOC_KEY]: "{broken" });
    expect(store.bootStatus()).toBe("corrupt");
    expect(store.getDoc()).toEqual(emptyDoc());
    // The raw text was stashed, never destroyed.
    expect(adapter.keys().some((k) => k.startsWith(SNAPSHOT_PREFIX + "corrupt-"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createItem
// ---------------------------------------------------------------------------

describe("createItem", () => {
  it("applies defaults and emits a create event (0 -> initial qty)", () => {
    const { store } = fresh();
    const item = store.createItem({ name: "paprika" });
    expect(item.unit).toBe("count");
    expect(item.quantity).toBe(1);
    expect(item.restock_amount).toBe(1);
    expect(item.display_mode).toBe("number");
    expect(item.threshold).toBeNull();
    expect(item.flagged).toBe(false);
    expect(item.verified_at).toBeNull();
    expect(item.created_at).toBe(START_ISO);
    expect(item.updated_at).toBe(START_ISO);
    expect(item.deleted_at).toBeNull();

    const doc = store.getDoc();
    expect(doc.items).toHaveLength(1);
    expect(doc.events).toHaveLength(1);
    expect(lastEvent(store)).toMatchObject({
      item_id: item.id,
      kind: "create",
      qty_before: 0,
      qty_after: 1,
      unit: "count",
      at: START_ISO,
    });
    expect(doc.settings.writes_since_export).toBe(1);
  });

  const thresholdCases: {
    name: string;
    input: Parameters<Store["createItem"]>[0];
    want: number | null;
  }[] = [
    { name: "ladder with no threshold gets the default", input: { name: "x", display_mode: "ladder" }, want: LADDER_DEFAULT_THRESHOLD },
    { name: "ladder with explicit null threshold gets the default", input: { name: "x", display_mode: "ladder", threshold: null }, want: LADDER_DEFAULT_THRESHOLD },
    { name: "ladder with explicit threshold keeps it", input: { name: "x", display_mode: "ladder", threshold: 0.5 }, want: 0.5 },
    { name: "number mode with no threshold stays null", input: { name: "x" }, want: null },
    { name: "number mode with explicit threshold keeps it", input: { name: "x", threshold: 2 }, want: 2 },
  ];
  for (const c of thresholdCases) {
    it(c.name, () => {
      const { store } = fresh();
      expect(store.createItem(c.input).threshold).toBe(c.want);
    });
  }

  it("rounds and clamps the initial quantity", () => {
    const { store } = fresh();
    expect(store.createItem({ name: "a", quantity: 1.23456 }).quantity).toBe(1.235);
    expect(store.createItem({ name: "b", quantity: -3 }).quantity).toBe(0);
  });

  it("does not auto-flag at creation even at/below threshold (edge-triggered)", () => {
    const { store } = fresh();
    const item = store.createItem({ name: "a", quantity: 0, threshold: 1 });
    expect(item.flagged).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// editItem
// ---------------------------------------------------------------------------

describe("editItem", () => {
  it("applies fields, bumps updated_at, emits NO event", () => {
    const { store, clock } = fresh();
    const item = store.createItem({ name: "flour" });
    clock.advance(60_000);
    store.editItem(item.id, { name: "bread flour", notes: "strong", location: "pantry", never_prompt: true });
    expect(item.name).toBe("bread flour");
    expect(item.notes).toBe("strong");
    expect(item.location).toBe("pantry");
    expect(item.never_prompt).toBe(true);
    expect(item.updated_at).toBe("2026-08-27T12:01:00.000Z");
    expect(store.getDoc().events).toHaveLength(1); // just the create
    expect(store.getDoc().settings.writes_since_export).toBe(2);
  });

  it("switching to ladder with a null threshold applies the default", () => {
    const { store } = fresh();
    const item = store.createItem({ name: "cumin" });
    store.editItem(item.id, { display_mode: "ladder" });
    expect(item.threshold).toBe(LADDER_DEFAULT_THRESHOLD);
  });

  it("switching to ladder keeps an existing or explicitly supplied threshold", () => {
    const { store } = fresh();
    const a = store.createItem({ name: "a", threshold: 0.4 });
    store.editItem(a.id, { display_mode: "ladder" });
    expect(a.threshold).toBe(0.4);

    const b = store.createItem({ name: "b" });
    store.editItem(b.id, { display_mode: "ladder", threshold: 0.6 });
    expect(b.threshold).toBe(0.6);
  });

  it("throws on an unknown id", () => {
    const { store } = fresh();
    expect(() => store.editItem("nope", { name: "x" })).toThrow(/Unknown item/);
  });
});

// ---------------------------------------------------------------------------
// Quantity gestures + coalescing
// ---------------------------------------------------------------------------

describe("adjustQuantity coalescing", () => {
  it("two quick adds settle into ONE event spanning the burst", () => {
    const { store, clock } = fresh();
    const item = store.createItem({ name: "eggs", quantity: 6 });
    clock.advance(5000);
    store.adjustQuantity(item.id, 1);
    clock.advance(500);
    store.adjustQuantity(item.id, 1);

    const doc = store.getDoc();
    expect(doc.events).toHaveLength(2); // create + one coalesced add
    expect(lastEvent(store)).toMatchObject({
      kind: "add",
      qty_before: 6, // the burst's origin, not the intermediate 7
      qty_after: 8,
      at: "2026-08-27T12:00:05.500Z", // `at` follows the latest tap
    });
    expect(item.quantity).toBe(8);
    // Each tap is still a committed mutation for the export nag.
    expect(doc.settings.writes_since_export).toBe(3);
  });

  it("add then use are DIFFERENT kinds: two events", () => {
    const { store, clock } = fresh();
    const item = store.createItem({ name: "eggs", quantity: 6 });
    clock.advance(5000);
    store.adjustQuantity(item.id, 1);
    clock.advance(200);
    store.adjustQuantity(item.id, -2);
    expect(store.getDoc().events.map((e) => e.kind)).toEqual(["create", "add", "use"]);
    expect(item.quantity).toBe(5);
  });

  it("coalesces at exactly COALESCE_MS, appends just past it", () => {
    const { store, clock } = fresh();
    const item = store.createItem({ name: "eggs", quantity: 1 });
    clock.advance(5000);
    store.adjustQuantity(item.id, 1);
    clock.advance(COALESCE_MS);
    store.adjustQuantity(item.id, 1); // boundary: still within
    expect(store.getDoc().events).toHaveLength(2);
    clock.advance(COALESCE_MS + 1);
    store.adjustQuantity(item.id, 1); // past: new event
    expect(store.getDoc().events).toHaveLength(3);
  });

  it("an intervening event for another item ends the burst", () => {
    const { store, clock } = fresh();
    const a = store.createItem({ name: "a" });
    const b = store.createItem({ name: "b" });
    clock.advance(5000);
    store.adjustQuantity(a.id, 1);
    clock.advance(100);
    store.adjustQuantity(b.id, 1);
    clock.advance(100);
    store.adjustQuantity(a.id, 1); // most recent event is b's — no coalesce
    const kinds = store.getDoc().events.map((e) => `${e.kind}:${e.item_id === a.id ? "a" : "b"}`);
    expect(kinds).toEqual(["create:a", "create:b", "add:a", "add:b", "add:a"]);
  });

  it("clamps decrements below zero to 0", () => {
    const { store, clock } = fresh();
    const item = store.createItem({ name: "milk", quantity: 1 });
    clock.advance(5000);
    store.adjustQuantity(item.id, -5);
    expect(item.quantity).toBe(0);
    expect(lastEvent(store)).toMatchObject({ kind: "use", qty_before: 1, qty_after: 0 });
  });

  it("a zero delta is a no-op: no event, no write counted", () => {
    const { store } = fresh();
    const item = store.createItem({ name: "milk" });
    store.adjustQuantity(item.id, 0);
    expect(store.getDoc().events).toHaveLength(1);
    expect(store.getDoc().settings.writes_since_export).toBe(1);
  });

  it("does not stamp verified_at (steppers are not observations of truth)", () => {
    const { store, clock } = fresh();
    const item = store.createItem({ name: "milk" });
    clock.advance(5000);
    store.adjustQuantity(item.id, 1);
    expect(item.verified_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Flags through the chokepoint
// ---------------------------------------------------------------------------

describe("threshold flag lifecycle", () => {
  it("raises exactly once on a downward crossing; purchase clears; re-cross re-raises", () => {
    const { store, clock } = fresh();
    const item = store.createItem({ name: "butter", unit: "stick", quantity: 2, threshold: 1 });

    clock.advance(5000);
    store.adjustQuantity(item.id, -1.5); // 2 -> 0.5 crosses 1
    expect(item.flagged).toBe(true);
    expect(item.flag_source).toBe("threshold");
    const firstFlaggedAt = item.flagged_at;
    expect(firstFlaggedAt).toBe("2026-08-27T12:00:05.000Z");

    // Second downward write while flagged: no re-raise, provenance untouched.
    clock.advance(60_000);
    store.adjustQuantity(item.id, -0.1);
    expect(item.flagged).toBe(true);
    expect(item.flagged_at).toBe(firstFlaggedAt);

    // Purchase clears — the only event that lowers it.
    clock.advance(60_000);
    store.purchase(item.id); // +1 restock -> 1.4
    expect(item.quantity).toBe(1.4);
    expect(item.flagged).toBe(false);
    expect(item.flag_source).toBeNull();
    expect(item.flagged_at).toBeNull();
    expect(lastEvent(store).kind).toBe("purchase");

    // Using it back down re-crosses and re-raises.
    clock.advance(60_000);
    store.adjustQuantity(item.id, -1); // 1.4 -> 0.4 crosses 1
    expect(item.flagged).toBe(true);
    expect(item.flag_source).toBe("threshold");
  });

  it("raises when landing exactly ON the threshold", () => {
    const { store, clock } = fresh();
    const item = store.createItem({ name: "butter", quantity: 2, threshold: 1 });
    clock.advance(5000);
    store.adjustQuantity(item.id, -1);
    expect(item.flagged).toBe(true);
  });

  it("purchase clears even when quantity stays at/below the threshold", () => {
    const { store, clock } = fresh();
    const item = store.createItem({ name: "butter", quantity: 2, threshold: 1, restock_amount: 0.1 });
    clock.advance(5000);
    store.adjustQuantity(item.id, -1.5); // flagged at 0.5
    expect(item.flagged).toBe(true);
    clock.advance(5000);
    store.purchase(item.id); // 0.6 — still under threshold
    expect(item.quantity).toBe(0.6);
    expect(item.flagged).toBe(false);
  });

  it("recount-up never clears (sticky rule)", () => {
    const { store, clock } = fresh();
    const item = store.createItem({ name: "butter", quantity: 2, threshold: 1 });
    clock.advance(5000);
    store.adjustQuantity(item.id, -1.5);
    expect(item.flagged).toBe(true);
    clock.advance(5000);
    store.setQuantity(item.id, 5);
    expect(item.quantity).toBe(5);
    expect(item.flagged).toBe(true);
    expect(item.flag_source).toBe("threshold");
  });

  it("purchase takes an explicit amount over restock_amount", () => {
    const { store, clock } = fresh();
    const item = store.createItem({ name: "eggs", quantity: 1, restock_amount: 6 });
    clock.advance(5000);
    store.purchase(item.id, 12);
    expect(item.quantity).toBe(13);
    expect(lastEvent(store)).toMatchObject({ kind: "purchase", qty_before: 1, qty_after: 13 });
  });
});

describe("never_prompt and manual flags", () => {
  it("never_prompt suppresses auto-raise; manual flag still works", () => {
    const { store, clock } = fresh();
    const item = store.createItem({ name: "eggnog", quantity: 2, threshold: 1 });
    store.setNeverPrompt(item.id, true);

    clock.advance(5000);
    store.adjustQuantity(item.id, -1.5); // crossing, but suppressed
    expect(item.flagged).toBe(false);

    clock.advance(5000);
    store.flagManual(item.id);
    expect(item.flagged).toBe(true);
    expect(item.flag_source).toBe("manual");
    expect(item.flagged_at).toBe("2026-08-27T12:00:10.000Z");
    // Flag changes are item fields, not events.
    expect(store.getDoc().events.map((e) => e.kind)).toEqual(["create", "use"]);

    store.clearFlag(item.id);
    expect(item.flagged).toBe(false);
    expect(item.flag_source).toBeNull();
    expect(item.flagged_at).toBeNull();
  });

  it("flagManual on an already-flagged item keeps original provenance", () => {
    const { store, clock } = fresh();
    const item = store.createItem({ name: "butter", quantity: 2, threshold: 1 });
    clock.advance(5000);
    store.adjustQuantity(item.id, -1.5);
    const at = item.flagged_at;
    clock.advance(5000);
    store.flagManual(item.id);
    expect(item.flag_source).toBe("threshold");
    expect(item.flagged_at).toBe(at);
  });

  it("clearFlag on an unflagged item is a no-op (no write, no notify)", () => {
    const { store } = fresh();
    const item = store.createItem({ name: "a" });
    const writes = store.getDoc().settings.writes_since_export;
    let calls = 0;
    store.subscribe(() => calls++);
    store.clearFlag(item.id);
    expect(calls).toBe(0);
    expect(store.getDoc().settings.writes_since_export).toBe(writes);
  });

  it("setNeverPrompt leaves an existing flag up (suppresses auto-raise only)", () => {
    const { store, clock } = fresh();
    const item = store.createItem({ name: "butter", quantity: 2, threshold: 1 });
    clock.advance(5000);
    store.adjustQuantity(item.id, -1.5);
    expect(item.flagged).toBe(true);
    store.setNeverPrompt(item.id, true);
    expect(item.flagged).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// verified_at stamping
// ---------------------------------------------------------------------------

describe("verified_at stamping", () => {
  it("setQuantity stamps it (recount)", () => {
    const { store, clock } = fresh();
    const item = store.createItem({ name: "rice" });
    clock.advance(5000);
    store.setQuantity(item.id, 3);
    expect(item.verified_at).toBe("2026-08-27T12:00:05.000Z");
    expect(lastEvent(store)).toMatchObject({ kind: "recount", qty_before: 1, qty_after: 3 });
  });

  it("a ladder rung write is a recount that stamps verified_at (and can raise)", () => {
    const { store, clock } = fresh();
    const item = store.createItem({ name: "cumin", display_mode: "ladder" }); // threshold 0.25
    clock.advance(5000);
    store.setLadderRung(item.id, "low");
    expect(item.quantity).toBe(0.2);
    expect(item.verified_at).toBe("2026-08-27T12:00:05.000Z");
    expect(lastEvent(store)).toMatchObject({ kind: "recount", qty_before: 1, qty_after: 0.2 });
    // 1 > 0.25 >= 0.2: the rung tap itself crossed the ladder default.
    expect(item.flagged).toBe(true);
  });

  it("purchase does NOT stamp it", () => {
    const { store, clock } = fresh();
    const item = store.createItem({ name: "rice" });
    clock.advance(5000);
    store.purchase(item.id);
    expect(item.verified_at).toBeNull();
  });

  it("verify() stamps with NO event", () => {
    const { store, clock } = fresh();
    const item = store.createItem({ name: "rice" });
    clock.advance(5000);
    store.verify(item.id);
    expect(item.verified_at).toBe("2026-08-27T12:00:05.000Z");
    expect(item.updated_at).toBe("2026-08-27T12:00:05.000Z");
    expect(store.getDoc().events).toHaveLength(1); // create only
    expect(store.getDoc().settings.writes_since_export).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

describe("undoQuantity + lastQuantityWrite", () => {
  it("lastQuantityWrite is null with no quantity-family events", () => {
    const { store } = fresh();
    expect(store.lastQuantityWrite()).toBeNull();
    store.createItem({ name: "a" }); // create is NOT in the undo family
    expect(store.lastQuantityWrite()).toBeNull();
  });

  it("reports the most recent add/use/recount/purchase, skipping other kinds", () => {
    const { store, clock } = fresh();
    const item = store.createItem({ name: "a", quantity: 2 });
    clock.advance(5000);
    store.adjustQuantity(item.id, -1);
    expect(store.lastQuantityWrite()).toEqual({ itemId: item.id, qtyBefore: 2 });
    // A delete event afterwards is skipped by the scan.
    clock.advance(5000);
    store.softDelete(item.id);
    expect(store.lastQuantityWrite()).toEqual({ itemId: item.id, qtyBefore: 2 });
  });

  it("a coalesced burst undoes to the PRE-burst value", () => {
    const { store, clock } = fresh();
    const item = store.createItem({ name: "a", quantity: 6 });
    clock.advance(5000);
    store.adjustQuantity(item.id, 1);
    clock.advance(100);
    store.adjustQuantity(item.id, 1);
    expect(store.lastQuantityWrite()).toEqual({ itemId: item.id, qtyBefore: 6 });
  });

  it("undo is a compensating recount WITHOUT a verified_at stamp", () => {
    const { store, clock } = fresh();
    const item = store.createItem({ name: "a", quantity: 2 });
    clock.advance(5000);
    store.adjustQuantity(item.id, -1);
    const undo = store.lastQuantityWrite();
    expect(undo).not.toBeNull();
    clock.advance(1000);
    store.undoQuantity(undo!.itemId, undo!.qtyBefore);
    expect(item.quantity).toBe(2);
    expect(item.verified_at).toBeNull(); // the human observed nothing
    expect(lastEvent(store)).toMatchObject({ kind: "recount", qty_before: 1, qty_after: 2 });
    // History stayed append-only: use then compensating recount.
    expect(store.getDoc().events.map((e) => e.kind)).toEqual(["create", "use", "recount"]);
  });

  it("undo runs flag evaluation like any quantity write", () => {
    const { store, clock } = fresh();
    const item = store.createItem({ name: "a", quantity: 2, threshold: 1 });
    clock.advance(5000);
    store.purchase(item.id); // 2 -> 3
    clock.advance(1000);
    store.undoQuantity(item.id, 0.5); // 3 -> 0.5 crosses the threshold
    expect(item.flagged).toBe(true);
  });

  it("restoreFlags puts back a manual flag the undone purchase cleared", () => {
    const { store, clock } = fresh();
    const item = store.createItem({ name: "butter", quantity: 1 });
    clock.advance(1000);
    store.flagManual(item.id);
    const flaggedAt = item.flagged_at;
    // The caller captures the triple BEFORE its write, exactly as the UI does.
    const flagsBefore = {
      flagged: item.flagged,
      flag_source: item.flag_source,
      flagged_at: item.flagged_at,
    };
    clock.advance(1000);
    store.purchase(item.id); // purchase ALWAYS clears — including manual flags
    expect(item.flagged).toBe(false);
    const undo = store.lastQuantityWrite();
    clock.advance(1000);
    store.undoQuantity(undo!.itemId, undo!.qtyBefore, flagsBefore);
    expect(item.quantity).toBe(1);
    // The manual flag is back with its ORIGINAL provenance and timestamp, so
    // the shopping list's oldest-first order does not reshuffle.
    expect(item.flagged).toBe(true);
    expect(item.flag_source).toBe("manual");
    expect(item.flagged_at).toBe(flaggedAt);
  });

  it("restoreFlags puts back a threshold flag a boundary purchase cleared", () => {
    const { store, clock } = fresh();
    const item = store.createItem({ name: "eggs", quantity: 3, threshold: 2 });
    clock.advance(1000);
    store.adjustQuantity(item.id, -2); // 3 -> 1 crosses: threshold raise
    expect(item.flag_source).toBe("threshold");
    const raisedAt = item.flagged_at;
    const flagsBefore = {
      flagged: item.flagged,
      flag_source: item.flag_source,
      flagged_at: item.flagged_at,
    };
    clock.advance(1000);
    store.purchase(item.id, 1); // 1 -> 2: ends AT the threshold, still clears
    expect(item.flagged).toBe(false);
    const undo = store.lastQuantityWrite();
    clock.advance(1000);
    // The compensating 2 -> 1 recount is NOT a fresh crossing (before must be
    // strictly above the threshold), so only restoreFlags can re-raise here.
    store.undoQuantity(undo!.itemId, undo!.qtyBefore, flagsBefore);
    expect(item.quantity).toBe(1);
    expect(item.flagged).toBe(true);
    expect(item.flag_source).toBe("threshold");
    expect(item.flagged_at).toBe(raisedAt);
  });

  it("restoreFlags clears a flag the undone write itself raised", () => {
    const { store, clock } = fresh();
    const item = store.createItem({ name: "milk", quantity: 3, threshold: 1 });
    const flagsBefore = {
      flagged: item.flagged,
      flag_source: item.flag_source,
      flagged_at: item.flagged_at,
    };
    clock.advance(1000);
    store.adjustQuantity(item.id, -2.5); // 3 -> 0.5 crosses: raise
    expect(item.flagged).toBe(true);
    const undo = store.lastQuantityWrite();
    clock.advance(1000);
    // The compensating 0.5 -> 3 recount is upward, and the sticky rule says
    // recount-up never clears — restoreFlags must override it in-commit.
    store.undoQuantity(undo!.itemId, undo!.qtyBefore, flagsBefore);
    expect(item.quantity).toBe(3);
    expect(item.flagged).toBe(false);
    expect(item.flag_source).toBeNull();
    expect(item.flagged_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Guarded unit flows
// ---------------------------------------------------------------------------

describe("changeUnit", () => {
  it("convert path moves quantity AND threshold together, one unit_change event with unit_before", () => {
    const { store, clock } = fresh();
    const item = store.createItem({
      name: "flour",
      unit: "bag",
      quantity: 2,
      threshold: 1,
      package_size: { amount: 1000, unit: "g" },
    });
    clock.advance(5000);
    const plan = planUnitChange(item, "g");
    expect(plan.kind).toBe("convert");
    store.changeUnit(item.id, "g", plan);

    expect(item.unit).toBe("g");
    expect(item.quantity).toBe(2000);
    expect(item.threshold).toBe(1000);
    expect(item.package_size).toEqual({ amount: 0.001, unit: "bag" });

    const events = store.getDoc().events;
    expect(events).toHaveLength(2); // create + ONE unit_change
    expect(lastEvent(store)).toMatchObject({
      kind: "unit_change",
      qty_before: 2, // in unit_before
      qty_after: 2000, // in the new unit
      unit: "g",
      unit_before: "bag",
    });
  });

  it("a pure re-labeling never raises the flag (g -> bag looks like a huge drop)", () => {
    const { store, clock } = fresh();
    const item = store.createItem({
      name: "flour",
      unit: "g",
      quantity: 2000,
      threshold: 1000,
      package_size: { amount: 0.001, unit: "bag" },
    });
    clock.advance(5000);
    const plan = planUnitChange(item, "bag");
    expect(plan.kind).toBe("convert");
    store.changeUnit(item.id, "bag", plan); // 2000 -> 2: numerically a crossing
    expect(item.quantity).toBe(2);
    expect(item.threshold).toBe(1);
    expect(item.flagged).toBe(false);
  });

  it("reenter path applies the caller's values; missing values throw", () => {
    const { store, clock } = fresh();
    const item = store.createItem({ name: "flour", unit: "bag", quantity: 2, threshold: 1 });
    clock.advance(5000);
    store.changeUnit(item.id, "g", { kind: "reenter" }, {
      quantity: 1500,
      threshold: 500,
      package_size: null,
    });
    expect(item.unit).toBe("g");
    expect(item.quantity).toBe(1500);
    expect(item.threshold).toBe(500);
    expect(item.package_size).toBeNull();
    expect(lastEvent(store)).toMatchObject({ kind: "unit_change", unit: "g", unit_before: "bag" });

    expect(() => store.changeUnit(item.id, "oz", { kind: "reenter" })).toThrow(/re-entered/);
  });
});

describe("resizePackage", () => {
  it("keep-amount rescales quantity and threshold through the ratio", () => {
    const { store, clock } = fresh();
    const item = store.createItem({
      name: "flour",
      unit: "bag",
      quantity: 2,
      threshold: 1,
      package_size: { amount: 1000, unit: "g" },
    });
    clock.advance(5000);
    store.resizePackage(item.id, { amount: 500, unit: "g" }, "amount");
    // Same 2000 g of flour, now counted in 500 g bags.
    expect(item.quantity).toBe(4);
    expect(item.threshold).toBe(2);
    expect(item.package_size).toEqual({ amount: 500, unit: "g" });
    const e = lastEvent(store);
    expect(e).toMatchObject({ kind: "unit_change", qty_before: 2, qty_after: 4, unit: "bag" });
    expect(e.unit_before).toBeUndefined(); // the unit string did not change
    expect(e.note).toContain("keep amount");
  });

  it("keep-count leaves the numbers; the package alone changes", () => {
    const { store, clock } = fresh();
    const item = store.createItem({
      name: "flour",
      unit: "bag",
      quantity: 2,
      threshold: 1,
      package_size: { amount: 1000, unit: "g" },
    });
    clock.advance(5000);
    store.resizePackage(item.id, { amount: 2000, unit: "g" }, "count");
    expect(item.quantity).toBe(2);
    expect(item.threshold).toBe(1);
    expect(item.package_size).toEqual({ amount: 2000, unit: "g" });
    expect(lastEvent(store)).toMatchObject({ kind: "unit_change", qty_before: 2, qty_after: 2 });
    expect(lastEvent(store).note).toContain("keep count");
  });
});

describe("clearPackageSize", () => {
  it("nulls the package, leaves quantity/threshold, records a noted unit_change", () => {
    const { store, clock } = fresh();
    const item = store.createItem({
      name: "flour",
      unit: "bag",
      quantity: 2,
      threshold: 1,
      package_size: { amount: 1000, unit: "g" },
    });
    clock.advance(5000);
    store.clearPackageSize(item.id);
    expect(item.package_size).toBeNull();
    // The numbers do not move — only the bag<->contents bookkeeping went away.
    expect(item.quantity).toBe(2);
    expect(item.threshold).toBe(1);
    expect(item.updated_at).toBe("2026-08-27T12:00:05.000Z");
    const e = lastEvent(store);
    expect(e).toMatchObject({
      item_id: item.id,
      kind: "unit_change",
      qty_before: 2,
      qty_after: 2,
      unit: "bag",
      note: "package 1000 g -> none",
    });
    // The unit string itself did not change, so no unit_before.
    expect(e.unit_before).toBeUndefined();
    expect(store.getDoc().settings.writes_since_export).toBe(2);
  });

  it("is a no-op when there is no package (no 'none -> none' event)", () => {
    const { store } = fresh();
    const item = store.createItem({ name: "salt" });
    store.clearPackageSize(item.id);
    expect(store.getDoc().events.map((e) => e.kind)).toEqual(["create"]);
    expect(store.getDoc().settings.writes_since_export).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

describe("mergeItems", () => {
  it("tombstones the loser, aliases + flags the survivor, and history still finds loser events", () => {
    const { store, clock } = fresh();
    const survivor = store.createItem({ name: "paprika", unit: "jar", quantity: 1 });
    const loser = store.createItem({ name: "Smoked Paprika", unit: "jar", quantity: 2 });
    store.editItem(loser.id, { aliases: ["pimentón"] });
    store.flagManual(loser.id);
    const loserFlaggedAt = loser.flagged_at;

    clock.advance(5000);
    store.mergeItems(survivor.id, loser.id, 3);

    // Loser: tombstone + pointer, never removed.
    expect(loser.deleted_at).toBe("2026-08-27T12:00:05.000Z");
    expect(loser.merged_into).toBe(survivor.id);

    // Survivor: aliases immunize future searches; flag ORs across the pair
    // and carries the loser's provenance.
    expect(survivor.aliases).toEqual(["Smoked Paprika", "pimentón"]);
    expect(survivor.quantity).toBe(3);
    expect(survivor.flagged).toBe(true);
    expect(survivor.flag_source).toBe("manual");
    expect(survivor.flagged_at).toBe(loserFlaggedAt);

    // ONE merge event, on the survivor, note = loser's name.
    const e = lastEvent(store);
    expect(e).toMatchObject({
      item_id: survivor.id,
      kind: "merge",
      qty_before: 1,
      qty_after: 3,
      note: "Smoked Paprika",
    });

    // Events were never rewritten: the loser's create still carries its id,
    // and the survivor's history view unions over the merged_into chain.
    const doc = store.getDoc();
    const loserCreate = doc.events.find((ev) => ev.item_id === loser.id && ev.kind === "create");
    expect(loserCreate).toBeDefined();
    const history = historyFor(doc, survivor.id);
    expect(history.some((ev) => ev.id === loserCreate!.id)).toBe(true);
  });

  it("throws when merging an item into itself", () => {
    const { store } = fresh();
    const item = store.createItem({ name: "a" });
    expect(() => store.mergeItems(item.id, item.id, 1)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Soft delete / restore
// ---------------------------------------------------------------------------

describe("softDelete / restore", () => {
  it("delete emits a delete event with qty_before = qty_after = quantity", () => {
    const { store, clock } = fresh();
    const item = store.createItem({ name: "a", quantity: 2 });
    clock.advance(5000);
    store.softDelete(item.id);
    expect(item.deleted_at).toBe("2026-08-27T12:00:05.000Z");
    expect(item.updated_at).toBe("2026-08-27T12:00:05.000Z");
    expect(lastEvent(store)).toMatchObject({ kind: "delete", qty_before: 2, qty_after: 2 });
  });

  it("restore clears deleted_at and emits a restore event", () => {
    const { store, clock } = fresh();
    const item = store.createItem({ name: "a", quantity: 2 });
    clock.advance(5000);
    store.softDelete(item.id);
    clock.advance(5000);
    store.restore(item.id);
    expect(item.deleted_at).toBeNull();
    expect(lastEvent(store)).toMatchObject({ kind: "restore", qty_before: 2, qty_after: 2 });
  });

  it("restore clears merged_into so a restored merge-loser owns its history again", () => {
    const { store, clock } = fresh();
    const survivor = store.createItem({ name: "paprika", unit: "jar", quantity: 1 });
    const loser = store.createItem({ name: "Smoked Paprika", unit: "jar", quantity: 1 });
    clock.advance(5000);
    store.mergeItems(survivor.id, loser.id, 2);
    expect(loser.merged_into).toBe(survivor.id);

    clock.advance(5000);
    store.restore(loser.id);
    expect(loser.deleted_at).toBeNull();
    // Without this, the restored item's events — past AND future — keep
    // resolving through the stale pointer to the merge survivor.
    expect(loser.merged_into).toBeNull();
    const loserCreate = store.getDoc().events.find(
      (e) => e.item_id === loser.id && e.kind === "create",
    );
    expect(loserCreate).toBeDefined();
    expect(historyFor(store.getDoc(), loser.id).some((e) => e.id === loserCreate!.id)).toBe(true);

    // A later reverse merge must not weld the pair into a pointer cycle.
    clock.advance(5000);
    store.mergeItems(loser.id, survivor.id, 2);
    expect(survivor.merged_into).toBe(loser.id);
    expect(loser.merged_into).toBeNull();
  });

  it("double delete / double restore are idempotent no-ops", () => {
    const { store, clock } = fresh();
    const item = store.createItem({ name: "a" });
    store.restore(item.id); // live already
    expect(store.getDoc().events).toHaveLength(1);
    clock.advance(5000);
    store.softDelete(item.id);
    store.softDelete(item.id);
    expect(store.getDoc().events.map((e) => e.kind)).toEqual(["create", "delete"]);
  });
});

// ---------------------------------------------------------------------------
// Extras
// ---------------------------------------------------------------------------

describe("shopping extras", () => {
  it("addExtra creates a live entry; check/uncheck toggle soft delete", () => {
    const { store, clock } = fresh();
    const extra = store.addExtra("birthday candles");
    expect(extra.text).toBe("birthday candles");
    expect(extra.deleted_at).toBeNull();
    expect(store.getDoc().extras).toEqual([extra]);
    expect(store.getDoc().settings.writes_since_export).toBe(1);

    clock.advance(5000);
    store.checkExtra(extra.id);
    expect(extra.deleted_at).toBe("2026-08-27T12:00:05.000Z");
    expect(extra.updated_at).toBe("2026-08-27T12:00:05.000Z");

    clock.advance(5000);
    store.uncheckExtra(extra.id);
    expect(extra.deleted_at).toBeNull();
    expect(extra.updated_at).toBe("2026-08-27T12:00:10.000Z");
  });

  it("re-checking a checked extra is a no-op", () => {
    const { store, clock } = fresh();
    const extra = store.addExtra("candles");
    clock.advance(5000);
    store.checkExtra(extra.id);
    const at = extra.deleted_at;
    clock.advance(5000);
    store.checkExtra(extra.id);
    expect(extra.deleted_at).toBe(at);
    expect(store.getDoc().settings.writes_since_export).toBe(2);
  });

  it("extras emit no history events", () => {
    const { store } = fresh();
    const extra = store.addExtra("candles");
    store.checkExtra(extra.id);
    expect(store.getDoc().events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Export / import round-trip
// ---------------------------------------------------------------------------

describe("export / import round-trip", () => {
  it("buildExport is read-only; recordExport stamps and zeroes the counter", () => {
    const { store, clock } = fresh();
    store.createItem({ name: "a" });
    store.addExtra("candles");
    clock.advance(5000);

    const envelope = store.buildExport();
    expect(envelope.app).toBe("ambry");
    expect(envelope.schema_version).toBe(SCHEMA_VERSION);
    expect(envelope.exported_at).toBe("2026-08-27T12:00:05.000Z");
    expect(envelope.counts).toEqual({ items: 1, events: 1, extras: 1 });
    // Building the envelope did NOT mark exported — only a completed share does.
    expect(store.getDoc().settings.last_export_at).toBeNull();
    expect(store.getDoc().settings.writes_since_export).toBe(2);

    store.recordExport();
    expect(store.getDoc().settings.last_export_at).toBe("2026-08-27T12:00:05.000Z");
    expect(store.getDoc().settings.writes_since_export).toBe(0);
  });

  it("full-fidelity round-trip through parseImport + importReplace, incl. the pre-import snapshot", () => {
    // Store A: real data including a tombstone (full fidelity check).
    const a = fresh();
    const kept = a.store.createItem({ name: "paprika", location: "pantry" });
    const dead = a.store.createItem({ name: "old sauce" });
    a.clock.advance(5000);
    a.store.softDelete(dead.id);
    a.store.adjustQuantity(kept.id, 2);
    a.store.addExtra("candles");
    const exported = JSON.stringify(a.store.buildExport());

    // Store B: different data that the import will replace.
    const b = fresh();
    b.store.createItem({ name: "b-only item" });
    b.store.flush();
    const preImportDoc = JSON.parse(b.adapter.get(DOC_KEY)!) as AmbryDoc;

    const parsed = parseImport(exported);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    b.clock.advance(60_000);
    const outcome = b.store.importReplace(parsed.doc);

    // Pre-import snapshot of B's OLD doc, at the promised key.
    expect(outcome.ok).toBe(true);
    expect(outcome.snapshotKey).toBe(SNAPSHOT_PREFIX + "pre-import-2026-08-27T12:01:00.000Z");
    const snapshot = JSON.parse(b.adapter.get(outcome.snapshotKey!)!) as AmbryDoc;
    expect(snapshot).toEqual(preImportDoc);
    expect(snapshot.items[0]!.name).toBe("b-only item");

    // The live doc is now A's data, tombstone and all — and it was persisted
    // IMMEDIATELY, no debounce window.
    expect(b.store.getDoc()).toEqual(a.store.getDoc());
    expect(JSON.parse(b.adapter.get(DOC_KEY)!)).toEqual(a.store.getDoc());
    expect(b.store.getDoc().items.find((i) => i.id === dead.id)?.deleted_at).not.toBeNull();

    // A third store booting from B's adapter sees the imported data.
    const c = createStore(b.adapter, { now: makeClock().now, uuid: makeUuid() });
    expect(c.bootStatus()).toBe("loaded");
    expect(c.getDoc()).toEqual(a.store.getDoc());
  });
});

describe("importReplace failure atomicity", () => {
  /** Adapter whose set() throws (like a quota error) when failWhen matches. */
  function failingSet(inner: StorageAdapter, failWhen: (key: string) => boolean): StorageAdapter {
    return {
      ...inner,
      set(k, v) {
        if (failWhen(k)) throw new Error("QuotaExceededError");
        inner.set(k, v);
      },
    };
  }

  it("a doc-save throw leaves memory AND storage on the old doc — no divergence", () => {
    // Seed real bytes so the store under test boots 'loaded'.
    const seeded = fresh();
    seeded.store.createItem({ name: "old doc item" });
    seeded.store.flush();

    let fail = false;
    const adapter = failingSet(seeded.adapter, (k) => fail && k === DOC_KEY);
    const store = createStore(adapter, { now: makeClock().now, uuid: makeUuid() });
    const rawBefore = adapter.get(DOC_KEY);
    const docBefore = store.getDoc();

    fail = true;
    const outcome = store.importReplace(emptyDoc("other-device"));
    expect(outcome.ok).toBe(false);
    // The in-memory doc is UNTOUCHED: the app is not silently running on an
    // import that never landed on disk.
    expect(store.getDoc()).toBe(docBefore);
    expect(store.getDoc().items.map((i) => i.name)).toEqual(["old doc item"]);
    expect(adapter.get(DOC_KEY)).toBe(rawBefore);

    // And the next save persists the OLD lineage, not the failed import.
    fail = false;
    store.adjustQuantity(store.getDoc().items[0]!.id, 1);
    store.flush();
    const persisted = JSON.parse(adapter.get(DOC_KEY)!) as AmbryDoc;
    expect(persisted.items[0]!.name).toBe("old doc item");
    expect(persisted.settings.device_label).not.toBe("other-device");
  });

  it("a pre-import snapshot throw also fails the import cleanly", () => {
    const seeded = fresh();
    seeded.store.createItem({ name: "old doc item" });
    seeded.store.flush();

    const adapter = failingSet(seeded.adapter, (k) => k.startsWith(SNAPSHOT_PREFIX));
    const store = createStore(adapter, { now: makeClock().now, uuid: makeUuid() });
    const rawBefore = adapter.get(DOC_KEY);

    const outcome = store.importReplace(emptyDoc("other-device"));
    expect(outcome.ok).toBe(false);
    expect(store.getDoc().items.map((i) => i.name)).toEqual(["old doc item"]);
    expect(adapter.get(DOC_KEY)).toBe(rawBefore);
  });
});

// ---------------------------------------------------------------------------
// Quota-safe persistence + cross-context clobber guard
// ---------------------------------------------------------------------------

describe("quota-safe persistence (saveError)", () => {
  function togglingAdapter(): { adapter: StorageAdapter; setFail: (v: boolean) => void } {
    const inner = memoryAdapter();
    let fail = false;
    return {
      setFail: (v) => (fail = v),
      adapter: {
        ...inner,
        set(k, v) {
          if (fail && k === DOC_KEY) throw new Error("QuotaExceededError");
          inner.set(k, v);
        },
      },
    };
  }

  it("a failed debounced save stays dirty, raises saveError, and recovers on flush", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { adapter, setFail } = togglingAdapter();
    const store = createStore(adapter, { now: makeClock().now, uuid: makeUuid() });
    let notifications = 0;
    store.subscribe(() => notifications++);
    expect(store.saveError()).toBe(false);

    setFail(true);
    store.createItem({ name: "a" }); // notify #1 (the mutation)
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
    // The save threw: nothing landed, the failure is surfaced and announced.
    expect(adapter.get(DOC_KEY)).toBeNull();
    expect(store.saveError()).toBe(true);
    expect(notifications).toBe(2);

    // flush() retries because the doc stayed dirty; success clears the flag.
    setFail(false);
    store.flush();
    expect(store.saveError()).toBe(false);
    expect(notifications).toBe(3); // recovery is UI-visible too
    expect((JSON.parse(adapter.get(DOC_KEY)!) as AmbryDoc).items).toHaveLength(1);
  });

  it("flush() itself survives a quota throw (pagehide must not crash)", () => {
    const { adapter, setFail } = togglingAdapter();
    const store = createStore(adapter, { now: makeClock().now, uuid: makeUuid() });
    store.createItem({ name: "a" });
    setFail(true);
    expect(() => store.flush()).not.toThrow();
    expect(store.saveError()).toBe(true);
    // Still dirty: a later successful flush lands the doc unchanged.
    setFail(false);
    store.flush();
    expect(store.saveError()).toBe(false);
    expect((JSON.parse(adapter.get(DOC_KEY)!) as AmbryDoc).items).toHaveLength(1);
  });
});

describe("cross-context clobber guard (storageConflict)", () => {
  it("refuses to save over bytes another context wrote — permanently", () => {
    const { adapter, store, clock } = fresh();
    const item = store.createItem({ name: "a" });
    store.flush();
    expect(store.storageConflict()).toBe(false);

    // Another tab writes DOC_KEY behind this store's back.
    const foreign = JSON.stringify(emptyDoc("other-tab"));
    adapter.set(DOC_KEY, foreign);

    let notifications = 0;
    store.subscribe(() => notifications++);
    clock.advance(5000);
    store.adjustQuantity(item.id, 1); // notify #1 (the mutation)
    store.flush(); // guard trips: notify #2, and crucially NO write
    expect(store.storageConflict()).toBe(true);
    expect(adapter.get(DOC_KEY)).toBe(foreign); // the other tab's data survives
    expect(notifications).toBe(2);

    // The refusal holds for the store's whole lifetime — only a reload
    // (which re-reads storage) can re-establish a baseline.
    store.adjustQuantity(item.id, 1);
    store.flush();
    expect(adapter.get(DOC_KEY)).toBe(foreign);
    // importReplace is a persist like any other: refused too.
    expect(store.importReplace(emptyDoc()).ok).toBe(false);
    expect(adapter.get(DOC_KEY)).toBe(foreign);
  });

  it("an empty boot that lost a race to another tab refuses its first save", () => {
    const adapter = memoryAdapter();
    const store = createStore(adapter, { now: makeClock().now, uuid: makeUuid() });
    const foreign = JSON.stringify(emptyDoc("other-tab"));
    adapter.set(DOC_KEY, foreign);
    store.createItem({ name: "mine" });
    store.flush();
    expect(store.storageConflict()).toBe(true);
    expect(adapter.get(DOC_KEY)).toBe(foreign);
  });

  it("a normal reload is not a conflict: the baseline comes from storage at boot", () => {
    const { adapter, store } = fresh();
    const item = store.createItem({ name: "a" });
    store.flush();
    const reloaded = createStore(adapter, { now: makeClock().now, uuid: makeUuid() });
    reloaded.adjustQuantity(item.id, 1);
    reloaded.flush();
    expect(reloaded.storageConflict()).toBe(false);
    expect((JSON.parse(adapter.get(DOC_KEY)!) as AmbryDoc).items[0]!.quantity).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Snapshot access
// ---------------------------------------------------------------------------

describe("snapshot access", () => {
  it("lists snapshots newest-first with byte sizes; reads and deletes them", () => {
    const { adapter, store } = fresh();
    store.createItem({ name: "a" });
    store.flush();
    const older = SNAPSHOT_PREFIX + "corrupt-2026-01-01T00:00:00.000Z";
    const newer = SNAPSHOT_PREFIX + "pre-import-2026-08-01T00:00:00.000Z";
    adapter.set(older, "junk-bytes");
    adapter.set(newer, "{}");

    const listed = store.listSnapshots();
    // Newest first (keys embed ISO timestamps), and never the live doc.
    expect(listed.map((s) => s.key)).toEqual([newer, older]);
    expect(listed[0]!.bytes).toBe(2); // "{}"
    expect(listed[1]!.bytes).toBe(10); // "junk-bytes"

    expect(store.snapshotText(older)).toBe("junk-bytes");
    expect(store.snapshotText(SNAPSHOT_PREFIX + "missing")).toBeNull();
    // Prefix-guarded: not a general storage peephole.
    expect(store.snapshotText(DOC_KEY)).toBeNull();

    const writesBefore = store.getDoc().settings.writes_since_export;
    const eventsBefore = store.getDoc().events.length;
    let notifications = 0;
    store.subscribe(() => notifications++);
    store.deleteSnapshot(older);
    expect(adapter.get(older)).toBeNull();
    expect(store.listSnapshots().map((s) => s.key)).toEqual([newer]);
    // Housekeeping, not a doc mutation: no event, meter untouched.
    expect(store.getDoc().settings.writes_since_export).toBe(writesBefore);
    expect(store.getDoc().events).toHaveLength(eventsBefore);
    expect(notifications).toBe(1);

    // deleteSnapshot can never remove the live doc.
    store.deleteSnapshot(DOC_KEY);
    expect(adapter.get(DOC_KEY)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Prune wiring
// ---------------------------------------------------------------------------

describe("prune", () => {
  it("prunes old events (keeping each item's latest) and stale checked extras", () => {
    const adapter = memoryAdapter();
    const clock = makeClock("2025-01-01T00:00:00.000Z");
    const store = createStore(adapter, { now: clock.now, uuid: makeUuid() });

    const item = store.createItem({ name: "flour", quantity: 2 });
    clock.advance(10_000);
    store.setQuantity(item.id, 3); // this newer event is the item's keeper
    const keeper = lastEvent(store).id;
    const gone = store.addExtra("old candles");
    clock.advance(10_000);
    store.checkExtra(gone.id); // checked long ago -> hard-pruned
    const live = store.addExtra("still wanted"); // live extras never prune

    const writesBefore = store.getDoc().settings.writes_since_export;
    let notifications = 0;
    store.subscribe(() => notifications++);

    clock.set("2026-08-27T12:00:00.000Z"); // > 365 days later
    store.prune();

    const doc = store.getDoc();
    expect(doc.events.map((e) => e.id)).toEqual([keeper]);
    expect(doc.extras.map((x) => x.id)).toEqual([live.id]);
    // Housekeeping must not move the data-at-risk meter.
    expect(doc.settings.writes_since_export).toBe(writesBefore);
    expect(notifications).toBe(1);

    // Second pass: nothing left to prune, so no notify and no save.
    store.prune();
    expect(notifications).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Subscription + persistence
// ---------------------------------------------------------------------------

describe("subscribe", () => {
  it("notifies synchronously once per committed mutation; unsubscribe stops", () => {
    const { store, clock } = fresh();
    let calls = 0;
    const unsubscribe = store.subscribe(() => calls++);

    const item = store.createItem({ name: "a" }); // 1
    clock.advance(5000);
    store.adjustQuantity(item.id, 1); // 2
    clock.advance(100);
    store.adjustQuantity(item.id, 1); // 3 — coalesced event, still a notify
    store.editItem(item.id, { notes: "x" }); // 4
    store.verify(item.id); // 5
    expect(calls).toBe(5);

    unsubscribe();
    store.adjustQuantity(item.id, 1);
    expect(calls).toBe(5);
  });
});

describe("debounced save + flush", () => {
  it("saves once after SAVE_DEBOUNCE_MS of quiet; mutations reset the window", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const adapter = memoryAdapter();
    let saves = 0;
    const counting: StorageAdapter = {
      ...adapter,
      set(k, v) {
        if (k === DOC_KEY) saves++;
        adapter.set(k, v);
      },
    };
    const clock = makeClock();
    const store = createStore(counting, { now: clock.now, uuid: makeUuid() });

    store.createItem({ name: "a" });
    expect(saves).toBe(0);
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS - 1);
    expect(saves).toBe(0);
    vi.advanceTimersByTime(1);
    expect(saves).toBe(1);

    // Two mutations inside one window collapse into one save.
    store.addExtra("x");
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS / 2);
    store.addExtra("y");
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS / 2);
    expect(saves).toBe(1); // window was reset by the second mutation
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS / 2);
    expect(saves).toBe(2);
  });

  it("flush saves immediately and cancels the pending timer", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const adapter = memoryAdapter();
    let saves = 0;
    const counting: StorageAdapter = {
      ...adapter,
      set(k, v) {
        if (k === DOC_KEY) saves++;
        adapter.set(k, v);
      },
    };
    const store = createStore(counting, { now: makeClock().now, uuid: makeUuid() });

    store.createItem({ name: "a" });
    store.flush();
    expect(saves).toBe(1);
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS * 5);
    expect(saves).toBe(1); // timer was cancelled — no double save

    store.flush();
    expect(saves).toBe(1); // nothing dirty — flush is a no-op
  });

  it("a second store booting from the same adapter sees flushed state exactly", () => {
    const { adapter, store, clock } = fresh();
    const item = store.createItem({ name: "paprika", location: "pantry" });
    clock.advance(5000);
    store.adjustQuantity(item.id, 2);
    store.addExtra("candles");
    store.flush();

    const reloaded = createStore(adapter, { now: makeClock().now, uuid: makeUuid() });
    expect(reloaded.bootStatus()).toBe("loaded");
    expect(reloaded.getDoc()).toEqual(store.getDoc());
  });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

describe("updateSettings", () => {
  it("applies retention_days and device_label and counts as a write", () => {
    const { store } = fresh();
    store.updateSettings({ retention_days: 30 });
    expect(store.getDoc().settings.retention_days).toBe(30);
    store.updateSettings({ device_label: "laptop" });
    expect(store.getDoc().settings.device_label).toBe("laptop");
    expect(store.getDoc().settings.writes_since_export).toBe(2);
  });
});

describe("undoQuantity verified_at restore", () => {
  it("undoing a first observation un-counts the item (verified_at back to null)", () => {
    const { store } = fresh();
    const item = store.createItem({ name: "Kiwi" });
    expect(item.verified_at).toBeNull();
    store.setQuantity(item.id, 3); // first observation stamps verified_at
    expect(item.verified_at).not.toBeNull();
    store.undoQuantity(item.id, 0, {
      flagged: false, flag_source: null, flagged_at: null, verified_at: null,
    });
    expect(item.quantity).toBe(0);
    expect(item.verified_at).toBeNull(); // back to "?" — not a false Out
  });

  it("zero-out undo restores the PRIOR stamp, not now", () => {
    const t0 = "2026-01-01T00:00:00.000Z";
    const { store } = fresh();
    const item = store.createItem({ name: "Rice" });
    item.verified_at = t0; // walked the shelf long ago
    store.setQuantity(item.id, 0); // reconcile zero-out stamps a fresh time
    expect(item.verified_at).not.toBe(t0);
    store.undoQuantity(item.id, 2, {
      flagged: false, flag_source: null, flagged_at: null, verified_at: t0,
    });
    expect(item.verified_at).toBe(t0); // stale-list standing restored
  });

  it("a snapshot without verified_at leaves the stamp untouched", () => {
    const { store } = fresh();
    const item = store.createItem({ name: "Oats", quantity: 2 });
    store.setQuantity(item.id, 5);
    const stamped = item.verified_at;
    store.undoQuantity(item.id, 2, { flagged: false, flag_source: null, flagged_at: null });
    expect(item.verified_at).toBe(stamped);
  });
});
