import { describe, expect, it } from "vitest";
import type { AmbryDoc, HistoryEvent, Item } from "../types";
import { historyFor, planMerge, resolveMergeChain } from "./merge";

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<Item> & { id: string }): Item {
  return {
    name: overrides.id,
    aliases: [],
    notes: "",
    category: null,
    location: null,
    unit: "count",
    quantity: 1,
    package_size: null,
    display_mode: "number",
    threshold: null,
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
    ...overrides,
  };
}

function makeEvent(overrides: Partial<HistoryEvent> & { id: string; item_id: string; at: string }): HistoryEvent {
  return {
    kind: "use",
    qty_before: 2,
    qty_after: 1,
    unit: "count",
    ...overrides,
  };
}

function makeDoc(items: Item[], events: HistoryEvent[]): AmbryDoc {
  return {
    schema_version: 1,
    items,
    events,
    extras: [],
    settings: {
      retention_days: 365,
      last_export_at: null,
      writes_since_export: 0,
      device_label: "test",
    },
  };
}

/** A merged loser row as the store would leave it. */
function loserRow(id: string, into: string, extra: Partial<Item> = {}): Item {
  return makeItem({
    id,
    merged_into: into,
    deleted_at: "2026-06-01T00:00:00.000Z",
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// resolveMergeChain
// ---------------------------------------------------------------------------

describe("resolveMergeChain", () => {
  const cases: Array<{
    name: string;
    items: Item[];
    id: string;
    expected: string;
  }> = [
    {
      name: "unknown id returns itself",
      items: [],
      id: "ghost",
      expected: "ghost",
    },
    {
      name: "item with no merged_into returns itself",
      items: [makeItem({ id: "a" })],
      id: "a",
      expected: "a",
    },
    {
      name: "depth 1: A->B resolves A to B",
      items: [loserRow("a", "b"), makeItem({ id: "b" })],
      id: "a",
      expected: "b",
    },
    {
      name: "depth 2: A->B->C resolves A to C",
      items: [loserRow("a", "b"), loserRow("b", "c"), makeItem({ id: "c" })],
      id: "a",
      expected: "c",
    },
    {
      name: "depth 2: the middle link B also resolves to C",
      items: [loserRow("a", "b"), loserRow("b", "c"), makeItem({ id: "c" })],
      id: "b",
      expected: "c",
    },
    {
      name: "chain ending at a dangling id returns that id",
      items: [loserRow("a", "gone")],
      id: "a",
      expected: "gone",
    },
    {
      name: "two-node cycle A->B->A returns the last id before the repeat",
      items: [loserRow("a", "b"), loserRow("b", "a")],
      id: "a",
      expected: "b",
    },
    {
      name: "two-node cycle entered at B returns A",
      items: [loserRow("a", "b"), loserRow("b", "a")],
      id: "b",
      expected: "a",
    },
    {
      name: "self-cycle A->A returns A",
      items: [loserRow("a", "a")],
      id: "a",
      expected: "a",
    },
    {
      name: "tail into a cycle terminates (X->A->B->A returns B)",
      items: [loserRow("x", "a"), loserRow("a", "b"), loserRow("b", "a")],
      id: "x",
      expected: "b",
    },
  ];

  it.each(cases)("$name", ({ items, id, expected }) => {
    expect(resolveMergeChain(items, id)).toBe(expected);
  });

  it("does not mutate the items array", () => {
    const items = [loserRow("a", "b"), makeItem({ id: "b" })];
    const snapshot = JSON.parse(JSON.stringify(items));
    resolveMergeChain(items, "a");
    expect(items).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// historyFor
// ---------------------------------------------------------------------------

describe("historyFor", () => {
  // A -> B -> C chain plus an unrelated item D.
  const items = [
    loserRow("a", "b"),
    loserRow("b", "c"),
    makeItem({ id: "c" }),
    makeItem({ id: "d" }),
  ];
  const events = [
    makeEvent({ id: "e1", item_id: "c", at: "2026-03-01T00:00:00.000Z", kind: "create" }),
    makeEvent({ id: "e2", item_id: "a", at: "2026-05-01T00:00:00.000Z", unit: "g" }),
    makeEvent({ id: "e3", item_id: "d", at: "2026-04-01T00:00:00.000Z" }),
    makeEvent({ id: "e4", item_id: "b", at: "2026-02-01T00:00:00.000Z" }),
    makeEvent({ id: "e5", item_id: "c", at: "2026-06-01T00:00:00.000Z", kind: "merge" }),
  ];
  const doc = makeDoc(items, events);

  it("unions events across the whole merged_into chain, newest first", () => {
    expect(historyFor(doc, "c").map((e) => e.id)).toEqual(["e5", "e2", "e1", "e4"]);
  });

  it("excludes events from unrelated items", () => {
    const ids = historyFor(doc, "c").map((e) => e.id);
    expect(ids).not.toContain("e3");
  });

  it("keeps the loser's original item_id on unioned events (never rewritten)", () => {
    const fromA = historyFor(doc, "c").find((e) => e.id === "e2");
    expect(fromA?.item_id).toBe("a");
    expect(fromA?.unit).toBe("g");
  });

  it("returns [] for a loser id — its events resolve past it to the survivor", () => {
    expect(historyFor(doc, "a")).toEqual([]);
    expect(historyFor(doc, "b")).toEqual([]);
  });

  it("returns [] for an id with no events", () => {
    expect(historyFor(doc, "d").map((e) => e.id)).toEqual(["e3"]);
    expect(historyFor(doc, "nothing")).toEqual([]);
  });

  it("finds events whose item_id is unknown when asked for that id directly", () => {
    // An orphaned event (its item was hard-lost somehow) resolves to itself.
    const orphanDoc = makeDoc([], [makeEvent({ id: "e9", item_id: "z", at: "2026-01-02T00:00:00.000Z" })]);
    expect(historyFor(orphanDoc, "z").map((e) => e.id)).toEqual(["e9"]);
  });

  it("does not mutate doc.events order", () => {
    const before = doc.events.map((e) => e.id);
    historyFor(doc, "c");
    expect(doc.events.map((e) => e.id)).toEqual(before);
  });

  it("survives a cyclic merged_into chain", () => {
    const cyclic = makeDoc(
      [loserRow("a", "b"), loserRow("b", "a")],
      [makeEvent({ id: "e1", item_id: "a", at: "2026-01-02T00:00:00.000Z" })],
    );
    // a resolves to b in the cycle; the call must terminate either way.
    expect(historyFor(cyclic, "b").map((e) => e.id)).toEqual(["e1"]);
  });
});

// ---------------------------------------------------------------------------
// planMerge
// ---------------------------------------------------------------------------

describe("planMerge", () => {
  it("throws when merging an item into itself", () => {
    const item = makeItem({ id: "same" });
    expect(() => planMerge(item, { ...item })).toThrow();
  });

  describe("aliases", () => {
    const cases: Array<{
      name: string;
      survivor: Partial<Item>;
      loser: Partial<Item>;
      expected: string[];
    }> = [
      {
        name: "loser name becomes an alias; survivor name excluded",
        survivor: { name: "Paprika" },
        loser: { name: "Smoked Paprika" },
        expected: ["Smoked Paprika"],
      },
      {
        name: "order: survivor aliases, then loser name, then loser aliases",
        survivor: { name: "Paprika", aliases: ["Pimentón"] },
        loser: { name: "Smoked Paprika", aliases: ["Spanish Paprika"] },
        expected: ["Pimentón", "Smoked Paprika", "Spanish Paprika"],
      },
      {
        name: "dedupe is case-insensitive; first-seen casing wins",
        survivor: { name: "Paprika", aliases: ["Pimentón"] },
        loser: { name: "PIMENTÓN", aliases: ["pimentón", "Paprika Dulce"] },
        expected: ["Pimentón", "Paprika Dulce"],
      },
      {
        name: "survivor.name is excluded case-insensitively",
        survivor: { name: "Paprika" },
        loser: { name: "paprika", aliases: ["PAPRIKA"] },
        expected: [],
      },
      {
        name: "duplicate within survivor aliases keeps first occurrence only",
        survivor: { name: "Flour", aliases: ["AP Flour", "ap flour"] },
        loser: { name: "All-Purpose Flour" },
        expected: ["AP Flour", "All-Purpose Flour"],
      },
    ];

    it.each(cases)("$name", ({ survivor, loser, expected }) => {
      const s = makeItem({ id: "s", ...survivor });
      const l = makeItem({ id: "l", ...loser });
      expect(planMerge(s, l).aliases).toEqual(expected);
    });
  });

  describe("flag OR", () => {
    const cases: Array<[boolean, boolean, boolean]> = [
      [false, false, false],
      [true, false, true],
      [false, true, true],
      [true, true, true],
    ];

    it.each(cases)("survivor %s | loser %s -> %s", (sf, lf, expected) => {
      const s = makeItem({ id: "s", flagged: sf });
      const l = makeItem({ id: "l", flagged: lf });
      expect(planMerge(s, l).flagged).toBe(expected);
    });
  });

  describe("quantity", () => {
    const cases: Array<{
      name: string;
      survivor: Partial<Item>;
      loser: Partial<Item>;
      defaultQuantity: number;
      needsQtyPrompt: boolean;
    }> = [
      {
        name: "identical units sum",
        survivor: { unit: "bag", quantity: 2 },
        loser: { unit: "bag", quantity: 1.5 },
        defaultQuantity: 3.5,
        needsQtyPrompt: false,
      },
      {
        name: "unit compare is case-insensitive",
        survivor: { unit: "Bag", quantity: 1 },
        loser: { unit: "bag", quantity: 2 },
        defaultQuantity: 3,
        needsQtyPrompt: false,
      },
      {
        name: "unit compare trims whitespace",
        survivor: { unit: " bag ", quantity: 1 },
        loser: { unit: "bag", quantity: 2 },
        defaultQuantity: 3,
        needsQtyPrompt: false,
      },
      {
        name: "sum is rounded to 3 decimals (no float noise)",
        survivor: { unit: "bag", quantity: 0.1 },
        loser: { unit: "bag", quantity: 0.2 },
        defaultQuantity: 0.3,
        needsQtyPrompt: false,
      },
      {
        name: "different units: survivor quantity + prompt",
        survivor: { unit: "bag", quantity: 2 },
        loser: { unit: "g", quantity: 500 },
        defaultQuantity: 2,
        needsQtyPrompt: true,
      },
      {
        name: "different units even when both are zero still prompt",
        survivor: { unit: "jar", quantity: 0 },
        loser: { unit: "can", quantity: 0 },
        defaultQuantity: 0,
        needsQtyPrompt: true,
      },
    ];

    it.each(cases)("$name", ({ survivor, loser, defaultQuantity, needsQtyPrompt }) => {
      const s = makeItem({ id: "s", ...survivor });
      const l = makeItem({ id: "l", ...loser });
      const plan = planMerge(s, l);
      expect(plan.defaultQuantity).toBe(defaultQuantity);
      expect(plan.needsQtyPrompt).toBe(needsQtyPrompt);
    });
  });

  it("does not mutate either item", () => {
    const s = makeItem({ id: "s", name: "Paprika", aliases: ["Pimentón"] });
    const l = makeItem({ id: "l", name: "paprika", aliases: ["Spanish"] });
    const sSnap = JSON.parse(JSON.stringify(s));
    const lSnap = JSON.parse(JSON.stringify(l));
    planMerge(s, l);
    expect(s).toEqual(sSnap);
    expect(l).toEqual(lSnap);
  });
});
