// Pure helpers for the global conversation search (no ctx, no DB) so the
// ranking / snippet / title-match logic is unit-testable independently of the
// Convex search-index harness fidelity. The owner-scoping access boundary lives
// in the query (`search.searchConversations`), NOT here.

export type SearchMatchedIn = "title" | "message";

export type SearchHit = {
  chatId: string;
  title: string | null;
  snippet: string;
  matchedIn: SearchMatchedIn;
  role?: "user" | "assistant" | "system";
  at: number;
};

// Snippet geometry: chars of context kept on each side of the first match, and
// the hard cap used when no term is located (relevance-only hit).
const SNIPPET_RADIUS = 90;
const SNIPPET_MAX = 180;

/** Lowercased, whitespace-split query terms (empties dropped). */
export function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/**
 * A short, single-line snippet centered on the FIRST occurrence of any query
 * term (case-insensitive). Falls back to a leading slice when the index matched
 * on relevance but no literal term is present (stemming/typo tolerance). Adds
 * ellipses at any truncated edge.
 */
export function buildSnippet(text: string, terms: string[]): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return "";
  const lower = flat.toLowerCase();

  let idx = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i !== -1 && (idx === -1 || i < idx)) idx = i;
  }

  if (idx === -1) {
    return flat.length > SNIPPET_MAX
      ? flat.slice(0, SNIPPET_MAX).trimEnd() + "…"
      : flat;
  }

  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(flat.length, idx + SNIPPET_RADIUS);
  let snip = flat.slice(start, end).trim();
  if (start > 0) snip = "…" + snip;
  if (end < flat.length) snip = snip + "…";
  return snip;
}

/**
 * A chat title matches when it contains EVERY query term (case-insensitive AND).
 * Precise for multi-word queries; equivalent to "contains" for a single term.
 * Empty/undefined titles never match.
 */
export function titleMatches(
  title: string | undefined | null,
  terms: string[],
): boolean {
  if (!title || terms.length === 0) return false;
  const lower = title.toLowerCase();
  return terms.every((t) => lower.includes(t));
}
