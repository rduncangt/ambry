import { describe, expect, it } from "vitest";
import {
  EXPORT_NAG_DAYS,
  EXPORT_NAG_WRITES,
  type AmbryDoc,
  type HistoryEvent,
  type Item,
  type ShoppingExtra,
} from "../types";
import { emptyDoc } from "./doc";
import {
  STALE_DAYS,
  exportNag,
  groupedInventory,
  liveItems,
  resolveVocabValue,
  shoppingList,
  staleCount,
  stalest,
  valuesInUse,
  type ExportNagLevel,
} from "./selectors";

const DAY_MS = 86_400_000;
const NOW = "2026-08-27T12:00:00.000Z";

let seq = 0;

function makeItem(over: Partial<Item> = {}): Item {
  seq++;
  return {
    id: `item-${seq}`,
    name: `item ${seq}`,
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
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    deleted_at: null,
    ...over,
  };
}

function makeExtra(over: Partial<ShoppingExtra> = {}): ShoppingExtra {
  seq++;
  return {
    id: `extra-${seq}`,
    text: `extra ${seq}`,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    deleted_at: null,
    ...over,
  };
}

function makeEvent(over: Partial<HistoryEvent> = {}): HistoryEvent {
  seq++;
  return {
    id: `event-${seq}`,
    item_id: "item-1",
    at: "2026-08-01T00:00:00.000Z",
    kind: "purchase",
    qty_before: 0,
    qty_after: 1,
    unit: "count",
    ...over,
  };
}

function makeDoc(over: Partial<AmbryDoc> = {}): AmbryDoc {
  return { ...emptyDoc("test"), ...over };
}

/**
 * Local midnight of NOW, computed exactly the way the implementation does —
 * so these tests hold in every timezone the suite runs in.
 */
function localMidnightMs(nowIso: string): number {
  const d = new Date(nowIso);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

describe("liveItems", () => {
  it("filters out soft-deleted items", () => {
    const live = makeItem();
    const dead = makeItem({ deleted_at: "2026-08-02T00:00:00.000Z" });
    expect(liveItems(makeDoc({ items: [live, dead] }))).toEqual([live]);
  });

  it("is empty on an empty doc", () => {
    expect(liveItems(makeDoc())).toEqual([]);
  });
});

describe("shoppingList — toBuy", () => {
  it("contains flagged live items, oldest flagged_at first", () => {
    const newer = makeItem({ flagged: true, flagged_at: "2026-08-20T00:00:00.000Z" });
    const older = makeItem({ flagged: true, flagged_at: "2026-08-10T00:00:00.000Z" });
    const unflagged = makeItem();
    const deletedFlagged = makeItem({ flagged: true, flagged_at: "2026-08-01T00:00:00.000Z", deleted_at: NOW });
    const doc = makeDoc({ items: [newer, unflagged, older, deletedFlagged] });
    expect(shoppingList(doc, NOW).toBuy).toEqual([older, newer]);
  });

  it("sorts a null flagged_at first (treated as oldest)", () => {
    const dated = makeItem({ flagged: true, flagged_at: "2026-08-10T00:00:00.000Z" });
    const undated = makeItem({ flagged: true, flagged_at: null });
    const doc = makeDoc({ items: [dated, undated] });
    expect(shoppingList(doc, NOW).toBuy).toEqual([undated, dated]);
  });
});

describe("shoppingList — extras", () => {
  it("contains live extras oldest first; checked-off entries drop out", () => {
    const newer = makeExtra({ created_at: "2026-08-20T00:00:00.000Z" });
    const older = makeExtra({ created_at: "2026-08-10T00:00:00.000Z" });
    const checked = makeExtra({ deleted_at: NOW });
    const doc = makeDoc({ extras: [newer, checked, older] });
    expect(shoppingList(doc, NOW).extras).toEqual([older, newer]);
  });
});

describe("shoppingList — inCart (purchases since LOCAL midnight)", () => {
  const midnight = localMidnightMs(NOW);

  it("includes an item purchased after local midnight, excludes one before", () => {
    const bought = makeItem();
    const yesterday = makeItem();
    const doc = makeDoc({
      items: [bought, yesterday],
      events: [
        makeEvent({ item_id: bought.id, at: new Date(midnight + 3_600_000).toISOString() }),
        makeEvent({ item_id: yesterday.id, at: new Date(midnight - 3_600_000).toISOString() }),
      ],
    });
    expect(shoppingList(doc, NOW).inCart).toEqual([bought]);
  });

  it("a purchase exactly AT local midnight counts as today", () => {
    const item = makeItem();
    const doc = makeDoc({
      items: [item],
      events: [makeEvent({ item_id: item.id, at: new Date(midnight).toISOString() })],
    });
    expect(shoppingList(doc, NOW).inCart).toEqual([item]);
  });

  it("ignores non-purchase events and dedupes repeat purchases", () => {
    const item = makeItem();
    const other = makeItem();
    const doc = makeDoc({
      items: [item, other],
      events: [
        makeEvent({ item_id: other.id, kind: "recount", at: new Date(midnight + 1000).toISOString() }),
        makeEvent({ item_id: item.id, at: new Date(midnight + 2000).toISOString() }),
        makeEvent({ item_id: item.id, at: new Date(midnight + 3000).toISOString() }), // went back for one more
      ],
    });
    expect(shoppingList(doc, NOW).inCart).toEqual([item]);
  });

  it("excludes items deleted after purchase and events for vanished items", () => {
    const deleted = makeItem({ deleted_at: NOW });
    const doc = makeDoc({
      items: [deleted],
      events: [
        makeEvent({ item_id: deleted.id, at: new Date(midnight + 1000).toISOString() }),
        makeEvent({ item_id: "no-such-item", at: new Date(midnight + 2000).toISOString() }),
      ],
    });
    expect(shoppingList(doc, NOW).inCart).toEqual([]);
  });

  it("mid-trip state is purely derived: same doc, same list (no stored in_cart)", () => {
    const item = makeItem();
    const doc = makeDoc({
      items: [item],
      events: [makeEvent({ item_id: item.id, at: new Date(midnight + 1000).toISOString() })],
    });
    // Two independent evaluations (a "page kill" is just re-derivation).
    expect(shoppingList(doc, NOW)).toEqual(shoppingList(doc, NOW));
  });
});

describe("groupedInventory", () => {
  it("groups live items by location, alphabetical within, null -> 'elsewhere' last", () => {
    const items = [
      makeItem({ name: "Yeast", location: "pantry" }),
      makeItem({ name: "apples", location: null }),
      makeItem({ name: "butter", location: "fridge" }),
      makeItem({ name: "anchovies", location: "pantry" }),
      makeItem({ name: "peas", location: "Freezer" }),
      makeItem({ name: "old jam", location: "pantry", deleted_at: NOW }),
    ];
    const groups = groupedInventory(makeDoc({ items }));
    expect(groups.map((g) => g.location)).toEqual(["Freezer", "fridge", "pantry", "elsewhere"]);
    expect(groups.map((g) => g.items.map((i) => i.name))).toEqual([
      ["peas"],
      ["butter"],
      ["anchovies", "Yeast"], // case-insensitive alpha within
      ["apples"],
    ]);
  });

  it("returns no groups for an empty or all-deleted doc", () => {
    expect(groupedInventory(makeDoc())).toEqual([]);
    expect(groupedInventory(makeDoc({ items: [makeItem({ deleted_at: NOW })] }))).toEqual([]);
  });
});

describe("valuesInUse", () => {
  it("collects distinct non-empty values from live items, alphabetical", () => {
    const items = [
      makeItem({ category: "spices", location: "pantry", unit: "jar" }),
      makeItem({ category: "Baking", location: "pantry", unit: "bag" }),
      makeItem({ category: null, location: "  ", unit: "jar" }), // null/blank skipped, dup unit collapsed
      makeItem({ category: "dairy", location: "fridge", unit: "stick", deleted_at: NOW }), // tombstone vocab out
    ];
    const doc = makeDoc({ items });
    expect(valuesInUse(doc, "category")).toEqual(["Baking", "spices"]);
    expect(valuesInUse(doc, "location")).toEqual(["pantry"]);
    expect(valuesInUse(doc, "unit")).toEqual(["bag", "jar"]);
  });
});

describe("stalest", () => {
  it("orders live items by verified_at ascending with nulls (never verified) first", () => {
    const recent = makeItem({ verified_at: "2026-08-20T00:00:00.000Z" });
    const never = makeItem({ verified_at: null });
    const old = makeItem({ verified_at: "2026-08-05T00:00:00.000Z" });
    const deleted = makeItem({ verified_at: null, deleted_at: NOW });
    const doc = makeDoc({ items: [recent, never, old, deleted] });
    expect(stalest(doc)).toEqual([never, old, recent]);
  });

  it("filters to one location when asked (micro-audit by shelf)", () => {
    const pantryOld = makeItem({ location: "pantry", verified_at: "2026-08-05T00:00:00.000Z" });
    const pantryNever = makeItem({ location: "pantry", verified_at: null });
    const fridge = makeItem({ location: "fridge", verified_at: null });
    const nowhere = makeItem({ location: null, verified_at: null });
    const doc = makeDoc({ items: [pantryOld, fridge, pantryNever, nowhere] });
    expect(stalest(doc, "pantry")).toEqual([pantryNever, pantryOld]);
    expect(stalest(doc)).toHaveLength(4);
  });
});

describe("staleCount", () => {
  const iso = (msBeforeNow: number): string => new Date(Date.parse(NOW) - msBeforeNow).toISOString();

  it("counts live items whose verified_at is more than STALE_DAYS old", () => {
    const stale = makeItem({ verified_at: iso((STALE_DAYS + 1) * DAY_MS) });
    const fresh = makeItem({ verified_at: iso(1 * DAY_MS) });
    const doc = makeDoc({ items: [stale, fresh] });
    expect(staleCount(doc, NOW)).toBe(1);
  });

  it("an item verified exactly STALE_DAYS ago is not yet stale (strictly more than)", () => {
    const doc = makeDoc({ items: [makeItem({ verified_at: iso(STALE_DAYS * DAY_MS) })] });
    expect(staleCount(doc, NOW)).toBe(0);
  });

  it("never-verified items fall back to created_at — a fresh pantry is not instantly stale", () => {
    const seededToday = makeItem({ verified_at: null, created_at: iso(0) });
    const seededLongAgo = makeItem({ verified_at: null, created_at: iso((STALE_DAYS + 5) * DAY_MS) });
    const doc = makeDoc({ items: [seededToday, seededLongAgo] });
    expect(staleCount(doc, NOW)).toBe(1);
  });

  it("verified_at wins over an old created_at", () => {
    // Created ages ago but confirmed yesterday: not stale.
    const doc = makeDoc({
      items: [makeItem({ created_at: iso(100 * DAY_MS), verified_at: iso(1 * DAY_MS) })],
    });
    expect(staleCount(doc, NOW)).toBe(0);
  });

  it("ignores soft-deleted items", () => {
    const doc = makeDoc({
      items: [makeItem({ verified_at: iso(100 * DAY_MS), deleted_at: NOW })],
    });
    expect(staleCount(doc, NOW)).toBe(0);
  });
});

describe("resolveVocabValue", () => {
  it("returns the EXISTING casing on a case-insensitive match", () => {
    expect(resolveVocabValue(["fridge", "pantry"], "Fridge")).toBe("fridge");
    expect(resolveVocabValue(["Baking", "spices"], "baking")).toBe("Baking");
  });

  it("trims before matching (iOS keyboards add trailing spaces too)", () => {
    expect(resolveVocabValue(["fridge"], "  FRIDGE  ")).toBe("fridge");
  });

  it("returns the trimmed typed value when nothing matches", () => {
    expect(resolveVocabValue(["fridge", "pantry"], "  Freezer ")).toBe("Freezer");
    expect(resolveVocabValue([], "garage")).toBe("garage");
  });

  it("an exact match round-trips unchanged", () => {
    expect(resolveVocabValue(["fridge"], "fridge")).toBe("fridge");
  });
});

describe("exportNag", () => {
  function docWithData(settings: Partial<AmbryDoc["settings"]>, itemCreatedAt = "2026-08-01T00:00:00.000Z"): AmbryDoc {
    const doc = makeDoc({ items: [makeItem({ created_at: itemCreatedAt })] });
    Object.assign(doc.settings, settings);
    return doc;
  }
  const iso = (msBeforeNow: number): string => new Date(Date.parse(NOW) - msBeforeNow).toISOString();

  it("never nags an empty doc, whatever the counters say", () => {
    const doc = makeDoc();
    doc.settings.writes_since_export = EXPORT_NAG_WRITES * 10;
    doc.settings.last_export_at = iso(100 * DAY_MS);
    expect(exportNag(doc, NOW)).toBe("none");
  });

  const writeCases: { name: string; writes: number; want: ExportNagLevel }[] = [
    { name: "quiet under the write limit", writes: EXPORT_NAG_WRITES - 1, want: "none" },
    { name: "badge exactly at the write limit", writes: EXPORT_NAG_WRITES, want: "badge" },
    { name: "badge just under double", writes: EXPORT_NAG_WRITES * 2 - 1, want: "badge" },
    { name: "banner at double the write limit", writes: EXPORT_NAG_WRITES * 2, want: "banner" },
  ];
  for (const c of writeCases) {
    it(c.name, () => {
      // Recent export so only the write axis is in play.
      const doc = docWithData({ writes_since_export: c.writes, last_export_at: iso(0) });
      expect(exportNag(doc, NOW)).toBe(c.want);
    });
  }

  const dayCases: { name: string; ageMs: number; want: ExportNagLevel }[] = [
    { name: "quiet under the day limit", ageMs: EXPORT_NAG_DAYS * DAY_MS - 1, want: "none" },
    { name: "badge exactly at the day limit", ageMs: EXPORT_NAG_DAYS * DAY_MS, want: "badge" },
    { name: "banner at double the day limit", ageMs: EXPORT_NAG_DAYS * 2 * DAY_MS, want: "banner" },
  ];
  for (const c of dayCases) {
    it(c.name, () => {
      const doc = docWithData({ writes_since_export: 0, last_export_at: iso(c.ageMs) });
      expect(exportNag(doc, NOW)).toBe(c.want);
    });
  }

  it("either axis alone is enough for a banner", () => {
    const writesOnly = docWithData({ writes_since_export: EXPORT_NAG_WRITES * 2, last_export_at: iso(0) });
    expect(exportNag(writesOnly, NOW)).toBe("banner");
    const daysOnly = docWithData({ writes_since_export: 0, last_export_at: iso(EXPORT_NAG_DAYS * 2 * DAY_MS) });
    expect(exportNag(daysOnly, NOW)).toBe("banner");
  });

  it("never exported: the data's own age drives the day axis", () => {
    // Data 8 days old, no export ever: as unprotected as an 8-day-old backup.
    const doc = docWithData({ writes_since_export: 0, last_export_at: null }, iso(8 * DAY_MS));
    expect(exportNag(doc, NOW)).toBe("badge");
    const freshDoc = docWithData({ writes_since_export: 0, last_export_at: null }, iso(0));
    expect(exportNag(freshDoc, NOW)).toBe("none");
  });
});
