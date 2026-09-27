// Pure helpers for the per-turn agent router (multi-agent chats). NO React and
// NO Convex imports, so they unit-test without a DOM or a backend (the frontend
// has no DOM test runner — see the AgentPicker helpers next door).
//
// A single visible conversation can route different turns to different agents.
// These helpers answer the three questions the UI has to make pure + testable:
//   - resolveMessageAgents:     which agent answered each message (attribution).
//   - lastRoutedAgent:          the in-flight placeholder's attribution fallback.
//   - resolveTurnRoute:         where the next message goes (mentions, else primary).

import { managesRoom, type RoomRole } from "./conversationRoles";

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
  /** IMPORTED history: the agent that answered, as a name only. */
  importedAgentLabel?: string;
  /** IMPORTED history: the agent the CONVERSATION was bound to elsewhere. */
  chatImportedAgentLabel?: string;
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
 *    an implicit routedAgent (which would flip the chat to multi-agent). The lone
 *    pool agent is NOT a per-turn choice.
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

/** The selector's resolved verdict: rendered at all, and offered or not. A pick
 *  ADDRESSES an agent in the NEXT message (its "@Name" token; `resolveTurnRoute`) — never the
 *  conversation's primary, which is chosen in the conversation panel only
 *  (chatAgents.setPrimaryAgent). `hidden` lives here rather than as a JSX condition
 *  because the component's own `multiAgent` check once discarded a gate that said
 *  "enabled" — a dead end the pure tests could not see. */
export interface AgentSelectorGate {
  hidden: boolean;
  disabled: boolean;
  /** WHY it is disabled. The trigger shows a different hint for each: a reader told
   *  their conversation is read-only while they are on a call would go looking for
   *  the wrong cause. */
  reason?: "call-active" | "read-only";
  /** WHO is on the line, when `reason` is "call-active". The label must name the
   *  agent the CALL is on, not this tab's local selection: another tab, or a
   *  participant with a different pick, showed a locked control naming the wrong
   *  agent while the call ran on someone else (codex P2, pass 5). Carried on the
   *  gate, beside the decision it belongs to — the closure and the name coming from
   *  two different reads is how they disagreed in the first place. */
  onCall?: { instanceName: string; agentId: string } | null;
}

/**
 * Is the agent selector offered?
 *
 * WHY THIS EXISTS (production report, 2026-07-31). A user opened a new chat on an
 * agent whose gateway happened to be down. The composer greyed out — correctly — but
 * the agent selector greyed out WITH it, so the only way out of the dead conversation
 * was to delete it. The selector is the ESCAPE HATCH from a bad target; disabling it
 * on the very condition it exists to resolve is the deadlock.
 *
 * `unavailable` is therefore taken as an input and DELIBERATELY does not disable the
 * control — passing it makes that decision assertable instead of implicit (re-adding
 * `|| unavailable` at the call site is what the tests neutralize). A pick of a healthy
 * agent addresses it in the message and re-scopes the availability query to it
 * (the composer's next target), which un-greys the composer, from the very first
 * message on: the first turn is routed like any other.
 *
 * READ-ONLY closes it: the lock is computed from the chat's BINDING, not the
 * selection, so a pick would light up and change nothing. The way out of a read-only
 * conversation is its owner's — the conversation panel changes the primary.
 */
export function resolveAgentSelectorGate(params: {
  /** This chat's next send target is unreachable. Never a reason to disable. */
  unavailable: boolean;
  /** The chat is bound to an agent the user is no longer entitled to. */
  readOnly: boolean;
  /** The user has MORE THAN ONE entitled agent (getChatAgent's flag). */
  multiAgent: boolean;
  /** Count of SELECTABLE agents in the entitled pool — a gateway-deleted agent does
   *  NOT count, since the picker renders it as a disabled row. Counting rows instead
   *  would light the escape hatch up over a list where nothing can be clicked: an
   *  active control with no possible action, which is the same lie in a new place. */
  poolSize: number;
  /** A voice call is up on this chat. Its agent is pinned (the gateway holds the
   *  session and the mid-call consult addresses that agent), so switching would
   *  split the conversation in two — and on a gateway-owned call it would end the
   *  call. The server refuses it too (`TALK_CALL_ACTIVE`); this is the half that
   *  tells the reader BEFORE they click. */
  callActive?: boolean;
  /** The agent that call is on, when the server knows it. */
  onCall?: { instanceName: string; agentId: string } | null;
}): AgentSelectorGate {
  const { readOnly, multiAgent, poolSize } = params;
  // Nothing to offer: a pick between agents is meaningless when there is only one.
  const hidden = poolSize === 0 || !multiAgent;
  // Ahead of every other verdict, and never HIDDEN for that reason: the control must
  // keep showing which agent is on the line — it is simply not changeable right now.
  if (params.callActive === true) {
    return {
      hidden,
      disabled: true,
      reason: "call-active",
      onCall: params.onCall ?? null,
    };
  }
  return readOnly ? { hidden, disabled: true, reason: "read-only" } : { hidden, disabled: false };
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
 * WHERE THE NEXT MESSAGE GOES — addressing by mention, no hidden selection.
 *
 *  - It mentions agents → the FIRST one (the others answer after it, in text order;
 *    the server chains them from the mentions themselves).
 *  - It mentions none → the PRIMARY (the crown), always — never "the last agent
 *    used". Sent explicitly wherever there is a choice (a room of several agents, or
 *    a chat already routed per turn), so the server routes it as a turn like any
 *    other and re-hydrates the primary when another agent spoke last.
 *  - `canRoute` false (a single-agent user) → undefined whatever else: an implicit
 *    route would flip the chat to multi-agent (P2-C); the server's own path applies.
 *  - A single-agent room not yet routed per turn → undefined: the unchanged path.
 */
export function resolveTurnRoute(params: {
  /** The agents the text mentions, in text order. */
  mentioned: readonly AgentRef[];
  primary: AgentRef | null;
  /** The room holds more than one agent. */
  severalAgents: boolean;
  perTurnRouting: boolean;
  canRoute: boolean;
}): AgentRef | undefined {
  const { mentioned, primary, severalAgents, perTurnRouting, canRoute } = params;
  if (!canRoute) return undefined;
  const first = mentioned[0];
  if (first !== undefined) {
    return { instanceName: first.instanceName, agentId: first.agentId };
  }
  if (primary === null || !(severalAgents || perTurnRouting)) return undefined;
  return { instanceName: primary.instanceName, agentId: primary.agentId };
}

/**
 * Per message, the name of the agent that answered it in ANOTHER deployment.
 *
 * Same inheritance as the attribution above — an assistant reply takes the label
 * of the user turn it answers when it carries none — because the two describe
 * the same thing. It is separate from `resolveMessageAgents` for one reason: an
 * `AgentRef` is ROUTABLE, and this must never be. It is a name to display, and
 * nothing here exists in this deployment.
 */
export function resolveImportedAgentLabels(
  messages: RoutableMessage[],
): Map<string, string | null> {
  const out = new Map<string, string | null>();
  let fromUserTurn: string | null = null;
  for (const message of messages) {
    if (message.role === "user") {
      fromUserTurn = message.importedAgentLabel ?? null;
      out.set(message._id, fromUserTurn ?? message.chatImportedAgentLabel ?? null);
      continue;
    }
    // Own, then the turn it answers, then the conversation's. The last is the
    // ordinary single-agent case, where no message names an agent at all.
    out.set(
      message._id,
      message.importedAgentLabel ??
        fromUserTurn ??
        message.chatImportedAgentLabel ??
        null,
    );
  }
  return out;
}

/**
 * The composer picker's ORDER — one flat list, read top to bottom, no per-instance
 * headings to scan past:
 *   1. the conversation's primary;
 *   2. the other agents of the room, in the order they were added;
 *   3. everything else the reader may address, by name.
 * `room` holds 1 and 2 (empty when the room has no added agent: the list is then
 * simply the primary followed by the rest). A search keeps the order and drops
 * what does not match.
 */
export function orderComposerAgents<
  T extends AgentRef & { displayName: string | null },
>(
  pool: T[],
  primary: AgentRef | null,
  roomAgents: AgentRef[],
): { room: T[]; others: T[] } {
  const primaryRow = pool.find((a) => agentRefEquals(a, primary)) ?? null;
  const added = roomAgents
    .map((r) => pool.find((a) => agentRefEquals(a, r)) ?? null)
    .filter((a): a is T => a !== null && !agentRefEquals(a, primary));
  const inRoom = (a: T) =>
    agentRefEquals(a, primary) || added.some((r) => agentRefEquals(r, a));
  // NATURAL order ("bench-2" before "bench-10"), case-insensitive.
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const name = (a: T) => a.displayName ?? a.agentId;
  const rest = pool
    .filter((a) => !inRoom(a))
    .sort(
      (a, b) =>
        collator.compare(name(a), name(b)) || collator.compare(a.instanceName, b.instanceName),
    );
  if (added.length === 0) {
    return { room: [], others: primaryRow ? [primaryRow, ...rest] : rest };
  }
  return { room: primaryRow ? [primaryRow, ...added] : added, others: rest };
}

/**
 * Which listed agents the composer's SIMPLIFIED list must tell apart: those whose
 * name another listed agent also bears ("Alice" on two gateways). The list shows no
 * technical detail — no model, no instance — except for these, which carry their
 * instance so two rows never read the same. Keys are `instance\u0000agentId`; names
 * compare as they read (trimmed, case-insensitive, the id when unnamed).
 */
export function homonymAgentKeys(
  rows: ReadonlyArray<AgentRef & { displayName: string | null }>,
): Set<string> {
  const label = (a: AgentRef & { displayName: string | null }) =>
    (a.displayName ?? a.agentId).trim().toLocaleLowerCase();
  const byLabel = new Map<string, Set<string>>();
  for (const a of rows) {
    const keys = byLabel.get(label(a)) ?? new Set<string>();
    keys.add(`${a.instanceName}\u0000${a.agentId}`);
    byLabel.set(label(a), keys);
  }
  const out = new Set<string>();
  for (const keys of byLabel.values()) {
    if (keys.size > 1) for (const k of keys) out.add(k);
  }
  return out;
}

/**
 * May this reader take this agent OUT of the room, from the composer's list? The
 * same authority as `chatAgents.removeChatAgent` (the owner and the managers), and
 * only for an ADDED agent: the primary is never removed — it changes through "Make
 * primary" in the conversation panel — and an agent outside the room has nothing to
 * remove.
 */
export function mayRemoveRoomAgent(
  viewer: RoomRole | undefined,
  agent: AgentRef,
  primary: AgentRef | null,
  roomAgents: readonly AgentRef[],
): boolean {
  if (!managesRoom(viewer)) return false;
  if (agentRefEquals(agent, primary)) return false;
  return roomAgents.some((r) => agentRefEquals(r, agent));
}

/**
 * The reader's pool, completed with the room's agents it does NOT hold: an agent
 * of the room the reader cannot reach (revoked, gone) stays listed, disabled
 * (`state: "deleted"`), so the list shows who is in the room — as the count does.
 */
/** A room agent the reader does not hold, as a disabled picker row. */
export type RosterRow = AgentRef & {
  isDefault: boolean;
  displayName: string | null;
  emoji: string | null;
  model: string | null;
  description: string | null;
  kind: "openclaw" | "hermes";
  state: "deleted";
};

export function withRoomRoster<P extends AgentRef>(
  pool: P[],
  roster: Array<
    | (AgentRef & {
        role: "primary" | "member";
        displayName: string | null;
        emoji: string | null;
        model: string | null;
        description: string | null;
        kind: "openclaw" | "hermes";
      })
    | null
  >,
): Array<P | RosterRow> {
  const missing: RosterRow[] = [];
  for (const a of roster) {
    if (a === null || pool.some((p) => agentRefEquals(p, a))) continue;
    missing.push({
      instanceName: a.instanceName,
      agentId: a.agentId,
      isDefault: a.role === "primary",
      displayName: a.displayName,
      emoji: a.emoji,
      model: a.model,
      description: a.description,
      kind: a.kind,
      state: "deleted",
    });
  }
  return missing.length === 0 ? pool : [...pool, ...missing];
}

/**
 * WHO the composer's presence strip shows: every person — the reader included —
 * then every agent, so the strip and the room control state the SAME count. Null
 * when the conversation is not a room (nobody but the reader, at most one agent).
 */
export function presenceRoster<P extends { isSelf: boolean }, A>(
  people: readonly P[],
  agents: readonly A[],
): { people: readonly P[]; agents: readonly A[] } | null {
  if (people.every((p) => p.isSelf) && agents.length <= 1) return null;
  return { people, agents };
}

/**
 * The agents a message can be ADDRESSED to: those in the conversation (the primary and
 * the ones added to it). An agent outside the room is only ever ADDED — never a target
 * — so a room's replies always come from its members. Until the room is known, the pool
 * is left as is (nothing to filter against yet).
 */
export function roomTargets<P extends AgentRef>(
  pool: readonly P[],
  room: ReadonlyArray<AgentRef | null> | null,
): P[] {
  if (room === null) return [...pool];
  const inRoom = new Set(
    room.filter((a): a is AgentRef => a !== null).map((a) => `${a.instanceName}\u0000${a.agentId}`),
  );
  return pool.filter((a) => inRoom.has(`${a.instanceName}\u0000${a.agentId}`));
}
