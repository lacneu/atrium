// Every refused block action is SAID (lot 24): a quote or a bookmark asked on one block
// of a reply — from the gutter, or from a list of the reply's ⋯ — and not done. Each
// surface says it where the person acted, through a status region that is on the page
// before it speaks and announces every refusal anew (liveStatus): the list in its
// dialog, the gutter beside its row. This module holds what each refusal says, and the
// bookmark toggle's outcome, which a fire-and-forget call used to drop.
import { m } from "@/paraglide/messages.js";
import { QUOTE_MAX_PER_TURN, type QuoteRefusal } from "./pendingQuote";

/** What a refused quote says, or null when the passage is staged (or already was:
 *  the same block quoted twice is one passage, already in the composer). */
export function quoteRefusalText(refusal: QuoteRefusal): string | null {
  switch (refusal) {
    case "ok":
      return null;
    case "too-many":
      return m.quote_reply_max_reached({ count: QUOTE_MAX_PER_TURN });
    case "too-long":
      return m.quote_reply_budget_reached();
  }
}

/** How a bookmark toggle ended: done — placed, or removed —, or refused: while an
 *  admin views another person's account (the server leaves that person's bookmarks
 *  untouched, and says nothing), or by the server (its bound on a conversation's
 *  bookmarks, a message no longer in it). */
export type BookmarkToggleOutcome =
  | { done: true; placed: boolean }
  | { done: false; reason: "impersonating" | "server" };

/** Runs a bookmark toggle and returns how it ended — never a rejection left unseen. */
export async function bookmarkToggleOutcome(
  impersonating: boolean,
  toggle: () => Promise<{ placed: boolean } | null | undefined>,
): Promise<BookmarkToggleOutcome> {
  if (impersonating) return { done: false, reason: "impersonating" };
  try {
    const result = await toggle();
    return { done: true, placed: result?.placed === true };
  } catch {
    return { done: false, reason: "server" };
  }
}

/** What a refused bookmark says, or null when the toggle was done. */
export function bookmarkRefusalText(outcome: BookmarkToggleOutcome): string | null {
  if (outcome.done) return null;
  return outcome.reason === "impersonating"
    ? m.bookmark_refused_impersonating()
    : m.bookmark_refused_server();
}
