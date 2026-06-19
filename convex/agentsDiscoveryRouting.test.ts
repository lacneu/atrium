/// <reference types="vite/client" />
//
// Model M: pollAgentDiscovery polls EACH instance's OWN bridgeUrl (so a second
// instance's agents are discovered from its own bridge), falling back to the env
// BRIDGE_URL only for the served / sole instance (never caching the env bridge's
// agents under another instance's name).

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

function agentsResponse() {
  return new Response(
    JSON.stringify({
      agents: [
        {
          agentId: "alice",
          displayName: "Alice",
          emoji: null,
          model: "m",
          isDefaultOnInstance: true,
        },
      ],
      count: 1,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** Pull the instance from a polled `/agents?instance=NAME` URL. */
function instanceOf(url: string): string {
  return new URL(url).searchParams.get("instance") ?? "";
}

describe("pollAgentDiscovery — per-instance bridgeUrl (Model M)", () => {
  let origFetch: typeof fetch;
  let prevUrl: string | undefined;
  let prevServed: string | undefined;
  let prevSecret: string | undefined;

  beforeEach(() => {
    origFetch = globalThis.fetch;
    prevUrl = process.env.BRIDGE_URL;
    prevServed = process.env.BRIDGE_INSTANCE_NAME;
    prevSecret = process.env.BRIDGE_SHARED_SECRET;
    process.env.BRIDGE_SHARED_SECRET = "secret";
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
    const restore = (k: string, v: string | undefined) =>
      v === undefined ? delete process.env[k] : (process.env[k] = v);
    restore("BRIDGE_URL", prevUrl);
    restore("BRIDGE_INSTANCE_NAME", prevServed);
    restore("BRIDGE_SHARED_SECRET", prevSecret);
  });

  test("polls each instance's OWN bridgeUrl and caches agents per-instance", async () => {
    const t = convexTest(schema, modules);
    delete process.env.BRIDGE_URL; // no env fallback in play
    await t.run(async (ctx) => {
      await ctx.db.insert("instances", {
        name: "olivier",
        gatewayUrl: "ws://gw1",
        bridgeUrl: "http://bridge-olivier:8787",
      });
      await ctx.db.insert("instances", {
        name: "jerome",
        gatewayUrl: "ws://gw2",
        bridgeUrl: "http://bridge-jerome:8787",
      });
    });
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return agentsResponse();
    }) as unknown as typeof fetch;

    await t.action(internal.agents.pollAgentDiscovery, {});

    // Each instance was polled against its OWN bridge host.
    expect(calls.some((u) => u.startsWith("http://bridge-olivier:8787/agents"))).toBe(true);
    expect(calls.some((u) => u.startsWith("http://bridge-jerome:8787/agents"))).toBe(true);
    expect(calls.map(instanceOf).sort()).toEqual(["jerome", "olivier"]);

    // Agents cached under EACH instance name (not corrupted onto one).
    const rows = await t.run((ctx) => ctx.db.query("agents").collect());
    expect(rows.filter((r) => r.instanceName === "olivier").length).toBe(1);
    expect(rows.filter((r) => r.instanceName === "jerome").length).toBe(1);
  });

  test("an instance WITHOUT bridgeUrl uses env BRIDGE_URL only when it is the served instance", async () => {
    const t = convexTest(schema, modules);
    process.env.BRIDGE_URL = "http://env-bridge:8787";
    process.env.BRIDGE_INSTANCE_NAME = "olivier";
    await t.run(async (ctx) => {
      await ctx.db.insert("instances", { name: "olivier", gatewayUrl: "ws://gw1" });
      // NOT served, no own bridgeUrl, not sole → must be SKIPPED (no corruption).
      await ctx.db.insert("instances", { name: "jerome", gatewayUrl: "ws://gw2" });
    });
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return agentsResponse();
    }) as unknown as typeof fetch;

    await t.action(internal.agents.pollAgentDiscovery, {});

    // Only the served instance was polled (via env); jerome was skipped.
    expect(calls.map(instanceOf)).toEqual(["olivier"]);
    expect(calls[0].startsWith("http://env-bridge:8787/agents")).toBe(true);
    const rows = await t.run((ctx) => ctx.db.query("agents").collect());
    expect(rows.every((r) => r.instanceName === "olivier")).toBe(true);
  });

  test("a per-instance bridgeUrl WINS over the env fallback for that instance", async () => {
    const t = convexTest(schema, modules);
    process.env.BRIDGE_URL = "http://env-bridge:8787";
    process.env.BRIDGE_INSTANCE_NAME = "olivier";
    await t.run(async (ctx) => {
      await ctx.db.insert("instances", {
        name: "olivier",
        gatewayUrl: "ws://gw1",
        bridgeUrl: "http://own-olivier:8787",
      });
    });
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return agentsResponse();
    }) as unknown as typeof fetch;

    await t.action(internal.agents.pollAgentDiscovery, {});
    expect(calls[0].startsWith("http://own-olivier:8787/agents")).toBe(true);
  });
});
