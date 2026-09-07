// People staged to be named in the message being written, per chat.
//
// Mirrors `pendingQuote`: a per-chat store the composer fills and the send path
// consumes exactly once. Keeping the two separate stores rather than one bag of
// "composer extras" is deliberate — a quote and a mention are consumed at
// different moments and restored on different failures.
//
// WHAT IS STAGED IS THE TOKEN, NOT A SPAN. The offsets a mention needs must match
// the text as SENT, and the person keeps typing after they pick somebody: an
// offset captured at pick time drifts on the very next keystroke. So the pick
// records `@Name`, and `resolveMentionSpans` locates it in the final text at send
// time. Delete the "@Name" from the box and the mention goes with it, which is
// exactly what deleting it means.

export interface PendingMention {
  /** Atrium user id of the person named. */
  userId: string;
  /** The literal token inserted in the composer, "@" included. */
  token: string;
}

export interface ResolvedMention {
  userId: string;
  start: number;
  end: number;
}

const EMPTY: readonly PendingMention[] = [];
const byChat = new Map<string, PendingMention[]>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** Subscribe to staged-mention changes (composer chips re-render on this). */
export function subscribePendingMentions(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function peekPendingMentions(chatId: string): readonly PendingMention[] {
  return byChat.get(chatId) ?? EMPTY;
}

/**
 * Stage one person. Idempotent per (chat, user): picking the same person twice
 * inserts the token twice in the text, and the resolver below then finds two
 * occurrences — but the STAGED list stays one entry per person, because naming
 * somebody twice in one message still names them once.
 */
export function stagePendingMention(chatId: string, mention: PendingMention): void {
  const list = byChat.get(chatId) ?? [];
  if (list.some((m) => m.userId === mention.userId)) return;
  byChat.set(chatId, [...list, mention]);
  emit();
}

export function clearPendingMentions(chatId: string): void {
  if (byChat.delete(chatId)) emit();
}

/** Read AND clear — the send path consumes the staged people exactly once. */
export function takePendingMentions(chatId: string): readonly PendingMention[] {
  const list = byChat.get(chatId) ?? EMPTY;
  if (list.length > 0) {
    byChat.delete(chatId);
    emit();
  }
  return list;
}

/** Put a consumed list BACK after a failed send, so a retry still names people. */
export function restorePendingMentions(
  chatId: string,
  mentions: readonly PendingMention[],
): void {
  if (mentions.length === 0) return;
  const current = byChat.get(chatId) ?? [];
  const seen = new Set(current.map((m) => m.userId));
  const merged = [...current];
  for (const m of mentions) {
    if (!seen.has(m.userId)) merged.push(m);
  }
  byChat.set(chatId, merged);
  emit();
}

/**
 * Locate each staged token in the text as it is about to be sent.
 *
 * Returns spans in TEXT ORDER and never overlapping — the two properties the
 * gateway's normalizer walks the list expecting, and whose absence makes it
 * refuse the whole send rather than the mention. A token that is no longer in the
 * text is dropped: the person deleted it.
 *
 * Offsets are UTF-16 code units, which is what `indexOf` returns and what both
 * Atrium's validator and the gateway count in.
 */
export function resolveMentionSpans(
  text: string,
  staged: readonly PendingMention[],
): ResolvedMention[] {
  const found: ResolvedMention[] = [];
  // Occupied ranges, so two people whose tokens overlap textually ("@ali" inside
  // "@alice") cannot both claim the same characters.
  const taken: Array<{ start: number; end: number }> = [];
  for (const mention of staged) {
    let from = 0;
    for (;;) {
      const start = text.indexOf(mention.token, from);
      if (start === -1) break;
      const end = start + mention.token.length;
      if (!taken.some((t) => start < t.end && end > t.start)) {
        found.push({ userId: mention.userId, start, end });
        taken.push({ start, end });
        break;
      }
      from = start + 1;
    }
  }
  return found.sort((a, b) => a.start - b.start);
}
