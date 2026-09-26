import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_RETENTION_DAYS, SCHEMA_VERSION } from "../types";
import { InvalidDocError, MIGRATIONS, NewerSchemaError, migrateDoc } from "./migrations";

/** Minimal valid current-shape doc as plain JSON-ish data. */
function validRaw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: SCHEMA_VERSION,
    items: [],
    events: [],
    extras: [],
    settings: {
      retention_days: 365,
      last_export_at: null,
      writes_since_export: 0,
      last_trip_ended_at: null,
      declared_locations: [],
      device_label: "phone",
    },
    ...over,
  };
}

afterEach(() => {
  // Tests that exercise the pipeline register temporary rungs; the real
  // table is empty at v1 and must stay that way between tests.
  for (const k of Object.keys(MIGRATIONS)) delete MIGRATIONS[Number(k)];
});

describe("migrateDoc — rejection of non-objects", () => {
  const cases: Array<[string, unknown]> = [
    ["null", null],
    ["undefined", undefined],
    ["number", 42],
    ["string", "{}"],
    ["boolean", true],
    ["array", []],
  ];
  it.each(cases)("rejects %s with InvalidDocError", (_label, raw) => {
    expect(() => migrateDoc(raw)).toThrow(InvalidDocError);
  });
});

describe("migrateDoc — schema_version validation", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["missing schema_version", (() => { const d = validRaw(); delete d.schema_version; return d; })()],
    ["string schema_version", validRaw({ schema_version: "1" })],
    ["null schema_version", validRaw({ schema_version: null })],
    ["boolean schema_version", validRaw({ schema_version: true })],
    ["NaN schema_version", validRaw({ schema_version: NaN })],
    ["Infinity schema_version", validRaw({ schema_version: Infinity })],
  ];
  it.each(cases)("rejects %s with InvalidDocError", (_label, raw) => {
    expect(() => migrateDoc(raw)).toThrow(InvalidDocError);
  });

  it("rejects a future version with NewerSchemaError carrying the version", () => {
    const future = SCHEMA_VERSION + 3;
    let caught: unknown;
    try {
      migrateDoc(validRaw({ schema_version: future }));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NewerSchemaError);
    expect((caught as NewerSchemaError).fileVersion).toBe(future);
    // The message is user-facing ("update the app first"), not a parse error.
    expect((caught as NewerSchemaError).message).toContain(String(future));
    expect((caught as NewerSchemaError).message).toMatch(/update the app/i);
  });

  it("rejects an older version with no registered migration path", () => {
    expect(() => migrateDoc(validRaw({ schema_version: SCHEMA_VERSION - 1 }))).toThrow(
      InvalidDocError,
    );
  });
});

describe("migrateDoc — structural validation", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["missing items", (() => { const d = validRaw(); delete d.items; return d; })()],
    ["missing events", (() => { const d = validRaw(); delete d.events; return d; })()],
    ["missing extras", (() => { const d = validRaw(); delete d.extras; return d; })()],
    ["non-array items", validRaw({ items: {} })],
    ["non-array events", validRaw({ events: "nope" })],
    ["non-array extras", validRaw({ extras: 7 })],
    ["missing settings", (() => { const d = validRaw(); delete d.settings; return d; })()],
    ["null settings", validRaw({ settings: null })],
    ["array settings", validRaw({ settings: [] })],
  ];
  it.each(cases)("rejects %s with InvalidDocError", (_label, raw) => {
    expect(() => migrateDoc(raw)).toThrow(InvalidDocError);
  });
});

describe("migrateDoc — current version", () => {
  it("accepts a valid current doc unchanged", () => {
    const raw = validRaw();
    const doc = migrateDoc(raw);
    expect(doc.schema_version).toBe(SCHEMA_VERSION);
    expect(doc.items).toEqual([]);
    expect(doc.settings.device_label).toBe("phone");
  });

  it("preserves unknown extra fields (lenient forward compatibility)", () => {
    const raw = validRaw({ some_future_field: { keep: "me" } });
    const doc = migrateDoc(raw) as unknown as Record<string, unknown>;
    expect(doc.some_future_field).toEqual({ keep: "me" });
  });
});

describe("migrateDoc — settings numeric coercion", () => {
  function withSettings(patch: (settings: Record<string, unknown>) => void): Record<string, unknown> {
    const raw = validRaw();
    patch(raw.settings as Record<string, unknown>);
    return raw;
  }

  it("fills DEFAULT_RETENTION_DAYS when a hand-edited backup lacks retention_days", () => {
    // Without the coercion, pruneDoc's cutoff arithmetic goes NaN and every
    // date comparison is false — history gets silently mishandled.
    const raw = withSettings((s) => delete s.retention_days);
    expect(migrateDoc(raw).settings.retention_days).toBe(DEFAULT_RETENTION_DAYS);
  });

  const retentionCases: Array<[string, unknown]> = [
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["a string", "365"],
    ["null", null],
    ["zero", 0],
    ["negative", -5],
  ];
  it.each(retentionCases)("coerces retention_days=%s to the default", (_label, v) => {
    const raw = withSettings((s) => (s.retention_days = v));
    expect(migrateDoc(raw).settings.retention_days).toBe(DEFAULT_RETENTION_DAYS);
  });

  it("floors a fractional retention_days instead of discarding it", () => {
    const raw = withSettings((s) => (s.retention_days = 30.9));
    expect(migrateDoc(raw).settings.retention_days).toBe(30);
  });

  const writesCases: Array<[string, unknown]> = [
    ["missing", "DELETE"],
    ["NaN", NaN],
    ["a string", "3"],
    ["negative", -1],
  ];
  it.each(writesCases)("coerces writes_since_export=%s to 0", (_label, v) => {
    const raw = withSettings((s) => {
      if (v === "DELETE" && _label === "missing") delete s.writes_since_export;
      else s.writes_since_export = v;
    });
    expect(migrateDoc(raw).settings.writes_since_export).toBe(0);
  });

  it("keeps valid values and returns a clean doc untouched (same reference)", () => {
    const raw = validRaw();
    const doc = migrateDoc(raw);
    expect(doc.settings.retention_days).toBe(365);
    expect(doc.settings.writes_since_export).toBe(0);
    expect(doc).toBe(raw);
  });

  it("coercion copies rather than mutating the input document", () => {
    const raw = withSettings((s) => delete s.retention_days);
    const before = JSON.stringify(raw);
    const doc = migrateDoc(raw);
    expect(doc.settings.retention_days).toBe(DEFAULT_RETENTION_DAYS);
    expect(JSON.stringify(raw)).toBe(before);
  });
});

describe("migrateDoc — declared_locations coercion", () => {
  function withSettings(patch: (settings: Record<string, unknown>) => void): Record<string, unknown> {
    const raw = validRaw();
    patch(raw.settings as Record<string, unknown>);
    return raw;
  }

  it("fills [] when an older backup predates declared_locations", () => {
    const raw = withSettings((s) => delete s.declared_locations);
    expect(migrateDoc(raw).settings.declared_locations).toEqual([]);
  });

  const junkCases: Array<[string, unknown]> = [
    ["a string", "garage"],
    ["an object", { 0: "garage" }],
    ["a number", 3],
    ["null", null],
  ];
  it.each(junkCases)("coerces declared_locations=%s to []", (_label, v) => {
    const raw = withSettings((s) => (s.declared_locations = v));
    expect(migrateDoc(raw).settings.declared_locations).toEqual([]);
  });

  it("trims entries and drops blanks and non-strings", () => {
    const raw = withSettings(
      (s) => (s.declared_locations = ["  Garage ", "", "   ", 7, null, "cellar"]),
    );
    expect(migrateDoc(raw).settings.declared_locations).toEqual(["Garage", "cellar"]);
  });

  it("dedupes case-insensitively keeping the first casing", () => {
    const raw = withSettings(
      (s) => (s.declared_locations = ["Garage", "garage", "GARAGE", "attic"]),
    );
    expect(migrateDoc(raw).settings.declared_locations).toEqual(["Garage", "attic"]);
  });

  it("passes a clean list through untouched (same reference doc)", () => {
    const raw = withSettings((s) => (s.declared_locations = ["Garage", "cellar"]));
    const doc = migrateDoc(raw);
    expect(doc).toBe(raw);
    expect(doc.settings.declared_locations).toEqual(["Garage", "cellar"]);
  });

  it("coercion copies rather than mutating the input document", () => {
    const raw = withSettings((s) => (s.declared_locations = ["Garage", "garage"]));
    const before = JSON.stringify(raw);
    const doc = migrateDoc(raw);
    expect(doc.settings.declared_locations).toEqual(["Garage"]);
    expect(JSON.stringify(raw)).toBe(before);
  });
});

describe("migrateDoc — optional pending carts", () => {
  const at = "2026-09-26T12:00:00.000Z";
  const staged = { id: "beans", flagged: true, deleted_at: null, quantity: 3, shopping_amount: 2, carted_at: at };

  it("preserves valid item and extra staging without a schema bump or stock change", () => {
    const raw = validRaw({ items: [staged], extras: [{ id: "candles", deleted_at: null, carted_at: at }] });
    expect(migrateDoc(raw)).toBe(raw);
    expect(migrateDoc(raw).items[0]?.quantity).toBe(3);
  });

  it("never derives a pending cart from legacy purchases", () => {
    const raw = validRaw({ items: [{ id: "beans", flagged: false, deleted_at: null, quantity: 33 }],
      events: [{ item_id: "beans", kind: "purchase", qty_before: 3, qty_after: 33, at }] });
    expect(migrateDoc(raw).items[0]?.carted_at).toBeUndefined();
    expect(migrateDoc(raw).items[0]?.quantity).toBe(33);
  });

  it.each([
    { carted_at: "garbage" }, { carted_at: null }, { carted_at: 12 },
    { flagged: false }, { deleted_at: at }, { shopping_amount: undefined },
    { shopping_amount: "2" }, { shopping_amount: Number.MAX_VALUE },
  ])("returns malformed staged items to the list without changing their stock: %j", (patch) => {
    const raw = validRaw({ items: [{ ...staged, ...patch }] });
    const before = structuredClone(raw);
    const result = migrateDoc(raw);
    expect(result.items[0]?.carted_at).toBeUndefined();
    expect(result.items[0]?.quantity).toBe(3);
    expect(raw).toEqual(before);
  });

  it("cleans bad or deleted extra staging without mutating the backup", () => {
    const raw = validRaw({ extras: [
      { id: "bad", deleted_at: null, carted_at: "yesterday" },
      { id: "deleted", deleted_at: at, carted_at: at },
    ] });
    const before = structuredClone(raw);
    expect(migrateDoc(raw).extras.every((extra) => extra.carted_at === undefined)).toBe(true);
    expect(raw).toEqual(before);
  });
});

describe("migrateDoc — older versions run forward through MIGRATIONS", () => {
  it("applies each rung in order and stamps the final version", () => {
    const applied: number[] = [];
    // Pretend the app is at v1 and the file is at v-1: two rungs to climb.
    MIGRATIONS[SCHEMA_VERSION - 2] = (raw) => {
      applied.push(SCHEMA_VERSION - 2);
      return { ...raw, hopped_a: true };
    };
    MIGRATIONS[SCHEMA_VERSION - 1] = (raw) => {
      applied.push(SCHEMA_VERSION - 1);
      return { ...raw, hopped_b: true };
    };
    const raw = validRaw({ schema_version: SCHEMA_VERSION - 2, legacy_field: "kept" });
    const doc = migrateDoc(raw) as unknown as Record<string, unknown>;
    expect(applied).toEqual([SCHEMA_VERSION - 2, SCHEMA_VERSION - 1]);
    expect(doc.hopped_a).toBe(true);
    expect(doc.hopped_b).toBe(true);
    expect(doc.schema_version).toBe(SCHEMA_VERSION);
    expect(doc.legacy_field).toBe("kept");
  });

  it("stamps schema_version even when a migration forgets to bump it", () => {
    MIGRATIONS[SCHEMA_VERSION - 1] = (raw) => ({ ...raw }); // no bump
    const doc = migrateDoc(validRaw({ schema_version: SCHEMA_VERSION - 1 }));
    expect(doc.schema_version).toBe(SCHEMA_VERSION);
  });

  it("does not mutate the input document", () => {
    MIGRATIONS[SCHEMA_VERSION - 1] = (raw) => ({ ...raw, migrated: true });
    const raw = validRaw({ schema_version: SCHEMA_VERSION - 1 });
    const before = JSON.stringify(raw);
    migrateDoc(raw);
    expect(JSON.stringify(raw)).toBe(before);
  });

  it("validates structure AFTER migration, so a rung may create the arrays", () => {
    // Old shape without `extras` (the field arrived in a later schema).
    MIGRATIONS[SCHEMA_VERSION - 1] = (raw) => ({ ...raw, extras: [] });
    const raw = validRaw({ schema_version: SCHEMA_VERSION - 1 });
    delete raw.extras;
    const doc = migrateDoc(raw);
    expect(doc.extras).toEqual([]);
  });
});
