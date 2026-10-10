// SEND LIKE THE CONTROL UI — the Convex half (transcript redesign phase 3, design §3.1,
// §3.5). Everything here applies ONLY to a conversation whose instance runs the
// transcript projection `on`; `off` and `shadow` keep the historical send path.
//
// The Control UI keeps a client-side durable queue for ONE mode — `queue` (the message
// waits until the session is free: ui/src/pages/chat/chat-outbox-drain.ts) — and sends
// every other mode at once with an explicit `queueMode`
// (ui/src/pages/chat/chat-send-submit.ts:548-562 at v2026.9.8). Atrium's outbox is that
// durable queue; this module decides when a send uses it.

import type { Doc } from "../_generated/dataModel";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

export type ProjectionMode = "off" | "shadow" | "on";

/** The person's choice for a send made while the agent works (ui/src/app/settings.ts
 *  :123-130 `CHAT_FOLLOW_UP_MODES`, plus the Control UI's `/redirect` = interrupt). */
export type FollowUpChoice = "queue" | "steer" | "interrupt";

/** Instances read to learn whether ANY runs the projection `on` (deployments have a
 *  handful; beyond the bound the answer is "unknown", which never fails anything). */
export const MAX_INSTANCES_SCANNED = 64;
/** The owner's own agent rows read to find a legacy conversation's default agent. */
export const MAX_OWNER_AGENTS_SCANNED = 64;

/** The `on` switch of the deployment: the names of the OpenClaw instances set `on`, or
 *  null when the bounded read could not see them all. One small bounded read — the
 *  common answer (none) settles every conversation without any routing resolution. */
async function instancesOn(ctx: QueryCtx): Promise<Set<string> | null> {
  const rows = await ctx.db.query("instances").take(MAX_INSTANCES_SCANNED + 1);
  if (rows.length > MAX_INSTANCES_SCANNED) return null;
  const on = new Set<string>();
  for (const r of rows) {
    if (r.kind !== "hermes" && r.config?.transcriptProjection === "on") on.add(r.name);
  }
  return on;
}

/** The instance a conversation's turns go to NOW — the dispatch's own resolution
 *  (bridge.ts `currentRoutedSession`, routing.ts `resolveTargetForChat`):
 *    1. a per-turn routed conversation is on the session of its last CONFIRMED route;
 *    2. a bound conversation on its binding;
 *    3. a legacy conversation (neither field) on the owner's default agent, where its
 *       first dispatch binds it — read from the owner's OWN agent rows, bounded: the
 *       full resolution (group grants, the whole catalogue for an unrestricted owner)
 *       is the dispatch's job, never a send's (a 16,000-agent catalogue aborted the send
 *       mutation). Unknown within the bound ⇒ null (the caller reads `off`).
 *  Reading `chats.instanceName` alone made every per-turn routed or legacy
 *  conversation read `off` while its bridge ran `on`. */
export async function instanceNameOfChat(
  ctx: QueryCtx,
  chat: Doc<"chats">,
): Promise<string | null> {
  if (chat.perTurnRouting === true && chat.lastRoutedInstanceName) {
    return chat.lastRoutedInstanceName;
  }
  if (chat.instanceName) return chat.instanceName;
  const own = await ctx.db
    .query("userAgents")
    .withIndex("by_user", (q) => q.eq("userId", chat.userId))
    .take(MAX_OWNER_AGENTS_SCANNED + 1);
  if (own.length === 0 || own.length > MAX_OWNER_AGENTS_SCANNED) return null;
  return (own.find((u) => u.isDefault) ?? own[0])?.instanceName ?? null;
}

/** The projection switch of the instance a conversation's turns go to (see
 *  `instanceNameOfChat`); `instanceName`, when the caller knows the instance of THIS
 *  turn (a send's per-turn route, an outbox row's stamp), decides instead. The switch
 *  is rolled out instance by instance (design §10.4). Bounded reads only, whatever the
 *  deployment's size: with no instance `on` (the production default) the answer is
 *  `off` before any routing is looked at. */
export async function projectionModeOfChat(
  ctx: QueryCtx,
  chat: Doc<"chats"> | null,
  instanceName?: string,
): Promise<ProjectionMode> {
  const on = await instancesOn(ctx);
  if (on !== null && on.size === 0) {
    // Nothing is `on`: only `shadow` vs `off` remains, and only a named instance can be
    // `shadow` — read that one row, never the routing.
    const named =
      instanceName ??
      (chat === null
        ? null
        : chat.perTurnRouting === true && chat.lastRoutedInstanceName
          ? chat.lastRoutedInstanceName
          : (chat.instanceName ?? null));
    return named === null ? "off" : await switchOf(ctx, named);
  }
  const name = instanceName ?? (chat === null ? null : await instanceNameOfChat(ctx, chat));
  if (!name) return "off";
  return await switchOf(ctx, name);
}

async function switchOf(ctx: QueryCtx, name: string): Promise<ProjectionMode> {
  const inst = await ctx.db
    .query("instances")
    .withIndex("by_name", (q) => q.eq("name", name))
    .first();
  // OpenClaw only: Hermes has no transcript with these identities and no queue modes,
  // and its bridge path is one turn per session — a switch set on a Hermes instance is
  // inert here, as it is in the bridge (design §9.2).
  if (inst?.kind === "hermes") return "off";
  return inst?.config?.transcriptProjection ?? "off";
}

/**
 * What a send does when the conversation is busy (projection `on`):
 *   - `queue` → parked in the outbox until the conversation is free (the Control UI's
 *     durable queue);
 *   - anything else (`steer`, `interrupt`, or the gateway's own mode) → dispatched NOW;
 *     the bridge sends it with the explicit `queueMode` the run policy calls for.
 * `choice` is the send's own choice, else the person's preference; absent = the
 * gateway's mode, which is never `queue` (a client mode).
 */
export function busySendParks(choice: FollowUpChoice | undefined): boolean {
  return choice === "queue";
}

/** The choice stored on the outbox row (the bridge reads it): `queue` is never stored —
 *  a parked row is sent when the conversation is free, where no mode applies. */
export function storedFollowUpMode(
  choice: FollowUpChoice | undefined,
): "steer" | "interrupt" | undefined {
  return choice === "steer" || choice === "interrupt" ? choice : undefined;
}

export function isFollowUpChoice(v: unknown): v is FollowUpChoice {
  return v === "queue" || v === "steer" || v === "interrupt";
}

/** The custody a user bubble shows, from what the gateway said about its input
 *  (design §3.2). PURE. `row`: its `<sendId>:user` transcript row, when read. `fact`:
 *  the input guard (`transcriptInputs`). `queuedAtGateway`: the explicit 9.7+ flags
 *  (lib/transcriptProjection.ts `currentCustody`). */
export function custodyOf(args: {
  acked: boolean;
  row: { steerTargetRunId?: string } | null;
  pendingState?: "queued" | "cancelled" | "interrupted";
  queuedAtGateway: boolean;
  receiptCancelled?: boolean;
}): Doc<"messages">["custody"] {
  if (args.pendingState === "cancelled" || args.receiptCancelled === true) return "cancelled";
  if (args.pendingState === "interrupted") return "interrupted";
  if (args.row !== null) return args.row.steerTargetRunId !== undefined ? "steered" : "persisted";
  if (args.queuedAtGateway) return "queued";
  return args.acked ? "accepted" : undefined;
}

/** At most this many held inputs ride a resume (the newest ones). */
export const MAX_RESUMED_HELD_INPUTS = 20;

/** Messages of the conversation read, newest first, when looking for held inputs. */
export const MAX_HELD_INPUT_SCAN = 200;

/**
 * The inputs the gateway accepted during bubble `m`'s RUN and that no transcript fact
 * has moved yet (custody `accepted` / `queued`: not steered, persisted, cancelled or
 * interrupted) — what a RESTARTED bridge must know again before it resumes that bubble,
 * or the run that answers one of them would be a stranger to it.
 *
 * The window opens at the run's ORIGIN, not at `m`'s creation: `m` may be a later
 * segment (the run was cut at a steered input), and an input queued before that cut is
 * still held — as is one sent while the run's own send awaited its ACK, before any
 * bubble existed (codex pass 4). The origin is the input that started the run (the
 * first segment's dispatch → its outbox row → its message, itself excluded), else the
 * first segment. Each candidate must have gone to the bubble's own instance and agent
 * (its outbox row). Bounded: the run's segments, then at most MAX_HELD_INPUT_SCAN
 * messages, all through indexes.
 */
export async function heldInputsOfRun(
  ctx: QueryCtx,
  m: Pick<
    Doc<"messages">,
    | "_id"
    | "_creationTime"
    | "chatId"
    | "runId"
    | "dispatchOutboxId"
    | "boundInstance"
    | "routedInstanceName"
    | "routedAgentId"
  >,
): Promise<Array<{ sendId: string; messageId: string }>> {
  let first: Pick<Doc<"messages">, "_creationTime" | "dispatchOutboxId"> = m;
  if (m.runId !== undefined) {
    // The run's FIRST segment (runSegment absent), a point read however often it was cut.
    const runId = m.runId;
    for (const x of await ctx.db
      .query("messages")
      .withIndex("by_chat_run_segment", (q) =>
        q.eq("chatId", m.chatId).eq("runId", runId).eq("runSegment", undefined),
      )
      .take(4)) {
      if (x.role === "assistant" && x._creationTime < first._creationTime) first = x;
    }
  }
  let since = first._creationTime;
  let originMessage: string | null = null;
  const dispatch = first.dispatchOutboxId ?? m.dispatchOutboxId;
  if (dispatch !== undefined) {
    const outboxId = ctx.db.normalizeId("outbox", dispatch);
    const row = outboxId === null ? null : await ctx.db.get(outboxId);
    if (row?.messageId !== undefined) {
      const origin = await ctx.db.get(row.messageId);
      if (origin !== null && origin.chatId === m.chatId) {
        since = Math.min(since, origin._creationTime);
        originMessage = origin._id;
      }
    }
  }
  const instance = m.routedInstanceName ?? m.boundInstance;
  const out: Array<{ sendId: string; messageId: string }> = [];
  let scanned = 0;
  for await (const x of ctx.db
    .query("messages")
    .withIndex("by_chat", (q) => q.eq("chatId", m.chatId))
    .order("desc")) {
    if (x._creationTime < since || out.length >= MAX_RESUMED_HELD_INPUTS) break;
    if (++scanned > MAX_HELD_INPUT_SCAN) break;
    if (x._id === originMessage) continue;
    if (x.role !== "user" || x.sendId === undefined) continue;
    if (x.custody !== "accepted" && x.custody !== "queued") continue;
    // The session: an input sent to another instance or agent is not this run's.
    const sent = await ctx.db
      .query("outbox")
      .withIndex("by_message", (q) => q.eq("messageId", x._id))
      .order("desc")
      .first();
    if (sent !== null) {
      const sentInstance = sent.sentToInstance ?? sent.routedAgent?.instanceName;
      if (instance !== undefined && sentInstance !== undefined && sentInstance !== instance) continue;
      if (
        m.routedAgentId !== undefined &&
        sent.routedAgent?.agentId !== undefined &&
        sent.routedAgent.agentId !== m.routedAgentId
      ) {
        continue;
      }
    }
    out.push({ sendId: x.sendId, messageId: x._id });
  }
  return out.reverse();
}

/**
 * Does a send made while the conversation is busy go to the SAME gateway session as the
 * turn in progress? Only then can it go at once: the bridge keeps one session per
 * conversation, and opening another agent's session would close the working one's
 * socket mid-stream. Unknown ⇒ no (the send waits in the queue, as before).
 *   - a conversation bound to one agent: its binding (a send naming another agent is
 *     not this session);
 *   - a conversation routed turn by turn: the last confirmed route, and only a send
 *     that names that same agent.
 */
export function sendTargetsActiveSession(
  chat: Pick<
    Doc<"chats">,
    "perTurnRouting" | "instanceName" | "agentId" | "lastRoutedInstanceName" | "lastRoutedAgentId"
  >,
  routedAgent: { instanceName: string; agentId: string } | undefined,
): boolean {
  if (chat.perTurnRouting !== true) {
    return (
      routedAgent === undefined ||
      (routedAgent.instanceName === chat.instanceName && routedAgent.agentId === chat.agentId)
    );
  }
  if (!chat.lastRoutedInstanceName || !chat.lastRoutedAgentId || routedAgent === undefined) {
    return false;
  }
  return (
    routedAgent.instanceName === chat.lastRoutedInstanceName &&
    routedAgent.agentId === chat.lastRoutedAgentId
  );
}

/** Bound on the text a resume carries for the earlier segments of a cut run. */
export const MAX_SEGMENT_PREFIX_CHARS = 200_000;

/**
 * The text of the SEGMENTS that precede bubble `m` in its run (a run cut at steered
 * inputs, CU-20), in order — what a restarted bridge strips from the run's cumulative
 * buffer when it resumes the last segment. Undefined when `m` is not a later segment.
 */
export async function segmentPrefixOf(
  ctx: QueryCtx,
  m: Pick<Doc<"messages">, "chatId" | "runId" | "runSegment">,
): Promise<string | undefined> {
  if (m.runSegment === undefined || m.runId === undefined) return undefined;
  const runId = m.runId;
  const seg = m.runSegment;
  const earlier = (
    await ctx.db
      .query("messages")
      .withIndex("by_chat_run", (q) => q.eq("chatId", m.chatId).eq("runId", runId))
      .take(50)
  )
    .filter((x) => x.role === "assistant" && (x.runSegment ?? 0) < seg)
    .sort((a, b) => (a.runSegment ?? 0) - (b.runSegment ?? 0))
    .map((x) => x.text.trim())
    .filter((t) => t !== "");
  if (earlier.length === 0) return undefined;
  return earlier.join("\n\n").slice(0, MAX_SEGMENT_PREFIX_CHARS);
}
