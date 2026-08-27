import { describe, expect, it } from "vitest";
import { fold, normalKey, tokens } from "./normalize";

describe("fold", () => {
  const cases: [input: string, expected: string][] = [
    // Case folding
    ["Paprika", "paprika"],
    ["OLIVE OIL", "olive oil"],
    // Diacritic folding (NFD + strip combining marks)
    ["jalapeño", "jalapeno"],
    ["Jalapeño", "jalapeno"],
    ["CRÈME FRAÎCHE", "creme fraiche"],
    ["café au lait", "cafe au lait"],
    // Punctuation becomes a token break
    ["Tomatoes,  Canned", "tomatoes canned"],
    ["half-and-half", "half and half"],
    ["Señor's \"Best\" Salsa", "senor s best salsa"],
    ["100% Juice", "100 juice"],
    ["mac_and_cheese", "mac and cheese"],
    // Whitespace collapse + trim
    ["  Olive   Oil  ", "olive oil"],
    ["\tsea\n salt ", "sea salt"],
    // Degenerate inputs
    ["", ""],
    ["   ", ""],
    ["!!!,,,---", ""],
  ];

  it.each(cases)("fold(%j) -> %j", (input, expected) => {
    expect(fold(input)).toBe(expected);
  });
});

describe("tokens", () => {
  const cases: [input: string, expected: string[]][] = [
    // "ies" tier: > 4 chars ending in "ies" -> "y"
    ["berries", ["berry"]],
    ["Cherries", ["cherry"]],
    // ...while 4-char "ies" words skip that tier and drop just the "s"
    ["pies", ["pie"]],
    ["ties", ["tie"]],
    // "es" tier: drop "es" after a sibilant-ish ending or "o"
    ["Canned Tomatoes", ["canned", "tomato"]],
    ["boxes", ["box"]],
    ["peaches", ["peach"]],
    ["dishes", ["dish"]],
    ["glasses", ["glass"]],
    // "molasses" ends in "ses" — the naive es-tier clips it to "molass".
    ["molasses", ["molass"]],
    // Bare-s tier: > 3 chars, trailing "s", not "ss"
    ["bags", ["bag"]],
    ["peas", ["pea"]],
    ["Chips", ["chip"]],
    // "grapes" misses the es-tier ("p" before the "es") and drops just the "s"
    ["grapes", ["grape"]],
    // "ss" endings are never singularized
    ["swiss", ["swiss"]],
    ["glass", ["glass"]],
    // Length guard: 3 chars or fewer keep their "s"
    ["gas", ["gas"]],
    ["peS", ["pes"]],
    ["s", ["s"]],
    // Folding happens before tokenizing
    ["Jalapeños", ["jalapeno"]],
    ["Tomatoes, canned", ["tomato", "canned"]],
    // Degenerate inputs
    ["", []],
    ["  ,, -- ", []],
  ];

  it.each(cases)("tokens(%j) -> %j", (input, expected) => {
    expect(tokens(input)).toEqual(expected);
  });
});

describe("normalKey", () => {
  it("collides word reorderings: 'Canned tomatoes' vs 'Tomatoes, canned'", () => {
    expect(normalKey("Canned tomatoes")).toBe(normalKey("Tomatoes, canned"));
    expect(normalKey("Canned tomatoes")).toBe("canned tomato");
  });

  it("collides diacritic and case variants", () => {
    expect(normalKey("Jalapeño Peppers")).toBe(normalKey("JALAPENO peppers"));
  });

  it("collides plural variants via the drop-trailing-s rule", () => {
    expect(normalKey("bag")).toBe(normalKey("Bags"));
  });

  // Each tier collides the plural with the ACTUAL singular a user would type,
  // in both directions — this is what stops "tomato" being created next to
  // "Tomatoes".
  it.each([
    ["tomatoes", "tomato"],
    ["boxes", "box"],
    ["berries", "berry"],
    ["peaches", "peach"],
  ])("collides %j with its true singular %j", (plural, singular) => {
    expect(normalKey(plural)).toBe(normalKey(singular));
    expect(normalKey(singular)).toBe(normalKey(plural));
  });

  const cases: [input: string, expected: string][] = [
    // Sorted
    ["zucchini apple", "apple zucchini"],
    // Deduped
    ["salt salt salt", "salt"],
    ["Bags bag", "bag"],
    // Degenerate
    ["", ""],
    ["?!", ""],
  ];

  it.each(cases)("normalKey(%j) -> %j", (input, expected) => {
    expect(normalKey(input)).toBe(expected);
  });
});
