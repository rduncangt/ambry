import { useState } from "preact/hooks";
import { fmtLevel } from "../../domain/format";
import type { OrganizationFields } from "../../domain/organize";
import { searchItems } from "../../domain/search";
import { alpha, liveItems, valuesInUse } from "../../store/selectors";
import { SEED_LOCATIONS } from "../../types";
import { Sheet } from "../components";
import { useDoc, useStore, useToast } from "../hooks";

/** Selection is temporary; Apply is one store command for the whole batch. */
export function OrganizeSheet(props: {
  initialLocation?: string | null;
  initialQuery: string;
  onClose: () => void;
}) {
  const doc = useDoc();
  const store = useStore();
  const toast = useToast();
  const [query, setQuery] = useState(props.initialQuery);
  const [location, setLocation] = useState(props.initialLocation === undefined ? "all" : `value:${props.initialLocation ?? ""}`);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState(false);
  const [move, setMove] = useState("keep");
  const [category, setCategory] = useState("keep");
  const [newLocation, setNewLocation] = useState("");
  const [newCategory, setNewCategory] = useState("");
  const [error, setError] = useState<string | null>(null);
  const live = liveItems(doc);
  const chosen = live.filter((i) => selected.has(i.id));
  const unique = (values: string[]) => [...new Map(values.map((v) => [v.toLowerCase(), v])).values()].sort(alpha);
  const locations = unique([...valuesInUse(doc, "location"), ...doc.settings.declared_locations, ...SEED_LOCATIONS]);
  const categories = unique(valuesInUse(doc, "category"));
  const shown = (query.trim() === "" ? [...live].sort((a,b) => alpha(a.name,b.name)) : searchItems(live, query))
    .filter((i) => location === "all" || `value:${i.location ?? ""}` === location);
  const allShown = shown.length > 0 && shown.every((i) => selected.has(i.id));
  const hiddenSelected = chosen.length - shown.filter((i) => selected.has(i.id)).length;
  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const fieldValue = (choice: string, typed: string): string | null | undefined =>
    choice === "keep" ? undefined : choice === "clear" ? null : choice === "new" ? typed.trim() : choice.slice(6);
  const fields: OrganizationFields = {};
  const moveValue = fieldValue(move, newLocation);
  const catValue = fieldValue(category, newCategory);
  if (moveValue !== undefined) fields.location = moveValue;
  if (catValue !== undefined) fields.category = catValue;
  const canApply = selected.size > 0 && (move !== "keep" || category !== "keep") &&
    (move !== "new" || newLocation.trim() !== "") && (category !== "new" || newCategory.trim() !== "");
  const apply = (e: Event) => {
    e.preventDefault();
    if (!canApply) return;
    try {
      const changes = store.organizeItems([...selected], fields);
      props.onClose();
      toast(changes.length === 0 ? "These items already match" : `Updated ${changes.length} ${changes.length === 1 ? "item" : "items"}`,
        changes.length === 0 ? undefined : () => store.undoOrganization(changes));
    } catch (e) { setError(e instanceof Error ? e.message : "Could not organize these items."); }
  };
  return (
    <Sheet open title={editing ? `Edit ${chosen.length} items` : "Organize items"} onClose={props.onClose}>
      {editing ? (
        <form class="organize-form" onSubmit={apply}>
          <button type="button" class="back-btn" onClick={() => { setEditing(false); setError(null); }}>‹ Selection</button>
          <p class="muted organize-preview">{chosen.map((i) => i.name).join(", ")}</p>
          <label class="organize-field">Location
            <select class="field-input" value={move} onChange={(e) => setMove(e.currentTarget.value)}>
              <option value="keep">Keep current locations</option>
              <option value="clear">No location</option>
              {locations.map((v) => <option key={v} value={`value:${v}`}>{v}</option>)}
              <option value="new">New location…</option>
            </select>
          </label>
          {move === "new" && <input class="field-input" aria-label="New location" placeholder="New location" value={newLocation} onInput={(e) => setNewLocation(e.currentTarget.value)} />}
          <label class="organize-field">Category
            <select class="field-input" value={category} onChange={(e) => setCategory(e.currentTarget.value)}>
              <option value="keep">Keep current categories</option>
              <option value="clear">No category</option>
              {categories.map((v) => <option key={v} value={`value:${v}`}>{v}</option>)}
              <option value="new">New category…</option>
            </select>
          </label>
          {category === "new" && <input class="field-input" aria-label="New category" placeholder="New category" value={newCategory} onInput={(e) => setNewCategory(e.currentTarget.value)} />}
          {error !== null && <p role="alert" class="settings-error">{error}</p>}
          <button class="btn btn-primary btn-big" type="submit" disabled={!canApply}>Apply to {chosen.length} items</button>
        </form>
      ) : (
        <div class="organize-form">
          <input class="field-input" type="search" aria-label="Search items to organize" placeholder="Search items…" value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
          <label class="organize-field">Show location
            <select class="field-input" value={location} onChange={(e) => setLocation(e.currentTarget.value)}>
              <option value="all">All locations</option>
              <option value="value:">No location</option>
              {locations.map((v) => <option key={v} value={`value:${v}`}>{v}</option>)}
            </select>
          </label>
          <div class="organize-actions">
            <span role="status">{chosen.length} selected</span>
            <button class="btn" type="button" disabled={shown.length === 0} onClick={() => setSelected((prev) => {
              const next = new Set(prev);
              for (const item of shown) { if (allShown) next.delete(item.id); else next.add(item.id); }
              return next;
            })}>{allShown ? "Deselect shown" : "Select shown"}</button>
            {selected.size > 0 && <button class="btn" type="button" onClick={() => setSelected(new Set())}>Clear selection</button>}
          </div>
          {hiddenSelected > 0 && <p class="muted">{hiddenSelected} selected outside this filter</p>}
          <div class="organize-list">
            {shown.length === 0 && <p class="muted">No matching items.</p>}
            {shown.map((item) => (
              <label key={item.id} class="organize-row">
                <input type="checkbox" checked={selected.has(item.id)} onChange={() => toggle(item.id)} />
                <span><span class="row-title">{item.name}</span><span class="row-sub">{[item.location, item.category, fmtLevel(item)].filter(Boolean).join(" · ")}</span></span>
              </label>
            ))}
          </div>
          <button class="btn btn-primary btn-big" type="button" disabled={chosen.length === 0} onClick={() => setEditing(true)}>Edit {chosen.length} selected items</button>
        </div>
      )}
    </Sheet>
  );
}
