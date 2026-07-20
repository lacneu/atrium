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

  test("provider_internal (transient upstream/network) is retryable, bound 2, same content gates", () => {
    expect(
      retryDecision({ ...base, errorKind: "provider_internal" }),
    ).toEqual({ attempt: 1, delayMs: RETRY_DELAY_MS[0] });
    expect(
      retryDecision({ ...base, errorKind: "provider_internal", lastAttempt: 1 }),
    ).toEqual({ attempt: 2, delayMs: RETRY_DELAY_MS[1] });
    // Bound: never past MAX (no infinite loop even on a dead provider).
    expect(
      retryDecision({
        ...base,
        errorKind: "provider_internal",
        lastAttempt: MAX_TURN_RETRIES,
      }),
    ).toBeNull();
    // Content gates hold: partial streamed text is never deleted-and-rerun.
    expect(
      retryDecision({ ...base, errorKind: "provider_internal", finalTextLen: 3 }),
    ).toBeNull();
    expect(
      retryDecision({ ...base, errorKind: "provider_internal", partCount: 1 }),
    ).toBeNull();
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

describe("provider_internal end-to-end (schedule -> visible stamp -> traces)", () => {
  test("a provider_internal finalize schedules the retry, stamps the visible countdown, and traces the chain", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const { chatId, assistantId } = await seedErroredTurn(t);
    await t.mutation(internal.stream.finalize, {
      messageId: assistantId,
      status: "error" as const,
      error: "The AI service returned an internal error. Please try again in a moment.",
      errorKind: "provider_internal",
    });
    // VISIBLE stamp: the error card's countdown source.
    const msg = await t.run((ctx) => ctx.db.get(assistantId));
    expect(msg?.status).toBe("error");
    expect(msg?.errorCode).toBe("provider_internal");
    expect(msg?.autoRetry).toMatchObject({ attempt: 1, maxAttempts: 2 });
    expect(msg?.autoRetry?.firesAt).toBeGreaterThan(Date.now());
    // TRACE: the schedule event with the failure nature.
    const traces = await t.run((ctx) => ctx.db.query("traceEvents").collect());
    const sched = traces.find(
      (e) => e.kind === "chat.auto_retry" && e.meta?.includes('"scheduled"'),
    );
    expect(sched).toBeDefined();
    expect(sched?.meta).toContain('"errorKind":"provider_internal"');
    // FIRE: the redispatch outcome closes the chain (message deleted, outbox rebuilt).
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS[0]! + 500);
    await t.finishInProgressScheduledFunctions();
    const after = await t.run(async (ctx) => ({
      msg: await ctx.db.get(assistantId),
      outbox: await ctx.db.query("outbox").collect(),
      traces: await ctx.db.query("traceEvents").collect(),
    }));
    expect(after.msg).toBeNull(); // the empty error card was consumed by the re-run
    expect(after.outbox.some((o) => o.autoRetryAttempt === 1)).toBe(true);
    const fired = after.traces.find(
      (e) => e.kind === "chat.auto_retry" && e.meta?.includes('"redispatch"'),
    );
    expect(fired).toBeDefined();
    vi.useRealTimers();
  });

  test("a stand-down (user sent meanwhile) CLEARS the visible stamp and traces its reason", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const { chatId, assistantId, userId } = await seedErroredTurn(t);
    await t.mutation(internal.stream.finalize, {
      messageId: assistantId,
      status: "error" as const,
      error: "read ECONNRESET",
      errorKind: "provider_internal",
    });
    // The user moves on before the retry fires: a new pending outbox row.
    await t.run(async (ctx) => {
      await ctx.db.insert("outbox", {
        chatId,
        userId,
        clientMessageId: "user-moved-on",
        text: "autre question",
        attachmentIds: [],
        status: "pending" as const,
      });
    });
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS[0]! + 500);
    await t.finishInProgressScheduledFunctions();
    const after = await t.run(async (ctx) => ({
      msg: await ctx.db.get(assistantId),
      traces: await ctx.db.query("traceEvents").collect(),
    }));
    expect(after.msg?.status).toBe("error"); // card stands (honest)
    expect(after.msg?.autoRetry).toBeUndefined(); // countdown cleared — no false promise
    const stood = after.traces.find(
      (e) => e.kind === "chat.auto_retry" && e.meta?.includes('"stand_down"'),
    );
    expect(stood?.meta).toContain('"chat_busy"');
    vi.useRealTimers();
  });

  test("EXHAUSTED retries trace the honest terminal (the retry did NOT fix it)", async () => {
    const t = convexTest(schema, modules);
    const { assistantId } = await seedErroredTurn(t, { sentAttempt: 2 });
    await t.mutation(internal.stream.finalize, {
      messageId: assistantId,
      status: "error" as const,
      error: "fetch failed",
      errorKind: "provider_internal",
    });
    const traces = await t.run((ctx) => ctx.db.query("traceEvents").collect());
    const exhausted = traces.find(
      (e) => e.kind === "chat.auto_retry" && e.meta?.includes('"exhausted"'),
    );
    expect(exhausted).toBeDefined();
    const msg = await t.run((ctx) => ctx.db.get(assistantId));
    expect(msg?.autoRetry).toBeUndefined(); // no countdown when nothing is coming
  });
});

describe("part gate refinement (provenance/MoA marker never block; real work does)", () => {
  test("a provenance part (injected-context report, the prod shape) does NOT block the retry", async () => {
    const t = convexTest(schema, modules);
    const { assistantId } = await seedErroredTurn(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("messageParts", {
        messageId: assistantId,
        order: 0,
        part: {
          kind: "provenance" as const,
          v: 1,
          pluginId: "openclaw-knowledge",
          source: "knowledge",
          group: "documents" as const,
          items: [],
        },
      });
    });
    await t.mutation(internal.stream.finalize, {
      messageId: assistantId,
      status: "error" as const,
      error: "The AI service returned an internal error. Please try again in a moment.",
      errorKind: "provider_internal",
    });
    const msg = await t.run((ctx) => ctx.db.get(assistantId));
    expect(msg?.autoRetry).toMatchObject({ attempt: 1 }); // scheduled
  });

  test("a REAL tool part (billed work) still blocks", async () => {
    const t = convexTest(schema, modules);
    const { assistantId } = await seedErroredTurn(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("messageParts", {
        messageId: assistantId,
        order: 0,
        part: { kind: "tool" as const, name: "web_search", phase: "completed" },
      });
    });
    await t.mutation(internal.stream.finalize, {
      messageId: assistantId,
      status: "error" as const,
      error: "read ECONNRESET",
      errorKind: "provider_internal",
    });
    const msg = await t.run((ctx) => ctx.db.get(assistantId));
    expect(msg?.autoRetry).toBeUndefined(); // no retry: real work present
  });
});

describe("codex hardening round (MoA gate, parts cascade)", () => {
  const moaPart = {
    kind: "tool" as const,
    name: "mixture_of_agents",
    phase: "completed",
  };
  async function seedWithMoa(
    t: ReturnType<typeof convexTest>,
    child: { status: "error" | "done"; resultText?: string } | null,
  ) {
    const seeded = await seedErroredTurn(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("messageParts", {
        messageId: seeded.assistantId,
        order: 0,
        part: moaPart,
      });
      if (child) {
        await ctx.db.insert("subAgents", {
          chatId: seeded.chatId,
          parentMessageId: seeded.assistantId,
          childSessionKey: "hermes:moa:child-1",
          status: child.status,
          ...(child.resultText ? { resultText: child.resultText } : {}),
          createdAt: 1,
          updatedAt: 2,
        });
      }
    });
    await t.mutation(internal.stream.finalize, {
      messageId: seeded.assistantId,
      status: "error" as const,
      error: "fetch failed",
      errorKind: "provider_internal",
    });
    return seeded;
  }

  test("MoA marker + a dead child that RAN A TOOL -> blocked (tool activity = real work, codex P1)", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedErroredTurn(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("messageParts", {
        messageId: seeded.assistantId,
        order: 0,
        part: moaPart,
      });
      await ctx.db.insert("subAgents", {
        chatId: seeded.chatId,
        parentMessageId: seeded.assistantId,
        childSessionKey: "hermes:moa:child-t",
        status: "error" as const,
        createdAt: 1,
        updatedAt: 2,
      });
      await ctx.db.insert("subAgentToolParts", {
        chatId: seeded.chatId,
        childSessionKey: "hermes:moa:child-t",
        toolCallId: "t1",
        name: "web_search",
        status: "done" as const,
        updatedAt: 2,
      });
    });
    await t.mutation(internal.stream.finalize, {
      messageId: seeded.assistantId,
      status: "error" as const,
      error: "fetch failed",
      errorKind: "provider_internal",
    });
    const msg = await t.run((ctx) => ctx.db.get(seeded.assistantId));
    expect(msg?.autoRetry).toBeUndefined();
  });

  test("MoA marker with NO observed children -> blocked (async observer lag is not evidence, codex P1)", async () => {
    const t = convexTest(schema, modules);
    const { assistantId } = await seedWithMoa(t, null);
    const msg = await t.run((ctx) => ctx.db.get(assistantId));
    expect(msg?.autoRetry).toBeUndefined();
  });

  test("an allowed MoA retry CASCADES the dead children rows (codex P2)", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const { assistantId, chatId } = await seedWithMoa(t, { status: "error" });
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS[0]! + 500);
    await t.finishInProgressScheduledFunctions();
    const after = await t.run(async (ctx) => ({
      msg: await ctx.db.get(assistantId),
      children: (
        await ctx.db
          .query("subAgents")
          .withIndex("by_chat", (q) => q.eq("chatId", chatId))
          .collect()
      ).filter((c) => c.parentMessageId === assistantId).length,
    }));
    expect(after.msg).toBeNull();
    expect(after.children).toBe(0); // no stale child state after the re-run
    vi.useRealTimers();
  });

  test("MoA marker + every child dead-and-fruitless -> retry allowed (the connect-failure shape)", async () => {
    const t = convexTest(schema, modules);
    const { assistantId } = await seedWithMoa(t, { status: "error" });
    const msg = await t.run((ctx) => ctx.db.get(assistantId));
    expect(msg?.autoRetry).toMatchObject({ attempt: 1 });
  });

  test("MoA marker + a child that DELIVERED work -> retry blocked (codex P1: no re-run of billed work)", async () => {
    const t = convexTest(schema, modules);
    const { assistantId } = await seedWithMoa(t, {
      status: "done",
      resultText: "rapport de référence",
    });
    const msg = await t.run((ctx) => ctx.db.get(assistantId));
    expect(msg?.autoRetry).toBeUndefined();
  });

  test("the redispatch CASCADES the card's parts (codex P2: no orphaned provenance rows)", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const { assistantId } = await seedErroredTurn(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("messageParts", {
        messageId: assistantId,
        order: 0,
        part: {
          kind: "provenance" as const,
          v: 1,
          pluginId: "openclaw-knowledge",
          source: "knowledge",
          group: "documents" as const,
          items: [],
        },
      });
    });
    await t.mutation(internal.stream.finalize, {
      messageId: assistantId,
      status: "error" as const,
      error: "read ECONNRESET",
      errorKind: "provider_internal",
    });
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS[0]! + 500);
    await t.finishInProgressScheduledFunctions();
    const after = await t.run(async (ctx) => ({
      msg: await ctx.db.get(assistantId),
      orphans: (
        await ctx.db
          .query("messageParts")
          .withIndex("by_message", (q) => q.eq("messageId", assistantId))
          .collect()
      ).length,
    }));
    expect(after.msg).toBeNull();
    expect(after.orphans).toBe(0); // parts cascaded with the card
    vi.useRealTimers();
  });
});
