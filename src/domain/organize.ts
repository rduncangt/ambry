import type { Item } from "../types";

export type OrganizationFields = Partial<Pick<Item, "location" | "category">>;
export interface OrganizationChange {
  id: string;
  before: OrganizationFields;
  after: OrganizationFields;
}

/** Validate the whole selection before planning any write. Never touch stock. */
export function planOrganization(
  items: Item[], ids: string[], fields: OrganizationFields, declaredLocations: string[],
): OrganizationChange[] {
  const selected = new Set(ids);
  const live = items.filter((item) => selected.has(item.id) && item.deleted_at === null);
  if (live.length !== selected.size) throw new Error("Some selected items are no longer available. Select them again.");
  const after: OrganizationFields = {};
  for (const field of ["location", "category"] as const) {
    const value = fields[field];
    if (value === undefined) continue;
    const trimmed = value?.trim() ?? "";
    const known = items.filter((i) => i.deleted_at === null).map((i) => i[field]);
    if (field === "location") known.push(...declaredLocations);
    after[field] = trimmed === "" ? null :
      known.find((v) => v?.toLowerCase() === trimmed.toLowerCase()) ?? trimmed;
  }
  return live.flatMap((item) => {
    const before: OrganizationFields = {};
    const changed: OrganizationFields = {};
    for (const field of ["location", "category"] as const) {
      if (after[field] !== undefined && item[field] !== after[field]) {
        before[field] = item[field];
        changed[field] = after[field];
      }
    }
    return Object.keys(changed).length === 0 ? [] : [{ id: item.id, before, after: changed }];
  });
}

/** Undo only untouched fields; intervening edits or deletions must survive. */
export function planOrganizationUndo(items: Item[], changes: OrganizationChange[]): OrganizationChange[] {
  return changes.flatMap((change) => {
    const item = items.find((i) => i.id === change.id && i.deleted_at === null);
    if (!item) return [];
    const before: OrganizationFields = {};
    const after: OrganizationFields = {};
    for (const field of ["location", "category"] as const) {
      if (change.before[field] !== undefined && item[field] === change.after[field]) {
        before[field] = item[field];
        after[field] = change.before[field];
      }
    }
    return Object.keys(after).length === 0 ? [] : [{ id: item.id, before, after }];
  });
}
