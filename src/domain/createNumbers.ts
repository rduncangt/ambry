/** Validate numeric drafts before item creation. Blank optional fields keep
 *  their existing defaults; explicitly invalid text must never become stock. */
import { roundQty } from "../types";
import { parseDec } from "./format";

export interface CreateNumberDrafts {
  quantity: string;
  threshold: string;
  packageAmount: string;
  packageUnit: string;
}
export type CreateNumberErrors = Partial<Record<keyof CreateNumberDrafts, string>>;
interface CreateNumbers {
  quantity?: number;
  threshold?: number;
  package_size?: { amount: number; unit: string };
}
export type CreateNumberResult =
  | { ok: true; values: CreateNumbers }
  | { ok: false; errors: CreateNumberErrors };

export function parseCreateNumbers(drafts: CreateNumberDrafts): CreateNumberResult {
  const values: CreateNumbers = {};
  const errors: CreateNumberErrors = {};
  if (drafts.quantity.trim() !== "") {
    const n = parseDec(drafts.quantity);
    if (n === null || !Number.isFinite(roundQty(n))) errors.quantity = "Enter a quantity of 0 or more, or leave blank to use 1.";
    else values.quantity = n;
  }
  if (drafts.threshold.trim() !== "") {
    const n = parseDec(drafts.threshold);
    if (n === null) errors.threshold = "Enter a flag threshold of 0 or more, or leave blank to turn it off.";
    else values.threshold = n;
  }
  const unit = drafts.packageUnit.trim();
  if (drafts.packageAmount.trim() !== "" || unit !== "") {
    const n = parseDec(drafts.packageAmount);
    if (n === null || n <= 0) errors.packageAmount = "Enter a package amount greater than 0, or clear both package fields.";
    if (unit === "") errors.packageUnit = "Enter the package unit, or clear both package fields.";
    if (n !== null && n > 0 && unit !== "") values.package_size = { amount: n, unit };
  }
  return Object.keys(errors).length === 0 ? { ok: true, values } : { ok: false, errors };
}
