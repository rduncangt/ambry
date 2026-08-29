import { describe, expect, it } from "vitest";
import {
  EXPORT_NAG_DAYS,
  EXPORT_NAG_WRITES,
  type AmbryDoc,
  type HistoryEvent,
  type Item,
  type ShoppingExtra,
} from "../types";
import { memoryAdapter } from "./adapter";
import { emptyDoc } from "./doc";
import { createStore } from "./store";
import {
  FRESH_DAYS,
  STALE_DAYS,
  backupAgeDays,
  exportNag,
  groupByCategory,
  isLow,
  isUncounted,
  itemsInLocation,
  liveItems,
  locationSummaries,
  needsCheck,
  purchaseRhythm,
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

  it("excludes a currently-flagged item — a put-back row lives in To Buy only", () => {
    // unpurchase re-raises the flag; the row must move back to To Buy whole,
    // never sit in both sections at once.
    const putBack = makeItem({ flagged: true, flagged_at: NOW });
    const kept = makeItem();
    const doc = makeDoc({
      items: [putBack, kept],
      events: [
        makeEvent({ item_id: putBack.id, at: new Date(midnight + 1000).toISOString() }),
        makeEvent({ item_id: kept.id, at: new Date(midnight + 2000).toISOString() }),
      ],
    });
    const list = shoppingList(doc, NOW);
    expect(list.inCart).toEqual([kept]);
    expect(list.toBuy).toEqual([putBack]);
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

describe("groupByCategory", () => {
  it("groups by category — categories alphabetical (case-insensitive), items alpha within", () => {
    const cheddar = makeItem({ name: "cheddar", category: "Dairy" });
    const apples = makeItem({ name: "Apples", category: "produce" });
    const bananas = makeItem({ name: "bananas", category: "produce" });
    const milk = makeItem({ name: "milk", category: "Dairy" });
    expect(groupByCategory([milk, bananas, cheddar, apples])).toEqual([
      { category: "Dairy", items: [cheddar, milk] },
      { category: "produce", items: [apples, bananas] },
    ]);
  });

  it("puts the null bucket last, after every named category", () => {
    const zebraCakes = makeItem({ name: "zebra cakes", category: "Zzz snacks" });
    const twine = makeItem({ name: "twine", category: null });
    const apples = makeItem({ name: "apples", category: "produce" });
    expect(groupByCategory([twine, zebraCakes, apples])).toEqual([
      { category: "produce", items: [apples] },
      { category: "Zzz snacks", items: [zebraCakes] },
      { category: null, items: [twine] },
    ]);
  });

  it('folds "Dairy"/"dairy" into ONE group under the first-seen casing', () => {
    const milk = makeItem({ name: "milk", category: "dairy" });
    const cheddar = makeItem({ name: "cheddar", category: "Dairy" });
    expect(groupByCategory([milk, cheddar])).toEqual([
      { category: "dairy", items: [cheddar, milk] },
    ]);
  });

  it("files blank/whitespace categories into the null bucket", () => {
    const blank = makeItem({ name: "blank", category: "" });
    const spaces = makeItem({ name: "spaces", category: "   " });
    expect(groupByCategory([spaces, blank])).toEqual([
      { category: null, items: [blank, spaces] },
    ]);
  });

  it("returns [] for empty input", () => {
    expect(groupByCategory([])).toEqual([]);
  });
});

describe("isUncounted", () => {
  const cases: { name: string; over: Partial<Item>; want: boolean }[] = [
    { name: "zero never verified -> uncounted", over: { quantity: 0, verified_at: null }, want: true },
    { name: "zero a human confirmed -> a real Out, not uncounted", over: { quantity: 0, verified_at: NOW }, want: false },
    { name: "nonzero never verified -> counted (seeded with a number)", over: { quantity: 2, verified_at: null }, want: false },
    { name: "nonzero and verified -> counted", over: { quantity: 1, verified_at: NOW }, want: false },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(isUncounted(makeItem(c.over))).toBe(c.want);
    });
  }
});

describe("isLow", () => {
  const cases: { name: string; over: Partial<Item>; want: boolean }[] = [
    { name: "below threshold -> low", over: { quantity: 0.5, threshold: 1 }, want: true },
    { name: "exactly at threshold -> low (<= rule)", over: { quantity: 1, threshold: 1 }, want: true },
    { name: "above threshold -> not low", over: { quantity: 2, threshold: 1 }, want: false },
    { name: "no threshold -> never low, even at zero", over: { quantity: 0, verified_at: NOW, threshold: null }, want: false },
    { name: "verified zero under threshold -> low", over: { quantity: 0, verified_at: NOW, threshold: 1 }, want: true },
    { name: "uncounted zero under threshold -> NOT low (a question, not a shortage)", over: { quantity: 0, verified_at: null, threshold: 1 }, want: false },
    { name: "soft-deleted -> not low", over: { quantity: 0, verified_at: NOW, threshold: 1, deleted_at: NOW }, want: false },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(isLow(makeItem(c.over))).toBe(c.want);
    });
  }
});

describe("locationSummaries", () => {
  it("orders physical shelves first, then others alphabetically, null bucket last", () => {
    const items = [
      makeItem({ location: "garage" }),
      makeItem({ location: null }),
      makeItem({ location: "freezer" }),
      makeItem({ location: "cellar" }),
      makeItem({ location: "pantry" }),
      makeItem({ location: "fridge" }),
      makeItem({ location: "countertop" }),
    ];
    expect(locationSummaries(makeDoc({ items })).map((s) => s.location)).toEqual([
      "pantry",
      "fridge",
      "freezer",
      "countertop",
      "cellar",
      "garage",
      null,
    ]);
  });

  it("ranks physical shelves case-insensitively (iOS-capitalized seeds still walk in order)", () => {
    const items = [makeItem({ location: "attic" }), makeItem({ location: "Fridge" })];
    expect(locationSummaries(makeDoc({ items })).map((s) => s.location)).toEqual([
      "Fridge",
      "attic",
    ]);
  });

  it("counts total/counted/low/flagged/uncounted per location over live items only", () => {
    const items = [
      makeItem({ location: "pantry", quantity: 2, verified_at: NOW }),
      makeItem({ location: "pantry", quantity: 0, verified_at: null }), // uncounted
      makeItem({ location: "pantry", quantity: 1, threshold: 1, verified_at: NOW }), // low
      makeItem({ location: "pantry", flagged: true, flagged_at: NOW }),
      makeItem({ location: "pantry", deleted_at: NOW }), // tombstone: invisible
      makeItem({ location: "fridge", quantity: 0, verified_at: null, flagged: true, flagged_at: NOW }),
    ];
    expect(locationSummaries(makeDoc({ items }))).toEqual([
      { location: "pantry", total: 4, counted: 3, low: 1, flagged: 1, uncounted: 1 },
      // Uncounted-but-flagged: counts as uncounted AND flagged, never low.
      { location: "fridge", total: 1, counted: 0, low: 0, flagged: 1, uncounted: 1 },
    ]);
  });

  it("is empty for an empty or all-deleted doc", () => {
    expect(locationSummaries(makeDoc())).toEqual([]);
    expect(locationSummaries(makeDoc({ items: [makeItem({ deleted_at: NOW })] }))).toEqual([]);
  });
});

describe("itemsInLocation", () => {
  it("splits one location's live items into counted/uncounted, each case-insensitive alpha", () => {
    const items = [
      makeItem({ name: "Yeast", location: "pantry", quantity: 1 }),
      makeItem({ name: "anchovies", location: "pantry", quantity: 2 }),
      makeItem({ name: "rice", location: "pantry", quantity: 0, verified_at: null }),
      makeItem({ name: "Flour", location: "pantry", quantity: 0, verified_at: null }),
      makeItem({ name: "butter", location: "fridge", quantity: 1 }),
      makeItem({ name: "old jam", location: "pantry", deleted_at: NOW }),
    ];
    const split = itemsInLocation(makeDoc({ items }), "pantry");
    expect(split.counted.map((i) => i.name)).toEqual(["anchovies", "Yeast"]);
    expect(split.uncounted.map((i) => i.name)).toEqual(["Flour", "rice"]);
  });

  it("null selects the elsewhere bucket (location === null) only", () => {
    const nowhere = makeItem({ name: "string", location: null, quantity: 1 });
    const filed = makeItem({ name: "flour", location: "pantry", quantity: 1 });
    const split = itemsInLocation(makeDoc({ items: [nowhere, filed] }), null);
    expect(split.counted).toEqual([nowhere]);
    expect(split.uncounted).toEqual([]);
  });

  it("a verified zero counts as counted (it is a real Out, not a seed)", () => {
    const out = makeItem({ name: "milk", location: "fridge", quantity: 0, verified_at: NOW });
    const split = itemsInLocation(makeDoc({ items: [out] }), "fridge");
    expect(split.counted).toEqual([out]);
    expect(split.uncounted).toEqual([]);
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

describe("needsCheck", () => {
  const iso = (msBeforeNow: number): string => new Date(Date.parse(NOW) - msBeforeNow).toISOString();

  it("FRESH_DAYS is a floor under STALE_DAYS — the two thresholds stay distinct", () => {
    expect(FRESH_DAYS).toBeLessThan(STALE_DAYS);
  });

  it("includes items last confirmed more than FRESH_DAYS ago; excludes fresh confirms", () => {
    const overdue = makeItem({ verified_at: iso((FRESH_DAYS + 1) * DAY_MS) });
    const justChecked = makeItem({ verified_at: iso(47 * 60_000) }); // 47 minutes ago
    const doc = makeDoc({ items: [overdue, justChecked] });
    expect(needsCheck(doc, NOW)).toEqual([overdue]);
  });

  it("a freshly counted pantry produces an EMPTY list, not a manufactured stalest-10", () => {
    const items = Array.from({ length: 12 }, () => makeItem({ verified_at: iso(1 * DAY_MS) }));
    expect(needsCheck(makeDoc({ items }), NOW)).toEqual([]);
  });

  it("boundary: confirmed exactly FRESH_DAYS ago is still fresh (strictly more than, matching staleCount)", () => {
    const atBoundary = makeItem({ verified_at: iso(FRESH_DAYS * DAY_MS) });
    const justOver = makeItem({ verified_at: iso(FRESH_DAYS * DAY_MS + 1) });
    const doc = makeDoc({ items: [atBoundary, justOver] });
    expect(needsCheck(doc, NOW)).toEqual([justOver]);
  });

  it("never-verified items fall back to created_at — a fresh seed is trusted for its first week", () => {
    const seededToday = makeItem({ verified_at: null, created_at: iso(0) });
    const seededLongAgo = makeItem({ verified_at: null, created_at: iso((FRESH_DAYS + 2) * DAY_MS) });
    const doc = makeDoc({ items: [seededToday, seededLongAgo] });
    expect(needsCheck(doc, NOW)).toEqual([seededLongAgo]);
  });

  it("verified_at wins over an old created_at (same clock as staleCount)", () => {
    const doc = makeDoc({
      items: [makeItem({ created_at: iso(100 * DAY_MS), verified_at: iso(1 * DAY_MS) })],
    });
    expect(needsCheck(doc, NOW)).toEqual([]);
  });

  it("orders stalest first: never-verified (old created_at) before dated verified_at ascending", () => {
    const old = makeItem({ verified_at: iso(20 * DAY_MS) });
    const older = makeItem({ verified_at: iso(25 * DAY_MS) });
    const never = makeItem({ verified_at: null, created_at: iso(50 * DAY_MS) });
    const doc = makeDoc({ items: [old, never, older] });
    expect(needsCheck(doc, NOW)).toEqual([never, older, old]);
  });

  it("filters to one location when asked and ignores soft-deleted items", () => {
    const pantry = makeItem({ location: "pantry", verified_at: iso(10 * DAY_MS) });
    const fridge = makeItem({ location: "fridge", verified_at: iso(10 * DAY_MS) });
    const deleted = makeItem({ location: "pantry", verified_at: iso(10 * DAY_MS), deleted_at: NOW });
    const doc = makeDoc({ items: [pantry, fridge, deleted] });
    expect(needsCheck(doc, NOW, "pantry")).toEqual([pantry]);
    expect(needsCheck(doc, NOW)).toEqual([pantry, fridge]);
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

describe("backupAgeDays", () => {
  const iso = (msBeforeNow: number): string => new Date(Date.parse(NOW) - msBeforeNow).toISOString();

  it("measures from last_export_at when set", () => {
    const doc = makeDoc({ items: [makeItem()] });
    doc.settings.last_export_at = iso(15 * DAY_MS);
    expect(backupAgeDays(doc, NOW)).toBe(15);
  });

  it("never exported: falls back to the EARLIEST record across items, extras, and events", () => {
    const doc = makeDoc({
      items: [makeItem({ created_at: iso(3 * DAY_MS) })],
      extras: [makeExtra({ created_at: iso(5 * DAY_MS) })],
      events: [makeEvent({ at: iso(9 * DAY_MS) })],
    });
    doc.settings.last_export_at = null;
    expect(backupAgeDays(doc, NOW)).toBe(9);
  });

  it("empty doc has no reference and reads 0", () => {
    const doc = makeDoc();
    doc.settings.last_export_at = null;
    expect(backupAgeDays(doc, NOW)).toBe(0);
  });
});

describe("purchaseRhythm", () => {
  it("zero purchases: count 0, no lastAt, no average", () => {
    const item = makeItem();
    const doc = makeDoc({
      items: [item],
      events: [makeEvent({ item_id: item.id, kind: "use", at: "2026-08-02T00:00:00.000Z" })],
    });
    expect(purchaseRhythm(doc, item.id, NOW)).toEqual({ count: 0, lastAt: null, avgDays: null });
  });

  it("one purchase: lastAt set, avgDays null (no gap exists yet)", () => {
    const item = makeItem();
    const at = "2026-08-10T09:00:00.000Z";
    const doc = makeDoc({
      items: [item],
      events: [makeEvent({ item_id: item.id, kind: "purchase", at })],
    });
    expect(purchaseRhythm(doc, item.id, NOW)).toEqual({ count: 1, lastAt: at, avgDays: null });
  });

  it("several purchases: avgDays is the mean successive gap, lastAt the newest", () => {
    // Purchases on Aug 1, 11, 15 (deliberately unsorted in the event log):
    // gaps of 10 and 4 days -> mean 7.
    const item = makeItem();
    const doc = makeDoc({
      items: [item],
      events: [
        makeEvent({ item_id: item.id, kind: "purchase", at: "2026-08-15T00:00:00.000Z" }),
        makeEvent({ item_id: item.id, kind: "purchase", at: "2026-08-01T00:00:00.000Z" }),
        makeEvent({ item_id: item.id, kind: "purchase", at: "2026-08-11T00:00:00.000Z" }),
      ],
    });
    const rhythm = purchaseRhythm(doc, item.id, NOW);
    expect(rhythm.count).toBe(3);
    expect(rhythm.lastAt).toBe("2026-08-15T00:00:00.000Z");
    expect(rhythm.avgDays).toBe(7);
  });

  it("keeps fractional averages exact — rounding is the call site's job", () => {
    // 36 hours apart -> 1.5 days.
    const item = makeItem();
    const doc = makeDoc({
      items: [item],
      events: [
        makeEvent({ item_id: item.id, kind: "purchase", at: "2026-08-01T00:00:00.000Z" }),
        makeEvent({ item_id: item.id, kind: "purchase", at: "2026-08-02T12:00:00.000Z" }),
      ],
    });
    expect(purchaseRhythm(doc, item.id, NOW).avgDays).toBe(1.5);
  });

  it("attributes a merged loser's purchases to the survivor (and none to the loser)", () => {
    const survivor = makeItem();
    const loser = makeItem({ merged_into: survivor.id, deleted_at: NOW });
    const doc = makeDoc({
      items: [survivor, loser],
      events: [
        // Loser events keep their original item_id (R2) and reach the
        // survivor's rhythm through the merge chain only.
        makeEvent({ item_id: loser.id, kind: "purchase", at: "2026-08-01T00:00:00.000Z" }),
        makeEvent({ item_id: survivor.id, kind: "purchase", at: "2026-08-08T00:00:00.000Z" }),
      ],
    });
    expect(purchaseRhythm(doc, survivor.id, NOW)).toEqual({
      count: 2,
      lastAt: "2026-08-08T00:00:00.000Z",
      avgDays: 7,
    });
    expect(purchaseRhythm(doc, loser.id, NOW)).toEqual({
      count: 0,
      lastAt: null,
      avgDays: null,
    });
  });

  it("ignores every non-purchase kind", () => {
    const item = makeItem();
    const doc = makeDoc({
      items: [item],
      events: [
        makeEvent({ item_id: item.id, kind: "add", at: "2026-08-01T00:00:00.000Z" }),
        makeEvent({ item_id: item.id, kind: "recount", at: "2026-08-02T00:00:00.000Z" }),
        makeEvent({ item_id: item.id, kind: "purchase", at: "2026-08-03T00:00:00.000Z" }),
        makeEvent({ item_id: item.id, kind: "use", at: "2026-08-04T00:00:00.000Z" }),
        makeEvent({ item_id: item.id, kind: "create", at: "2026-07-30T00:00:00.000Z" }),
      ],
    });
    expect(purchaseRhythm(doc, item.id, NOW)).toEqual({
      count: 1,
      lastAt: "2026-08-03T00:00:00.000Z",
      avgDays: null,
    });
  });
});

describe("inCart is reversal-aware", () => {
  it("a Put back followed by a later flag-clear does not resurface the item in the cart", () => {
    const adapter = memoryAdapter();
    const store = createStore(adapter);
    const item = store.createItem({ name: "Salsa", quantity: 1 });
    store.flagManual(item.id);
    store.purchase(item.id, 1);
    store.unpurchase(item.id); // reversal recount, flag re-raised
    store.clearFlag(item.id); // user decides they don't need it after all
    const list = shoppingList(store.getDoc(), new Date().toISOString());
    expect(list.inCart.map((i) => i.name)).toEqual([]); // nothing came home
    expect(list.toBuy.map((i) => i.name)).toEqual([]);
  });

  it("an undone purchase (note 'put back') stays out of the cart after flag-clear", () => {
    const adapter = memoryAdapter();
    const store = createStore(adapter);
    const item = store.createItem({ name: "Jelly", quantity: 1 });
    store.flagManual(item.id);
    const before = { flagged: item.flagged, flag_source: item.flag_source, flagged_at: item.flagged_at };
    store.purchase(item.id, 1);
    store.undoQuantity(item.id, 1, before, { note: "put back" });
    store.clearFlag(item.id);
    const list = shoppingList(store.getDoc(), new Date().toISOString());
    expect(list.inCart).toEqual([]);
  });

  it("an unreversed purchase still shows in the cart once its flag is gone", () => {
    const adapter = memoryAdapter();
    const store = createStore(adapter);
    const item = store.createItem({ name: "Bread", quantity: 0 });
    store.flagManual(item.id);
    store.purchase(item.id, 2); // bought: flag clears, quantity 2
    const list = shoppingList(store.getDoc(), new Date().toISOString());
    expect(list.inCart.map((i) => i.name)).toEqual(["Bread"]);
  });
});

describe("purchaseRhythm ignores reversed check-offs", () => {
  it("purchase + put-back counts zero", () => {
    const adapter = memoryAdapter();
    const store = createStore(adapter);
    const item = store.createItem({ name: "Jam", quantity: 0 });
    store.flagManual(item.id);
    store.purchase(item.id, 1);
    store.unpurchase(item.id);
    const r = purchaseRhythm(store.getDoc(), item.id, new Date().toISOString());
    expect(r.count).toBe(0);
    expect(r.lastAt).toBeNull();
  });

  it("purchase, put-back, purchase counts one — the surviving purchase", () => {
    const adapter = memoryAdapter();
    const store = createStore(adapter);
    const item = store.createItem({ name: "Tea", quantity: 0 });
    store.flagManual(item.id);
    store.purchase(item.id, 1);
    store.unpurchase(item.id);
    store.purchase(item.id, 2);
    const doc = store.getDoc();
    const r = purchaseRhythm(doc, item.id, new Date().toISOString());
    expect(r.count).toBe(1);
    const lastPurchase = [...doc.events].reverse().find((e) => e.kind === "purchase");
    expect(r.lastAt).toBe(lastPurchase?.at ?? null);
    expect(r.avgDays).toBeNull();
  });
});
