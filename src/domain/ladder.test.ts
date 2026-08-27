import { describe, expect, it } from "vitest";
import { readRung, rungNeedsConfirm, rungValue } from "./ladder";
import type { LadderRung } from "../types";

describe("readRung", () => {
  const cases: Array<[number, LadderRung]> = [
    // full: >= 0.75, including everything above one container
    [3, "full"],
    [1.5, "full"],
    [1, "full"],
    [0.76, "full"],
    [0.75, "full"], // boundary is inclusive
    // half: >= 0.35
    [0.7499, "half"],
    [0.5, "half"],
    [0.35, "half"], // boundary is inclusive
    // low: > 0
    [0.3499, "low"],
    [0.2, "low"],
    [0.001, "low"],
    [Number.EPSILON, "low"], // epsilon above zero is still "low", not "out"
    // out: exactly 0
    [0, "out"],
  ];
  it.each(cases)("readRung(%f) -> %s", (qty, rung) => {
    expect(readRung(qty)).toBe(rung);
  });
});

describe("rungValue", () => {
  const cases: Array<[LadderRung, number]> = [
    ["full", 1],
    ["half", 0.5],
    ["low", 0.2],
    ["out", 0],
  ];
  it.each(cases)("rungValue(%s) -> %f", (rung, value) => {
    expect(rungValue(rung)).toBe(value);
  });

  it("round-trips: every rung's write value reads back as the same rung (except out)", () => {
    expect(readRung(rungValue("full"))).toBe("full");
    expect(readRung(rungValue("half"))).toBe("half");
    expect(readRung(rungValue("low"))).toBe("low");
    expect(readRung(rungValue("out"))).toBe("out");
  });
});

describe("rungNeedsConfirm", () => {
  const cases: Array<[number, boolean]> = [
    [0, false],
    [0.5, false],
    [1, false], // exactly one container: rung values are same-scale, no confirm
    [1.001, true], // strictly above 1: multi-container guard kicks in
    [1.5, true],
    [3, true],
  ];
  it.each(cases)("rungNeedsConfirm(%f) -> %s", (qty, confirm) => {
    expect(rungNeedsConfirm(qty)).toBe(confirm);
  });
});
