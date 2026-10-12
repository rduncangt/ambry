/** Shopping is two steps: stage what is in the cart, then check out.
 *  Staging, amount edits and put-back never change pantry stock or history.
 *  The saved cart survives navigation, app restarts and overnight trips. */
import { useState } from "preact/hooks";
import { fmtAge, fmtAgeShort, fmtLevel, fmtQty, isUncounted, parseDec } from "../../domain/format";
import { groupByCategory, shoppingList } from "../../store/selectors";
import { now, type Item, type ShoppingExtra } from "../../types";
import { CartMinusIcon, CartPlusIcon, InlineQtyInput, qtyLines, Stepper, TrashIcon } from "../components";
import { useDoc, useNav, useStore, useToast } from "../hooks";
import "./shopping.css";

export function ShoppingView() {
  const doc = useDoc();
  const store = useStore();
  const toast = useToast();
  const nav = useNav();
  const [error, setError] = useState<string | null>(null);
  const [prompts, setPrompts] = useState<ShoppingExtra[]>([]);
  const nowIso = now();
  const list = shoppingList(doc);
  const cartCount = list.inCart.length + list.cartExtras.length;

  const checkout = (): void => {
    const result = store.checkout();
    if (!result.ok) { setError(result.error); return; }
    setError(null);
    const count = result.itemCount + result.extras.length;
    if (count === 0) return;
    setPrompts((old) => [...old, ...result.extras]);
    toast(`Checked out ${count} ${count === 1 ? "item" : "items"}${result.itemCount > 0 ? " — pantry updated" : ""}`);
  };

  return (
    <section class="view">
      <header class="sticky-head"><h1 class="view-title">Shopping</h1></header>
      {list.toBuy.length === 0 ? (
        <p class="shop-empty">
          {cartCount > 0 ? "No pantry items left to pick up — review your cart below." :
            "Nothing flagged — the pantry view raises flags when things run low."}
        </p>
      ) : (
        <div class="shop-section">
          <h2 class="shop-section-title">To buy</h2>
          {groupByCategory(list.toBuy).map((group, _, groups) => (
            <div key={group.category ?? ""} class="shop-cat">
              {(groups.length > 1 || group.category !== null) && (
                <h3 class="shop-cat-title">{group.category ?? "other"}</h3>
              )}
              {group.items.map((item) => <ToBuyRow key={item.id} item={item} nowIso={nowIso} />)}
            </div>
          ))}
        </div>
      )}

      <ExtrasSection extras={list.extras} />

      {cartCount > 0 && (
        <div class="shop-section">
          <h2 class="shop-section-title">In the cart</h2>
          <p class="shop-section-sub">Review, then check out to update your pantry.</p>
          {list.inCart.map((item) => <InCartRow key={item.id} item={item} />)}
          {list.cartExtras.map((extra) => <ExtraCartRow key={extra.id} extra={extra} />)}
          <button class="btn btn-primary shop-finish" type="button" onClick={checkout}>
            Check out ({cartCount})
          </button>
        </div>
      )}
      {error !== null && <p class="settings-error" role="alert">{error}</p>}

      {/* Extras graduate only after they have actually been purchased. */}
      {prompts.map((extra) => (
        <div key={extra.id} class="shop-prompt" role="status">
          <span class="shop-prompt-text">Add “{extra.text}” to the pantry?</span>
          <button class="btn" type="button" onClick={() => {
            nav.openCreate(extra.text);
            setPrompts((old) => old.filter((x) => x.id !== extra.id));
          }}>Add</button>
          <button class="shop-quiet" type="button" aria-label="Dismiss" onClick={() =>
            setPrompts((old) => old.filter((x) => x.id !== extra.id))}>✕</button>
        </div>
      ))}
    </section>
  );
}

/** The same persisted amount is editable both before and after staging. */
function BuyAmount(props: { item: Item; label: string }) {
  const store = useStore();
  const [entering, setEntering] = useState(false);
  const amount = props.item.shopping_amount ?? props.item.restock_amount;
  const lines = qtyLines(amount, props.item.unit);
  return (
    <div class="shop-buy-amount">
      <span class="shop-buy-label">{props.label}</span>
      {entering ? (
        <InlineQtyInput initial={fmtQty(amount)} onDone={(raw) => {
          setEntering(false);
          if (raw === null) return;
          const n = parseDec(raw);
          if (n !== null) store.setShoppingAmount(props.item.id, n);
        }} />
      ) : (
        <span class="shop-stepper">
          <Stepper value={lines.num} unit={lines.unit}
            valueTitle="Amount to buy — tap to type an exact amount"
            onDelta={(d) => store.setShoppingAmount(props.item.id, Math.max(0, amount + d))}
            onTapValue={() => setEntering(true)} />
        </span>
      )}
    </div>
  );
}

function stockCaption(item: Item): string {
  return isUncounted(item) ? "Have: not counted" : `Have: ${fmtLevel(item)}`;
}

function InCartRow(props: { item: Item }) {
  const store = useStore();
  const toast = useToast();
  const nav = useNav();
  const item = props.item;
  return (
    <div class="shop-card">
      <div class="shop-card-top">
        <button class="shop-card-main shop-open" type="button" onClick={() => nav.openItem(item.id)}>
          <div class="row-title">{item.name}</div>
          <div class="row-sub">{stockCaption(item)}</div>
        </button>
        <button class="shop-check shop-check-remove" type="button"
          aria-label={`Put ${item.name} back — remove from cart`} onClick={() => {
            store.putBackItem(item.id);
            toast(`${item.name} put back`, () => { store.stageItem(item.id); });
          }}><CartMinusIcon /></button>
      </div>
      <div class="shop-card-acts"><BuyAmount item={item} label="In cart" /></div>
    </div>
  );
}

function ToBuyRow(props: { item: Item; nowIso: string }) {
  const store = useStore();
  const toast = useToast();
  const nav = useNav();
  const item = props.item;
  const age = item.flagged_at === null ? null : fmtAgeShort(item.flagged_at, props.nowIso);
  const stage = (): void => {
    if (!store.stageItem(item.id)) {
      toast("Check the buy amount before adding this item to the cart");
      return;
    }
    toast(`${item.name} added to cart`, () => store.putBackItem(item.id));
  };
  const removeFromList = (): void => {
    const planned = item.shopping_amount;
    store.clearFlag(item.id);
    toast(`${item.name}: removed from list`, () => {
      store.flagManual(item.id);
      if (planned !== undefined) store.setShoppingAmount(item.id, planned);
    });
  };
  return (
    <div class="shop-card">
      <div class="shop-card-top">
        <button class="shop-card-main shop-open" type="button" onClick={() => nav.openItem(item.id)}>
          <div class="row-title">{item.name}</div>
          <div class="row-sub">
            {stockCaption(item)}
            {age !== null && <span class="shop-age" title={`On the list ${fmtAge(item.flagged_at, props.nowIso)}`}>{age}</span>}
          </div>
        </button>
        <button class="shop-trash" type="button" aria-label="Remove from list" onClick={removeFromList}>
          <TrashIcon />
        </button>
      </div>
      <div class="shop-card-acts">
        <BuyAmount item={item} label="Buy" />
        <button class="shop-check shop-check-add" type="button" aria-label={`Add ${item.name} to cart`} onClick={stage}>
          <CartPlusIcon />
        </button>
      </div>
    </div>
  );
}

function ExtraCartRow(props: { extra: ShoppingExtra }) {
  const store = useStore();
  const toast = useToast();
  const extra = props.extra;
  return (
    <div class="shop-card">
      <div class="shop-card-top shop-card-center">
        <div class="shop-card-main"><div class="row-title">{extra.text}</div></div>
        <RemoveExtraButton extra={extra} />
        <button class="shop-check shop-check-remove" type="button"
          aria-label={`Put ${extra.text} back — remove from cart`} onClick={() => {
            store.putBackExtra(extra.id);
            toast(`${extra.text} put back`, () => { store.stageExtra(extra.id); });
          }}><CartMinusIcon /></button>
      </div>
    </div>
  );
}

function ExtrasSection(props: { extras: ShoppingExtra[] }) {
  const store = useStore();
  const toast = useToast();
  const [text, setText] = useState("");
  return (
    <div class="shop-section">
      <h2 class="shop-section-title">Extras</h2>
      {props.extras.map((extra) => (
        <div key={extra.id} class="shop-card">
          <div class="shop-card-top shop-card-center">
            <div class="shop-card-main"><div class="row-title">{extra.text}</div></div>
            <RemoveExtraButton extra={extra} />
            <button class="shop-check shop-check-add" type="button" aria-label={`Add ${extra.text} to cart`} onClick={() => {
              if (store.stageExtra(extra.id)) toast(`${extra.text} added to cart`, () => store.putBackExtra(extra.id));
            }}><CartPlusIcon /></button>
          </div>
        </div>
      ))}
      <form class="shop-add" onSubmit={(e) => {
        e.preventDefault();
        const trimmed = text.trim();
        if (trimmed === "") return;
        store.addExtra(trimmed);
        setText("");
      }}>
        <input class="field-input" type="text" autocomplete="off"
          placeholder="Add extra — e.g. birthday candles" aria-label="Add extra"
          value={text} onInput={(e) => setText(e.currentTarget.value)} />
        <button class="btn" type="submit">Add</button>
      </form>
    </div>
  );
}

function RemoveExtraButton(props: { extra: ShoppingExtra }) {
  const store = useStore();
  const toast = useToast();
  return (
    <button class="shop-quiet shop-extra-remove" type="button" aria-label={`Remove ${props.extra.text} from shopping list`}
      onClick={() => {
        const removal = store.removeExtra(props.extra.id);
        if (removal !== null) toast(`${props.extra.text} removed`, () => store.undoExtraRemoval(removal));
      }}><TrashIcon /></button>
  );
}
