import { afterEach, describe, expect, it } from "vitest";
import { SCHEMA_VERSION, type AmbryDoc, type Item } from "../types";
import { DOC_KEY, SNAPSHOT_PREFIX, memoryAdapter } from "./adapter";
import { emptyDoc, listSnapshots, loadDoc, saveDoc, writeSnapshot } from "./doc";
import { MIGRATIONS } from "./migrations";

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

function makeDoc(over: Partial<AmbryDoc> = {}): AmbryDoc {
  return { ...emptyDoc("test-device"), ...over };
}

afterEach(() => {
  for (const k of Object.keys(MIGRATIONS)) delete MIGRATIONS[Number(k)];
});

describe("emptyDoc", () => {
  it("builds a current-schema doc with default settings", () => {
    const doc = emptyDoc();
    expect(doc.schema_version).toBe(SCHEMA_VERSION);
    expect(doc.items).toEqual([]);
    expect(doc.events).toEqual([]);
    expect(doc.extras).toEqual([]);
    expect(doc.settings.retention_days).toBe(365);
    expect(doc.settings.last_export_at).toBeNull();
    expect(doc.settings.writes_since_export).toBe(0);
    expect(doc.settings.device_label).toBe("phone");
  });

  it("takes an explicit device label", () => {
    expect(emptyDoc("laptop").settings.device_label).toBe("laptop");
  });
});

describe("loadDoc — empty key", () => {
  it("returns an empty doc with status 'empty' and writes NOTHING", () => {
    const adapter = memoryAdapter();
    const r = loadDoc(adapter);
    expect(r.status).toBe("empty");
    expect(r.doc).toEqual(emptyDoc());
    // The boot rule: never silently start fresh. loadDoc must not persist
    // the placeholder — the restore-first screen owns the next step.
    expect(adapter.keys()).toEqual([]);
    expect(adapter.get(DOC_KEY)).toBeNull();
  });
});

describe("loadDoc — corrupt", () => {
  it("stashes corrupt raw JSON at a snapshot key and returns 'corrupt'", () => {
    const raw = '{"schema_version": 1, "items": [broken';
    const adapter = memoryAdapter({ [DOC_KEY]: raw });
    const r = loadDoc(adapter);
    expect(r.status).toBe("corrupt");
    expect(r.doc).toEqual(emptyDoc());

    const snaps = listSnapshots(adapter);
    expect(snaps).toHaveLength(1);
    const key = snaps[0]!;
    expect(key.startsWith(SNAPSHOT_PREFIX + "corrupt-")).toBe(true);
    // The stash must hold the exact original bytes — it is the recovery path.
    expect(adapter.get(key)).toBe(raw);
    // The main key is not destroyed by loading.
    expect(adapter.get(DOC_KEY)).toBe(raw);
  });

  it("treats valid JSON with an invalid shape the same way", () => {
    const raw = JSON.stringify({ schema_version: SCHEMA_VERSION, items: "not-an-array" });
    const adapter = memoryAdapter({ [DOC_KEY]: raw });
    const r = loadDoc(adapter);
    expect(r.status).toBe("corrupt");
    const snaps = listSnapshots(adapter);
    expect(snaps).toHaveLength(1);
    expect(adapter.get(snaps[0]!)).toBe(raw);
  });

  it("treats a NEWER-schema doc as unloadable but preserves the bytes", () => {
    const raw = JSON.stringify({ ...makeDoc(), schema_version: SCHEMA_VERSION + 1 });
    const adapter = memoryAdapter({ [DOC_KEY]: raw });
    const r = loadDoc(adapter);
    expect(r.status).toBe("corrupt");
    expect(adapter.get(listSnapshots(adapter)[0]!)).toBe(raw);
  });
});

describe("loadDoc — older schema", () => {
  it("snapshots the RAW pre-migrate text, migrates, and SAVES the result", () => {
    const from = SCHEMA_VERSION - 1;
    MIGRATIONS[from] = (rawDoc) => ({ ...rawDoc, migrated_marker: true });
    const raw = JSON.stringify({ ...makeDoc({ items: [makeItem()] }), schema_version: from });
    const adapter = memoryAdapter({ [DOC_KEY]: raw });

    const r = loadDoc(adapter);
    expect(r.status).toBe("migrated");
    expect(r.doc.schema_version).toBe(SCHEMA_VERSION);
    expect((r.doc as unknown as Record<string, unknown>).migrated_marker).toBe(true);
    expect(r.doc.items).toHaveLength(1);

    // Pre-migrate snapshot holds the untouched original bytes.
    expect(adapter.get(`${SNAPSHOT_PREFIX}pre-migrate-v${from}`)).toBe(raw);

    // The migrated doc was saved back, so the next boot loads clean.
    const persisted = JSON.parse(adapter.get(DOC_KEY)!) as Record<string, unknown>;
    expect(persisted.schema_version).toBe(SCHEMA_VERSION);
    expect(persisted.migrated_marker).toBe(true);

    const again = loadDoc(adapter);
    expect(again.status).toBe("loaded");
    expect(again.doc).toEqual(r.doc);
  });

  it("a failed migration falls through to the corrupt path, bytes preserved", () => {
    // No MIGRATIONS entry registered: version-0 docs have no path today.
    const raw = JSON.stringify({ ...makeDoc(), schema_version: SCHEMA_VERSION - 1 });
    const adapter = memoryAdapter({ [DOC_KEY]: raw });
    const r = loadDoc(adapter);
    expect(r.status).toBe("corrupt");
    const corrupt = listSnapshots(adapter).find((k) => k.includes("corrupt-"));
    expect(corrupt).toBeDefined();
    expect(adapter.get(corrupt!)).toBe(raw);
  });
});

describe("loadDoc — current schema", () => {
  it("loads without writing any snapshot or touching the stored bytes", () => {
    const doc = makeDoc({ items: [makeItem()] });
    const raw = JSON.stringify(doc);
    const adapter = memoryAdapter({ [DOC_KEY]: raw });
    const r = loadDoc(adapter);
    expect(r.status).toBe("loaded");
    expect(r.doc).toEqual(doc);
    expect(listSnapshots(adapter)).toEqual([]);
    // No rewrite on a clean load: the stored bytes are untouched.
    expect(adapter.get(DOC_KEY)).toBe(raw);
    expect(adapter.keys()).toEqual([DOC_KEY]);
  });
});

describe("saveDoc / writeSnapshot / listSnapshots", () => {
  it("saveDoc round-trips through loadDoc", () => {
    const adapter = memoryAdapter();
    const doc = makeDoc({ items: [makeItem({ name: "flour" })] });
    saveDoc(adapter, doc);
    const r = loadDoc(adapter);
    expect(r.status).toBe("loaded");
    expect(r.doc).toEqual(doc);
  });

  it("listSnapshots returns only snapshot keys, sorted", () => {
    const adapter = memoryAdapter();
    saveDoc(adapter, makeDoc());
    writeSnapshot(adapter, "pre-import", "{}");
    writeSnapshot(adapter, "corrupt-2026-08-27T00:00:00.000Z", "junk");
    expect(listSnapshots(adapter)).toEqual([
      `${SNAPSHOT_PREFIX}corrupt-2026-08-27T00:00:00.000Z`,
      `${SNAPSHOT_PREFIX}pre-import`,
    ]);
  });
});
