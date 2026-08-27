/**
 * InventoryView — the aisle answer (PLAN.md §4 M1, flow (a): pocket to
 * answer < 3 s). The answer lives IN the row: name + caption + QtyControl,
 * never one tap deeper. Search is pinned to the bottom (thumb zone, directly
 * above the tab bar) and is NOT auto-focused (PLAN.md §5 — the keyboard
 * jumping up on every launch is friction).
 *
 * Creation IS search (PLAN.md §1.4): when the query matches nothing exactly,
 * the list ends with a Create row; above it, duplicate candidates — including
 * tombstones, whose Restore keeps the UUID and history intact.
 */
import { useState } from "preact/hooks";
import { fmtAge } from "../../domain/format";
import { fold, normalKey } from "../../domain/normalize";
import { duplicateCandidates, searchItems } from "../../domain/search";
import { groupedInventory, liveItems } from "../../store/selectors";
import { now, type Item } from "../../types";
import { QtyControl } from "../components";
import { useDoc, useNav, useStore, useToast } from "../hooks";
import "./inventory.css";

/** UI hint only (code constant, not a setting): an item whose last human
 *  observation is older than this feeds the stale line's reconcile nudge. */
const STALE_DAYS = 30;
const DAY_MS = 86_400_000;

/** " · "-joined non-empty caption parts, or null so the row-sub line is
 *  omitted entirely (no empty second line inflating row height). */
function caption(...parts: (string | null)[]): string | null {
  const kept = parts.filter((p): p is string => p !== null && p.trim() !== "");
  return kept.length === 0 ? null : kept.join(" · ");
}

export function InventoryView() {
  const doc = useDoc();
  const nav = useNav();
  const [query, setQuery] = useState("");
  const nowIso = now();

  // fold("") === fold("  ,,") === "" — a query that folds to nothing keeps
  // the grouped view (searchItems would return [] for it anyway).
  const searching = fold(query) !== "";

  return (
    <section class="view inv-view">
      <h1 class="view-title">Pantry</h1>

      {searching ? (
        <SearchResults query={query} nowIso={nowIso} />
      ) : (
        <GroupedPantry nowIso={nowIso} />
      )}

      {/* Bottom-pinned search: fixed above the tab bar so the thumb reaches
          it one-handed. type="search" gives iOS the clear (✕) affordance. */}
      <div class="inv-searchbar">
        <input
          class="inv-search"
          type="search"
          autocomplete="off"
          placeholder="Search or add…"
          aria-label="Search pantry"
          value={query}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
      </div>
    </section>
  );
}

/** Empty query: location groups, alpha within (groupedInventory), with the
 *  flagged-count + stale-hint line on top. */
function GroupedPantry(props: { nowIso: string }) {
  const doc = useDoc();
  const nav = useNav();
  const groups = groupedInventory(doc);

  const live = liveItems(doc);
  const flagged = live.filter((i) => i.flagged).length;
  // "Stale" = last human observation too old. Never-verified items fall back
  // to created_at so a freshly seeded pantry doesn't open with everything
  // flagged stale — items age INTO the reconcile nudge instead.
  const staleBefore = Date.parse(props.nowIso) - STALE_DAYS * DAY_MS;
  const stale = live.filter(
    (i) => Date.parse(i.verified_at ?? i.created_at) < staleBefore,
  ).length;

  return (
    <div>
      {(flagged > 0 || stale > 0) && (
        <p class="inv-summary">
          {flagged > 0 && (
            <span class="muted">
              <span class="flag-dot" /> {flagged} flagged for shopping
            </span>
          )}
          {flagged > 0 && stale > 0 && <span class="muted"> · </span>}
          {stale > 0 && (
            <button
              class="inv-stale"
              type="button"
              onClick={() => nav.setView("reconcile")}
            >
              {stale} not checked in {STALE_DAYS}+ days ›
            </button>
          )}
        </p>
      )}

      {groups.length === 0 ? (
        <p class="muted">Nothing here yet — type a name below to add your first item.</p>
      ) : (
        groups.map((group) => (
          <section key={group.location}>
            <h2 class="inv-loc">{group.location}</h2>
            <ul class="inv-list">
              {group.items.map((item) => (
                // Location is the group header, so the caption carries only
                // the category.
                <ItemRow key={item.id} item={item} caption={caption(item.category)} />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

/** Non-empty query: flat ranked results, then duplicate candidates (incl.
 *  tombstones-with-restore), then the Create fallback row. */
function SearchResults(props: { query: string; nowIso: string }) {
  const doc = useDoc();
  const nav = useNav();
  const trimmed = props.query.trim();

  const results = searchItems(doc.items, props.query);
  const resultIds = new Set(results.map((i) => i.id));

  // "Matches nothing exactly" uses the §1.4 normalization (case, punctuation,
  // token order, naive plurals) over live names + aliases — a live exact
  // match means "tap it", so Create and the candidate section disappear.
  const key = normalKey(props.query);
  const hasExact = doc.items.some(
    (i) =>
      i.deleted_at === null &&
      [i.name, ...i.aliases].some((label) => normalKey(label) === key),
  );

  const candidates = hasExact
    ? []
    : duplicateCandidates(doc.items, props.query).filter(
        (i) =>
          // Live candidates the substring search already listed stay listed
          // once; merge losers are excluded because restoring one would
          // resurrect the exact duplicate the merge repaired (the survivor
          // carries its name as an alias and surfaces here instead).
          !resultIds.has(i.id) && !(i.deleted_at !== null && i.merged_into !== null),
      );

  return (
    <ul class="inv-list">
      {results.map((item) => (
        <ItemRow
          key={item.id}
          item={item}
          caption={caption(item.location, item.category)}
        />
      ))}
      {candidates.map((item) =>
        item.deleted_at === null ? (
          <ItemRow
            key={item.id}
            item={item}
            caption={caption(item.location, item.category)}
          />
        ) : (
          <RestoreRow key={item.id} item={item} nowIso={props.nowIso} />
        ),
      )}
      {!hasExact && (
        <li class="row">
          <button
            class="row-main inv-open"
            type="button"
            onClick={() => nav.openCreate(trimmed)}
          >
            <span class="row-title inv-create">Create “{trimmed}”</span>
          </button>
        </li>
      )}
    </ul>
  );
}

/** One live item: name area opens the detail overlay; QtyControl answers and
 *  writes in place (and owns the flag dot / 🔕 / Out badge / undo toast);
 *  the compact ⋯ target toggles the manual shopping flag. */
function ItemRow(props: { item: Item; caption: string | null }) {
  const store = useStore();
  const nav = useNav();
  const toast = useToast();
  const item = props.item;

  const flagLabel = item.flagged ? "Clear shopping flag" : "Flag for shopping";
  const toggleFlag = (): void => {
    // One tap each way keeps this reversible without an undo closure.
    if (item.flagged) {
      store.clearFlag(item.id);
      toast(`${item.name}: flag cleared`);
    } else {
      store.flagManual(item.id);
      toast(`${item.name} flagged for shopping`);
    }
  };

  return (
    <li class="row">
      <button class="row-main inv-open" type="button" onClick={() => nav.openItem(item.id)}>
        <span class="row-title">{item.name}</span>
        {props.caption !== null && <span class="row-sub">{props.caption}</span>}
      </button>
      <QtyControl item={item} />
      <button
        class="inv-more"
        type="button"
        title={flagLabel}
        aria-label={flagLabel}
        onClick={toggleFlag}
      >
        ⋯
      </button>
    </li>
  );
}

/** A tombstone duplicate candidate: Restore revives the same UUID with its
 *  history intact (PLAN.md §1.4) instead of minting a colliding new item. */
function RestoreRow(props: { item: Item; nowIso: string }) {
  const store = useStore();
  const toast = useToast();
  const item = props.item;
  return (
    <li class="row">
      <div class="row-main">
        <span class="row-title inv-deleted">{item.name}</span>
        <span class="row-sub">deleted {fmtAge(item.deleted_at, props.nowIso)}</span>
      </div>
      <button
        class="btn"
        type="button"
        onClick={() => {
          store.restore(item.id);
          toast(`Restored ${item.name}`);
        }}
      >
        Restore
      </button>
    </li>
  );
}
