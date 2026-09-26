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

import { findWholeToken } from "../../convex/lib/mentions";

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
 * Stage one person — one entry per (chat, user), because naming somebody twice in
 * one message still names them once. Staging the same person with a DIFFERENT
 * token (renamed meanwhile) replaces the old one: the token in the text is the
 * one that must be found at send time.
 */
export function stagePendingMention(chatId: string, mention: PendingMention): void {
  const list = byChat.get(chatId) ?? [];
  const at = list.findIndex((m) => m.userId === mention.userId);
  if (at !== -1 && list[at]!.token === mention.token) return;
  byChat.set(
    chatId,
    at === -1 ? [...list, mention] : list.map((m, i) => (i === at ? mention : m)),
  );
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
  // Occupied ranges, so two people whose tokens overlap cannot both claim the
  // same characters; and only WHOLE tokens count (findWholeToken) — "@Ali" picked
  // then typed on into "@Alice" no longer names Ali.
  const taken: Array<{ start: number; end: number }> = [];
  for (const mention of staged) {
    const at = findWholeToken(text, mention.token, taken);
    if (at === null) continue;
    found.push({ userId: mention.userId, start: at.start, end: at.end });
    taken.push(at);
  }
  return found.sort((a, b) => a.start - b.start);
}

/**
 * What a send carries for the people staged in this chat: consumes them (exactly
 * once) and resolves their spans against the text as sent. BOTH send paths — a
 * new turn and a follow-up queued behind a live one — go through here, so neither
 * can send a staged name as plain text or leave it staged for a later message
 * that happens to contain the same token. `staged` is what to give back with
 * `restorePendingMentions` if the send fails.
 */
export function takeMentionsForSend(
  chatId: string,
  text: string,
): { staged: readonly PendingMention[]; mentions: ResolvedMention[] } {
  const staged = takePendingMentions(chatId);
  return { staged, mentions: resolveMentionSpans(text, staged) };
}

/**
 * Name somebody in the message being written: stages them and returns the composer
 * text with their token appended — or null when they are ALREADY named in it (one
 * mention per person per message; a second "@Name" would name nobody). A pick
 * whose earlier token the writer has since deleted inserts it again.
 *
 * TOKENS ARE UNIQUE PER MESSAGE. Two people may share a display name, and a token
 * both could claim would be attributed by the order they were picked, not by who
 * the writer meant — delete the first "@Alex" and the second would name the wrong
 * Alex. So a token another staged person already holds gets a suffix ("@Alex-2"),
 * which whole-token matching never confuses with "@Alex".
 */
export function nameInComposer(
  chatId: string,
  text: string,
  userId: string,
  baseToken: string,
): string | null {
  const staged = peekPendingMentions(chatId);
  const mine = staged.find((m) => m.userId === userId);
  if (mine !== undefined && findWholeToken(text, mine.token) !== null) return null;
  const heldByOthers = new Set(staged.filter((m) => m.userId !== userId).map((m) => m.token));
  let token = baseToken;
  for (let n = 2; heldByOthers.has(token); n += 1) token = `${baseToken}-${n}`;
  stagePendingMention(chatId, { userId, token });
  const separator = text.length === 0 || text.endsWith(" ") ? "" : " ";
  return `${text}${separator}${token} `;
}
