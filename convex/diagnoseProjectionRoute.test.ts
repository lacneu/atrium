/// <reference types="vite/client" />
//
// GET /api/v1/diagnose — the projection part can NEVER fail the diagnosis.
//
// Driven through the REAL route and the REAL projection query: only the report
// loader underneath the query is replaced (module mock, this file only), so the
// failure is raised exactly where a production one would be — inside the query the
// route runs. A route that calls that query without the isolating helper lets the
// error escape and loses the whole diagnosis; this test is what catches it.

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { hashKey } from "./lib/apikeys";
import schema from "./schema";

const loader = vi.hoisted(() => ({ fail: false, calls: 0 }));

vi.mock("./lib/transcriptProjection", async (importOriginal) => {
  const original = await importOriginal<typeof import("./lib/transcriptProjection")>();
  return {
    ...original,
    loadProjectionReport: async (...args: Parameters<typeof original.loadProjectionReport>) => {
      loader.calls += 1;
      if (loader.fail) throw new Error("projection report failed");
      return original.loadProjectionReport(...args);
    },
  };
});

const modules = import.meta.glob("./**/*.ts");
const KEY = "oc_test_diag_key";

async function seed(t: TestConvex<typeof schema>) {
  const hashedKey = await hashKey(KEY);
  return t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", {});
    await ctx.db.insert("instances", {
      name: "alpha",
      gatewayUrl: "ws://gw",
      config: { transcriptProjection: "shadow" } as never,
    });
    const chatId = await ctx.db.insert("chats", {
      userId: owner,
      updatedAt: 1,
      instanceName: "alpha",
    });
    await ctx.db.insert("roles", {
      key: "diag",
      name: "Diag",
      builtin: false,
      permissions: ["traces.read"],
    });
    const serviceAccountId = await ctx.db.insert("serviceAccounts", {
      name: "svc-diag",
      roleKey: "diag",
      disabled: false,
      createdByUserId: owner,
    });
    await ctx.db.insert("apiKeys", {
      serviceAccountId,
      hashedKey,
      prefix: "oc_test_diag",
      lastFour: "key1",
      disabled: false,
      createdAt: Date.now(),
    });
    return { chatId };
  });
}

const diagnose = (t: TestConvex<typeof schema>, chatId: string) =>
  t.fetch(`/api/v1/diagnose?chatId=${chatId}`, {
    headers: { Authorization: `Bearer ${KEY}` },
  });

afterEach(() => {
  loader.fail = false;
  loader.calls = 0;
});

describe("GET /api/v1/diagnose — projection isolation", () => {
  test("the seam is live: the route's projection goes through the replaced loader", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const res = await diagnose(t, chatId);
    expect(res.status).toBe(200);
    expect(loader.calls).toBe(1);
    const body = (await res.json()) as { projection: { verdict: string } };
    expect(body.projection.verdict).toBe("not_projected");
  });

  test("a projection query that THROWS leaves the diagnosis whole and reads `unavailable`", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    loader.fail = true;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await diagnose(t, chatId);
      expect(res.status).toBe(200);
      expect(loader.calls).toBe(1);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.ok).toBe(true);
      expect(Object.keys(body).sort()).toEqual(
        ["assessment", "availability", "chatState", "ok", "projection"].sort(),
      );
      expect(body.assessment).toEqual(expect.objectContaining({ class: expect.any(String) }));
      expect(body.projection).toEqual({
        verdict: "unavailable",
        reason: "projection_query_failed",
      });
      // The failure is logged by its class only — never its message.
      expect(errors).toHaveBeenCalledWith("diagnose: projection report unavailable:", "Error");
    } finally {
      errors.mockRestore();
    }
  });
});
