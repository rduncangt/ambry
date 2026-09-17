import { describe, expect, it } from "vitest";
import type { Item } from "../types";
import { planOrganization, planOrganizationUndo } from "./organize";
const item = (id: string, fields: Partial<Item> = {}) => ({ id, location: "pantry", category: "cans", deleted_at: null, ...fields }) as Item;

describe("bulk organization", () => {
  it("deduplicates selected IDs and canonicalizes against live and declared vocabulary", () => {
    const items = [item("a"), item("b"), item("c", { location: "Garage", category: "Fruit" })];
    const before = structuredClone(items);
    const changes = planOrganization(items, ["a", "b", "a"], { location: " garage ", category: "FRUIT" }, []);
    expect(changes.map((c) => c.after)).toEqual([{ location: "Garage", category: "Fruit" }, { location: "Garage", category: "Fruit" }]);
    expect(planOrganization(items, ["a"], { location: " spare freezer " }, ["Spare freezer"])[0]?.after.location).toBe("Spare freezer");
    expect(items).toEqual(before);
  });
  it("changes only requested fields, supports clearing, and omits no-ops", () => {
    expect(planOrganization([item("a")], ["a"], { category: null }, [])).toEqual([
      { id: "a", before: { category: "cans" }, after: { category: null } },
    ]);
    expect(planOrganization([item("a")], ["a"], { location: "pantry" }, [])).toEqual([]);
    expect(planOrganization([item("a")], ["a"], {}, [])).toEqual([]);
  });
  it("rejects the entire batch if any selected item is missing or deleted", () => {
    expect(() => planOrganization([item("a")], ["a", "missing"], { location: "fridge" }, [])).toThrow();
    expect(() => planOrganization([item("a", { deleted_at: "2026-09-17" })], ["a"], { category: "fruit" }, [])).toThrow();
  });
  it("undo preserves subsequent edits and deleted items", () => {
    const changes = planOrganization([item("a"), item("b")], ["a", "b"], { location: "fridge", category: "fruit" }, []);
    const edited = [item("a", { location: "freezer", category: "fruit" }), item("b", { deleted_at: "2026-09-17", location: "fridge", category: "fruit" })];
    expect(planOrganizationUndo(edited, changes)).toEqual([
      { id: "a", before: { category: "fruit" }, after: { category: "cans" } },
    ]);
  });
});
