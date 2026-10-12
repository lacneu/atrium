/// <reference types="vite/client" />
//
// NEVER-ON INVARIANCE (codex phase 4 pass 10): a conversation whose instance never ran the
// transcript projection `on` — off, or shadow with a read cursor — must cost EXACTLY what
// it cost before phase 4, on every deletion path and on the send → stream → finalize path:
// the same index ranges, documents read, documents written and functions scheduled, and
// no projection-only table touched.
//
// The expectations are MEASURED, not chosen: `fixtures/projection-invariance-baseline.json`
// was produced by running THIS file against the 0.95.0 tree (HEAD before phase 4) with
// PROJECTION_INVARIANCE_RECORD=<path>, then RE-MEASURED on the 0.96.0 tree (`git archive
// v0.96.0`) once phase 5 added its paths — the delivery runs' merge, the sub-agent
// observations, the message list (every older entry came out identical). Each path below is
// replayed here and its counts must be identical. Neutralizing the gate
// (lib/transcriptProjection `transcriptStoredText`) turns it red.

import { readFileSync, writeFileSync } from "node:fs";
import { convexTest, type TestConvex } from "convex-test";
// The tracker every transaction of convex-test charges (deep import: no package exports).
import { TransactionMetricsTracker } from "convex-test/dist/transactionMetrics.js";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { cascadeDeleteChat } from "./chats";
import { deleteTurnCardCascade } from "./turnRetry";
import { maybeReparkPreemptedTurn } from "./preemptRepark";

const modules = import.meta.glob("./**/*.ts");
type T = TestConvex<typeof schema>;
type Mode = "off" | "shadow";
type Counts = {
  ranges: number;
  reads: number;
  writes: number;
  scheduled: number;
  /** codex phase 4 pass 14: the BYTES too — a field added to a document never `on` writes
   *  and reads more without changing a count. */
  bytesRead: number;
  bytesWritten: number;
};

const counts: Counts = { ranges: 0, reads: 0, writes: 0, scheduled: 0, bytesRead: 0, bytesWritten: 0 };
const proto = TransactionMetricsTracker.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
for (const [method, key, bytes] of [
  ["trackIndexRange", "ranges", null],
  ["trackRead", "reads", "bytesRead"],
  ["trackWrite", "writes", "bytesWritten"],
  ["trackScheduledFunction", "scheduled", null],
] as const) {
  const original = proto[method]!;
  proto[method] = function (this: unknown, ...args: unknown[]) {
    counts[key]++;
    if (bytes !== null) counts[bytes] += typeof args[0] === "number" ? args[0] : 0;
    return original.apply(this, args);
  };
}
const reset = () => {
  counts.ranges = 0;
  counts.reads = 0;
  counts.writes = 0;
  counts.scheduled = 0;
  counts.bytesRead = 0;
  counts.bytesWritten = 0;
};
/** The counts of `fn` alone (setup excluded). */
async function measure(fn: () => Promise<unknown>): Promise<Counts> {
  reset();
  await fn();
  return { ...counts };
}

const SK = "agent:main:atrium:chat:u:c1";
const SK2 = "agent:main:atrium:chat:u:c1:other";
const TARGET = { instanceName: "prod", agentId: "main" };
const SEND_A = `webchat-${"a".repeat(64)}`;
const SEND_B = `webchat-${"b".repeat(64)}`;
const TURNS = 12;
// Phase 5: the delegation a delivery run belongs to.
const CHILD_KEY = "agent:files:subagent:0d59e951-cbaa-44f1-92e5-33b9729d096e";
const CHILD_RUN = "742ca132-060c-4cf8-8c0a-3f1377095ea3";
const TASK_ID = "bf66f802-e5a6-4394-9815-40c4bcd28dae";
const ANNOUNCE_RUN = `announce:v1:${CHILD_KEY}:${CHILD_RUN}`;
const SETTLE_RUN = `announce:requester-settle:main:${"agent:main:atrium:chat:u:c1"}:${CHILD_RUN}:yield-1`;
const TASK_RUN = `image_generate:${TASK_ID}:ok`;
const MERGES = 3;

let prevAnon: string | undefined;
beforeEach(() => {
  prevAnon = process.env.OPENCLAW_ENABLE_ANON_AUTH;
  process.env.OPENCLAW_ENABLE_ANON_AUTH = "1";
});
afterAll(() => {
  if (prevAnon === undefined) delete process.env.OPENCLAW_ENABLE_ANON_AUTH;
  else process.env.OPENCLAW_ENABLE_ANON_AUTH = prevAnon;
});

/** A conversation never `on`: TURNS user/assistant turns, MERGES merged runs each, and —
 *  in shadow — the read cursor and identity rows a shadow instance writes. */
async function world(
  t: T,
  mode: Mode,
  opts: {
    kind?: "summarizer";
    trashed?: boolean;
    stuck?: boolean;
    /** More instances in the same mode (the mode resolution reads them all). */
    instances?: number;
    /** The read cursor (in both modes), owned by this instance and read at this time. */
    cursor?: { instanceName: string; lastReadAt?: number };
    /** A session only LIVE applies wrote so far: no cursor, one row of this instance. */
    foreignRows?: { sessionKey: string; instanceName: string };
    /** Phase 5: a running sub-agent child and a running background task, both anchored
     *  (exactly) to the last answer — what a delivery run merges into. */
    delegation?: boolean;
  } = {},
) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const profileId = await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "u" });
    const adminUser = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId: adminUser, role: "admin" as const, canonical: "a" });
    await ctx.db.insert("userAgents", { userId, instanceName: "prod", agentId: "main", isDefault: true, source: "manual" as const, createdAt: 1 });
    await ctx.db.insert("instances", { name: "prod", gatewayUrl: "ws://gw", config: { transcriptProjection: mode } as never });
    for (let i = 0; i < (opts.instances ?? 0); i++) {
      await ctx.db.insert("instances", { name: `inst-${i}`, gatewayUrl: "ws://gw", config: { transcriptProjection: mode } as never });
    }
    const chatId = await ctx.db.insert("chats", {
      userId,
      updatedAt: 1,
      instanceName: "prod",
      agentId: "main",
      ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
      ...(opts.trashed === true ? { trashedAt: 1, purgeAfter: 2 } : {}),
    } as never);
    const messages: Array<Id<"messages">> = [];
    for (let i = 0; i < TURNS; i++) {
      const u = await ctx.db.insert("messages", { chatId, userId, role: "user" as const, status: "complete" as const, text: `q${i}`, sendId: `send${i}`, updatedAt: 1 });
      const a = await ctx.db.insert("messages", { chatId, userId, role: "assistant" as const, status: "complete" as const, text: `r${i}`, runId: `run${i}`, turnSessionKey: SK, boundInstance: "prod", updatedAt: 1 });
      messages.push(u, a);
      for (let m = 0; m < MERGES; m++) {
        await ctx.db.insert("runBubbles", { chatId, runId: `run${i}-m${m}`, messageId: a, createdAt: 1 });
      }
    }
    // A stuck turn: an old streaming bubble, an old pending send, an errored card to retry.
    let stuckId: Id<"messages"> | null = null;
    let erroredId: Id<"messages"> | null = null;
    if (opts.stuck === true) {
      const u = await ctx.db.insert("messages", { chatId, userId, role: "user" as const, status: "complete" as const, text: "q-stuck", sendId: "send-stuck", updatedAt: 1 });
      stuckId = await ctx.db.insert("messages", { chatId, userId, role: "assistant" as const, status: "streaming" as const, text: "", runId: "run-stuck", turnSessionKey: SK, boundInstance: "prod", updatedAt: 1 });
      await ctx.db.insert("outbox", { chatId, userId, clientMessageId: "stuck", messageId: u, text: "q-stuck", attachmentIds: [], status: "pending", pendingSince: 1, sentToInstance: "prod" } as never);
      const u2 = await ctx.db.insert("messages", { chatId, userId, role: "user" as const, status: "complete" as const, text: "q-err", sendId: "send-err", updatedAt: 1 });
      erroredId = await ctx.db.insert("messages", { chatId, userId, role: "assistant" as const, status: "error" as const, text: "", runId: "run-err", errorCode: "provider_internal", turnSessionKey: SK, boundInstance: "prod", updatedAt: 1 } as never);
      void u2;
    }
    if (mode === "shadow" || opts.cursor !== undefined) {
      await ctx.db.insert("transcriptCursors", {
        chatId,
        sessionKey: SK,
        instanceName: opts.cursor?.instanceName ?? "prod",
        ...(opts.cursor?.lastReadAt !== undefined ? { lastReadAt: opts.cursor.lastReadAt } : {}),
        sessionId: "s-1",
        floorSeq: 0,
        floorAt: 1,
        lastKind: "page",
        reads: 1,
        resets: 0,
        unidentified: 0,
        updatedAt: 1,
      } as never);
      for (let i = 0; i < TURNS; i++) {
        await ctx.db.insert("transcriptRows", { chatId, instanceName: "prod", sessionKey: SK, sessionId: "s-1", entryId: `a${i}`, seq: 2 + 2 * i, role: "assistant", runId: `run${i}`, hidden: false, visible: true, updatedAt: 1 });
      }
    }
    if (opts.delegation === true) {
      const anchor = messages[messages.length - 1]!;
      await ctx.db.insert("subAgents", { chatId, userId, instanceName: "prod", parentMessageId: anchor, anchorExact: true, childSessionKey: CHILD_KEY, childRunId: CHILD_RUN, kind: "subagent" as const, status: "running" as const, createdAt: 1, updatedAt: 1 });
      await ctx.db.insert("subAgents", { chatId, userId, instanceName: "prod", parentMessageId: anchor, anchorExact: true, childSessionKey: `task:${TASK_ID}`, kind: "task" as const, taskName: "image_generate", status: "running" as const, createdAt: 1, updatedAt: 1 });
    }
    if (opts.foreignRows !== undefined) {
      await ctx.db.insert("transcriptRows", { chatId, instanceName: opts.foreignRows.instanceName, sessionKey: opts.foreignRows.sessionKey, sessionId: "s-2", entryId: "f0", seq: 2, role: "assistant", runId: "runF", hidden: false, visible: true, updatedAt: 1 });
    }
    return { userId, profileId, adminUser, chatId, messages, stuckId, erroredId };
  });
}

const PATHS = [
  "deleteMessage",
  "dropIfEmpty",
  "turnRetryCascade",
  "preemptedResume",
  "sweepDeletedChat",
  "sweepHiddenChat",
  "trashPurgeChat",
  "adminPurgeChat",
  "deleteUser",
  "send",
  "startAssistant",
  "appendDelta",
  "finalize",
  "markOutboxSent",
  // codex phase 4 pass 11: the recurring paths
  "applyLiveRows",
  "applyDeltaEmpty",
  "applyDeltaRows",
  "applyDeltaUserRows",
  "applyDeltaGuardFacts",
  "reconcileChatStuckStreams",
  "reconcileStuckStreams",
  "sweepInstanceStreams",
  "drainNextQueued",
  "reconcileStalledOutbox",
  "autoRetryTurn",
  "followUpState",
  "resumeTarget",
  "markResumed",
  // codex phase 4 pass 12: every apply that exits early — it costs what it cost before
  "applyOwnedElsewhere",
  "applyOwnedElsewhereByRows",
  "applyBadSessionKey",
  "applyCrossInstance",
  "applyStaleRead",
  // codex phase 4 pass 14: the send identity changing on a message (bytes included)
  "ackKeyCorrection",
  "regenerationStamp",
  // codex phase 4 pass 23: the stale-rendition cron (a file job's timeout)
  "timeoutStaleRenditions",
  // phase 5 (delegation chains): every path a delivery run, a sub-agent observation or
  // the message list takes — measured on the 0.96.0 tree before any phase-5 code.
  "startAnnounceMerge",
  "startSettleMerge",
  "startTaskMerge",
  "startUnanchoredDelivery",
  "finalizeMergedAnnounce",
  "finalizeEmptyDelivery",
  "addPartMergedAnnounce",
  "upsertSubAgentNew",
  "upsertSubAgentUpdate",
  "upsertTaskEngagement",
  "listByChat",
  // codex phase 5 pass 2 #3: a report freezes the reported answer — never-on, one message
  "submitFeedback",
  // codex phase 5 pass 11: 0.96.0's retry of a merged settle batch (`batchAnswered`) —
  // answered in text (with 19 parts of 900 KiB it must never read: under the real limits),
  // answered nothing, answered only with a file whose blob is gone.
  "retryAnsweredBatch",
  "retryUnansweredBatch",
  "retryGoneBlobBatch",
  // codex phase 5 pass 11 audit: a report on a message older than the context scan (its
  // prompt found by the older walk) — the single-message path phase 5 touched.
  "submitFeedbackOlderThanScan",
  // codex phase 5 pass 12 #2: the bench's dev probe (assertDev: OPENCLAW_ENABLE_ANON_AUTH=1,
  // set by this harness) — one message read when the last bubble carries no display group,
  // even when the conversation's recent bubbles weigh more than a transaction may read.
  "peekSubAgents",
  "peekSubAgentsHeavy",
] as const;
type PathName = (typeof PATHS)[number];
const DELEGATION_PATHS = new Set<PathName>([
  "retryAnsweredBatch",
  "retryUnansweredBatch",
  "retryGoneBlobBatch",
  "startAnnounceMerge",
  "startSettleMerge",
  "startTaskMerge",
  "startUnanchoredDelivery",
  "finalizeMergedAnnounce",
  "finalizeEmptyDelivery",
  "addPartMergedAnnounce",
  "upsertSubAgentNew",
  "upsertSubAgentUpdate",
  "upsertTaskEngagement",
  "listByChat",
  "peekSubAgents",
  "peekSubAgentsHeavy",
]);

async function run(path: PathName, mode: Mode): Promise<Counts> {
  vi.useFakeTimers();
  const c = await runPath(path, mode);
  vi.useRealTimers();
  return c;
}

/** Nothing of the projection's OWN (phase 4) was touched: no tombstone, no row text, no
 *  presence marker, no projection step scheduled. Only asked of this tree (the 0.95.0 tree
 *  the baseline was recorded on has none of these tables). */
async function assertUntouched(t: T) {
  const own = await t.run(async (ctx) => {
    const db = ctx.db as unknown as { query: (table: string) => { collect: () => Promise<unknown[]> } };
    return {
      tombstones: (await db.query("transcriptTombstones").collect()).length,
      texts: (await db.query("transcriptRowTexts").collect()).length,
      marked: (await ctx.db.query("chats").collect()).filter((c) => (c as { transcriptSeenAt?: number }).transcriptSeenAt !== undefined).length,
      steps: (await ctx.db.system.query("_scheduled_functions").collect()).filter((f) =>
        /transcriptProjection:(purge|followUp|continue|store|tombstone)|displayGroups:/.test(f.name),
      ).length,
      // Phase 5: no launch fact, no display group, no own delivery bubble.
      spawns: (await db.query("transcriptSpawns").collect()).length,
    };
  });
  // Messages page by page: a path's conversation may weigh more than one transaction reads.
  let grouped = 0;
  let cursor: string | null = null;
  for (;;) {
    const page: { page: Doc<"messages">[]; isDone: boolean; continueCursor: string } = await t.run((ctx) =>
      ctx.db.query("messages").paginate({ numItems: 8, cursor }),
    );
    grouped += page.page.filter((m) => m.displayGroupId !== undefined || m.deliveryOwnBubble !== undefined).length;
    if (page.isDone) break;
    cursor = page.continueCursor;
  }
  expect({ ...own, grouped }).toEqual({ tombstones: 0, texts: 0, marked: 0, steps: 0, spawns: 0, grouped: 0 });
}

async function runPath(path: PathName, mode: Mode): Promise<Counts> {
  const t = convexTest({ schema, modules, transactionLimits: true });
  const w = await world(t, mode, {
    ...(["reconcileChatStuckStreams", "reconcileStuckStreams", "sweepInstanceStreams", "reconcileStalledOutbox", "autoRetryTurn", "resumeTarget", "markResumed", "drainNextQueued"].includes(path)
      ? { stuck: true }
      : {}),
    ...(path === "sweepHiddenChat" ? { kind: "summarizer" as const } : {}),
    ...(path === "trashPurgeChat" || path === "adminPurgeChat" ? { trashed: true } : {}),
    ...(path === "applyOwnedElsewhere" ? { instances: 63, cursor: { instanceName: "other" } } : {}),
    ...(path === "applyOwnedElsewhereByRows" ? { instances: 63, foreignRows: { sessionKey: SK2, instanceName: "other" } } : {}),
    ...(path === "applyStaleRead" ? { cursor: { instanceName: "prod", lastReadAt: 50 } } : {}),
    ...(DELEGATION_PATHS.has(path) ? { delegation: true } : {}),
  });
  const asUser = t.withIdentity({ subject: `${w.userId}|session` });
  const asAdmin = t.withIdentity({ subject: `${w.adminUser}|session` });
  const docOf = (id: Id<"messages">) => t.run((ctx) => ctx.db.get(id)) as Promise<Doc<"messages">>;
  const measured = await measurePath();
  if (RECORD === undefined) await assertUntouched(t);
  return measured;
  async function measurePath(): Promise<Counts> {
    switch (path) {
      case "deleteMessage":
        return await measure(() => asUser.mutation(api.messages.deleteMessage, { messageId: w.messages[0]! }));
      case "dropIfEmpty": {
        const id = (await t.mutation(internal.stream.startAssistant, { chatId: w.chatId, runId: "fresh", turnSessionKey: SK })) as Id<"messages">;
        return await measure(() => t.mutation(internal.stream.finalize, { messageId: id, status: "complete", dropIfEmpty: true } as never));
      }
      case "turnRetryCascade": {
        const card = await docOf(w.messages[w.messages.length - 1]!);
        const chat = (await t.run((ctx) => ctx.db.get(w.chatId)))!;
        return await measure(() =>
          t.run((ctx) => (deleteTurnCardCascade as (...a: unknown[]) => Promise<void>)(ctx, w.userId, w.chatId, card._id, { chat, card })),
        );
      }
      case "preemptedResume": {
        const card = await docOf(w.messages[w.messages.length - 1]!);
        return await measure(() => t.run((ctx) => maybeReparkPreemptedTurn(ctx, card, 0)));
      }
      case "sweepDeletedChat":
        return await measure(() => t.mutation(internal.chats.sweepDeletedChat, { chatId: w.chatId, ownerId: w.userId }));
      case "sweepHiddenChat":
        return await measure(() => t.mutation(internal.chatSummaries.sweepHiddenChat, { hiddenChatId: w.chatId }));
      case "trashPurgeChat":
        return await measure(() => asUser.mutation(api.trash.purgeChat, { chatId: w.chatId }));
      case "adminPurgeChat":
        return await measure(() => asAdmin.mutation(api.trash.adminPurgeChat, { chatId: w.chatId }));
      case "deleteUser":
        return await measure(() => asAdmin.mutation(api.admin.deleteUser, { profileId: w.profileId }));
      case "send":
        return await measure(() => asUser.mutation(api.send.sendMessage, { chatId: w.chatId, text: "encore", clientMessageId: "inv-1" }));
      case "startAssistant":
        return await measure(() => t.mutation(internal.stream.startAssistant, { chatId: w.chatId, runId: "fresh", turnSessionKey: SK }));
      case "appendDelta": {
        const id = (await t.mutation(internal.stream.startAssistant, { chatId: w.chatId, runId: "fresh", turnSessionKey: SK })) as Id<"messages">;
        return await measure(() => t.mutation(internal.stream.appendDelta, { messageId: id, text: "bonjour" } as never));
      }
      case "finalize": {
        const id = (await t.mutation(internal.stream.startAssistant, { chatId: w.chatId, runId: "fresh", turnSessionKey: SK })) as Id<"messages">;
        await t.mutation(internal.stream.appendDelta, { messageId: id, text: "bonjour" } as never);
        return await measure(() => t.mutation(internal.stream.finalize, { messageId: id, status: "complete", text: "bonjour" } as never));
      }
      case "applyOwnedElsewhere":
        return await measure(() => applyT(t, w.chatId, "delta", [assistantRow("x1", 100, "runX")]));
      case "applyOwnedElsewhereByRows":
        return await measure(() => applyT(t, w.chatId, "delta", [assistantRow("x1", 100, "runX")], { sessionKey: SK2 }));
      case "applyBadSessionKey":
        return await measure(() => applyT(t, w.chatId, "delta", [assistantRow("x1", 100, "runX")], { sessionKey: "" }));
      case "applyCrossInstance":
        return await measure(() =>
          applyT(t, w.chatId, "delta", [assistantRow("x1", 100, "runX")], { boundInstanceName: "intruder" }).catch(() => undefined),
        );
      case "applyStaleRead":
        return await measure(() => applyT(t, w.chatId, "delta", [assistantRow("x1", 100, "runX")]));
      case "timeoutStaleRenditions": {
        await t.run(async (ctx) => {
          const sourceStorageId = await ctx.storage.store(new Blob(["PPTX"]));
          const hidden = await ctx.db.insert("chats", {
            userId: w.userId,
            updatedAt: 1,
            kind: "converter",
            instanceName: "prod",
            agentId: "convbot",
          } as never);
          const renditionId = await ctx.db.insert("fileRenditions", {
            sourceStorageId,
            chatId: w.chatId,
            userId: w.userId,
            sourceFilename: "deck.pptx",
            sourceMimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            status: "pending",
            converterInstance: "prod",
            converterAgentId: "convbot",
            // Stale (past the 5-minute timeout) but within the projection's wait bound:
            // the path a projected job would defer on.
            createdAt: Date.now() - 6 * 60_000,
            updatedAt: 1,
          } as never);
          await ctx.db.patch(hidden, { pendingConvert: { renditionId, createdAt: Date.now() - 6 * 60_000 } } as never);
          await ctx.db.insert("messages", { chatId: hidden, userId: w.userId, role: "assistant" as const, status: "complete" as const, text: "PDF", runId: "run-conv", updatedAt: 1 });
        });
        return await measure(() => t.mutation(internal.fileRenditions.timeoutStaleRenditions, {}));
      }
      case "ackKeyCorrection": {
        const { outboxId } = await asUser.mutation(api.send.sendMessage, { chatId: w.chatId, text: "encore", clientMessageId: "inv-3" });
        await t.mutation(internal.bridge.lastGateBeforeSend, { outboxId, target: TARGET, sendId: SEND_A });
        return await measure(() => t.mutation(internal.bridge.markOutbox, { outboxId, status: "sent", sendId: SEND_B } as never));
      }
      case "regenerationStamp": {
        const { outboxId } = await asUser.mutation(api.send.sendMessage, { chatId: w.chatId, text: "encore", clientMessageId: "inv-4" });
        await t.mutation(internal.bridge.lastGateBeforeSend, { outboxId, target: TARGET, sendId: SEND_A });
        return await measure(() => t.mutation(internal.bridge.lastGateBeforeSend, { outboxId, target: TARGET, sendId: SEND_B }));
      }
      case "applyLiveRows":
        return await measure(() => applyT(t, w.chatId, "live", [assistantRow("x1", 100, "runX")]));
      case "applyDeltaEmpty":
        return await measure(() => applyT(t, w.chatId, "delta", []));
      case "applyDeltaRows":
        return await measure(() => applyT(t, w.chatId, "delta", [assistantRow("x1", 100, "runX"), assistantRow("x2", 101, "runX")], { terminals: [{ runId: "runX", status: "completed", at: 1 }], hasActiveRun: false, activeRunIds: [] }));
      case "applyDeltaUserRows":
        return await measure(() => applyT(t, w.chatId, "delta", [userRow("u1", 99, "send0"), assistantRow("x1", 100, "send0")], { hasActiveRun: true, activeRunIds: ["send0"] }));
      case "applyDeltaGuardFacts":
        return await measure(() =>
          applyT(t, w.chatId, "delta", [], {
            inputRunIds: ["send0", "send1"],
            inputReceipts: [{ runId: "send0", state: "consumed" }],
            pendingInputs: { total: 1, complete: true, items: [{ runId: "send1", state: "queued" }] },
          }),
        );
      case "reconcileChatStuckStreams":
        return await measure(() => t.mutation(internal.stuckStreams.reconcileChatStuckStreams, { chatId: w.chatId as string }));
      case "reconcileStuckStreams":
        return await measure(() => t.mutation(internal.stuckStreams.reconcileStuckStreams, {}));
      case "sweepInstanceStreams":
        return await measure(() => t.mutation(internal.stuckStreams.sweepInstanceStreams, { instanceName: "prod" }));
      case "drainNextQueued":
        return await measure(() => t.mutation(internal.bridge.drainAfterCallRefusal, { chatId: w.chatId }));
      case "reconcileStalledOutbox":
        return await measure(() => t.mutation(internal.outboxReconcile.reconcileStalledOutbox, { now: 10 * 60 * 60_000 }));
      case "autoRetryTurn":
        return await measure(() => t.mutation(internal.turnRetry.autoRetryTurn, { chatId: w.chatId, messageId: w.erroredId!, attempt: 1 }));
      case "followUpState":
        return await measure(() => asUser.query(api.followUp.followUpState, { chatId: w.chatId }));
      case "resumeTarget":
        return await measure(() => t.query(internal.stuckStreams.resumeTarget, { messageId: w.stuckId! }));
      case "markResumed":
        return await measure(() => t.mutation(internal.stuckStreams.markResumed, { messageId: w.stuckId! }));
      case "startAnnounceMerge":
        return await measure(() => t.mutation(internal.stream.startAssistant, { chatId: w.chatId, runId: ANNOUNCE_RUN, turnSessionKey: SK, boundInstanceName: "prod" }));
      case "startSettleMerge":
        return await measure(() => t.mutation(internal.stream.startAssistant, { chatId: w.chatId, runId: SETTLE_RUN, turnSessionKey: SK, boundInstanceName: "prod" }));
      case "startTaskMerge":
        return await measure(() => t.mutation(internal.stream.startAssistant, { chatId: w.chatId, runId: TASK_RUN, turnSessionKey: SK, boundInstanceName: "prod" }));
      case "startUnanchoredDelivery":
        return await measure(() =>
          t.mutation(internal.stream.startAssistant, { chatId: w.chatId, runId: `announce:v1:agent:files:subagent:none:${CHILD_RUN}x`, turnSessionKey: SK, boundInstanceName: "prod" }),
        );
      case "finalizeMergedAnnounce": {
        const id = (await t.mutation(internal.stream.startAssistant, { chatId: w.chatId, runId: ANNOUNCE_RUN, turnSessionKey: SK, boundInstanceName: "prod" })) as Id<"messages">;
        await t.mutation(internal.stream.appendDelta, { messageId: id, text: "résultat" } as never);
        return await measure(() => t.mutation(internal.stream.finalize, { messageId: id, status: "complete", text: "résultat" } as never));
      }
      case "finalizeEmptyDelivery": {
        const id = (await t.mutation(internal.stream.startAssistant, {
          chatId: w.chatId,
          runId: `announce:v1:agent:files:subagent:none:${CHILD_RUN}x`,
          turnSessionKey: SK,
          boundInstanceName: "prod",
        })) as Id<"messages">;
        return await measure(() => t.mutation(internal.stream.finalize, { messageId: id, status: "complete" } as never));
      }
      case "addPartMergedAnnounce": {
        const id = (await t.mutation(internal.stream.startAssistant, { chatId: w.chatId, runId: ANNOUNCE_RUN, turnSessionKey: SK, boundInstanceName: "prod" })) as Id<"messages">;
        return await measure(() =>
          t.mutation(internal.stream.addPart, {
            messageId: id,
            part: { kind: "tool", toolCallId: "call-1", name: "exec", phase: "result", textOffset: 0 },
          } as never),
        );
      }
      case "upsertSubAgentNew":
        return await measure(() =>
          t.mutation(internal.subAgents.upsertSubAgent, {
            chatId: w.chatId,
            instanceName: "prod",
            boundInstanceName: "prod",
            parentMessageId: w.messages[w.messages.length - 1]!,
            anchorExact: true,
            childSessionKey: "agent:files:subagent:new-child",
            childRunId: "new-child-run",
            kind: "subagent",
            status: "running",
          }),
        );
      case "upsertSubAgentUpdate":
        return await measure(() =>
          t.mutation(internal.subAgents.upsertSubAgent, {
            chatId: w.chatId,
            instanceName: "prod",
            boundInstanceName: "prod",
            childSessionKey: CHILD_KEY,
            kind: "subagent",
            status: "done",
            resultText: "fini",
          }),
        );
      case "upsertTaskEngagement":
        return await measure(() =>
          t.mutation(internal.subAgents.upsertSubAgent, {
            chatId: w.chatId,
            instanceName: "prod",
            boundInstanceName: "prod",
            parentMessageId: w.messages[w.messages.length - 1]!,
            anchorExact: true,
            childSessionKey: "task:0d59e951-cbaa-44f1-92e5-33b9729d0000",
            kind: "task",
            taskName: "image_generate",
            status: "running",
          }),
        );
      case "listByChat":
        return await measure(() => asUser.query(api.messages.listByChat, { chatId: w.chatId as string }));
      case "submitFeedback":
        return await measure(() =>
          asUser.mutation(api.feedback.submitFeedback, {
            chatId: w.chatId,
            messageId: w.messages[w.messages.length - 1]!,
            category: "incorrect",
            client: { displayedText: `r${TURNS - 1}` },
          }),
        );
      case "submitFeedbackOlderThanScan": {
        await t.run(async (ctx) => {
          for (let i = 0; i < 61; i++) {
            await ctx.db.insert("messages", { chatId: w.chatId, userId: w.userId, role: i % 2 === 0 ? ("user" as const) : ("assistant" as const), status: "complete" as const, text: `n${i}`, updatedAt: 1 });
          }
        });
        return await measure(() =>
          asUser.mutation(api.feedback.submitFeedback, {
            chatId: w.chatId,
            messageId: w.messages[1]!,
            category: "incorrect",
            client: { displayedText: "r0" },
          }),
        );
      }
      case "retryAnsweredBatch":
      case "retryUnansweredBatch":
      case "retryGoneBlobBatch": {
        // The last answer is a bubble the settle batch of CHILD_RUN merged into (0.96.0):
        // its continuation begins after "r11\n\n", its parts are stamped by the batch.
        const bubble = w.messages[w.messages.length - 1]!;
        await t.run((ctx) =>
          ctx.db.patch(bubble, {
            runId: SETTLE_RUN,
            text: path === "retryAnsweredBatch" ? `r${TURNS - 1}\n\nSYNTHESE: fini.` : `r${TURNS - 1}\n\n`,
            announcePrefix: `r${TURNS - 1}`,
            continuations: [{ at: `r${TURNS - 1}\n\n`.length, childRunIds: [CHILD_RUN] }],
            mergedAnnounceRuns: [SETTLE_RUN],
          } as never),
        );
        if (path === "retryAnsweredBatch") {
          for (let i = 0; i < 19; i++) {
            await t.run((ctx) =>
              ctx.db.insert("messageParts", { messageId: bubble, order: i, announceRun: SETTLE_RUN, part: { kind: "tool", name: "exec", phase: "result", toolCallId: `big${i}`, output: "x".repeat(900 * 1024) } } as never),
            );
          }
        } else if (path === "retryUnansweredBatch") {
          await t.run((ctx) =>
            ctx.db.insert("messageParts", { messageId: bubble, order: 0, announceRun: SETTLE_RUN, part: { kind: "tool", name: "exec", phase: "result", toolCallId: "t0" } } as never),
          );
        } else {
          await t.run(async (ctx) => {
            const storageId = await ctx.storage.store(new Blob(["pdf"]));
            await ctx.storage.delete(storageId);
            await ctx.db.insert("messageParts", { messageId: bubble, order: 0, announceRun: SETTLE_RUN, part: { kind: "file", storageId, filename: "r.pdf", mimeType: "application/pdf" } } as never);
          });
        }
        return await measure(() =>
          t.mutation(internal.stream.startAssistant, { chatId: w.chatId, runId: `${SETTLE_RUN}:retry-1`, turnSessionKey: SK, boundInstanceName: "prod" }),
        );
      }
      case "peekSubAgents":
      case "peekSubAgentsHeavy": {
        if (path === "peekSubAgentsHeavy") {
          for (let i = 0; i < 27; i++) {
            await t.run((ctx) =>
              ctx.db.insert("messages", { chatId: w.chatId, userId: w.userId, role: "assistant" as const, status: "complete" as const, text: "x".repeat(650 * 1024), runId: `heavy${i}`, turnSessionKey: SK, boundInstance: "prod", updatedAt: 1 }),
            );
          }
        }
        return await measure(() => t.query(api.dev.peekSubAgents, { chatId: w.chatId }));
      }
      case "markOutboxSent": {
        const { outboxId } = await asUser.mutation(api.send.sendMessage, { chatId: w.chatId, text: "encore", clientMessageId: "inv-2" });
        return await measure(() => t.mutation(internal.bridge.markOutbox, { outboxId, status: "sent" } as never));
      }
    }
  }
}

const assistantRow = (entryId: string, seq: number, runId: string) => ({ entryId, seq, role: "assistant", runId, hidden: false, visible: true });
const userRow = (entryId: string, seq: number, sendId: string) => ({ entryId, seq, role: "user", runId: sendId, sendId, hidden: false, visible: true });
/** One transcript apply, with only the arguments 0.95.0 already took. */
function applyT(t: T, chatId: Id<"chats">, kind: "live" | "delta", rows: unknown[], extra: Record<string, unknown> = {}) {
  return t.mutation(internal.transcriptProjection.applyTranscript, {
    chatId,
    boundInstanceName: "prod",
    sessionKey: SK,
    sessionId: "s-1",
    kind,
    ...(kind === "delta" ? { deltaCursor: "c:next" } : {}),
    rows,
    terminals: [],
    unidentified: 0,
    readAt: 5,
    ...extra,
  } as never);
}

const RECORD = process.env.PROJECTION_INVARIANCE_RECORD;
const BASELINE_PATH = new URL("./fixtures/projection-invariance-baseline.json", import.meta.url);
const recorded: Record<string, Counts> = {};
const baseline: Record<string, Counts> = RECORD === undefined ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : {};

afterAll(() => {
  if (RECORD !== undefined) writeFileSync(RECORD, JSON.stringify(recorded, null, 2) + "\n");
});

describe("a conversation never `on` costs exactly what it cost before phase 4", () => {
  for (const mode of ["off", "shadow"] as const) {
    for (const path of PATHS) {
      test(`${mode} · ${path}`, async () => {
        const c = await run(path, mode);
        recorded[`${mode}:${path}`] = c;
        if (RECORD === undefined) expect(c).toEqual(baseline[`${mode}:${path}`]);
      }, 60_000);
    }
  }
});
