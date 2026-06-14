/// <reference types="vite/client" />
//
// Query-level tests for the filter wiring + the deleteServiceAccount cascade.
//
// Admin paths use t.withIdentity({ subject: `${userId}|session` }) (the same
// pattern as fixes.test.ts) so requireAdmin's REAL-identity gate resolves to a
// seeded admin profile.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");

/** Seed an admin user+profile and return an identity-bound test client. */
async function seedAdmin(t: ReturnType<typeof convexTest>) {
  const userId = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "admin" });
    return userId;
  });
  return { userId, as: t.withIdentity({ subject: `${userId}|session` }) };
}

describe("listEvents — filter narrows results", () => {
  test("statusClass + q + time range narrow the trace set", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedAdmin(t);
    const now = Date.now();

    await t.run(async (ctx) => {
      // 2xx api.call, 4xx api.call, 5xx openclaw.dispatch — all recent.
      await ctx.db.insert("traceEvents", {
        at: now - 1000,
        kind: "api.call",
        principalType: "service",
        roleKey: "observer",
        route: "/api/v1/traces",
        status: 200,
        redacted: true,
      });
      await ctx.db.insert("traceEvents", {
        at: now - 2000,
        kind: "api.call",
        principalType: "service",
        roleKey: "observer",
        route: "/api/v1/kpi",
        status: 404,
        redacted: true,
      });
      await ctx.db.insert("traceEvents", {
        at: now - 3000,
        kind: "openclaw.dispatch",
        principalType: "system",
        status: 500,
        redacted: true,
      });
      // An OLD row outside a now-1h window (must be excluded by the range).
      await ctx.db.insert("traceEvents", {
        at: now - 3 * 60 * 60 * 1000,
        kind: "api.call",
        principalType: "service",
        status: 200,
        redacted: true,
      });
    });

    // No filter -> all 4.
    const all = await as.query(api.observability.listEvents, {});
    expect(all.length).toBe(4);

    // statusClass=4xx -> only the 404 api.call.
    const fourxx = await as.query(api.observability.listEvents, {
      filter: { statusClass: "4xx" },
    });
    expect(fourxx.length).toBe(1);
    expect(fourxx[0]!.status).toBe(404);

    // exact numeric status=404 -> the same single 404 row (the orphan-param bug
    // guard: status must actually filter, not be parsed-and-dropped).
    const exact404 = await as.query(api.observability.listEvents, {
      filter: { status: 404 },
    });
    expect(exact404.length).toBe(1);
    expect(exact404[0]!.status).toBe(404);

    // q over route -> only the /api/v1/kpi row.
    const byRoute = await as.query(api.observability.listEvents, {
      filter: { q: "/api/v1/kpi" },
    });
    expect(byRoute.length).toBe(1);
    expect(byRoute[0]!.route).toBe("/api/v1/kpi");

    // time range now-1h..now -> excludes the 3h-old row (3 of 4 remain).
    const recent = await as.query(api.observability.listEvents, {
      filter: { from: now - 60 * 60 * 1000, to: now },
    });
    expect(recent.length).toBe(3);

    // advanced predicate: status gte 400 -> the 404 + 500 rows.
    const errors = await as.query(api.observability.listEvents, {
      filter: { advanced: [{ field: "status", op: "gte", value: 400 }] },
    });
    expect(errors.length).toBe(2);
    expect(errors.map((e) => e.status).sort()).toEqual([404, 500]);
  });
});

describe("listAnomalies — filter narrows results", () => {
  test("severity + q narrow the anomaly set", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedAdmin(t);
    const now = Date.now();

    await t.run(async (ctx) => {
      await ctx.db.insert("anomalies", {
        at: now - 1000,
        kind: "api.error_ratio",
        severity: "critical",
        status: "open",
        message: "High API error ratio",
        source: "detector",
      });
      await ctx.db.insert("anomalies", {
        at: now - 2000,
        kind: "assistant.stream_errors",
        severity: "warn",
        status: "open",
        message: "Stream error burst",
        source: "detector",
      });
      await ctx.db.insert("anomalies", {
        at: now - 3000,
        kind: "openclaw.dispatch_failures",
        severity: "warn",
        status: "resolved",
        message: "Dispatch failures",
        source: "agent",
      });
    });

    const all = await as.query(api.anomalies.listAnomalies, {});
    expect(all.length).toBe(3);

    // severity=warn -> the two warn rows.
    const warns = await as.query(api.anomalies.listAnomalies, {
      filter: { severity: "warn" },
    });
    expect(warns.length).toBe(2);

    // q over message -> only the "High API error ratio" row.
    const byMsg = await as.query(api.anomalies.listAnomalies, {
      filter: { q: "high api" },
    });
    expect(byMsg.length).toBe(1);
    expect(byMsg[0]!.kind).toBe("api.error_ratio");

    // anomalyStatus=resolved via filter (no dedicated status arg) -> 1 row.
    const resolved = await as.query(api.anomalies.listAnomalies, {
      filter: { anomalyStatus: "resolved" },
    });
    expect(resolved.length).toBe(1);
    expect(resolved[0]!.source).toBe("agent");

    // source=agent -> the one agent-reported row.
    const agentRows = await as.query(api.anomalies.listAnomalies, {
      filter: { source: "agent" },
    });
    expect(agentRows.length).toBe(1);
  });
});

describe("deleteServiceAccount — cascade", () => {
  test("removes the account + all its keys + writes an audit row", async () => {
    const t = convexTest(schema, modules);
    const { as, userId } = await seedAdmin(t);

    // Seed a service account with two API keys directly in db context.
    const { serviceAccountId, keyA, keyB } = await t.run(async (ctx) => {
      const serviceAccountId = await ctx.db.insert("serviceAccounts", {
        name: "to-delete",
        roleKey: "observer",
        disabled: false,
        createdByUserId: userId,
      });
      const keyA = await ctx.db.insert("apiKeys", {
        serviceAccountId,
        hashedKey: "hashA",
        prefix: "oc_live_A",
        lastFour: "aaaa",
        disabled: false,
        createdAt: Date.now(),
      });
      const keyB = await ctx.db.insert("apiKeys", {
        serviceAccountId,
        hashedKey: "hashB",
        prefix: "oc_live_B",
        lastFour: "bbbb",
        disabled: true, // a revoked key must also be cascaded
        createdAt: Date.now(),
      });
      return { serviceAccountId, keyA, keyB };
    });

    const result = await as.mutation(api.apiKeys.deleteServiceAccount, {
      serviceAccountId,
    });
    expect(result.ok).toBe(true);
    expect(result.deletedKeys).toBe(2);

    // Account gone, both keys gone.
    await t.run(async (ctx) => {
      expect(await ctx.db.get(serviceAccountId)).toBeNull();
      expect(await ctx.db.get(keyA)).toBeNull();
      expect(await ctx.db.get(keyB)).toBeNull();
      // No keys remain on the by_account index.
      const remaining = await ctx.db
        .query("apiKeys")
        .withIndex("by_account", (q) =>
          q.eq("serviceAccountId", serviceAccountId),
        )
        .collect();
      expect(remaining.length).toBe(0);
    });

    // An audit row was written for the delete.
    const audit = await as.query(api.admin.listAudit, {});
    const row = audit.find((a) => a.action === "serviceAccount.delete");
    expect(row).toBeDefined();
    expect(row!.resource).toBe("serviceAccount");
    expect(row!.resourceId).toBe(serviceAccountId);
  });

  test("throws Not found for a missing account", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedAdmin(t);
    // Insert then delete a SA to obtain a valid-but-stale id.
    const staleId = await t.run(async (ctx) => {
      const u = await ctx.db.insert("users", {});
      const id = await ctx.db.insert("serviceAccounts", {
        name: "ghost",
        roleKey: "observer",
        disabled: false,
        createdByUserId: u,
      });
      await ctx.db.delete(id);
      return id as Id<"serviceAccounts">;
    });
    await expect(
      as.mutation(api.apiKeys.deleteServiceAccount, { serviceAccountId: staleId }),
    ).rejects.toThrow(/not found/i);
  });
});

describe("kpisInternal — time range filter (bucket conversion)", () => {
  test("filter.from/to (ms) narrows to the matching hour buckets", async () => {
    const t = convexTest(schema, modules);

    // Two buckets an hour apart. ISO hour strings sort == chronologically.
    await t.run(async (ctx) => {
      await ctx.db.insert("kpiRollups", {
        bucket: "2026-06-02T10",
        metric: "api.calls",
        value: 5,
      });
      await ctx.db.insert("kpiRollups", {
        bucket: "2026-06-02T12",
        metric: "api.calls",
        value: 9,
      });
    });

    // from = 2026-06-02T11:00Z (ms) -> bucket "2026-06-02T11"; only the T12 row.
    const fromMs = Date.parse("2026-06-02T11:00:00Z");
    const rows = await t.query(internal.kpi.kpisInternal, {
      filter: { from: fromMs },
    });
    expect(rows.length).toBe(1);
    expect(rows[0]!.bucket).toBe("2026-06-02T12");
  });
});
