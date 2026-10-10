/// <reference types="vite/client" />
//
// A SERVICE ANSWER WHOSE OUTCOME WAS ONLY INFERRED (transcript projection `on`, phase 4 —
// codex pass 25). An idle read closes the summarizer's or curator's answer `complete`
// before the run's own terminal arrives. Those correlates JUDGE the status (a summary is
// stored, a curation proposed, only from a `complete` answer): they wait for the live
// terminal — a `complete` confirms, an `error` corrects — or for a bounded check, and run
// exactly once. Each case in `on` and after a rollback to `shadow`.

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { curationSessionNonce, summarizeSessionNonce } from "./lib/rehydration";
import { STATUS_JOB_WAIT_MS } from "./stream";

const modules = import.meta.glob("./**/*.ts");
type T = TestConvex<typeof schema>;
type Kind = "summarizer" | "curator";

const SUMMARY = "Résumé : le projet avance.";
const CURATED = "# Memory\n- kept the one load-bearing fact\n" + "- detail\n".repeat(300);
const CREATED = 1_700_000_000_000;

afterEach(() => {
  vi.useRealTimers();
});

/** A service job whose answer an idle read made `complete` (inferred). */
async function inferredAnswer(t: T, kind: Kind) {
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "admin" as const, canonical: "u" });
    await ctx.db.insert("instances", {
      name: "primary",
      gatewayUrl: "ws://gw",
      config: { transcriptProjection: "on" } as never,
    });
    let sessionKey: string;
    let jobId: Id<"chats"> | Id<"agentFileCurations">;
    let lock: Record<string, unknown>;
    if (kind === "summarizer") {
      const target = await ctx.db.insert("chats", { userId, updatedAt: 1, instanceName: "primary", agentId: "alice" });
      jobId = target;
      lock = { pendingSummarize: { targetChatId: target, watermarkTarget: 10, coveredCountTarget: 4, createdAt: CREATED } };
      sessionKey = `agent:alice:atrium:chat:u:${summarizeSessionNonce(String(target), CREATED)}`;
    } else {
      const curationId = await ctx.db.insert("agentFileCurations", {
        instanceName: "primary",
        agentId: "alice",
        name: "MEMORY.md",
        status: "dispatched",
        baseUpdatedAtMs: 100,
        beforeSize: 30_000,
        beforeContent: "x".repeat(30_000),
        budgetChars: 16_000,
        requestedByUserId: userId,
        trigger: "manual" as const,
        createdAt: CREATED,
        updatedAt: CREATED,
      } as never);
      jobId = curationId;
      lock = { pendingCurate: { curationId, createdAt: CREATED } };
      sessionKey = `agent:alice:curate:x:${curationSessionNonce(String(curationId), CREATED)}`;
    }
    const hidden = await ctx.db.insert("chats", {
      userId,
      updatedAt: 1,
      kind,
      instanceName: "primary",
      agentId: "alice",
      transcriptSeenAt: 1,
      ...lock,
    } as never);
    return { userId, hidden, jobId, sessionKey };
  });
  const apply = (rows: unknown[], extra: Record<string, unknown> = {}) =>
    t.mutation(internal.transcriptProjection.applyTranscript, {
      chatId: ids.hidden,
      boundInstanceName: "primary",
      sessionKey: ids.sessionKey,
      sessionId: "s-job",
      kind: "delta",
      deltaCursor: `c:${Math.random()}`,
      rows,
      terminals: [],
      unidentified: 0,
      ...extra,
    } as never);
  await apply([], { kind: "page" });
  // An IDLE read: the run's rows, no terminal of its own.
  await apply(
    [{ entryId: "a1", seq: 2, role: "assistant", runId: "run-job", hidden: false, visible: true, text: kind === "summarizer" ? SUMMARY : CURATED }],
    { hasActiveRun: false },
  );
  const answer = await t.run(async (ctx) =>
    (await ctx.db.query("messages").withIndex("by_chat", (q) => q.eq("chatId", ids.hidden)).collect()).find((m) => m.role === "assistant")!,
  );
  return { ...ids, answer, apply };
}

const locked = (t: T, kind: Kind, hidden: Id<"chats">) =>
  t.run(async (ctx) => {
    const c = (await ctx.db.get(hidden))!;
    return kind === "summarizer" ? c.pendingSummarize !== undefined : c.pendingCurate !== undefined;
  });
/** The job's SUCCESS result, if any: the stored summary, or the proposed curation. */
const succeeded = (t: T, kind: Kind, jobId: Id<"chats"> | Id<"agentFileCurations">) =>
  t.run(async (ctx) => {
    if (kind === "summarizer") {
      const row = await ctx.db
        .query("chatSummaries")
        .withIndex("by_chat", (q) => q.eq("chatId", jobId as Id<"chats">))
        .unique();
      return row !== null && row.summary === SUMMARY;
    }
    const c = (await ctx.db.get(jobId as Id<"agentFileCurations">))!;
    return c.status === "proposed" && (c.proposedContent ?? "").includes("load-bearing");
  });
const rollback = (t: T) =>
  t.run(async (ctx) => {
    const inst = (await ctx.db.query("instances").collect())[0]!;
    await ctx.db.patch(inst._id, { config: { transcriptProjection: "shadow" } as never });
  });
const liveTerminal = (t: T, messageId: Id<"messages">, status: "complete" | "error" | "aborted" | "timeout") =>
  t.mutation(internal.stream.finalize, {
    messageId,
    // A timeout reaches finalize as `error` with errorKind `timeout` (the bridge's map).
    status: status === "timeout" ? "error" : status,
    text: "",
    expectedRunId: "run-job",
    finalizeCause: "gateway_final",
    ...(status === "error" ? { error: "provider failed", errorKind: "provider_internal" } : {}),
    ...(status === "timeout" ? { error: "the run timed out", errorKind: "timeout" } : {}),
  } as never);

for (const kind of ["summarizer", "curator"] as const) {
  for (const rolledBack of [false, true]) {
    const where = rolledBack ? " (rolled back to shadow)" : "";
    describe(`${kind}: an inferred close waits for the run's outcome${where}`, () => {
      test("the close itself judges nothing: the lock holds, no result", async () => {
        vi.useFakeTimers();
        const t = convexTest({ schema, modules, transactionLimits: true });
        const j = await inferredAnswer(t, kind);
        expect(j.answer.closeInferred).toBe(true);
        expect(await locked(t, kind, j.hidden)).toBe(true);
        expect(await succeeded(t, kind, j.jobId)).toBe(false);
      });

      test("a late live ERROR: the lock is released, no success result left", async () => {
        vi.useFakeTimers();
        const t = convexTest({ schema, modules, transactionLimits: true });
        const j = await inferredAnswer(t, kind);
        if (rolledBack) await rollback(t);
        await liveTerminal(t, j.answer._id, "error");
        expect(await locked(t, kind, j.hidden)).toBe(false);
        expect(await succeeded(t, kind, j.jobId)).toBe(false);
        // Once: the bounded check finds nothing left to do.
        await t.finishAllScheduledFunctions(vi.runAllTimers);
        expect(await succeeded(t, kind, j.jobId)).toBe(false);
      });

      for (const [terminalKind, expectedStatus] of [["aborted", "aborted"], ["timeout", "error"]] as const) {
        test(`a late live ${terminalKind.toUpperCase()}: the answer becomes ${expectedStatus}, the lock is released, no success result`, async () => {
          vi.useFakeTimers();
          const t = convexTest({ schema, modules, transactionLimits: true });
          const j = await inferredAnswer(t, kind);
          if (rolledBack) await rollback(t);
          await liveTerminal(t, j.answer._id, terminalKind);
          const doc = await t.run((ctx) => ctx.db.get(j.answer._id));
          expect(doc?.status).toBe(expectedStatus);
          if (terminalKind === "timeout") expect(doc?.errorCode).toBe("timeout");
          expect(await locked(t, kind, j.hidden)).toBe(false);
          expect(await succeeded(t, kind, j.jobId)).toBe(false);
          await t.finishAllScheduledFunctions(vi.runAllTimers);
          expect(await succeeded(t, kind, j.jobId)).toBe(false);
        });
      }

      test("a late live COMPLETE: the result is kept", async () => {
        vi.useFakeTimers();
        const t = convexTest({ schema, modules, transactionLimits: true });
        const j = await inferredAnswer(t, kind);
        if (rolledBack) await rollback(t);
        await liveTerminal(t, j.answer._id, "complete");
        expect(await locked(t, kind, j.hidden)).toBe(false);
        expect(await succeeded(t, kind, j.jobId)).toBe(true);
      });

      test("NO terminal ever: the bounded check settles it on the transcript's verdict", async () => {
        vi.useFakeTimers();
        const t = convexTest({ schema, modules, transactionLimits: true });
        const j = await inferredAnswer(t, kind);
        if (rolledBack) await rollback(t);
        vi.advanceTimersByTime(STATUS_JOB_WAIT_MS - 1_000);
        await t.finishInProgressScheduledFunctions();
        expect(await locked(t, kind, j.hidden)).toBe(true);
        await t.finishAllScheduledFunctions(vi.runAllTimers);
        expect(await locked(t, kind, j.hidden)).toBe(false);
        expect(await succeeded(t, kind, j.jobId)).toBe(true);
      });

      test("NO live terminal, but a later read recorded the run's ERROR: the bounded check fails the job", async () => {
        vi.useFakeTimers();
        const t = convexTest({ schema, modules, transactionLimits: true });
        const j = await inferredAnswer(t, kind);
        if (rolledBack) await rollback(t);
        await t.run(async (ctx) => {
          const run = (await ctx.db.query("transcriptRuns").collect()).find((r) => r.runId === "run-job")!;
          await ctx.db.patch(run._id, { status: "error" });
        });
        await t.finishAllScheduledFunctions(vi.runAllTimers);
        expect(await locked(t, kind, j.hidden)).toBe(false);
        expect(await succeeded(t, kind, j.jobId)).toBe(false);
      });
    });
  }
}
