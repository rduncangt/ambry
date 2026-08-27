/**
 * Shared building blocks. QtyControl is THE quantity writer (inventory and
 * reconcile rows both use it) so the undo-toast and multi-container-confirm
 * rules live in exactly one place. All writes go through the Store (AGENTS.md
 * rule 1) — nothing here touches storage or builds events.
 */
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { fmtQty, fmtQtyBoth, ladderLabel } from "../domain/format";
import { readRung, rungNeedsConfirm, rungValue } from "../domain/ladder";
import type { Item, LadderRung } from "../types";
import { useStore, useToast } from "./hooks";

// ---------------------------------------------------------------------------
// Sheet — bottom sheet/modal
// ---------------------------------------------------------------------------

export function Sheet(props: {
  open: boolean;
  onClose: () => void;
  title: string;
  children?: ComponentChildren;
}) {
  if (!props.open) return null;
  return (
    <div class="sheet-backdrop" onClick={props.onClose}>
      {/* stopPropagation: a tap inside the sheet must not count as a backdrop
          tap and dismiss it */}
      <div class="sheet" role="dialog" aria-label={props.title} onClick={(e) => e.stopPropagation()}>
        <div class="sheet-head">
          <div class="sheet-title">{props.title}</div>
          <button class="sheet-close" type="button" aria-label="Close" onClick={props.onClose}>
            ✕
          </button>
        </div>
        {props.children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stepper — big +/- around a (tappable) value
// ---------------------------------------------------------------------------

export function Stepper(props: {
  /** Preformatted display value — the component stays dumb about units. */
  value: string;
  onDelta: (d: number) => void;
  /** When given, the value itself is a button (opens absolute entry). */
  onTapValue?: () => void;
}) {
  return (
    <span class="stepper">
      <button class="stepper-btn" type="button" aria-label="Decrease" onClick={() => props.onDelta(-1)}>
        −
      </button>
      {props.onTapValue !== undefined ? (
        <button class="stepper-value" type="button" onClick={props.onTapValue}>
          {props.value}
        </button>
      ) : (
        <span class="stepper-value">{props.value}</span>
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
const RUNG_TEXT: Record<LadderRung, string> = { full: "Full", half: "Half", low: "Low", out: "Out" };

export function LadderChips(props: { item: Item; onRung: (rung: LadderRung) => void }) {
  const active = readRung(props.item.quantity);
  const tap = (rung: LadderRung): void => {
    // Multi-container guard (PLAN.md §1.7): rung values are fractions of ONE
    // container, so a silent write would destroy a multi-container count.
    if (rungNeedsConfirm(props.item.quantity)) {
      const ok = window.confirm(
        `Quantity is ${fmtQty(props.item.quantity)} — set to ${RUNG_TEXT[rung].toLowerCase()} (${fmtQty(rungValue(rung))})?`,
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
          {RUNG_TEXT[rung]}
        </button>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// QtyControl — the shared quantity writer
// ---------------------------------------------------------------------------

/** Inline absolute entry. Commit on submit; blur commits only when the text
 *  changed (an accidental tap elsewhere must not mint a recount event —
 *  deliberate "still the same" confirmation is reconcile's ✓, not this). */
function InlineQtyInput(props: { initial: string; onDone: (raw: string | null) => void }) {
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
          if (e.key === "Escape") finish(null);
        }}
        onBlur={() => finish(val === props.initial ? null : val)}
      />
    </form>
  );
}

export function QtyControl(props: { item: Item }) {
  const store = useStore();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const item = props.item;

  /** Every write ends here: the store mutated `item` in place, so reading it
   *  again gives the post-write state for the message; lastQuantityWrite()
   *  feeds the compensating undo. */
  const fireUndoToast = (): void => {
    const message =
      item.display_mode === "ladder"
        ? `${item.name}: ${ladderLabel(item.quantity, readRung(item.quantity))}`
        : `${item.name}: ${fmtQtyBoth(item)}`;
    const last = store.lastQuantityWrite();
    if (last === null) toast(message);
    else toast(message, () => store.undoQuantity(last.itemId, last.qtyBefore));
  };

  const commitAbsolute = (raw: string | null): void => {
    setEditing(false);
    if (raw === null) return;
    // Decimal-comma tolerance; the store rounds and clamps (roundQty).
    const n = Number(raw.trim().replace(",", "."));
    if (raw.trim() === "" || !Number.isFinite(n)) return;
    store.setQuantity(item.id, n);
    fireUndoToast();
  };

  const marks = (
    <span class="qty-marks">
      {item.flagged && <span class="flag-dot" title="Flagged for shopping" />}
      {item.never_prompt && (
        <span class="nobell" title="Auto-flag off">
          🔕
        </span>
      )}
      {item.quantity === 0 && <span class="badge badge-out">Out</span>}
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
    return (
      <span class="qty">
        {marks}
        <button class="qty-value" type="button" onClick={() => setEditing(true)}>
          {ladderLabel(item.quantity, readRung(item.quantity))}
          {item.package_size !== null && <span class="qty-sub muted">{fmtQtyBoth(item)}</span>}
        </button>
        <LadderChips
          item={item}
          onRung={(rung) => {
            store.setLadderRung(item.id, rung);
            fireUndoToast();
          }}
        />
      </span>
    );
  }

  return (
    <span class="qty">
      {marks}
      <Stepper
        value={fmtQtyBoth(item)}
        onDelta={(d) => {
          store.adjustQuantity(item.id, d);
          fireUndoToast();
        }}
        onTapValue={() => setEditing(true)}
      />
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
