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
//
// AGENTS TOO. In a room of several agents, picking an agent names it the same way
// (`nameAgentInComposer`): its token is staged beside the people's, located at send
// time by the same rule, and sent as an ADDRESS — the agents a message is for, in
// the order their tokens appear (convex/send.ts chains one reply per agent). Tokens
// are unique per message across people AND agents, so no token names two things.

import { findWholeToken } from "../../convex/lib/mentions";

/** A person staged to be named. */
export interface PendingPersonMention {
  /** Atrium user id of the person named. */
  userId: string;
  /** The literal token inserted in the composer, "@" included. */
  token: string;
}

/** An agent staged to be addressed. */
export interface PendingAgentMention {
  agent: { instanceName: string; agentId: string };
  /** The literal token inserted in the composer, "@" included. */
  token: string;
}

export type PendingMention = PendingPersonMention | PendingAgentMention;

export interface ResolvedMention {
  userId: string;
  start: number;
  end: number;
}

export interface ResolvedAgentMention {
  instanceName: string;
  agentId: string;
  start: number;
  end: number;
}

const isAgentMention = (m: PendingMention): m is PendingAgentMention => "agent" in m;

/** WHAT a staged mention names — a person or an agent — as one comparable key. */
function mentionKey(m: PendingMention): string {
  return isAgentMention(m)
    ? `agent\u0000${m.agent.instanceName}\u0000${m.agent.agentId}`
    : `user\u0000${m.userId}`;
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
  const at = list.findIndex((m) => mentionKey(m) === mentionKey(mention));
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
  const seen = new Set(current.map(mentionKey));
  const merged = [...current];
  for (const m of mentions) {
    if (!seen.has(mentionKey(m))) merged.push(m);
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
  return resolveAllMentionSpans(text, staged).people;
}

/**
 * Both kinds at once, located TOGETHER: one set of occupied ranges, so a person's
 * token and an agent's can never claim the same characters (the server validates
 * the union — convex/lib/agentMentions.ts). Each list in TEXT order; for the agents
 * that order is the order they answer in.
 */
export function resolveAllMentionSpans(
  text: string,
  staged: readonly PendingMention[],
): { people: ResolvedMention[]; agents: ResolvedAgentMention[] } {
  const people: ResolvedMention[] = [];
  const agents: ResolvedAgentMention[] = [];
  // Occupied ranges, so two people whose tokens overlap cannot both claim the
  // same characters; and only WHOLE tokens count (findWholeToken) — "@Ali" picked
  // then typed on into "@Alice" no longer names Ali.
  const taken: Array<{ start: number; end: number }> = [];
  for (const mention of staged) {
    const at = findWholeToken(text, mention.token, taken);
    if (at === null) continue;
    if (isAgentMention(mention)) {
      agents.push({ ...mention.agent, start: at.start, end: at.end });
    } else {
      people.push({ userId: mention.userId, start: at.start, end: at.end });
    }
    taken.push(at);
  }
  return {
    people: people.sort((a, b) => a.start - b.start),
    agents: agents.sort((a, b) => a.start - b.start),
  };
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
): {
  staged: readonly PendingMention[];
  mentions: ResolvedMention[];
  /** The agents the message is addressed to, in the order they answer. */
  agentMentions: ResolvedAgentMention[];
} {
  const staged = takePendingMentions(chatId);
  const { people, agents } = resolveAllMentionSpans(text, staged);
  return { staged, mentions: people, agentMentions: agents };
}

/** The agents staged in a chat, in the order they were picked — what the composer
 *  can know of the next message's addressees before the text is final. */
export function stagedAgents(
  staged: readonly PendingMention[],
): Array<{ instanceName: string; agentId: string }> {
  return staged.filter(isAgentMention).map((m) => ({ ...m.agent }));
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
  return stageTokenInComposer(chatId, text, { userId, token: baseToken });
}

/**
 * ADDRESS an agent in the message being written — the agent row of the room
 * popover. The same gesture as naming a person, and the same rules: one token per
 * agent per message (picking it again adds nothing while its token is still there),
 * a suffix for a token already held by someone or something else ("@Nova-2").
 */
export function nameAgentInComposer(
  chatId: string,
  text: string,
  agent: { instanceName: string; agentId: string },
  baseToken: string,
): string | null {
  return stageTokenInComposer(chatId, text, {
    agent: { instanceName: agent.instanceName, agentId: agent.agentId },
    token: baseToken,
  });
}

function stageTokenInComposer(
  chatId: string,
  text: string,
  picked: PendingMention,
): string | null {
  const key = mentionKey(picked);
  const baseToken = picked.token;
  const staged = peekPendingMentions(chatId);
  const mine = staged.find((m) => mentionKey(m) === key);
  if (mine !== undefined && findWholeToken(text, mine.token) !== null) return null;
  const heldByOthers = new Set(staged.filter((m) => mentionKey(m) !== key).map((m) => m.token));
  let token = baseToken;
  for (let n = 2; heldByOthers.has(token); n += 1) token = `${baseToken}-${n}`;
  stagePendingMention(chatId, { ...picked, token });
  const separator = text.length === 0 || text.endsWith(" ") ? "" : " ";
  return `${text}${separator}${token} `;
}
