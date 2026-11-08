/// <reference types="vite/client" />
//
// THE UTILITY HOLD (lib/utilityHold.ts, bridge.holdUtilityDispatch). On OpenClaw, any
// session created while a person decides an approval makes the allowed command fail
// `approval-request-failed`; every hidden utility job creates one. These tests drive the
// REAL dispatch action (the bridge is a stubbed `fetch`) and assert what left for the
// bridge, what stayed in Convex, and what the watchdogs do with a held job.

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { UTILITY_HOLD_MAX_MS, UTILITY_HOLD_RECHECK_MS } from "./lib/utilityHold";
import { STALLED_PENDING_MS } from "./outboxReconcile";
import { RENDITION_TIMEOUT_MS } from "./fileRenditions";

const modules = import.meta.glob("./**/*.ts");
type Tt = TestConvex<typeof schema>;

const INSTANCE = "primary";
const BRIDGE_URL = "https://bridge.test";
const T0 = Date.UTC(2026, 10, 8, 12, 0, 0);
const MIN = 60_000;

type JobKind = "summarizer" | "documentary" | "curator" | "converter";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  process.env.BRIDGE_SHARED_SECRET = "shared";
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete process.env.BRIDGE_SHARED_SECRET;
});

/** How many POSTs reached the bridge's `/send`. */
function sends(): number {
  return fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/send")).length;
}

async function seedInstance(
  t: Tt,
  name: string,
  opts: { kind?: "openclaw" | "hermes"; projection?: "on" } = {},
): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("instances", {
      name,
      gatewayUrl: "ws://gw",
      kind: opts.kind ?? "openclaw",
      bridgeUrl: BRIDGE_URL,
      ...(opts.projection ? { config: { transcriptProjection: opts.projection } } : {}),
    });
    await ctx.db.insert("agents", {
      instanceName: name,
      agentId: "olivier",
      source: "discovered" as const,
      presentInLastOk: true,
      enabled: true,
      firstSeenAt: 1,
      lastSeenAt: 1,
    });
  });
}

/**
 * A user, the conversation a job works for, and the job itself as its creator leaves
 * it: the hidden chat holding the job's lock, its prompt, and a `pending` outbox row
 * whose dispatch has not run yet. `kind: "ordinary"` seeds a plain conversation turn
 * instead (no hidden chat).
 */
async function seedJob(
  t: Tt,
  opts: {
    kind?: JobKind | "ordinary";
    instanceName?: string;
    instanceKind?: "openclaw" | "hermes";
    projection?: "on";
    pendingSince?: number;
    utilityHoldSince?: number;
    renditionCreatedAt?: number;
    /** A converter job's file, riding the turn as its attachment (read and encoded by
     *  the dispatch before the last gate). */
    attachment?: Blob;
  } = {},
) {
  const instanceName = opts.instanceName ?? INSTANCE;
  await seedInstance(t, instanceName, {
    ...(opts.instanceKind ? { kind: opts.instanceKind } : {}),
    ...(opts.projection ? { projection: opts.projection } : {}),
  });
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "u" });
    const sourceChatId = await ctx.db.insert("chats", {
      userId,
      instanceName,
      agentId: "olivier",
      updatedAt: 1,
    });
    const sourceMessageId = await ctx.db.insert("messages", {
      chatId: sourceChatId,
      userId,
      role: "assistant" as const,
      status: "complete" as const,
      text: "a reply that cites documents",
      updatedAt: 1,
    });
    const kind = opts.kind ?? "summarizer";
    let renditionId: Id<"fileRenditions"> | null = null;
    let attachmentId: Id<"_storage"> | null = null;
    if (kind === "converter") {
      const sourceStorageId = await ctx.storage.store(
        opts.attachment ?? new Blob([new Uint8Array([1, 2, 3])]),
      );
      if (opts.attachment) attachmentId = sourceStorageId;
      renditionId = await ctx.db.insert("fileRenditions", {
        sourceStorageId,
        chatId: sourceChatId,
        userId,
        sourceFilename: "deck.pptx",
        sourceMimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        status: "pending" as const,
        converterInstance: instanceName,
        converterAgentId: "olivier",
        createdAt: opts.renditionCreatedAt ?? T0,
        updatedAt: opts.renditionCreatedAt ?? T0,
      });
    }
    let curationId: Id<"agentFileCurations"> | null = null;
    if (kind === "curator") {
      curationId = await ctx.db.insert("agentFileCurations", {
        instanceName,
        agentId: "olivier",
        name: "MEMORY.md",
        status: "dispatched" as const,
        baseUpdatedAtMs: null,
        beforeSize: 5,
        budgetChars: 4_000,
        requestedByUserId: userId,
        trigger: "manual" as const,
        createdAt: T0,
        updatedAt: T0,
      });
    }
    const chatId =
      kind === "ordinary"
        ? sourceChatId
        : await ctx.db.insert("chats", {
            userId,
            kind,
            instanceName,
            agentId: "olivier",
            updatedAt: 1,
            openclawChatId: `${kind}:job:${T0}`,
            ...(kind === "summarizer"
              ? {
                  pendingSummarize: {
                    targetChatId: sourceChatId,
                    watermarkTarget: 1,
                    coveredCountTarget: 1,
                    createdAt: T0,
                  },
                }
              : {}),
            ...(kind === "documentary"
              ? { pendingFetch: { sourceMessageId, createdAt: T0 } }
              : {}),
            ...(kind === "converter" && renditionId !== null
              ? { pendingConvert: { renditionId, createdAt: T0 } }
              : {}),
            ...(kind === "curator" && curationId !== null
              ? { pendingCurate: { curationId, createdAt: T0 } }
              : {}),
          });
    const messageId = await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "user" as const,
      status: "complete" as const,
      text: "job prompt",
      updatedAt: T0,
    });
    const outboxId = await ctx.db.insert("outbox", {
      chatId,
      userId,
      clientMessageId: `job-${kind}-${T0}`,
      messageId,
      text: "job prompt",
      attachmentIds: attachmentId === null ? [] : [attachmentId],
      ...(attachmentId === null
        ? {}
        : {
            attachments: [
              {
                storageId: attachmentId,
                filename: "deck.pptx",
                mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
              },
            ],
          }),
      status: "pending" as const,
      pendingSince: opts.pendingSince ?? T0,
      ...(opts.utilityHoldSince !== undefined ? { utilityHoldSince: opts.utilityHoldSince } : {}),
    });
    return { userId, sourceChatId, chatId, outboxId, renditionId };
  });
}

/** An agent request as the bridge records it, raised in `chatId`. */
async function seedRequest(
  t: Tt,
  chatId: Id<"chats">,
  opts: {
    instanceName?: string;
    kind?: "approval" | "question";
    status?: "pending" | "submitting" | "allowed";
    expiresAt?: number;
  } = {},
): Promise<Id<"agentRequests">> {
  return await t.run(async (ctx) => {
    const chat = await ctx.db.get(chatId);
    const kind = opts.kind ?? "approval";
    return await ctx.db.insert("agentRequests", {
      chatId,
      userId: chat!.userId,
      instanceName: opts.instanceName ?? INSTANCE,
      source: kind === "approval" ? ("openclaw.exec" as const) : ("openclaw.ask_user" as const),
      kind,
      providerRequestId: `req-${Math.random().toString(36).slice(2)}`,
      ...(kind === "approval"
        ? {
            approvalKind: "exec" as const,
            approval: { command: "echo OK", decisions: ["allow-once" as const, "deny" as const] },
          }
        : {
            questions: [
              {
                id: "q",
                text: "Which?",
                options: [{ label: "A" }],
                multiSelect: false,
                allowOther: false,
                secret: false,
              },
            ],
          }),
      status: opts.status ?? "pending",
      createdAt: T0,
      updatedAt: T0,
      expiresAt: opts.expiresAt ?? T0 + 30 * MIN,
    });
  });
}

/** A conversation of ANOTHER user on the same instance — an approval is the gateway's,
 *  not the job owner's. */
async function otherConversation(t: Tt, instanceName = INSTANCE): Promise<Id<"chats">> {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "other" });
    return await ctx.db.insert("chats", { userId, instanceName, agentId: "olivier", updatedAt: 1 });
  });
}

async function dispatch(t: Tt, outboxId: Id<"outbox">): Promise<void> {
  await t.action(internal.bridge.dispatch, { outboxId });
}

async function outbox(t: Tt, outboxId: Id<"outbox">) {
  return await t.run((ctx) => ctx.db.get(outboxId));
}

/** The dispatches the hold scheduled again. */
async function scheduledDispatches(t: Tt) {
  return (
    await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())
  ).filter((f) => f.name.includes("bridge") && f.name.includes("dispatch") && f.state.kind === "pending");
}

async function dispatchTraces(t: Tt) {
  const rows = await t.run((ctx) => ctx.db.query("traceEvents").collect());
  return rows
    .filter((r) => r.kind === "openclaw.dispatch")
    .map((r) => JSON.parse(r.meta ?? "{}") as Record<string, unknown>);
}

describe("a utility job is held while an approval waits on its instance", () => {
  test("a summary: nothing reaches the bridge, the row stays pending, and asks again", async () => {
    const t = convexTest(schema, modules);
    const job = await seedJob(t, { pendingSince: T0 - MIN });
    await seedRequest(t, await otherConversation(t));

    await dispatch(t, job.outboxId);

    expect(sends()).toBe(0);
    const row = await outbox(t, job.outboxId);
    expect(row!.status).toBe("pending");
    expect(row!.utilityHoldSince).toBe(T0);
    // Re-stamped: the reconciler measures from here, not from the job's creation.
    expect(row!.pendingSince).toBe(T0);
    const again = await scheduledDispatches(t);
    expect(again).toHaveLength(1);
    expect(again[0]!.scheduledTime).toBe(T0 + UTILITY_HOLD_RECHECK_MS);
    expect((again[0]!.args[0] as { outboxId: string }).outboxId).toBe(job.outboxId);
    // The job keeps its lock: its reply will still correlate.
    const hidden = await t.run((ctx) => ctx.db.get(job.chatId));
    expect(hidden!.pendingSummarize?.targetChatId).toBe(job.sourceChatId);
    const traces = await dispatchTraces(t);
    expect(traces).toEqual([
      expect.objectContaining({
        dispatchStatus: "deferred",
        reason: "approval_pending",
        chatKind: "summarizer",
        instanceName: INSTANCE,
      }),
    ]);
  });

  test("released once the approval is settled: the next check sends it", async () => {
    const t = convexTest(schema, modules);
    const job = await seedJob(t);
    const approval = await seedRequest(t, await otherConversation(t));
    await dispatch(t, job.outboxId);
    expect(sends()).toBe(0);

    await t.run((ctx) => ctx.db.patch(approval, { status: "allowed", updatedAt: T0 + 5_000 }));
    vi.setSystemTime(T0 + UTILITY_HOLD_RECHECK_MS);
    await dispatch(t, job.outboxId);

    expect(sends()).toBe(1);
    expect((await outbox(t, job.outboxId))!.status).toBe("sent");
    const statuses = (await dispatchTraces(t)).map((m) => m.dispatchStatus);
    expect(statuses).toEqual(["deferred", "sent"]);
  });

  test("a job held at every check is traced once, on its first hold", async () => {
    const t = convexTest(schema, modules);
    const job = await seedJob(t);
    await seedRequest(t, await otherConversation(t));
    await dispatch(t, job.outboxId);
    vi.setSystemTime(T0 + UTILITY_HOLD_RECHECK_MS);
    await dispatch(t, job.outboxId);

    expect(sends()).toBe(0);
    const row = await outbox(t, job.outboxId);
    // The hold started at the first check; the stamp follows the last one.
    expect(row!.utilityHoldSince).toBe(T0);
    expect(row!.pendingSince).toBe(T0 + UTILITY_HOLD_RECHECK_MS);
    expect((await dispatchTraces(t)).filter((m) => m.dispatchStatus === "deferred")).toHaveLength(1);
  });

  test("an approval the person already clicked (submitting) still holds", async () => {
    const t = convexTest(schema, modules);
    const job = await seedJob(t);
    await seedRequest(t, await otherConversation(t), { status: "submitting" });
    await dispatch(t, job.outboxId);
    expect(sends()).toBe(0);
    expect((await outbox(t, job.outboxId))!.utilityHoldSince).toBe(T0);
  });

  test("it asks again at the approval's own deadline when that comes first", async () => {
    const t = convexTest(schema, modules);
    const job = await seedJob(t);
    await seedRequest(t, await otherConversation(t), { expiresAt: T0 + 4_000 });
    await dispatch(t, job.outboxId);
    const again = await scheduledDispatches(t);
    expect(again).toHaveLength(1);
    expect(again[0]!.scheduledTime).toBe(T0 + 4_000);
  });

  for (const kind of ["documentary", "curator", "converter"] as const) {
    test(`a ${kind} job is held the same way`, async () => {
      const t = convexTest(schema, modules);
      const job = await seedJob(t, { kind });
      await seedRequest(t, await otherConversation(t));
      await dispatch(t, job.outboxId);
      expect(sends()).toBe(0);
      expect((await outbox(t, job.outboxId))!.status).toBe("pending");
      expect((await dispatchTraces(t))[0]).toMatchObject({
        dispatchStatus: "deferred",
        reason: "approval_pending",
        chatKind: kind,
      });
    });
  }
});

describe("what does NOT hold a job", () => {
  test("an approval on ANOTHER instance", async () => {
    const t = convexTest(schema, modules);
    const job = await seedJob(t);
    await seedInstance(t, "elsewhere");
    await seedRequest(t, await otherConversation(t, "elsewhere"), { instanceName: "elsewhere" });
    await dispatch(t, job.outboxId);
    expect(sends()).toBe(1);
    expect((await outbox(t, job.outboxId))!.utilityHoldSince).toBeUndefined();
  });

  test("a Hermes instance, whatever is pending on it", async () => {
    const t = convexTest(schema, modules);
    const job = await seedJob(t, { instanceKind: "hermes" });
    await seedRequest(t, await otherConversation(t));
    await dispatch(t, job.outboxId);
    expect(sends()).toBe(1);
    expect((await outbox(t, job.outboxId))!.utilityHoldSince).toBeUndefined();
  });

  test("a conversation's own turn — nobody's turn waits for someone else's approval", async () => {
    const t = convexTest(schema, modules);
    const job = await seedJob(t, { kind: "ordinary" });
    await seedRequest(t, await otherConversation(t));
    await dispatch(t, job.outboxId);
    expect(sends()).toBe(1);
    expect((await outbox(t, job.outboxId))!.utilityHoldSince).toBeUndefined();
  });

  test("a question waiting for an answer", async () => {
    const t = convexTest(schema, modules);
    const job = await seedJob(t);
    await seedRequest(t, await otherConversation(t), { kind: "question" });
    await dispatch(t, job.outboxId);
    expect(sends()).toBe(1);
  });

  test("an approval past its deadline that the sweep has not closed yet", async () => {
    const t = convexTest(schema, modules);
    const job = await seedJob(t);
    await seedRequest(t, await otherConversation(t), { expiresAt: T0 - 1 });
    await dispatch(t, job.outboxId);
    expect(sends()).toBe(1);
  });

  test("an approval already settled", async () => {
    const t = convexTest(schema, modules);
    const job = await seedJob(t);
    await seedRequest(t, await otherConversation(t), { status: "allowed" });
    await dispatch(t, job.outboxId);
    expect(sends()).toBe(1);
  });
});

describe("a summary also waits for the conversation it summarizes", () => {
  test("while a sub-agent of it runs — even under the transcript projection", async () => {
    // Under projection `on` a running sub-agent does not make a conversation busy for a
    // SEND (isChatBusy), but it is exactly the run that asks for an approval after its
    // parent's turn ended: measured on the bench, the summary was decided 0.3 to 2.4 s
    // before the sub-agent's request.
    const t = convexTest(schema, modules);
    const job = await seedJob(t, { projection: "on" });
    const child = await t.run((ctx) =>
      ctx.db.insert("subAgents", {
        chatId: job.sourceChatId,
        childSessionKey: "agent:olivier:subagent:c1",
        status: "running" as const,
        kind: "subagent" as const,
        createdAt: T0,
        updatedAt: T0,
      }),
    );
    await dispatch(t, job.outboxId);
    expect(sends()).toBe(0);
    expect((await dispatchTraces(t))[0]).toMatchObject({
      dispatchStatus: "deferred",
      reason: "source_busy",
    });
    expect((await scheduledDispatches(t))[0]!.scheduledTime).toBe(T0 + UTILITY_HOLD_RECHECK_MS);

    await t.run((ctx) => ctx.db.patch(child, { status: "done" as const }));
    vi.setSystemTime(T0 + UTILITY_HOLD_RECHECK_MS);
    await dispatch(t, job.outboxId);
    expect(sends()).toBe(1);
  });

  test("while it streams a reply", async () => {
    const t = convexTest(schema, modules);
    const job = await seedJob(t);
    await t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId: job.sourceChatId,
        userId: job.userId,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "",
        updatedAt: T0,
      }),
    );
    await dispatch(t, job.outboxId);
    expect(sends()).toBe(0);
    expect((await dispatchTraces(t))[0]).toMatchObject({ reason: "source_busy" });
  });

  test("while one of its turns is being dispatched", async () => {
    const t = convexTest(schema, modules);
    const job = await seedJob(t);
    await t.run((ctx) =>
      ctx.db.insert("outbox", {
        chatId: job.sourceChatId,
        userId: job.userId,
        clientMessageId: "turn-1",
        text: "next question",
        attachmentIds: [],
        status: "pending" as const,
        pendingSince: T0,
      }),
    );
    await dispatch(t, job.outboxId);
    expect(sends()).toBe(0);
  });

  test("…but another job's source does not hold a documentary fetch", async () => {
    // The source rule is the SUMMARY's: a fetch is decided by a click, not at a turn's
    // end, and is held only by an approval.
    const t = convexTest(schema, modules);
    const job = await seedJob(t, { kind: "documentary" });
    await t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId: job.sourceChatId,
        userId: job.userId,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "",
        updatedAt: T0,
      }),
    );
    await dispatch(t, job.outboxId);
    expect(sends()).toBe(1);
  });
});

describe("the hold is bounded and keeps the watchdogs honest", () => {
  // The bound is literal on purpose: it must stay above the 30 minutes an exec approval
  // waits upstream by default, or a job would be sent into the very wait it protects.
  test("35 minutes after its first hold, the job leaves even if an approval still waits", async () => {
    expect(UTILITY_HOLD_MAX_MS).toBe(35 * MIN);
    const t = convexTest(schema, modules);
    const job = await seedJob(t, { utilityHoldSince: T0 - 35 * MIN });
    await seedRequest(t, await otherConversation(t));
    await dispatch(t, job.outboxId);
    expect(sends()).toBe(1);
    expect((await outbox(t, job.outboxId))!.status).toBe("sent");
  });

  test("…and is still held a moment before, past the 30 minutes of an exec approval", async () => {
    const t = convexTest(schema, modules);
    const since = T0 - 35 * MIN + 1_000;
    const job = await seedJob(t, { utilityHoldSince: since });
    await seedRequest(t, await otherConversation(t));
    await dispatch(t, job.outboxId);
    expect(sends()).toBe(0);
    // The hold keeps its origin: re-checks do not extend the bound.
    expect((await outbox(t, job.outboxId))!.utilityHoldSince).toBe(since);
  });

  test("a held row is not settled as a stalled dispatch", async () => {
    const t = convexTest(schema, modules);
    // Its dispatch window opened long ago (a job held since): past the reconciler's bound.
    const job = await seedJob(t, { pendingSince: T0 - STALLED_PENDING_MS - MIN });
    await seedRequest(t, await otherConversation(t));
    // An instance that has correlated a turn before: the reconciler's SHORT bound applies.
    await t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId: job.sourceChatId,
        userId: job.userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "earlier reply",
        updatedAt: 1,
        boundInstance: INSTANCE,
        dispatchOutboxId: "earlier-outbox",
      }),
    );
    await dispatch(t, job.outboxId);

    await t.mutation(internal.outboxReconcile.reconcileStalledOutbox, { now: T0 + MIN });

    const row = await outbox(t, job.outboxId);
    expect(row!.status).toBe("pending");
    const failures = await t.run((ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_chat", (q) => q.eq("chatId", job.chatId))
        .collect(),
    );
    expect(failures.some((m) => m.role === "assistant" && m.status === "error")).toBe(false);
  });

  test("a held conversion is not timed out, and gets its whole window once it leaves", async () => {
    const t = convexTest(schema, modules);
    // Requested ten minutes ago: twice the rendition timeout.
    const job = await seedJob(t, { kind: "converter", renditionCreatedAt: T0 - 10 * MIN });
    // A second file of the same user, queued behind it on the serial converter chat.
    const queued = await t.run(async (ctx) => {
      const sourceStorageId = await ctx.storage.store(new Blob([new Uint8Array([4])]));
      return await ctx.db.insert("fileRenditions", {
        sourceStorageId,
        chatId: job.sourceChatId,
        userId: job.userId,
        sourceFilename: "sheet.xlsx",
        sourceMimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        status: "pending" as const,
        converterInstance: INSTANCE,
        converterAgentId: "olivier",
        createdAt: T0 - 9 * MIN,
        updatedAt: T0 - 9 * MIN,
      });
    });
    const approval = await seedRequest(t, await otherConversation(t));
    await dispatch(t, job.outboxId);

    await t.mutation(internal.fileRenditions.timeoutStaleRenditions, {});
    const status = async (id: Id<"fileRenditions">) =>
      (await t.run((ctx) => ctx.db.get(id)))!.status;
    expect(await status(job.renditionId!)).toBe("pending");
    expect(await status(queued)).toBe("pending");

    // The approval is settled and the turn leaves at the next check…
    await t.run((ctx) => ctx.db.patch(approval, { status: "allowed" }));
    vi.setSystemTime(T0 + UTILITY_HOLD_RECHECK_MS);
    await dispatch(t, job.outboxId);
    expect(sends()).toBe(1);
    // …and the converter has the whole window from the last hold, not one second more.
    vi.setSystemTime(T0 + RENDITION_TIMEOUT_MS - 1_000);
    await t.mutation(internal.fileRenditions.timeoutStaleRenditions, {});
    expect(await status(job.renditionId!)).toBe("pending");
    vi.setSystemTime(T0 + RENDITION_TIMEOUT_MS + 1_000);
    await t.mutation(internal.fileRenditions.timeoutStaleRenditions, {});
    expect(await status(job.renditionId!)).toBe("failed");
  });
});

describe("the hold, asked again after the attachments are read (codex review of lot A+B)", () => {
  /** A file whose READ by the dispatch raises an approval on the instance, once: the
   *  first check has passed (nothing pending), the last gate has not run yet. The stored
   *  object itself is what the dispatch reads (`storage.get` returns it). Armed only once
   *  the job is stored: storing it reads it too (its sha256). */
  function fileThatRaisesAnApproval(t: Tt): { blob: Blob; arm: () => void; reads: () => number } {
    const blob = new Blob([new Uint8Array([7, 7, 7])]);
    const original = blob.arrayBuffer.bind(blob);
    let reads = 0;
    let armed = false;
    Object.defineProperty(blob, "arrayBuffer", {
      value: async () => {
        if (armed) {
          reads += 1;
          if (reads === 1) await seedRequest(t, await otherConversation(t));
        }
        return await original();
      },
    });
    return { blob, arm: () => (armed = true), reads: () => reads };
  }

  test("an approval raised while a conversion's file is read: nothing is sent, the dispatch asks again", async () => {
    const t = convexTest(schema, modules);
    const file = fileThatRaisesAnApproval(t);
    const job = await seedJob(t, { kind: "converter", attachment: file.blob, pendingSince: T0 - MIN });
    file.arm();

    await dispatch(t, job.outboxId);

    // The first check passed: the file WAS read and encoded…
    expect(file.reads()).toBe(1);
    // …and the last gate held the job all the same.
    expect(sends()).toBe(0);
    const row = await outbox(t, job.outboxId);
    expect(row!.status).toBe("pending");
    expect(row!.sentToInstance).toBeUndefined();
    expect(row!.sendId).toBeUndefined();
    expect(row!.utilityHoldSince).toBe(T0);
    expect(row!.pendingSince).toBe(T0);
    const again = await scheduledDispatches(t);
    expect(again).toHaveLength(1);
    expect(again[0]!.scheduledTime).toBe(T0 + UTILITY_HOLD_RECHECK_MS);
    const rendition = await t.run((ctx) => ctx.db.get(job.renditionId!));
    expect(rendition!.dispatchHeldAt).toBe(T0);
    expect((await dispatchTraces(t)).filter((m) => m.dispatchStatus === "deferred")).toEqual([
      expect.objectContaining({ reason: "approval_pending", chatKind: "converter" }),
    ]);
  });

  test("…and a job already traced on an earlier hold is not traced twice", async () => {
    const t = convexTest(schema, modules);
    const file = fileThatRaisesAnApproval(t);
    const job = await seedJob(t, { kind: "converter", attachment: file.blob, utilityHoldSince: T0 - MIN });
    file.arm();

    await dispatch(t, job.outboxId);

    expect(sends()).toBe(0);
    const row = await outbox(t, job.outboxId);
    // The hold keeps its origin; the stamp follows this check.
    expect(row!.utilityHoldSince).toBe(T0 - MIN);
    expect(row!.pendingSince).toBe(T0);
    expect(await scheduledDispatches(t)).toHaveLength(1);
    expect((await dispatchTraces(t)).filter((m) => m.dispatchStatus === "deferred")).toHaveLength(0);
  });
});

describe("the rendition timeout continues past a page of held conversions (codex review of lot A+B)", () => {
  test("50 re-armed renditions, then an expired one: the 51st is timed out, the page is never re-read at once", async () => {
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const chatId = await ctx.db.insert("chats", { userId, instanceName: INSTANCE, agentId: "olivier", updatedAt: 1 });
      const sourceStorageId = await ctx.storage.store(new Blob([new Uint8Array([1])]));
      const row = (dispatchHeldAt?: number) => ({
        sourceStorageId,
        chatId,
        userId,
        sourceFilename: "deck.pptx",
        sourceMimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        status: "pending" as const,
        converterInstance: INSTANCE,
        converterAgentId: "olivier",
        // Requested twice the timeout ago.
        createdAt: T0 - 10 * MIN,
        updatedAt: T0 - 10 * MIN,
        ...(dispatchHeldAt === undefined ? {} : { dispatchHeldAt }),
      });
      // A whole page of conversions a held turn re-armed just now…
      const held: Id<"fileRenditions">[] = [];
      for (let i = 0; i < 50; i++) held.push(await ctx.db.insert("fileRenditions", row(T0)));
      // …and, after them, one that has truly expired.
      const expired = await ctx.db.insert("fileRenditions", row());
      return { held, expired };
    });
    const lastHeld = await t.run((ctx) => ctx.db.get(ids.held[49]!));

    // The cron's own run: nothing of its page can be timed out.
    expect(await t.mutation(internal.fileRenditions.timeoutStaleRenditions, {})).toEqual({ failed: 0 });
    const continuations = (
      await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())
    ).filter((f) => f.name.includes("timeoutStaleRenditions") && f.state.kind === "pending");
    // ONE continuation, and PAST the page — never the same page again at once.
    expect(continuations).toHaveLength(1);
    expect((continuations[0]!.args[0] as { after?: number }).after).toBe(lastHeld!._creationTime);

    // The chain runs to its end (a loop would exhaust the iterations and throw).
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = async (id: Id<"fileRenditions">) => (await t.run((ctx) => ctx.db.get(id)))!;
    expect((await status(ids.expired)).status).toBe("failed");
    expect((await status(ids.expired)).failureReason).toBe("timeout");
    for (const id of ids.held) expect((await status(id)).status).toBe("pending");
  });
});

