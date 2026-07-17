// Quote-reply pending state: the block the user clicked "Reply" on, waiting in
// the composer as a cancellable chip until the next send consumes it. A module
// store (useSyncExternalStore) KEYED BY CHAT — the trigger lives deep in the
// assistant message tree while the composer belongs to the (chat-reused)
// runtime, and keying by chatId makes cross-chat leakage structurally
// impossible (the composer only ever reads ITS chat's entry; a quote set in
// chat A never renders — or sends — in chat B).

import { useSyncExternalStore } from "react";

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

const byChat = new Map<string, PendingQuote>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function setPendingQuote(chatId: string, quote: PendingQuote): void {
  byChat.set(chatId, quote);
  emit();
}

export function clearPendingQuote(chatId: string): void {
  if (byChat.delete(chatId)) emit();
}

/** Read AND clear — the send path consumes the quote exactly once. */
export function takePendingQuote(chatId: string): PendingQuote | null {
  const quote = byChat.get(chatId) ?? null;
  if (quote !== null) {
    byChat.delete(chatId);
    emit();
  }
  return quote;
}

export function peekPendingQuote(chatId: string): PendingQuote | null {
  return byChat.get(chatId) ?? null;
}

/** Reactive read for the composer chip (null chatId = no chat mounted). */
export function usePendingQuote(chatId: string | null): PendingQuote | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => (chatId === null ? null : (byChat.get(chatId) ?? null)),
  );
}
