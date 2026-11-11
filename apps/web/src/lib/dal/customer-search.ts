// PostgREST filter for the customers search (pure, unit-tested). The search
// term is user input: it must never change the shape of the filter, only the
// value matched. Each value is double-quoted (so commas, dots, colons and
// parentheses stay literal inside `or=(...)`), LIKE wildcards in the term are
// escaped, and `*` (PostgREST's wildcard) is dropped.

/** Escapes `%`, `_` and the escape character itself for a LIKE pattern. */
export function escapeLikePattern(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** Escapes a value for a double-quoted PostgREST filter value. */
function quoteFilterValue(value: string): string {
  return `"${value.replace(/[\\"]/g, (char) => `\\${char}`)}"`;
}

/** A "contains" LIKE pattern for `term` in PostgREST syntax, for a simple filter such as `.ilike(column, ...)`. */
export function likeContains(term: string): string {
  return `*${escapeLikePattern(term.replace(/\*/g, ""))}*`;
}

/** The same pattern double-quoted, for a value inside an `or=(...)` filter. */
export function containsPattern(term: string): string {
  return quoteFilterValue(likeContains(term));
}

/**
 * The `or` filter matching `term` in any of `columns`, or null when the term
 * is empty (after dropping `*`). Column names come from code, never from input.
 */
export function customerSearchFilter(term: string, columns: readonly string[]): string | null {
  if (term.replace(/\*/g, "").trim() === "") return null;
  const pattern = containsPattern(term);
  return columns.map((column) => `${column}.ilike.${pattern}`).join(",");
}
