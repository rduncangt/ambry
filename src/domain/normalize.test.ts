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
    // Naive singularization: > 3 chars, trailing "s", not "ss"
    ["Canned Tomatoes", ["canned", "tomatoe"]],
    ["bags", ["bag"]],
    ["peas", ["pea"]],
    ["Chips", ["chip"]],
    // "ss" endings are never singularized
    ["swiss", ["swiss"]],
    ["glass", ["glass"]],
    // "molasses" ends in "es", not "ss" — the naive rule singularizes it.
    ["molasses", ["molasse"]],
    // Length guard: 3 chars or fewer keep their "s"
    ["gas", ["gas"]],
    ["peS", ["pes"]],
    ["s", ["s"]],
    // Folding happens before tokenizing
    ["Jalapeños", ["jalapeno"]],
    ["Tomatoes, canned", ["tomatoe", "canned"]],
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
    expect(normalKey("Canned tomatoes")).toBe("canned tomatoe");
  });

  it("collides diacritic and case variants", () => {
    expect(normalKey("Jalapeño Peppers")).toBe(normalKey("JALAPENO peppers"));
  });

  it("collides plural variants via the drop-trailing-s rule", () => {
    expect(normalKey("bag")).toBe(normalKey("Bags"));
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
