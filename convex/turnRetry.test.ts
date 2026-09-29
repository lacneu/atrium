import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import {
  retryDecision,
  MAX_TURN_RETRIES,
  RETRY_DELAY_MS,
  RETRYABLE_KINDS,
  maxRetriesForKind,
  SESSION_INIT_CONFLICT_CODE,
  CONTEXT_LENGTH_COMPACTED_CODE,
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

describe("a compacted session's overflow retries ONCE (W2)", () => {
  const at = (kind: string, lastAttempt = 0) => ({
    status: "error",
    errorKind: kind,
    finalTextLen: 0,
    partCount: 0,
    chatBusy: false,
    lastAttempt,
  });

  test("the compacted class retries once, then stops", () => {
    // The session provably shrank right before this send, so composing it again is
    // a different attempt — worth exactly one.
    expect(retryDecision(at(CONTEXT_LENGTH_COMPACTED_CODE))).toEqual({
      attempt: 1,
      delayMs: RETRY_DELAY_MS[0],
    });
    expect(retryDecision(at(CONTEXT_LENGTH_COMPACTED_CODE, 1))).toBeNull();
  });

  test("a PLAIN context overflow is never retried", () => {
    // Nothing changed about the session: a retry would fail identically and cost
    // the user another wait. The honest card and its two actions are the answer.
    expect(retryDecision(at("context_length"))).toBeNull();
  });

  test("a WITHHELD send is never retried by the system either", () => {
    // The guard already decided this one cannot fit. Re-dispatching it would walk
    // straight back into the same measurement.
    expect(retryDecision(at("context_length_presend"))).toBeNull();
  });

  test("a GONE conversation IS retried, once, on the fresh session", () => {
    // The gateway refuses at PREFLIGHT COMPACTION, before the model generates anything,
    // so the zero-content gate is met by construction and a retry repeats no work. The
    // finalize drops the stored session BEFORE scheduling, so the attempt opens a fresh
    // one and the rehydration re-ships the history — which is what makes the recovery
    // invisible instead of showing a reader the gateway's `/new`.
    expect(RETRYABLE_KINDS.has("session_gone")).toBe(true);
    expect(retryDecision(at("session_gone"))).not.toBeNull();
    // ONE attempt: the first lands on a fresh session; a second failure means the fresh
    // one is failing too, and another wait buys the reader nothing.
    expect(maxRetriesForKind("session_gone")).toBe(1);
    // …and the zero-content gate still governs it: a turn that produced something keeps
    // its honest card rather than losing that content to a re-dispatch.
    expect(
      retryDecision({ ...at("session_gone"), finalTextLen: 12 }),
    ).toBeNull();
  });

  test("an auth-profile cooldown is never retried — the window has not elapsed", () => {
    // Upstream refuses the candidate BEFORE calling the provider (isProfileInCooldown,
    // src/agents/auth-profiles/usage-state.ts). Whether a retry is even attempted there
    // depends on the reason that opened the window — allowed for billing and the
    // transient ones (rate_limit, overloaded, unknown, empty_response,
    // no_error_details, unclassified, timeout), refused for auth, auth_permanent,
    // session_expired, format and model_not_found — and this class does not say which. `provider_internal`, which the sentence's wording invites, would show that
    // as a countdown promising recovery. The reader decides instead.
    expect(RETRYABLE_KINDS.has("auth_profile_cooldown")).toBe(false);
    expect(retryDecision(at("auth_profile_cooldown"))).toBeNull();
  });

  test("a refusal on the session's own rules is never retried", () => {
    // OpenClaw 2026.9.6: the session's VISIBILITY excludes this person (the same send is
    // refused the same way until its owner changes it), or its permission mode changed
    // since the reader saw it — a re-send under a mode nobody looked at is exactly what
    // the guard exists to prevent. The reader decides.
    for (const code of ["session_visibility_refused", "session_settings_changed"]) {
      expect(RETRYABLE_KINDS.has(code), code).toBe(false);
      expect(retryDecision(at(code)), code).toBeNull();
    }
  });

  test("a writer rebound is never retried, zero content or not", () => {
    // `session_write_conflict` is a rebound the bridge could NOT prove pre-generation:
    // it may have struck at a commit after the model ran. The zero-content gate cannot
    // see work that left no part, so the class stays out of RETRYABLE_KINDS entirely
    // (codex). A proven pre-generation rebound arrives here as the init conflict.
    expect(retryDecision(at("session_write_conflict"))).toBeNull();
    expect(RETRYABLE_KINDS.has("session_write_conflict")).toBe(false);
    // …while the INIT conflict, which throws before any generation, still retries.
    expect(retryDecision(at(SESSION_INIT_CONFLICT_CODE))).not.toBeNull();
  });

  test("visible content on the failed turn cancels the retry", () => {
    // Same zero-content gate as every other retryable class: deleting a card that
    // shows work would lose it.
    expect(
      retryDecision({ ...at(CONTEXT_LENGTH_COMPACTED_CODE), finalTextLen: 12 }),
    ).toBeNull();
    expect(
      retryDecision({ ...at(CONTEXT_LENGTH_COMPACTED_CODE), partCount: 1 }),
    ).toBeNull();
  });
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

  test("the gateway's STORAGE classes are NEVER auto-retried, contention included", () => {
    // The write failed with the run already working — the same reason the writer rebound is
    // kept out: replaying such a turn can repeat actions whose effects already happened. Even
    // the transient one (a busy database, which the gateway's own sentence invites a human to
    // re-send) buys its retry from the reader, not from an automatic re-dispatch.
    for (const errorKind of ["gateway_storage_busy", "gateway_storage_unavailable"]) {
      expect(retryDecision({ ...base, errorKind }), errorKind).toBeNull();
    }
  });

  test("a gateway that CLOSED the agent's database is not auto-retried either", () => {
    // Refused until the gateway's operator acts (or its startup inspection finishes), and when
    // it retires an execution under a run, the run may already have worked. Pinned as a decision.
    expect(retryDecision({ ...base, errorKind: "gateway_agent_db_closed" })).toBeNull();
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
    const { chatId, assistantId, userId, outboxId } = await seedErroredTurn(t);
    // The card knows the row that dispatched it (stream.startAssistant stamps it),
    // which is what lets the newer row below be PROVEN another send.
    await t.run((ctx) => ctx.db.patch(assistantId, { dispatchOutboxId: String(outboxId) }));
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
    // …and the card KNOWS it is the retry's own failure: only here may it say so.
    expect(msg?.autoRetryOutcome).toMatchObject({
      outcome: "exhausted",
      attempt: 2,
      maxAttempts: 2,
    });
  });

  // Production 2026-09-28 (metadata only): a silent close was scheduled for one
  // retry; before it fired, a delegation continuation started streaming into the
  // PREVIOUS bubble, and the retry stood down (`another_turn_streaming`). The card
  // kept its copy "it was retried automatically" — nothing on the message said
  // otherwise. The outcome is now recorded on the card itself.
  test("a retry that stands down because another turn is streaming leaves that FACT on the card", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const { chatId, assistantId, userId } = await seedErroredTurn(t);
    await t.mutation(internal.stream.finalize, {
      messageId: assistantId,
      status: "error" as const,
      error: "",
      errorKind: "empty_response_silent",
    });
    const scheduled = await t.run((ctx) => ctx.db.get(assistantId));
    expect(scheduled?.autoRetry).toMatchObject({ attempt: 1, maxAttempts: 1 });
    expect(scheduled?.autoRetryOutcome).toBeUndefined();
    // A continuation of an EARLIER bubble starts streaming before the fire.
    await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "",
        runId: "announce:requester-settle:synthetic:yield-1",
        updatedAt: 3,
      });
    });
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS[0]! + 500);
    await t.finishInProgressScheduledFunctions();
    const after = await t.run((ctx) => ctx.db.get(assistantId));
    expect(after?.status).toBe("error");
    expect(after?.autoRetry).toBeUndefined();
    expect(after?.autoRetryOutcome).toMatchObject({
      outcome: "stood_down",
      reason: "another_turn_streaming",
      attempt: 1,
      maxAttempts: 1,
    });
    vi.useRealTimers();
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

describe("the retry of a participant's turn stays theirs (group chats)", () => {
  test("the rebuilt outbox row names the AUTHOR, not the owner", async () => {
    // The dispatch re-checks the sender's rights and sends under their name; a
    // retry rebuilt under the owner's id would hand a removed participant's turn
    // the owner's standing.
    const t = convexTest(schema, modules);
    const { chatId, userMsgId, assistantId } = await seedErroredTurn(t, {
      routed: true,
    });
    const guest = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId: id, role: "user" as const, canonical: "guest" });
      await ctx.db.insert("chatParticipants", {
        chatId,
        userId: id,
        addedBy: (await ctx.db.get(chatId))!.userId,
        addedAt: 1,
      });
      await ctx.db.patch(userMsgId, { authorUserId: id });
      return id;
    });
    await finalizeConflict(t, assistantId);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const retry = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("outbox")
          .withIndex("by_chat_status", (q) => q.eq("chatId", chatId))
          .collect()
      ).find((r) => r.autoRetryAttempt === 1),
    );
    expect(String(retry?.userId)).toBe(String(guest));
  });
});

// Production 2026-09-28 (metadata only): a silent close with ZERO parts had three
// sub-agent rows anchored to it (fallback anchor). The part gate saw nothing, and a
// retry's card cascade deletes every row anchored to the card. Delegated work now
// blocks the retry, and the card records why.
describe("delegated work on the card blocks the retry — and the card says so", () => {
  const seedChild = (
    t: ReturnType<typeof convexTest>,
    chatId: Id<"chats">,
    userId: Id<"users">,
    parentMessageId: Id<"messages">,
    extra: Record<string, unknown>,
  ) =>
    t.run((ctx) =>
      ctx.db.insert("subAgents", {
        chatId,
        userId,
        parentMessageId,
        childSessionKey: `agent:jerome:subagent:${String(Math.random()).slice(2)}`,
        status: "error" as const,
        createdAt: 1,
        updatedAt: 1,
        ...extra,
      }),
    );

  test("a child that ran a tool: no retry is scheduled, the outcome is recorded, the row survives", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const { chatId, assistantId, userId } = await seedErroredTurn(t);
    const childId = await seedChild(t, chatId, userId, assistantId, {
      tools: [{ name: "exec", status: "done" as const }],
    });
    await t.mutation(internal.stream.finalize, {
      messageId: assistantId,
      status: "error" as const,
      error: "",
      errorKind: "empty_response_silent",
    });
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS[0]! + 500);
    await t.finishInProgressScheduledFunctions();
    const after = await t.run(async (ctx) => ({
      msg: await ctx.db.get(assistantId),
      child: await ctx.db.get(childId),
      outbox: await ctx.db.query("outbox").collect(),
    }));
    expect(after.msg?.status).toBe("error");
    expect(after.msg?.autoRetry).toBeUndefined();
    expect(after.msg?.autoRetryOutcome).toMatchObject({
      outcome: "stood_down",
      reason: "delegated_work",
    });
    expect(after.child).not.toBeNull();
    expect(after.outbox.some((o) => o.autoRetryAttempt === 1)).toBe(false);
    vi.useRealTimers();
  });

  test("a child registered AFTER the schedule (it has a run id) stops the retry at fire time", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const { chatId, assistantId, userId } = await seedErroredTurn(t);
    await t.mutation(internal.stream.finalize, {
      messageId: assistantId,
      status: "error" as const,
      error: "",
      errorKind: "empty_response_silent",
    });
    const childId = await seedChild(t, chatId, userId, assistantId, {
      childRunId: "11111111-1111-4111-8111-111111111111",
    });
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS[0]! + 500);
    await t.finishInProgressScheduledFunctions();
    const after = await t.run(async (ctx) => ({
      msg: await ctx.db.get(assistantId),
      child: await ctx.db.get(childId),
    }));
    expect(after.msg?.autoRetryOutcome).toMatchObject({
      outcome: "stood_down",
      reason: "delegated_work",
      attempt: 1,
    });
    expect(after.child).not.toBeNull();
    vi.useRealTimers();
  });

  // REVISED (codex P1 on 0.88.1): such a row is harmless to delete, but its EXISTENCE
  // proves the session delegated during a turn whose frames said it did not — the
  // exact prod shape (three children, 0 tools, no run id, fallback-anchored to a
  // card with toolCalls 0). Its siblings may not have registered yet: no retry.
  test("a child that failed with no tool, no run id and no result still blocks — it proves the turn delegated", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const { chatId, assistantId, userId } = await seedErroredTurn(t);
    const childId = await seedChild(t, chatId, userId, assistantId, {});
    await t.mutation(internal.stream.finalize, {
      messageId: assistantId,
      status: "error" as const,
      error: "",
      errorKind: "empty_response_silent",
    });
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS[0]! + 500);
    await t.finishInProgressScheduledFunctions();
    const after = await t.run(async (ctx) => ({
      msg: await ctx.db.get(assistantId),
      child: await ctx.db.get(childId),
    }));
    expect(after.msg?.autoRetryOutcome).toMatchObject({
      outcome: "stood_down",
      reason: "delegated_work",
    });
    expect(after.child).not.toBeNull();
    vi.useRealTimers();
  });

  test("a child born during the turn but NOT anchored to the card (anchor unknown) stops the retry at fire time", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const { chatId, assistantId, userId } = await seedErroredTurn(t);
    await t.mutation(internal.stream.finalize, {
      messageId: assistantId,
      status: "error" as const,
      error: "",
      errorKind: "empty_response_silent",
    });
    // The observer's row lands AFTER the schedule, with no anchor at all.
    const childId = await t.run((ctx) =>
      ctx.db.insert("subAgents", {
        chatId,
        userId,
        childSessionKey: "agent:jerome:subagent:late-unanchored",
        status: "error" as const,
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS[0]! + 500);
    await t.finishInProgressScheduledFunctions();
    const after = await t.run(async (ctx) => ({
      msg: await ctx.db.get(assistantId),
      child: await ctx.db.get(childId),
    }));
    expect(after.msg?.autoRetryOutcome).toMatchObject({
      outcome: "stood_down",
      reason: "delegated_work",
    });
    expect(after.child).not.toBeNull();
    vi.useRealTimers();
  });

  test("a sub-agent still RUNNING elsewhere in the chat stops the retry (the session is busy delegating)", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const { chatId, userId, userMsgId } = await seedErroredTurn(t);
    // A running child of an EARLIER message, created BEFORE the card below — so
    // only the "running anywhere" rule can see it.
    await t.run((ctx) =>
      ctx.db.insert("subAgents", {
        chatId,
        userId,
        parentMessageId: userMsgId,
        childSessionKey: "agent:jerome:subagent:earlier-running",
        status: "running" as const,
        createdAt: 0,
        updatedAt: 0,
      }),
    );
    const assistantId = await t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "",
        runId: "webchat-run-2",
        updatedAt: 3,
      }),
    );
    await t.mutation(internal.stream.finalize, {
      messageId: assistantId,
      status: "error" as const,
      error: "",
      errorKind: "empty_response_silent",
    });
    const msg = await t.run((ctx) => ctx.db.get(assistantId));
    expect(msg?.autoRetry).toBeUndefined();
    expect(msg?.autoRetryOutcome).toMatchObject({
      outcome: "stood_down",
      reason: "delegated_work",
    });
    vi.useRealTimers();
  });
});

// codex P2 on 0.88.1: the exhausted line reported the NEW class's limit ("2/1").
describe("an exhausted chain reports the limit of the chain it ran in", () => {
  // DECIDED (codex pass 2): the chain's limit governs further attempts too, so a
  // provider_internal chain (2) whose first retry closes silently (1) runs its
  // second attempt — and when that fails, the card reports 2 of 2, never "2/1".
  test("a provider_internal chain (2 allowed) whose retry ends as a silent close runs attempt 2 of 2", async () => {
    const t = convexTest(schema, modules);
    const { assistantId, outboxId } = await seedErroredTurn(t, { sentAttempt: 1 });
    await t.run((ctx) => ctx.db.patch(outboxId, { autoRetryMaxAttempts: 2 }));
    await t.mutation(internal.stream.finalize, {
      messageId: assistantId,
      status: "error" as const,
      error: "",
      errorKind: "empty_response_silent",
    });
    const msg = await t.run((ctx) => ctx.db.get(assistantId));
    expect(msg?.autoRetry).toMatchObject({ attempt: 2, maxAttempts: 2 });
  });

  test("…and its spent chain reports 2 of 2 whatever the last class", async () => {
    const t = convexTest(schema, modules);
    const { assistantId, outboxId } = await seedErroredTurn(t, { sentAttempt: 2 });
    await t.run((ctx) => ctx.db.patch(outboxId, { autoRetryMaxAttempts: 2 }));
    await t.mutation(internal.stream.finalize, {
      messageId: assistantId,
      status: "error" as const,
      error: "",
      errorKind: "empty_response_silent",
    });
    const msg = await t.run((ctx) => ctx.db.get(assistantId));
    expect(msg?.autoRetryOutcome).toMatchObject({
      outcome: "exhausted",
      attempt: 2,
      maxAttempts: 2,
    });
  });

  test("the retry's own outbox row carries the chain's limit", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const { assistantId } = await seedErroredTurn(t);
    await t.mutation(internal.stream.finalize, {
      messageId: assistantId,
      status: "error" as const,
      error: "fetch failed",
      errorKind: "provider_internal",
    });
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS[0]! + 500);
    await t.finishInProgressScheduledFunctions();
    const rows = await t.run((ctx) => ctx.db.query("outbox").collect());
    const retry = rows.find((o) => o.autoRetryAttempt === 1);
    expect(retry?.autoRetryMaxAttempts).toBe(2);
    vi.useRealTimers();
  });
});

// codex P2 on 0.88.1: a card another generation takes over must not keep the
// previous generation's retry story.
describe("a new generation's terminal starts its own retry story", () => {
  test("a reopened card that now completes drops the previous stand-down", async () => {
    const t = convexTest(schema, modules);
    const { assistantId } = await seedErroredTurn(t);
    // The state a reopen leaves if a path forgets to clear: streaming + stale outcome.
    await t.run((ctx) =>
      ctx.db.patch(assistantId, {
        autoRetryOutcome: {
          outcome: "stood_down" as const,
          reason: "another_turn_streaming",
          attempt: 1,
          maxAttempts: 1,
          at: 1,
        },
      }),
    );
    await t.mutation(internal.stream.finalize, {
      messageId: assistantId,
      status: "complete" as const,
      text: "une réponse",
    });
    const msg = await t.run((ctx) => ctx.db.get(assistantId));
    expect(msg?.status).toBe("complete");
    expect(msg?.autoRetryOutcome).toBeUndefined();
  });
});

// codex P3 on 0.88.1 + pass 2: the delegation check is bounded, and background tasks
// (exempt chat-wide) must neither fill the window nor be counted for another turn.
describe("background tasks in the delegation check", () => {
  const insertTask = (
    t: ReturnType<typeof convexTest>,
    chatId: Id<"chats">,
    userId: Id<"users">,
    i: number,
    extra: Record<string, unknown> = {},
  ) =>
    t.run((ctx) =>
      ctx.db.insert("subAgents", {
        chatId,
        userId,
        kind: "task" as const,
        childSessionKey: `task:synthetic-${i}`,
        status: "running" as const,
        createdAt: 0,
        updatedAt: 0,
        ...extra,
      }),
    );
  const newCard = (
    t: ReturnType<typeof convexTest>,
    chatId: Id<"chats">,
    userId: Id<"users">,
  ) =>
    t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "",
        runId: "webchat-run-2",
        updatedAt: 3,
      }),
    );
  const silentClose = (t: ReturnType<typeof convexTest>, messageId: Id<"messages">) =>
    t.mutation(internal.stream.finalize, {
      messageId,
      status: "error" as const,
      error: "",
      errorKind: "empty_response_silent",
    });

  test("sixteen RUNNING background tasks do not fill the window: the retry is scheduled", async () => {
    const t = convexTest(schema, modules);
    const { chatId, userId } = await seedErroredTurn(t);
    for (let i = 0; i < 16; i++) await insertTask(t, chatId, userId, i);
    const card = await newCard(t, chatId, userId);
    await silentClose(t, card);
    const msg = await t.run((ctx) => ctx.db.get(card));
    expect(msg?.autoRetry).toMatchObject({ attempt: 1 });
    expect(msg?.autoRetryOutcome).toBeUndefined();
  });

  test("a background task of ANOTHER turn, discovered after the card was created, does not block", async () => {
    const t = convexTest(schema, modules);
    const { chatId, userId, userMsgId, assistantId } = await seedErroredTurn(t);
    await insertTask(t, chatId, userId, 1, { parentMessageId: userMsgId, status: "done" });
    await silentClose(t, assistantId);
    const msg = await t.run((ctx) => ctx.db.get(assistantId));
    expect(msg?.autoRetry).toMatchObject({ attempt: 1 });
    expect(msg?.autoRetryOutcome).toBeUndefined();
  });

  test("a background task anchored to THIS card still counts: no retry", async () => {
    const t = convexTest(schema, modules);
    const { chatId, userId, assistantId } = await seedErroredTurn(t);
    await insertTask(t, chatId, userId, 1, { parentMessageId: assistantId });
    await silentClose(t, assistantId);
    const msg = await t.run((ctx) => ctx.db.get(assistantId));
    expect(msg?.autoRetry).toBeUndefined();
    expect(msg?.autoRetryOutcome).toMatchObject({ reason: "delegated_work" });
  });

  test("a full window of NON-exempt rows with no verdict stays conservative (MoA children, all dead)", async () => {
    const t = convexTest(schema, modules);
    const { chatId, userId, assistantId } = await seedErroredTurn(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("messageParts", {
        messageId: assistantId,
        order: 0,
        part: { kind: "tool" as const, name: "mixture_of_agents", phase: "completed" },
      });
      // Sixteen dead, fruitless MoA children: each is exempt by the MoA gate, so
      // only the bound can decide — and a bound never licenses a retry.
      for (let i = 0; i < 16; i++) {
        await ctx.db.insert("subAgents", {
          chatId,
          userId,
          parentMessageId: assistantId,
          childSessionKey: `hermes:moa:dead-${i}`,
          status: "error" as const,
          createdAt: 1,
          updatedAt: 1,
        });
      }
    });
    await t.mutation(internal.stream.finalize, {
      messageId: assistantId,
      status: "error" as const,
      error: "fetch failed",
      errorKind: "provider_internal",
    });
    const msg = await t.run((ctx) => ctx.db.get(assistantId));
    expect(msg?.autoRetry).toBeUndefined();
    expect(msg?.autoRetryOutcome).toMatchObject({ reason: "delegated_work" });
  });
});

// codex pass 2 on 0.88.1: the dispatch-failure path hands its attempt over and
// used to lose the chain's limit with it.
describe("a retry that fails at DISPATCH keeps its chain's limit", () => {
  const seedRetryRow = (
    t: ReturnType<typeof convexTest>,
    attempt: number,
    max: number,
  ) =>
    t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const chatId = await ctx.db.insert("chats", {
        userId,
        updatedAt: 1,
        instanceName: "ataraxis",
        agentId: "jerome",
      });
      const userMsgId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "user" as const,
        status: "complete" as const,
        text: "question synthétique",
        updatedAt: 1,
      });
      const outboxId = await ctx.db.insert("outbox", {
        chatId,
        userId,
        clientMessageId: `autoretry-${attempt}`,
        messageId: userMsgId,
        text: "question synthétique",
        attachmentIds: [],
        status: "pending" as const,
        autoRetryAttempt: attempt,
        autoRetryMaxAttempts: max,
      });
      return { chatId, outboxId };
    });
  const failedCard = (t: ReturnType<typeof convexTest>, chatId: Id<"chats">) =>
    t.run(async (ctx) =>
      (await ctx.db.query("messages").collect()).find(
        (m) => m.chatId === chatId && m.role === "assistant",
      ),
    );

  test("DECIDED: the chain's limit (2, provider_internal) governs a retry refused as session_archived (1): attempt 2 runs", async () => {
    const t = convexTest(schema, modules);
    const { chatId, outboxId } = await seedRetryRow(t, 1, 2);
    await t.mutation(internal.bridge.failDispatch, {
      outboxId,
      reason: "send_failed",
      errorCode: "session_archived",
    });
    const card = await failedCard(t, chatId);
    expect(card?.errorCode).toBe("session_archived");
    expect(card?.autoRetry).toMatchObject({ attempt: 2, maxAttempts: 2 });
    expect(card?.autoRetryOutcome).toBeUndefined();
  });

  test("…and when that chain is spent, the card reports it against the chain: 2 of 2", async () => {
    const t = convexTest(schema, modules);
    const { chatId, outboxId } = await seedRetryRow(t, 2, 2);
    await t.mutation(internal.bridge.failDispatch, {
      outboxId,
      reason: "send_failed",
      errorCode: "session_archived",
    });
    const card = await failedCard(t, chatId);
    expect(card?.autoRetry).toBeUndefined();
    expect(card?.autoRetryOutcome).toMatchObject({
      outcome: "exhausted",
      attempt: 2,
      maxAttempts: 2,
    });
  });
});

// codex pass 4 on 0.88.1: a timer is bound to the countdown it wrote. A card another
// generation took over (reopen, new failure, new schedule) is not the old timer's.
describe("a stale retry timer touches nothing", () => {
  test("old fire after a reopen + new failure + new schedule: no write, the new countdown stands", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const { assistantId } = await seedErroredTurn(t);
    await t.mutation(internal.stream.finalize, {
      messageId: assistantId,
      status: "error" as const,
      error: "fetch failed",
      errorKind: "provider_internal",
    });
    const first = await t.run((ctx) => ctx.db.get(assistantId));
    expect(first?.autoRetry?.attempt).toBe(1);
    // Within the delay: another generation takes the card (reopen), fails again,
    // and schedules its OWN retry (a later stamp).
    await vi.advanceTimersByTimeAsync(1_000);
    await t.run((ctx) =>
      ctx.db.patch(assistantId, {
        status: "streaming" as const,
        error: undefined,
        errorCode: undefined,
        autoRetry: undefined,
        autoRetryOutcome: undefined,
      }),
    );
    await t.mutation(internal.stream.finalize, {
      messageId: assistantId,
      status: "error" as const,
      error: "fetch failed",
      errorKind: "provider_internal",
    });
    const second = await t.run((ctx) => ctx.db.get(assistantId));
    expect(second?.autoRetry).toBeDefined();
    expect(second?.autoRetry?.firesAt).not.toBe(first?.autoRetry?.firesAt);
    // The OLD timer fires first (it was armed 1 s earlier) and must be a no-op.
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS[0]! - 500);
    await t.finishInProgressScheduledFunctions();
    const afterOld = await t.run(async (ctx) => ({
      msg: await ctx.db.get(assistantId),
      traces: await ctx.db.query("traceEvents").collect(),
    }));
    expect(afterOld.msg).not.toBeNull();
    expect(afterOld.msg?.autoRetry).toEqual(second?.autoRetry);
    expect(afterOld.msg?.autoRetryOutcome).toBeUndefined();
    expect(
      afterOld.traces.some(
        (e) => e.kind === "chat.auto_retry" && e.meta?.includes('"superseded"'),
      ),
    ).toBe(true);
    vi.useRealTimers();
  });
});

// codex pass 4 on 0.88.1: the turn's OWN dispatch row still pending is not "the
// conversation moved on" — no newer turn exists. It still blocks (a dispatch that
// has not reported back may yet paint its own error card), under its own reason.
describe("the card's own unsettled dispatch is not a newer send", () => {
  test("own row still pending at fire time: stands down as own_dispatch_unsettled, never chat_busy", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const { assistantId, outboxId } = await seedErroredTurn(t, { outboxStatus: "pending" });
    await t.run((ctx) => ctx.db.patch(assistantId, { dispatchOutboxId: String(outboxId) }));
    await t.mutation(internal.stream.finalize, {
      messageId: assistantId,
      status: "error" as const,
      error: "fetch failed",
      errorKind: "provider_internal",
    });
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS[0]! + 500);
    await t.finishInProgressScheduledFunctions();
    const msg = await t.run((ctx) => ctx.db.get(assistantId));
    expect(msg?.status).toBe("error");
    expect(msg?.autoRetryOutcome).toMatchObject({
      outcome: "stood_down",
      reason: "own_dispatch_unsettled",
    });
    vi.useRealTimers();
  });
});
