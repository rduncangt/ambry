/**
 * History presenter: the raw event log rendered as sentences ("Bought 2 —
 * now 3 jars"), newest first. Pure — reads events, writes nothing, and every
 * row remembers which event ids it speaks for so the UI's tap-to-delete can
 * hand them straight to the store. Legal under R2 (PLAN.md §2): events are
 * self-contained observations nothing references, so any of them can vanish
 * and nothing breaks — which is exactly what makes user-facing deletion of a
 * history row a record edit rather than surgery.
 */
import type { HistoryEvent } from "../types";
import { fmtQty, fmtQtyUnit } from "./format";

export interface HistoryRow {
  /** Every event this row speaks for — a reversal pair carries BOTH ids, so
   *  deleting the row deletes the whole story, never half of it. */
  ids: string[];
  label: string;
  sub: string | null;
  /** The row's instant (a reversal pair sits at the reversal's timestamp). */
  at: string;
  /** Quiet rendering: reversal rows — a retracted check-off is bookkeeping,
   *  not stock news. */
  muted: boolean;
}

/** A compensating recount that reversed a purchase — both put-back paths
 *  (the shopping view's Put back and the undo toast) mark it this way. */
const isPutBack = (e: HistoryEvent): boolean => e.kind === "recount" && e.note === "put back";

/**
 * Newest first with the append-position tiebreak (lifted from
 * purchaseRhythm): same-`at` events — a purchase and the put-back that
 * reversed it can land in one millisecond — order by INPUT position, later =
 * newer. Both feeders satisfy that assumption: doc.events is append-ordered,
 * and historyFor's stable sort keeps append order within a same-`at` run.
 */
export function sortEventsNewestFirst(events: HistoryEvent[]): HistoryEvent[] {
  const pos = new Map(events.map((e, i) => [e.id, i]));
  return [...events].sort((a, b) =>
    a.at === b.at ? (pos.get(b.id) ?? 0) - (pos.get(a.id) ?? 0) : a.at < b.at ? 1 : -1,
  );
}

/**
 * Build display rows from an item's events, newest first.
 *
 * Reversal pairing: each "put back" recount collapses together with the
 * nearest OLDER unpaired `purchase` of the same item_id (merge unions can
 * interleave two items' histories, and a reversal only ever reversed its own
 * item's purchase) into ONE muted row at the reversal's timestamp. A "put
 * back" whose purchase is gone (pruned, or deleted from this very list)
 * stands alone, muted, as "Put back".
 */
export function buildHistoryRows(events: HistoryEvent[], nowIso: string): HistoryRow[] {
  // The labels themselves are age-free; the UI renders ages and day headers
  // against its own clock. The parameter rides along like every other
  // clocked read-model so the pair travels together (see purchaseRhythm).
  void nowIso;
  const ordered = sortEventsNewestFirst(events);

  // Pair pass, newest-first: a reversal claims the nearest older unclaimed
  // purchase — the same one-cancels-the-next-older walk purchaseRhythm does,
  // but carrying ids so the pair can be deleted as one.
  const pairFor = new Map<string, HistoryEvent>(); // reversal id -> its purchase
  const claimed = new Set<string>(); // purchase ids folded into a pair
  ordered.forEach((e, i) => {
    if (!isPutBack(e)) return;
    for (let j = i + 1; j < ordered.length; j++) {
      const p = ordered[j];
      if (p === undefined || p.kind !== "purchase") continue;
      if (p.item_id !== e.item_id || claimed.has(p.id)) continue;
      claimed.add(p.id);
      pairFor.set(e.id, p);
      break;
    }
  });

  const rows: HistoryRow[] = [];
  for (const e of ordered) {
    if (e.kind === "purchase" && claimed.has(e.id)) continue; // lives in its reversal's row
    rows.push(toRow(e, pairFor.get(e.id)));
  }
  return rows;
}

/** One event (plus, for a paired reversal, the purchase it undid) as a row. */
function toRow(e: HistoryEvent, reversed: HistoryEvent | undefined): HistoryRow {
  const row = (label: string, sub: string | null = null, muted = false): HistoryRow => ({
    ids: [e.id],
    label,
    sub,
    at: e.at,
    muted,
  });
  switch (e.kind) {
    case "purchase":
      return row(`Bought ${fmtQty(e.qty_after - e.qty_before)} — now ${fmtQtyUnit(e.qty_after, e.unit)}`);
    case "use":
      return row(`Used ${fmtQty(e.qty_before - e.qty_after)} — now ${fmtQtyUnit(e.qty_after, e.unit)}`);
    case "add":
      return row(`Added ${fmtQty(e.qty_after - e.qty_before)} — now ${fmtQtyUnit(e.qty_after, e.unit)}`);
    case "recount": {
      if (isPutBack(e)) {
        if (reversed !== undefined) {
          return {
            ids: [reversed.id, e.id],
            label: `Bought ${fmtQty(reversed.qty_after - reversed.qty_before)}, then put back`,
            sub: null,
            at: e.at,
            muted: true,
          };
        }
        // Orphaned reversal (its purchase pruned or deleted): still honest,
        // still quiet.
        return row(`Put back — now ${fmtQtyUnit(e.qty_after, e.unit)}`, null, true);
      }
      // A recount landing on the same number is a verification, not noise.
      if (e.qty_before === e.qty_after) return row(`Confirmed ${fmtQtyUnit(e.qty_after, e.unit)}`);
      return row(`Counted ${fmtQtyUnit(e.qty_after, e.unit)}`, `was ${fmtQty(e.qty_before)}`);
    }
    case "create":
      return row(
        "Added to the pantry",
        e.qty_after > 0 ? `with ${fmtQtyUnit(e.qty_after, e.unit)}` : null,
      );
    case "delete":
      return row("Deleted");
    case "restore":
      return row("Restored");
    case "unit_change":
      // qty_before is denominated in unit_before when the unit itself moved;
      // package-size edits keep the unit (no unit_before) and tell their
      // story in the note, which rides along as the sub line.
      return row(
        `Unit changed — ${fmtQtyUnit(e.qty_before, e.unit_before ?? e.unit)} → ${fmtQtyUnit(e.qty_after, e.unit)}`,
        e.note ?? null,
      );
    case "merge":
      return row(e.note !== undefined && e.note !== "" ? `Absorbed “${e.note}”` : "Merged");
    case "import":
      return row("Imported");
  }
}
