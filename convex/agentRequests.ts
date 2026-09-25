// AGENT REQUESTS — the ask, the answer, and everything in between.
//
// An agent that asks a person something STOPS until it hears back or its provider's
// deadline passes (OpenClaw 15 min for a question; Hermes 60 s for an approval, 300 s
// for a clarification). Before this module nothing in Atrium could answer: a question
// was invisible, a Hermes approval was refused on the person's behalf, and a turn
// waiting on a human was declared dead by our own silence clock.
//
// WRITERS
//   - the bridge, through `/bridge/ingest` (`upsertAgentRequest`, `settleAgentRequest`),
//     authenticated per bridge and re-checked ATOMICALLY against the chat's instance;
//   - the person, through `answer` — prepared in a mutation (access, freshness, answer
//     rules), sent by the action to the bridge that serves the request's instance, and
//     settled by what the gateway said.
//
// A SECRET NEVER TOUCHES THE DATABASE. A credential or a secret question's value rides
// the action's arguments to the bridge and is dropped; the row only records that it
// was provided.

import { v } from "convex/values";
import {
  action,
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireActive, requireReachableChat } from "./lib/access";
import { chatAllowsInstance } from "./lib/ingestAuthz";
import { resolveBridgeUrlForDispatch } from "./lib/bridgeRouting";
import { resolveGatewayUser, resolveTargetForChat } from "./routing";
import { writeTraceEvent } from "./observability";
import { notifyUser } from "./notifications";
import {
  DEFAULT_REQUEST_TTL_MS,
  EXPIRY_SWEEP_GRACE_MS,
  MAX_ANSWER_CHARS,
  MAX_ANSWER_VALUES,
  MAX_REQUEST_TTL_MS,
  SECRET_ANSWER_PLACEHOLDER,
  agentRequestAnswerValidator,
  agentRequestSourceValidator,
  approvalDecisionValidator,
  boundApproval,
  boundCredential,
  boundQuestions,
  isOpenStatus,
  kindForSource,
  questionShape,
  providerForSource,
  statusForDecision,
  storableAnswers,
  validateAnswers,
  withholdSecretAnswers,
  type AgentRequestStatus,
  type ApprovalDecision,
} from "./lib/agentRequests";

/** How long the answer POST may take. The gateway answers a resolve in
 *  milliseconds; this bounds a hung bridge, not a slow agent. */
const ANSWER_POST_TIMEOUT_MS = 45_000;
/** How many rows a conversation's request list returns (newest first). */
/** Longest provider request id kept (bridge core/agent-requests.ts MAX_PROVIDER_ID_CHARS). */
const MAX_PROVIDER_REQUEST_ID = 512;
/** Generations of one provider id read by a settle (an id comes back rarely). */
const MAX_GENERATIONS_READ = 20;
/** Stale Hermes approvals closed by one new one (see upsertFromBridge). A session holds
 *  a handful at most; anything left is closed by the next approval or the sweep. */
const MAX_SUPERSEDED_PER_WRITE = 50;
const LIST_LIMIT = 100;
/** Open rows of one conversation returned beyond the recent page. A request is
 *  created by an agent's tool call, so hundreds open at once is not a conversation. */
const OPEN_LIST_LIMIT = 500;
/** A `submitting` row older than this lost its action (a platform kill between the
 *  click and the settle) and goes back to `pending` so the person can try again. */
const SUBMIT_STALL_MS = 3 * 60_000;

const terminalStatusValidator = v.union(
  v.literal("answered"),
  v.literal("allowed"),
  v.literal("denied"),
  v.literal("expired"),
  v.literal("cancelled"),
);

function trace(
  ctx: MutationCtx,
  chatId: Id<"chats">,
  meta: Record<string, string | number | boolean>,
) {
  // Metadata ONLY — never the question, the command or an answer.
  return writeTraceEvent(ctx, {
    kind: "agent.request",
    direction: "internal",
    principalType: "system",
    principalId: "agent-requests",
    chatId: String(chatId),
    correlationId: String(chatId),
    meta: JSON.stringify(meta),
  });
}

/** The newest assistant bubble of a chat — where an ask with no known turn is shown. */
async function latestAssistantMessage(
  ctx: QueryCtx | MutationCtx,
  chatId: Id<"chats">,
): Promise<Id<"messages"> | undefined> {
  const recent = await ctx.db
    .query("messages")
    .withIndex("by_chat", (q) => q.eq("chatId", chatId))
    .order("desc")
    .take(25);
  return recent.find((m) => m.role === "assistant")?._id;
}

function boundedDeadline(now: number, expiresAt: number | undefined): number {
  if (
    typeof expiresAt === "number" &&
    Number.isFinite(expiresAt) &&
    expiresAt > now &&
    expiresAt <= now + MAX_REQUEST_TTL_MS
  ) {
    return Math.round(expiresAt);
  }
  return now + DEFAULT_REQUEST_TTL_MS;
}

/** Mark the owner's notification for a request read once it no longer waits. */
/** The request's notification, gone with it (a cascade): a bell entry linking to a
 *  deleted conversation, unread forever, is worse than none (codex P3). */
async function deleteNotification(ctx: MutationCtx, row: Doc<"agentRequests">) {
  const note = await ctx.db
    .query("notifications")
    .withIndex("by_user_dedupe", (q) =>
      q.eq("userId", row.userId).eq("dedupeKey", `agent_request:${String(row._id)}`),
    )
    .first();
  if (note !== null) await ctx.db.delete(note._id);
}

async function clearNotification(ctx: MutationCtx, row: Doc<"agentRequests">) {
  const note = await ctx.db
    .query("notifications")
    .withIndex("by_user_dedupe", (q) =>
      q.eq("userId", row.userId).eq("dedupeKey", `agent_request:${String(row._id)}`),
    )
    .first();
  if (note !== null && note.readAt === undefined) {
    await ctx.db.patch(note._id, { readAt: Date.now() });
  }
}

// ── Bridge → Convex ───────────────────────────────────────────────────────────

/**
 * Record a request the bridge observed. Idempotent on (chat, provider id): a replay
 * after reconnect refreshes nothing on a settled row and never reopens it.
 */
export const upsertFromBridge = internalMutation({
  args: {
    chatId: v.id("chats"),
    boundInstanceName: v.string(),
    messageId: v.optional(v.string()),
    agentId: v.optional(v.string()),
    source: agentRequestSourceValidator,
    providerRequestId: v.string(),
    approvalKind: v.optional(
      v.union(v.literal("exec"), v.literal("plugin"), v.literal("system-agent")),
    ),
    sessionKey: v.optional(v.string()),
    runId: v.optional(v.string()),
    seq: v.optional(v.number()),
    providerCreatedAt: v.optional(v.number()),
    /** Hermes approvals: the session's approvals ordered before this are over. */
    supersedesBeforeSeq: v.optional(v.number()),
    /** A Hermes server→client request: answered by its own id, not by session order. */
    answerById: v.optional(v.boolean()),
    /** The bridge's own sighting order (see `nextSightingSeq`). */
    providerSeenSeq: v.optional(v.number()),
    /** The bridge process that saw it (`SIGHTING_EPOCH`). */
    providerSeenEpoch: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
    questions: v.optional(v.any()),
    approval: v.optional(v.any()),
    credential: v.optional(v.any()),
  },
  handler: async (ctx, args): Promise<{ id: Id<"agentRequests"> | null; created: boolean }> => {
    const chat = await ctx.db.get(args.chatId);
    if (chat === null) return { id: null, created: false };
    if (!(await chatAllowsInstance(ctx, args.chatId, args.boundInstanceName))) {
      throw new Error("forbidden: cross-instance agent request target");
    }
    // The provider's address, VERBATIM: the gateway matches it byte for byte, so a
    // trimmed or cut id could name — and answer — another request (codex P1). An id
    // too long to keep whole is refused, never shortened.
    const providerRequestId = args.providerRequestId;
    if (providerRequestId === "" || providerRequestId.length > MAX_PROVIDER_REQUEST_ID) {
      return { id: null, created: false };
    }
    // The NEWEST row for this id. A replay (reconnect, retried POST) is the same row —
    // never a resurrection of a settled one. But the same id may name a NEW request:
    // OpenClaw forgets a settled question after 15 s and takes caller-chosen ids, so a
    // settled row whose provider creation time differs from this one is an older
    // generation, and this request gets its own row (codex P2).
    const incomingFamily = familyOf(args.source);
    const existing =
      (
        await ctx.db
          .query("agentRequests")
          // Same INSTANCE by the index — a per-turn-routed chat talks to several
          // gateways, which may use the same id — then the same family (codex P2 ×2).
          .withIndex("by_chat_instance_provider_request", (q) =>
            q
              .eq("chatId", args.chatId)
              .eq("instanceName", args.boundInstanceName)
              .eq("providerRequestId", providerRequestId),
          )
          .order("desc")
          .take(MAX_GENERATIONS_READ)
      ).find((r) => familyOf(r.source) === incomingFamily) ?? null;
    // A row WITHOUT a generation cannot be a replay of this one either: every OpenClaw
    // request ingested carries one (required below), so such a row came from an
    // archive import (which drops it) or a seed — an older request (codex P2).
    // Only a NEWER one supersedes: a late re-emission of an older generation is a replay
    // of history, never a reason to close the request asked since (codex P2).
    // …or one with ANOTHER creation time that the bridge SAW LATER: a gateway clock that
    // stood still or stepped back must not leave the old row answering for the new request
    // (codex P2), while a late retried write of an older sighting still carries its own,
    // older seq and supersedes nothing.
    // The seq is the bridge's wall clock (µs), made strictly increasing within a process —
    // the one order two processes share. Another process is NOT later by construction: a
    // rolling deploy runs the old and the new bridge side by side, and the old one's late
    // write must not close the request the new one recorded since (codex P2, 0.21.5 pass
    // 19). Left: a bridge host clock stepping BACK further than the gap between two
    // sightings — the card then keeps the older question, and an answer to it is refused
    // by the question-shape check rather than delivered to the newer one.
    const seenLater =
      typeof args.providerSeenSeq === "number" &&
      Number.isFinite(args.providerSeenSeq) &&
      args.providerSeenSeq > (existing?.providerSeenSeq ?? 0);
    // …and the SAME creation time asking ANOTHER question (a clock that stood still): taken
    // for a replay, the old row would answer it and mask its secrets by the old flags
    // (codex P1). The shape is compared, not the text, which is bounded here.
    const otherQuestion =
      existing !== null &&
      existing.questions !== undefined &&
      args.questions !== undefined &&
      // Bounded like the stored copy, so a replay of the SAME question compares equal.
      questionShape(existing.questions) !== questionShape(boundQuestions(args.questions));
    // Both sightings ordered: one seen EARLIER is never a newer generation, whatever its
    // creation time — a late retry of the first sighting after the gateway clock stepped
    // back would otherwise close the request asked since (codex P2, 0.21.5 pass 21).
    const ordered =
      typeof args.providerSeenSeq === "number" && typeof existing?.providerSeenSeq === "number";
    const newGeneration =
      existing !== null &&
      typeof args.providerCreatedAt === "number" &&
      (existing.providerCreatedAt === undefined ||
        (args.providerCreatedAt > existing.providerCreatedAt && (!ordered || seenLater)) ||
        (args.providerCreatedAt !== existing.providerCreatedAt && seenLater) ||
        (otherQuestion && seenLater));
    // The gateway forgets a settled request and may then give its id to a NEW one — and
    // under a clock that stood still, or stepped back, with the same or an older
    // creation time (codex P2). A `pending` sighting of an id whose row here is settled
    // cannot be the old request: its own `resolved` preceded this on the same socket,
    // and the replays (question.list / approval.get) list pending ones only. So it is
    // recorded — unless it arrives already past its deadline, which is the one way a
    // row Atrium closed early (its sweep) can still be listed pending for a moment.
    // Seen AFTER the settled row's own sighting: a late write from another bridge process
    // (a rolling deploy) of the request before it settled is history, not a reuse — it
    // would raise a phantom card for a request already over (codex P2, 0.21.5 pass 20).
    const reusedAfterSettle =
      existing !== null &&
      !newGeneration &&
      args.source.startsWith("openclaw.") &&
      !isOpenStatus(existing.status) &&
      seenLater &&
      (args.expiresAt === undefined || args.expiresAt > Date.now());
    if (existing !== null && !newGeneration && !reusedAfterSettle) {
      return { id: existing._id, created: false };
    }
    const kind = kindForSource(args.source);
    const questions = kind === "question" ? boundQuestions(args.questions) : null;
    const approval = kind === "approval" ? boundApproval(args.approval) : null;
    // An OpenClaw secret question is a question the gateway validates as such; it
    // is SHOWN as a credential (masked input, nothing stored).
    // Each question keeps ITS OWN flag: a request may mix a secret with ordinary
    // questions, and masking the ordinary ones would accept answers the gateway then
    // refuses (a blank "region" passes as a secret, is trimmed and rejected upstream).
    const secretQuestions =
      args.source === "openclaw.secret" ? boundQuestions(args.questions) : null;
    if (kind === "question" && questions === null) return { id: null, created: false };
    if (kind === "approval" && approval === null) return { id: null, created: false };
    // An OpenClaw request is addressed by an id the gateway may give to ANOTHER request
    // later (caller-chosen, forgotten 15 s after settling): only its generation — the
    // creation time upstream always sends (QuestionRecord / approval snapshot
    // `createdAtMs`, required) — tells them apart. Without it, not recorded (codex P1).
    if (
      args.source.startsWith("openclaw.") &&
      (typeof args.providerCreatedAt !== "number" || !Number.isFinite(args.providerCreatedAt))
    ) {
      return { id: null, created: false };
    }
    // A Hermes approval is answered by SESSION, oldest first: without its session and
    // its order it cannot be placed in that queue, and answering it could decide
    // another one (codex P1). Not recorded rather than recorded unorderable.
    if (
      args.source === "hermes.approval" &&
      (typeof args.sessionKey !== "string" ||
        args.sessionKey.trim() === "" ||
        typeof args.seq !== "number" ||
        !Number.isFinite(args.seq))
    ) {
      return { id: null, created: false };
    }
    if (
      args.source === "openclaw.secret" &&
      (secretQuestions === null || !secretQuestions.some((q) => q.secret))
    ) {
      return { id: null, created: false };
    }
    // An older generation still OPEN here (its settle was lost) is over for certain:
    // the gateway reuses an id only after forgetting the settled one. Closed now, so it
    // can never be answered in the new one's place (codex P1). Only once the new one is
    // KNOWN recordable: an observation refused below must leave the open request as it
    // was, not closed with nothing in its place (codex P2, 0.21.5 pass 20).
    if (existing !== null && newGeneration && isOpenStatus(existing.status)) {
      const nowClosed = Date.now();
      await ctx.db.patch(existing._id, { status: "cancelled", updatedAt: nowClosed, resolvedAt: nowClosed });
      await clearNotification(ctx, existing);
    }

    // An earlier turn's Hermes approval whose close was lost stays `pending` here while
    // Hermes has long moved on — and, heading the session's queue, it refused every
    // later answer (oldest first) and disabled the new card (several waiting) for up to
    // the 24 h hold (codex P2). The bridge names the bound: this turn was ACKed
    // `streaming`, which Hermes does only on an idle session. Closed in THIS write, so
    // the new request is never recorded behind a ghost. `submitting` ones too: whatever
    // their answer did, the approval no longer waits — and left open, the reaper would
    // put a lost action's row back to `pending` at the head of the queue (codex P2). A
    // closed row stays closed: completeAnswer keeps a terminal verdict, revertAnswer
    // and the reaper only touch `submitting`.
    if (
      args.source === "hermes.approval" &&
      typeof args.supersedesBeforeSeq === "number" &&
      Number.isFinite(args.supersedesBeforeSeq) &&
      typeof args.sessionKey === "string"
    ) {
      const bound = args.supersedesBeforeSeq;
      const stale: Doc<"agentRequests">[] = [];
      for (const status of ["pending", "submitting"] as const) {
        stale.push(
          ...(await ctx.db
            .query("agentRequests")
            .withIndex("by_chat_instance_source_session_status_seq", (q) =>
              q
                .eq("chatId", args.chatId)
                .eq("instanceName", args.boundInstanceName)
                .eq("source", "hermes.approval")
                .eq("sessionKey", args.sessionKey!.slice(0, 512))
                .eq("status", status)
                .lt("seq", bound),
            )
            .take(MAX_SUPERSEDED_PER_WRITE)),
        );
      }
      const closedAt = Date.now();
      for (const row of stale) {
        await ctx.db.patch(row._id, { status: "cancelled", updatedAt: closedAt, resolvedAt: closedAt });
        await clearNotification(ctx, row);
      }
    }

    // Anchor: the turn's own bubble when the bridge named one that IS in this chat.
    let messageId: Id<"messages"> | undefined;
    if (args.messageId !== undefined) {
      const mid = ctx.db.normalizeId("messages", args.messageId);
      if (mid !== null) {
        const msg = await ctx.db.get(mid);
        if (msg !== null && msg.chatId === args.chatId) messageId = mid;
      }
    }
    messageId ??= await latestAssistantMessage(ctx, args.chatId);

    const now = Date.now();
    const id = await ctx.db.insert("agentRequests", {
      chatId: args.chatId,
      userId: chat.userId,
      ...(messageId !== undefined ? { messageId } : {}),
      instanceName: args.boundInstanceName,
      ...(args.agentId !== undefined ? { agentId: args.agentId.slice(0, 128) } : {}),
      source: args.source,
      kind,
      providerRequestId,
      ...(args.approvalKind !== undefined ? { approvalKind: args.approvalKind } : {}),
      ...(args.answerById === true && args.source.startsWith("hermes.") ? { answerById: true } : {}),
      ...(typeof args.providerSeenSeq === "number" && Number.isFinite(args.providerSeenSeq)
        ? { providerSeenSeq: args.providerSeenSeq }
        : {}),
      ...(typeof args.providerSeenEpoch === "string"
        ? { providerSeenEpoch: args.providerSeenEpoch.slice(0, 64) }
        : {}),
      ...(args.sessionKey !== undefined ? { sessionKey: args.sessionKey.slice(0, 512) } : {}),
      ...(args.runId !== undefined ? { runId: args.runId.slice(0, 512) } : {}),
      ...(typeof args.seq === "number" && Number.isFinite(args.seq) ? { seq: args.seq } : {}),
      ...(typeof args.providerCreatedAt === "number" && Number.isFinite(args.providerCreatedAt)
        ? { providerCreatedAt: args.providerCreatedAt }
        : {}),
      ...(questions !== null ? { questions } : {}),
      ...(secretQuestions !== null ? { questions: secretQuestions } : {}),
      ...(approval !== null ? { approval } : {}),
      ...(kind === "credential"
        ? { credential: boundCredential(args.credential, args.source) }
        : {}),
      status: "pending",
      createdAt: now,
      expiresAt: boundedDeadline(now, args.expiresAt),
      updatedAt: now,
    });
    await notifyUser(ctx, {
      userId: chat.userId,
      kind: "agent_request",
      title: "Un agent attend votre réponse",
      body: chat.title ?? "",
      messageKey: `notif_agent_request_${kind}`,
      params: { chat: chat.title ?? "" },
      href: `/chat/${String(args.chatId)}`,
      dedupeKey: `agent_request:${String(id)}`,
    });
    await trace(ctx, args.chatId, {
      phase: "requested",
      source: args.source,
      anchored: messageId !== undefined,
    });
    return { id, created: true };
  },
});

/**
 * The provider settled a request — answered here or elsewhere, expired, cancelled.
 * Never reopens a settled row, and never overwrites the outcome Atrium itself
 * recorded for its own answer.
 */
export const settleFromBridge = internalMutation({
  args: {
    chatId: v.id("chats"),
    boundInstanceName: v.string(),
    providerRequestId: v.string(),
    /** The generation settled; absent = the newest row of this id. */
    providerCreatedAt: v.optional(v.number()),
    /** A question and an approval may share an id: the family settled. */
    family: v.optional(v.union(v.literal("question"), v.literal("approval"))),
    /** The question set settled (`questionShape`): picks the generation when two share a
     *  creation time (a reused id under a clock that stood still). */
    questionShape: v.optional(v.string()),
    /** When the settled request was seen (`providerSeenSeq`): among generations alike in
     *  creation time and shape, the newest one seen by then. */
    providerSeenSeq: v.optional(v.number()),
    status: terminalStatusValidator,
    answers: v.optional(v.array(agentRequestAnswerValidator)),
    /** The provider sent answers the ingest could not read whole (never cut). */
    answersUnreadable: v.optional(v.boolean()),
    decision: v.optional(approvalDecisionValidator),
  },
  handler: async (ctx, args): Promise<{ settled: boolean }> => {
    if (!(await chatAllowsInstance(ctx, args.chatId, args.boundInstanceName))) {
      throw new Error("forbidden: cross-instance agent request target");
    }
    // The row of THIS generation (see upsertFromBridge): a late settle of an older
    // request must never close a newer one under the same id (codex P1). Without a
    // generation, the newest row.
    const generations = await ctx.db
      .query("agentRequests")
      .withIndex("by_chat_instance_provider_request", (q) =>
        q
          .eq("chatId", args.chatId)
          .eq("instanceName", args.boundInstanceName)
          .eq("providerRequestId", args.providerRequestId),
      )
      .order("desc")
      .take(MAX_GENERATIONS_READ);
    const sameFamily =
      args.family === undefined ? generations : generations.filter((g) => familyOf(g.source) === args.family);
    const sameTime =
      args.providerCreatedAt === undefined
        ? sameFamily.slice(0, 1)
        : sameFamily.filter(
            (g) => g.providerCreatedAt === undefined || g.providerCreatedAt === args.providerCreatedAt,
          );
    // Two generations sharing one creation time (another question under a reused id, a
    // clock that stood still) are told apart by WHAT they asked: a late settle of the first
    // must not close the second, still awaited (codex P2, 0.21.5 pass 21).
    const sameShape =
      sameTime.length > 1 && args.questionShape !== undefined
        ? sameTime.filter((g) => questionShape(g.questions) === args.questionShape)
        : sameTime;
    // …and generations alike in both (a reused id, a frozen clock, the same question) by
    // WHEN each was seen: the settle is about the newest one seen by its own sighting, never
    // one raised after it (codex P2, 0.21.5 pass 22). One candidate is never filtered out:
    // two bridge clocks may disagree, and a lost settle would leave the card open.
    const seenSeq = args.providerSeenSeq;
    const row =
      sameShape.length > 1 && seenSeq !== undefined
        ? (sameShape.find((g) => g.providerSeenSeq === undefined || g.providerSeenSeq <= seenSeq) ?? null)
        : (sameShape[0] ?? null);
    if (row === null || !isOpenStatus(row.status)) return { settled: false };
    const now = Date.now();
    // Ours in flight: the gateway's broadcast of OUR answer can beat the action's
    // own settle. It is still our answer, not someone else's.
    const ours = row.status === "submitting";
    // …and a turn that ENDED while our answer was on the wire says "cancelled" about
    // a prompt the person has just answered. The action knows what the gateway
    // replied; it settles the row, not this.
    if (ours && (args.status === "expired" || args.status === "cancelled")) {
      return { settled: false };
    }
    const patch: Partial<Doc<"agentRequests">> = {
      status: args.status,
      updatedAt: now,
      resolvedAt: now,
    };
    // What the gateway recorded, NEVER cut: a truncated copy both misstates the answer and
    // can match ours by its prefix (codex P2). Past the bounds Atrium's own answers obey, it
    // cannot be ours — and, not storable as given, it is not stored at all.
    // …nor filtered: an answer to a question this request does not ask cannot be ours
    // either (codex P2), and an unreadable one says nothing we may store.
    const askedIds = new Set((row.questions ?? []).map((q) => q.id));
    const observedRaw =
      args.answers !== undefined && row.questions !== undefined ? args.answers : undefined;
    const observedWithinBounds =
      args.answersUnreadable !== true &&
      (observedRaw === undefined ||
        observedRaw.every(
          (a) =>
            askedIds.has(a.id) &&
            a.values.length <= MAX_ANSWER_VALUES &&
            a.values.every((v) => v.length <= MAX_ANSWER_CHARS),
        ));
    const observedAnswers =
      observedRaw !== undefined && observedWithinBounds
        ? storableAnswers(row.questions!, observedRaw)
        : undefined;
    // In flight is not proof of ours: another client can win the race, and the
    // broadcast then carries THEIR answer. What the gateway recorded decides — a
    // different verdict is someone else's, whatever we had proposed (codex P2).
    const theirs =
      ours &&
      ((args.decision !== undefined &&
        (row.decision === undefined || sameGatewayDecision(args.decision, row.decision) === false)) ||
        !observedWithinBounds ||
        (observedAnswers !== undefined && !sameAnswers(observedAnswers, row.answers)));
    const elsewhere = !ours || theirs;
    if (elsewhere && (args.status === "answered" || args.status === "allowed" || args.status === "denied")) {
      patch.resolvedElsewhere = true;
      if (theirs) patch.resolvedByUserId = undefined;
      if (observedAnswers !== undefined) patch.answers = observedAnswers;
      // Someone else's answer we cannot store as given: ours must not stand in for it.
      else if (theirs) patch.answers = undefined;
      if (args.decision !== undefined) patch.decision = args.decision;
    }
    await ctx.db.patch(row._id, patch);
    await clearNotification(ctx, row);
    await trace(ctx, args.chatId, {
      phase: "settled",
      source: row.source,
      status: args.status,
      elsewhere,
      waitedMs: now - row.createdAt,
    });
    return { settled: true };
  },
});

// ── Person → gateway ───────────────────────────────────────────────────────────

type Answer = { id: string; values: string[] };

type PreparedAnswer = {
  requestId: Id<"agentRequests">;
  bridgeUrl: string | null;
  status: AgentRequestStatus;
  body: Record<string, unknown>;
};

/**
 * Access, freshness and answer rules, then `pending → submitting`. The ACTION holds
 * the secret; this mutation never sees one.
 */
export const prepareAnswer = internalMutation({
  args: {
    requestId: v.id("agentRequests"),
    answers: v.optional(v.array(agentRequestAnswerValidator)),
    decision: v.optional(approvalDecisionValidator),
    skip: v.optional(v.boolean()),
    /** True when the action carries a credential value (never the value itself). */
    hasSecret: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<PreparedAnswer | { refused: string }> => {
    const { userId, impersonating } = await requireActive(ctx);
    const row = await ctx.db.get(args.requestId);
    if (row === null) throw new Error("AGENT_REQUEST_NOT_FOUND");
    const { chat, role } = await requireReachableChat(ctx, userId, row.chatId);
    // A participant may answer a QUESTION — that is conversation. An approval or a
    // credential acts with the owner's authority on the owner's gateway session.
    if (row.kind !== "question" && role !== "owner") {
      throw new Error("AGENT_REQUEST_OWNER_ONLY");
    }
    // An administrator looking through a person's account may talk in their place
    // (the send path allows it), but never authorise a command or hand over a
    // credential for them.
    if (row.kind !== "question" && impersonating) {
      throw new Error("AGENT_REQUEST_IMPERSONATING");
    }
    if (row.status !== "pending") throw new Error("AGENT_REQUEST_NOT_PENDING");
    // A request whose turn was deleted is not one to answer from here.
    if (row.messageId !== undefined && (await ctx.db.get(row.messageId)) === null) {
      throw new Error("AGENT_REQUEST_NOT_PENDING");
    }
    const now = Date.now();
    if (row.expiresAt <= now) {
      // RETURNED, not thrown: a throw would roll this settle back with it, and the
      // row would keep offering an answer the agent can no longer receive.
      await ctx.db.patch(row._id, { status: "expired", updatedAt: now, resolvedAt: now });
      await clearNotification(ctx, row);
      return { refused: "AGENT_REQUEST_EXPIRED" };
    }

    let terminal: AgentRequestStatus;
    let answers: Answer[] | undefined;
    let decision: ApprovalDecision | undefined;
    const skip = args.skip === true;
    if (row.kind === "approval") {
      if (args.decision === undefined) throw new Error("AGENT_REQUEST_DECISION_REQUIRED");
      if (!(row.approval?.decisions ?? ["deny"]).includes(args.decision)) {
        throw new Error("AGENT_REQUEST_DECISION_NOT_OFFERED");
      }
      // HERMES ANSWERS BY SESSION, OLDEST FIRST (`approval.respond` resolves the head
      // of the session's queue). Answering a later one would decide the earlier one.
      // …unless it is addressed by its OWN id (a server→client request, Hermes 0.21.3+):
      // then exactly that one is decided, and no order binds the person.
      if (row.source === "hermes.approval" && row.answerById !== true) {
        // `submitting` counts as much as `pending`: an earlier answer still on the wire
        // has not reached the head yet, and two POSTs are not ordered — B's could land
        // first and decide A (codex P1). One exact range per status, on this session's
        // Hermes approvals only: nothing else in the chat can push the earlier one out.
        // Ingest refuses a Hermes approval without both; a row that still lacks one
        // (hand-written, restored) is not placed in the queue by guessing.
        if (row.seq === undefined || row.sessionKey === undefined) {
          throw new Error("AGENT_REQUEST_ANSWER_OLDEST_FIRST");
        }
        const mySeq = row.seq;
        for (const status of ["pending", "submitting"] as const) {
          const earlier = await ctx.db
            .query("agentRequests")
            // Per INSTANCE: two Hermes gateways are two queues, whatever their
            // session ids (codex P2).
            .withIndex("by_chat_instance_source_session_status_seq", (q) =>
              q
                .eq("chatId", row.chatId)
                .eq("instanceName", row.instanceName)
                .eq("source", "hermes.approval")
                .eq("sessionKey", row.sessionKey)
                .eq("status", status)
                .lt("seq", mySeq),
            )
            .first();
          if (earlier !== null && earlier._id !== row._id) {
            throw new Error("AGENT_REQUEST_ANSWER_OLDEST_FIRST");
          }
        }
      }
      decision = args.decision;
      terminal = statusForDecision(args.decision);
    } else if (row.kind === "credential" && row.questions === undefined) {
      if (skip) terminal = "cancelled";
      else if (row.credential?.clipped === true || row.credential?.commandMissing === true) {
        // What the password unlocks could not be shown whole — or at all: only "don't
        // provide" stands (codex P1 ×2).
        throw new Error("AGENT_REQUEST_CLIPPED");
      } else {
        if (args.hasSecret !== true) throw new Error("AGENT_REQUEST_SECRET_REQUIRED");
        terminal = "answered";
      }
    } else {
      const questions = row.questions ?? [];
      // Fail closed, skip or not: a secret answer reaching this mutation as anything but
      // the placeholder means a value crossed the boundary it must not cross — and a
      // placeholder under an ordinary question is not an answer.
      for (const given of args.answers ?? []) {
        const q = questions.find((x) => x.id === given.id);
        const placeholder = given.values.length === 1 && given.values[0] === SECRET_ANSWER_PLACEHOLDER;
        if (q?.secret === true ? !placeholder : given.values.includes(SECRET_ANSWER_PLACEHOLDER)) {
          throw new Error("AGENT_REQUEST_SECRET_NOT_WITHHELD");
        }
      }
      if (skip) {
        terminal = "cancelled";
      } else {
        const checked = validateAnswers(questions, args.answers ?? []);
        if (!checked.ok) {
          throw new Error(`AGENT_REQUEST_INVALID_ANSWER:${checked.refusal.code}:${checked.refusal.questionId}`);
        }
        answers = checked.answers;
        terminal = "answered";
      }
    }

    const instance = await ctx.db
      .query("instances")
      .withIndex("by_name", (q) => q.eq("name", row.instanceName))
      .first();
    const someInstances = await ctx.db.query("instances").take(2);
    const bridgeUrl = resolveBridgeUrlForDispatch(instance, {
      instanceName: row.instanceName,
      served: process.env.BRIDGE_INSTANCE_NAME ?? null,
      isSole: someInstances.length <= 1,
    });
    const res = await resolveTargetForChat(ctx, chat, chat.userId);
    const canonical = res.target?.canonical;
    const gatewayUser =
      canonical !== undefined
        ? await resolveGatewayUser(ctx, {
            instanceName: row.instanceName,
            ownerUserId: chat.userId,
            canonical,
            instance,
          })
        : undefined;

    await ctx.db.patch(row._id, {
      status: "submitting",
      updatedAt: now,
      resolvedByUserId: userId,
      ...(answers !== undefined
        ? { answers: storableAnswers(row.questions ?? [], answers) }
        : {}),
      ...(decision !== undefined ? { decision } : {}),
      failureCode: undefined,
    });
    return {
      requestId: row._id,
      bridgeUrl: bridgeUrl ?? null,
      status: terminal,
      body: {
        chatId: String(row.chatId),
        instanceName: row.instanceName,
        agentId: row.agentId ?? res.target?.agentId ?? null,
        ...(canonical !== undefined ? { canonical } : {}),
        ...(gatewayUser !== undefined ? { gatewayUser } : {}),
        openclawChatId: chat.openclawChatId ?? null,
        provider: providerForSource(row.source),
        source: row.source,
        providerRequestId: row.providerRequestId,
        // The GENERATION answered: the bridge re-checks it against the gateway's own
        // record, so a card left open cannot answer a newer request under the same id.
        ...(row.providerCreatedAt !== undefined ? { providerCreatedAt: row.providerCreatedAt } : {}),
        ...(row.approvalKind !== undefined ? { approvalKind: row.approvalKind } : {}),
        ...(row.sessionKey !== undefined ? { sessionKey: row.sessionKey } : {}),
        ...(row.answerById === true ? { answerById: true } : {}),
        // The question the card SHOWS, for the bridge to check against the one still asked.
        ...(row.source.startsWith("openclaw.") && row.questions !== undefined
          ? { questionShape: questionShape(row.questions) }
          : {}),
        ...(skip ? { skip: true } : {}),
        ...(answers !== undefined ? { answers } : {}),
        ...(decision !== undefined ? { decision } : {}),
      },
    };
  },
});

/** Which questions of a request are secret — ids only, for the action to withhold
 *  their answers from every mutation. */
export const answerShapeOf = internalQuery({
  args: { requestId: v.id("agentRequests") },
  handler: async (ctx, { requestId }): Promise<{ questionIds: string[]; secretIds: string[] }> => {
    const row = await ctx.db.get(requestId);
    const questions = row?.questions ?? [];
    return {
      questionIds: questions.map((q) => q.id),
      secretIds: questions.filter((q) => q.secret).map((q) => q.id),
    };
  },
});

/** The gateway took the answer (or said the request is gone). */
export const completeAnswer = internalMutation({
  args: {
    requestId: v.id("agentRequests"),
    status: terminalStatusValidator,
    /** The gateway reported the request already settled by someone else. */
    elsewhere: v.optional(v.boolean()),
  },
  handler: async (ctx, { requestId, status, elsewhere }) => {
    const row = await ctx.db.get(requestId);
    if (row === null) return null;
    // A broadcast may have settled it first — keep that verdict. But not its AUTHOR:
    // the broadcast names none, so an identical answer from another client was taken
    // for ours; the gateway now says ours never applied (it was already settled), and
    // that is the only proof there is (codex P2).
    if (!isOpenStatus(row.status)) {
      if (elsewhere === true && row.resolvedElsewhere !== true) {
        await ctx.db.patch(requestId, { resolvedElsewhere: true, resolvedByUserId: undefined });
      }
      return null;
    }
    const now = Date.now();
    await ctx.db.patch(requestId, {
      status,
      updatedAt: now,
      resolvedAt: now,
      ...(elsewhere === true
        ? { resolvedElsewhere: true, resolvedByUserId: undefined, answers: undefined, decision: undefined }
        : {}),
    });
    await clearNotification(ctx, row);
    await trace(ctx, row.chatId, {
      phase: "answered",
      source: row.source,
      status,
      elsewhere: elsewhere === true,
      waitedMs: now - row.createdAt,
    });
    return null;
  },
});

/** The answer did not get through: back to `pending`, with the reason, so the person
 *  can try again while the agent still waits. */
export const revertAnswer = internalMutation({
  args: { requestId: v.id("agentRequests"), failureCode: v.string() },
  handler: async (ctx, { requestId, failureCode }) => {
    const row = await ctx.db.get(requestId);
    if (row === null || row.status !== "submitting") return null;
    const now = Date.now();
    const expired = row.expiresAt <= now;
    await ctx.db.patch(requestId, {
      status: expired ? "expired" : "pending",
      updatedAt: now,
      ...(expired ? { resolvedAt: now } : {}),
      failureCode: failureCode.slice(0, 64),
      resolvedByUserId: undefined,
      answers: undefined,
      decision: undefined,
    });
    if (expired) await clearNotification(ctx, row);
    await trace(ctx, row.chatId, { phase: "answer_failed", source: row.source, code: failureCode.slice(0, 64) });
    return null;
  },
});

/** Bridge verdict codes that mean "this request no longer waits". */
const GONE_STATUS: Record<string, "expired" | "cancelled" | "answered" | "allowed" | "denied"> = {
  expired: "expired",
  cancelled: "cancelled",
  answered: "answered",
  allowed: "allowed",
  denied: "denied",
};

/**
 * PUBLIC: answer an agent's request. `answers` for a question, `decision` for an
 * approval, `secret` for a credential (NEVER stored — it goes to the bridge and is
 * dropped), `skip` to let the agent carry on without an answer.
 */
export const answer = action({
  args: {
    requestId: v.id("agentRequests"),
    answers: v.optional(v.array(agentRequestAnswerValidator)),
    decision: v.optional(approvalDecisionValidator),
    secret: v.optional(v.string()),
    skip: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ ok: true; status: AgentRequestStatus } | { ok: false; reason: string }> => {
    if (args.secret !== undefined && args.secret.length > MAX_ANSWER_CHARS) {
      return { ok: false, reason: "too_long" };
    }
    // Secret answers stay HERE: the mutation sees a placeholder, and the value goes
    // straight from this action to the bridge (codex P1).
    // A skip answers nothing: no answer — secret or not — rides into the mutation with it
    // (codex P1, it used to bypass the withholding below).
    let answers = args.skip === true ? undefined : args.answers;
    let held = new Map<string, string[]>();
    if (answers !== undefined) {
      const shape = await ctx.runQuery(internal.agentRequests.answerShapeOf, {
        requestId: args.requestId,
      });
      // An answer to a question this request does not ask never reaches a mutation: on a
      // credential (no questions at all) it is exactly where a secret could ride past the
      // withholding below (codex P2).
      const unknown = answers.find((a) => !shape.questionIds.includes(a.id));
      if (unknown !== undefined) {
        return { ok: false, reason: `AGENT_REQUEST_INVALID_ANSWER:unknown_question:${unknown.id}` };
      }
      const secretIds = new Set(shape.secretIds);
      const out = withholdSecretAnswers(secretIds, answers);
      if (!out.ok) {
        return {
          ok: false,
          reason: `AGENT_REQUEST_INVALID_ANSWER:${out.refusal.code}:${out.refusal.questionId}`,
        };
      }
      answers = out.forMutation;
      held = out.held;
    }
    let prep: PreparedAnswer | { refused: string };
    try {
      prep = await ctx.runMutation(internal.agentRequests.prepareAnswer, {
        requestId: args.requestId,
        answers,
        decision: args.decision,
        skip: args.skip,
        hasSecret: args.secret !== undefined && args.secret.length > 0,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = /AGENT_REQUEST_[A-Z_]+(?::[a-z_]+:[a-z0-9_]+)?/.exec(msg)?.[0];
      return { ok: false, reason: code ?? "refused" };
    }
    if ("refused" in prep) return { ok: false, reason: prep.refused };
    const sharedSecret = process.env.BRIDGE_SHARED_SECRET;
    if (prep.bridgeUrl === null || !sharedSecret) {
      await ctx.runMutation(internal.agentRequests.revertAnswer, {
        requestId: prep.requestId,
        failureCode: "not_configured",
      });
      return { ok: false, reason: "not_configured" };
    }
    try {
      const res = await fetch(`${prep.bridgeUrl.replace(/\/$/, "")}/agent-request/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: sharedSecret },
        signal: AbortSignal.timeout(ANSWER_POST_TIMEOUT_MS),
        body: JSON.stringify({
          ...prep.body,
          ...(Array.isArray(prep.body.answers) && held.size > 0
            ? {
                answers: (prep.body.answers as Answer[]).map((a) =>
                  held.has(a.id) ? { id: a.id, values: held.get(a.id)! } : a,
                ),
              }
            : {}),
          ...(args.secret !== undefined && args.skip !== true ? { secret: args.secret } : {}),
        }),
      });
      let payload: { ok?: unknown; error?: { code?: unknown; status?: unknown } } = {};
      try {
        payload = (await res.json()) as typeof payload;
      } catch {
        /* a non-JSON body is read through its status below */
      }
      if (res.ok && payload.ok === true) {
        await ctx.runMutation(internal.agentRequests.completeAnswer, {
          requestId: prep.requestId,
          status: prep.status as "answered" | "allowed" | "denied" | "cancelled",
        });
        return { ok: true, status: prep.status };
      }
      const code = typeof payload.error?.code === "string" ? payload.error.code : `http_${res.status}`;
      const goneStatus =
        code === "request_gone" && typeof payload.error?.status === "string"
          ? GONE_STATUS[payload.error.status]
          : undefined;
      if (code === "request_gone") {
        await ctx.runMutation(internal.agentRequests.completeAnswer, {
          requestId: prep.requestId,
          status: goneStatus ?? "expired",
          elsewhere: goneStatus === "answered" || goneStatus === "allowed" || goneStatus === "denied",
        });
        return { ok: false, reason: "request_gone" };
      }
      await ctx.runMutation(internal.agentRequests.revertAnswer, {
        requestId: prep.requestId,
        failureCode: code,
      });
      return { ok: false, reason: code };
    } catch {
      await ctx.runMutation(internal.agentRequests.revertAnswer, {
        requestId: prep.requestId,
        failureCode: "unreachable",
      });
      return { ok: false, reason: "unreachable" };
    }
  },
});

// ── Reads ──────────────────────────────────────────────────────────────────────

/** A conversation's requests, newest first — the thread cards, the dock and the
 *  "Demandes" panel all read this one list. */
export const listForChat = query({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }) => {
    const { userId } = await requireActive(ctx);
    const { role } = await requireReachableChat(ctx, userId, chatId);
    const recent = await ctx.db
      .query("agentRequests")
      .withIndex("by_chat_and_created", (q) => q.eq("chatId", chatId))
      .order("desc")
      .take(LIST_LIMIT);
    // Every request still OPEN, whatever the page: the history is bounded, what waits
    // is not — the head of a Hermes queue pushed out of the recent page could never be
    // answered, and every later one would be refused behind it (codex P2).
    const open = [
      ...(await ctx.db
        .query("agentRequests")
        .withIndex("by_chat_and_status", (q) => q.eq("chatId", chatId).eq("status", "pending"))
        .take(OPEN_LIST_LIMIT)),
      ...(await ctx.db
        .query("agentRequests")
        .withIndex("by_chat_and_status", (q) => q.eq("chatId", chatId).eq("status", "submitting"))
        .take(OPEN_LIST_LIMIT)),
    ];
    const seen = new Set(recent.map((r) => r._id));
    const rows = [...recent, ...open.filter((r) => !seen.has(r._id))];
    // The queue a Hermes approval waits in — its gateway AND its session, since two
    // instances may share a session id (codex P2) — as an OPAQUE label, meaningful only
    // within this answer: the session key is a gateway routing handle, not the
    // client's to hold (codex P2).
    const queues = new Map<string, string>();
    const queueKeyOf = (r: Doc<"agentRequests">): string | null => {
      if (r.sessionKey === undefined) return null;
      const key = `${r.instanceName}\u0000${r.sessionKey}`;
      let label = queues.get(key);
      if (label === undefined) {
        label = `q${queues.size + 1}`;
        queues.set(key, label);
      }
      return label;
    };
    return rows.map((r) => ({
      _id: r._id,
      messageId: r.messageId ?? null,
      source: r.source,
      kind: r.kind,
      agentId: r.agentId ?? null,
      status: r.status,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      resolvedAt: r.resolvedAt ?? null,
      resolvedElsewhere: r.resolvedElsewhere === true,
      answeredByMe: r.resolvedByUserId === userId,
      seq: r.seq ?? null,
      queueKey: queueKeyOf(r),
      answerById: r.answerById === true,
      questions: r.questions ?? null,
      approval: r.approval ?? null,
      credential: r.credential ?? null,
      answers: r.answers ?? null,
      decision: r.decision ?? null,
      failureCode: r.failureCode ?? null,
      /** Whether THIS reader may answer (a participant answers questions only). */
      canAnswer: r.kind === "question" || role === "owner",
    }));
  },
});

/** Which of my conversations have an agent waiting on me — the sidebar badge. */
export const pendingByChat = query({
  args: {},
  handler: async (ctx) => {
    const { userId } = await requireActive(ctx);
    const pending = await ctx.db
      .query("agentRequests")
      .withIndex("by_user_and_status", (q) => q.eq("userId", userId).eq("status", "pending"))
      .take(200);
    const now = Date.now();
    const byChat = new Map<string, { chatId: Id<"chats">; count: number; kinds: string[]; soonestExpiry: number }>();
    for (const r of pending) {
      if (r.expiresAt <= now) continue;
      const key = String(r.chatId);
      const cur = byChat.get(key) ?? { chatId: r.chatId, count: 0, kinds: [], soonestExpiry: r.expiresAt };
      cur.count += 1;
      if (!cur.kinds.includes(r.kind)) cur.kinds.push(r.kind);
      cur.soonestExpiry = Math.min(cur.soonestExpiry, r.expiresAt);
      byChat.set(key, cur);
    }
    return [...byChat.values()];
  },
});

// ── Sweeps ─────────────────────────────────────────────────────────────────────

/**
 * Settle what nothing else will: an open request past its deadline (the provider's
 * own expiry normally arrives first — this is the net for a restarted bridge), and
 * a `submitting` row whose action was lost.
 */
export const reapExpired = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ expired: number; unstuck: number }> => {
    const now = Date.now();
    let expired = 0;
    let unstuck = 0;
    for (const status of ["pending", "submitting"] as const) {
      const rows = await ctx.db
        .query("agentRequests")
        .withIndex("by_status_and_expires", (q) =>
          q.eq("status", status).lt("expiresAt", now - EXPIRY_SWEEP_GRACE_MS),
        )
        .take(100);
      for (const row of rows) {
        await ctx.db.patch(row._id, { status: "expired", updatedAt: now, resolvedAt: now });
        await clearNotification(ctx, row);
        await trace(ctx, row.chatId, { phase: "swept", source: row.source });
        expired += 1;
      }
    }
    const stuck = await ctx.db
      .query("agentRequests")
      .withIndex("by_status_and_expires", (q) => q.eq("status", "submitting").gte("expiresAt", now))
      .take(100);
    for (const row of stuck) {
      if (now - row.updatedAt < SUBMIT_STALL_MS) continue;
      await ctx.db.patch(row._id, {
        status: "pending",
        updatedAt: now,
        failureCode: "stalled",
        resolvedByUserId: undefined,
        answers: undefined,
        decision: undefined,
      });
      unstuck += 1;
    }
    return { expired, unstuck };
  },
});

/** Delete a chat's requests (chat deletion cascade). */
export async function deleteChatAgentRequests(
  ctx: MutationCtx,
  chatId: Id<"chats">,
): Promise<void> {
  const rows = await ctx.db
    .query("agentRequests")
    .withIndex("by_chat_and_created", (q) => q.eq("chatId", chatId))
    .take(CASCADE_BATCH);
  for (const r of rows) {
    await deleteNotification(ctx, r);
    await ctx.db.delete(r._id);
  }
  // One transaction has read/write limits: the rest goes in its own (codex P2).
  if (rows.length === CASCADE_BATCH) {
    await ctx.scheduler.runAfter(0, internal.agentRequests.deleteAgentRequestsStep, { chatId });
  }
}

/** A provider id's family: questions (and credentials) vs approvals — the two may
 *  carry the same id, and are never the same request (codex P2). */
function familyOf(source: string): "question" | "approval" {
  return kindForSource(source as Parameters<typeof kindForSource>[0]) === "approval" ? "approval" : "question";
}

/** Two decisions the gateway records identically: OpenClaw has no session scope, so
 *  Atrium's `allow-session` is sent — and recorded — as `allow-once`. */
function sameGatewayDecision(a: ApprovalDecision, b: ApprovalDecision): boolean {
  const norm = (d: ApprovalDecision) => (d === "allow-session" ? "allow-once" : d);
  return norm(a) === norm(b);
}

/** The same stored answers (order of questions and of values ignored). */
function sameAnswers(a: Answer[], b: Answer[] | undefined): boolean {
  if (b === undefined) return false;
  const key = (xs: Answer[]) =>
    JSON.stringify([...xs].map((x) => [x.id, [...x.values].sort()]).sort((p, q) => String(p[0]).localeCompare(String(q[0]))));
  return key(a) === key(b);
}

/** Rows deleted per transaction by the cascades; the rest is a scheduled step. */
const CASCADE_BATCH = 200;

/** A cascade's continuation: the next page of a chat's, or a message's, requests. */
export const deleteAgentRequestsStep = internalMutation({
  args: { chatId: v.optional(v.id("chats")), messageId: v.optional(v.id("messages")) },
  handler: async (ctx, args) => {
    if (args.chatId !== undefined) await deleteChatAgentRequests(ctx, args.chatId);
    if (args.messageId !== undefined) await deleteMessageAgentRequests(ctx, [args.messageId]);
  },
});

/** Delete the requests anchored to messages being removed (truncation). */
export async function deleteMessageAgentRequests(
  ctx: MutationCtx,
  messageIds: ReadonlyArray<Id<"messages">>,
): Promise<void> {
  for (const messageId of messageIds) {
    // EVERY row of the message: a page here, the rest in scheduled steps — one
    // transaction cannot hold an unbounded delete (codex P2). A request whose message
    // is gone is refused by prepareAnswer meanwhile.
    const rows = await ctx.db
      .query("agentRequests")
      .withIndex("by_message", (q) => q.eq("messageId", messageId))
      .take(CASCADE_BATCH);
    for (const r of rows) {
    await deleteNotification(ctx, r);
    await ctx.db.delete(r._id);
  }
    if (rows.length === CASCADE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.agentRequests.deleteAgentRequestsStep, { messageId });
    }
  }
}
