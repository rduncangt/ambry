/** Optional shelf walk, opened only from Inventory tools.
 *  Counts have no review deadline. Leaving never creates a follow-up list
 *  or changes items the user did not touch. */
import { useState } from "preact/hooks";
import { itemsForShelfWalk, valuesInUse } from "../../store/selectors";
import type { Item } from "../../types";
import { QtyControl } from "../components";
import { useDoc, useNav, useStore, useToast } from "../hooks";
import "./reconcile.css";

interface Walk {
  label: string;
  single: boolean;
  // Freeze row order for the visit so edits cannot move another control
  // under the user's finger. This is UI state, never a persisted queue.
  ids: string[];
}

function countText(n: number): string {
  return `${n} ${n === 1 ? "item" : "items"}`;
}

export function ReconcileView() {
  const store = useStore();
  const doc = useDoc();
  const nav = useNav();
  const toast = useToast();
  const [walk, setWalk] = useState<Walk | null>(null);

  const startWalk = (label: string, location?: string | null): void => {
    setWalk({
      label,
      single: location !== undefined,
      ids: itemsForShelfWalk(doc, location).map((item) => item.id),
    });
  };

  if (walk !== null) {
    const byId = new Map(doc.items.map((item) => [item.id, item]));
    const rows = walk.ids.map((id) => byId.get(id))
      .filter((item): item is Item => item !== undefined && item.deleted_at === null);

    return (
      <section class="view">
        <header class="sticky-head recon-head">
          <h1 class="view-title">{walk.label}</h1>
          <button class="recon-switch" type="button" onClick={() => setWalk(null)}>Locations</button>
          <button class="btn" type="button" onClick={() => nav.setView("more")}>Done</button>
        </header>
        <p class="recon-caption">{countText(rows.length)}</p>
        <ul class="recon-list">
          {rows.map((item) => (
            <li key={item.id} class="recon-row">
              <div class="recon-row-head">
                <span class="row-title">{item.name}</span>
                {!walk.single && <span class="row-sub">{item.location ?? "elsewhere"}</span>}
              </div>
              <div class="recon-row-acts">
                <QtyControl item={item} />
                <button class="btn recon-ok" type="button" onClick={() => {
                  store.verify(item.id);
                  toast(`${item.name}: count confirmed`);
                }}>✓ Looks right</button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  const live = itemsForShelfWalk(doc);
  const locations = valuesInUse(doc, "location");
  const unfiled = live.filter((item) => item.location === null);
  const pickRow = (key: string, label: string, count: number, location?: string | null) => (
    <button key={key} class="recon-pick" type="button" onClick={() => startWalk(label, location)}>
      <span class="row-main">
        <span class="row-title">{label}</span>
        <span class="row-sub">{countText(count)}</span>
      </span>
      <span class="recon-chevron" aria-hidden="true">›</span>
    </button>
  );

  return (
    <section class="view">
      <header class="sticky-head"><h1 class="view-title">Walk the shelves</h1></header>
      {live.length === 0 ? <p class="muted">No items in the pantry yet.</p> : (
        <>
          <p class="recon-caption">Choose a location to view and adjust. Leave whenever you’re done.</p>
          <div class="recon-picks">
            {locations.map((loc) => pickRow(`loc:${loc}`, loc, live.filter((item) => item.location === loc).length, loc))}
            {unfiled.length > 0 && pickRow("elsewhere", "elsewhere", unfiled.length, null)}
            {pickRow("everywhere", "Everywhere", live.length)}
          </div>
        </>
      )}
    </section>
  );
}
