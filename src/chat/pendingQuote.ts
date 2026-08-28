// Quote-reply pending state: the blocks the user clicked "Reply" on, waiting in
// the composer as cancellable chips until the next send consumes them. A module
// store (useSyncExternalStore) KEYED BY CHAT — the trigger lives deep in the
// assistant message tree while the composer belongs to the (chat-reused)
// runtime, and keying by chatId makes cross-chat leakage structurally
// impossible (the composer only ever reads ITS chat's entry; a quote set in
// chat A never renders — or sends — in chat B).
//
// A chat holds a LIST, in the order the user picked: a second "Reply" adds a
// passage instead of replacing the first, and each chip is removed on its own.

import { useSyncExternalStore } from "react";
// The bounds are the SERVER's, imported rather than restated: two copies of one
// number is how a composer ends up staging a selection the send then refuses.
import {
  QUOTE_MAX_PER_TURN,
  QUOTE_TOTAL_EXCERPT_CAP,
} from "../../convex/lib/quoteReply";

export { QUOTE_MAX_PER_TURN, QUOTE_TOTAL_EXCERPT_CAP };

export type PendingQuote = {
  /** The quoted assistant message. */
  messageId: string;
  /** The block within it (null = the whole message). */
  blockIndex: number | null;
  /** The display+prompt excerpt captured at click time. */
  excerpt: string;
};

/** Client-side excerpt budget: word-truncated well under the server's 500 cap
 *  so the chip stays scannable and the prompt preamble stays tight. */
export const QUOTE_EXCERPT_CLIENT_MAX = 280;

const EMPTY: readonly PendingQuote[] = [];

const byChat = new Map<string, readonly PendingQuote[]>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** What identifies a passage: the same block quoted twice is one passage. */
function keyOf(q: PendingQuote): string {
  return `${q.messageId}:${q.blockIndex ?? "all"}`;
}

/** APPEND a passage. Already-staged (same message + same block) is a no-op, so a
 *  double click cannot stage the same passage twice. Refused — with a reason for the
 *  caller to SAY WHICH — past the count bound OR past the total excerpt budget:
 *  both are the server's, checked here because this is the last moment the user
 *  can still act on the refusal. Letting the send do it instead would fail the
 *  turn AND lose the selection (the failure reads as a server rejection, which
 *  is precisely what the restage path refuses to restore). */
export type QuoteRefusal = "ok" | "too-many" | "too-long";

export function addPendingQuote(
  chatId: string,
  quote: PendingQuote,
): QuoteRefusal {
  const current = byChat.get(chatId) ?? EMPTY;
  if (current.some((q) => keyOf(q) === keyOf(quote))) return "ok";
  if (current.length >= QUOTE_MAX_PER_TURN) return "too-many";
  const budget =
    current.reduce((n, q) => n + q.excerpt.length, 0) + quote.excerpt.length;
  if (budget > QUOTE_TOTAL_EXCERPT_CAP) return "too-long";
  byChat.set(chatId, [...current, quote]);
  emit();
  return "ok";
}

/** Drop ONE staged passage (its chip's ✕). */
export function removePendingQuote(chatId: string, key: string): void {
  const current = byChat.get(chatId);
  if (current === undefined) return;
  const next = current.filter((q) => keyOf(q) !== key);
  if (next.length === current.length) return;
  if (next.length === 0) byChat.delete(chatId);
  else byChat.set(chatId, next);
  emit();
}

/** Its stable identity, for a chip's key and its ✕. */
export const pendingQuoteKey = keyOf;

export function clearPendingQuotes(chatId: string): void {
  if (byChat.delete(chatId)) emit();
}

/** Read AND clear — the send path consumes the staged passages exactly once. */
export function takePendingQuotes(chatId: string): readonly PendingQuote[] {
  const quotes = byChat.get(chatId) ?? EMPTY;
  if (quotes.length > 0) {
    byChat.delete(chatId);
    emit();
  }
  return quotes;
}

export function peekPendingQuotes(chatId: string): readonly PendingQuote[] {
  return byChat.get(chatId) ?? EMPTY;
}

/** Put a consumed list BACK after a failed send.
 *
 *  MERGES rather than replaces or refuses. The send path empties the store
 *  before the mutation, so anything it cannot give back is GONE — a selection
 *  the user deliberately assembled, lost to a failure they did not cause. An
 *  earlier version refused whenever something had been staged during the
 *  round-trip, which traded one silent loss for another.
 *
 *  What is already staged is RESERVED — it is on screen and it is the user's
 *  most recent intent — then the consumed passages come back ahead of it, in the
 *  order they were picked, as far as the bounds allow. `restored` counts what
 *  came back and `dropped` what could not; nothing is ever removed quietly.
 *  The invariant lives here, where the state does, rather than in each caller. */
export function restorePendingQuotes(
  chatId: string,
  quotes: readonly PendingQuote[],
): { restored: number; dropped: number } {
  if (quotes.length === 0) return { restored: 0, dropped: 0 };
  // WHAT IS ON SCREEN IS RESERVED FIRST. Staged during the round trip, it is the
  // user's most recent intent and they can see it; evicting it to make room for
  // a passage they cannot see would be the same silent loss one level down —
  // and the report would say a quote "could not be put back" while the one that
  // actually vanished was the new one.
  const current = byChat.get(chatId) ?? EMPTY;
  const seen = new Set<string>();
  let budget = 0;
  for (const q of current) {
    seen.add(keyOf(q));
    budget += q.excerpt.length;
  }
  // Then as many consumed passages as still fit, in the order they were picked.
  const returning: PendingQuote[] = [];
  let dropped = 0;
  for (const q of quotes) {
    if (seen.has(keyOf(q))) continue;
    if (
      current.length + returning.length >= QUOTE_MAX_PER_TURN ||
      budget + q.excerpt.length > QUOTE_TOTAL_EXCERPT_CAP
    ) {
      dropped += 1;
      continue;
    }
    seen.add(keyOf(q));
    budget += q.excerpt.length;
    returning.push(q);
  }
  // Displayed in picking order: what came back first, then what was added while
  // the send was in flight.
  const merged = [...returning, ...current];
  if (merged.length === 0) byChat.delete(chatId);
  else byChat.set(chatId, merged);
  emit();
  return { restored: returning.length, dropped };
}

/** Drop the passages whose anchors the server just named as gone, and give the
 *  rest back. Returns how many were dropped, for the caller to SAY so. */
export function restorePendingQuotesExcept(
  chatId: string,
  quotes: readonly PendingQuote[],
  goneMessageIds: ReadonlySet<string>,
): { restored: number; gone: number; dropped: number } {
  const kept = quotes.filter((q) => !goneMessageIds.has(q.messageId));
  const { restored, dropped } = restorePendingQuotes(chatId, kept);
  return { restored, gone: quotes.length - kept.length, dropped };
}

/** Reactive read for the composer chips (null chatId = no chat mounted). The
 *  empty case returns the SAME frozen array every time — a fresh `[]` per call
 *  would make useSyncExternalStore see a new snapshot on every render. */
export function usePendingQuotes(chatId: string | null): readonly PendingQuote[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => (chatId === null ? EMPTY : (byChat.get(chatId) ?? EMPTY)),
  );
}
