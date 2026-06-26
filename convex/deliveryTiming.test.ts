// Delivery-latency recorder (convex/deliveryTiming.ts). Each test fails if its
// target regresses: the OFF default writes/ships nothing; an active recording times
// every tagged delta and the report applies the skews (asserted by recomputing from
// the raw rows, robust to the real clock); a delta tagged with a NON-active session
// is rejected (no cross-session contamination); recordFrontendTiming closes segment
// C keyed by the timing row id; stop + auto-stop disable; activation is admin-only
// and the report needs traces.read.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
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
    const expectedBmax = Math.max(...rows.map((r) => r.t3 - r.t2));
    expect(report.segments!.B.max).toBe(expectedBmax);
    expect(report.segments!.B.max).toBeGreaterThanOrEqual(0);
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
    // Controlled rows: B = t3 - t2 = [10,20,30,40] (t2=0).
    await t.run(async (ctx) => {
      const chatId = await ctx.db.insert("chats", {
        userId: admin,
        updatedAt: 1,
      });
      for (const b of [10, 20, 30, 40]) {
        await ctx.db.insert("deliveryTimings", {
          sessionId,
          chatId,
          t1: 0,
          t2: 0,
          t3: b,
        });
      }
    });

    const report = await asAdmin.query(api.deliveryTiming.getDeliveryReport, {
      sessionId,
    });
    expect(report.count).toBe(4);
    // Nearest-rank p50 of [10,20,30,40] = idx ceil(0.5*4)-1 = 1 -> 20.
    // The old floor() bug returned idx 2 -> 30, so this assert guards the fix.
    expect(report.segments!.B.p50).toBe(20);
    expect(report.segments!.B.p95).toBe(40);
    expect(report.segments!.B.max).toBe(40);
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
});
