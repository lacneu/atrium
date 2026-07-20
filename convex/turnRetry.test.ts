import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import {
  retryDecision,
  MAX_TURN_RETRIES,
  RETRY_DELAY_MS,
  SESSION_INIT_CONFLICT_CODE,
} from "./turnRetry";

const modules = import.meta.glob("./**/*.ts");

// Bounded auto-retry of a turn the gateway failed with the TRANSIENT
// session-init OCC conflict (live incident 2026-07-09). The retry IS the manual
// delete+regenerate done for the user — so the discriminating tests are the
// GUARDS (a retry that fires when the user moved on would corrupt the thread)
// and the BOUND (an unbounded retry on a persistent conflict is a loop).

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("retryDecision (pure gate/bound logic)", () => {
  const base = {
    status: "error",
    errorKind: SESSION_INIT_CONFLICT_CODE,
    finalTextLen: 0,
    partCount: 0,
    chatBusy: false,
    lastAttempt: 0,
  };

  test("the conflict on a zero-content idle turn schedules attempt 1 at the base delay", () => {
    expect(retryDecision(base)).toEqual({ attempt: 1, delayMs: RETRY_DELAY_MS[0] });
  });

  test("attempt 1 already ran -> attempt 2 at the longer delay; MAX exhausts", () => {
    expect(retryDecision({ ...base, lastAttempt: 1 })).toEqual({
      attempt: 2,
      delayMs: RETRY_DELAY_MS[1],
    });
    expect(retryDecision({ ...base, lastAttempt: MAX_TURN_RETRIES })).toBeNull();
  });

  test("empty_response_silent (zero-work clean close) is retryable; worked empty_response is NOT", () => {
    // The Fabien class (prod 2026-07-19 ×3): the gateway closes the run
    // cleanly with nothing — zero content AND zero work, so an automatic
    // re-dispatch bills nothing and usually succeeds (his manual re-send did).
    expect(
      retryDecision({ ...base, errorKind: "empty_response_silent" }),
    ).toEqual({ attempt: 1, delayMs: RETRY_DELAY_MS[0] });
    // TIGHTER bound than the conflict class: a silent close already billed a
    // completion, so exactly ONE automatic re-dispatch (the user's own manual
    // re-send equivalent) — never two.
    expect(
      retryDecision({
        ...base,
        errorKind: "empty_response_silent",
        lastAttempt: 1,
      }),
    ).toBeNull();
    expect(
      retryDecision({
        ...base,
        errorKind: "empty_response_silent",
        finalTextLen: 5,
      }),
    ).toBeNull();
    // The WORKED empty class must never auto-rerun (a billed media generation
    // whose delivery dropped would be duplicated — codex P1).
    expect(retryDecision({ ...base, errorKind: "empty_response" })).toBeNull();
  });

  test("every disqualifying gate stands down", () => {
    expect(retryDecision({ ...base, status: "complete" })).toBeNull();
    expect(retryDecision({ ...base, errorKind: "context_length" })).toBeNull();
    expect(retryDecision({ ...base, errorKind: null })).toBeNull();
    // Visible content: the turn did real work — deleting it would lose it.
    expect(retryDecision({ ...base, finalTextLen: 12 })).toBeNull();
    expect(retryDecision({ ...base, partCount: 1 })).toBeNull();
    // A queued follow-up drained / is pending: the user moved on.
    expect(retryDecision({ ...base, chatBusy: true })).toBeNull();
  });
});

async function seedErroredTurn(
  t: ReturnType<typeof convexTest>,
  opts?: {
    routed?: boolean;
    sentAttempt?: number;
    outboxStatus?: "sent" | "pending";
    chatKind?: "documentary";
  },
) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", {
      userId,
      role: "user" as const,
      canonical: "jnl",
    });
    const chatId = await ctx.db.insert("chats", {
      userId,
      updatedAt: 1,
      instanceName: "ataraxis",
      agentId: "jerome",
      ...(opts?.chatKind ? { kind: opts.chatKind } : {}),
    });
    const userMsgId = await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "user" as const,
      status: "complete" as const,
      text: "Tu sais quelle heure il est ?",
      updatedAt: 1,
      ...(opts?.routed
        ? { routedInstanceName: "ataraxis", routedAgentId: "jerome" }
        : {}),
    });
    // The turn's outbox row — carries the attempt count the NEXT finalize reads
    // to bound the chain. Default "sent"; the pending-race tests seed "pending"
    // (the live incident shape: the error beat the dispatch's sent-flip).
    const outboxId = await ctx.db.insert("outbox", {
      chatId,
      userId,
      clientMessageId: "orig-1",
      messageId: userMsgId,
      text: "Tu sais quelle heure il est ?",
      attachmentIds: [],
      status: (opts?.outboxStatus ?? "sent") as "sent" | "pending",
      ...(opts?.sentAttempt !== undefined
        ? { autoRetryAttempt: opts.sentAttempt }
        : {}),
    });
    // The assistant turn, still streaming (finalize flips it in the test body).
    const assistantId = await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "assistant" as const,
      status: "streaming" as const,
      text: "",
      runId: "webchat-run-1",
      updatedAt: 2,
    });
    return { userId, chatId, userMsgId, assistantId, outboxId };
  });
}

async function finalizeConflict(
  t: ReturnType<typeof convexTest>,
  messageId: Id<"messages">,
) {
  await t.mutation(internal.stream.finalize, {
    messageId,
    status: "error" as const,
    error:
      "Error: reply session initialization conflicted for agent:jerome:atrium:chat:jnl:mh7abc",
    errorKind: SESSION_INIT_CONFLICT_CODE,
  });
}

describe("finalize -> autoRetryTurn (the automatic delete+regenerate)", () => {
  test("happy path: the empty error card is dropped and a stamped retry outbox row rides dispatchReset", async () => {
    const t = convexTest(schema, modules);
    const { chatId, userMsgId, assistantId } = await seedErroredTurn(t, {
      routed: true,
    });
    await finalizeConflict(t, assistantId);
    // The retry is scheduled at +5s; run the chain (dispatchReset fail-fasts in
    // tests — no BRIDGE_SHARED_SECRET — which exercises its fail-SAFE contract).
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const state = await t.run(async (ctx) => {
      const gone = await ctx.db.get(assistantId);
      const rows = await ctx.db
        .query("outbox")
        .withIndex("by_chat_status", (q) => q.eq("chatId", chatId))
        .collect();
      return { gone, rows };
    });
    // The empty error card was deleted (nothing visible lost — it was empty).
    expect(state.gone).toBeNull();
    // A retry outbox row exists: attempt-stamped, keyed to never dedupe against
    // the original, re-routed to the SAME per-turn agent.
    const retryRows = state.rows.filter((r) => r.autoRetryAttempt === 1);
    expect(retryRows.length).toBe(1);
    const retry = retryRows[0]!;
    expect(retry.clientMessageId.startsWith(`autoretry-${userMsgId}-1-`)).toBe(true);
    expect(retry.text).toBe("Tu sais quelle heure il est ?");
    expect(retry.messageId).toBe(userMsgId);
    expect(retry.routedAgent).toEqual({
      instanceName: "ataraxis",
      agentId: "jerome",
    });
  });

  test("a NEW user message during the backoff window stands the retry down (no deletion, no row)", async () => {
    const t = convexTest(schema, modules);
    const { chatId, userId, assistantId } = await seedErroredTurn(t);
    await finalizeConflict(t, assistantId);
    // The user moved on before the +5s retry fired.
    await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        chatId: chatId,
        userId: userId,
        role: "user" as const,
        status: "complete" as const,
        text: "autre question",
        updatedAt: 3,
      });
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const state = await t.run(async (ctx) => {
      const kept = await ctx.db.get(assistantId);
      const rows = await ctx.db
        .query("outbox")
        .withIndex("by_chat_status", (q) => q.eq("chatId", chatId))
        .collect();
      return { kept, rows };
    });
    // The error card STAYS (honest state) and no retry row was built.
    expect(state.kept).not.toBeNull();
    expect(state.rows.some((r) => r.autoRetryAttempt !== undefined)).toBe(false);
  });

  test("a turn that streamed real text keeps its honest error card (no retry)", async () => {
    const t = convexTest(schema, modules);
    const { chatId, assistantId } = await seedErroredTurn(t);
    await t.mutation(internal.stream.finalize, {
      messageId: assistantId,
      status: "error" as const,
      text: "réponse partielle avant l'erreur",
      error:
        "Error: reply session initialization conflicted for agent:jerome:atrium:chat:jnl:mh7abc",
      errorKind: SESSION_INIT_CONFLICT_CODE,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const state = await t.run(async (ctx) => {
      const kept = await ctx.db.get(assistantId);
      const rows = await ctx.db
        .query("outbox")
        .withIndex("by_chat_status", (q) => q.eq("chatId", chatId))
        .collect();
      return { kept, rows };
    });
    expect(state.kept?.status).toBe("error");
    expect(state.kept?.text).toBe("réponse partielle avant l'erreur");
    expect(state.rows.some((r) => r.autoRetryAttempt !== undefined)).toBe(false);
  });

  test("the chain is BOUNDED: a sent row already at MAX attempts schedules nothing", async () => {
    const t = convexTest(schema, modules);
    const { chatId, assistantId } = await seedErroredTurn(t, {
      sentAttempt: MAX_TURN_RETRIES,
    });
    await finalizeConflict(t, assistantId);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const state = await t.run(async (ctx) => {
      const kept = await ctx.db.get(assistantId);
      const rows = await ctx.db
        .query("outbox")
        .withIndex("by_chat_status", (q) => q.eq("chatId", chatId))
        .collect();
      return { kept, rows };
    });
    // Retries exhausted -> the honest final error card stays.
    expect(state.kept?.status).toBe("error");
    expect(state.kept?.errorCode).toBe(SESSION_INIT_CONFLICT_CODE);
    expect(
      state.rows.some((r) => r.autoRetryAttempt === MAX_TURN_RETRIES + 1),
    ).toBe(false);
  });

  test("PENDING-RACE (the live incident shape): the error beating the sent-flip still schedules the retry", async () => {
    // Live trace 2026-07-09: assistant finalize error at t, dispatch sent-flip at
    // t+190ms — at finalize time the turn's OWN outbox row is still `pending`.
    // Blocking on it would kill the retry in exactly the case it exists for.
    const t = convexTest(schema, modules);
    const { chatId, assistantId, outboxId } = await seedErroredTurn(t, {
      outboxStatus: "pending",
    });
    await finalizeConflict(t, assistantId);
    // The dispatch action completes ~200ms later (long before the +5s fire).
    await t.run(async (ctx) => {
      await ctx.db.patch(outboxId, { status: "sent" as const });
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const state = await t.run(async (ctx) => {
      const gone = await ctx.db.get(assistantId);
      const rows = await ctx.db
        .query("outbox")
        .withIndex("by_chat_status", (q) => q.eq("chatId", chatId))
        .collect();
      return { gone, rows };
    });
    expect(state.gone).toBeNull(); // the retry DID run
    expect(state.rows.filter((r) => r.autoRetryAttempt === 1).length).toBe(1);
  });

  test("BOUND holds through the pending race: a retry row still pending at ITS failure is the attempt source", async () => {
    // The retry (attempt 1) errors fast too — its own row is still pending. The
    // attempt count must come from that newest PENDING row (1 → schedule 2), not
    // fall back to the original SENT row (0 → ping-pong past MAX).
    const t = convexTest(schema, modules);
    const { chatId, assistantId } = await seedErroredTurn(t, {
      outboxStatus: "pending",
      sentAttempt: MAX_TURN_RETRIES, // the pending row IS the MAXth retry's row
    });
    await finalizeConflict(t, assistantId);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const state = await t.run(async (ctx) => {
      const kept = await ctx.db.get(assistantId);
      const rows = await ctx.db
        .query("outbox")
        .withIndex("by_chat_status", (q) => q.eq("chatId", chatId))
        .collect();
      return { kept, rows };
    });
    // Exhausted: the honest error card stays; no attempt MAX+1 row exists.
    expect(state.kept?.status).toBe("error");
    expect(
      state.rows.some(
        (r) => (r.autoRetryAttempt ?? 0) > MAX_TURN_RETRIES,
      ),
    ).toBe(false);
  });

  test("a UTILITY chat (documentary) never auto-retries — its own failure handling stays authoritative", async () => {
    const t = convexTest(schema, modules);
    const { chatId, assistantId } = await seedErroredTurn(t, {
      chatKind: "documentary",
    });
    await finalizeConflict(t, assistantId);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const state = await t.run(async (ctx) => {
      const kept = await ctx.db.get(assistantId);
      const rows = await ctx.db
        .query("outbox")
        .withIndex("by_chat_status", (q) => q.eq("chatId", chatId))
        .collect();
      return { kept, rows };
    });
    expect(state.kept?.status).toBe("error"); // untouched
    expect(state.rows.some((r) => r.autoRetryAttempt !== undefined)).toBe(false);
  });

  test("a generic gateway error (no conflict code) never triggers the machinery", async () => {
    const t = convexTest(schema, modules);
    const { chatId, assistantId } = await seedErroredTurn(t);
    await t.mutation(internal.stream.finalize, {
      messageId: assistantId,
      status: "error" as const,
      error: "some other gateway failure",
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const state = await t.run(async (ctx) => {
      const kept = await ctx.db.get(assistantId);
      const rows = await ctx.db
        .query("outbox")
        .withIndex("by_chat_status", (q) => q.eq("chatId", chatId))
        .collect();
      return { kept, rows };
    });
    expect(state.kept?.status).toBe("error");
    expect(state.rows.some((r) => r.autoRetryAttempt !== undefined)).toBe(false);
  });
});
