/**
 * Walk-the-shelf reconciliation (PLAN.md §2 Reconciliation; §4 M3 flow (d):
 * ~2 min per location). One primitive throughout: a human absolute
 * observation. "✓ Looks right" = verified_at stamp only (store.verify);
 * a fix = recount via the shared QtyControl. The end-of-pass "not seen"
 * list offers EXPLICIT per-item choices — never automatic zeroing, because
 * a write the human didn't observe is drift manufactured by the app.
 *
 * All stage state here is session-local by design: which rows were touched
 * this pass is a UI fact about the walk, not data about the pantry.
 */
import { useState } from "preact/hooks";
import { fmtAge, fmtLevel } from "../../domain/format";
import { liveItems, resolveVocabValue, stalest, valuesInUse } from "../../store/selectors";
import { now, type Item } from "../../types";
import { QtyControl, Sheet } from "../components";
import { useDoc, useNav, useStore, useToast } from "../hooks";
import "./reconcile.css";

interface WalkStage {
  name: "walk";
  label: string;
  /** Single-location walk: rows need no per-row location. */
  single: boolean;
  /** Snapshot of item ids in stalest order at walk start — the list must
   *  not resort mid-walk as verify() moves verified_at under it. */
  ids: string[];
  startIso: string;
}

type SweepOutcome = "zeroed" | "moved" | "deleted" | "skipped";

interface SweepStage {
  name: "sweep";
  label: string;
  checked: number;
  /** Ids never touched during the walk, awaiting an explicit decision. */
  remaining: string[];
  zeroed: number;
  moved: number;
  deleted: number;
  skipped: number;
}

interface DoneStage {
  name: "done";
  label: string;
  checked: number;
  zeroed: number;
  moved: number;
  deleted: number;
  skipped: number;
}

type Stage = { name: "pick" } | WalkStage | SweepStage | DoneStage;

/** Oldest verified_at in a set; any never-confirmed item is oldest of all. */
function oldestVerified(items: Item[]): string | null {
  let oldest: string | undefined;
  for (const item of items) {
    if (item.verified_at === null) return null;
    if (oldest === undefined || item.verified_at < oldest) oldest = item.verified_at;
  }
  return oldest ?? null;
}

function countText(n: number): string {
  return `${n} ${n === 1 ? "item" : "items"}`;
}

export function ReconcileView() {
  const store = useStore();
  const doc = useDoc();
  const nav = useNav();
  const toast = useToast();
  const [stage, setStage] = useState<Stage>({ name: "pick" });
  // Move… sheet (sweep stage): which item, plus the explicit-add-new text
  // (PLAN.md §5: pick from existing values + add new, never a bare field).
  const [movingId, setMovingId] = useState<string | null>(null);
  const [newLoc, setNewLoc] = useState("");
  const nowIso = now();

  const startWalk = (label: string, single: boolean, items: Item[]): void => {
    setStage({
      name: "walk",
      label,
      single,
      ids: items.map((i) => i.id),
      startIso: now(),
    });
  };

  const bump = (s: SweepStage, outcome: SweepOutcome): SweepStage => ({
    ...s,
    zeroed: s.zeroed + (outcome === "zeroed" ? 1 : 0),
    moved: s.moved + (outcome === "moved" ? 1 : 0),
    deleted: s.deleted + (outcome === "deleted" ? 1 : 0),
    skipped: s.skipped + (outcome === "skipped" ? 1 : 0),
  });

  const resolveItem = (id: string, outcome: SweepOutcome): void => {
    setStage((s) => {
      if (s.name !== "sweep") return s;
      const bumped = bump(s, outcome);
      const remaining = s.remaining.filter((r) => r !== id);
      if (remaining.length === 0) {
        return {
          name: "done",
          label: bumped.label,
          checked: bumped.checked,
          zeroed: bumped.zeroed,
          moved: bumped.moved,
          deleted: bumped.deleted,
          skipped: bumped.skipped,
        };
      }
      return { ...bumped, remaining };
    });
  };

  const skipRest = (): void => {
    setStage((s) => {
      if (s.name !== "sweep") return s;
      return {
        name: "done",
        label: s.label,
        checked: s.checked,
        zeroed: s.zeroed,
        moved: s.moved,
        deleted: s.deleted,
        skipped: s.skipped + s.remaining.length,
      };
    });
  };

  // -- explicit not-seen decisions (each is a human observation) -----------

  const zeroOut = (item: Item): void => {
    // Capture the flag triple BEFORE the write: zeroing usually raises a
    // threshold flag, and undoing the zero-out must also take that flag
    // back down (or keep a pre-existing one exactly as it stood).
    const flagsBefore = {
      flagged: item.flagged,
      flag_source: item.flag_source,
      flagged_at: item.flagged_at,
    };
    // A recount to 0: the human looked and it wasn't there. Stamps
    // verified_at inside the store — absence confirmed is still confirmed.
    store.setQuantity(item.id, 0);
    const last = store.lastQuantityWrite();
    if (last === null) toast(`${item.name}: set to 0`);
    else {
      toast(`${item.name}: set to 0`, () =>
        store.undoQuantity(last.itemId, last.qtyBefore, flagsBefore),
      );
    }
    resolveItem(item.id, "zeroed");
  };

  const doDelete = (item: Item): void => {
    const ok = window.confirm(
      `Delete ${item.name}? Its history is kept and it can be restored later.`,
    );
    if (!ok) return;
    store.softDelete(item.id);
    toast(`Deleted ${item.name}`, () => store.restore(item.id));
    resolveItem(item.id, "deleted");
  };

  const doMove = (item: Item, location: string): void => {
    const from = item.location;
    store.editItem(item.id, { location });
    toast(`${item.name} → ${location}`, () => store.editItem(item.id, { location: from }));
    setMovingId(null);
    resolveItem(item.id, "moved");
  };

  // -- walk ----------------------------------------------------------------

  if (stage.name === "walk") {
    // Resolve the id snapshot against the live doc each render so QtyControl
    // edits show through; keep snapshot ORDER so rows never jump mid-walk.
    const rows: Item[] = [];
    for (const id of stage.ids) {
      const item = doc.items.find((i) => i.id === id);
      if (item !== undefined && item.deleted_at === null) rows.push(item);
    }
    // Touched = any committed mutation since the walk began (verify bumps
    // updated_at too). Derived from the doc, so QtyControl edits count
    // without this view needing write callbacks.
    const isTouched = (i: Item): boolean => i.updated_at > stage.startIso;
    const pending = rows.filter((i) => !isTouched(i));
    const checked = rows.length - pending.length;

    const finish = (): void => {
      if (pending.length === 0) {
        setStage({
          name: "done",
          label: stage.label,
          checked,
          zeroed: 0,
          moved: 0,
          deleted: 0,
          skipped: 0,
        });
      } else {
        setStage({
          name: "sweep",
          label: stage.label,
          checked,
          remaining: pending.map((i) => i.id),
          zeroed: 0,
          moved: 0,
          deleted: 0,
          skipped: 0,
        });
      }
    };

    const row = (item: Item) => {
      const touched = isTouched(item);
      const age =
        item.verified_at === null
          ? "never confirmed"
          : `last confirmed ${fmtAge(item.verified_at, nowIso)}`;
      return (
        <li key={item.id} class={`recon-row${touched ? " recon-touched" : ""}`}>
          <div class="recon-row-head">
            <span class="row-title">
              {item.name}
              {touched && (
                <span class="recon-check" aria-hidden="true">
                  {" "}
                  ✓
                </span>
              )}
            </span>
            <span class="row-sub">
              {stage.single ? age : `${item.location ?? "elsewhere"} · ${age}`}
            </span>
          </div>
          <div class="recon-row-acts">
            <QtyControl item={item} />
            <button
              class="btn recon-ok"
              type="button"
              onClick={() => store.verify(item.id)}
            >
              ✓ Looks right
            </button>
          </div>
        </li>
      );
    };

    return (
      <section class="view">
        <header class="recon-head">
          <h1 class="view-title">{stage.label}</h1>
          <button
            class="recon-switch"
            type="button"
            onClick={() => setStage({ name: "pick" })}
          >
            Switch
          </button>
        </header>
        {rows.length === 0 ? (
          <p class="muted">No items here.</p>
        ) : (
          <p class="recon-progress">
            {checked} of {rows.length} checked
          </p>
        )}
        <ul class="recon-list">
          {/* ONE list in snapshot order: touched rows dim and get their ✓ in
              place. Re-partitioning on each render made the FIRST stepper tap
              sink the row, sliding the next row under a still-tapping finger —
              a wrong-item write during the anti-drift flow. */}
          {rows.map(row)}
        </ul>
        <button
          class="btn btn-primary btn-big recon-finish"
          type="button"
          onClick={finish}
        >
          {pending.length === 0 ? "Finish pass" : `Finish — ${pending.length} not seen`}
        </button>
      </section>
    );
  }

  // -- sweep: the not-seen list --------------------------------------------

  if (stage.name === "sweep") {
    const rows: Item[] = [];
    for (const id of stage.remaining) {
      const item = doc.items.find((i) => i.id === id);
      if (item !== undefined && item.deleted_at === null) rows.push(item);
    }
    const locations = valuesInUse(doc, "location");
    const movingItem =
      movingId === null ? undefined : rows.find((i) => i.id === movingId);

    return (
      <section class="view">
        <h1 class="view-title">Not seen</h1>
        <p class="recon-progress">
          {countText(rows.length)} never got a look this pass. Nothing changes
          automatically — decide per item.
        </p>
        <ul class="recon-list">
          {rows.map((item) => (
            <li key={item.id} class="recon-row">
              <div class="recon-row-head">
                <span class="row-title">{item.name}</span>
                <span class="row-sub">
                  {fmtLevel(item)} · {item.location ?? "elsewhere"}
                </span>
              </div>
              <div class="recon-sweep-acts">
                <button class="btn" type="button" onClick={() => zeroOut(item)}>
                  Zero out
                </button>
                <button
                  class="btn"
                  type="button"
                  onClick={() => {
                    setNewLoc("");
                    setMovingId(item.id);
                  }}
                >
                  Move…
                </button>
                <button class="btn recon-delete" type="button" onClick={() => doDelete(item)}>
                  Delete
                </button>
                <button
                  class="btn"
                  type="button"
                  onClick={() => resolveItem(item.id, "skipped")}
                >
                  Skip
                </button>
              </div>
            </li>
          ))}
        </ul>
        <button class="btn btn-big recon-finish" type="button" onClick={skipRest}>
          Skip the rest
        </button>
        {movingItem !== undefined && (
          <Sheet open onClose={() => setMovingId(null)} title={`Move ${movingItem.name}`}>
            <div class="recon-move">
              {locations
                .filter((l) => l !== movingItem.location)
                .map((l) => (
                  <button
                    key={l}
                    class="btn btn-big"
                    type="button"
                    onClick={() => doMove(movingItem, l)}
                  >
                    {l}
                  </button>
                ))}
              <form
                class="recon-move-new"
                onSubmit={(e) => {
                  e.preventDefault();
                  // Case-insensitive match reuses the EXISTING casing so a
                  // typed "Fridge" cannot mint a second location beside
                  // "fridge".
                  const t = resolveVocabValue(locations, newLoc);
                  if (t !== "") doMove(movingItem, t);
                }}
              >
                <input
                  class="field-input"
                  type="text"
                  placeholder="New location"
                  aria-label="New location"
                  autocomplete="off"
                  autocapitalize="none"
                  value={newLoc}
                  onInput={(e) => setNewLoc(e.currentTarget.value)}
                />
                <button class="btn" type="submit">
                  Move
                </button>
              </form>
            </div>
          </Sheet>
        )}
      </section>
    );
  }

  // -- done ----------------------------------------------------------------

  if (stage.name === "done") {
    const bits = [`${stage.checked} checked`];
    if (stage.zeroed > 0) bits.push(`${stage.zeroed} zeroed`);
    if (stage.moved > 0) bits.push(`${stage.moved} moved`);
    if (stage.deleted > 0) bits.push(`${stage.deleted} deleted`);
    if (stage.skipped > 0) bits.push(`${stage.skipped} skipped`);
    return (
      <section class="view recon-done">
        <div class="recon-done-mark" aria-hidden="true">
          ✓
        </div>
        <h1 class="view-title">Pass complete</h1>
        <p>
          {stage.label}: {bits.join(" · ")}.
        </p>
        <p class="muted">Drift fought — these counts match the shelf again.</p>
        <div class="recon-done-acts">
          <button
            class="btn btn-primary btn-big"
            type="button"
            onClick={() => nav.setView("more")}
          >
            Done
          </button>
          <button
            class="btn btn-big"
            type="button"
            onClick={() => setStage({ name: "pick" })}
          >
            Walk another shelf
          </button>
        </div>
      </section>
    );
  }

  // -- pick ----------------------------------------------------------------

  const live = liveItems(doc);
  const locations = valuesInUse(doc, "location");
  const unfiled = live.filter((i) => i.location === null);
  const stale10 = stalest(doc).slice(0, 10);

  const pickRow = (key: string, title: string, sub: string, onTap: () => void) => (
    <button key={key} class="recon-pick" type="button" onClick={onTap}>
      <span class="row-main">
        <span class="row-title">{title}</span>
        <span class="row-sub">{sub}</span>
      </span>
      <span class="recon-chevron" aria-hidden="true">
        ›
      </span>
    </button>
  );

  return (
    <section class="view">
      <h1 class="view-title">Reconcile</h1>
      {live.length === 0 ? (
        <p class="muted">Nothing to walk yet — the pantry is empty.</p>
      ) : (
        <>
          <p class="recon-progress">
            Pick a shelf to walk. Confirm what you see; fix what you don't.
          </p>
          <div class="recon-picks">
            {/* micro-audit first: PLAN.md — "10 stalest, 2 minutes" beats
                guilt-inducing full audits */}
            {pickRow(
              "stalest",
              "10 stalest",
              `${countText(stale10.length)} · oldest check ${fmtAge(oldestVerified(stale10), nowIso)}`,
              () => startWalk("10 stalest", false, stale10),
            )}
            {locations.map((loc) => {
              const items = live.filter((i) => i.location === loc);
              return pickRow(
                `loc:${loc}`,
                loc,
                `${countText(items.length)} · oldest check ${fmtAge(oldestVerified(items), nowIso)}`,
                () => startWalk(loc, true, stalest(doc, loc)),
              );
            })}
            {/* null-location items would otherwise be reachable only via a
                full everywhere walk */}
            {unfiled.length > 0 &&
              pickRow(
                "elsewhere",
                "elsewhere",
                `${countText(unfiled.length)} with no location · oldest check ${fmtAge(oldestVerified(unfiled), nowIso)}`,
                () =>
                  startWalk(
                    "elsewhere",
                    true,
                    stalest(doc).filter((i) => i.location === null),
                  ),
              )}
            {pickRow(
              "everywhere",
              "Everywhere",
              `${countText(live.length)} · oldest check ${fmtAge(oldestVerified(live), nowIso)}`,
              () => startWalk("Everywhere", false, stalest(doc)),
            )}
          </div>
        </>
      )}
    </section>
  );
}
