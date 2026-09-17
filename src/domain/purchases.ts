import type { HistoryEvent } from "../types";
import { roundQty } from "../types";
import { sortEventsNewestFirst } from "./history";

export interface PurchaseAmount { amount: number; unit: string }

/** Receipt totals over the supplied trip window. Pair reversals per item,
 * retaining each event's unit even if the item has since changed units. */
export function purchaseAmounts(events: HistoryEvent[]): Map<string, PurchaseAmount[]> {
  const totals = new Map<string, PurchaseAmount[]>();
  const reversed = new Map<string, number>();
  for (const e of sortEventsNewestFirst(events)) {
    if (e.kind === "recount" && e.note === "put back") {
      reversed.set(e.item_id, (reversed.get(e.item_id) ?? 0) + 1);
    } else if (e.kind === "purchase") {
      const owed = reversed.get(e.item_id) ?? 0;
      if (owed > 0) { reversed.set(e.item_id, owed - 1); continue; }
      const rows = totals.get(e.item_id) ?? [];
      const unit = rows.find((r) => r.unit.trim().toLowerCase() === e.unit.trim().toLowerCase());
      const amount = e.qty_after - e.qty_before;
      if (unit) unit.amount = roundQty(unit.amount + amount);
      else rows.push({ amount: roundQty(amount), unit: e.unit });
      totals.set(e.item_id, rows);
    }
  }
  return totals;
}
