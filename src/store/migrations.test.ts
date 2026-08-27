import { afterEach, describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../types";
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
