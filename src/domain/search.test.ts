import { describe, expect, it } from "vitest";
import type { Item } from "../types";
import { duplicateCandidates, searchItems } from "./search";

/** Minimal valid Item; tests override only the fields search cares about. */
function makeItem(overrides: Partial<Item> & { name: string }): Item {
  return {
    id: overrides.name,
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

const names = (items: Item[]): string[] => items.map((i) => i.name);

describe("searchItems", () => {
  const pantry: Item[] = [
    makeItem({ name: "Milk" }),
    makeItem({ name: "Oat Milk" }),
    makeItem({ name: "Half-and-Half", aliases: ["milk creamer"] }),
    makeItem({ name: "Cream", category: "milk products" }),
    makeItem({ name: "Jalapeño" }),
    makeItem({ name: "Tomato Paste" }),
    makeItem({ name: "Canned Tomatoes" }),
    makeItem({ name: "Swiss Cheese" }),
    makeItem({ name: "Paprika", deleted_at: "2026-02-01T00:00:00.000Z" }),
  ];

  it.each([["", 0], ["   ", 0], ["\t\n", 0]] as [string, number][])(
    "empty/whitespace query %j returns []",
    (query) => {
      expect(searchItems(pantry, query)).toEqual([]);
    }
  );

  it("query that folds to nothing (bare punctuation) returns []", () => {
    expect(searchItems(pantry, "!!!")).toEqual([]);
  });

  it("no match returns []", () => {
    expect(searchItems(pantry, "quinoa")).toEqual([]);
  });

  describe("diacritic folding", () => {
    it("plain query matches accented name", () => {
      expect(names(searchItems(pantry, "jalapeno"))).toEqual(["Jalapeño"]);
    });

    it("accented query matches plain name", () => {
      const items = [makeItem({ name: "Jalapeno Poppers" })];
      expect(names(searchItems(items, "jalapeño"))).toEqual(["Jalapeno Poppers"]);
    });
  });

  it("punctuation in names folds for matching: 'half and' finds 'Half-and-Half'", () => {
    expect(names(searchItems(pantry, "half and"))).toEqual(["Half-and-Half"]);
  });

  describe("ranking bands", () => {
    it("name-prefix beats name-substring beats alias/category", () => {
      // "Milk" = prefix, "Oat Milk" = substring, alias/category matches last.
      expect(names(searchItems(pantry, "milk"))).toEqual([
        "Milk",
        "Oat Milk",
        "Cream",          // category "milk products"
        "Half-and-Half",  // alias "milk creamer"
      ]);
    });

    it("prefix band beats substring band for partial words", () => {
      expect(names(searchItems(pantry, "tom"))).toEqual([
        "Tomato Paste",     // prefix
        "Canned Tomatoes",  // substring
      ]);
    });

    it("sorts alphabetically (by folded name) within a band", () => {
      const items = [
        makeItem({ name: "Sea Salt Flakes" }),
        makeItem({ name: "Salt" }),
        makeItem({ name: "Salted Butter" }),
      ];
      expect(names(searchItems(items, "salt"))).toEqual([
        "Salt",             // prefix band, "salt"
        "Salted Butter",    // prefix band, "salted butter"
        "Sea Salt Flakes",  // substring band
      ]);
    });
  });

  describe("includeDeleted", () => {
    it("excludes soft-deleted items by default", () => {
      expect(names(searchItems(pantry, "paprika"))).toEqual([]);
    });

    it("excludes soft-deleted items when explicitly false", () => {
      expect(names(searchItems(pantry, "paprika", { includeDeleted: false }))).toEqual([]);
    });

    it("includes soft-deleted items when true (create-flow restore path)", () => {
      expect(names(searchItems(pantry, "paprika", { includeDeleted: true }))).toEqual([
        "Paprika",
      ]);
    });

    it("ranks deleted items in their normal band", () => {
      const items = [
        makeItem({ name: "Paprika", deleted_at: "2026-02-01T00:00:00.000Z" }),
        makeItem({ name: "Smoked Paprika" }),
      ];
      expect(names(searchItems(items, "pap", { includeDeleted: true }))).toEqual([
        "Paprika",        // prefix band, though deleted
        "Smoked Paprika", // substring band
      ]);
    });
  });
});

describe("duplicateCandidates", () => {
  it("empty and punctuation-only names return []", () => {
    const items = [makeItem({ name: "Salt" })];
    expect(duplicateCandidates(items, "")).toEqual([]);
    expect(duplicateCandidates(items, "   ")).toEqual([]);
    expect(duplicateCandidates(items, "!!!")).toEqual([]);
  });

  it("matches equal normalKey across case, diacritics, and word order", () => {
    const items = [makeItem({ name: "Tomatoes, Canned" })];
    expect(names(duplicateCandidates(items, "canned tomatoes"))).toEqual([
      "Tomatoes, Canned",
    ]);
    const accented = [makeItem({ name: "Jalapeño" })];
    expect(names(duplicateCandidates(accented, "JALAPENO"))).toEqual(["Jalapeño"]);
  });

  it("matches plural variants via the drop-trailing-s rule", () => {
    const items = [makeItem({ name: "Bag Clips" })];
    expect(names(duplicateCandidates(items, "bags clip"))).toEqual(["Bag Clips"]);
  });

  it("does not singularize 'ss' words: 'swis' is not a dup of 'Swiss'", () => {
    const items = [makeItem({ name: "Swiss" })];
    expect(duplicateCandidates(items, "swis")).toEqual([]);
  });

  it("finds soft-deleted tombstones (the restore path)", () => {
    const items = [
      makeItem({ name: "Paprika", deleted_at: "2026-02-01T00:00:00.000Z" }),
    ];
    expect(names(duplicateCandidates(items, "paprika"))).toEqual(["Paprika"]);
  });

  describe("token-subset containment", () => {
    it("query contains item: 'canned tomatoes' vs 'Tomatoes'", () => {
      const items = [makeItem({ name: "Tomatoes" })];
      expect(names(duplicateCandidates(items, "canned tomatoes"))).toEqual(["Tomatoes"]);
    });

    it("item contains query: 'tomatoes' vs 'Canned Tomatoes'", () => {
      const items = [makeItem({ name: "Canned Tomatoes" })];
      expect(names(duplicateCandidates(items, "tomatoes"))).toEqual(["Canned Tomatoes"]);
    });

    it("overlap without containment is NOT a match: 'green beans' vs 'green peas'", () => {
      const items = [makeItem({ name: "Green Peas" })];
      expect(duplicateCandidates(items, "green beans")).toEqual([]);
    });
  });

  it("matches over aliases (merge residue immunizes future searches)", () => {
    const items = [makeItem({ name: "Scallions", aliases: ["Green Onions"] })];
    expect(names(duplicateCandidates(items, "green onion"))).toEqual(["Scallions"]);
  });

  it("returns live items before tombstones", () => {
    const items = [
      makeItem({ id: "dead", name: "Paprika", deleted_at: "2026-02-01T00:00:00.000Z" }),
      makeItem({ id: "live", name: "Smoked Paprika" }),
    ];
    // Both match "paprika" by containment; the live item leads despite
    // appearing later in the input.
    expect(duplicateCandidates(items, "paprika").map((i) => i.id)).toEqual([
      "live",
      "dead",
    ]);
  });

  it("unrelated names do not match", () => {
    const items = [makeItem({ name: "Pepper" })];
    expect(duplicateCandidates(items, "salt")).toEqual([]);
  });
});
