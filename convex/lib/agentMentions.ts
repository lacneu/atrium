// Addressing AGENTS by "@Name" in a multi-agent conversation.
//
// In a room of several agents, the agents a message is for are the agents it
// mentions; each answers in turn, in the order of the mentions in the text, and
// a message that mentions none goes to the primary. An agent mention is a span
// of the text plus the agent it names — stored for the same reason a person's
// is (lib/mentions.ts): two agents may share a name, one name may contain
// another, and a rename must not change who a past message was for.
//
// ROUTING ONLY. An agent mention never reaches the gateway as a human mention
// (OpenClaw refuses those from the bridge, and an agent is not a person it could
// notify); what reaches it is the plain text, and the routing is Atrium's.

import {
  reanchorMentionSpans,
  rejectMentionSpans,
  type MentionRejection,
  type MentionSpan,
} from "./mentions";

/** How many agents one message may chain — the room's own bound
 *  (chatAgents.MAX_CHAT_AGENTS), restated here so this module stays pure. */
export const MAX_ADDRESSED_AGENTS = 8;

export interface AgentRef {
  instanceName: string;
  agentId: string;
}

export interface AgentMentionSpan extends AgentRef, MentionSpan {}

export type AgentMentionRejection =
  | MentionRejection
  | "too_many_agents"
  | "duplicate_agent";

const sameAgent = (a: AgentRef, b: AgentRef) =>
  a.instanceName === b.instanceName && a.agentId === b.agentId;

/**
 * Validate a message's agent mentions TOGETHER with its people mentions: the span
 * rules are the people's (lib/mentions.rejectMentionSpans), applied to the UNION —
 * one text, one set of disjoint, ordered spans, whoever they name. Then the
 * agent-only rules: at most MAX_ADDRESSED_AGENTS, each agent once (a second token
 * for the same agent would have it answer twice).
 *
 * The agent spans must be given in TEXT ORDER: that order IS the order of the
 * replies, so a list the server would have to reorder is refused rather than
 * silently re-sequenced.
 */
export function rejectAgentMentions(
  text: string,
  agents: readonly AgentMentionSpan[],
  people: readonly MentionSpan[] = [],
): AgentMentionRejection | null {
  if (agents.length > MAX_ADDRESSED_AGENTS) return "too_many_agents";
  for (let i = 1; i < agents.length; i += 1) {
    if (agents[i]!.start < agents[i - 1]!.end) return "overlapping";
  }
  for (let i = 0; i < agents.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      if (sameAgent(agents[i]!, agents[j]!)) return "duplicate_agent";
    }
  }
  const union = [...people, ...agents].sort((a, b) => a.start - b.start);
  return rejectMentionSpans(text, union);
}

/** The agents a message addresses, in the order they answer (the text's). */
export function addressedChain(agents: readonly AgentMentionSpan[]): AgentRef[] {
  return agents.map((a) => ({ instanceName: a.instanceName, agentId: a.agentId }));
}

/**
 * The agent mentions of a queued message whose text was REWRITTEN, found again
 * (lib/mentions.reanchorMentionSpans, on the union with the people's so no two
 * claim the same characters). Null when the rewrite changed WHO the message is
 * for or in which order: the chain was built from the mentions at send time, and
 * a message must not end up answered by agents its text no longer names.
 */
export function reanchorAddressedAgents<P extends MentionSpan>(
  before: string,
  after: string,
  agents: readonly AgentMentionSpan[],
  people: readonly P[],
): { agents: AgentMentionSpan[]; people: P[]; droppedPeople: P[] } | null {
  type Tagged =
    | (MentionSpan & { kind: "agent"; agent: AgentMentionSpan })
    | (MentionSpan & { kind: "person"; person: P });
  const tagged: Tagged[] = [
    ...people.map((p) => ({ kind: "person" as const, person: p, start: p.start, end: p.end })),
    ...agents.map((a) => ({ kind: "agent" as const, agent: a, start: a.start, end: a.end })),
  ].sort((a, b) => a.start - b.start);
  // Each token re-found by the composer's rule (lib/mentions.reanchorMentionSpans).
  const { kept, dropped } = reanchorMentionSpans(before, after, tagged);
  const keptAgents = kept.filter((k) => k.kind === "agent");
  if (keptAgents.length !== agents.length) return null;
  const reordered = keptAgents.map((k) => (k as { agent: AgentMentionSpan }).agent);
  for (let i = 0; i < agents.length; i += 1) {
    if (!sameAgent(reordered[i]!, agents[i]!)) return null;
  }
  return {
    agents: keptAgents.map((k) => ({
      ...(k as { agent: AgentMentionSpan }).agent,
      start: k.start,
      end: k.end,
    })),
    people: kept
      .filter((k) => k.kind === "person")
      .map((k) => ({ ...(k as { person: P }).person, start: k.start, end: k.end })),
    droppedPeople: dropped
      .filter((k) => k.kind === "person")
      .map((k) => (k as { person: P }).person),
  };
}

/** The idempotency key of a chained row: DERIVED from the send's own key, so the
 *  browser's key keeps naming the logical send (the head). */
export function chainClientMessageId(key: string, index: number): string {
  return `${key}${CHAIN_KEY_MARK}${index}`;
}
const CHAIN_KEY_MARK = ":chain:";

/** Keys a client may not choose: every key Atrium derives or mints for its own
 *  outbox rows of a user's conversation (`regen-…`, `autoretry-…`, and a chained
 *  row's `<key>:chain:<n>`). Browsers send UUIDs; nothing a client legitimately
 *  sends looks like these. */
export function isReservedClientMessageId(key: string): boolean {
  return key.includes(CHAIN_KEY_MARK) || /^(regen|autoretry)-/.test(key);
}
