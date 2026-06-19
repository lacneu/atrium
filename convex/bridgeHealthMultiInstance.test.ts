/// <reference types="vite/client" />
//
// Model M: pollBridgeHealth fans out to each instance's OWN bridge and AGGREGATES
// into the singleton — union of targets (each forced to its instance + tagged with
// that bridge's maxPayload), reachable = any reachable, doc.maxPayload = MIN. And
// maxPayloadInternal resolves the cap per ROUTED instance (the precise per-instance
// frame limit), falling back to the doc-level min, then null.

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

function healthBody(instanceName: string, maxPayload: number) {
  return new Response(
    JSON.stringify({
      status: "ok",
      startedAt: 1000,
      maxPayload,
      targets: [
        {
          key: `${instanceName}:main:alice`,
          instanceName,
          canonical: "alice",
          agentId: "main",
          gatewayHost: `gw-${instanceName}`,
          state: "connected",
          lastOkAt: 1,
          attempts: 1,
          okCount: 1,
          errorCount: 0,
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("pollBridgeHealth — multi-instance aggregation (Model M)", () => {
  let origFetch: typeof fetch;
  let prevUrl: string | undefined;
  let prevServed: string | undefined;

  beforeEach(() => {
    origFetch = globalThis.fetch;
    prevUrl = process.env.BRIDGE_URL;
    prevServed = process.env.BRIDGE_INSTANCE_NAME;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
    if (prevUrl === undefined) delete process.env.BRIDGE_URL;
    else process.env.BRIDGE_URL = prevUrl;
    if (prevServed === undefined) delete process.env.BRIDGE_INSTANCE_NAME;
    else process.env.BRIDGE_INSTANCE_NAME = prevServed;
  });

  test("unions both instances' targets, tags per-instance maxPayload, doc.maxPayload = MIN", async () => {
    const t = convexTest(schema, modules);
    delete process.env.BRIDGE_URL;
    await t.run(async (ctx) => {
      await ctx.db.insert("instances", {
        name: "olivier",
        gatewayUrl: "ws://g1",
        bridgeUrl: "http://b-olivier:8787",
      });
      await ctx.db.insert("instances", {
        name: "jerome",
        gatewayUrl: "ws://g2",
        bridgeUrl: "http://b-jerome:8787",
      });
    });
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input);
      if (u.startsWith("http://b-olivier:8787")) return healthBody("olivier", 26214400);
      if (u.startsWith("http://b-jerome:8787")) return healthBody("jerome", 10000000);
      throw new Error(`unexpected url ${u}`);
    }) as unknown as typeof fetch;

    await t.action(internal.bridgeHealth.pollBridgeHealth, {});

    const doc = await t.run((ctx) =>
      ctx.db
        .query("bridgeHealth")
        .withIndex("by_key", (q) => q.eq("key", "singleton"))
        .unique(),
    );
    expect(doc?.reachable).toBe(true);
    expect(doc?.targets).toHaveLength(2);
    const byInstance = Object.fromEntries(
      (doc?.targets ?? []).map((tg) => [tg.instanceName, tg.maxPayload]),
    );
    expect(byInstance).toEqual({ olivier: 26214400, jerome: 10000000 });
    // doc-level = MIN across instances (conservative global gate).
    expect(doc?.maxPayload).toBe(10000000);
  });

  test("maxPayloadInternal resolves the cap per ROUTED instance, else the doc MIN, else null", async () => {
    const t = convexTest(schema, modules);
    delete process.env.BRIDGE_URL;
    await t.run(async (ctx) => {
      await ctx.db.insert("instances", {
        name: "olivier",
        gatewayUrl: "ws://g1",
        bridgeUrl: "http://b-olivier:8787",
      });
      await ctx.db.insert("instances", {
        name: "jerome",
        gatewayUrl: "ws://g2",
        bridgeUrl: "http://b-jerome:8787",
      });
    });
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input);
      if (u.startsWith("http://b-olivier:8787")) return healthBody("olivier", 26214400);
      if (u.startsWith("http://b-jerome:8787")) return healthBody("jerome", 10000000);
      throw new Error(`unexpected url ${u}`);
    }) as unknown as typeof fetch;
    await t.action(internal.bridgeHealth.pollBridgeHealth, {});

    const cap = (instanceName: string | null) =>
      t.query(internal.bridgeHealth.maxPayloadInternal, { instanceName });
    expect(await cap("olivier")).toBe(26214400); // its OWN frame limit
    expect(await cap("jerome")).toBe(10000000); // its OWN frame limit
    expect(await cap("ghost")).toBe(10000000); // unknown instance → doc MIN
    expect(await cap(null)).toBe(10000000); // no instance → doc MIN
  });

  test("one instance DOWN: the other stays reachable (no shared fate)", async () => {
    const t = convexTest(schema, modules);
    delete process.env.BRIDGE_URL;
    await t.run(async (ctx) => {
      await ctx.db.insert("instances", {
        name: "olivier",
        gatewayUrl: "ws://g1",
        bridgeUrl: "http://b-olivier:8787",
      });
      await ctx.db.insert("instances", {
        name: "jerome",
        gatewayUrl: "ws://g2",
        bridgeUrl: "http://b-jerome:8787",
      });
    });
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input);
      if (u.startsWith("http://b-olivier:8787")) return healthBody("olivier", 26214400);
      throw new Error("ECONNREFUSED"); // jerome's bridge is down
    }) as unknown as typeof fetch;
    await t.action(internal.bridgeHealth.pollBridgeHealth, {});

    const doc = await t.run((ctx) =>
      ctx.db
        .query("bridgeHealth")
        .withIndex("by_key", (q) => q.eq("key", "singleton"))
        .unique(),
    );
    expect(doc?.reachable).toBe(true); // olivier up → aggregate reachable
    expect(doc?.targets.map((tg) => tg.instanceName)).toEqual(["olivier"]);
    // olivier's cap still resolves; jerome falls back to the doc-level value.
    expect(
      await t.query(internal.bridgeHealth.maxPayloadInternal, {
        instanceName: "olivier",
      }),
    ).toBe(26214400);
  });
});
