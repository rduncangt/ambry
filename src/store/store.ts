/**
 * THE CHOKEPOINT (R1). Every mutation goes through a Store command. Each
 * command, in one synchronous pass: updates the item, appends (or coalesces)
 * its history event, evaluates flag transitions, stamps timestamps, bumps
 * writes_since_export, and schedules a debounced save (~100 ms, flushed on
 * pagehide). UI components never construct events or touch storage.
 *
 * Event coalescing: stepper bursts must settle into ONE event (PLAN.md §2).
 * Mechanism: if the doc's most recent event is for the same item, same kind
 * (add/use only), and within COALESCE_MS, update that event's qty_after and
 * `at` in place instead of appending. Safe under R2 (nothing references
 * events). All other kinds always append.
 *
 * Undo: a 5-second UI toast undoes the last quantity write as a COMPENSATING
 * recount event (history stays append-only) — lastQuantityWrite() feeds it.
 */
import {
  LADDER_DEFAULT_THRESHOLD,
  now,
  roundQty,
  uuid,
  type AmbryDoc,
  type DisplayMode,
  type EventKind,
  type ExportEnvelope,
  type Item,
  type LadderRung,
  type ShoppingExtra,
} from "../types";
import type { StorageAdapter } from "./adapter";
import type { BootStatus } from "./doc";
import type { UnitChangePlan } from "../domain/units";

export const COALESCE_MS = 2000;
export const SAVE_DEBOUNCE_MS = 100;

export interface CreateItemInput {
  name: string;
  unit?: string;                // default "count"
  quantity?: number;            // default 1
  category?: string | null;
  location?: string | null;
  notes?: string;
  display_mode?: DisplayMode;   // default "number"
  threshold?: number | null;
  package_size?: { amount: number; unit: string } | null;
  restock_amount?: number;      // default 1
  expiry?: string | null;
}

/** Editable fields NOT allowed here: quantity, unit, package_size (guarded flows). */
export interface EditItemFields {
  name?: string;
  aliases?: string[];
  notes?: string;
  category?: string | null;
  location?: string | null;
  display_mode?: DisplayMode;
  threshold?: number | null;
  restock_amount?: number;
  never_prompt?: boolean;
  expiry?: string | null;
  barcodes?: string[];
}

export interface ImportOutcome {
  ok: boolean;
  /** snapshot key the pre-import copy was written to */
  snapshotKey?: string;
}

export interface Store {
  // -- reading ------------------------------------------------------------
  getDoc(): AmbryDoc;
  subscribe(listener: () => void): () => void;
  bootStatus(): BootStatus;
  /** Most recent quantity-affecting event (for the undo toast), if within its undo window. */
  lastQuantityWrite(): { itemId: string; qtyBefore: number } | null;

  // -- item lifecycle -----------------------------------------------------
  /** Applies defaults; display_mode "ladder" with no threshold gets LADDER_DEFAULT_THRESHOLD. Emits `create`. */
  createItem(input: CreateItemInput): Item;
  /** Non-quantity field edits. display_mode -> "ladder" with null threshold also applies the ladder default. No event (updated_at only). */
  editItem(id: string, fields: EditItemFields): void;
  /** Soft delete / restore. Emit `delete` / `restore` (qty_before = qty_after = quantity). */
  softDelete(id: string): void;
  restore(id: string): void;

  // -- quantity (all round + clamp via roundQty; all evaluate flags) ------
  /** Stepper: kind `add` (delta > 0) or `use` (delta < 0), coalesced. */
  adjustQuantity(id: string, delta: number): void;
  /** Absolute entry: kind `recount`, stamps verified_at. */
  setQuantity(id: string, qty: number): void;
  /** Ladder tap: recount to the rung value, stamps verified_at. Caller handles the qty>1 confirm. */
  setLadderRung(id: string, rung: LadderRung): void;
  /** Shopping check-off: qty += amount ?? restock_amount, kind `purchase`, ALWAYS clears the flag. */
  purchase(id: string, amount?: number): void;
  /** Undo the last quantity write: compensating `recount` back to qtyBefore (no verified_at stamp). */
  undoQuantity(itemId: string, qtyBefore: number): void;

  // -- flags --------------------------------------------------------------
  flagManual(id: string): void;
  /** "Have plenty" / no longer needed (PLAN.md §1.2 fix 4). */
  clearFlag(id: string): void;
  setNeverPrompt(id: string, value: boolean): void;
  /** Audit ✓ — stamps verified_at, NO event. */
  verify(id: string): void;

  // -- guarded unit flows (PLAN.md §1.5) ----------------------------------
  /**
   * Apply a unit change. plan "convert": quantity AND threshold move together.
   * plan "reenter": caller supplies reentered values. Either way ONE
   * `unit_change` event (unit_before = old unit).
   */
  changeUnit(
    id: string,
    newUnit: string,
    plan: UnitChangePlan,
    reentered?: { quantity: number; threshold: number | null; package_size: { amount: number; unit: string } | null },
  ): void;
  /** Package-size edit with keep-amount/keep-count decision; records `unit_change` with a note. */
  resizePackage(id: string, newPackage: { amount: number; unit: string }, keep: "amount" | "count"): void;

  // -- merge (PLAN.md §2) --------------------------------------------------
  /** Loser -> tombstone with merged_into; survivor gains aliases/flag; `merge` event on survivor records resolvedQty. */
  mergeItems(survivorId: string, loserId: string, resolvedQty: number): void;

  // -- shopping extras -----------------------------------------------------
  addExtra(text: string): ShoppingExtra;
  /** Check-off = soft delete. */
  checkExtra(id: string): void;
  uncheckExtra(id: string): void;

  // -- backup / lifecycle --------------------------------------------------
  /** Envelope for the share sheet; does NOT mark exported (only a completed share does). */
  buildExport(): ExportEnvelope;
  /** Stamp last_export_at, zero writes_since_export. */
  recordExport(): void;
  /** Gated replace: snapshot current doc first ("pre-import-<iso>"), then swap in the (already migrated) doc. */
  importReplace(doc: AmbryDoc): ImportOutcome;
  /** Launch-time retention pass (prune.ts). */
  prune(): void;
  /** Immediate synchronous save (pagehide / visibilitychange). */
  flush(): void;
  /** Settings edits (retention_days, device_label). */
  updateSettings(fields: Partial<Pick<AmbryDoc["settings"], "retention_days" | "device_label">>): void;
}

/**
 * Create the store over an adapter. Loads (migrating if needed) immediately;
 * `bootStatus()` tells the UI whether to show the restore-first boot screen.
 * `deps.now`/`deps.uuid` are injectable for tests.
 */
export function createStore(
  adapter: StorageAdapter,
  deps: { now?: () => string; uuid?: () => string } = {},
): Store {
  throw new Error("TODO: implement (workflow)");
}
