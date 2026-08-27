/**
 * Name normalization — the foundation of search and the create-time duplicate
 * guard (PLAN.md §1.4). Pure functions only.
 */

/**
 * Fold for matching: lowercase, Unicode-NFD with combining marks stripped
 * (jalapeño ≈ jalapeno), punctuation replaced by spaces, whitespace collapsed
 * and trimmed. "Tomatoes,  Canned" -> "tomatoes canned".
 */
export function fold(s: string): string {
  return s
    .toLowerCase()
    // NFD splits "ñ" into "n" + combining tilde; dropping the marks (\p{M})
    // is what makes jalapeño and jalapeno the same word.
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    // Anything that isn't a letter or digit is a token break, not content —
    // this is how "Tomatoes, canned" and "canned tomatoes" end up comparable.
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Folded tokens with naive singularization ("ies" -> "y", drop "-es" after
 * sibilants and "o", else drop a trailing "s"). "Canned Tomatoes" ->
 * ["canned","tomato"]. Deliberately naive — at ~300 items this catches
 * bags/bag, tomatoes/tomato, berries/berry without a real inflection table.
 */
export function tokens(s: string): string[] {
  const folded = fold(s);
  if (folded === "") return [];
  return folded.split(" ").map(singularize);
}

/**
 * Naive singular form, tried in three tiers so the singular a user actually
 * types collides with the plural already stored (and vice versa):
 * 1. "ies" -> "y" (berries -> berry); length > 4 keeps "pies" out of this tier.
 * 2. Drop "es" after a sibilant-ish ending or "o" (boxes -> box,
 *    peaches -> peach, tomatoes -> tomato); length > 3 guards tiny words.
 * 3. Drop a bare trailing "s"; the length > 3 guard keeps short words like
 *    "gas" intact and the "ss" guard keeps "swiss"/"glass" intact.
 */
function singularize(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && /([sxz]|[cs]h|o)es$/.test(token)) return token.slice(0, -2);
  return token.length > 3 && token.endsWith("s") && !token.endsWith("ss")
    ? token.slice(0, -1)
    : token;
}

/**
 * Canonical duplicate key: sorted, deduped tokens joined by a space, so
 * "Canned tomatoes" and "Tomatoes, canned" collide. Never persisted (computed
 * at runtime only).
 */
export function normalKey(s: string): string {
  return [...new Set(tokens(s))].sort().join(" ");
}
