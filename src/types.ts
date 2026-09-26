/**
 * Ambry data model. PLAN.md §2 is the authoritative spec; the three rules:
 *
 * R1 — One chokepoint. Every mutation goes through src/store/store.ts.
 * R2 — Current state lives on the item; events are self-contained observations
 *      that nothing references. Any event can be pruned and nothing breaks.
 * R3 — Storage is one versioned document; import runs the same migration
 *      pipeline as load.
 *
 * Timestamps: ISO-8601 UTC strings. Expiry: plain "YYYY-MM-DD" calendar date,
 * never a timestamp. IDs: crypto.randomUUID().
 */

export interface AmbryDoc {
  schema_version: number;
  items: Item[];
  /** Append-only, age-pruned. */
  events: HistoryEvent[];
  /** Ad-hoc shopping lines (PLAN.md §1.6). */
  extras: ShoppingExtra[];
  settings: Settings;
}

export interface Item {
  id: string;
  name: string;
  /** Merge residue + extra search hits. */
  aliases: string[];
  notes: string;
  /** Picked from existing values in the UI; stored as plain strings. */
  category: string | null;
  location: string | null;

  /** "bag", "stick", "g" — the unit carries the granularity. */
  unit: string;
  /** THE number, in `unit`. Rounded to 3 decimals on write, clamped >= 0. */
  quantity: number;
  /** e.g. 1 bag = 1000 g -> { amount: 1000, unit: "g" } */
  package_size: { amount: number; unit: string } | null;
  display_mode: DisplayMode;

  /** In `unit`; null = no auto-flag. */
  threshold: number | null;
  flagged: boolean;
  /** Provenance lives on the item so it survives event pruning (R2). */
  flag_source: "threshold" | "manual" | null;
  flagged_at: string | null;
  /** Default purchase quantity, in `unit`. */
  restock_amount: number;
  /** This shopping trip's chosen amount, in `unit`; absent = restock_amount.
   *  Optional so existing v1 documents/backups retain their usual default. */
  shopping_amount?: number;
  /** Staged for checkout; stock and the resupply flag have not changed yet.
   *  A staged item always has an explicit shopping_amount. */
  carted_at?: string;
  /** Suppresses threshold auto-raise ONLY; manual flagging still works. */
  never_prompt: boolean;

  /** "YYYY-MM-DD" or null. */
  expiry: string | null;
  /** Reserved for phase-2 scanning; always exported. */
  barcodes: string[];
  /** Last human-confirmed physical observation — the anti-drift field. */
  verified_at: string | null;
  /** Set (with deleted_at) on the losing row of a merge. */
  merged_into: string | null;

  created_at: string;
  /** Bumps on EVERY mutation including soft delete. */
  updated_at: string;
  /** Soft delete. Non-null means deleted. */
  deleted_at: string | null;
}

export type DisplayMode = "number" | "ladder";

export type EventKind =
  | "create"
  | "add"        // stepper up
  | "use"        // stepper down
  | "recount"    // absolute entry / ladder tap / audit fix — stamps verified_at
  | "purchase"   // completed checkout — clears the flag
  | "unit_change"
  | "merge"
  | "delete"
  | "restore"
  | "import";

export interface HistoryEvent {
  id: string;
  /** The item as it was at write time — never rewritten by merges. */
  item_id: string;
  at: string;
  kind: EventKind;
  /** Before+after, not delta: every event is self-contained (R2). */
  qty_before: number;
  qty_after: number;
  /** SNAPSHOT of item.unit at write time (PLAN.md §1.5). */
  unit: string;
  /** unit_change only: qty_before is denominated in unit_before. */
  unit_before?: string;
  /** e.g. merge records the loser's name. */
  note?: string;
}

export interface ShoppingExtra {
  id: string;
  text: string;
  created_at: string;
  updated_at: string;
  /** Staged for checkout; absent while still on the shopping list. */
  carted_at?: string;
  /** Checkout = soft delete; hard-pruned after EXTRA_PRUNE_DAYS. */
  deleted_at: string | null;
}

export interface Settings {
  /** Event retention window. */
  retention_days: number;
  last_export_at: string | null;
  /** Stored, not derived — pruning can't distort it. */
  writes_since_export: number;
  /** When the last checkout completed. Pending cart contents have no
   *  midnight cutoff and survive until checked out or put back. */
  last_trip_ended_at: string | null;
  /** Locations declared by hand ("set up the garage freezer before filling
   *  it"): plain strings, unioned case-insensitively with the locations
   *  items already use, so an empty shelf can exist as a zero-count card.
   *  Never referenced by items — removing an entry touches nothing else. */
  declared_locations: string[];
  /** Goes into the export envelope. */
  device_label: string;
}

/** Full-fidelity export envelope (PLAN.md §1.1: tombstones + events included). */
export interface ExportEnvelope {
  app: "ambry";
  schema_version: number;
  exported_at: string;
  device_label: string;
  counts: { items: number; events: number; extras: number };
  items: Item[];
  events: HistoryEvent[];
  extras: ShoppingExtra[];
  settings: Settings;
}

// ---------------------------------------------------------------------------
// Constants (code, not settings — PLAN.md §5)
// ---------------------------------------------------------------------------

export const SCHEMA_VERSION = 1;

/** Ladder write values: tapping a rung recounts to this value. */
export const LADDER_WRITE = { full: 1, half: 0.5, low: 0.2, out: 0 } as const;
export type LadderRung = keyof typeof LADDER_WRITE;

/** Ladder read buckets: >= 0.75 full, >= 0.35 half, > 0 low, 0 out. */
export const LADDER_READ = { full: 0.75, half: 0.35 } as const;

/** Default threshold for ladder items so "Low" (0.2) crosses it. */
export const LADDER_DEFAULT_THRESHOLD = 0.25;

/** Quantities are rounded to this many decimals on every write. */
export const QTY_DECIMALS = 3;

export const DEFAULT_RETENTION_DAYS = 365;
/** Checked-off shopping extras are hard-pruned after this many days. */
export const EXTRA_PRUNE_DAYS = 7;

/** Export nag: badge at these limits, banner at double them. */
export const EXPORT_NAG_WRITES = 20;
export const EXPORT_NAG_DAYS = 7;

/** Seeded location suggestions (UI-level; storage is plain strings). */
export const SEED_LOCATIONS = ["pantry", "fridge", "freezer"];
/** Quick-create unit chip row. */
export const COMMON_UNITS = ["count", "bag", "jar", "can", "bottle", "box", "stick", "g"];

export const now = (): string => new Date().toISOString();
export const uuid = (): string => crypto.randomUUID();

/** Round to QTY_DECIMALS and clamp at zero — applied on every quantity write. */
export function roundQty(n: number): number {
  const f = 10 ** QTY_DECIMALS;
  return Math.max(0, Math.round(n * f) / f);
}
