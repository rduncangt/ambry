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
 * Undo: a 3-second UI toast undoes the last quantity write as a COMPENSATING
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
  type HistoryEvent,
  type Item,
  type LadderRung,
  type ShoppingExtra,
} from "../types";
import { DOC_KEY, SNAPSHOT_PREFIX, type StorageAdapter } from "./adapter";
import { loadDoc, writeSnapshot, type BootStatus } from "./doc";
import { flagTransition } from "../domain/flags";
import { rungValue } from "../domain/ladder";
import { planMerge } from "../domain/merge";
import { pruneDoc } from "../domain/prune";
import { buildExport as buildEnvelope } from "../domain/exportImport";
import { planPackageResize, type UnitChangePlan } from "../domain/units";

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
  lastQuantityWrite(): { itemId: string; qtyBefore: number; eventId: string } | null;
  /**
   * True while the most recent save attempt threw (e.g. quota exceeded). The
   * doc stays dirty so flush()/the next mutation retries; the next successful
   * save clears this.
   */
  saveError(): boolean;
  /**
   * True once another tab/context has written DOC_KEY behind this store. From
   * then on EVERY save is refused — overwriting would silently destroy the
   * other context's data — until a reload re-reads storage.
   */
  storageConflict(): boolean;

  // -- item lifecycle -----------------------------------------------------
  /** Applies defaults; display_mode "ladder" with no threshold gets LADDER_DEFAULT_THRESHOLD. Emits `create`. */
  createItem(input: CreateItemInput): Item;
  /** Non-quantity field edits. display_mode -> "ladder" with null threshold also applies the ladder default. No event (updated_at only). */
  editItem(id: string, fields: EditItemFields): void;
  /** Soft delete. Emits `delete` (qty_before = qty_after = quantity). */
  softDelete(id: string): void;
  /**
   * Undelete. Emits `restore` (qty_before = qty_after = quantity) and clears
   * merged_into: a restored merge-loser is a live item again, so its history
   * must stop resolving to the merge survivor.
   */
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
  /**
   * Put back from the cart: reverse the item's most recent purchase since
   * LOCAL midnight (the same same-day rule the inCart selector uses).
   * Quantity returns to that purchase event's qty_before via a compensating
   * `recount` (note "put back", NO verified_at stamp — nothing was observed,
   * a tap was retracted), and the flag re-raises (flag_source "manual",
   * flagged_at now) so the item goes back to To Buy. Silently no-ops when
   * the item has no purchase today.
   */
  /** Returns true when a same-day purchase was reversed; false when there
   *  was nothing to put back (e.g. the purchase happened before local
   *  midnight while the tab sat open) — callers must not claim success. */
  unpurchase(id: string): boolean;
  /**
   * Undo the last quantity write: compensating `recount` back to qtyBefore
   * (no verified_at stamp). Callers capture the item's flag triple BEFORE
   * their write and pass it as `restoreFlags`; those three fields are applied
   * in the SAME commit, overriding the compensating write's own flag
   * evaluation — undo must also put back flag state the original write
   * changed (a purchase's clear, a crossing's raise).
   */
  undoQuantity(
    itemId: string,
    qtyBefore: number,
    restoreFlags?: {
      flagged: boolean;
      flag_source: "threshold" | "manual" | null;
      flagged_at: string | null;
      /** Pre-write observation stamp: undoing a retracted first count must
       *  also un-count the item (null restores the "–" uncounted state), or the undo
       *  path manufactures the exact false-Out drift it exists to prevent. */
      verified_at?: string | null;
    },
    opts?: {
      /** Reversal marker for the event log (e.g. "put back" when undoing a
       *  purchase) — the inCart selector reads it to keep a reversed
       *  check-off out of the "In the cart" section. */
      note?: string;
    },
  ): void;

  // -- flags --------------------------------------------------------------
  flagManual(id: string): void;
  /** "Remove from list" / no longer needed (PLAN.md §1.2 fix 4). */
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
  /**
   * Remove the package definition (package_size -> null). Quantity and
   * threshold are untouched and the unit string does not change (so no
   * unit_before); records a `unit_change` event whose note carries the
   * change ("package 1000 g -> none"). No-op when there is no package.
   */
  clearPackageSize(id: string): void;

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
  /**
   * Gated replace: snapshot the current doc first ("pre-import-<iso>"), then
   * persist the (already migrated) new doc; ONLY a successful persist swaps
   * the in-memory doc. On failure (quota throw, storage conflict) memory and
   * the stored doc are both untouched and { ok: false } comes back — the app
   * must never keep running on an imported doc that never landed on disk.
   */
  importReplace(doc: AmbryDoc): ImportOutcome;
  /** Launch-time retention pass (prune.ts). */
  prune(): void;
  /**
   * Immediate synchronous save (pagehide / visibilitychange). A failed save
   * keeps the doc dirty and raises saveError(); a cross-context clobber
   * raises storageConflict() instead of overwriting.
   */
  flush(): void;
  /**
   * Snapshot inventory (SNAPSHOT_PREFIX keys on this store's adapter) with
   * UTF-8 sizes, sorted newest-first by key (snapshot names embed ISO
   * timestamps). Read-only.
   */
  listSnapshots(): { key: string; bytes: number }[];
  /** Raw text of one snapshot, or null when missing (or not a snapshot key). Read-only. */
  snapshotText(key: string): string | null;
  /**
   * Permanently remove one snapshot. Storage housekeeping, not a doc
   * mutation: no history event, writes_since_export does not move, and only
   * snapshot keys can ever be removed.
   */
  deleteSnapshot(key: string): void;
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
  const nowFn = deps.now ?? now;
  const uuidFn = deps.uuid ?? uuid;

  const loaded = loadDoc(adapter);
  let doc = loaded.doc;
  const status: BootStatus = loaded.status;

  const listeners = new Set<() => void>();
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  // Dirty tracking matters for the boot rule: an "empty" boot must never
  // persist its placeholder doc, so flush() on pagehide with no mutations
  // writes nothing (loadDoc deliberately did not persist it either).
  let dirty = false;
  // Set when a persist threw (quota); cleared by the next successful save.
  let saveFailed = false;
  // Set when DOC_KEY changed underneath us (another tab/context wrote);
  // permanent for this store's lifetime — only a reload re-reads storage.
  let conflict = false;
  // The exact raw string this store last read from / wrote to DOC_KEY.
  // Every persist compares storage against it first: any other value means
  // another context wrote, and saving would silently clobber its data.
  // Initialized right after load so a migrated boot remembers the bytes
  // loadDoc just saved back.
  let lastKnownRaw = adapter.get(DOC_KEY);

  function notify(): void {
    // Copy first so a listener unsubscribing (or subscribing) mid-notify
    // cannot skip or double-call anyone in this pass.
    for (const listener of [...listeners]) listener();
  }

  /** Cross-context clobber guard: false (and conflict latched) when DOC_KEY changed under us. */
  function storageStillOurs(): boolean {
    if (conflict) return false;
    const onDisk = adapter.get(DOC_KEY);
    if (onDisk !== null && onDisk !== lastKnownRaw) {
      conflict = true;
      notify();
      return false;
    }
    return true;
  }

  function persistNow(): void {
    if (!dirty) return;
    if (!storageStillOurs()) return; // stay dirty; saves are refused for good
    try {
      const raw = JSON.stringify(doc);
      adapter.set(DOC_KEY, raw);
      lastKnownRaw = raw;
      dirty = false;
      if (saveFailed) {
        // Recovery is UI-visible state (the save-failure banner comes down).
        saveFailed = false;
        notify();
      }
    } catch {
      // Quota (or any storage failure): stay dirty so flush()/the next
      // mutation retries, and surface the failure via saveError().
      saveFailed = true;
      notify();
    }
  }

  function flushNow(): void {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    persistNow();
  }

  function scheduleSave(): void {
    dirty = true;
    // Trailing debounce: each mutation restarts the window, so a burst of
    // writes costs one setItem after it settles.
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      persistNow();
    }, SAVE_DEBOUNCE_MS);
  }

  /** Common tail of every committed mutation. */
  function committed(countWrite = true): void {
    // writes_since_export is the export-nag's data-at-risk meter; pruning and
    // export bookkeeping pass false because they are not human edits at risk.
    if (countWrite) doc.settings.writes_since_export += 1;
    notify();
    scheduleSave();
  }

  function itemById(id: string): Item {
    const item = doc.items.find((i) => i.id === id);
    if (item === undefined) throw new Error(`Unknown item: ${id}`);
    return item;
  }

  function extraById(id: string): ShoppingExtra {
    const extra = doc.extras.find((x) => x.id === id);
    if (extra === undefined) throw new Error(`Unknown extra: ${id}`);
    return extra;
  }

  /** Kinds whose before/after are a real stock movement in ONE unit. */
  function isGestureKind(kind: EventKind): boolean {
    return kind === "add" || kind === "use" || kind === "recount" || kind === "purchase";
  }

  /**
   * THE one commit path for every event-emitting mutation: roundQty, event
   * append-or-coalesce, flag transition, verified_at option, updated_at,
   * writes_since_export, notify, debounced save.
   */
  function commitQuantity(
    item: Item,
    after: number,
    kind: EventKind,
    opts: {
      stampVerified?: boolean;
      unitBefore?: string;
      note?: string;
      restoreFlags?: {
        flagged: boolean;
        flag_source: "threshold" | "manual" | null;
        flagged_at: string | null;
        verified_at?: string | null;
      };
    } = {},
  ): void {
    const at = nowFn();
    const before = item.quantity;
    const rounded = roundQty(after);

    // Flags are evaluated against the item's PRE-write state, and only for
    // gesture kinds: a unit_change or merge moves the number across
    // denominations (before in the old unit, after in the new), so the
    // crossing test would compare incommensurable values and could raise a
    // flag for a pure re-labeling. create can never cross (before is 0), and
    // delete/restore keep before === after.
    const transition = isGestureKind(kind) ? flagTransition(item, before, rounded, kind) : "none";

    // Append-or-coalesce. Only the doc's very last event is a candidate:
    // any intervening event (other item, other kind) ends the burst.
    const last = doc.events[doc.events.length - 1];
    const coalescible = kind === "add" || kind === "use";
    if (
      coalescible &&
      last !== undefined &&
      last.item_id === item.id &&
      last.kind === kind &&
      Date.parse(at) - Date.parse(last.at) <= COALESCE_MS
    ) {
      // In-place update: qty_before stays the burst's origin, so the settled
      // event describes the whole burst (and undo returns to the pre-burst
      // value). Safe under R2 — nothing references events.
      last.qty_after = rounded;
      last.at = at;
    } else {
      const event: HistoryEvent = {
        id: uuidFn(),
        item_id: item.id,
        at,
        kind,
        qty_before: before,
        qty_after: rounded,
        // Snapshot of item.unit at write time; unit-change callers set
        // item.unit to the NEW unit before committing, so qty_after's
        // denomination is what lands here and qty_before's in unit_before.
        unit: item.unit,
      };
      if (opts.unitBefore !== undefined) event.unit_before = opts.unitBefore;
      if (opts.note !== undefined) event.note = opts.note;
      doc.events.push(event);
    }

    item.quantity = rounded;
    if (transition === "raise") {
      item.flagged = true;
      item.flag_source = "threshold";
      item.flagged_at = at;
    } else if (transition === "clear") {
      item.flagged = false;
      item.flag_source = null;
      item.flagged_at = null;
    }
    // Undo path: the caller captured these three fields as they stood BEFORE
    // the write being undone. They override the transition above — a
    // compensating recount must put back what the original write changed (a
    // purchase's clear, a crossing's raise), not re-derive flag state from a
    // movement the user just retracted.
    if (opts.restoreFlags !== undefined) {
      item.flagged = opts.restoreFlags.flagged;
      item.flag_source = opts.restoreFlags.flag_source;
      item.flagged_at = opts.restoreFlags.flagged_at;
      // Applied after the stampVerified option so a compensating recount puts
      // the observation stamp back exactly where it was (including null).
      if ("verified_at" in opts.restoreFlags) item.verified_at = opts.restoreFlags.verified_at ?? null;
    }
    // recount-family only, and NOT the undo compensator: the caller decides.
    if (opts.stampVerified === true) item.verified_at = at;
    item.updated_at = at;
    committed();
  }

  return {
    // -- reading ------------------------------------------------------------
    getDoc: () => doc,

    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    bootStatus: () => status,

    saveError: () => saveFailed,

    storageConflict: () => conflict,

    lastQuantityWrite() {
      // Pure scan over the log, newest first — no extra state to persist or
      // to fall out of sync (the 3 s window itself is UI-owned toast state).
      for (let i = doc.events.length - 1; i >= 0; i--) {
        const e = doc.events[i];
        if (e === undefined) continue;
        if (isGestureKind(e.kind)) return { itemId: e.item_id, qtyBefore: e.qty_before, eventId: e.id };
      }
      return null;
    },

    // -- item lifecycle -----------------------------------------------------
    createItem(input) {
      const at = nowFn();
      const display_mode = input.display_mode ?? "number";
      let threshold = input.threshold ?? null;
      // Ladder items need a threshold for "Low" (0.2) to cross — same rule
      // editItem applies when switching modes later.
      if (display_mode === "ladder" && threshold === null) threshold = LADDER_DEFAULT_THRESHOLD;

      const item: Item = {
        id: uuidFn(),
        name: input.name,
        aliases: [],
        notes: input.notes ?? "",
        category: input.category ?? null,
        location: input.location ?? null,
        unit: input.unit ?? "count",
        // 0 here so the create event records 0 -> initial stock; the commit
        // path below writes the real starting quantity.
        quantity: 0,
        package_size: input.package_size ?? null,
        display_mode,
        threshold,
        flagged: false,
        flag_source: null,
        flagged_at: null,
        restock_amount: input.restock_amount ?? 1,
        never_prompt: false,
        expiry: input.expiry ?? null,
        barcodes: [],
        verified_at: null,
        merged_into: null,
        created_at: at,
        updated_at: at,
        deleted_at: null,
      };
      doc.items.push(item);
      commitQuantity(item, input.quantity ?? 1, "create");
      return item;
    },

    editItem(id, fields) {
      const item = itemById(id);
      if (fields.name !== undefined) item.name = fields.name;
      if (fields.aliases !== undefined) item.aliases = fields.aliases;
      if (fields.notes !== undefined) item.notes = fields.notes;
      if (fields.category !== undefined) item.category = fields.category;
      if (fields.location !== undefined) item.location = fields.location;
      if (fields.display_mode !== undefined) item.display_mode = fields.display_mode;
      if (fields.threshold !== undefined) item.threshold = fields.threshold;
      if (fields.restock_amount !== undefined) item.restock_amount = fields.restock_amount;
      if (fields.never_prompt !== undefined) item.never_prompt = fields.never_prompt;
      if (fields.expiry !== undefined) item.expiry = fields.expiry;
      if (fields.barcodes !== undefined) item.barcodes = fields.barcodes;
      // Same rule as createItem: entering ladder mode without a threshold
      // gets the default, so "Low" always has something to cross. (An edit
      // that explicitly supplies a threshold alongside the switch keeps it —
      // the threshold assignment above ran first.)
      if (fields.display_mode === "ladder" && item.threshold === null) {
        item.threshold = LADDER_DEFAULT_THRESHOLD;
      }
      item.updated_at = nowFn();
      committed();
    },

    softDelete(id) {
      const item = itemById(id);
      // Idempotent: a second tap must not mint a second tombstone event.
      if (item.deleted_at !== null) return;
      item.deleted_at = nowFn();
      commitQuantity(item, item.quantity, "delete");
    },

    restore(id) {
      const item = itemById(id);
      if (item.deleted_at === null) return;
      item.deleted_at = null;
      // A merge-loser's pointer must not survive restoration: while it
      // stands, ALL the item's history — past and future — keeps resolving
      // to the merge survivor, and a later reverse merge would create a
      // merged_into cycle between the pair.
      item.merged_into = null;
      commitQuantity(item, item.quantity, "restore");
    },

    // -- quantity -----------------------------------------------------------
    adjustQuantity(id, delta) {
      if (delta === 0) return; // a zero step is not an observation
      const item = itemById(id);
      commitQuantity(item, item.quantity + delta, delta > 0 ? "add" : "use");
    },

    setQuantity(id, qty) {
      const item = itemById(id);
      commitQuantity(item, qty, "recount", { stampVerified: true });
    },

    setLadderRung(id, rung) {
      const item = itemById(id);
      commitQuantity(item, rungValue(rung), "recount", { stampVerified: true });
    },

    purchase(id, amount) {
      const item = itemById(id);
      commitQuantity(item, item.quantity + (amount ?? item.restock_amount), "purchase");
    },

    unpurchase(id) {
      const item = itemById(id);
      // Same "today" as the inCart selector: the shopper's LOCAL midnight,
      // not UTC's — the two must agree on which purchases are put-backable.
      const midnightLocal = new Date(nowFn());
      midnightLocal.setHours(0, 0, 0, 0);
      const midnight = midnightLocal.getTime();
      // Newest-first scan for the item's most recent same-day purchase.
      let target: HistoryEvent | undefined;
      for (let i = doc.events.length - 1; i >= 0; i--) {
        const e = doc.events[i];
        if (e === undefined || e.item_id !== id || e.kind !== "purchase") continue;
        if (Date.parse(e.at) >= midnight) target = e;
        break; // an older most-recent purchase means nothing bought today
      }
      if (target === undefined) return false; // no same-day purchase: nothing to put back
      // Through the normal commit path. restoreFlags is the same in-commit
      // flag override the undo path uses: the re-raise must land atomically
      // with the quantity reversal, and "manual"/now is honest provenance —
      // putting it back on the list IS a fresh human decision. No
      // verified_at key, so the observation stamp stays untouched.
      // Reverse the purchase's DELTA rather than restoring its qty_before:
      // identical when nothing intervened, but a human recount between
      // check-off and put-back must survive — snapping to qty_before would
      // wipe an observation and leave verified_at vouching for a number
      // nobody holds (manufactured drift).
      commitQuantity(item, item.quantity - (target.qty_after - target.qty_before), "recount", {
        note: "put back",
        restoreFlags: { flagged: true, flag_source: "manual", flagged_at: nowFn() },
      });
      return true;
    },

    undoQuantity(itemId, qtyBefore, restoreFlags, opts) {
      const item = itemById(itemId);
      // Compensating recount, NOT a human observation: no verified_at stamp
      // (the human confirmed nothing — they retracted a tap). restoreFlags,
      // when the caller captured it, rides in the same commit so undo also
      // reverses flag changes the retracted write made.
      const o: Parameters<typeof commitQuantity>[3] = { restoreFlags };
      if (opts?.note !== undefined) o.note = opts.note;
      commitQuantity(item, qtyBefore, "recount", o);
    },

    // -- flags --------------------------------------------------------------
    flagManual(id) {
      const item = itemById(id);
      // Already-flagged: keep the original provenance and flagged_at so the
      // shopping list's oldest-first order does not reshuffle.
      if (item.flagged) return;
      const at = nowFn();
      item.flagged = true;
      item.flag_source = "manual";
      item.flagged_at = at;
      item.updated_at = at;
      committed();
    },

    clearFlag(id) {
      const item = itemById(id);
      if (!item.flagged) return;
      item.flagged = false;
      item.flag_source = null;
      item.flagged_at = null;
      item.updated_at = nowFn();
      committed();
    },

    setNeverPrompt(id, value) {
      const item = itemById(id);
      if (item.never_prompt === value) return;
      // Suppresses future auto-raise ONLY — an existing flag stays up.
      item.never_prompt = value;
      item.updated_at = nowFn();
      committed();
    },

    verify(id) {
      const item = itemById(id);
      const at = nowFn();
      // "✓ looks right" is a stamp-only observation: NO event (PLAN.md §2
      // Reconciliation), but it is still a committed mutation.
      item.verified_at = at;
      item.updated_at = at;
      committed();
    },

    // -- guarded unit flows -------------------------------------------------
    changeUnit(id, newUnit, plan, reentered) {
      const item = itemById(id);
      const unitBefore = item.unit;

      let quantity: number;
      if (plan.kind === "convert") {
        quantity = plan.quantity;
        // Quantity AND threshold move together — never one without the other
        // (§1.5). roundQty on the threshold kills conversion float noise the
        // same way the commit path does for quantity.
        item.threshold = plan.threshold === null ? null : roundQty(plan.threshold);
        item.package_size = plan.package_size;
      } else {
        if (reentered === undefined) {
          throw new Error("Unit change with no conversion path requires re-entered values");
        }
        quantity = reentered.quantity;
        item.threshold = reentered.threshold === null ? null : roundQty(reentered.threshold);
        item.package_size = reentered.package_size;
      }

      // New unit goes on the item FIRST so the event's `unit` snapshot is the
      // one qty_after is denominated in; qty_before keeps unit_before.
      item.unit = newUnit;
      commitQuantity(item, quantity, "unit_change", { unitBefore });
    },

    resizePackage(id, newPackage, keep) {
      const item = itemById(id);
      const before = item.package_size;
      // Domain planning: keep-amount rescales quantity+threshold through the
      // package ratio; keep-count leaves the numbers (their physical meaning
      // changes). Both come from the pure planner.
      const plan = planPackageResize(item, newPackage, keep);
      const beforeText = before === null ? "none" : `${before.amount} ${before.unit}`;
      const note = `package ${beforeText} -> ${newPackage.amount} ${newPackage.unit} (keep ${keep})`;
      item.package_size = { ...newPackage };
      item.threshold = plan.threshold === null ? null : roundQty(plan.threshold);
      // The unit string is unchanged (only its physical meaning moved), so no
      // unit_before on the event — the note carries the package change.
      commitQuantity(item, plan.quantity, "unit_change", { note });
    },

    clearPackageSize(id) {
      const item = itemById(id);
      const before = item.package_size;
      // Nothing to clear: minting a "package none -> none" event is noise.
      if (before === null) return;
      const note = `package ${before.amount} ${before.unit} -> none`;
      item.package_size = null;
      // Quantity and threshold are untouched — dropping the package changes
      // no numbers, only the bag<->contents bookkeeping. The unit string is
      // unchanged too, so no unit_before; the note carries the change.
      commitQuantity(item, item.quantity, "unit_change", { note });
    },

    // -- merge --------------------------------------------------------------
    mergeItems(survivorId, loserId, resolvedQty) {
      const survivor = itemById(survivorId);
      const loser = itemById(loserId);
      const plan = planMerge(survivor, loser); // throws on survivor === loser
      const at = nowFn();

      survivor.aliases = plan.aliases;
      if (plan.flagged && !survivor.flagged) {
        // The flag ORs across the pair; when the loser is the flagged half,
        // its provenance rides along (fall back to "manual"/now for a
        // hand-built doc missing them).
        survivor.flagged = true;
        survivor.flag_source = loser.flag_source ?? "manual";
        survivor.flagged_at = loser.flagged_at ?? at;
      }

      // Loser: tombstone + pointer. Its events are NEVER rewritten — history
      // views union over the merged_into chain (domain/merge.historyFor).
      loser.deleted_at = at;
      loser.merged_into = survivor.id;
      loser.updated_at = at;

      // One merge event, on the survivor, note = loser's name.
      commitQuantity(survivor, resolvedQty, "merge", { note: loser.name });
    },

    // -- shopping extras ----------------------------------------------------
    addExtra(text) {
      const at = nowFn();
      const extra: ShoppingExtra = {
        id: uuidFn(),
        text,
        created_at: at,
        updated_at: at,
        deleted_at: null,
      };
      doc.extras.push(extra);
      committed();
      return extra;
    },

    checkExtra(id) {
      const extra = extraById(id);
      if (extra.deleted_at !== null) return;
      const at = nowFn();
      extra.deleted_at = at;
      extra.updated_at = at;
      committed();
    },

    uncheckExtra(id) {
      const extra = extraById(id);
      if (extra.deleted_at === null) return;
      const at = nowFn();
      extra.deleted_at = null;
      extra.updated_at = at;
      committed();
    },

    // -- backup / lifecycle -------------------------------------------------
    buildExport() {
      // Read-only: only a COMPLETED share marks the doc exported, so an
      // abandoned share sheet cannot silently reset the nag.
      return buildEnvelope(doc, nowFn());
    },

    recordExport() {
      doc.settings.last_export_at = nowFn();
      doc.settings.writes_since_export = 0;
      committed(false);
    },

    importReplace(newDoc) {
      // The clobber guard gates imports like any other persist: overwriting
      // a doc another context wrote destroys that context's data just the
      // same whether the bytes came from a mutation or an import file.
      if (!storageStillOurs()) return { ok: false };
      const at = nowFn();
      const reason = `pre-import-${at}`;
      try {
        // Snapshot the IN-MEMORY doc (it may be ahead of storage inside the
        // debounce window) — the import gate's promised escape hatch.
        writeSnapshot(adapter, reason, JSON.stringify(doc));
        // Persist FIRST, swap only on success: if this write throws (quota),
        // the app must keep running on the doc storage still holds — never
        // on an in-memory imported doc that a later debounced save would
        // silently persist behind an "import failed" message. And replace
        // persists immediately regardless: a wholesale swap must not sit in
        // a 100 ms window where a page kill leaves the OLD doc on disk under
        // the user's belief they restored.
        const raw = JSON.stringify(newDoc);
        adapter.set(DOC_KEY, raw);
        lastKnownRaw = raw;
      } catch {
        // Snapshot or save failed (e.g. quota): memory AND storage stand
        // untouched — the running app and the persisted doc still agree.
        return { ok: false };
      }
      doc = newDoc;
      // Reset save tracking: storage now holds exactly this doc, so nothing
      // is dirty, a pending debounce would only re-save it, and any earlier
      // quota failure was just superseded by a successful write.
      if (saveTimer !== null) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      dirty = false;
      saveFailed = false;
      notify();
      return { ok: true, snapshotKey: SNAPSHOT_PREFIX + reason };
    },

    prune() {
      const result = pruneDoc(doc, nowFn());
      // Same-reference result means nothing was pruned: no notify, no save.
      if (result.doc === doc) return;
      doc = result.doc;
      // Housekeeping, not a human edit: writes_since_export must not move
      // ("stored, not derived — pruning can't distort it").
      committed(false);
    },

    flush: flushNow,

    listSnapshots() {
      // Snapshot names embed ISO timestamps (pre-import-<iso>, corrupt-<iso>),
      // so a descending lexicographic sort is newest-first for those; the few
      // undated keys (pre-migrate-vN) simply sort among them.
      return adapter
        .keys()
        .filter((k) => k.startsWith(SNAPSHOT_PREFIX))
        .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
        .map((key) => ({
          key,
          // UTF-8 size — what a shared/downloaded copy of the text weighs.
          bytes: new TextEncoder().encode(adapter.get(key) ?? "").length,
        }));
    },

    snapshotText(key) {
      // Prefix-guarded so the snapshot API can never become a general
      // storage peephole (the live doc has getDoc()).
      if (!key.startsWith(SNAPSHOT_PREFIX)) return null;
      return adapter.get(key);
    },

    deleteSnapshot(key) {
      // Prefix-guarded: this must never be able to remove the live doc.
      if (!key.startsWith(SNAPSHOT_PREFIX)) return;
      adapter.remove(key);
      // Storage housekeeping, not a doc mutation: no event, nothing dirty,
      // writes_since_export untouched. Notify so snapshot lists re-read.
      notify();
    },

    updateSettings(fields) {
      if (fields.retention_days !== undefined) doc.settings.retention_days = fields.retention_days;
      if (fields.device_label !== undefined) doc.settings.device_label = fields.device_label;
      committed();
    },
  };
}
