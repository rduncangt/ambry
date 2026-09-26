import { roundQty, type AmbryDoc, type Item, type ShoppingExtra } from "../types";

/** A cart is a saved intention to buy, independent of quantity history. */
export function isCartItem(item: Item): boolean {
  return item.deleted_at === null && item.flagged && item.carted_at !== undefined;
}

export function isCartExtra(extra: ShoppingExtra): boolean {
  return extra.deleted_at === null && extra.carted_at !== undefined;
}

export function validShoppingAmount(amount: unknown): amount is number {
  return typeof amount === "number" && Number.isFinite(amount) && amount >= 0 &&
    Number.isFinite(roundQty(amount));
}

/** Validate every line before the store books any purchase. Use current stock
 *  so a recount made during the trip survives checkout. No writes or events. */
export function planCheckout(doc: AmbryDoc): {
  purchases: { itemId: string; quantity: number }[];
  extras: ShoppingExtra[];
} {
  const purchases = doc.items.filter(isCartItem).map((item) => {
    if (!validShoppingAmount(item.shopping_amount) || !validShoppingAmount(item.quantity)) {
      throw new Error(`Check the amount for ${item.name} before checkout.`);
    }
    const quantity = roundQty(item.quantity + item.shopping_amount);
    if (!Number.isFinite(quantity)) {
      throw new Error(`The amount for ${item.name} is too large.`);
    }
    return { itemId: item.id, quantity };
  });
  return { purchases, extras: doc.extras.filter(isCartExtra) };
}
