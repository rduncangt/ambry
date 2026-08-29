import { describe, expect, it } from "vitest";
import {
  RUNG_LABELS,
  fmtAge,
  fmtLevel,
  fmtQty,
  fmtQtyBoth,
  fmtQtyUnit,
  ladderLabel,
  parseDec,
} from "./format";
import type { Item, LadderRung } from "../types";

/** Minimal valid Item; tests override the fields they exercise. */
function makeItem(over: Partial<Item> = {}): Item {
  return {
    id: "00000000-0000-0000-0000-000000000002",
    name: "flour",
    aliases: [],
    notes: "",
    category: null,
    location: null,
    unit: "bag",
    quantity: 1,
    package_size: { amount: 1000, unit: "g" },
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
    ...over,
  };
}

describe("fmtQty", () => {
  const cases: Array<[number, string]> = [
    [0.5, "0.5"],
    [2, "2"],
    [0.432, "0.432"],
    [2.5, "2.5"],
    [0, "0"],
    // no trailing zeros
    [2.5, "2.5"],
    [1.1, "1.1"],
    // display rounding kills float noise (PLAN.md §1.5)
    [431.99999999, "432"],
    [432.00000000000006, "432"],
    [0.30000000000000004, "0.3"],
    // trims to <= 3 decimals by rounding
    [1.2344, "1.234"],
    [1.9999, "2"],
    [0.0004, "0"],
    // negative zero never leaks
    [-0.0001, "0"],
  ];
  it.each(cases)("fmtQty(%f) -> %j", (n, want) => {
    expect(fmtQty(n)).toBe(want);
  });
});

describe("fmtQtyUnit", () => {
  const cases: Array<[number, string, string]> = [
    // pluralization
    [2, "bag", "2 bags"],
    [1, "bag", "1 bag"],
    [0.5, "bag", "0.5 bags"],
    [0, "bag", "0 bags"],
    // irregular plurals beat the suffix tiers (the screenshot bug: "2 loafs")
    [2, "loaf", "2 loaves"],
    [1, "loaf", "1 loaf"],
    [2, "Loaf", "2 Loaves"],
    // sibilant-ish endings take -es (the screenshot bug: "0 bunchs")
    [0, "bunch", "0 bunches"],
    [2, "box", "2 boxes"],
    [3, "dish", "3 dishes"],
    [1, "bunch", "1 bunch"],
    // already ends in "s": never doubled
    [2, "oats", "2 oats"],
    // metric-ish symbols stay bare of the plural
    [2, "oz", "2 oz"],
    [1, "oz", "1 oz"],
    [2, "Oz", "2 Oz"],
    [432, "g", "432 g"],
    [2, "kg", "2 kg"],
    [500, "ml", "500 ml"],
    [2, "l", "2 l"],
    // "count" renders as a bare number, case-insensitively
    [3, "count", "3"],
    [1, "count", "1"],
    [3, "Count", "3"],
    // "each"/"ea" are count-family too — never "2 eaches"
    [2, "each", "2"],
    [1, "each", "1"],
    [2, "ea", "2"],
    [1, "ea", "1"],
    [2, "Each", "2"],
    [1, "Each", "1"],
    // non-alphabetic units don't pluralize
    [2, "fl oz", "2 fl oz"],
    // empty unit renders bare
    [2, "", "2"],
    // pluralization follows the DISPLAYED value: 1.0001 shows as "1"
    [1.0001, "bag", "1 bag"],
  ];
  it.each(cases)("fmtQtyUnit(%f, %j) -> %j", (qty, unit, want) => {
    expect(fmtQtyUnit(qty, unit)).toBe(want);
  });
});

describe("ladderLabel", () => {
  const cases: Array<[number, LadderRung, string]> = [
    [1, "full", "Full"],
    [0.5, "half", "Half"],
    [0.2, "low", "Low"],
    [0, "out", "Out"],
    // qty > 1 renders the surplus, fmtQty'd (fractional N included)
    [2, "full", "Full +1"],
    [3, "full", "Full +2"],
    [1.5, "full", "Full +0.5"],
    [2.25, "full", "Full +1.25"],
  ];
  it.each(cases)("ladderLabel(%f, %s) -> %j", (qty, rung, want) => {
    expect(ladderLabel(qty, rung)).toBe(want);
  });
});

describe("fmtQtyBoth", () => {
  it("shows both sides when package_size exists", () => {
    const item = makeItem({ quantity: 0.4 });
    expect(fmtQtyBoth(item)).toBe("0.4 bags (400 g)");
  });

  it("rounds the derived side at display time: 0.432 bags never prints 431.999... g", () => {
    // 0.432 * 1000 === 432.00000000000006 in floats
    const item = makeItem({ quantity: 0.432 });
    expect(fmtQtyBoth(item)).toBe("0.432 bags (432 g)");
  });

  it("falls back to the single-sided form without a package_size", () => {
    expect(fmtQtyBoth(makeItem({ quantity: 2, package_size: null }))).toBe("2 bags");
  });

  it("pluralizes a countable precise side", () => {
    const item = makeItem({ unit: "box", quantity: 2, package_size: { amount: 8, unit: "stick" } });
    // naive "+s" on both sides
    expect(fmtQtyBoth(item)).toBe("2 boxes (16 sticks)");
  });

  it("works after a unit change left an inverted package (g -> bag)", () => {
    const item = makeItem({ unit: "g", quantity: 432, package_size: { amount: 0.001, unit: "bag" } });
    expect(fmtQtyBoth(item)).toBe("432 g (0.432 bags)");
  });

  it("renders a bare count with no package as just the number", () => {
    expect(fmtQtyBoth(makeItem({ unit: "count", quantity: 3, package_size: null }))).toBe("3");
  });
});

describe("RUNG_LABELS", () => {
  it("maps every rung to its display word", () => {
    expect(RUNG_LABELS).toEqual({ full: "Full", half: "Half", low: "Low", out: "Out" });
  });

  it("agrees with ladderLabel for single-container quantities", () => {
    // The exported map and the label function must never drift apart.
    expect(ladderLabel(1, "full")).toBe(RUNG_LABELS.full);
    expect(ladderLabel(0, "out")).toBe(RUNG_LABELS.out);
  });
});

describe("fmtLevel", () => {
  it("renders a ladder item as its rung label from the quantity", () => {
    expect(fmtLevel(makeItem({ display_mode: "ladder", quantity: 1 }))).toBe("Full");
    expect(fmtLevel(makeItem({ display_mode: "ladder", quantity: 0.5 }))).toBe("Half");
    expect(fmtLevel(makeItem({ display_mode: "ladder", quantity: 0.2 }))).toBe("Low");
    // A zero only reads "Out" once a human verified it; unverified is "?".
    expect(
      fmtLevel(makeItem({ display_mode: "ladder", quantity: 0, verified_at: "2026-01-02T00:00:00.000Z" })),
    ).toBe("Out");
  });

  it("keeps the multi-container surplus visible on ladder items", () => {
    expect(fmtLevel(makeItem({ display_mode: "ladder", quantity: 3 }))).toBe("Full +2");
  });

  it("renders a numeric item with both sides via fmtQtyBoth", () => {
    expect(fmtLevel(makeItem({ display_mode: "number", quantity: 0.4 }))).toBe(
      "0.4 bags (400 g)",
    );
    expect(
      fmtLevel(makeItem({ display_mode: "number", quantity: 2, package_size: null })),
    ).toBe("2 bags");
  });
});

describe("parseDec", () => {
  const cases: Array<[string, number | null]> = [
    ["2", 2],
    ["0.5", 0.5],
    ["0", 0],
    ["  1.25  ", 1.25],
    // decimal comma is a decimal point
    ["0,5", 0.5],
    ["  2,25 ", 2.25],
    // empty and garbage
    ["", null],
    ["   ", null],
    ["abc", null],
    ["1.2.3", null],
    // quantities are never negative
    ["-1", null],
    ["-0.5", null],
    // non-finite never leaks into quantities
    ["Infinity", null],
    ["-Infinity", null],
    ["NaN", null],
  ];
  it.each(cases)("parseDec(%j) -> %j", (text, want) => {
    expect(parseDec(text)).toBe(want);
  });
});

describe("fmtAge", () => {
  const now = "2026-08-27T12:00:00.000Z";
  const cases: Array<[string | null, string]> = [
    [null, "never"],
    // under a minute: just now
    [now, "just now"],
    ["2026-08-27T11:59:30.000Z", "just now"],
    ["2026-08-27T11:59:00.001Z", "just now"],
    // minutes: 1m up to 59m
    ["2026-08-27T11:59:00.000Z", "1m ago"],
    ["2026-08-27T11:30:00.000Z", "30m ago"],
    ["2026-08-27T11:01:00.000Z", "59m ago"],
    // hours: 1h up to 23h
    ["2026-08-27T11:00:00.000Z", "1h ago"],
    ["2026-08-26T13:00:00.000Z", "23h ago"],
    ["2026-08-26T12:30:00.000Z", "23h ago"],
    // days from 24h on
    ["2026-08-26T12:00:00.000Z", "1d ago"],
    ["2026-08-24T12:00:00.000Z", "3d ago"],
    ["2026-07-18T12:00:00.000Z", "40d ago"],
    // clock skew: a future timestamp never renders a negative age
    ["2026-08-27T12:05:00.000Z", "just now"],
  ];
  it.each(cases)("fmtAge(%j) -> %j", (iso, want) => {
    expect(fmtAge(iso, now)).toBe(want);
  });

  it("treats an unparseable timestamp as just now rather than NaN", () => {
    expect(fmtAge("not-a-date", now)).toBe("just now");
  });
});

describe("fmtLevel refuses to call an unverified zero a shortage", () => {
  const base = {
    id: "x", name: "X", aliases: [], notes: "", category: null, location: null,
    package_size: null, threshold: null, flagged: false, flag_source: null,
    flagged_at: null, restock_amount: 1, never_prompt: false, expiry: null,
    barcodes: [], merged_into: null, created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z", deleted_at: null,
  };
  it("uncounted number item reads ?", () => {
    expect(fmtLevel({ ...base, unit: "bag", quantity: 0, display_mode: "number", verified_at: null } as Item)).toBe("?");
  });
  it("uncounted ladder item reads ?", () => {
    expect(fmtLevel({ ...base, unit: "jar", quantity: 0, display_mode: "ladder", verified_at: null } as Item)).toBe("?");
  });
  it("verified zero still reads Out / 0", () => {
    expect(fmtLevel({ ...base, unit: "jar", quantity: 0, display_mode: "ladder", verified_at: "2026-01-02T00:00:00.000Z" } as Item)).toBe("Out");
    expect(fmtLevel({ ...base, unit: "bag", quantity: 0, display_mode: "number", verified_at: "2026-01-02T00:00:00.000Z" } as Item)).toBe("0 bags");
  });
});
