// WHICH user messages wait in the composer's queue dock instead of the thread.
//
// Two queues, one place (transcript redesign phase 6):
//   - Atrium's OWN queue: a message parked in the outbox (`queue` mode) until the agent is
//     free — the dock since the Codex-style queue (QueuedDock.tsx);
//   - the GATEWAY'S queue (2026.9.7+): an input the gateway accepted and holds behind the
//     run in progress (`pendingInputs.items[].queued`, read back by the transcript
//     projection into `messages.custody = "queued"`). The Control UI shows those in the
//     composer's queue and NEVER in the thread (ui/src/pages/chat/history-merge.ts:402-441
//     at v2026.9.8), and empties that queue on a page that says `queuedCount: 0`
//     (chat-pending-inputs.ts:59-61).
//
// The gateway's queue is PER SESSION (codex phase 6 pass 4): a conversation can run several
// sessions (agents), and one session's read must never move another session's message.
// Convex names, for each session, the send identities it holds queued (convex/followUp.ts
// `gatewayQueueSessions`, which never loads a message — codex phase 6 pass 5); a message
// leaves the thread only through its own session's fact (matched by the `queuedSendId`
// messages.listByChat gives a queued bubble), while that fact is fresh and non-empty.
//
// A message is in the thread OR in the dock, never both. PURE: the runtime passes the facts.

/** One session's queue as its last read stated it. */
export type GatewayQueueSessionFact = { count: number; until: number; sendIds: string[] };
/** The conversation's gateway queues (convex/followUp.ts `followUpState.gatewayQueue`). */
export type GatewayQueueFact = { sessions: GatewayQueueSessionFact[] } | null | undefined;

/** The sessions whose last read still vouches for their queue: projection `on` only (after
 *  a rollback nothing moves a custody any more), fresh, and not emptied by the gateway. */
export function liveQueueSessions(
  projection: boolean,
  queue: GatewayQueueFact,
  now: number,
): GatewayQueueSessionFact[] {
  if (!projection || queue === null || queue === undefined) return [];
  return queue.sessions.filter((s) => s.count > 0 && now < s.until);
}

/** The send identities a live session holds in its queue. */
export function gatewayQueuedIds(live: readonly GatewayQueueSessionFact[]): Set<string> {
  return new Set(live.flatMap((s) => s.sendIds));
}

/** Where one user message sits: Atrium's own queue, the gateway's, or the thread. */
export function dockPlaceOf(
  m: {
    _id: unknown;
    role: string;
    custody?: string | null;
    queuedSendId?: string | null;
    outbox?: { status?: string } | null;
  },
  echoIds: ReadonlySet<string>,
  gatewayQueued: ReadonlySet<string>,
): "atrium" | "gateway" | "thread" {
  if (m.role !== "user") return "thread";
  // Atrium's own queue first: a parked outbox row has not reached the gateway at all.
  if (m.outbox?.status === "queued" || echoIds.has(String(m._id))) return "atrium";
  return m.custody === "queued" && typeof m.queuedSendId === "string" && gatewayQueued.has(m.queuedSendId)
    ? "gateway"
    : "thread";
}

/** Inputs the gateway queues that are NOT this conversation's own cards (another client
 *  sent them): Atrium keeps no text for them. Counted PER SESSION — each session's count
 *  minus the cards that session itself accounts for — then summed into one line. */
export function othersInGatewayQueue(
  live: readonly GatewayQueueSessionFact[],
  ownCardSendIds: ReadonlySet<string>,
): number {
  let others = 0;
  for (const s of live) {
    const own = s.sendIds.filter((id) => ownCardSendIds.has(id)).length;
    others += Math.max(0, s.count - own);
  }
  return others;
}
