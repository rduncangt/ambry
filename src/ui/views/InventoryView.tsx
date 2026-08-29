/**
 * InventoryView — the aisle answer (PLAN.md §4 M1, flow (a): pocket to
 * answer < 3 s). The answer lives IN the row: name + QtyControl, never one
 * tap deeper. Search is pinned to the bottom (thumb zone, directly above the
 * tab bar) and is NOT auto-focused (PLAN.md §5 — the keyboard jumping up on
 * every launch is friction).
 *
 * Three states, all under one sticky screen header and the same search bar:
 *   1. Default — one tappable card per location. A seeded catalog is mostly
 *      uncounted "?" rows; a flat list buries the handful of real counts, so
 *      the directory replaces it. (An earlier "Low & flagged" strip above
 *      the cards is gone: low items flag themselves now and the Shopping tab
 *      lists them — here it was noise.)
 *   2. Location open — that shelf's counted rows, flagged-first (no category
 *      caption: inside one shelf it is noise), with the uncounted pile
 *      collapsed behind a "not counted yet" divider.
 *   3. Searching — flat ranked results across ALL items regardless of open
 *      location; clearing the query drops back to whichever state was
 *      underneath. Creation IS search (PLAN.md §1.4): when the query matches
 *      nothing exactly, the list ends with a Create row; above it, duplicate
 *      candidates — including tombstones, whose Restore keeps the UUID and
 *      history intact.
 *
 * All of this is component state on purpose: tab switches may reset it
 * (PLAN.md §5 — no launch-state memory).
 */
import { useState } from "preact/hooks";
import { fmtAge } from "../../domain/format";
import { fold, normalKey } from "../../domain/normalize";
import { duplicateCandidates, searchItems } from "../../domain/search";
import {
  STALE_DAYS,
  alpha,
  itemsInLocation,
  locationSummaries,
  staleCount,
  type LocationSummary,
} from "../../store/selectors";
import { now, type Item } from "../../types";
import { QtyControl } from "../components";
import { useDoc, useNav, useStore, useToast } from "../hooks";
import "./inventory.css";

/** " · "-joined non-empty caption parts, or null so the row-sub line is
 *  omitted entirely (no empty second line inflating row height). */
function caption(...parts: (string | null)[]): string | null {
  const kept = parts.filter((p): p is string => p !== null && p.trim() !== "");
  return kept.length === 0 ? null : kept.join(" · ");
}

/** First letter only — CSS `capitalize` would title-case every word of a
 *  multi-word location ("top shelf" -> "Top Shelf"). */
function capFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * The order a location visit opens with: counted rows flagged-first (the
 * owner's "move the items in the shopping cart to the top"), alphabetical
 * within each group. Computed ONCE per visit, from flag state at open —
 * see visitSnapshot / splitByVisit.
 */
function countedOrderAtOpen(counted: Item[]): string[] {
  const flagged = counted.filter((i) => i.flagged).sort((a, b) => alpha(a.name, b.name));
  const rest = counted.filter((i) => !i.flagged).sort((a, b) => alpha(a.name, b.name));
  return [...flagged, ...rest].map((i) => i.id);
}

/** Both per-visit snapshots, taken together the moment the shelf opens. */
function visitSnapshot(live: { counted: Item[]; uncounted: Item[] }): {
  countedOrder: string[];
  uncountedIds: Set<string>;
} {
  return {
    countedOrder: countedOrderAtOpen(live.counted),
    uncountedIds: new Set(live.uncounted.map((i) => i.id)),
  };
}

/**
 * Re-partition a location's live rows by the snapshots taken when the shelf
 * was opened. VISIT-SNAPSHOT INVARIANT: the row order is computed ONCE at
 * open and never resorts while the shelf stays open —
 * - an item counted DURING the visit keeps its slot in the uncounted tail
 *   (showing its fresh value) instead of jumping into the counted section
 *   mid-burst;
 * - the counted section renders in `countedOrder`, the flagged-first
 *   (alpha within each group) order as flag state stood AT OPEN — taken the
 *   same moment as the uncounted Set — so cart-toggling or purchasing
 *   mid-visit cannot shuffle rows under the finger;
 * - newly created/moved-in items APPEND after the snapshot rows (alpha among
 *   themselves); deleted/moved-away rows simply drop out.
 * A re-shuffle under the finger would land the next tap on a different
 * item's control; the fresh order arrives on the next visit.
 */
function splitByVisit(
  live: { counted: Item[]; uncounted: Item[] },
  snapshot: { countedOrder: string[]; uncountedIds: Set<string> },
): { counted: Item[]; uncounted: Item[] } {
  const all = [...live.counted, ...live.uncounted];
  const byName = (a: Item, b: Item): number => alpha(a.name, b.name);
  const slot = new Map(snapshot.countedOrder.map((id, i) => [id, i]));
  const counted = all
    .filter((i) => !snapshot.uncountedIds.has(i.id))
    .sort((a, b) => {
      const sa = slot.get(a.id);
      const sb = slot.get(b.id);
      if (sa !== undefined && sb !== undefined) return sa - sb;
      if (sa !== undefined) return -1; // snapshot rows keep their slots
      if (sb !== undefined) return 1; // new rows append after them
      return byName(a, b);
    });
  return {
    counted,
    uncounted: all.filter((i) => snapshot.uncountedIds.has(i.id)).sort(byName),
  };
}

export function InventoryView() {
  const doc = useDoc();
  const nav = useNav();
  const [query, setQuery] = useState("");
  /** Which shelf is open. Outer null = the card directory; the wrapper
   *  exists because the "elsewhere" bucket IS the null location, so a bare
   *  `string | null` could not also mean "nothing open". `uncountedIds` and
   *  `countedOrder` are the visit-long snapshots (uncounted pile + the
   *  flagged-first counted order, both as they stood at open) that
   *  splitByVisit() renders by. */
  const [open, setOpen] = useState<{
    location: string | null;
    countedOrder: string[];
    uncountedIds: Set<string>;
  } | null>(null);
  /** Uncounted pile revealed? Lives up here (not in LocationItems) so a
   *  search interlude does not reset it while the location stays open. */
  const [showUncounted, setShowUncounted] = useState(false);
  const nowIso = now();

  // fold("") === fold("  ,,") === "" — a query that folds to nothing keeps
  // the underlying state (searchItems would return [] for it anyway).
  const searching = fold(query) !== "";

  const openLocation = (location: string | null): void => {
    const split = itemsInLocation(doc, location);
    setOpen({ location, ...visitSnapshot(split) });
    // Collapsed on every fresh open — the divider is the reveal gesture —
    // UNLESS there is nothing counted to protect: an all-uncounted shelf
    // (the dominant state of a freshly seeded pantry) behind a collapsed
    // divider reads as a broken, near-blank screen.
    setShowUncounted(split.counted.length === 0);
  };
  const closeLocation = (): void => {
    setOpen(null);
    setShowUncounted(false);
  };

  // Search ranges over ALL items, so its header (and the default state's)
  // is the screen's own; only a non-searching open location retitles it.
  // openLive feeds the caption (progress should move as you count); the rows
  // render from the visit-frozen partition, which deliberately does not.
  const openLive = open !== null && !searching ? itemsInLocation(doc, open.location) : null;
  const openSplit =
    open !== null && openLive !== null ? splitByVisit(openLive, open) : null;
  const stale = staleCount(doc, nowIso);

  return (
    <section class="view inv-view">
      {/* Opaque sticky screen header: rows visibly disappear under it
          instead of mingling with the status bar (body::after mask stays as
          belt-and-braces). */}
      <header class="sticky-head">
        {openLive !== null && open !== null ? (
          <>
            {/* "‹ Locations", not "‹ Pantry": directly above a location
                titled "Pantry" (the physical closet) the tab's name would
                mean two different places in one breath — the label names
                the card directory this returns to. */}
            <button class="back-btn" type="button" onClick={closeLocation}>
              ‹ Locations
            </button>
            <h1 class="view-title">{capFirst(open.location ?? "elsewhere")}</h1>
            <p class="sticky-caption muted">
              {openLive.counted.length} of {openLive.counted.length + openLive.uncounted.length}{" "}
              counted
            </p>
          </>
        ) : (
          <>
            <h1 class="view-title">Pantry</h1>
            {/* The reconcile nudge is the screen caption. The canonical
                staleness rule lives in the selector so this line and the
                More tab can never disagree. */}
            {!searching && stale > 0 && (
              <p class="inv-summary">
                <button class="inv-stale" type="button" onClick={() => nav.setView("reconcile")}>
                  {stale} not checked in {STALE_DAYS}+ days ›
                </button>
              </p>
            )}
          </>
        )}
      </header>

      {searching ? (
        <SearchResults query={query} nowIso={nowIso} openLocation={open} />
      ) : openSplit !== null ? (
        <LocationItems
          split={openSplit}
          showUncounted={showUncounted}
          onToggleUncounted={() => setShowUncounted(!showUncounted)}
        />
      ) : (
        <PantryHome onOpen={openLocation} />
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

/** Default state: one card per location. (The old "Low & flagged" strip is
 *  gone — low items flag themselves and the Shopping tab lists them; the
 *  location cards keep their low/uncounted markers.) */
function PantryHome(props: { onOpen: (location: string | null) => void }) {
  const doc = useDoc();
  const summaries = locationSummaries(doc);

  return (
    <div>
      {summaries.length === 0 ? (
        <p class="muted">Nothing here yet — type a name below to add your first item.</p>
      ) : (
        <ul class="loc-cards">
          {summaries.map((s) => (
            <li key={s.location ?? ""}>
              <LocationCard summary={s} onOpen={props.onOpen} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One tappable shelf card: name, size, and only the markers that matter. */
function LocationCard(props: {
  summary: LocationSummary;
  onOpen: (location: string | null) => void;
}) {
  const s = props.summary;
  return (
    <button class="loc-card" type="button" onClick={() => props.onOpen(s.location)}>
      <span class="loc-card-main">
        <span class="loc-card-name">{capFirst(s.location ?? "elsewhere")}</span>
        <span class="loc-card-meta">
          {s.total} {s.total === 1 ? "item" : "items"}
          {s.low > 0 && (
            <>
              {" · "}
              <span class="loc-card-low">{s.low} low</span>
            </>
          )}
          {s.uncounted > 0 && <>{` · ${s.uncounted} not counted`}</>}
        </span>
      </span>
      <span class="loc-card-chevron" aria-hidden="true">
        ›
      </span>
    </button>
  );
}

/** Open location: counted rows (captionless — the shelf IS the context),
 *  then the uncounted pile behind its collapsed divider. */
function LocationItems(props: {
  split: { counted: Item[]; uncounted: Item[] };
  showUncounted: boolean;
  onToggleUncounted: () => void;
}) {
  const { counted, uncounted } = props.split;

  if (counted.length === 0 && uncounted.length === 0) {
    // Reachable when the last item here is deleted/moved while open.
    return <p class="muted">Nothing stored here right now.</p>;
  }

  return (
    <ul class="inv-list">
      {counted.map((item) => (
        <ItemRow key={item.id} item={item} caption={null} />
      ))}
      {uncounted.length > 0 && (
        <li class="row">
          <button
            class="inv-uncounted-toggle"
            type="button"
            aria-expanded={props.showUncounted}
            onClick={props.onToggleUncounted}
          >
            <span>{uncounted.length} not counted yet</span>
            <span
              class={`inv-chevron${props.showUncounted ? " inv-chevron-open" : ""}`}
              aria-hidden="true"
            >
              ›
            </span>
          </button>
        </li>
      )}
      {props.showUncounted &&
        uncounted.map((item) => <ItemRow key={item.id} item={item} caption={null} />)}
    </ul>
  );
}

/** Non-empty query: flat ranked results, then duplicate candidates (incl.
 *  tombstones-with-restore), then the Create fallback row. */
function SearchResults(props: {
  query: string;
  nowIso: string;
  /** The location open under the search interlude (its wrapper shape), so
   *  Create files the new item where the user is standing. */
  openLocation: { location: string | null } | null;
}) {
  const doc = useDoc();
  const nav = useNav();
  const trimmed = props.query.trim();

  const results = searchItems(doc.items, props.query);
  const resultIds = new Set(results.map((i) => i.id));

  // "Matches something exactly" uses the §1.4 normalization (case,
  // punctuation, token order, naive plurals) over live names + aliases — a
  // VISIBLE exact match means "tap it", so Create and the candidate section
  // disappear. Visibility matters: search itself is substring-only, so a
  // reordered/pluralized exact equivalent ("canned tomatoes" for "Tomatoes,
  // canned") may match by key while the results are empty — suppressing
  // Create AND the candidates then would dead-end on a blank list for an
  // item that exists. Letting duplicateCandidates surface it gives the user
  // the row to tap instead.
  const key = normalKey(props.query);
  const exactVisible = doc.items.some(
    (i) =>
      i.deleted_at === null &&
      resultIds.has(i.id) &&
      [i.name, ...i.aliases].some((label) => normalKey(label) === key),
  );

  const candidates = exactVisible
    ? []
    : duplicateCandidates(doc.items, props.query).filter(
        // Live candidates the substring search already listed stay listed
        // once (merge-loser tombstones are already excluded by the domain).
        (i) => !resultIds.has(i.id),
      );

  return (
    <ul class="inv-list">
      {results.map((item) => (
        <ItemRow
          key={item.id}
          item={item}
          caption={caption(item.category, item.location)}
        />
      ))}
      {candidates.map((item) =>
        item.deleted_at === null ? (
          <ItemRow
            key={item.id}
            item={item}
            caption={caption(item.category, item.location)}
          />
        ) : (
          <RestoreRow key={item.id} item={item} nowIso={props.nowIso} />
        ),
      )}
      {!exactVisible && (
        <li class="row">
          <button
            class="row-main inv-open"
            type="button"
            onClick={() =>
              // Standing in an open shelf, the new item files there (PLAN.md
              // M1 quick-create: location preselected); otherwise as before.
              nav.openCreate(
                trimmed,
                props.openLocation !== null
                  ? { location: props.openLocation.location }
                  : undefined,
              )
            }
          >
            <span class="row-title inv-create">Create “{trimmed}”</span>
          </button>
        </li>
      )}
    </ul>
  );
}

/** Stroke-style cart glyph (currentColor, ~20px in the 44px hit box). The
 *  basket fills when the item is on the list — the ONLY state signal the
 *  row carries for the flag, so it must read at a glance against cream. */
function CartIcon(props: { filled: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M3 4h2.2L7 14.5h10.4L19.6 7H5.8" fill={props.filled ? "currentColor" : "none"} />
      <circle cx="8.5" cy="19.5" r="1.4" fill={props.filled ? "currentColor" : "none"} />
      <circle cx="16.5" cy="19.5" r="1.4" fill={props.filled ? "currentColor" : "none"} />
    </svg>
  );
}

/** One live item: name area opens the detail overlay; QtyControl answers and
 *  writes in place (and owns the 🔕 / Out–? value states / undo toast); the cart
 *  target toggles the manual shopping flag AND carries the flag state (its
 *  filled/outline basket), so the row's flag-dot mark is suppressed —
 *  Shopping/Reconcile rows, which have no cart control, keep the dot. */
function ItemRow(props: { item: Item; caption: string | null }) {
  const store = useStore();
  const nav = useNav();
  const toast = useToast();
  const item = props.item;

  const flagLabel = item.flagged
    ? "On the shopping list — tap to remove"
    : "Add to shopping list";
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
      {/* Grouped so the whole cluster wraps below the name as ONE
          right-aligned unit on narrow viewports (styles.css .row-controls)
          instead of the stepper overflowing onto the name. */}
      <span class="row-controls">
        <QtyControl item={item} brief hideFlag />
        <button
          class={`inv-more${item.flagged ? " inv-more-on" : ""}`}
          type="button"
          title={flagLabel}
          aria-label={flagLabel}
          aria-pressed={item.flagged}
          onClick={toggleFlag}
        >
          <CartIcon filled={item.flagged} />
        </button>
      </span>
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
