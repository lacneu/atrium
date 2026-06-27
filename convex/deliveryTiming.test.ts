// Delivery-latency recorder (convex/deliveryTiming.ts). Each test fails if its
// target regresses: the OFF default writes/ships nothing; an active recording times
// every tagged delta and the report applies the skews (asserted by recomputing from
// the raw rows, robust to the real clock); a delta tagged with a NON-active session
// is rejected (no cross-session contamination); recordFrontendTiming closes segment
// C keyed by the timing row id; stop + auto-stop disable; activation is admin-only
// and the report needs traces.read.

import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "admin" | "user",
): Promise<Id<"users">> {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role, canonical: "u" });
    return userId;
  });
}

async function seedStreamingMessage(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
): Promise<{ chatId: Id<"chats">; messageId: Id<"messages"> }> {
  return await t.run(async (ctx) => {
    const chatId = await ctx.db.insert("chats", {
      userId,
      updatedAt: 1,
      instanceName: "prod",
    });
    const messageId = await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "assistant" as const,
      status: "streaming" as const,
      text: "",
      updatedAt: 1,
    });
    return { chatId, messageId };
  });
}

const timingRows = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => ctx.db.query("deliveryTimings").collect());

describe("delivery-latency recorder", () => {
  test("OFF by default: a tagged delta records nothing and adds no in-band fields", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t, "user");
    const { chatId, messageId } = await seedStreamingMessage(t, userId);

    await t.mutation(internal.stream.appendDelta, {
      messageId,
      text: "hi",
      recSessionId: "anything",
      bridgeSentAt: 1000,
      bridgeSkew: 0,
    });

    expect(await timingRows(t)).toEqual([]); // nothing recorded
    const view = await t
      .withIdentity({ subject: `${userId}|session` })
      .query(api.messages.getStreamingText, { chatId });
    expect(view[0].text).toBe("hi");
    expect((view[0] as Record<string, unknown>).recTimingId).toBeUndefined();
  });

  test("SSE leg: the stream chunk carries recTimingId during a recording (absent otherwise)", async () => {
    // Phase 5: the SSE chunk must carry the SAME correlator as the timing row so the SSE
    // leg can close segment C at the displayed receipt. Untagged (no recording) chunks
    // carry nothing — the recorder stays inert.
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "admin");
    const asAdmin = t.withIdentity({ subject: `${admin}|session` });
    const { messageId } = await seedStreamingMessage(t, admin);

    // Not recording yet -> the chunk has no correlator.
    await t.mutation(internal.stream.appendDelta, { messageId, text: "x" });
    // Recording active -> the next delta's chunk carries the minted correlator.
    const { sessionId } = await asAdmin.mutation(
      api.deliveryTiming.startDeliveryRecord,
      {},
    );
    await t.mutation(internal.stream.appendDelta, {
      messageId,
      text: "y",
      recSessionId: sessionId,
      bridgeSentAt: Date.now(),
      bridgeSkew: 0,
      sizeBytes: 1,
    });

    const chunks = await t.run((ctx) =>
      ctx.db
        .query("streamChunks")
        .withIndex("by_message_seq", (q) => q.eq("messageId", messageId))
        .collect(),
    );
    const timings = await timingRows(t);
    const untagged = chunks.find((c) => c.text === "x");
    const tagged = chunks.find((c) => c.text === "y");
    expect(untagged?.recTimingId).toBeUndefined();
    // Same id as the minted timing row -> the frontend stamps t4 by it on the SSE leg.
    expect(timings).toHaveLength(1);
    expect(tagged?.recTimingId).toBe(timings[0]._id);
  });

  test("active recording: deltas timed, in-band id shipped, report applies the skews", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "admin");
    const asAdmin = t.withIdentity({ subject: `${admin}|session` });
    const { chatId, messageId } = await seedStreamingMessage(t, admin);

    const { sessionId } = await asAdmin.mutation(
      api.deliveryTiming.startDeliveryRecord,
      {},
    );
    const now = Date.now();
    await t.mutation(internal.stream.appendDelta, {
      messageId,
      text: "a",
      recSessionId: sessionId,
      bridgeSentAt: now - 30,
      bridgeSkew: 12,
      sizeBytes: 1,
    });
    await t.mutation(internal.stream.appendDelta, {
      messageId,
      text: "b",
      recSessionId: sessionId,
      bridgeSentAt: now - 20,
      bridgeSkew: 12,
      sizeBytes: 1,
    });

    const rows = await timingRows(t);
    expect(rows.length).toBe(2);

    // In-band: getStreamingText carries the LAST delta's timing id + commit time.
    const view = await asAdmin.query(api.messages.getStreamingText, { chatId });
    const recId = (view[0] as Record<string, unknown>).recTimingId;
    expect(typeof recId).toBe("string");
    expect(rows.some((r) => r._id === recId)).toBe(true);
    expect(typeof (view[0] as Record<string, unknown>).recCommittedAt).toBe(
      "number",
    );

    const report = await asAdmin.query(api.deliveryTiming.getDeliveryReport, {
      sessionId,
    });
    expect(report.count).toBe(2);
    // A is skew-corrected: EXACT equality vs recomputation. Dropping `- bridgeSkew`
    // (12ms) breaks this.
    const expectedAmax = Math.max(
      ...rows.map((r) => r.t2 - r.t1 - (r.bridgeSkew ?? 0)),
    );
    expect(report.segments!.A.max).toBe(expectedAmax);
    expect(report.segments!.A.count).toBe(2);
    // No B segment: Convex exec is unmeasurable in-app (frozen mutation clock).
    expect("B" in report.segments!).toBe(false);
    expect(report.segments!.C.count).toBe(0); // no t4 yet
  });

  test("a delta tagged with a NON-active session is rejected (no contamination)", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "admin");
    const asAdmin = t.withIdentity({ subject: `${admin}|session` });
    const { messageId } = await seedStreamingMessage(t, admin);

    // Session A, then stop, then a fresh session B is active.
    const a = await asAdmin.mutation(api.deliveryTiming.startDeliveryRecord, {});
    await asAdmin.mutation(api.deliveryTiming.stopDeliveryRecord, {});
    const b = await asAdmin.mutation(api.deliveryTiming.startDeliveryRecord, {});
    expect(b.sessionId).not.toBe(a.sessionId);

    // A late delta from the OLD turn still carries session A's id.
    await t.mutation(internal.stream.appendDelta, {
      messageId,
      text: "late",
      recSessionId: a.sessionId,
      bridgeSentAt: Date.now(),
      bridgeSkew: 0,
    });

    // It must NOT be filed (neither under A nor mis-filed under the active B).
    expect(await timingRows(t)).toEqual([]);
    const report = await asAdmin.query(api.deliveryTiming.getDeliveryReport, {
      sessionId: b.sessionId,
    });
    expect(report.count).toBe(0);
  });

  test("recordFrontendTiming closes segment C (keyed by timing id, owner-scoped)", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "admin");
    const asAdmin = t.withIdentity({ subject: `${admin}|session` });
    const { messageId } = await seedStreamingMessage(t, admin);
    const { sessionId } = await asAdmin.mutation(
      api.deliveryTiming.startDeliveryRecord,
      {},
    );
    await t.mutation(internal.stream.appendDelta, {
      messageId,
      text: "a",
      recSessionId: sessionId,
      bridgeSentAt: Date.now() - 10,
      bridgeSkew: 0,
    });

    const row = (await timingRows(t))[0];
    const t4 = row.t3 + 200;
    const clientSkew = 9;
    const res = await asAdmin.mutation(
      api.deliveryTiming.recordFrontendTiming,
      { samples: [{ timingId: row._id, t4, clientSkew }] },
    );
    expect(res.patched).toBe(1);

    const report = await asAdmin.query(api.deliveryTiming.getDeliveryReport, {
      sessionId,
    });
    expect(report.segments!.C.count).toBe(1);
    // C = t4 - t3 + clientSkew (t4 is a browser-clock stamp at the later endpoint;
    // +clientSkew converts it to server time). A sign flip -> 191, so this guards it.
    expect(report.segments!.C.max).toBe(t4 - row.t3 + clientSkew);
  });

  test("recordFrontendTiming is owner-scoped: a non-owner cannot close C", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "admin");
    const asAdmin = t.withIdentity({ subject: `${admin}|session` });
    const stranger = await seedUser(t, "user");
    const { messageId } = await seedStreamingMessage(t, admin);
    const { sessionId } = await asAdmin.mutation(
      api.deliveryTiming.startDeliveryRecord,
      {},
    );
    await t.mutation(internal.stream.appendDelta, {
      messageId,
      text: "a",
      recSessionId: sessionId,
      bridgeSentAt: Date.now(),
      bridgeSkew: 0,
    });
    const row = (await timingRows(t))[0];

    const res = await t
      .withIdentity({ subject: `${stranger}|session` })
      .mutation(api.deliveryTiming.recordFrontendTiming, {
        samples: [{ timingId: row._id, t4: row.t3 + 50 }],
      });
    expect(res.patched).toBe(0); // stranger doesn't own the chat -> skipped
  });

  test("stopDeliveryRecord disables recording: later deltas are not timed", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "admin");
    const asAdmin = t.withIdentity({ subject: `${admin}|session` });
    const { messageId } = await seedStreamingMessage(t, admin);
    const { sessionId } = await asAdmin.mutation(
      api.deliveryTiming.startDeliveryRecord,
      {},
    );

    await t.mutation(internal.stream.appendDelta, {
      messageId,
      text: "a",
      recSessionId: sessionId,
      bridgeSentAt: Date.now(),
      bridgeSkew: 0,
    });
    await asAdmin.mutation(api.deliveryTiming.stopDeliveryRecord, {});
    await t.mutation(internal.stream.appendDelta, {
      messageId,
      text: "b",
      recSessionId: sessionId,
      bridgeSentAt: Date.now(),
      bridgeSkew: 0,
    });

    expect((await timingRows(t)).length).toBe(1); // only the pre-stop delta
  });

  test("a recording past its autoStopAt is treated as OFF", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "admin");
    const asAdmin = t.withIdentity({ subject: `${admin}|session` });
    const { messageId } = await seedStreamingMessage(t, admin);
    const { sessionId } = await asAdmin.mutation(
      api.deliveryTiming.startDeliveryRecord,
      {},
    );
    await t.run(async (ctx) => {
      const cfg = await ctx.db
        .query("deliveryRecording")
        .withIndex("by_key", (q) => q.eq("key", "singleton"))
        .unique();
      await ctx.db.patch(cfg!._id, { autoStopAt: Date.now() - 1 });
    });

    await t.mutation(internal.stream.appendDelta, {
      messageId,
      text: "x",
      recSessionId: sessionId,
      bridgeSentAt: Date.now(),
      bridgeSkew: 0,
    });
    expect(await timingRows(t)).toEqual([]); // expired => not recorded
  });

  test("activation is admin-only and the report needs traces.read", async () => {
    const t = convexTest(schema, modules);
    const user = await seedUser(t, "user");
    const asUser = t.withIdentity({ subject: `${user}|session` });
    await expect(
      asUser.mutation(api.deliveryTiming.startDeliveryRecord, {}),
    ).rejects.toThrow(/admin/);
    await expect(
      asUser.query(api.deliveryTiming.getDeliveryReport, {}),
    ).rejects.toThrow(/permission|traces/i);
  });

  test("stale in-band marker is cleared when recording stops mid-stream", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "admin");
    const asAdmin = t.withIdentity({ subject: `${admin}|session` });
    const { chatId, messageId } = await seedStreamingMessage(t, admin);
    const { sessionId } = await asAdmin.mutation(
      api.deliveryTiming.startDeliveryRecord,
      {},
    );

    await t.mutation(internal.stream.appendDelta, {
      messageId,
      text: "a",
      recSessionId: sessionId,
      bridgeSentAt: Date.now(),
      bridgeSkew: 0,
    });
    let view = await asAdmin.query(api.messages.getStreamingText, { chatId });
    expect(typeof (view[0] as Record<string, unknown>).recTimingId).toBe(
      "string",
    );

    await asAdmin.mutation(api.deliveryTiming.stopDeliveryRecord, {});
    await t.mutation(internal.stream.appendDelta, {
      messageId,
      text: "b",
      recSessionId: sessionId,
      bridgeSentAt: Date.now(),
      bridgeSkew: 0,
    });

    view = await asAdmin.query(api.messages.getStreamingText, { chatId });
    expect(view[0].text).toBe("ab");
    expect((view[0] as Record<string, unknown>).recTimingId).toBeUndefined();
  });

  test("report percentiles use nearest-rank (no overestimation)", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "admin");
    const asAdmin = t.withIdentity({ subject: `${admin}|session` });
    const sessionId = "sess-pct-test";
    // Controlled rows: bridge-internal = t1 - t0 = [10,20,30,40] (t0=0).
    await t.run(async (ctx) => {
      const chatId = await ctx.db.insert("chats", {
        userId: admin,
        updatedAt: 1,
      });
      for (const v of [10, 20, 30, 40]) {
        await ctx.db.insert("deliveryTimings", {
          sessionId,
          chatId,
          t0: 0,
          t1: v,
          t2: v,
          t3: v,
        });
      }
    });

    const report = await asAdmin.query(api.deliveryTiming.getDeliveryReport, {
      sessionId,
    });
    expect(report.count).toBe(4);
    // Nearest-rank p50 of [10,20,30,40] = idx ceil(0.5*4)-1 = 1 -> 20.
    // The old floor() bug returned idx 2 -> 30, so this assert guards the fix.
    expect(report.segments!.bridge.p50).toBe(20);
    expect(report.segments!.bridge.p95).toBe(40);
    expect(report.segments!.bridge.max).toBe(40);
  });

  test("agent/MCP path: internal start/report/stop wrappers work without a user identity", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "admin");
    const { messageId } = await seedStreamingMessage(t, admin);

    // Key-authed HTTP path calls these internal fns (no user auth).
    const { sessionId } = await t.mutation(
      internal.deliveryTiming.startDeliveryRecordForAgent,
      { principalId: "svc-1" },
    );
    await t.mutation(internal.stream.appendDelta, {
      messageId,
      text: "a",
      recSessionId: sessionId,
      bridgeSentAt: Date.now(),
      bridgeSkew: 0,
    });

    const report = await t.query(
      internal.deliveryTiming.getDeliveryReportInternal,
      { sessionId },
    );
    expect(report.count).toBe(1);

    await t.mutation(internal.deliveryTiming.stopDeliveryRecordForAgent, {});
    // After stop, a new tagged delta for the old session is not recorded.
    await t.mutation(internal.stream.appendDelta, {
      messageId,
      text: "b",
      recSessionId: sessionId,
      bridgeSentAt: Date.now(),
      bridgeSkew: 0,
    });
    const after = await t.query(
      internal.deliveryTiming.getDeliveryReportInternal,
      { sessionId },
    );
    expect(after.count).toBe(1); // still 1 — the post-stop delta was rejected
  });

  test("list shows sessions; delete purges ALL timings + the session (no ghost report)", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "admin");
    const asAdmin = t.withIdentity({ subject: `${admin}|session` });
    const { messageId } = await seedStreamingMessage(t, admin);
    const { sessionId } = await asAdmin.mutation(
      api.deliveryTiming.startDeliveryRecord,
      {},
    );
    for (const text of ["a", "b", "c"]) {
      await t.mutation(internal.stream.appendDelta, {
        messageId,
        text,
        recSessionId: sessionId,
        bridgeSentAt: Date.now(),
        bridgeSkew: 0,
      });
    }
    await asAdmin.mutation(api.deliveryTiming.stopDeliveryRecord, {});

    const sessions = await asAdmin.query(
      api.deliveryTiming.listDeliverySessions,
      {},
    );
    expect(sessions.some((s) => s.sessionId === sessionId)).toBe(true);

    // Delete is bounded + self-scheduling. Fake timers must be active WHEN the
    // mutation schedules (so the convex-test scheduler registers on the mocked clock)
    // and to drain the recursive steps; scope them to the delete + drain only.
    vi.useFakeTimers();
    let res: { scheduled: number };
    try {
      res = await asAdmin.mutation(api.deliveryTiming.deleteDeliverySessions, {
        sessionIds: [sessionId],
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
    }
    expect(res.scheduled).toBe(1);
    // No leftover timing rows, and the report for the deleted id is empty (guards the
    // "delete only removed the first page" regression).
    expect(await timingRows(t)).toEqual([]);
    const report = await asAdmin.query(api.deliveryTiming.getDeliveryReport, {
      sessionId,
    });
    expect(report.count).toBe(0);
  });

  test("deleting the ACTIVE session stops recording (so no new deltas land mid-purge)", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "admin");
    const asAdmin = t.withIdentity({ subject: `${admin}|session` });
    const { messageId } = await seedStreamingMessage(t, admin);
    const { sessionId } = await asAdmin.mutation(
      api.deliveryTiming.startDeliveryRecord,
      {},
    );
    await t.mutation(internal.stream.appendDelta, {
      messageId,
      text: "a",
      recSessionId: sessionId,
      bridgeSentAt: Date.now(),
      bridgeSkew: 0,
    });

    // Delete the ACTIVE session without stopping first.
    vi.useFakeTimers();
    try {
      await asAdmin.mutation(api.deliveryTiming.deleteDeliverySessions, {
        sessionIds: [sessionId],
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
    }

    const stat = await asAdmin.query(api.deliveryTiming.getDeliveryStatus, {});
    expect(stat.recording).toBe(false); // the delete stopped the active recording
    expect(await timingRows(t)).toEqual([]);
  });

  test("delete is idempotent: a duplicate id, then a re-delete, never throws", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "admin");
    const asAdmin = t.withIdentity({ subject: `${admin}|session` });
    const { messageId } = await seedStreamingMessage(t, admin);
    const { sessionId } = await asAdmin.mutation(
      api.deliveryTiming.startDeliveryRecord,
      {},
    );
    await t.mutation(internal.stream.appendDelta, {
      messageId,
      text: "a",
      recSessionId: sessionId,
      bridgeSentAt: Date.now(),
      bridgeSkew: 0,
    });
    await asAdmin.mutation(api.deliveryTiming.stopDeliveryRecord, {});

    vi.useFakeTimers();
    try {
      // A duplicate id is deduped to one scheduled job...
      const res = await asAdmin.mutation(
        api.deliveryTiming.deleteDeliverySessions,
        { sessionIds: [sessionId, sessionId] },
      );
      expect(res.scheduled).toBe(1);
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      // ...and re-deleting the now-gone session must NOT throw (idempotent).
      await asAdmin.mutation(api.deliveryTiming.deleteDeliverySessions, {
        sessionIds: [sessionId],
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
    }

    expect(await timingRows(t)).toEqual([]);
  });
});

// --- Scale / load -----------------------------------------------------------
// Deterministic, CI-runnable load tests for the recorder's scale invariants:
// recording is exactly linear (N deltas -> N rows, no leak/dup), OFF stays at
// zero under a burst, and delete drains a session far larger than one batch via
// the bounded self-scheduling purge.
describe("delivery recorder — scale / load", () => {
  test("ON records exactly N rows under a burst; OFF records zero", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "admin");
    const asAdmin = t.withIdentity({ subject: `${admin}|session` });
    const { messageId } = await seedStreamingMessage(t, admin);

    // OFF: a 50-delta burst tagged with a non-active session records nothing.
    for (let i = 0; i < 50; i++) {
      await t.mutation(internal.stream.appendDelta, {
        messageId,
        text: "x",
        recSessionId: "not-active",
        bridgeSentAt: Date.now(),
        bridgeSkew: 0,
      });
    }
    expect(await timingRows(t)).toEqual([]);

    // ON: an N-delta burst under the active session -> exactly N timing rows.
    const { sessionId } = await asAdmin.mutation(
      api.deliveryTiming.startDeliveryRecord,
      {},
    );
    const N = 200;
    for (let i = 0; i < N; i++) {
      await t.mutation(internal.stream.appendDelta, {
        messageId,
        text: "y",
        recSessionId: sessionId,
        bridgeSentAt: Date.now() - 5,
        bridgeSkew: 0,
        sizeBytes: 1,
      });
    }
    expect((await timingRows(t)).length).toBe(N); // linear, no leak / no dup
    const report = await asAdmin.query(api.deliveryTiming.getDeliveryReport, {
      sessionId,
    });
    expect(report.count).toBe(N);
    expect(report.segments!.A.count).toBe(N);
  });

  test("delete drains a session far larger than one batch (multi-step purge)", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "admin");
    const asAdmin = t.withIdentity({ subject: `${admin}|session` });
    const COUNT = 5000; // > 2 * TIMING_DELETE_BATCH (2000) -> 3 purge steps
    const sessionId = await t.run(async (ctx) => {
      const sid = await ctx.db.insert("deliverySessions", {
        startedAt: 1,
        startedBy: "test",
        autoStopAt: 2,
      });
      const chatId = await ctx.db.insert("chats", { userId: admin, updatedAt: 1 });
      for (let i = 0; i < COUNT; i++) {
        await ctx.db.insert("deliveryTimings", {
          sessionId: sid,
          chatId,
          t1: 0,
          t2: 0,
          t3: 1,
        });
      }
      return sid;
    });
    expect((await timingRows(t)).length).toBe(COUNT);

    vi.useFakeTimers();
    try {
      const res = await asAdmin.mutation(
        api.deliveryTiming.deleteDeliverySessions,
        { sessionIds: [sessionId] },
      );
      expect(res.scheduled).toBe(1);
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
    }

    // All COUNT rows purged across multiple bounded steps; session + report gone.
    expect(await timingRows(t)).toEqual([]);
    const report = await asAdmin.query(api.deliveryTiming.getDeliveryReport, {
      sessionId,
    });
    expect(report.count).toBe(0);
  });
});

// --- Re-analysis hardening guards -------------------------------------------
describe("delivery recorder — re-analysis hardening", () => {
  test("report excludes A for an uncalibrated delta (no bridgeSkew); keeps B and C", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "admin");
    const asAdmin = t.withIdentity({ subject: `${admin}|session` });
    const sessionId = "sess-hardening";
    await t.run(async (ctx) => {
      const chatId = await ctx.db.insert("chats", { userId: admin, updatedAt: 1 });
      // Untimed + uncalibrated + open: no t0, no bridgeSkew, no t4 -> bridge, A and C
      // ALL excluded (no segment can be computed for it).
      await ctx.db.insert("deliveryTimings", {
        sessionId,
        chatId,
        t1: 0,
        t2: 50,
        t3: 50,
      });
      // Fully timed: t0 + bridgeSkew + t4 -> bridge, A and C all present.
      await ctx.db.insert("deliveryTimings", {
        sessionId,
        chatId,
        t0: 10,
        t1: 14,
        t2: 30,
        t3: 30,
        bridgeSkew: 10,
        t4: 200,
        clientSkew: 5,
      });
    });

    const report = await asAdmin.query(api.deliveryTiming.getDeliveryReport, {
      sessionId,
    });
    expect(report.count).toBe(2);
    expect(report.segments!.bridge.count).toBe(1); // only the row with t0
    expect(report.segments!.bridge.max).toBe(4); // t1 14 - t0 10
    expect(report.segments!.A.count).toBe(1); // only the calibrated delta
    expect(report.segments!.A.max).toBe(6); // t2 30 - t1 14 - skew 10
    expect("B" in report.segments!).toBe(false); // no Convex-exec segment
    expect(report.segments!.C.count).toBe(1); // only the one with t4
    expect(report.segments!.C.max).toBe(175); // t4 200 - t3 30 + clientSkew 5
    expect(report.truncated).toBe(false);
  });

  test("listDeliverySessions derives stoppedAt for an auto-stopped (lapsed) session", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "admin");
    const asAdmin = t.withIdentity({ subject: `${admin}|session` });
    const past = Date.now() - 1000;
    await t.run(async (ctx) => {
      await ctx.db.insert("deliverySessions", {
        startedAt: past - 1000,
        startedBy: "test",
        autoStopAt: past, // lapsed, never explicitly stopped
      });
    });
    const sessions = await asAdmin.query(
      api.deliveryTiming.listDeliverySessions,
      {},
    );
    expect(sessions.length).toBe(1);
    expect(sessions[0]!.active).toBe(false);
    expect(sessions[0]!.stoppedAt).toBe(past); // derived from autoStopAt
  });
});

// --- Report cap boundary (off-by-one guard) ---------------------------------
describe("delivery recorder — report cap edge", () => {
  test("a session with EXACTLY REPORT_CAP rows is NOT flagged truncated", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "admin");
    const asAdmin = t.withIdentity({ subject: `${admin}|session` });
    const CAP = 10000; // = REPORT_CAP in convex/deliveryTiming.ts
    const sessionId = "sess-cap";
    await t.run(async (ctx) => {
      const chatId = await ctx.db.insert("chats", { userId: admin, updatedAt: 1 });
      for (let i = 0; i < CAP; i++) {
        await ctx.db.insert("deliveryTimings", {
          sessionId,
          chatId,
          t1: 0,
          t2: 0,
          t3: 1,
          bridgeSkew: 0,
        });
      }
    });
    const report = await asAdmin.query(api.deliveryTiming.getDeliveryReport, {
      sessionId,
    });
    expect(report.count).toBe(CAP);
    expect(report.truncated).toBe(false); // exactly at cap -> nothing omitted
  });
});
