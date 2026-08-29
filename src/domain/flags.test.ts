import { describe, expect, it } from "vitest";
import type { EventKind, Item } from "../types";
import { flagTransition, type FlagTransition } from "./flags";

/** Minimal valid Item; tests override only what each case exercises. */
function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    id: "item-1",
    name: "butter",
    aliases: [],
    notes: "",
    category: null,
    location: null,
    unit: "stick",
    quantity: 2,
    package_size: null,
    display_mode: "number",
    threshold: 1,
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

interface Case {
  name: string;
  item: Partial<Item>;
  before: number;
  after: number;
  kind: EventKind;
  want: FlagTransition;
}

/** A counted item: verified_at set, so only a downward move can raise. */
const COUNTED = "2026-01-02T00:00:00.000Z";

describe("flagTransition", () => {
  const cases: Case[] = [
    // --- Raise: landing at/below the threshold on a downward move ---
    {
      name: "raises on downward crossing past the threshold",
      item: { threshold: 1 },
      before: 2,
      after: 0.5,
      kind: "use",
      want: "raise",
    },
    {
      name: "raises when landing exactly ON the threshold",
      item: { threshold: 1 },
      before: 2,
      after: 1,
      kind: "use",
      want: "raise",
    },
    {
      name: "raises from barely above the threshold",
      item: { threshold: 1 },
      before: 1.001,
      after: 1,
      kind: "use",
      want: "raise",
    },
    {
      name: "raises on a recount that crosses downward",
      item: { threshold: 1 },
      before: 3,
      after: 0,
      kind: "recount",
      want: "raise",
    },
    {
      name: "raises across a zero threshold (0 is not 'no threshold')",
      item: { threshold: 0 },
      before: 1,
      after: 0,
      kind: "use",
      want: "raise",
    },

    // --- Dead zones of the old strict-crossing rule, now fixed ---
    {
      // Old rule: before(1) > threshold(1) is false, so this never flagged
      // despite the UI's "at or below N" promise.
      name: "raises when dropping from exactly AT the threshold to below",
      item: { threshold: 1, verified_at: COUNTED },
      before: 1,
      after: 0.5,
      kind: "use",
      want: "raise",
    },
    {
      // Genuinely low: a further downward move inside below-threshold
      // territory on a counted, unflagged item still raises.
      name: "raises on a drop deeper below the threshold (counted, unflagged)",
      item: { threshold: 1, verified_at: COUNTED },
      before: 0.5,
      after: 0.4,
      kind: "use",
      want: "raise",
    },

    // --- First observation: never-verified items flag on landing low ---
    {
      // Old rule: the seeded before of 0 is not above the threshold, so a
      // first count landing AT the threshold never flagged.
      name: "first count landing exactly AT the threshold raises",
      item: { threshold: 3, verified_at: null },
      before: 0,
      after: 3,
      kind: "recount",
      want: "raise",
    },
    {
      name: "first count of exactly 0 raises (verified Out is a shortage)",
      item: { threshold: 1, verified_at: null },
      before: 0,
      after: 0,
      kind: "recount",
      want: "raise",
    },

    // --- NO raise: landing above, or upward on a counted item ---
    {
      name: "no raise when the drop stays above the threshold",
      item: { threshold: 1 },
      before: 3,
      after: 2,
      kind: "use",
      want: "none",
    },
    {
      name: "no raise on an unchanged recount at the threshold (counted item)",
      item: { threshold: 1, verified_at: COUNTED },
      before: 1,
      after: 1,
      kind: "recount",
      want: "none",
    },
    {
      name: "no raise on an upward move past the threshold",
      item: { threshold: 1, verified_at: COUNTED },
      before: 0.5,
      after: 2,
      kind: "add",
      want: "none",
    },
    {
      // No nag on corrections: an upward recount that still lands below the
      // threshold does NOT raise on a counted item (only first observations
      // may raise on an upward write).
      name: "no raise on an upward recount to below-threshold (counted item)",
      item: { threshold: 1, verified_at: COUNTED },
      before: 0.2,
      after: 0.8,
      kind: "recount",
      want: "none",
    },

    // --- Already flagged: no re-raise without first rising above ---
    {
      name: "no raise when already flagged, even on a fresh crossing",
      item: { threshold: 1, flagged: true, flag_source: "threshold" },
      before: 2,
      after: 0.5,
      kind: "use",
      want: "none",
    },
    {
      name: "no raise when already flagged and dropping below again",
      item: { threshold: 1, flagged: true, flag_source: "manual" },
      before: 1,
      after: 0,
      kind: "use",
      want: "none",
    },

    // --- Sticky: nothing except purchase ever clears ---
    {
      name: "recount UP past the threshold never clears a flagged item",
      item: { threshold: 1, flagged: true, flag_source: "threshold" },
      before: 0.5,
      after: 3,
      kind: "recount",
      want: "none",
    },
    {
      name: "stepper add up past the threshold never clears",
      item: { threshold: 1, flagged: true, flag_source: "threshold" },
      before: 0,
      after: 5,
      kind: "add",
      want: "none",
    },

    // --- never_prompt suppresses auto-raise ONLY ---
    {
      name: "never_prompt suppresses the raise on a crossing",
      item: { threshold: 1, never_prompt: true },
      before: 2,
      after: 0,
      kind: "use",
      want: "none",
    },
    {
      name: "never_prompt does not block the purchase clear",
      item: { threshold: 1, never_prompt: true, flagged: true, flag_source: "manual" },
      before: 0,
      after: 1,
      kind: "purchase",
      want: "clear",
    },

    // --- null threshold: auto-raise permanently off ---
    {
      name: "null threshold never raises regardless of the drop",
      item: { threshold: null },
      before: 10,
      after: 0,
      kind: "use",
      want: "none",
    },

    // --- purchase ALWAYS clears ---
    {
      name: "purchase clears a threshold-raised flag",
      item: { threshold: 1, flagged: true, flag_source: "threshold" },
      before: 0.5,
      after: 1.5,
      kind: "purchase",
      want: "clear",
    },
    {
      name: "purchase clears even when the result is still <= threshold",
      item: { threshold: 3, flagged: true, flag_source: "threshold" },
      before: 0,
      after: 1,
      kind: "purchase",
      want: "clear",
    },
    {
      // Buying back to exactly the threshold must not instantly re-raise:
      // purchase short-circuits to "clear" before the level test can run.
      name: "purchase landing exactly AT the threshold clears, no re-raise",
      item: { threshold: 1, flagged: true, flag_source: "threshold", verified_at: COUNTED },
      before: 0.5,
      after: 1,
      kind: "purchase",
      want: "clear",
    },
    {
      name: "purchase returns clear even on an unflagged item (store no-ops it)",
      item: { threshold: 1, flagged: false },
      before: 2,
      after: 3,
      kind: "purchase",
      want: "clear",
    },
    {
      name: "purchase wins over a simultaneous downward crossing",
      item: { threshold: 2 },
      before: 5,
      after: 1,
      kind: "purchase",
      want: "clear",
    },
    {
      name: "purchase clears even with a null threshold",
      item: { threshold: null, flagged: true, flag_source: "manual" },
      before: 0,
      after: 2,
      kind: "purchase",
      want: "clear",
    },
  ];

  it.each(cases)("$name", ({ item, before, after, kind, want }) => {
    expect(flagTransition(makeItem(item), before, after, kind)).toBe(want);
  });

  it("raises for every non-purchase quantity-write kind on a crossing", () => {
    // The spec gates the raise on the crossing, not the gesture: any kind the
    // store routes through a quantity write can raise, purchase excepted.
    const kinds: EventKind[] = ["add", "use", "recount", "create", "merge", "import"];
    for (const kind of kinds) {
      expect(flagTransition(makeItem({ threshold: 1 }), 2, 0.5, kind)).toBe("raise");
    }
  });
});
