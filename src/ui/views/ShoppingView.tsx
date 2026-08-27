/**
 * Shopping view (PLAN.md §2 "Shopping view"; M2 flow (b): a 20-item restock
 * in under 2 minutes). Three sections, all derived by the shoppingList
 * selector — list membership is never stored here (§1.6):
 *   TO BUY  — flagged items, oldest flag first; ONE big check-off per row IS
 *             the purchase gesture (§1.2), with the amount correctable first.
 *   EXTRAS  — live ad-hoc lines; check-off soft-deletes and offers one-shot
 *             graduation to a real pantry item.
 *   IN CART — today's purchases, dimmed, read-only (derived from events, so
 *             mid-trip state survives page kills for free).
 * All writes go through Store commands (AGENTS.md rule 1).
 */
import { useState } from "preact/hooks";
import { fmtAge, fmtLevel, fmtQty, fmtQtyUnit, parseDec } from "../../domain/format";
import { shoppingList } from "../../store/selectors";
import { now, type Item, type ShoppingExtra } from "../../types";
import { InlineQtyInput, Stepper } from "../components";
import { useDoc, useNav, useStore, useToast } from "../hooks";
import "./shopping.css";

export function ShoppingView() {
  const doc = useDoc();
  const nowIso = now();
  const list = shoppingList(doc, nowIso);

  return (
    <section class="view">
      <h1 class="view-title">Shopping</h1>

      {list.toBuy.length === 0 ? (
        <p class="shop-empty">
          Nothing flagged — the pantry view raises flags when things run low.
        </p>
      ) : (
        <div class="shop-section">
          <h2 class="shop-section-title">To buy</h2>
          {list.toBuy.map((item) => (
            <ToBuyRow key={item.id} item={item} nowIso={nowIso} />
          ))}
        </div>
      )}

      <ExtrasSection extras={list.extras} />

      {list.inCart.length > 0 && (
        <div class="shop-section">
          <h2 class="shop-section-title">In cart ({list.inCart.length})</h2>
          {list.inCart.map((item) => (
            <div key={item.id} class="row shop-cart-row">
              <div class="row-main">
                <div class="row-title">{item.name}</div>
                <div class="row-sub">{fmtLevel(item)}</div>
              </div>
              <span class="shop-cart-mark" aria-hidden="true">
                ✓
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// TO BUY row — the one-big-tap purchase gesture
// ---------------------------------------------------------------------------

function ToBuyRow(props: { item: Item; nowIso: string }) {
  const store = useStore();
  const toast = useToast();
  const item = props.item;

  // Pending purchase amount, corrected BEFORE the buy tap (bought 2, not 1).
  // Local state only: nothing is written until the check-off itself.
  const [pending, setPending] = useState(item.restock_amount);
  const [editing, setEditing] = useState(false); // mini stepper open
  const [entering, setEntering] = useState(false); // decimal entry open

  // Flag provenance: auto flags say how long the need has stood (list order
  // is oldest-first, so the caption explains the ordering too).
  const provenance =
    item.flag_source === "threshold"
      ? `auto · ${fmtAge(item.flagged_at, props.nowIso)}`
      : "manual";

  const buy = (): void => {
    // Capture the flag triple BEFORE the write: purchase always clears the
    // flag, and the compensating recount cannot re-derive a manual flag (or
    // a flag raised exactly ON the threshold boundary) from the quantity
    // move alone — undoing a mistap must put the row back on the list.
    const flagsBefore = {
      flagged: item.flagged,
      flag_source: item.flag_source,
      flagged_at: item.flagged_at,
    };
    store.purchase(item.id, pending);
    // QtyControl's toast pattern: the store mutated `item` in place, so
    // reading it again gives the post-write state; purchase is a gesture
    // kind, so lastQuantityWrite() feeds the compensating undo.
    const last = store.lastQuantityWrite();
    const message = `Bought ${item.name} — ${fmtLevel(item)}`;
    if (last === null) toast(message);
    else toast(message, () => store.undoQuantity(last.itemId, last.qtyBefore, flagsBefore));
  };

  const havePlenty = (): void => {
    // PLAN.md §1.2 fix 4: the flag path that never ends in a purchase.
    store.clearFlag(item.id);
    // Undo re-raises manually — provenance becomes "manual"/now, which is
    // honest: the re-raise IS a fresh human decision.
    toast(`${item.name}: flag cleared`, () => store.flagManual(item.id));
  };

  const actions = editing ? (
    entering ? (
      <InlineQtyInput
        initial={fmtQty(pending)}
        onDone={(raw) => {
          setEntering(false);
          if (raw === null) return;
          // parseDec rejects blank/garbage/negative — any of those leaves
          // the pending amount unchanged (the store rounds on the write).
          const n = parseDec(raw);
          if (n !== null) setPending(n);
        }}
      />
    ) : (
      <>
        <Stepper
          value={fmtQtyUnit(pending, item.unit)}
          onDelta={(d) => setPending((p) => Math.max(0, p + d))}
          onTapValue={() => setEntering(true)}
        />
        <button class="shop-quiet" type="button" onClick={() => setEditing(false)}>
          done
        </button>
      </>
    )
  ) : (
    <>
      <button
        class="shop-amt"
        type="button"
        aria-label={`Amount to buy: ${fmtQtyUnit(pending, item.unit)} — tap to change`}
        onClick={() => setEditing(true)}
      >
        +{fmtQtyUnit(pending, item.unit)}
      </button>
      <button class="shop-quiet" type="button" onClick={havePlenty}>
        have plenty
      </button>
    </>
  );

  return (
    <div class="row shop-row">
      <div class="row-main">
        <div class="row-title">{item.name}</div>
        <div class="row-sub">
          {fmtLevel(item)} · {provenance}
        </div>
        <div class="shop-actions">{actions}</div>
      </div>
      <button class="shop-check" type="button" aria-label={`Bought ${item.name}`} onClick={buy}>
        ✓
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// EXTRAS — ad-hoc lines with one-shot promote-to-item
// ---------------------------------------------------------------------------

function ExtrasSection(props: { extras: ShoppingExtra[] }) {
  const store = useStore();
  const nav = useNav();
  const toast = useToast();
  const [text, setText] = useState("");
  // One-shot promote prompt (PLAN.md §1.6): the last checked-off extra offers
  // graduation to a real item so one-off buys aren't retyped as
  // near-duplicates later. A newer check-off replaces it; the toast owns
  // undo, so this lives inline rather than competing for the single toast.
  const [prompt, setPrompt] = useState<{ id: string; text: string } | null>(null);

  const check = (extra: ShoppingExtra): void => {
    store.checkExtra(extra.id);
    setPrompt({ id: extra.id, text: extra.text });
    toast(`Got ${extra.text}`, () => {
      store.uncheckExtra(extra.id);
      // Back on the list — offering to add it to the pantry now would be
      // premature noise.
      setPrompt((p) => (p !== null && p.id === extra.id ? null : p));
    });
  };

  const add = (e: Event): void => {
    e.preventDefault();
    const trimmed = text.trim();
    if (trimmed === "") return;
    store.addExtra(trimmed);
    setText("");
  };

  return (
    <div class="shop-section">
      <h2 class="shop-section-title">Extras</h2>
      {props.extras.map((extra) => (
        <div key={extra.id} class="row">
          <div class="row-main">
            <div class="row-title">{extra.text}</div>
          </div>
          <button
            class="shop-check"
            type="button"
            aria-label={`Got ${extra.text}`}
            onClick={() => check(extra)}
          >
            ✓
          </button>
        </div>
      ))}
      {prompt !== null && (
        <div class="shop-prompt" role="status">
          <span class="shop-prompt-text">Add “{prompt.text}” to the pantry?</span>
          <button
            class="btn"
            type="button"
            onClick={() => {
              nav.openCreate(prompt.text);
              setPrompt(null);
            }}
          >
            Add
          </button>
          <button
            class="shop-quiet"
            type="button"
            aria-label="Dismiss"
            onClick={() => setPrompt(null)}
          >
            ✕
          </button>
        </div>
      )}
      <form class="shop-add" onSubmit={add}>
        <input
          class="field-input"
          type="text"
          autocomplete="off"
          placeholder="Add extra — e.g. birthday candles"
          aria-label="Add extra"
          value={text}
          onInput={(e) => setText(e.currentTarget.value)}
        />
        <button class="btn" type="submit">
          Add
        </button>
      </form>
    </div>
  );
}
