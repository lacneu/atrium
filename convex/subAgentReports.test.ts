/// <reference types="vite/client" />
//
// SOC2 two-plane tests for USER reports on a sub-agent failure.
//
// THE LOAD-BEARING INVARIANT (§2a): the raw errorMessage/resultText/taskName are
// captured into the CONTENT-BEARING plane-1 record (subAgentReports) but NEVER
// cross into the CONTENT-FREE plane-2 anomaly. We seed a unique SENTINEL into all
// three content fields and assert:
//   - the plane-1 snapshot DOES contain the sentinel (the freeze works), AND
//   - the emitted anomaly row (evidence + message) contains NO sentinel.
// Plus: owner-scope, the source:"user"/kind anomaly, the "already reported"
// affordance, the admin metadata-vs-audited-content split.

import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { FIELD_TEXT_MAX_BYTES } from "./subAgentReports";

const modules = import.meta.glob("./**/*.ts");

// A unique canary placed in EVERY content field. Must never appear in plane-2.
const SENTINEL = "PHI_LEAK_CANARY_零_42";

async function setup(t: TestConvex<typeof schema>) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", {
      userId,
      role: "user" as const,
      canonical: "owner",
      email: "owner@example.com",
    });
    const otherId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", {
      userId: otherId,
      role: "user" as const,
      canonical: "other",
    });
    const adminId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", {
      userId: adminId,
      role: "admin" as const,
      canonical: "admin",
      email: "admin@example.com",
    });

    const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1 });
    // The spawning assistant turn (carries a runId → resolvable correlationId).
    const parentMessageId = await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "assistant" as const,
      status: "complete" as const,
      text: `parent turn ${SENTINEL}`,
      runId: "run-xyz",
      updatedAt: 1,
    });
    // A FAILED sub-agent, with the sentinel in ALL content fields.
    const subAgentId = await ctx.db.insert("subAgents", {
      chatId,
      parentMessageId,
      childSessionKey: "agent:main:subagent:abcdef0123456789",
      taskName: `task ${SENTINEL}`,
      status: "error" as const,
      errorMessage: `web_fetch failed (500) ${SENTINEL}`,
      resultText: `partial ${SENTINEL}`,
      phase: "tool",
      createdAt: 1,
      updatedAt: 2,
    });
    // A second FAILED sibling (aborted) — should also be captured.
    await ctx.db.insert("subAgents", {
      chatId,
      childSessionKey: "agent:main:subagent:sibling999",
      status: "aborted" as const,
      errorMessage: `aborted ${SENTINEL}`,
      createdAt: 1,
      updatedAt: 3,
    });
    return { userId, otherId, adminId, chatId, subAgentId };
  });
}

describe("createSubAgentReport — two-plane SOC2", () => {
  test("PLANE 1 freezes content; PLANE 2 anomaly is content-free (sentinel boundary)", async () => {
    const t = convexTest(schema, modules);
    const { userId, subAgentId } = await setup(t);
    const as = t.withIdentity({ subject: `${userId}|session` });

    const { reportId, anomalyId } = await as.mutation(
      api.subAgentReports.createSubAgentReport,
      { subAgentId, category: "error", comment: "it hung" },
    );

    await t.run(async (ctx) => {
      // --- PLANE 1: the snapshot DOES carry the raw content (freeze works) ---
      const report = await ctx.db.get(reportId);
      expect(report).not.toBeNull();
      const snapJson = JSON.stringify(report!.snapshot);
      expect(snapJson).toContain(SENTINEL); // errorMessage/taskName/resultText frozen
      expect(report!.snapshot.failedCount).toBe(2); // flagged + aborted sibling
      expect(report!.snapshot.totalCount).toBe(2);
      expect(report!.anomalyId).toEqual(anomalyId);
      expect(report!.userId).toEqual(userId);

      // --- PLANE 2: the anomaly is CONTENT-FREE ---
      // Fetch via the table query (not ctx.db.get(anomalyId)): the mutation's
      // return type widened to `Id | null` for the idempotent path, which would
      // resolve get() to the all-tables doc union. There is exactly one anomaly.
      const anomalies = await ctx.db.query("anomalies").collect();
      expect(anomalies.length).toBe(1);
      const anomaly = anomalies[0];
      expect(anomaly!.source).toBe("user");
      expect(anomaly!.kind).toBe("subagent.failure");
      expect(anomaly!.severity).toBe("warn");
      // THE INVARIANT: nothing on the whole anomaly row leaks the sentinel.
      expect(JSON.stringify(anomaly)).not.toContain(SENTINEL);

      // Evidence carries the structure + the opaque pointer, never content.
      const evidence = JSON.parse(anomaly!.evidence!) as {
        reportId: string;
        errorCategories: string[];
        parentCorrelationId: string;
      };
      expect(evidence.reportId).toEqual(reportId);
      expect(evidence.errorCategories).toEqual(["api_error", "aborted"]);
      // chatId:runId resolved from the spawning turn.
      expect(evidence.parentCorrelationId).toContain(":run-xyz");
      expect(anomaly!.correlationId).toEqual(evidence.parentCorrelationId);
    });
  });

  test("owner-scope: a non-owner cannot report on another user's sub-agent", async () => {
    const t = convexTest(schema, modules);
    const { otherId, subAgentId } = await setup(t);
    const asOther = t.withIdentity({ subject: `${otherId}|session` });
    await expect(
      asOther.mutation(api.subAgentReports.createSubAgentReport, { subAgentId }),
    ).rejects.toThrow(/not owned/);
    // And no anomaly was emitted by the rejected attempt.
    const count = await t.run(async (ctx) =>
      (await ctx.db.query("anomalies").collect()).length,
    );
    expect(count).toBe(0);
  });

  test("rejects a STILL-RUNNING sub-agent (no report, no anomaly, no notification)", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await setup(t);
    // A running child in the owner's chat (server must reject reporting it even if
    // a stale UI / a direct call tries to).
    const runningId = await t.run(async (ctx) => {
      const chatId = await ctx.db
        .query("chats")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .first()
        .then((c) => c!._id);
      return ctx.db.insert("subAgents", {
        chatId,
        childSessionKey: "agent:main:subagent:running1",
        status: "running" as const,
        phase: "tool",
        createdAt: 1,
        updatedAt: 2,
      });
    });
    const as = t.withIdentity({ subject: `${userId}|session` });
    await expect(
      as.mutation(api.subAgentReports.createSubAgentReport, {
        subAgentId: runningId,
      }),
    ).rejects.toThrow(/still running/);
    // No side effects from the rejected attempt.
    const counts = await t.run(async (ctx) => ({
      reports: (await ctx.db.query("subAgentReports").collect()).length,
      anomalies: (await ctx.db.query("anomalies").collect()).length,
      notifs: (await ctx.db.query("notifications").collect()).length,
    }));
    expect(counts).toEqual({ reports: 0, anomalies: 0, notifs: 0 });
  });

  test("myReportedSubAgentIds marks the flagged sub-agent for its owner", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, subAgentId } = await setup(t);
    const as = t.withIdentity({ subject: `${userId}|session` });
    await as.mutation(api.subAgentReports.createSubAgentReport, { subAgentId });
    const ids = await as.query(api.subAgentReports.myReportedSubAgentIds, {
      chatId,
    });
    expect(ids).toContain(subAgentId);
  });

  test("IDEMPOTENT: reporting the same (user, sub-agent) twice → ONE report, ONE anomaly, ONE notification", async () => {
    const t = convexTest(schema, modules);
    const { userId, subAgentId } = await setup(t);
    const as = t.withIdentity({ subject: `${userId}|session` });
    const first = await as.mutation(
      api.subAgentReports.createSubAgentReport,
      { subAgentId, comment: "first" },
    );
    const second = await as.mutation(
      api.subAgentReports.createSubAgentReport,
      { subAgentId, comment: "second" },
    );
    // The second call returns the FIRST report (no new row).
    expect(second.reportId).toEqual(first.reportId);
    expect(second.anomalyId).toEqual(first.anomalyId);

    const counts = await t.run(async (ctx) => ({
      reports: (await ctx.db.query("subAgentReports").collect()).length,
      anomalies: (await ctx.db.query("anomalies").collect()).length,
    }));
    expect(counts.reports).toBe(1);
    expect(counts.anomalies).toBe(1);
    // The duplicate did NOT overwrite the original (its comment is preserved).
    const stored = await t.run(async (ctx) => {
      const r = await ctx.db.get(first.reportId);
      return r?.comment;
    });
    expect(stored).toBe("first");
  });
});

describe("createSubAgentReport — frozen text is bounded (Convex ~1MB doc limit)", () => {
  test("a >1MB failure SUCCEEDS: each text field clipped, doc < 1MB, textTruncated=true", async () => {
    const t = convexTest(schema, modules);
    // 600KB per field × (errorMessage+resultText+taskName+parentText) ≈ 2.4MB raw
    // — far over the 1MB document limit; the insert must NOT throw.
    const big = "Z".repeat(600_000);
    const { userId, subAgentId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId,
        role: "user" as const,
        canonical: "big",
      });
      const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1 });
      const parentMessageId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: big,
        runId: "run-big",
        updatedAt: 1,
      });
      const subAgentId = await ctx.db.insert("subAgents", {
        chatId,
        parentMessageId,
        childSessionKey: "agent:m:subagent:big1",
        taskName: big,
        status: "error" as const,
        errorMessage: big,
        resultText: big,
        phase: "tool",
        createdAt: 1,
        updatedAt: 2,
      });
      return { userId, subAgentId };
    });
    const as = t.withIdentity({ subject: `${userId}|session` });

    // The whole point: this resolves (no throw) — an over-cap insert would lose
    // both the report AND the anomaly exactly when the failure matters most.
    const { reportId } = await as.mutation(
      api.subAgentReports.createSubAgentReport,
      { subAgentId },
    );

    await t.run(async (ctx) => {
      const r = await ctx.db.get(reportId);
      expect(r).not.toBeNull();
      expect(r!.snapshot.textTruncated).toBe(true);
      const enc = new TextEncoder();
      const child = r!.snapshot.children[0];
      expect(enc.encode(child.errorMessage!).length).toBeLessThanOrEqual(
        FIELD_TEXT_MAX_BYTES,
      );
      expect(enc.encode(child.resultText!).length).toBeLessThanOrEqual(
        FIELD_TEXT_MAX_BYTES,
      );
      expect(enc.encode(child.taskName!).length).toBeLessThanOrEqual(
        FIELD_TEXT_MAX_BYTES,
      );
      expect(enc.encode(r!.snapshot.parentText!).length).toBeLessThanOrEqual(
        FIELD_TEXT_MAX_BYTES,
      );
      // The whole stored document is comfortably under Convex's ~1MB cap.
      expect(enc.encode(JSON.stringify(r)).length).toBeLessThan(1_000_000);
    });
  });
});

describe("admin administration — metadata vs audited content", () => {
  test("listForAdmin returns NO content; readReport returns content + writes an audit row", async () => {
    const t = convexTest(schema, modules);
    const { userId, adminId, subAgentId } = await setup(t);
    const as = t.withIdentity({ subject: `${userId}|session` });
    const { reportId } = await as.mutation(
      api.subAgentReports.createSubAgentReport,
      { subAgentId, comment: "broken" },
    );

    const asAdmin = t.withIdentity({ subject: `${adminId}|session` });

    // METADATA list — must be free of the frozen snapshot content.
    const list = await asAdmin.query(api.subAgentReports.listForAdmin, {});
    expect(list.length).toBe(1);
    expect(JSON.stringify(list)).not.toContain(SENTINEL);
    expect(list[0].failedCount).toBe(2);

    // AUDITED content read — returns the snapshot WITH content.
    const detail = await asAdmin.mutation(api.subAgentReports.readReport, {
      reportId,
    });
    expect(JSON.stringify(detail.snapshot)).toContain(SENTINEL);

    // The read wrote an audit row attributing admin → owner.
    const audited = await t.run(async (ctx) => {
      const rows = await ctx.db.query("auditLog").collect();
      return rows.find((r) => r.action === "subagent_report.read.content");
    });
    expect(audited).toBeTruthy();
    expect(audited!.realUserId).toEqual(adminId);
    expect(audited!.effectiveUserId).toEqual(userId);
  });

  test("listForAdmin requires admin (a regular user is rejected)", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await setup(t);
    const as = t.withIdentity({ subject: `${userId}|session` });
    await expect(
      as.query(api.subAgentReports.listForAdmin, {}),
    ).rejects.toThrow(/admin/);
  });

  test("respondToReport appends an admin note to the thread (no owner notification yet)", async () => {
    const t = convexTest(schema, modules);
    const { userId, adminId, subAgentId } = await setup(t);
    const as = t.withIdentity({ subject: `${userId}|session` });
    const { reportId } = await as.mutation(
      api.subAgentReports.createSubAgentReport,
      { subAgentId },
    );
    const asAdmin = t.withIdentity({ subject: `${adminId}|session` });
    await asAdmin.mutation(api.subAgentReports.respondToReport, {
      reportId,
      text: "looking into it",
    });
    const { thread, ownerNotifs } = await t.run(async (ctx) => {
      const r = await ctx.db.get(reportId);
      const ownerNotifs = await ctx.db
        .query("notifications")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect();
      return { thread: r!.thread, ownerNotifs };
    });
    expect(thread?.length).toBe(1);
    expect(thread?.[0].authorRole).toBe("admin");
    expect(thread?.[0].text).toBe("looking into it");
    // The owner-facing read surface + its notification are a deferred follow-up:
    // the reply must NOT fire a notification the user can't read (no void notify).
    expect(ownerNotifs.length).toBe(0);
  });
});
