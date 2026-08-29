import { describe, expect, it } from "vitest";
import type { AmbryDoc, HistoryEvent, ShoppingExtra } from "../types";
import { pruneDoc } from "./prune";

const NOW = "2026-08-27T12:00:00.000Z";
const DAY_MS = 86_400_000;

/** ISO timestamp exactly `days` days before NOW, shifted `extraMs` earlier. */
function daysAgo(days: number, extraMs = 0): string {
  return new Date(Date.parse(NOW) - days * DAY_MS - extraMs).toISOString();
}

let seq = 0;
function makeEvent(overrides: Partial<HistoryEvent> = {}): HistoryEvent {
  return {
    id: `ev-${seq++}`,
    item_id: "item-a",
    at: daysAgo(1),
    kind: "use",
    qty_before: 2,
    qty_after: 1,
    unit: "count",
    ...overrides,
  };
}

function makeExtra(overrides: Partial<ShoppingExtra> = {}): ShoppingExtra {
  return {
    id: `ex-${seq++}`,
    text: "birthday candles",
    created_at: daysAgo(30),
    updated_at: daysAgo(30),
    deleted_at: null,
    ...overrides,
  };
}

function makeDoc(overrides: Partial<AmbryDoc> = {}): AmbryDoc {
  return {
    schema_version: 1,
    items: [],
    events: [],
    extras: [],
    settings: {
      retention_days: 365,
      last_export_at: null,
      writes_since_export: 0,
      last_trip_ended_at: null,
      declared_locations: [],
      device_label: "test",
    },
    ...overrides,
  };
}

describe("pruneDoc — events", () => {
  it("keeps everything inside the retention window", () => {
    const doc = makeDoc({ events: [makeEvent({ at: daysAgo(0) }), makeEvent({ at: daysAgo(364) })] });
    const res = pruneDoc(doc, NOW);
    expect(res.doc).toBe(doc); // untouched -> same reference
    expect(res.eventsRemoved).toBe(0);
    expect(res.extrasRemoved).toBe(0);
  });

  it("keeps an out-of-window event when it is the item's single most recent", () => {
    const only = makeEvent({ at: daysAgo(400) });
    const res = pruneDoc(makeDoc({ events: [only] }), NOW);
    expect(res.doc.events).toEqual([only]);
    expect(res.eventsRemoved).toBe(0);
  });

  it("prunes an old event once the same item has a newer one", () => {
    const old = makeEvent({ at: daysAgo(400) });
    const fresh = makeEvent({ at: daysAgo(1) });
    const res = pruneDoc(makeDoc({ events: [old, fresh] }), NOW);
    expect(res.doc.events).toEqual([fresh]);
    expect(res.eventsRemoved).toBe(1);
  });

  it("keeps only the most recent of several out-of-window events", () => {
    const oldest = makeEvent({ at: daysAgo(500) });
    const middle = makeEvent({ at: daysAgo(450) });
    const newestOld = makeEvent({ at: daysAgo(400) });
    const res = pruneDoc(makeDoc({ events: [oldest, middle, newestOld] }), NOW);
    expect(res.doc.events).toEqual([newestOld]);
    expect(res.eventsRemoved).toBe(2);
  });

  it("picks the most recent by timestamp, not by array position", () => {
    // Newer event stored EARLIER in the array must still be the survivor.
    const newerFirst = makeEvent({ at: daysAgo(380) });
    const olderSecond = makeEvent({ at: daysAgo(500) });
    const res = pruneDoc(makeDoc({ events: [newerFirst, olderSecond] }), NOW);
    expect(res.doc.events).toEqual([newerFirst]);
    expect(res.eventsRemoved).toBe(1);
  });

  it("breaks an exact timestamp tie toward the later array position", () => {
    // Append-only log: on equal `at`, the later index is the later write.
    const at = daysAgo(400);
    const first = makeEvent({ at });
    const second = makeEvent({ at });
    const res = pruneDoc(makeDoc({ events: [first, second] }), NOW);
    expect(res.doc.events).toEqual([second]);
    expect(res.eventsRemoved).toBe(1);
  });

  it("applies keep-latest per item independently", () => {
    const aOld = makeEvent({ item_id: "a", at: daysAgo(400) });
    const bOld1 = makeEvent({ item_id: "b", at: daysAgo(500) });
    const bOld2 = makeEvent({ item_id: "b", at: daysAgo(400) });
    const cFresh = makeEvent({ item_id: "c", at: daysAgo(2) });
    const res = pruneDoc(makeDoc({ events: [aOld, bOld1, bOld2, cFresh] }), NOW);
    expect(res.doc.events).toEqual([aOld, bOld2, cFresh]);
    expect(res.eventsRemoved).toBe(1);
  });

  it("protects the latest event of soft-deleted, merged, and unknown items alike", () => {
    // The rule keys off event.item_id, not the items list — tombstoned and
    // merged-away items (and even ids no longer present at all) keep context.
    const doc = makeDoc({
      items: [],
      events: [
        makeEvent({ item_id: "tombstoned", at: daysAgo(500) }),
        makeEvent({ item_id: "tombstoned", at: daysAgo(400) }),
        makeEvent({ item_id: "merged-away", at: daysAgo(450) }),
      ],
    });
    const res = pruneDoc(doc, NOW);
    expect(res.doc.events.map((e) => e.item_id)).toEqual(["tombstoned", "merged-away"]);
    expect(res.eventsRemoved).toBe(1);
  });

  it("treats the boundary as strict: exactly retention_days old is kept", () => {
    const doc = makeDoc({
      events: [
        makeEvent({ at: daysAgo(10) }), // exactly at the cutoff — not "older than"
        makeEvent({ at: daysAgo(1) }),
      ],
      settings: { retention_days: 10, last_export_at: null, writes_since_export: 0, last_trip_ended_at: null, declared_locations: [], device_label: "test" },
    });
    const res = pruneDoc(doc, NOW);
    expect(res.eventsRemoved).toBe(0);
    expect(res.doc).toBe(doc);
  });

  it("prunes one millisecond past the boundary", () => {
    const past = makeEvent({ at: daysAgo(10, 1) });
    const fresh = makeEvent({ at: daysAgo(1) });
    const doc = makeDoc({
      events: [past, fresh],
      settings: { retention_days: 10, last_export_at: null, writes_since_export: 0, last_trip_ended_at: null, declared_locations: [], device_label: "test" },
    });
    const res = pruneDoc(doc, NOW);
    expect(res.doc.events).toEqual([fresh]);
    expect(res.eventsRemoved).toBe(1);
  });
});

describe("pruneDoc — extras", () => {
  it("never prunes live extras, however old", () => {
    const ancient = makeExtra({ created_at: daysAgo(1000), updated_at: daysAgo(1000) });
    const doc = makeDoc({ extras: [ancient] });
    const res = pruneDoc(doc, NOW);
    expect(res.doc).toBe(doc);
    expect(res.extrasRemoved).toBe(0);
  });

  it("hard-prunes extras checked off longer than EXTRA_PRUNE_DAYS ago", () => {
    const gone = makeExtra({ deleted_at: daysAgo(8) });
    const kept = makeExtra({ deleted_at: daysAgo(6) });
    const res = pruneDoc(makeDoc({ extras: [gone, kept] }), NOW);
    expect(res.doc.extras).toEqual([kept]);
    expect(res.extrasRemoved).toBe(1);
  });

  it("treats the extras boundary as strict: exactly 7 days is kept", () => {
    const atBoundary = makeExtra({ deleted_at: daysAgo(7) });
    const past = makeExtra({ deleted_at: daysAgo(7, 1) });
    const res = pruneDoc(makeDoc({ extras: [atBoundary, past] }), NOW);
    expect(res.doc.extras).toEqual([atBoundary]);
    expect(res.extrasRemoved).toBe(1);
  });
});

describe("pruneDoc — purity and result shape", () => {
  it("returns the same doc reference when nothing changed", () => {
    const doc = makeDoc({
      events: [makeEvent({ at: daysAgo(3) })],
      extras: [makeExtra({ deleted_at: daysAgo(2) })],
    });
    const res = pruneDoc(doc, NOW);
    expect(res.doc).toBe(doc);
  });

  it("returns a new doc without mutating the input", () => {
    const old = makeEvent({ at: daysAgo(400) });
    const fresh = makeEvent({ at: daysAgo(1) });
    const gone = makeExtra({ deleted_at: daysAgo(30) });
    const doc = makeDoc({ events: [old, fresh], extras: [gone] });
    const res = pruneDoc(doc, NOW);
    expect(res.doc).not.toBe(doc);
    // Input untouched — pruning must never mutate the loaded document.
    expect(doc.events).toEqual([old, fresh]);
    expect(doc.extras).toEqual([gone]);
    expect(res.doc.events).toEqual([fresh]);
    expect(res.doc.extras).toEqual([]);
    expect(res.eventsRemoved).toBe(1);
    expect(res.extrasRemoved).toBe(1);
  });

  it("keeps the untouched array's identity when only the other changed", () => {
    const events = [makeEvent({ at: daysAgo(2) })];
    const doc = makeDoc({ events, extras: [makeExtra({ deleted_at: daysAgo(30) })] });
    const res = pruneDoc(doc, NOW);
    expect(res.doc.events).toBe(events);
    expect(res.doc.extras).toEqual([]);
  });

  it("carries items and settings through by reference", () => {
    const doc = makeDoc({ events: [makeEvent({ at: daysAgo(400) }), makeEvent({ at: daysAgo(1) })] });
    const res = pruneDoc(doc, NOW);
    expect(res.doc.items).toBe(doc.items);
    expect(res.doc.settings).toBe(doc.settings);
    expect(res.doc.schema_version).toBe(doc.schema_version);
  });

  it("reports accurate combined counts", () => {
    const doc = makeDoc({
      events: [
        makeEvent({ item_id: "a", at: daysAgo(500) }),
        makeEvent({ item_id: "a", at: daysAgo(450) }),
        makeEvent({ item_id: "a", at: daysAgo(1) }),
        makeEvent({ item_id: "b", at: daysAgo(600) }),
      ],
      extras: [
        makeExtra({ deleted_at: daysAgo(10) }),
        makeExtra({ deleted_at: daysAgo(9) }),
        makeExtra({ deleted_at: daysAgo(1) }),
        makeExtra(),
      ],
    });
    const res = pruneDoc(doc, NOW);
    expect(res.eventsRemoved).toBe(2); // both old "a" events; "b" keeps its only one
    expect(res.extrasRemoved).toBe(2);
    expect(res.doc.events).toHaveLength(2);
    expect(res.doc.extras).toHaveLength(2);
  });
});
