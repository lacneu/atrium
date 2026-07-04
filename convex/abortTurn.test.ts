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
