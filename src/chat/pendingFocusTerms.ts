// Ephemeral hand-off of the GLOBAL-SEARCH terms to the thread's focus hook.
// DELIBERATELY not a URL param: search terms can be sensitive (names,
// diagnoses — PHI in this deployment context); putting them in the address bar
// would leak them into browser history / copied links / access logs (codex P1).
// The ?m message id (opaque) stays in the URL; the TERMS ride this one-shot
// module store instead — a reload simply skips the term highlight.

let pending: { messageId: string; terms: string } | null = null;

export function setPendingFocusTerms(messageId: string, terms: string): void {
  pending = { messageId, terms };
}

/** Consume (one-shot) the terms staged for this message, if any. */
export function takePendingFocusTerms(messageId: string): string | null {
  if (pending === null || pending.messageId !== messageId) return null;
  const t = pending.terms;
  pending = null;
  return t;
}
