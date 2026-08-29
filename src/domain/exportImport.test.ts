import { afterEach, describe, expect, it } from "vitest";
import { SCHEMA_VERSION, type AmbryDoc, type HistoryEvent, type Item, type ShoppingExtra } from "../types";
import { MIGRATIONS } from "../store/migrations";
import { buildExport, checkStaleness, exportFilename, parseImport, restampDoc } from "./exportImport";
import { emptyDoc } from "../store/doc";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeItem(over: Partial<Item> = {}): Item {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    name: "paprika",
    aliases: [],
    notes: "",
    category: null,
    location: "pantry",
    unit: "jar",
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
  return {
    id: "22222222-2222-2222-2222-222222222222",
    text: "birthday candles",
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    deleted_at: null,
    ...over,
  };
}

function makeEvent(over: Partial<HistoryEvent> = {}): HistoryEvent {
  return {
    id: "33333333-3333-3333-3333-333333333333",
    item_id: "11111111-1111-1111-1111-111111111111",
    at: "2026-08-01T00:00:00.000Z",
    kind: "recount",
    qty_before: 2,
    qty_after: 1,
    unit: "jar",
    ...over,
  };
}

function makeDoc(over: Partial<AmbryDoc> = {}): AmbryDoc {
  return {
    schema_version: SCHEMA_VERSION,
    items: [],
    events: [],
    extras: [],
    settings: {
      retention_days: 365,
      last_export_at: null,
      writes_since_export: 3,
      last_trip_ended_at: null,
      declared_locations: [],
      device_label: "kc-iphone",
    },
    ...over,
  };
}

afterEach(() => {
  for (const k of Object.keys(MIGRATIONS)) delete MIGRATIONS[Number(k)];
});

// ---------------------------------------------------------------------------
// buildExport
// ---------------------------------------------------------------------------

describe("buildExport", () => {
  it("is full fidelity: tombstones, events, extras, settings all included", () => {
    const tombstone = makeItem({ id: "dead", deleted_at: "2026-08-10T00:00:00.000Z" });
    const doc = makeDoc({
      items: [makeItem(), tombstone],
      events: [makeEvent(), makeEvent({ id: "e2" })],
      extras: [makeExtra()],
    });
    const env = buildExport(doc, "2026-08-27T19:30:00.000Z");
    expect(env.app).toBe("ambry");
    expect(env.schema_version).toBe(SCHEMA_VERSION);
    expect(env.exported_at).toBe("2026-08-27T19:30:00.000Z");
    expect(env.device_label).toBe("kc-iphone");
    expect(env.items).toContainEqual(tombstone);
    expect(env.events).toEqual(doc.events);
    expect(env.extras).toEqual(doc.extras);
    expect(env.settings).toEqual(doc.settings);
  });

  it("counts match the arrays, tombstones included", () => {
    const doc = makeDoc({
      items: [makeItem(), makeItem({ id: "b", deleted_at: "2026-08-10T00:00:00.000Z" })],
      events: [makeEvent(), makeEvent({ id: "e2" }), makeEvent({ id: "e3" })],
      extras: [makeExtra()],
    });
    const env = buildExport(doc, "2026-08-27T19:30:00.000Z");
    expect(env.counts).toEqual({ items: 2, events: 3, extras: 1 });
  });

  it("an explicit deviceLabel overrides the stored one", () => {
    const env = buildExport(makeDoc(), "2026-08-27T19:30:00.000Z", "laptop");
    expect(env.device_label).toBe("laptop");
  });
});

// ---------------------------------------------------------------------------
// exportFilename
// ---------------------------------------------------------------------------

describe("exportFilename", () => {
  // Dates are constructed from LOCAL components, so these pass in any TZ.
  const cases: Array<[string, Date, string]> = [
    ["evening", new Date(2026, 7, 27, 19, 30), "ambry-backup-2026-08-27-1930.json"],
    ["single-digit month/day/hour/minute pads", new Date(2026, 0, 5, 9, 5), "ambry-backup-2026-01-05-0905.json"],
    ["midnight", new Date(2026, 11, 31, 0, 0), "ambry-backup-2026-12-31-0000.json"],
    ["end of day", new Date(2026, 8, 1, 23, 59), "ambry-backup-2026-09-01-2359.json"],
  ];
  it.each(cases)("%s", (_label, d, expected) => {
    expect(exportFilename(d)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// parseImport
// ---------------------------------------------------------------------------

describe("parseImport", () => {
  it("returns {ok:false, invalid} on garbage text — never throws", () => {
    const r = parseImport("not json at all {");
    expect(r).toMatchObject({ ok: false, error: "invalid" });
  });

  const invalidJsonValues: Array<[string, string]> = [
    ["JSON number", "42"],
    ["JSON string", '"hello"'],
    ["JSON array", "[]"],
    ["JSON null", "null"],
    ["object without schema_version", '{"items":[]}'],
    ["object missing arrays", '{"schema_version":1,"settings":{}}'],
  ];
  it.each(invalidJsonValues)("returns invalid for %s", (_label, text) => {
    const r = parseImport(text);
    expect(r).toMatchObject({ ok: false, error: "invalid" });
  });

  it("accepts a bare AmbryDoc (raw snapshot as restore source)", () => {
    const doc = makeDoc({ items: [makeItem()] });
    const r = parseImport(JSON.stringify(doc));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc).toEqual(doc);
    // A bare doc has no envelope metadata.
    expect(r.envelope.exported_at).toBeNull();
    expect(r.envelope.device_label).toBeNull();
    expect(r.envelope.counts).toEqual({ items: 1, events: 0, extras: 0 });
  });

  it("accepts a full envelope and round-trips the doc exactly", () => {
    const doc = makeDoc({
      items: [makeItem(), makeItem({ id: "t", deleted_at: "2026-08-10T00:00:00.000Z" })],
      events: [makeEvent()],
      extras: [makeExtra({ deleted_at: "2026-08-11T00:00:00.000Z" })],
    });
    const env = buildExport(doc, "2026-08-27T19:30:00.000Z");
    const r = parseImport(JSON.stringify(env, null, 2));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.items).toEqual(doc.items);
    expect(r.doc.events).toEqual(doc.events);
    expect(r.doc.extras).toEqual(doc.extras);
    expect(r.doc.settings).toEqual(doc.settings);
    expect(r.envelope.exported_at).toBe("2026-08-27T19:30:00.000Z");
    expect(r.envelope.device_label).toBe("kc-iphone");
    expect(r.envelope.counts).toEqual({ items: 2, events: 1, extras: 1 });
  });

  it("does not leak envelope metadata into the imported doc", () => {
    const env = buildExport(makeDoc(), "2026-08-27T19:30:00.000Z");
    const r = parseImport(JSON.stringify(env));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const asRecord = r.doc as unknown as Record<string, unknown>;
    expect(asRecord.app).toBeUndefined();
    expect(asRecord.exported_at).toBeUndefined();
    expect(asRecord.counts).toBeUndefined();
    expect(asRecord.device_label).toBeUndefined();
  });

  it("recomputes counts from the arrays, ignoring a lying stored counts field", () => {
    const env = buildExport(makeDoc({ items: [makeItem()] }), "2026-08-27T19:30:00.000Z");
    const tampered = { ...env, counts: { items: 999, events: 999, extras: 999 } };
    const r = parseImport(JSON.stringify(tampered));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.envelope.counts).toEqual({ items: 1, events: 0, extras: 0 });
  });

  it("refuses a newer-schema file with a distinct error, not a parse error", () => {
    const future = SCHEMA_VERSION + 5;
    for (const text of [
      JSON.stringify({ ...makeDoc(), schema_version: future }),
      JSON.stringify({ ...buildExport(makeDoc(), "2026-08-27T19:30:00.000Z"), schema_version: future }),
    ]) {
      const r = parseImport(text);
      expect(r).toMatchObject({ ok: false, error: "newer_schema" });
      if (r.ok) continue;
      expect(r.detail).toContain(String(future));
    }
  });

  it("migrates an older file through the shared pipeline (R3)", () => {
    MIGRATIONS[SCHEMA_VERSION - 1] = (raw) => ({ ...raw, migrated_flag: true });
    const oldDoc = { ...makeDoc(), schema_version: SCHEMA_VERSION - 1 };
    const r = parseImport(JSON.stringify(oldDoc));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.schema_version).toBe(SCHEMA_VERSION);
    expect((r.doc as unknown as Record<string, unknown>).migrated_flag).toBe(true);
  });

  it("migrates an older ENVELOPE too, preserving doc-level legacy fields", () => {
    MIGRATIONS[SCHEMA_VERSION - 1] = (raw) => ({ ...raw, upgraded: raw.legacy });
    const env = {
      ...buildExport(makeDoc(), "2026-08-27T19:30:00.000Z"),
      schema_version: SCHEMA_VERSION - 1,
      legacy: "carried",
    };
    const r = parseImport(JSON.stringify(env));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.doc as unknown as Record<string, unknown>).upgraded).toBe("carried");
  });
});

// ---------------------------------------------------------------------------
// checkStaleness
// ---------------------------------------------------------------------------

describe("checkStaleness", () => {
  const T1 = "2026-08-01T00:00:00.000Z";
  const T2 = "2026-08-15T00:00:00.000Z";
  const T3 = "2026-08-27T00:00:00.000Z";

  it("an empty local doc is never newer", () => {
    const r = checkStaleness(makeDoc(), makeDoc({ items: [makeItem({ updated_at: T1 })] }));
    expect(r.incomingIsOlder).toBe(false);
    expect(r.localLatest).toBeNull();
    expect(r.incomingLatest).toBe(T1);
  });

  it("both empty: not older", () => {
    const r = checkStaleness(makeDoc(), makeDoc());
    expect(r.incomingIsOlder).toBe(false);
    expect(r.localLatest).toBeNull();
    expect(r.incomingLatest).toBeNull();
  });

  it("incoming older than local -> refuse", () => {
    const local = makeDoc({ items: [makeItem({ updated_at: T3 })] });
    const incoming = makeDoc({ items: [makeItem({ updated_at: T1 })] });
    const r = checkStaleness(local, incoming);
    expect(r.incomingIsOlder).toBe(true);
    expect(r.localLatest).toBe(T3);
    expect(r.incomingLatest).toBe(T1);
  });

  it("incoming newer than local -> fine", () => {
    const local = makeDoc({ items: [makeItem({ updated_at: T1 })] });
    const incoming = makeDoc({ items: [makeItem({ updated_at: T3 })] });
    expect(checkStaleness(local, incoming).incomingIsOlder).toBe(false);
  });

  it("EQUAL timestamps are NOT older (re-importing the backup just made)", () => {
    const local = makeDoc({ items: [makeItem({ updated_at: T2 })] });
    const incoming = makeDoc({ items: [makeItem({ updated_at: T2 })] });
    const r = checkStaleness(local, incoming);
    expect(r.incomingIsOlder).toBe(false);
    expect(r.localLatest).toBe(T2);
    expect(r.incomingLatest).toBe(T2);
  });

  it("an empty incoming file over real local data IS older", () => {
    const local = makeDoc({ items: [makeItem({ updated_at: T1 })] });
    const r = checkStaleness(local, makeDoc());
    expect(r.incomingIsOlder).toBe(true);
    expect(r.incomingLatest).toBeNull();
  });

  it("takes the max across items AND extras, tombstones included", () => {
    const local = makeDoc({
      items: [
        makeItem({ updated_at: T1 }),
        makeItem({ id: "t", updated_at: T2, deleted_at: T2 }),
      ],
      extras: [makeExtra({ updated_at: T3 })],
    });
    expect(checkStaleness(local, makeDoc()).localLatest).toBe(T3);
  });

  it("falls back to events' `at` only when there are no items or extras", () => {
    const eventsOnly = makeDoc({ events: [makeEvent({ at: T1 }), makeEvent({ id: "e2", at: T2 })] });
    expect(checkStaleness(eventsOnly, makeDoc()).localLatest).toBe(T2);

    // With rows present, rows win even when an event is newer.
    const mixed = makeDoc({
      items: [makeItem({ updated_at: T1 })],
      events: [makeEvent({ at: T3 })],
    });
    expect(checkStaleness(mixed, makeDoc()).localLatest).toBe(T1);
  });
});

describe("restampDoc", () => {
  it("stamps item/extra timestamps to now, leaving identity and counts alone", () => {
    const doc = emptyDoc("seed");
    doc.items.push({
      id: "00000000-0000-4000-8000-000000000001", name: "Apples", aliases: [], notes: "",
      category: "fruit", location: "countertop", unit: "count", quantity: 0,
      package_size: null, display_mode: "number", threshold: null, flagged: false,
      flag_source: null, flagged_at: null, restock_amount: 1, never_prompt: false,
      expiry: null, barcodes: [], verified_at: null, merged_into: null,
      created_at: "2026-08-28T02:07:05.459Z", updated_at: "2026-08-28T02:07:05.459Z", deleted_at: null,
    });
    const at = "2026-11-01T12:00:00.000Z";
    restampDoc(doc, at);
    const it2 = doc.items[0]!;
    expect(it2.created_at).toBe(at);
    expect(it2.updated_at).toBe(at);
    expect(it2.verified_at).toBeNull(); // still uncounted — restamp is not a count
    expect(it2.id).toBe("00000000-0000-4000-8000-000000000001");
    expect(it2.quantity).toBe(0);
  });
});
