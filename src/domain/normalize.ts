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
  throw new Error("TODO: implement (workflow)");
}

/**
 * Folded tokens with naive singularization: a token longer than 3 chars ending
 * in "s" (but not "ss") drops the final "s". "Canned Tomatoes" -> ["canned","tomatoe"].
 * Deliberately naive — at ~300 items this catches bags/bag, tomatoes/tomatoe.
 */
export function tokens(s: string): string[] {
  throw new Error("TODO: implement (workflow)");
}

/**
 * Canonical duplicate key: sorted, deduped tokens joined by a space, so
 * "Canned tomatoes" and "Tomatoes, canned" collide. Never persisted (computed
 * at runtime only).
 */
export function normalKey(s: string): string {
  throw new Error("TODO: implement (workflow)");
}
