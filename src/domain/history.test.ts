import { describe, expect, it } from "vitest";
import type { HistoryEvent } from "../types";
import { buildHistoryRows, sortEventsNewestFirst } from "./history";

const NOW = "2026-08-27T12:00:00.000Z";

let seq = 0;

function ev(over: Partial<HistoryEvent> = {}): HistoryEvent {
  seq++;
  return {
    id: `e${seq}`,
    item_id: "item-1",
    at: "2026-08-20T10:00:00.000Z",
    kind: "recount",
    qty_before: 2,
    qty_after: 2,
    unit: "jar",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Verbs — one event in, one sentence out
// ---------------------------------------------------------------------------

describe("buildHistoryRows — every verb speaks a sentence", () => {
  const cases: Array<{
    name: string;
    over: Partial<HistoryEvent>;
    label: string;
    sub?: string | null;
    muted?: boolean;
  }> = [
    {
      name: "purchase",
      over: { kind: "purchase", qty_before: 1, qty_after: 3 },
      label: "Bought 2 — now 3 jars",
    },
    {
      name: "use",
      over: { kind: "use", qty_before: 3, qty_after: 2 },
      label: "Used 1 — now 2 jars",
    },
    {
      name: "add",
      over: { kind: "add", qty_before: 2, qty_after: 3 },
      label: "Added 1 — now 3 jars",
    },
    {
      name: "recount to the same number is a verification",
      over: { kind: "recount", qty_before: 2, qty_after: 2 },
      label: "Confirmed 2 jars",
    },
    {
      // The old rendering's cryptic "= 0 → 0 jars": confirming an out shelf
      // IS an observation, not noise.
      name: "recount 0 -> 0 is Confirmed, not Counted",
      over: { kind: "recount", qty_before: 0, qty_after: 0 },
      label: "Confirmed 0 jars",
    },
    {
      name: "recount to a different number",
      over: { kind: "recount", qty_before: 3, qty_after: 2 },
      label: "Counted 2 jars",
      sub: "was 3",
    },
    {
      name: "create with starting stock",
      over: { kind: "create", qty_before: 0, qty_after: 2 },
      label: "Added to the pantry",
      sub: "with 2 jars",
    },
    {
      name: "create with no stock has no sub line",
      over: { kind: "create", qty_before: 0, qty_after: 0 },
      label: "Added to the pantry",
    },
    { name: "delete", over: { kind: "delete", qty_before: 2, qty_after: 2 }, label: "Deleted" },
    { name: "restore", over: { kind: "restore", qty_before: 2, qty_after: 2 }, label: "Restored" },
    {
      name: "unit_change shows qty_before in unit_before",
      over: { kind: "unit_change", qty_before: 2, qty_after: 1000, unit: "g", unit_before: "bag" },
      label: "Unit changed — 2 bags → 1000 g",
    },
    {
      // Package resize/removal: the unit string never moved (no unit_before),
      // so the note carries the story as the sub line.
      name: "unit_change without unit_before keeps the note as sub",
      over: {
        kind: "unit_change",
        qty_before: 2,
        qty_after: 2,
        note: "package 1000 g -> none",
      },
      label: "Unit changed — 2 jars → 2 jars",
      sub: "package 1000 g -> none",
    },
    {
      name: "merge with a note names the absorbed item",
      over: { kind: "merge", qty_before: 2, qty_after: 3, note: "paprika" },
      label: "Absorbed “paprika”",
    },
    {
      name: "merge without a note",
      over: { kind: "merge", qty_before: 2, qty_after: 3 },
      label: "Merged",
    },
    { name: "import", over: { kind: "import", qty_before: 2, qty_after: 2 }, label: "Imported" },
    {
      // Count-family units render bare numbers (fmtQtyUnit's rule).
      name: "count units stay bare",
      over: { kind: "purchase", qty_before: 1, qty_after: 3, unit: "count" },
      label: "Bought 2 — now 3",
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const e = ev(c.over);
      expect(buildHistoryRows([e], NOW)).toEqual([
        { ids: [e.id], label: c.label, sub: c.sub ?? null, at: e.at, muted: c.muted ?? false },
      ]);
    });
  }
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

describe("buildHistoryRows — ordering", () => {
  it("sorts rows newest first regardless of input order", () => {
    const older = ev({ kind: "use", at: "2026-08-20T10:00:00.000Z", qty_before: 3, qty_after: 2 });
    const newer = ev({ kind: "add", at: "2026-08-21T10:00:00.000Z", qty_before: 2, qty_after: 3 });
    const rows = buildHistoryRows([older, newer], NOW);
    expect(rows.map((r) => r.ids)).toEqual([[newer.id], [older.id]]);
  });

  it("breaks same-instant ties by input (append) position, later = newer", () => {
    const first = ev({ kind: "add", qty_before: 1, qty_after: 2 });
    const second = ev({ kind: "use", qty_before: 2, qty_after: 1 }); // same default `at`
    const sorted = sortEventsNewestFirst([first, second]);
    expect(sorted.map((e) => e.id)).toEqual([second.id, first.id]);
  });
});

// ---------------------------------------------------------------------------
// Reversal pairing
// ---------------------------------------------------------------------------

describe("buildHistoryRows — put-back reversals", () => {
  it("collapses a purchase + its put-back into ONE muted row at the reversal's instant", () => {
    const purchase = ev({
      kind: "purchase",
      at: "2026-08-20T10:00:00.000Z",
      qty_before: 2,
      qty_after: 3,
    });
    const reversal = ev({
      kind: "recount",
      note: "put back",
      at: "2026-08-20T10:05:00.000Z",
      qty_before: 3,
      qty_after: 2,
    });
    const rows = buildHistoryRows([reversal, purchase], NOW);
    expect(rows).toEqual([
      {
        ids: [purchase.id, reversal.id],
        label: "Bought 1, then put back",
        sub: null,
        at: reversal.at,
        muted: true,
      },
    ]);
  });

  it("pairs a same-millisecond purchase + put-back (append order decides)", () => {
    const at = "2026-08-20T10:00:00.000Z";
    const purchase = ev({ kind: "purchase", at, qty_before: 0, qty_after: 2 });
    const reversal = ev({ kind: "recount", note: "put back", at, qty_before: 2, qty_after: 0 });
    // Input in append order, as doc.events (and historyFor's stable sort
    // within a tie) would hand it over.
    const rows = buildHistoryRows([purchase, reversal], NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ids).toEqual([purchase.id, reversal.id]);
    expect(rows[0]?.label).toBe("Bought 2, then put back");
    expect(rows[0]?.muted).toBe(true);
  });

  it("claims the NEAREST older unpaired purchase; earlier purchases keep their own rows", () => {
    const boughtLastWeek = ev({
      kind: "purchase",
      at: "2026-08-13T10:00:00.000Z",
      qty_before: 0,
      qty_after: 1,
    });
    const boughtToday = ev({
      kind: "purchase",
      at: "2026-08-20T10:00:00.000Z",
      qty_before: 1,
      qty_after: 2,
    });
    const reversal = ev({
      kind: "recount",
      note: "put back",
      at: "2026-08-20T10:05:00.000Z",
      qty_before: 2,
      qty_after: 1,
    });
    const rows = buildHistoryRows([reversal, boughtToday, boughtLastWeek], NOW);
    expect(rows.map((r) => r.label)).toEqual([
      "Bought 1, then put back",
      "Bought 1 — now 1 jar",
    ]);
    expect(rows[0]?.ids).toEqual([boughtToday.id, reversal.id]);
  });

  it("an unpaired put-back (purchase pruned or deleted) stands alone, muted", () => {
    const reversal = ev({
      kind: "recount",
      note: "put back",
      qty_before: 1,
      qty_after: 0,
    });
    expect(buildHistoryRows([reversal], NOW)).toEqual([
      { ids: [reversal.id], label: "Put back — now 0 jars", sub: null, at: reversal.at, muted: true },
    ]);
  });

  it("never pairs across items (merged histories interleave two items' events)", () => {
    const otherItemsPurchase = ev({
      kind: "purchase",
      item_id: "item-2",
      at: "2026-08-20T09:00:00.000Z",
      qty_before: 0,
      qty_after: 1,
    });
    const reversal = ev({
      kind: "recount",
      note: "put back",
      item_id: "item-1",
      at: "2026-08-20T10:00:00.000Z",
      qty_before: 1,
      qty_after: 0,
    });
    const rows = buildHistoryRows([reversal, otherItemsPurchase], NOW);
    expect(rows.map((r) => r.label)).toEqual([
      "Put back — now 0 jars",
      "Bought 1 — now 1 jar",
    ]);
  });

  it("two reversals each claim their own purchase", () => {
    const p1 = ev({ kind: "purchase", at: "2026-08-20T10:00:00.000Z", qty_before: 0, qty_after: 1 });
    const r1 = ev({
      kind: "recount",
      note: "put back",
      at: "2026-08-20T10:01:00.000Z",
      qty_before: 1,
      qty_after: 0,
    });
    const p2 = ev({ kind: "purchase", at: "2026-08-20T11:00:00.000Z", qty_before: 0, qty_after: 1 });
    const r2 = ev({
      kind: "recount",
      note: "put back",
      at: "2026-08-20T11:01:00.000Z",
      qty_before: 1,
      qty_after: 0,
    });
    const rows = buildHistoryRows([p1, r1, p2, r2], NOW);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.ids).toEqual([p2.id, r2.id]);
    expect(rows[1]?.ids).toEqual([p1.id, r1.id]);
  });
});
