/**
 * Item detail/edit overlay + the quick-create sheet.
 *
 * All writes go through Store commands (AGENTS.md rule 1). Unit and
 * package-size edits are guarded flows (PLAN.md §1.5): the store enforces
 * atomicity; this file provides the ceremony — previews, forced re-entry,
 * keep-amount/keep-count — so a number never silently changes meaning.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { RUNG_LABELS, fmtAge, fmtQty, fmtQtyBoth, fmtQtyUnit, parseDec } from "../../domain/format";
import { rungValue } from "../../domain/ladder";
import { historyFor, planMerge } from "../../domain/merge";
import { duplicateCandidates, searchItems } from "../../domain/search";
import { planPackageResize, planUnitChange, toPreciseUnit } from "../../domain/units";
import { purchaseRhythm, resolveVocabValue, valuesInUse } from "../../store/selectors";
import type { CreateItemInput } from "../../store/store";
import {
  COMMON_UNITS,
  SEED_LOCATIONS,
  now,
  type AmbryDoc,
  type EventKind,
  type HistoryEvent,
  type Item,
  type LadderRung,
} from "../../types";
import { Banner, QtyControl, Sheet } from "../components";
import { useDoc, useNav, useStore, useToast } from "../hooks";
import "./item.css";

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

const normUnit = (u: string): string => u.trim().toLowerCase();

/**
 * Which rung chip a numeric threshold displays as: the highest rung whose tap
 * value would cross it (largest rung value <= threshold). The stored default
 * 0.25 therefore shows as "Low" — the rung it exists to catch.
 */
function thresholdRung(threshold: number): LadderRung {
  if (threshold >= rungValue("full")) return "full";
  if (threshold >= rungValue("half")) return "half";
  if (threshold >= rungValue("low")) return "low";
  return "out";
}

/**
 * Decimal field committing on blur (Enter just blurs). Keyed on the canonical
 * value so an external write (undo, unit change) resets the draft, while
 * typing never fights the store.
 */
function DecField(props: {
  value: number | null;
  ariaLabel: string;
  /** Blank commits null (threshold "off"); otherwise blank reverts. */
  allowNull?: boolean;
  /** Reject 0 as well as negatives (restock amount). */
  requirePositive?: boolean;
  onCommit: (n: number | null) => void;
}) {
  const canonical = props.value === null ? "" : fmtQty(props.value);
  return (
    <DecDraft
      key={canonical}
      canonical={canonical}
      ariaLabel={props.ariaLabel}
      allowNull={props.allowNull ?? false}
      requirePositive={props.requirePositive ?? false}
      onCommit={props.onCommit}
    />
  );
}

function DecDraft(props: {
  canonical: string;
  ariaLabel: string;
  allowNull: boolean;
  requirePositive: boolean;
  onCommit: (n: number | null) => void;
}) {
  const [draft, setDraft] = useState(props.canonical);
  const ref = useRef<HTMLInputElement>(null);
  const commit = (): void => {
    if (draft.trim() === props.canonical) return;
    if (draft.trim() === "") {
      if (props.allowNull) props.onCommit(null);
      else setDraft(props.canonical);
      return;
    }
    // parseDec already rejects negatives, so only the zero rule is local.
    const n = parseDec(draft);
    if (n === null || (props.requirePositive && n <= 0)) {
      // Invalid entry reverts visibly instead of pretending it stuck.
      setDraft(props.canonical);
      return;
    }
    props.onCommit(n);
    // Same value re-typed differently ("2.0" for "2") causes no remount, so
    // normalize the draft here.
    setDraft(fmtQty(n));
  };
  return (
    <form
      class="qty-form"
      onSubmit={(e) => {
        e.preventDefault();
        ref.current?.blur();
      }}
    >
      <input
        ref={ref}
        class="field-input item-num"
        type="text"
        inputMode="decimal"
        autocomplete="off"
        aria-label={props.ariaLabel}
        value={draft}
        onInput={(e) => setDraft(e.currentTarget.value)}
        onBlur={commit}
      />
    </form>
  );
}

/**
 * Category/location vocabulary picker (PLAN.md §5): pick from existing values
 * plus an explicit "add new" — never a bare text field, so "Fridge"/"fridge"
 * duplicate rot cannot start.
 */
function PickerRow(props: {
  label: string;
  value: string | null;
  options: string[];
  onPick: (v: string | null) => void;
}) {
  // De-dupe while keeping first-seen order (seeds before in-use values).
  const seen = new Set<string>();
  const options = props.options.filter((o) => {
    const k = o.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const addNew = (): void => {
    const raw = window.prompt(`New ${props.label.toLowerCase()}`);
    if (raw === null) return;
    // Case-insensitive match reuses the EXISTING casing — iOS capitalizes
    // the first letter of prompt() text, which must not mint "Fridge"
    // beside "fridge".
    const v = resolveVocabValue(options, raw);
    if (v !== "") props.onPick(v);
  };
  return (
    <div class="item-field">
      <div class="item-label">{props.label}</div>
      <div class="chips">
        <button
          type="button"
          class={`chip${props.value === null ? " chip-active" : ""}`}
          onClick={() => props.onPick(null)}
        >
          None
        </button>
        {options.map((o) => (
          <button
            key={o}
            type="button"
            class={`chip${o === props.value ? " chip-active" : ""}`}
            onClick={() => props.onPick(o)}
          >
            {o}
          </button>
        ))}
        <button type="button" class="chip" onClick={addNew}>
          ＋ New…
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

const KIND_GLYPH: Record<EventKind, string> = {
  create: "✚",
  add: "＋",
  use: "−",
  recount: "＝",
  purchase: "🛒",
  unit_change: "⇄",
  merge: "⇥",
  delete: "🗑",
  restore: "↩",
  import: "⇪",
};

const KIND_LABEL: Record<EventKind, string> = {
  create: "created",
  add: "added",
  use: "used",
  recount: "recount",
  purchase: "bought",
  unit_change: "unit change",
  merge: "merged",
  delete: "deleted",
  restore: "restored",
  import: "imported",
};

/** "2 bags → 400 g" — unit_change events show qty_before in unit_before. */
function eventQtyText(e: HistoryEvent): string {
  const before =
    e.unit_before !== undefined ? fmtQtyUnit(e.qty_before, e.unit_before) : fmtQty(e.qty_before);
  return `${before} → ${fmtQtyUnit(e.qty_after, e.unit)}`;
}

const HISTORY_LIMIT = 20;

function HistorySection(props: { doc: AmbryDoc; itemId: string; nowIso: string }) {
  // Union over the merged_into chain — loser events reach the survivor's
  // view without ever being rewritten (domain/merge.historyFor).
  const events = historyFor(props.doc, props.itemId);
  return (
    <section class="item-section">
      <h2 class="item-section-title">History</h2>
      {events.length === 0 ? (
        <p class="muted">No recorded changes.</p>
      ) : (
        <ul class="item-history">
          {events.slice(0, HISTORY_LIMIT).map((e) => (
            <li key={e.id} class="item-event">
              <span class="item-event-glyph" title={KIND_LABEL[e.kind]} aria-label={KIND_LABEL[e.kind]}>
                {KIND_GLYPH[e.kind]}
              </span>
              <span class="item-event-qty">
                {eventQtyText(e)}
                {e.note !== undefined && <span class="muted"> · {e.note}</span>}
              </span>
              <span class="item-event-age muted">{fmtAge(e.at, props.nowIso)}</span>
            </li>
          ))}
        </ul>
      )}
      {events.length > HISTORY_LIMIT && (
        <p class="muted item-hint">Showing the {HISTORY_LIMIT} most recent.</p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Name editor (inline)
// ---------------------------------------------------------------------------

function NameEditor(props: { current: string; onDone: (v: string | null) => void }) {
  const [draft, setDraft] = useState(props.current);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  // Submit fires blur right after — first outcome wins (same pattern as the
  // shell's InlineQtyInput).
  const finish = (v: string | null): void => {
    if (done.current) return;
    done.current = true;
    props.onDone(v);
  };
  const commit = (): void => {
    const t = draft.trim();
    finish(t === "" || t === props.current ? null : t);
  };

  return (
    <form
      class="item-name-form"
      onSubmit={(e) => {
        e.preventDefault();
        commit();
      }}
    >
      <input
        ref={ref}
        class="field-input"
        type="text"
        autocomplete="off"
        aria-label="Name"
        value={draft}
        onInput={(e) => setDraft(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") finish(null);
        }}
        onBlur={commit}
      />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Guarded unit change (PLAN.md §1.5)
// ---------------------------------------------------------------------------

/** New-unit candidates: package measure first (the convertible one), then common, then in use. */
function unitOptions(doc: AmbryDoc, item: Item): string[] {
  const seen = new Set<string>([normUnit(item.unit)]);
  const out: string[] = [];
  const push = (u: string): void => {
    const k = normUnit(u);
    if (k === "" || seen.has(k)) return;
    seen.add(k);
    out.push(u.trim());
  };
  if (item.package_size !== null) push(item.package_size.unit);
  for (const u of COMMON_UNITS) push(u);
  for (const u of valuesInUse(doc, "unit")) push(u);
  return out;
}

function UnitChangeSheet(props: { item: Item; onClose: () => void }) {
  const store = useStore();
  const doc = useDoc();
  const toast = useToast();
  const item = props.item;

  const [target, setTarget] = useState<string | null>(null);
  const [custom, setCustom] = useState("");
  // Re-entry drafts (reenter plan only).
  const [qtyDraft, setQtyDraft] = useState("");
  const [thrDraft, setThrDraft] = useState("");
  const [pkgAmtDraft, setPkgAmtDraft] = useState("");
  const [pkgUnitDraft, setPkgUnitDraft] = useState("");

  const plan = target === null ? null : planUnitChange(item, target);

  const pickCustom = (): void => {
    const u = custom.trim();
    if (u === "" || normUnit(u) === normUnit(item.unit)) return;
    setTarget(u);
  };

  const applyConvert = (): void => {
    if (target === null || plan === null || plan.kind !== "convert") return;
    store.changeUnit(item.id, target, plan);
    toast(`${item.name}: now counted in ${target}`);
    props.onClose();
  };

  const qn = parseDec(qtyDraft);
  const thrEmpty = thrDraft.trim() === "";
  const thrN = parseDec(thrDraft);
  const pkgEmpty = pkgAmtDraft.trim() === "" && pkgUnitDraft.trim() === "";
  const pkgAmtN = parseDec(pkgAmtDraft);
  const pkgOk = pkgEmpty || (pkgAmtN !== null && pkgAmtN > 0 && pkgUnitDraft.trim() !== "");
  const reenterOk =
    qn !== null && qn >= 0 && (thrEmpty || (thrN !== null && thrN >= 0)) && pkgOk;

  const applyReenter = (): void => {
    if (target === null || plan === null || plan.kind !== "reenter" || !reenterOk || qn === null) return;
    const pkg =
      pkgEmpty || pkgAmtN === null ? null : { amount: pkgAmtN, unit: pkgUnitDraft.trim() };
    store.changeUnit(item.id, target, plan, {
      quantity: qn,
      threshold: thrEmpty ? null : thrN,
      package_size: pkg,
    });
    toast(`${item.name}: now counted in ${target}`);
    props.onClose();
  };

  return (
    <Sheet open onClose={props.onClose} title="Change unit">
      {target === null || plan === null ? (
        <div class="create-form">
          <p class="muted item-hint">
            The unit denominates the quantity, the flag threshold, and the package size — so
            changing it is a guided step: the numbers convert together, or get re-entered
            together. History keeps the units it was written in.
          </p>
          <div class="item-field">
            <div class="item-label">
              New unit (currently <strong>{item.unit}</strong>)
            </div>
            <div class="chips">
              {unitOptions(doc, item).map((u) => (
                <button key={u} type="button" class="chip" onClick={() => setTarget(u)}>
                  {u}
                </button>
              ))}
            </div>
          </div>
          <div class="item-field">
            <div class="item-label">Or type one</div>
            <div class="item-inline">
              <input
                class="field-input"
                type="text"
                autocomplete="off"
                aria-label="New unit"
                placeholder="e.g. tub"
                value={custom}
                onInput={(e) => setCustom(e.currentTarget.value)}
              />
              <button type="button" class="btn" disabled={custom.trim() === ""} onClick={pickCustom}>
                Use
              </button>
            </div>
          </div>
        </div>
      ) : plan.kind === "convert" ? (
        <div class="create-form">
          <p>
            The package size links {item.unit} and {target}, so Ambry can convert everything:
          </p>
          <ul class="item-preview">
            <li>
              Quantity: {fmtQtyUnit(item.quantity, item.unit)} →{" "}
              <strong>{fmtQtyUnit(plan.quantity, target)}</strong>
            </li>
            <li>
              Flag threshold:{" "}
              {item.threshold === null || plan.threshold === null
                ? "off (unchanged)"
                : `${fmtQtyUnit(item.threshold, item.unit)} → ${fmtQtyUnit(plan.threshold, target)}`}
            </li>
            <li>
              Package:{" "}
              {plan.package_size === null
                ? "cleared"
                : `1 ${target} = ${fmtQtyUnit(plan.package_size.amount, plan.package_size.unit)}`}
            </li>
          </ul>
          <button type="button" class="btn btn-primary btn-big" onClick={applyConvert}>
            Convert to {target}
          </button>
          <button type="button" class="btn" onClick={() => setTarget(null)}>
            Back
          </button>
        </div>
      ) : (
        <div class="create-form">
          <p class="muted item-hint">
            Nothing links {item.unit} to {target}, so the numbers can't be carried across —
            enter the current amounts in {target}. Asking now beats a threshold that silently
            means the wrong thing forever.
          </p>
          <div class="item-field">
            <div class="item-label">Quantity on hand ({target})</div>
            <input
              class="field-input item-num"
              type="text"
              inputMode="decimal"
              autocomplete="off"
              aria-label="Quantity in new unit"
              value={qtyDraft}
              onInput={(e) => setQtyDraft(e.currentTarget.value)}
            />
          </div>
          <div class="item-field">
            <div class="item-label">Auto-flag at or below ({target}) — blank for off</div>
            <input
              class="field-input item-num"
              type="text"
              inputMode="decimal"
              autocomplete="off"
              aria-label="Threshold in new unit"
              value={thrDraft}
              onInput={(e) => setThrDraft(e.currentTarget.value)}
            />
          </div>
          <div class="item-field">
            <div class="item-label">Package size (optional): 1 {target} =</div>
            <div class="item-inline">
              <input
                class="field-input item-num"
                type="text"
                inputMode="decimal"
                autocomplete="off"
                aria-label="Package amount"
                placeholder="amount"
                value={pkgAmtDraft}
                onInput={(e) => setPkgAmtDraft(e.currentTarget.value)}
              />
              <input
                class="field-input"
                type="text"
                autocomplete="off"
                aria-label="Package unit"
                placeholder="unit"
                value={pkgUnitDraft}
                onInput={(e) => setPkgUnitDraft(e.currentTarget.value)}
              />
            </div>
          </div>
          <button
            type="button"
            class="btn btn-primary btn-big"
            disabled={!reenterOk}
            onClick={applyReenter}
          >
            Change to {target}
          </button>
          <button type="button" class="btn" onClick={() => setTarget(null)}>
            Back
          </button>
        </div>
      )}
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Package-size edit (keep amount vs keep count — PLAN.md §1.5)
// ---------------------------------------------------------------------------

function PackageSheet(props: { item: Item; onClose: () => void }) {
  const store = useStore();
  const toast = useToast();
  const item = props.item;

  const [amtDraft, setAmtDraft] = useState(
    item.package_size === null ? "" : fmtQty(item.package_size.amount),
  );
  const [unitDraft, setUnitDraft] = useState(item.package_size?.unit ?? "");
  /** Non-null = the keep-amount/keep-count decision step. */
  const [pending, setPending] = useState<{ amount: number; unit: string } | null>(null);

  const amtN = parseDec(amtDraft);
  const valid = amtN !== null && amtN > 0 && unitDraft.trim() !== "";

  const apply = (pkg: { amount: number; unit: string }, keep: "amount" | "count"): void => {
    store.resizePackage(item.id, pkg, keep);
    toast(`${item.name}: 1 ${item.unit} = ${fmtQtyUnit(pkg.amount, pkg.unit)}`);
    props.onClose();
  };

  const submit = (): void => {
    if (!valid || amtN === null) return;
    const newPkg = { amount: amtN, unit: unitDraft.trim() };
    const old = item.package_size;
    // Only a same-measure resize has a ratio to preserve; then the stored
    // numbers can mean two different physical truths and the human must say
    // which one held. Otherwise the numbers keep their values ("count").
    const sameMeasure =
      old !== null &&
      Number.isFinite(old.amount) &&
      old.amount > 0 &&
      normUnit(old.unit) === normUnit(newPkg.unit);
    if (sameMeasure && old.amount !== newPkg.amount) setPending(newPkg);
    else apply(newPkg, "count");
  };

  if (pending !== null && item.package_size !== null) {
    const old = item.package_size;
    const keepAmount = planPackageResize(item, pending, "amount");
    const precise = toPreciseUnit(item);
    return (
      <Sheet open onClose={props.onClose} title="Package size">
        <div class="create-form">
          <p>
            A {item.unit} now means {fmtQtyUnit(pending.amount, pending.unit)} instead of{" "}
            {fmtQtyUnit(old.amount, old.unit)}. Every stored number is denominated in{" "}
            {item.unit}s — which stayed true on the shelf?
          </p>
          <button type="button" class="btn btn-big" onClick={() => apply(pending, "amount")}>
            Keep amount — still{" "}
            {precise === null ? fmtQtyBoth(item) : fmtQtyUnit(precise.amount, precise.unit)}; the
            count becomes {fmtQtyUnit(keepAmount.quantity, item.unit)}
          </button>
          <button type="button" class="btn btn-big" onClick={() => apply(pending, "count")}>
            Keep count — still {fmtQtyUnit(item.quantity, item.unit)}, which now means{" "}
            {fmtQtyUnit(item.quantity * pending.amount, pending.unit)}
          </button>
          <p class="muted item-hint">
            "Keep amount" also rescales the flag threshold to match; "keep count" leaves the
            numbers and changes what they mean. A unit-change event records it either way.
          </p>
          <button type="button" class="btn" onClick={() => setPending(null)}>
            Back
          </button>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet open onClose={props.onClose} title="Package size">
      <div class="create-form">
        <p class="muted item-hint">
          What one {item.unit} contains — lets Ambry show both sides ("0.4 bags (400 g)") and
          convert if you ever change the unit.
        </p>
        <div class="item-field">
          <div class="item-label">1 {item.unit} =</div>
          <div class="item-inline">
            <input
              class="field-input item-num"
              type="text"
              inputMode="decimal"
              autocomplete="off"
              aria-label="Package amount"
              placeholder="amount"
              value={amtDraft}
              onInput={(e) => setAmtDraft(e.currentTarget.value)}
            />
            <input
              class="field-input"
              type="text"
              autocomplete="off"
              aria-label="Package unit"
              placeholder="unit (e.g. g)"
              value={unitDraft}
              onInput={(e) => setUnitDraft(e.currentTarget.value)}
            />
          </div>
        </div>
        <button type="button" class="btn btn-primary btn-big" disabled={!valid} onClick={submit}>
          Save package size
        </button>
        {item.package_size !== null && (
          <>
            <button
              type="button"
              class="btn btn-big"
              onClick={() => {
                // Drops only the bag<->contents link: quantity, threshold and
                // unit keep their values (the store records a unit_change
                // event with the removal in its note).
                store.clearPackageSize(item.id);
                toast(`${item.name}: package size removed`);
                props.onClose();
              }}
            >
              Remove package size
            </button>
            <p class="muted item-hint">
              Removing it keeps the numbers — Ambry just stops showing the converted side.
            </p>
          </>
        )}
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Merge tool (PLAN.md §2 Merge)
// ---------------------------------------------------------------------------

function MergeSheet(props: { item: Item; onClose: () => void }) {
  const store = useStore();
  const doc = useDoc();
  const toast = useToast();
  const nav = useNav();
  const item = props.item;

  const [q, setQ] = useState("");
  const [targetId, setTargetId] = useState<string | null>(null);
  const [qtyDraft, setQtyDraft] = useState("");

  const target =
    targetId === null ? null : (doc.items.find((i) => i.id === targetId) ?? null);

  if (target === null) {
    const candidates = searchItems(
      doc.items.filter((i) => i.deleted_at === null && i.id !== item.id),
      q,
    ).slice(0, 8);
    return (
      <Sheet open onClose={props.onClose} title="Merge into…">
        <div class="create-form">
          <p class="muted item-hint">
            Duplicate repair: this item becomes an alias of the one you pick; its history is
            preserved.
          </p>
          <input
            class="field-input"
            type="search"
            autocomplete="off"
            aria-label="Find the surviving item"
            placeholder="Find the surviving item"
            value={q}
            onInput={(e) => setQ(e.currentTarget.value)}
          />
          <div>
            {candidates.map((c) => (
              <button
                key={c.id}
                type="button"
                class="row item-pick"
                onClick={() => {
                  setTargetId(c.id);
                  setQtyDraft(fmtQty(planMerge(c, item).defaultQuantity));
                }}
              >
                <span class="row-main">
                  <span class="row-title">{c.name}</span>
                  <span class="row-sub">
                    {fmtQtyBoth(c)}
                    {c.location !== null ? ` · ${c.location}` : ""}
                  </span>
                </span>
              </button>
            ))}
            {q.trim() !== "" && candidates.length === 0 && (
              <p class="muted">No matching items.</p>
            )}
          </div>
        </div>
      </Sheet>
    );
  }

  const plan = planMerge(target, item);
  const qn = parseDec(qtyDraft);
  const confirm = (): void => {
    if (qn === null || qn < 0) return;
    store.mergeItems(target.id, item.id, qn);
    toast(`Merged into ${target.name}`);
    props.onClose();
    // Land on the survivor — the merged-away view no longer represents a
    // live item.
    nav.openItem(target.id);
  };

  return (
    <Sheet open onClose={props.onClose} title="Merge into…">
      <div class="create-form">
        <p>
          “{item.name}” becomes an alias of <strong>“{target.name}”</strong>; its history is
          preserved.
        </p>
        {plan.aliases.length > 0 && (
          <p class="muted item-hint">
            “{target.name}” will also answer to: {plan.aliases.join(", ")}.
          </p>
        )}
        {plan.flagged && <p class="muted item-hint">The merged item stays on the shopping list.</p>}
        <div class="item-field">
          <div class="item-label">Combined quantity ({target.unit})</div>
          {plan.needsQtyPrompt ? (
            <p class="muted item-hint">
              Units differ ({item.unit} vs {target.unit}), so the quantities can't be added —
              enter what's actually on the shelf, in {target.unit}.
            </p>
          ) : (
            <p class="muted item-hint">Defaults to the sum — adjust if the shelf says otherwise.</p>
          )}
          <input
            class="field-input item-num"
            type="text"
            inputMode="decimal"
            autocomplete="off"
            aria-label="Combined quantity"
            value={qtyDraft}
            onInput={(e) => setQtyDraft(e.currentTarget.value)}
          />
        </div>
        <button
          type="button"
          class="btn btn-primary btn-big"
          disabled={qn === null || qn < 0}
          onClick={confirm}
        >
          Merge into “{target.name}”
        </button>
        <button type="button" class="btn" onClick={() => setTargetId(null)}>
          Back
        </button>
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// ItemView — the overlay body (shell owns the back header)
// ---------------------------------------------------------------------------

export function ItemView({ id }: { id: string }) {
  const doc = useDoc();
  const item = doc.items.find((i) => i.id === id);
  if (item === undefined) {
    return (
      <section class="view">
        <p class="muted">Item not found.</p>
      </section>
    );
  }
  // Keyed so every editor/sheet state resets when merge navigates to the
  // survivor (same component position, different item).
  return <ItemBody key={id} item={item} doc={doc} />;
}

function ItemBody(props: { item: Item; doc: AmbryDoc }) {
  const { item, doc } = props;
  const store = useStore();
  const nav = useNav();
  const toast = useToast();
  const nowIso = now();

  const [editingName, setEditingName] = useState(false);
  const [unitSheet, setUnitSheet] = useState(false);
  const [pkgSheet, setPkgSheet] = useState(false);
  const [mergeSheet, setMergeSheet] = useState(false);

  // ---- tombstone: restore-first, no editors (writes to a deleted item
  // would be drift manufactured by the UI) --------------------------------
  if (item.deleted_at !== null) {
    const survivor =
      item.merged_into === null ? undefined : doc.items.find((i) => i.id === item.merged_into);
    return (
      <section class="view">
        <Banner
          kind="warn"
          action="Restore"
          onAction={() => {
            store.restore(item.id);
            toast(`Restored ${item.name}`);
          }}
        >
          Deleted {fmtAge(item.deleted_at, nowIso)}.
          {survivor !== undefined && (
            <>
              {" "}
              Its identity was merged into <strong>{survivor.name}</strong>; restoring
              separates them into two items again. The quantity moved to{" "}
              {survivor.name} during the merge, so recount after restoring.
            </>
          )}
        </Banner>
        <div class="item-section">
          <p class="muted">
            {fmtQtyBoth(item)}
            {item.location !== null ? ` · ${item.location}` : ""}
          </p>
          {survivor !== undefined && (
            <button type="button" class="btn btn-big" onClick={() => nav.openItem(survivor.id)}>
              Open {survivor.name}
            </button>
          )}
        </div>
        <HistorySection doc={doc} itemId={item.id} nowIso={nowIso} />
      </section>
    );
  }

  // ---- live item ---------------------------------------------------------
  const flaggedCaption =
    item.flag_source === "threshold"
      ? `flagged automatically ${fmtAge(item.flagged_at, nowIso)}`
      : `flagged by hand ${fmtAge(item.flagged_at, nowIso)}`;
  const activeThresholdRung = item.threshold === null ? null : thresholdRung(item.threshold);

  // Buying rhythm (purchase events via the merge-chain-aware selector):
  // quiet context for the threshold and "usually buy" settings below it.
  // Rounding to whole days happens HERE, not in the selector, and floors at
  // 1 — "about every 0 days" would be same-day noise. Never bought = no
  // line at all (retention bounds the window to ~a year; recent enough to
  // stand without a caveat).
  const rhythm = purchaseRhythm(doc, item.id, nowIso);
  let rhythmLine: string | null = null;
  if (rhythm.count === 1) {
    rhythmLine = `Bought once · ${fmtAge(rhythm.lastAt, nowIso)}`;
  } else if (rhythm.count >= 2 && rhythm.avgDays !== null) {
    const days = Math.max(1, Math.round(rhythm.avgDays));
    rhythmLine = `Bought ${rhythm.count} times · about every ${days} ${
      days === 1 ? "day" : "days"
    } · last ${fmtAge(rhythm.lastAt, nowIso)}`;
  }

  return (
    <section class="view">
      {/* Name — tap to edit inline. The shell header shows it too and updates live. */}
      {editingName ? (
        <NameEditor
          current={item.name}
          onDone={(v) => {
            setEditingName(false);
            if (v !== null) store.editItem(item.id, { name: v });
          }}
        />
      ) : (
        <button type="button" class="item-name-btn" onClick={() => setEditingName(true)}>
          {item.name} <span class="muted item-name-pen">✎</span>
        </button>
      )}
      {item.aliases.length > 0 && (
        <p class="muted item-aliases">Also answers to: {item.aliases.join(", ")}</p>
      )}

      {/* Quantity */}
      <section class="item-section item-qty-block">
        <QtyControl item={item} />
        <div class="item-inline item-wide">
          <span class="muted">Last confirmed {fmtAge(item.verified_at, nowIso)}</span>
          <button
            type="button"
            class="btn"
            onClick={() => {
              store.verify(item.id);
              toast(`${item.name}: confirmed`);
            }}
          >
            ✓ Verify
          </button>
        </div>
        <div class="item-field">
          <div class="item-label">Shown as</div>
          <div class="chips">
            <button
              type="button"
              class={`chip${item.display_mode === "number" ? " chip-active" : ""}`}
              onClick={() => store.editItem(item.id, { display_mode: "number" })}
            >
              Number
            </button>
            <button
              type="button"
              class={`chip${item.display_mode === "ladder" ? " chip-active" : ""}`}
              onClick={() => store.editItem(item.id, { display_mode: "ladder" })}
            >
              Ladder
            </button>
          </div>
          {item.display_mode === "ladder" && (
            <p class="muted item-hint">Full / Half / Low / Out — the exact number is kept underneath.</p>
          )}
        </div>
      </section>

      {/* Details */}
      <section class="item-section">
        <h2 class="item-section-title">Details</h2>
        <PickerRow
          label="Location"
          value={item.location}
          options={[...SEED_LOCATIONS, ...valuesInUse(doc, "location")]}
          onPick={(v) => store.editItem(item.id, { location: v })}
        />
        <PickerRow
          label="Category"
          value={item.category}
          options={valuesInUse(doc, "category")}
          onPick={(v) => store.editItem(item.id, { category: v })}
        />
        <div class="item-field">
          <div class="item-label">Expiry</div>
          <div class="item-inline">
            <input
              class="field-input item-date"
              type="date"
              aria-label="Expiry date"
              value={item.expiry ?? ""}
              onChange={(e) => {
                const v = e.currentTarget.value;
                store.editItem(item.id, { expiry: v === "" ? null : v });
              }}
            />
            {item.expiry !== null && (
              <button
                type="button"
                class="btn"
                onClick={() => store.editItem(item.id, { expiry: null })}
              >
                Clear
              </button>
            )}
          </div>
        </div>
        <div class="item-field">
          <div class="item-label">Notes</div>
          <NotesField
            key={item.id}
            value={item.notes}
            onCommit={(v) => store.editItem(item.id, { notes: v })}
          />
        </div>
      </section>

      {/* Resupply */}
      <section class="item-section">
        <h2 class="item-section-title">Resupply</h2>

        {rhythmLine !== null && <p class="muted item-hint">{rhythmLine}</p>}

        {item.flagged ? (
          <div class="item-inline">
            <span>
              <span class="flag-dot" /> On the shopping list{" "}
              <span class="muted">({flaggedCaption})</span>
            </span>
            <button
              type="button"
              class="btn"
              onClick={() => {
                // Manual clear for flags that will never end in a purchase
                // (PLAN.md §1.2 fix 4). Action language: the button removes
                // the item from the list, it does not assert stock state.
                store.clearFlag(item.id);
                toast(`${item.name}: removed from shopping list`);
              }}
            >
              Remove from shopping list
            </button>
          </div>
        ) : (
          <div class="item-inline">
            <span class="muted">Not on the shopping list</span>
            <button type="button" class="btn" onClick={() => store.flagManual(item.id)}>
              Flag for shopping
            </button>
          </div>
        )}

        {item.display_mode === "ladder" ? (
          <div class="item-field">
            <div class="item-label">Auto-flag when it drops to</div>
            <div class="chips">
              <button
                type="button"
                class={`chip${item.threshold === null ? " chip-active" : ""}`}
                onClick={() => store.editItem(item.id, { threshold: null })}
              >
                Off
              </button>
              {(["out", "low", "half", "full"] as LadderRung[]).map((r) => (
                <button
                  key={r}
                  type="button"
                  class={`chip${activeThresholdRung === r ? " chip-active" : ""}`}
                  // Stored as the rung's numeric value (PLAN.md §1.7).
                  onClick={() => store.editItem(item.id, { threshold: rungValue(r) })}
                >
                  {RUNG_LABELS[r]}
                </button>
              ))}
            </div>
            {activeThresholdRung !== null && (
              // Rung phrasing of the same rule the number mode states: a
              // write landing at/below the threshold (dropping, or the first
              // count) flags.
              <p class="muted item-hint">
                Flags when a count lands at {RUNG_LABELS[activeThresholdRung]} or below.
              </p>
            )}
          </div>
        ) : (
          <div class="item-field">
            <div class="item-label">Auto-flag at or below</div>
            <div class="item-inline">
              <DecField
                value={item.threshold}
                ariaLabel="Flag threshold"
                allowNull
                onCommit={(n) => store.editItem(item.id, { threshold: n })}
              />
              <span class="muted">{item.unit === "count" ? "" : item.unit}</span>
              {item.threshold !== null && (
                <button
                  type="button"
                  class="btn"
                  onClick={() => store.editItem(item.id, { threshold: null })}
                >
                  Off
                </button>
              )}
            </div>
            <p class="muted item-hint">
              {item.threshold === null
                ? "Blank = never flags itself; you can still flag by hand."
                : `Flags when a count lands at ${fmtQtyUnit(item.threshold, item.unit)} or below.`}
            </p>
          </div>
        )}

        <div class="item-field">
          <div class="item-label">Usually buy</div>
          <div class="item-inline">
            <DecField
              value={item.restock_amount}
              ariaLabel="Restock amount"
              requirePositive
              onCommit={(n) => {
                if (n !== null) store.editItem(item.id, { restock_amount: n });
              }}
            />
            <span class="muted">{item.unit === "count" ? "" : item.unit}</span>
          </div>
          <p class="muted item-hint">Checking it off while shopping adds this much.</p>
        </div>

        <div class="item-field">
          <label class="item-toggle">
            <input
              type="checkbox"
              checked={item.never_prompt}
              onChange={(e) => store.setNeverPrompt(item.id, e.currentTarget.checked)}
            />
            <span>🔕 Never auto-flag</span>
          </label>
          <p class="muted item-hint">
            Running low will never put this on the shopping list by itself; flagging by hand
            still works. Shown with a muted 🔕 so the silence stays visible.
          </p>
        </div>
      </section>

      {/* Unit & package — guarded flows, never bare edits (PLAN.md §1.5) */}
      <section class="item-section">
        <h2 class="item-section-title">Unit &amp; package</h2>
        <div class="item-inline">
          <span>
            Counted in <strong>{item.unit}</strong>
          </span>
          <button type="button" class="btn" onClick={() => setUnitSheet(true)}>
            Change unit…
          </button>
        </div>
        <div class="item-inline">
          {item.package_size !== null ? (
            <span>
              1 {item.unit} = {fmtQtyUnit(item.package_size.amount, item.package_size.unit)}
            </span>
          ) : (
            <span class="muted">No package size</span>
          )}
          <button type="button" class="btn" onClick={() => setPkgSheet(true)}>
            {item.package_size !== null ? "Edit…" : "Set…"}
          </button>
        </div>
      </section>

      {/* Merge tool */}
      <section class="item-section">
        <button type="button" class="btn btn-big" onClick={() => setMergeSheet(true)}>
          Merge into another item…
        </button>
        <p class="muted item-hint">
          Duplicate repair: this item becomes an alias of the one you pick; its history is
          preserved.
        </p>
      </section>

      <HistorySection doc={doc} itemId={item.id} nowIso={nowIso} />

      {/* Danger zone */}
      <section class="item-section item-danger">
        <button
          type="button"
          class="btn btn-danger btn-big"
          onClick={() => {
            const ok = window.confirm(
              `Delete “${item.name}”? It stays findable in search and can be restored there with its history intact.`,
            );
            if (!ok) return;
            store.softDelete(item.id);
            nav.closeItem();
            // Undo = the restore command; history stays append-only.
            toast(`Deleted ${item.name}`, () => store.restore(item.id));
          }}
        >
          Delete item
        </button>
        <p class="muted item-hint">
          Soft delete: it leaves the pantry but remains findable in search, where a tap
          restores it — same item, history intact.
        </p>
      </section>

      {unitSheet && <UnitChangeSheet item={item} onClose={() => setUnitSheet(false)} />}
      {pkgSheet && <PackageSheet item={item} onClose={() => setPkgSheet(false)} />}
      {mergeSheet && <MergeSheet item={item} onClose={() => setMergeSheet(false)} />}
    </section>
  );
}

/** Notes textarea committing on blur — keeps keystrokes out of the store. */
function NotesField(props: { value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(props.value);
  return (
    <textarea
      class="field-input item-notes"
      rows={2}
      aria-label="Notes"
      value={draft}
      onInput={(e) => setDraft(e.currentTarget.value)}
      onBlur={() => {
        if (draft !== props.value) props.onCommit(draft);
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// CreateSheet — quick create (PLAN.md §5: name is the ONLY required field)
// ---------------------------------------------------------------------------

export function CreateSheet() {
  const store = useStore();
  const doc = useDoc();
  const nav = useNav();
  const toast = useToast();

  const [name, setName] = useState(nav.createPrefill ?? "");
  const [unit, setUnit] = useState("count");
  /** null = using the chip row; non-null = free-entry text is the unit. */
  const [customUnit, setCustomUnit] = useState<string | null>(null);
  const [qty, setQty] = useState("1");
  // Seeded from where the user is standing (an open location card) so an
  // item created mid-shelf files to that shelf, not silently to "elsewhere".
  // The chips below still change or clear it in one tap.
  const [location, setLocation] = useState<string | null>(nav.createDefaults?.location ?? null);
  const [category, setCategory] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [threshold, setThreshold] = useState("");
  const [pkgAmt, setPkgAmt] = useState("");
  const [pkgUnit, setPkgUnit] = useState("");
  const [expiry, setExpiry] = useState("");
  const [notes, setNotes] = useState("");

  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Autofocus is fine here: the user explicitly initiated creation, so the
    // keyboard coming up is the next step, not friction.
    const el = nameRef.current;
    if (el === null) return;
    el.focus();
    // Caret at the end so a search-prefilled name can be continued.
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const effUnit =
    customUnit !== null && customUnit.trim() !== "" ? customUnit.trim() : unit;
  const usingCustom = customUnit !== null;

  // Live duplicate guard (PLAN.md §1.4): tombstones included — restoring
  // keeps the UUID and history instead of minting a colliding duplicate.
  const dupes = name.trim() === "" ? [] : duplicateCandidates(doc.items, name).slice(0, 3);

  const openDupe = (d: Item): void => {
    if (d.deleted_at !== null) {
      store.restore(d.id);
      toast(`Restored ${d.name}`);
    }
    nav.closeCreate();
    nav.openItem(d.id);
  };

  const locationOptions = (() => {
    const seen = new Set<string>();
    return [...SEED_LOCATIONS, ...valuesInUse(doc, "location")].filter((o) => {
      const k = o.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  })();

  const addNewValue = (label: string, existing: string[], set: (v: string) => void): void => {
    const raw = window.prompt(`New ${label}`);
    if (raw === null) return;
    // Reuse existing casing on a case-insensitive match — iOS capitalizes
    // prompt() text, which must not mint "Fridge" beside "fridge".
    const v = resolveVocabValue(existing, raw);
    if (v !== "") set(v);
  };

  const submit = (e: Event): void => {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed === "") return;
    const input: CreateItemInput = { name: trimmed, unit: effUnit };
    const q = parseDec(qty);
    if (q !== null && q >= 0) input.quantity = q;
    if (location !== null) input.location = location;
    if (category !== null) input.category = category;
    if (notes.trim() !== "") input.notes = notes.trim();
    const thr = parseDec(threshold);
    if (thr !== null && thr >= 0) input.threshold = thr;
    const pa = parseDec(pkgAmt);
    if (pa !== null && pa > 0 && pkgUnit.trim() !== "") {
      input.package_size = { amount: pa, unit: pkgUnit.trim() };
    }
    if (expiry !== "") input.expiry = expiry;
    const item = store.createItem(input);
    nav.closeCreate();
    toast(`Added ${item.name}`);
  };

  return (
    <Sheet open onClose={nav.closeCreate} title="New item">
      <form class="create-form" onSubmit={submit}>
        <input
          ref={nameRef}
          class="field-input"
          type="text"
          aria-label="Name"
          placeholder="Name"
          autocomplete="off"
          value={name}
          onInput={(e) => setName(e.currentTarget.value)}
        />

        {dupes.length > 0 && (
          <div class="dupe-guard">
            <p class="muted item-hint">Did you mean…</p>
            {dupes.map((d) => (
              <button key={d.id} type="button" class="row dupe-row" onClick={() => openDupe(d)}>
                <span class="row-main">
                  <span class="row-title">{d.name}</span>
                  <span class="row-sub">
                    {d.deleted_at !== null
                      ? "deleted — tap to restore with its history"
                      : `${fmtQtyBoth(d)}${d.location !== null ? ` · ${d.location}` : ""}`}
                  </span>
                </span>
                <span class="muted">{d.deleted_at !== null ? "Restore" : "Open"}</span>
              </button>
            ))}
          </div>
        )}

        <div class="item-field">
          <div class="item-label">Unit</div>
          <div class="chips">
            {COMMON_UNITS.map((u) => (
              <button
                key={u}
                type="button"
                class={`chip${!usingCustom && u === unit ? " chip-active" : ""}`}
                onClick={() => {
                  setUnit(u);
                  setCustomUnit(null);
                }}
              >
                {u}
              </button>
            ))}
            <button
              type="button"
              class={`chip${usingCustom ? " chip-active" : ""}`}
              onClick={() => setCustomUnit(customUnit === null ? "" : customUnit)}
            >
              Other…
            </button>
          </div>
          {usingCustom && (
            <input
              class="field-input"
              type="text"
              autocomplete="off"
              aria-label="Custom unit"
              placeholder="Unit (e.g. tub)"
              value={customUnit ?? ""}
              onInput={(e) => setCustomUnit(e.currentTarget.value)}
            />
          )}
        </div>

        <div class="item-field">
          <div class="item-label">Quantity</div>
          <input
            class="field-input item-num"
            type="text"
            inputMode="decimal"
            autocomplete="off"
            aria-label="Quantity"
            value={qty}
            onInput={(e) => setQty(e.currentTarget.value)}
          />
        </div>

        <div class="item-field">
          <div class="item-label">Location</div>
          <div class="chips">
            {locationOptions.map((o) => (
              <button
                key={o}
                type="button"
                class={`chip${o === location ? " chip-active" : ""}`}
                // Tap again to unselect — location stays optional.
                onClick={() => setLocation(o === location ? null : o)}
              >
                {o}
              </button>
            ))}
            <button
              type="button"
              class="chip"
              onClick={() => addNewValue("location", locationOptions, setLocation)}
            >
              ＋ New…
            </button>
          </div>
        </div>

        <div class="item-field">
          <div class="item-label">Category</div>
          <div class="chips">
            {valuesInUse(doc, "category").map((o) => (
              <button
                key={o}
                type="button"
                class={`chip${o === category ? " chip-active" : ""}`}
                onClick={() => setCategory(o === category ? null : o)}
              >
                {o}
              </button>
            ))}
            <button
              type="button"
              class="chip"
              onClick={() => addNewValue("category", valuesInUse(doc, "category"), setCategory)}
            >
              ＋ New…
            </button>
          </div>
        </div>

        <button type="button" class="btn" onClick={() => setMore(!more)}>
          {more ? "Fewer options" : "More options"}
        </button>

        {more && (
          <>
            <div class="item-field">
              <div class="item-label">
                Auto-flag at or below{effUnit === "count" ? "" : ` (${effUnit})`}
              </div>
              <input
                class="field-input item-num"
                type="text"
                inputMode="decimal"
                autocomplete="off"
                aria-label="Flag threshold"
                placeholder="off"
                value={threshold}
                onInput={(e) => setThreshold(e.currentTarget.value)}
              />
            </div>
            <div class="item-field">
              <div class="item-label">Package size: 1 {effUnit} =</div>
              <div class="item-inline">
                <input
                  class="field-input item-num"
                  type="text"
                  inputMode="decimal"
                  autocomplete="off"
                  aria-label="Package amount"
                  placeholder="amount"
                  value={pkgAmt}
                  onInput={(e) => setPkgAmt(e.currentTarget.value)}
                />
                <input
                  class="field-input"
                  type="text"
                  autocomplete="off"
                  aria-label="Package unit"
                  placeholder="unit (e.g. g)"
                  value={pkgUnit}
                  onInput={(e) => setPkgUnit(e.currentTarget.value)}
                />
              </div>
            </div>
            <div class="item-field">
              <div class="item-label">Expiry</div>
              <input
                class="field-input item-date"
                type="date"
                aria-label="Expiry date"
                value={expiry}
                onChange={(e) => setExpiry(e.currentTarget.value)}
              />
            </div>
            <div class="item-field">
              <div class="item-label">Notes</div>
              <input
                class="field-input"
                type="text"
                autocomplete="off"
                aria-label="Notes"
                value={notes}
                onInput={(e) => setNotes(e.currentTarget.value)}
              />
            </div>
          </>
        )}

        <button class="btn btn-primary btn-big" type="submit" disabled={name.trim() === ""}>
          Add
        </button>
      </form>
    </Sheet>
  );
}
