// Pure helpers for the per-turn agent router (multi-agent chats). NO React and
// NO Convex imports, so they unit-test without a DOM or a backend (the frontend
// has no DOM test runner — see the AgentPicker helpers next door).
//
// A single visible conversation can route different turns to different agents.
// These helpers answer the three questions the UI has to make pure + testable:
//   - resolveMessageAgents:     which agent answered each message (attribution).
//   - lastRoutedAgent:          the composer's "last-used agent" default.
//   - resolveRoutedAgentToSend: the SINGLE-AGENT-PATH rule (what to send, if any).

/** A reference to one agent (the {instance, id} pair the server authorizes). */
export interface AgentRef {
  instanceName: string;
  agentId: string;
}

/** Display fields for an agent ref (a subset of AgentPicker's PickableAgent). */
export interface AgentDisplay {
  displayName: string | null;
  emoji: string | null;
}

/** Structural equality of two agent references (instance + id). Null-safe. */
export function agentRefEquals(a: AgentRef | null, b: AgentRef | null): boolean {
  if (a === null || b === null) return a === b;
  return a.instanceName === b.instanceName && a.agentId === b.agentId;
}

// Minimal message shape the resolvers read (a subset of ConvexMessageView).
export interface RoutableMessage {
  _id: string;
  role: "user" | "assistant" | "system";
  routedInstanceName?: string;
  routedAgentId?: string;
}

/** A message's OWN routed agent, or null when it carries none. */
function ownRouted(m: RoutableMessage): AgentRef | null {
  return m.routedInstanceName && m.routedAgentId
    ? { instanceName: m.routedInstanceName, agentId: m.routedAgentId }
    : null;
}

/**
 * Resolve, per message, WHICH agent it is attributed to. A user message uses its
 * own routed agent (the one the user addressed the turn to). An assistant message
 * uses its own routed agent if stamped, else INHERITS the preceding user message's
 * routed agent (the same turn). `null` => the message carries no explicit routing,
 * so the caller falls back to the chat's primary agent. Pure + order-dependent:
 * pass the messages in display order.
 */
export function resolveMessageAgents(
  messages: RoutableMessage[],
): Map<string, AgentRef | null> {
  const out = new Map<string, AgentRef | null>();
  let lastUserRouted: AgentRef | null = null;
  for (const msg of messages) {
    const own = ownRouted(msg);
    if (msg.role === "user") {
      lastUserRouted = own;
      out.set(msg._id, own);
    } else if (msg.role === "assistant") {
      out.set(msg._id, own ?? lastUserRouted);
    } else {
      out.set(msg._id, own);
    }
  }
  return out;
}

/**
 * The most-recent explicitly-routed agent in the thread (scan from the end), or
 * null when no turn was ever routed. Drives the composer's "last-used" default.
 */
export function lastRoutedAgent(messages: RoutableMessage[]): AgentRef | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const own = ownRouted(messages[i]);
    if (own) return own;
  }
  return null;
}

/**
 * Is this the chat's FIRST turn? — i.e. should the send-rule treat it as turn 1
 * (never route). CRITICAL: distinguish LOADING (`undefined`, listByChat not yet
 * responded) from a genuinely EMPTY new chat (`[]`). While loading we do NOT know
 * the history, so we must NOT report first-turn (that would suppress routing on an
 * already-perTurnRouting chat → the turn falls back to the primary). Only a LOADED,
 * user-message-free thread is the real first turn.
 */
export function isFirstTurn(messages: RoutableMessage[] | undefined): boolean {
  if (messages === undefined) return false;
  return !messages.some((m) => m.role === "user");
}

/** An agent as the default-selection resolver sees it: a ref plus the fields that
 *  decide usability (gateway state) and the sensible last-resort (user default).
 *  A subset of AgentPicker's PickableAgent, so the entitled pool passes directly. */
export interface SelectableAgent extends AgentRef {
  isDefault?: boolean;
  state?: string;
}

/** Usable as a default selection = present in the CURRENT entitled pool AND not
 *  gateway-deleted (a deleted agent would fail the dispatch). */
function isUsable(pool: SelectableAgent[], ref: AgentRef | null): boolean {
  if (!ref) return false;
  const found = pool.find((a) => agentRefEquals(a, ref));
  return found !== undefined && found.state !== "deleted";
}

/**
 * The composer's effective DEFAULT selection, resolved against the user's CURRENT
 * entitled pool. CRITICAL: a perTurnRouting chat stamps the effective selection on
 * EVERY send, so a stale last-routed agent (revoked from the user, or
 * gateway-deleted) must never remain the default — the dispatch would fail
 * `agent_restricted`/`no_agent` and the user would be stuck (especially once the
 * selector hides after grants narrow).
 *
 * Order: the thread's last-routed agent if still usable → else the chat's primary
 * if usable → else the first usable agent in the pool (preferring the user's
 * default) → else null (no agent available at all).
 */
export function resolveDefaultSelection(params: {
  lastRouted: AgentRef | null;
  primary: AgentRef | null;
  pool: SelectableAgent[];
}): AgentRef | null {
  const { lastRouted, primary, pool } = params;
  const pick = (ref: AgentRef): AgentRef => ({
    instanceName: ref.instanceName,
    agentId: ref.agentId,
  });
  if (isUsable(pool, lastRouted)) return pick(lastRouted!);
  if (isUsable(pool, primary)) return pick(primary!);
  const usable = pool.filter((a) => a.state !== "deleted");
  if (usable.length === 0) return null;
  return pick(usable.find((a) => a.isDefault) ?? usable[0]);
}

/**
 * The composer's effective selection, accounting for BOTH multi-agent capability
 * and the pool's loading state. This is the one place the send decision and the
 * selector read.
 *
 *  - `canRoute` false (a single-agent user: exactly one entitled agent and the
 *    chat is not already perTurnRouting) → ALWAYS null. Such a user must never get
 *    an implicit routedAgent (which would flip the chat to multi-agent + bypass the
 *    normal rebind). The lone pool agent is NOT a per-turn choice.
 *  - pool OR messages still LOADING (`poolLoading`/`messagesLoading`) → preserve the
 *    desired selection (explicit pick, else the last-routed agent), falling back to
 *    primary. Never drop it to null on a transient empty/absent input — in a
 *    perTurnRouting chat that would silently reroute a fast send to the primary
 *    instead of the last-chosen agent. (The caller supplies the chat-level
 *    last-routed agent so it survives the messages-loading window.)
 *  - both LOADED → resolve against the pool (drops a revoked/deleted agent — see
 *    resolveDefaultSelection).
 */
export function resolveEffectiveSelection(params: {
  selected: AgentRef | null;
  lastRouted: AgentRef | null;
  primary: AgentRef | null;
  pool: SelectableAgent[];
  poolLoading: boolean;
  messagesLoading: boolean;
  canRoute: boolean;
}): AgentRef | null {
  const { selected, lastRouted, primary, pool, poolLoading, messagesLoading, canRoute } =
    params;
  if (!canRoute) return null;
  const desired = selected ?? lastRouted;
  if (poolLoading || messagesLoading) return desired ?? primary;
  return resolveDefaultSelection({ lastRouted: desired, primary, pool });
}

/** Look up an agent ref's display (name/emoji) in the user's entitled pool. Null
 *  when the ref is null OR no longer in the pool (e.g. entitlement narrowed). */
export function findAgentDisplay(
  pool: (AgentRef & AgentDisplay)[],
  ref: AgentRef | null,
): AgentDisplay | null {
  if (!ref) return null;
  const found = pool.find((a) => agentRefEquals(a, ref));
  return found ? { displayName: found.displayName, emoji: found.emoji } : null;
}

/**
 * Decide which `routedAgent` (if any) the composer should send for a turn — the
 * SINGLE-AGENT-PATH rule (server contract). Returns `undefined` to keep the
 * unchanged single-agent path (server stamps nothing), or the agent to route to.
 *
 *  - canRoute false              → undefined. A single-agent user (exactly one
 *    entitled agent, chat not perTurnRouting) must NEVER stamp a routedAgent — an
 *    implicit route would flip the chat to multi-agent + bypass the normal rebind.
 *  - Nothing selected            → undefined (no choice made).
 *  - Very first turn of the chat → undefined (the agent is bound at creation;
 *    never flip a brand-new chat to multi-agent on turn 1).
 *  - Chat already perTurnRouting → always stamp the selection (every turn then
 *    carries an explicit agent, so attribution stays unambiguous).
 *  - Selection === primary       → undefined (a normal single-agent send).
 *  - Selection !== primary       → route to it (the server flips perTurnRouting).
 */
export function resolveRoutedAgentToSend(params: {
  selected: AgentRef | null;
  primary: AgentRef | null;
  perTurnRouting: boolean;
  isFirstTurn: boolean;
  canRoute: boolean;
}): AgentRef | undefined {
  const { selected, primary, perTurnRouting, isFirstTurn, canRoute } = params;
  if (!canRoute) return undefined;
  if (!selected) return undefined;
  if (isFirstTurn) return undefined;
  if (perTurnRouting) return selected;
  if (agentRefEquals(selected, primary)) return undefined;
  return selected;
}
