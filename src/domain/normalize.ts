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
 * Folded tokens with naive singularization: a token longer than 3 chars ending
 * in "s" (but not "ss") drops the final "s". "Canned Tomatoes" -> ["canned","tomatoe"].
 * Deliberately naive — at ~300 items this catches bags/bag, tomatoes/tomatoe.
 */
export function tokens(s: string): string[] {
  const folded = fold(s);
  if (folded === "") return [];
  return folded.split(" ").map(singularize);
}

/**
 * Drop a trailing "s" from plural-looking tokens. The length > 3 guard keeps
 * short words like "gas" intact; the "ss" guard keeps "swiss"/"glass" intact.
 */
function singularize(token: string): string {
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
