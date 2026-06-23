/// <reference types="vite/client" />
//
// Agent TYPES — the fixed code-defined catalogue (conversational | documentary) +
// per-agent assignment. Pins the pure registry helpers AND setAgentTypes (admin
// gate, unknown-code rejection, dedup/normalisation, default-on-read), so the
// parallel "documentary source" action can rely on a correct type model.

import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import {
  AGENT_TYPE_CODES,
  DEFAULT_AGENT_TYPE,
  normalizeAgentTypes,
  resolveAgentTypes,
} from "./lib/agentTypes";

const modules = import.meta.glob("./**/*.ts");

async function seed(t: TestConvex<typeof schema>, role: "admin" | "user") {
  const userId = await t.run(async (ctx) => {
    const uid = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId: uid, role });
    await ctx.db.insert("instances", {
      name: "primary",
      gatewayUrl: "ws://gw",
    });
    await ctx.db.insert("agents", {
      instanceName: "primary",
      agentId: "alice",
      source: "discovered" as const,
      presentInLastOk: true,
      firstSeenAt: 1,
      lastSeenAt: 1,
    });
    return uid;
  });
  return t.withIdentity({ subject: `${userId}|session` });
}

const storedTypes = (t: TestConvex<typeof schema>, agentId: string) =>
  t.run(async (ctx) => {
    const a = await ctx.db
      .query("agents")
      .withIndex("by_instance_agent", (q) =>
        q.eq("instanceName", "primary").eq("agentId", agentId),
      )
      .unique();
    return a?.types;
  });

describe("agent-types pure registry", () => {
  test("resolveAgentTypes defaults to conversational when unset/empty/unknown", () => {
    expect(resolveAgentTypes(undefined)).toEqual([DEFAULT_AGENT_TYPE]);
    expect(resolveAgentTypes([])).toEqual([DEFAULT_AGENT_TYPE]);
    expect(resolveAgentTypes(["nope"])).toEqual([DEFAULT_AGENT_TYPE]);
    // de-dups + filters unknown + orders by the catalogue (never empty).
    expect(resolveAgentTypes(["documentary", "documentary", "x"])).toEqual([
      "documentary",
    ]);
    expect(resolveAgentTypes(["documentary", "conversational"])).toEqual([
      ...AGENT_TYPE_CODES,
    ]);
  });

  test("normalizeAgentTypes throws on an unknown code; dedups + orders valid ones", () => {
    expect(() => normalizeAgentTypes(["conversational", "bogus"])).toThrow(
      /Unknown agent type/,
    );
    expect(normalizeAgentTypes(["documentary", "conversational", "documentary"])).toEqual(
      [...AGENT_TYPE_CODES],
    );
  });
});

describe("setAgentTypes mutation", () => {
  test("admin sets types; they are normalised + read back resolved", async () => {
    const t = convexTest(schema, modules);
    const as = await seed(t, "admin");
    await as.mutation(api.agents.setAgentTypes, {
      instanceName: "primary",
      agentId: "alice",
      types: ["documentary"],
    });
    expect(await storedTypes(t, "alice")).toEqual(["documentary"]);
    const data = await as.query(api.agents.listAgentsForInstance, {
      instanceName: "primary",
    });
    expect(data.agents.find((a) => a.agentId === "alice")?.types).toEqual([
      "documentary",
    ]);
  });

  test("an agent with no explicit types reads back as conversational by default", async () => {
    const t = convexTest(schema, modules);
    const as = await seed(t, "admin");
    const data = await as.query(api.agents.listAgentsForInstance, {
      instanceName: "primary",
    });
    expect(data.agents.find((a) => a.agentId === "alice")?.types).toEqual([
      "conversational",
    ]);
  });

  test("an unknown type code is REJECTED and nothing is stored", async () => {
    const t = convexTest(schema, modules);
    const as = await seed(t, "admin");
    await expect(
      as.mutation(api.agents.setAgentTypes, {
        instanceName: "primary",
        agentId: "alice",
        types: ["conversational", "bogus"],
      }),
    ).rejects.toThrow(/Unknown agent type/);
    expect(await storedTypes(t, "alice")).toBeNull(); // convex-test: unset optional reads back null
  });

  test("a non-admin is refused and no type is written", async () => {
    const t = convexTest(schema, modules);
    const as = await seed(t, "user");
    await expect(
      as.mutation(api.agents.setAgentTypes, {
        instanceName: "primary",
        agentId: "alice",
        types: ["documentary"],
      }),
    ).rejects.toThrow();
    expect(await storedTypes(t, "alice")).toBeNull(); // convex-test: unset optional reads back null
  });
});

describe("documentaryAvailable (L2 capability gate — entitlement)", () => {
  async function setup(
    t: TestConvex<typeof schema>,
    types: string[] | undefined,
    opts: { grant?: boolean; deleted?: boolean } = {},
  ) {
    const userId = await t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId: uid, role: "user" as const, canonical: "u" });
      await ctx.db.insert("instances", { name: "primary", gatewayUrl: "ws://gw" });
      await ctx.db.insert("agents", {
        instanceName: "primary",
        agentId: "doc",
        source: "discovered" as const,
        presentInLastOk: opts.deleted ? false : true,
        firstSeenAt: 1,
        lastSeenAt: 1,
        ...(types ? { types } : {}),
      });
      if (opts.grant !== false) {
        await ctx.db.insert("userAgents", {
          userId: uid,
          instanceName: "primary",
          agentId: "doc",
          isDefault: true,
          source: "manual" as const,
          createdAt: 1,
        });
      }
      return uid;
    });
    return t.withIdentity({ subject: `${userId}|session` });
  }

  test("returns the agent when the user is GRANTED a documentary agent", async () => {
    const t = convexTest(schema, modules);
    const as = await setup(t, ["documentary"]);
    expect(await as.query(api.agents.documentaryAvailable, {})).not.toBeNull();
  });
  test("null when the user's only agent is conversational", async () => {
    const t = convexTest(schema, modules);
    const as = await setup(t, ["conversational"]);
    expect(await as.query(api.agents.documentaryAvailable, {})).toBeNull();
  });
  test("null when the granted documentary agent is DELETED on the gateway", async () => {
    const t = convexTest(schema, modules);
    const as = await setup(t, ["documentary"], { deleted: true });
    expect(await as.query(api.agents.documentaryAvailable, {})).toBeNull();
  });
  test("null when a documentary agent exists but is OUTSIDE the user's set (entitlement)", async () => {
    const t = convexTest(schema, modules);
    const as = await setup(t, ["documentary"], { grant: false });
    // Under the cascade a user with NO restriction at all sees EVERY agent, so to
    // test "not entitled" we must give them a restriction that EXCLUDES the
    // documentary agent: a direct grant on a different (conversational) agent. The
    // documentary "doc" exists but is not in their effective set -> not available.
    await t.run(async (ctx) => {
      const uid = (await ctx.db.query("profiles").collect())[0].userId;
      await ctx.db.insert("agents", {
        instanceName: "primary",
        agentId: "conv",
        source: "discovered" as const,
        presentInLastOk: true,
        firstSeenAt: 1,
        lastSeenAt: 1,
        types: ["conversational"],
      });
      await ctx.db.insert("userAgents", {
        userId: uid,
        instanceName: "primary",
        agentId: "conv",
        isDefault: true,
        source: "manual" as const,
        createdAt: 1,
      });
    });
    expect(await as.query(api.agents.documentaryAvailable, {})).toBeNull();
  });
});
