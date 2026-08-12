import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

// The STOP button (chat.abort chain, Convex half): abortTurn settles the
// chat's streaming assistant message through the SAME internal finalize the
// gateway path uses (text streamed so far kept, queue drained) and schedules
// the best-effort bridge kill. The bridge/gateway halves are covered by the
// bridge suite; here we pin ownership, the no-active-turn answer, and the
// optimistic settle.

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function seedChatWithStreaming(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", {
      userId,
      role: "user" as const,
      canonical: "u",
    });
    const chatId = await ctx.db.insert("chats", {
      userId,
      updatedAt: 1,
      instanceName: "prod",
      agentId: "main",
    });
    const messageId = await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "assistant" as const,
      status: "streaming" as const,
      text: "",
      liveText: "réponse partielle déjà str",
      updatedAt: 1,
    });
    return { userId, chatId, messageId };
  });
}

describe("messages.abortTurn (stop button)", () => {
  test("settles the streaming message as aborted, keeping the partial text", async () => {
    const t = convexTest(schema);
    const { userId, chatId, messageId } = await seedChatWithStreaming(t);
    const asUser = t.withIdentity({ subject: `${userId}|session` });
    const res = await asUser.mutation(api.messages.abortTurn, { chatId });
    expect(res.ok).toBe(true);
    // The finalize + bridge kill are scheduled (0 ms) — run them. The bridge
    // POST inside dispatchAbort fails fast in tests (no BRIDGE_SHARED_SECRET),
    // which is exactly the log-only best-effort contract.
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const msg = await t.run((ctx) => ctx.db.get(messageId));
    expect(msg?.status).toBe("aborted");
    expect(msg?.text).toBe("réponse partielle déjà str"); // streamed text kept
  });

  test("a LATE gateway final never overwrites the user's abort (first terminal wins)", async () => {
    const t = convexTest(schema);
    const { userId, chatId, messageId } = await seedChatWithStreaming(t);
    const asUser = t.withIdentity({ subject: `${userId}|session` });
    await asUser.mutation(api.messages.abortTurn, { chatId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    // The gateway finished anyway (kill lost the race): its final lands late.
    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "complete",
      text: "réponse complète non voulue",
    });
    const msg = await t.run((ctx) => ctx.db.get(messageId));
    expect(msg?.status).toBe("aborted"); // the stop is FINAL
    expect(msg?.text).toBe("réponse partielle déjà str");
  });

  test("a reply that COMPLETED before the kill landed is never repainted as interrupted", async () => {
    const t = convexTest(schema);
    const { userId, chatId, messageId } = await seedChatWithStreaming(t);
    const asUser = t.withIdentity({ subject: `${userId}|session` });
    await asUser.mutation(api.messages.abortTurn, { chatId });
    // The gateway's final WINS the race (lands before the scheduled kill+settle).
    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "complete",
      text: "réponse complète livrée",
    });
    // Now the kill chain's guaranteed-settle finalize(aborted) arrives late.
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const msg = await t.run((ctx) => ctx.db.get(messageId));
    expect(msg?.status).toBe("complete"); // the delivered answer stays
    expect(msg?.text).toBe("réponse complète livrée");
  });

  test("no active turn -> honest no-op result", async () => {
    const t = convexTest(schema);
    const { userId, chatId, messageId } = await seedChatWithStreaming(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(messageId, { status: "complete" as const });
    });
    const asUser = t.withIdentity({ subject: `${userId}|session` });
    const res = await asUser.mutation(api.messages.abortTurn, { chatId });
    expect(res).toEqual({ ok: false, reason: "no_active_turn" });
  });

  test("a foreign user cannot abort someone else's chat", async () => {
    const t = convexTest(schema);
    const { chatId } = await seedChatWithStreaming(t);
    const intruderId = await t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId: uid,
        role: "user" as const,
        canonical: "intrus",
      });
      return uid;
    });
    const asIntruder = t.withIdentity({ subject: `${intruderId}|session` });
    await expect(
      asIntruder.mutation(api.messages.abortTurn, { chatId }),
    ).rejects.toThrow();
  });
});

// STOP MEANS THE WHOLE CONVERSATION.
//
// The case Fabien reported: a parent that delegated has SETTLED — it wrote its
// sentence and finished — while its children go on working, sometimes for
// hours. Keyed on the streaming message alone, Stop answered "no active turn",
// killed nothing, and the button had already vanished.
describe("messages.abortTurn stops delegated work too", () => {
  /** A settled parent whose sub-agent is still running — no streaming message. */
  async function seedSettledParentWithRunningChild(
    t: ReturnType<typeof convexTest>,
    opts: { instanceName?: string; childKey?: string } = {},
  ) {
    return t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId,
        role: "user" as const,
        canonical: "u",
      });
      const chatId = await ctx.db.insert("chats", {
        userId,
        updatedAt: 1,
        instanceName: "prod",
        agentId: "main",
      });
      const parentId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "Sous-agent lancé.",
        updatedAt: 1,
      });
      // FRESH: `turnActivity` treats a running row untouched for longer than the
      // reaper's TTL as stale and stops reporting it. A row stamped at the epoch
      // is a state production never produces — and it would make the signal read
      // "idle" before the Stop, so the assertion below would pass for the wrong
      // reason.
      const childId = await ctx.db.insert("subAgents", {
        chatId,
        userId,
        parentMessageId: parentId,
        childSessionKey: opts.childKey ?? "agent:files:subagent:abc-123",
        status: "running" as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...(opts.instanceName ? { instanceName: opts.instanceName } : {}),
      });
      return { userId, chatId, parentId, childId };
    });
  }

  test("a settled parent with a running child is NOT 'no active turn'", async () => {
    const t = convexTest(schema);
    const { userId, chatId } = await seedSettledParentWithRunningChild(t);
    const asUser = t.withIdentity({ subject: `${userId}|s` });
    const res = await asUser.mutation(api.messages.abortTurn, { chatId });
    expect(res.ok, "the button had nothing to press before this").toBe(true);
  });

  test("the child goes terminal IN THE MUTATION, not on the gateway's word", async () => {
    const t = convexTest(schema);
    const { userId, chatId, childId } = await seedSettledParentWithRunningChild(t);
    const asUser = t.withIdentity({ subject: `${userId}|s` });
    await asUser.mutation(api.messages.abortTurn, { chatId });
    const child = await t.run(async (ctx) => ctx.db.get(childId));
    expect(child?.status, "left running, the indicators keep insisting").toBe(
      "aborted",
    );
  });

  // THE user-visible promise: whoever pressed Stop is watching the clock and the
  // "a sub-agent is working" line. Both read turnActivity.
  test("the activity signal is OFF immediately after the stop", async () => {
    const t = convexTest(schema);
    const { userId, chatId } = await seedSettledParentWithRunningChild(t);
    const asUser = t.withIdentity({ subject: `${userId}|s` });
    const before = await asUser.query(api.subAgents.turnActivity, { chatId });
    expect(before.running, "precondition: work was live").toBe(true);
    await asUser.mutation(api.messages.abortTurn, { chatId });
    const after = await asUser.query(api.subAgents.turnActivity, { chatId });
    expect(after.running, "the clock must stop the moment Stop is pressed").toBe(
      false,
    );
  });

  test("the block that carried the work is MARKED, and its reply is untouched", async () => {
    const t = convexTest(schema);
    const { userId, chatId, parentId } = await seedSettledParentWithRunningChild(t);
    const asUser = t.withIdentity({ subject: `${userId}|s` });
    await asUser.mutation(api.messages.abortTurn, { chatId });
    const parent = await t.run(async (ctx) => ctx.db.get(parentId));
    expect(parent?.interruptedAt, "nothing says the rest was cut short").toBeTypeOf(
      "number",
    );
    expect(parent?.status, "a settled reply stays settled").toBe("complete");
    expect(parent?.text, "what the agent did say stands").toBe(
      "Sous-agent lancé.",
    );
  });

  test("every running child is stopped, not just the first", async () => {
    const t = convexTest(schema);
    const { userId, chatId } = await seedSettledParentWithRunningChild(t);
    await t.run(async (ctx) => {
      const chat = await ctx.db.get(chatId);
      for (const key of ["agent:a:subagent:two", "agent:b:subagent:three"]) {
        await ctx.db.insert("subAgents", {
          chatId,
          userId: chat!.userId,
          childSessionKey: key,
          status: "running" as const,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
    });
    const asUser = t.withIdentity({ subject: `${userId}|s` });
    const res = await asUser.mutation(api.messages.abortTurn, { chatId });
    expect(res.ok).toBe(true);
    const stillRunning = await t.run(async (ctx) =>
      ctx.db
        .query("subAgents")
        .withIndex("by_chat_status", (q) =>
          q.eq("chatId", chatId).eq("status", "running"),
        )
        .collect(),
    );
    expect(stillRunning, "one survivor is two hours of work the user refused").toEqual(
      [],
    );
  });

  test("the follow-up parked behind the stopped work is released", async () => {
    // This branch has no message to finalize, and finalize is what normally
    // drains. Without an explicit drain the queued message stays `queued` for
    // ever — not "visibly failed", simply stuck behind work that no longer
    // exists.
    const t = convexTest(schema);
    const { userId, chatId } = await seedSettledParentWithRunningChild(t);
    const outboxId = await t.run(async (ctx) =>
      ctx.db.insert("outbox", {
        chatId,
        userId,
        text: "et sinon, autre chose",
        status: "queued" as const,
        clientMessageId: "cm-queued-1",
        attachmentIds: [],
      }),
    );
    const asUser = t.withIdentity({ subject: `${userId}|s` });
    await asUser.mutation(api.messages.abortTurn, { chatId });
    const row = await t.run(async (ctx) => ctx.db.get(outboxId));
    expect(row?.status, "a message held behind stopped work must go out").not.toBe(
      "queued",
    );
  });

  test("a chat with nothing running still answers 'no active turn'", async () => {
    const t = convexTest(schema);
    const { userId, chatId, childId } = await seedSettledParentWithRunningChild(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(childId, { status: "done" as const });
    });
    const asUser = t.withIdentity({ subject: `${userId}|s` });
    const res = await asUser.mutation(api.messages.abortTurn, { chatId });
    expect(res.ok).toBe(false);
  });
});

// WHAT A STOP MUST NOT DO.
describe("a stop is honest about what it stopped", () => {
  test("a background TASK is not claimed as stopped when it cannot be", async () => {
    // `chat.abort` names provider SESSIONS. A task row's key is a registry
    // correlator, so there is nothing to name — marking it `aborted` would tell
    // the user the work is over while it goes on spending and delivers later.
    const t = convexTest(schema);
    const { userId, chatId, taskRowId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId,
        role: "user" as const,
        canonical: "u",
      });
      const chatId = await ctx.db.insert("chats", {
        userId,
        updatedAt: 1,
        instanceName: "prod",
        agentId: "main",
      });
      const taskRowId = await ctx.db.insert("subAgents", {
        chatId,
        userId,
        childSessionKey: "task:t-42",
        kind: "task" as const,
        status: "running" as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.insert("subAgents", {
        chatId,
        userId,
        childSessionKey: "agent:files:subagent:killable",
        status: "running" as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return { userId, chatId, taskRowId };
    });
    const asUser = t.withIdentity({ subject: `${userId}|s` });
    await asUser.mutation(api.messages.abortTurn, { chatId });
    const task = await t.run(async (ctx) => ctx.db.get(taskRowId));
    expect(
      task?.status,
      "claiming a task stopped is worse than admitting it was not",
    ).toBe("running");
  });


  test("a kill that could never be SENT hands the child back to running", async () => {
    // The row is terminalized optimistically — that is what makes the clock go
    // out at once. But when no routing target exists for that child (revoked
    // grant, utility agent, unresolvable instance) nothing was attempted and the
    // child is still spending. Leaving it terminal would hide live work behind a
    // button that has since disappeared.
    const t = convexTest(schema);
    const { chatId, userId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const chatId = await ctx.db.insert("chats", {
        userId,
        updatedAt: 1,
        instanceName: "prod",
        agentId: "main",
      });
      return { chatId, userId };
    });
    const rowId = await t.run(async (ctx) =>
      ctx.db.insert("subAgents", {
        chatId,
        userId,
        childSessionKey: "agent:revoked:subagent:x",
        status: "aborted" as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await t.mutation(internal.subAgents.restoreRunningAfterFailedKill, {
      childRowId: rowId,
    });
    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    expect(row?.status, "a child nobody could reach is not 'stopped'").toBe(
      "running",
    );
  });

  test("a child that reached a REAL terminal state is not resurrected", async () => {
    const t = convexTest(schema);
    const { chatId, userId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const chatId = await ctx.db.insert("chats", {
        userId,
        updatedAt: 1,
        instanceName: "prod",
        agentId: "main",
      });
      return { chatId, userId };
    });
    const rowId = await t.run(async (ctx) =>
      ctx.db.insert("subAgents", {
        chatId,
        userId,
        childSessionKey: "agent:a:subagent:done",
        status: "done" as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await t.mutation(internal.subAgents.restoreRunningAfterFailedKill, {
      childRowId: rowId,
    });
    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    expect(row?.status, "its own frame landed — that wins").toBe("done");
  });
});

// A BACKGROUND TASK OUTLIVES THE REPLY IT CAME FROM.
//
// Production, 2026-08-08: a bubble whose text had been final for two days showed
// a spinner and "47 h 08 min". Nothing was stuck — a background task launched by
// that turn was genuinely still running, and the clock is the TASK'S age. Shown
// under a settled reply it answers a question nobody asked, and reads as "your
// answer has been in progress for two days".
describe("a detached task keeps the signal but loses the clock", () => {
  async function seedSettledReplyWithRunningTask(
    t: ReturnType<typeof convexTest>,
    parentStatus: "complete" | "streaming",
  ) {
    return t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId,
        role: "user" as const,
        canonical: "u",
      });
      const chatId = await ctx.db.insert("chats", {
        userId,
        updatedAt: 1,
        instanceName: "prod",
        agentId: "main",
      });
      const parentId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: parentStatus,
        text: "Voici la recette.",
        updatedAt: Date.now(),
      });
      // FRESH updatedAt: a task polled seconds ago is the production shape — a
      // stale row would make the signal read "idle" and pass for the wrong reason.
      await ctx.db.insert("subAgents", {
        chatId,
        userId,
        parentMessageId: parentId,
        childSessionKey: "task:8074f478-9142-420e-88fa-e473ea4c27e4",
        kind: "task" as const,
        taskName: "image_generate",
        status: "running" as const,
        createdAt: Date.now() - 47 * 60 * 60 * 1000,
        updatedAt: Date.now() - 19_000,
      });
      return { userId, chatId };
    });
  }

  test("under a SETTLED reply: still working, but no duration is offered", async () => {
    const t = convexTest(schema);
    const { userId, chatId } = await seedSettledReplyWithRunningTask(
      t,
      "complete",
    );
    const asUser = t.withIdentity({ subject: `${userId}|s` });
    const a = await asUser.query(api.subAgents.turnActivity, { chatId });
    // The work is real and must keep being announced.
    expect(a.running, "the reader is told nothing is happening").toBe(true);
    expect(
      a.detachedTask,
      "the task's age is presented as this turn's duration",
    ).toBe(true);
  });

  test("under a STREAMING reply: that IS the turn, and it keeps its clock", async () => {
    const t = convexTest(schema);
    const { userId, chatId } = await seedSettledReplyWithRunningTask(
      t,
      "streaming",
    );
    const asUser = t.withIdentity({ subject: `${userId}|s` });
    const a = await asUser.query(api.subAgents.turnActivity, { chatId });
    expect(a.running).toBe(true);
    expect(
      a.detachedTask,
      "a turn still being composed lost the duration it is entitled to",
    ).toBe(false);
  });
});
