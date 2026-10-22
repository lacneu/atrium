/// <reference types="vite/client" />
//
// HERMES INVARIANCE: a conversation on a HERMES instance — never projected (it has no
// transcript with OpenClaw's identities, design §9.2) — costs EXACTLY what it cost before
// the OpenClaw-only projection lost its `off`/`shadow` modes (0.102.0), on every deletion
// path and on the send → stream → finalize path that a Hermes bridge drives: the same index
// ranges, documents read, documents written and functions scheduled (bytes included), and no
// projection-only table touched.
//
// Until 0.101.x this file pinned an OpenClaw instance set `off` or `shadow` to 0.95.0's
// costs. Those modes are gone for OpenClaw (an OpenClaw instance always runs `on`); the
// property that survives is Hermes'. The paths an OpenClaw bridge alone drives (transcript
// applies, CU-22 resume, delivery runs and their merges, sub-agent observations, the
// gateway queue, the pressure trace) are not replayed here.
//
// The expectations are MEASURED, not chosen: `fixtures/projection-invariance-hermes-baseline.json`
// was produced by running THIS file against the v0.101.4 tree (`git archive v0.101.4`) with
// PROJECTION_INVARIANCE_RECORD=<path>. Each path below is replayed here and its counts must
// be identical.

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
const TARGET = { instanceName: "prod", agentId: "main" };
const SEND_A = `webchat-${"a".repeat(64)}`;
const SEND_B = `webchat-${"b".repeat(64)}`;
const TURNS = 12;
// The delegation the message list and the dev probe read.
const CHILD_KEY = "agent:files:subagent:0d59e951-cbaa-44f1-92e5-33b9729d096e";
const CHILD_RUN = "742ca132-060c-4cf8-8c0a-3f1377095ea3";
const TASK_ID = "bf66f802-e5a6-4394-9815-40c4bcd28dae";
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

/** A Hermes conversation: TURNS user/assistant turns, MERGES run records each. */
async function world(
  t: T,
  opts: {
    kind?: "summarizer";
    trashed?: boolean;
    stuck?: boolean;
    /** Phase 5 shape: a running sub-agent child and a running background task, both
     *  anchored (exactly) to the last answer — what the message list and the dev probe read. */
    delegation?: boolean;
  } = {},
) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const profileId = await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "u" });
    const adminUser = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId: adminUser, role: "admin" as const, canonical: "a" });
    await ctx.db.insert("userAgents", { userId, instanceName: "prod", agentId: "main", isDefault: true, source: "manual" as const, createdAt: 1 });
    await ctx.db.insert("instances", { name: "prod", kind: "hermes", gatewayUrl: "ws://gw" } as never);
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
    if (opts.delegation === true) {
      const anchor = messages[messages.length - 1]!;
      await ctx.db.insert("subAgents", { chatId, userId, instanceName: "prod", parentMessageId: anchor, anchorExact: true, childSessionKey: CHILD_KEY, childRunId: CHILD_RUN, kind: "subagent" as const, status: "running" as const, createdAt: 1, updatedAt: 1 });
      await ctx.db.insert("subAgents", { chatId, userId, instanceName: "prod", parentMessageId: anchor, anchorExact: true, childSessionKey: `task:${TASK_ID}`, kind: "task" as const, taskName: "image_generate", status: "running" as const, createdAt: 1, updatedAt: 1 });
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
  "reconcileChatStuckStreams",
  "reconcileStuckStreams",
  "sweepInstanceStreams",
  "drainNextQueued",
  "reconcileStalledOutbox",
  "autoRetryTurn",
  "followUpState",
  "regenerationStamp",
  "timeoutStaleRenditions",
  "listByChat",
  "submitFeedback",
  "submitFeedbackOlderThanScan",
  "peekSubAgents",
  "peekSubAgentsHeavy",
] as const;
type PathName = (typeof PATHS)[number];
const DELEGATION_PATHS = new Set<PathName>([
  "listByChat",
  "peekSubAgents",
  "peekSubAgentsHeavy",
]);

async function run(path: PathName): Promise<Counts> {
  vi.useFakeTimers();
  const c = await runPath(path);
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

async function runPath(path: PathName): Promise<Counts> {
  const t = convexTest({ schema, modules, transactionLimits: true });
  const w = await world(t, {
    ...(["reconcileChatStuckStreams", "reconcileStuckStreams", "sweepInstanceStreams", "reconcileStalledOutbox", "autoRetryTurn", "drainNextQueued"].includes(path)
      ? { stuck: true }
      : {}),
    ...(path === "sweepHiddenChat" ? { kind: "summarizer" as const } : {}),
    ...(path === "trashPurgeChat" || path === "adminPurgeChat" ? { trashed: true } : {}),
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
      case "regenerationStamp": {
        const { outboxId } = await asUser.mutation(api.send.sendMessage, { chatId: w.chatId, text: "encore", clientMessageId: "inv-4" });
        await t.mutation(internal.bridge.lastGateBeforeSend, { outboxId, target: TARGET, sendId: SEND_A });
        return await measure(() => t.mutation(internal.bridge.lastGateBeforeSend, { outboxId, target: TARGET, sendId: SEND_B }));
      }
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

const RECORD = process.env.PROJECTION_INVARIANCE_RECORD;
const BASELINE_PATH = new URL("./fixtures/projection-invariance-hermes-baseline.json", import.meta.url);
const recorded: Record<string, Counts> = {};
const baseline: Record<string, Counts> = RECORD === undefined ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : {};

afterAll(() => {
  if (RECORD !== undefined) writeFileSync(RECORD, JSON.stringify(recorded, null, 2) + "\n");
});

describe("a Hermes conversation costs exactly what it cost at 0.101.4", () => {
  for (const path of PATHS) {
    test(`hermes · ${path}`, async () => {
      const c = await run(path);
      recorded[`hermes:${path}`] = c;
      if (RECORD === undefined) expect(c).toEqual(baseline[`hermes:${path}`]);
    }, 60_000);
  }
});
