/**
 * Shared building blocks. QtyControl is THE quantity writer (inventory and
 * reconcile rows both use it) so the undo-toast and multi-container-confirm
 * rules live in exactly one place. All writes go through the Store (AGENTS.md
 * rule 1) — nothing here touches storage or builds events.
 */
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { fmtLevel, fmtQty, fmtQtyUnit, ladderLabel, parseDec, RUNG_LABELS } from "../domain/format";
import { readRung, rungNeedsConfirm, rungValue } from "../domain/ladder";
import { toPreciseUnit } from "../domain/units";
import { isUncounted } from "../store/selectors";
import type { Item, LadderRung } from "../types";
import { useStore, useToast } from "./hooks";

// ---------------------------------------------------------------------------
// Sheet — bottom sheet/modal
// ---------------------------------------------------------------------------

export { Sheet, ItemOverlay } from "./ModalView";

// ---------------------------------------------------------------------------
// Stepper — big +/- around a (tappable) stacked value
// ---------------------------------------------------------------------------

/**
 * Split a quantity for the Stepper's two-line value: line 1 the number,
 * line 2 the pluralized unit word — or null when fmtQtyUnit renders bare
 * (count-family and empty units), so no unit line appears. Derived FROM
 * fmtQtyUnit so the stacked value can never disagree with the flat string
 * used in toasts and captions.
 */
export function qtyLines(qty: number, unit: string): { num: string; unit: string | null } {
  const full = fmtQtyUnit(qty, unit);
  const num = fmtQty(qty);
  return { num, unit: full === num ? null : full.slice(num.length + 1) };
}

export function Stepper(props: {
  /** Line 1, preformatted — the number, or a state word ("Out", "–"). */
  value: string;
  /** Line 2 — small muted unit line ("bags", "bags · 400 g"); omit/null for
   *  none. The component stays dumb about units: callers split via qtyLines. */
  unit?: string | null;
  /** Extra class on line 1 (the Out/– value-state tones). */
  valueClass?: string;
  /** Title on the value block (the uncounted "–" state's explanation). */
  valueTitle?: string;
  onDelta: (d: number) => void;
  /** When given, the value itself is a button (opens absolute entry). */
  onTapValue?: () => void;
}) {
  // One block, one tap target: number over unit inside the same button/span.
  const stacked = (
    <>
      <span class={`stepper-num${props.valueClass !== undefined ? ` ${props.valueClass}` : ""}`}>
        {props.value}
      </span>
      {props.unit !== undefined && props.unit !== null && (
        <span class="stepper-unit">{props.unit}</span>
      )}
    </>
  );
  return (
    <span class="stepper">
      <button class="stepper-btn" type="button" aria-label="Decrease" onClick={() => props.onDelta(-1)}>
        −
      </button>
      {props.onTapValue !== undefined ? (
        <button class="stepper-value" type="button" title={props.valueTitle} onClick={props.onTapValue}>
          {stacked}
        </button>
      ) : (
        <span class="stepper-value" title={props.valueTitle}>
          {stacked}
        </span>
      )}
      <button class="stepper-btn" type="button" aria-label="Increase" onClick={() => props.onDelta(1)}>
        +
      </button>
    </span>
  );
}

// ---------------------------------------------------------------------------
// LadderChips — Full / Half / Low / Out
// ---------------------------------------------------------------------------

const RUNGS: LadderRung[] = ["full", "half", "low", "out"];

export function LadderChips(props: { item: Item; onRung: (rung: LadderRung) => void }) {
  // An uncounted item has no current rung: quantity 0 would light "Out",
  // asserting a verified absence the collapsed "–" chip just declined to make.
  const active = isUncounted(props.item) ? null : readRung(props.item.quantity);
  const tap = (rung: LadderRung): void => {
    // Multi-container guard (PLAN.md §1.7): rung values are fractions of ONE
    // container, so a silent write would destroy a multi-container count.
    if (rungNeedsConfirm(props.item.quantity)) {
      const ok = window.confirm(
        `Quantity is ${fmtQty(props.item.quantity)} — set to ${RUNG_LABELS[rung].toLowerCase()} (${fmtQty(rungValue(rung))})?`,
      );
      if (!ok) return;
    }
    props.onRung(rung);
  };
  return (
    <span class="ladder" role="group" aria-label="Level">
      {RUNGS.map((rung) => (
        <button
          key={rung}
          type="button"
          class={`chip${rung === active ? " chip-active" : ""}`}
          onClick={() => tap(rung)}
        >
          {RUNG_LABELS[rung]}
        </button>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// QtyControl — the shared quantity writer
// ---------------------------------------------------------------------------

/** Inline absolute entry (shared: QtyControl here, ShoppingView's buy-amount
 *  entry). Commit on submit; blur commits only when the text changed (an
 *  accidental tap elsewhere must not mint a recount event — deliberate
 *  "still the same" confirmation is reconcile's ✓, not this). */
export function InlineQtyInput(props: { initial: string; onDone: (raw: string | null) => void }) {
  const [val, setVal] = useState(props.initial);
  const inputRef = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    // select() so typing replaces the old number — no delete-first dance.
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const finish = (raw: string | null): void => {
    // Submit fires blur right after — first outcome wins, no double commit.
    if (done.current) return;
    done.current = true;
    props.onDone(raw);
  };

  return (
    <form
      class="qty-form"
      onSubmit={(e) => {
        e.preventDefault();
        finish(val);
      }}
    >
      <input
        ref={inputRef}
        class="qty-input"
        type="text"
        inputMode="decimal"
        autocomplete="off"
        aria-label="Quantity"
        value={val}
        onInput={(e) => setVal(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.preventDefault(); finish(null); }
        }}
        onBlur={() => finish(val === props.initial ? null : val)}
      />
    </form>
  );
}

export function QtyControl(props: {
  item: Item;
  /** Unit-only second line ("bags") for tight list rows; the detail overlay
   *  (non-brief) folds the derived side into the unit line ("bags · 400 g")
   *  — toasts, via fmtLevel, keep the full flat fmtQtyBoth string. */
  brief?: boolean;
  /** Suppress the cart mark: for rows whose own cart toggle already
   *  shows the flag state (InventoryView) — two marks for one fact is
   *  noise. Rows without that control (Reconcile, the item page) keep it. */
  hideFlag?: boolean;
}) {
  const store = useStore();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  /** Ladder rows collapse to ONE chip (the current rung); this opens the
   *  full rung row in place, for this row only. */
  const [ladderOpen, setLadderOpen] = useState(false);
  const ladderRef = useRef<HTMLSpanElement>(null);
  const item = props.item;

  // Tapping anywhere outside this control collapses the expanded rung row —
  // an abandoned expansion must not leave four chips crowding the row.
  useEffect(() => {
    if (!ladderOpen) return;
    const isInside = (t: EventTarget | null): boolean => {
      const root = ladderRef.current;
      return root !== null && t instanceof Node && root.contains(t);
    };
    // Two-phase outside-close (same rule as PickerRow): dead-area taps
    // dismiss on pointerdown; taps on interactive controls collapse only
    // after their click completes, so the re-layout can't shift the target
    // out from under the finger mid-gesture.
    const onPointerDown = (e: PointerEvent): void => {
      if (isInside(e.target)) return;
      const interactive =
        e.target instanceof Element && e.target.closest("button,input,textarea,select,label,a") !== null;
      if (!interactive) setLadderOpen(false);
    };
    const onClickCapture = (e: MouseEvent): void => {
      if (!isInside(e.target)) setLadderOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("click", onClickCapture, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("click", onClickCapture, true);
    };
  }, [ladderOpen]);

  /** Snapshot the flag triple BEFORE a write: quantity writes can raise or
   *  clear the flag as a side effect, and undo must put back the exact prior
   *  flag state — the compensating recount's own flag evaluation cannot
   *  reconstruct e.g. a manual flag a purchase cleared. */
  const flagsBefore = (): {
    flagged: boolean;
    flag_source: Item["flag_source"];
    flagged_at: string | null;
    verified_at: string | null;
  } => ({
    flagged: item.flagged,
    flag_source: item.flag_source,
    flagged_at: item.flagged_at,
    // A retracted count must also retract its observation stamp, or an
    // undone first tap leaves a "–" item wearing a false verified "Out".
    verified_at: item.verified_at,
  });

  /** Every write ends here: the store mutated `item` in place, so fmtLevel
   *  reads the post-write state for the message; lastQuantityWrite() feeds
   *  the compensating undo, `restore` the pre-write flag snapshot. */
  const fireUndoToast = (restore: ReturnType<typeof flagsBefore>): void => {
    const message = `${item.name}: ${fmtLevel(item)}`;
    const last = store.lastQuantityWrite();
    if (last === null) toast(message);
    else toast(message, () => store.undoQuantity(last.itemId, last.qtyBefore, restore));
  };

  /** The current stepper burst's ORIGIN flag snapshot. The store coalesces
   *  rapid add/use taps into one event whose qty_before stays the burst's
   *  origin, so undo restores the pre-burst quantity — the flag snapshot it
   *  rides with must be pre-burst too, not the last tap's (a mid-burst
   *  threshold crossing would otherwise survive the undo as a phantom flag). */
  const burstRestore = useRef<{
    itemId: string;
    qtyBefore: number;
    /** The coalesced event's identity — coalescing updates one event in
     *  place, so "same id before and after the write" is exact proof of a
     *  continuing burst (qtyBefore alone can collide with an earlier no-op
     *  write at the same quantity and resurrect a stale snapshot). */
    eventId: string;
    restore: ReturnType<typeof flagsBefore>;
  } | null>(null);

  const onDelta = (d: number): void => {
    const restore = flagsBefore();
    // First observation: a +/− on a never-counted zero IS a count, not a
    // consumption delta — route it through the recount path so verified_at
    // is stamped and the unknown "–" becomes an actual count.
    // Subsequent taps are ordinary deltas again.
    if (isUncounted(item)) {
      store.setQuantity(item.id, item.quantity + d);
      fireUndoToast(restore);
      return;
    }
    const before = store.lastQuantityWrite();
    store.adjustQuantity(item.id, d);
    const after = store.lastQuantityWrite();
    if (after === null) {
      // Unreachable after a successful adjust; degrade to the plain snapshot.
      fireUndoToast(restore);
      return;
    }
    // This tap coalesced into the running burst iff the last gesture event
    // is unchanged (same item, same origin) AND our ref tracked that burst —
    // then undo must reuse the burst-origin snapshot, not this tap's.
    const prev = burstRestore.current;
    const effective =
      prev !== null &&
      before !== null &&
      before.eventId === after.eventId && // coalesced: same event updated in place
      prev.eventId === after.eventId
        ? prev.restore
        : restore;
    burstRestore.current = {
      itemId: after.itemId,
      qtyBefore: after.qtyBefore,
      eventId: after.eventId,
      restore: effective,
    };
    fireUndoToast(effective);
  };

  const commitAbsolute = (raw: string | null): void => {
    setEditing(false);
    if (raw === null) return;
    // parseDec: decimal-comma tolerance, rejects negatives; the store rounds
    // and clamps (roundQty).
    const n = parseDec(raw);
    if (n === null) return;
    const restore = flagsBefore();
    store.setQuantity(item.id, n);
    fireUndoToast(restore);
  };

  const marks = (
    <span class="qty-marks">
      {item.flagged && props.hideFlag !== true && <CartMarkIcon />}
      {item.never_prompt && (
        <span class="nobell" title="Auto-flag off">
          🔕
        </span>
      )}
      {/* No Out/– pills here: state lives in the value itself — the number
          rows' stepper value line says Out/–, matching the ladder chip's
          vocabulary (its rung chip already says the same words). */}
    </span>
  );

  if (editing) {
    return (
      <span class="qty">
        {marks}
        <InlineQtyInput initial={fmtQty(item.quantity)} onDone={commitAbsolute} />
      </span>
    );
  }

  if (item.display_mode === "ladder") {
    const unknown = isUncounted(item);
    return (
      <span class="qty" ref={ladderRef}>
        {marks}
        {ladderOpen ? (
          // Expanded in place: the four rungs, existing confirm rules intact.
          // Choosing one (or tapping anywhere else) collapses back.
          <LadderChips
            item={item}
            onRung={(rung) => {
              setLadderOpen(false);
              const restore = flagsBefore();
              store.setLadderRung(item.id, rung);
              fireUndoToast(restore);
            }}
          />
        ) : (
          <button
            // Control-scale outline chip (.qty-rung), NOT the filled
            // .chip-active: solid fill is the expanded row's selected-rung
            // voice; collapsed, this is a button that opens the ladder.
            class={`chip qty-rung${unknown ? " qty-rung-unknown" : ""}`}
            type="button"
            title={unknown ? "Never counted — set during a shelf walk" : undefined}
            onClick={() => setLadderOpen(true)}
          >
            {/* A zero nobody ever counted must not claim "Out": the chip
                carries the same quiet "–" the number rows wear (the dashed
                style and title above already say the rest — a dash states
                "no value yet" without a hundred seeded rows reading as a
                hundred nagging questions). */}
            {unknown ? "–" : ladderLabel(item.quantity, readRung(item.quantity))}
          </button>
        )}
      </span>
    );
  }

  // Number mode: stacked value — the number over a small unit line. List
  // rows (brief) carry just the unit word; the detail overlay folds the
  // derived side in beside it ("bags · 400 g").
  // Zero states live IN the value, sharing the ladder chip's vocabulary: a
  // verified zero says "Out" (quiet danger text, no pill); a zero no human
  // ever observed is not "Out" — it's "–" (seeded items wear this until the
  // first shelf-walk count). The unit line stays; tap still opens entry.
  const unknown = isUncounted(item);
  const lines = qtyLines(item.quantity, item.unit);
  let unitLine = lines.unit;
  // Fold the derived side in ("bags · 400 g") only when there is a real
  // number to derive from: under a "–" the small line asserting a measured
  // "0 g" would contradict the value's refusal to claim anything, and under
  // a verified Out "· 0 g" is pure redundancy.
  if (props.brief !== true && !unknown && item.quantity > 0) {
    const precise = toPreciseUnit(item);
    if (precise !== null) {
      const side = fmtQtyUnit(precise.amount, precise.unit);
      unitLine = unitLine === null ? side : `${unitLine} · ${side}`;
    }
  }
  const out = !unknown && item.quantity === 0;
  return (
    <span class="qty">
      {marks}
      <Stepper
        value={unknown ? "–" : out ? "Out" : lines.num}
        unit={unitLine}
        valueClass={unknown ? "stepper-unknown" : out ? "stepper-out" : undefined}
        valueTitle={unknown ? "Never counted — set during a shelf walk" : undefined}
        onDelta={onDelta}
        onTapValue={() => setEditing(true)}
      />
    </span>
  );
}

// ---------------------------------------------------------------------------
// TrashIcon — remove-from-list glyph
// ---------------------------------------------------------------------------

/** Stroke-style trash-can glyph (currentColor, ~20px — same weight family as
 *  InventoryView's CartIcon). On a list row a trash can unambiguously means
 *  "off this list"; callers wrap it in a 44px hit box and give the button
 *  its aria-label. */
export function TrashIcon() {
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
      <path d="M3.5 6h17" />
      <path d="M8.5 6V4.5A1.5 1.5 0 0 1 10 3h4a1.5 1.5 0 0 1 1.5 1.5V6" />
      <path d="M18.5 6l-.9 13.1a1.5 1.5 0 0 1-1.5 1.4H7.9a1.5 1.5 0 0 1-1.5-1.4L5.5 6" />
      <path d="M10 10.5v6" />
      <path d="M14 10.5v6" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Cart icons — the check-off's add-to-cart glyph and the in-cart done-mark
// ---------------------------------------------------------------------------

/** Stroke-style cart-with-a-plus glyph (currentColor, ~22px — the same
 *  drawing family as TrashIcon above and InventoryView's CartIcon). The
 *  shopping check-off wears it: the gesture reads "into the cart", not a
 *  generic confirm ✓. Callers own the hit box and the aria-label. */
export function CartPlusIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {/* CartIcon's cart, nudged down-left to make room for the + where the
          goods drop in (above the basket's open top). */}
      <path d="M2.5 6.5h2L6.2 16h9.6l1.9-6.2H4.9" />
      <circle cx="7.6" cy="20.4" r="1.4" />
      <circle cx="14.6" cy="20.4" r="1.4" />
      <path d="M18.6 2.6v5.2" />
      <path d="M16 5.2h5.2" />
    </svg>
  );
}

/** The filled state of the same cart drawing — the in-cart row's done-mark.
 *  Solid where CartPlusIcon is open, so a row keeps one continuous landmark
 *  (the cart) as it moves from To Buy to the dimmed cart section. Purely
 *  decorative: aria-hidden, the row's own text carries the state. */
export function CartMinusIcon() {
  // CartPlusIcon's exact geometry with the plus flattened to a minus: the
  // same spot that put a row into the cart takes it back out, in the same
  // drawing. (The old filled "done" mark is gone — inside the In-the-cart
  // section, a cart glyph that only restates the section header is
  // furniture, not information.)
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 6.5h2L6.2 16h9.6l1.9-6.2H4.9" />
      <circle cx="7.6" cy="20.4" r="1.4" />
      <circle cx="14.6" cy="20.4" r="1.4" />
      <path d="M16 5.2h5.2" />
    </svg>
  );
}

/** Mini FILLED cart — the flagged-for-shopping mark beside steppers (the
 *  item page's quantity block, reconcile rows). InventoryView's cart toggle
 *  already says "on the list" with a filled basket; the brown dot that stood
 *  here was a second dialect for the same word. Same drawing as that
 *  toggle's filled state (CartIcon geometry), at mark scale (~14px) in the
 *  accent color (.cart-mark). Purely decorative: aria-hidden, with the
 *  dot's old title on the wrapper — unlike the toggle, this one is not
 *  tappable and asserts nothing the row's controls don't already know. */
export function CartMarkIcon() {
  return (
    <span class="cart-mark" title="Flagged for shopping">
      <svg
        viewBox="0 0 24 24"
        width="14"
        height="14"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M3 4h2.2L7 14.5h10.4L19.6 7H5.8" fill="currentColor" />
        <circle cx="8.5" cy="19.5" r="1.4" fill="currentColor" />
        <circle cx="16.5" cy="19.5" r="1.4" fill="currentColor" />
      </svg>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Banner — install / export / update notices
// ---------------------------------------------------------------------------

export type BannerKind = "info" | "warn";

export function Banner(props: {
  kind: BannerKind;
  /** Label for the single action button. */
  action: string;
  onAction: () => void;
  /** When given, a ✕ dismiss button is shown alongside the action. */
  onDismiss?: () => void;
  children: ComponentChildren;
}) {
  return (
    <div class={`banner banner-${props.kind}`} role="status">
      <div class="banner-body">{props.children}</div>
      <div class="banner-actions">
        <button class="btn btn-primary" type="button" onClick={props.onAction}>
          {props.action}
        </button>
        {props.onDismiss !== undefined && (
          <button class="btn" type="button" aria-label="Dismiss" onClick={props.onDismiss}>
            ✕
          </button>
        )}
      </div>
    </div>
  );
}
