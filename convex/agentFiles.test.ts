/// <reference types="vite/client" />
//
// CONF-4c/4d — agent workspace files + chat defaults over the bridge.
//
// Pins the SERVER-side security properties (UI hiding is never enforcement):
//   - A3v2 (grant-aligned): a non-admin with `agents.files.read` may only target
//     agents in their EFFECTIVE GRANTS — and then sees ALL files (MEMORY.md,
//     USER.md included: a user who can chat with an agent can already ask it to
//     print its own files, so the former per-name depth filter protected nothing).
//   - Writes are admin-only, CAS-aware (409 -> stable "conflict" error), and
//     every success records a FULL before/after revision (A4).
//   - compactSession is owner-scoped; chat-defaults read/write is admin-only
//     with enum validation BEFORE any bridge call.
// Bridge fetches are stubbed (vi.stubGlobal) — gate-rejection tests are
// hermetic because every gate runs BEFORE postBridge.

import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { MAX_AGENT_FILE_CHARS } from "./agentFiles";

const modules = import.meta.glob("./**/*.ts");

/** Seed an account with a role (+ optional granted extraPermissions). */
async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "user" | "admin" = "user",
  extraPermissions?: string[],
) {
  const userId = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", {
      userId,
      role,
      canonical: "alice",
      ...(extraPermissions ? { extraPermissions } : {}),
    });
    return userId;
  });
  return { userId, as: t.withIdentity({ subject: `${userId}|session` }) };
}

/** Grant a user direct access to an agent (the P2-1 scope is grant-based). */
async function grantAgent(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  instanceName = "main",
  agentId = "alice",
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("userAgents", {
      userId,
      instanceName,
      agentId,
      isDefault: true,
      source: "manual",
      createdAt: Date.now(),
    });
  });
}

/** Stub BRIDGE_* env + global fetch with a programmable JSON responder. */
function stubBridge(
  respond: (
    url: string,
    body: Record<string, unknown>,
  ) => { status: number; json?: unknown },
) {
  const prevUrl = process.env.BRIDGE_URL;
  const prevSecret = process.env.BRIDGE_SHARED_SECRET;
  process.env.BRIDGE_URL = "http://bridge.test";
  process.env.BRIDGE_SHARED_SECRET = "s3cret";
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : {};
      calls.push({ url, body });
      const r = respond(url, body);
      return new Response(JSON.stringify(r.json ?? {}), { status: r.status });
    },
  );
  return {
    calls,
    restore: () => {
      vi.unstubAllGlobals();
      if (prevUrl === undefined) delete process.env.BRIDGE_URL;
      else process.env.BRIDGE_URL = prevUrl;
      if (prevSecret === undefined) delete process.env.BRIDGE_SHARED_SECRET;
      else process.env.BRIDGE_SHARED_SECRET = prevSecret;
    },
  };
}

const FULL_LISTING = [
  { name: "AGENTS.md", size: 9200, missing: false, updatedAtMs: 1 },
  { name: "SOUL.md", size: 1400, missing: false, updatedAtMs: 2 },
  { name: "IDENTITY.md", size: 300, missing: false, updatedAtMs: 3 },
  { name: "TOOLS.md", size: 800, missing: false, updatedAtMs: 4 },
  { name: "USER.md", size: 500, missing: false, updatedAtMs: 5 },
  { name: "MEMORY.md", size: 16900, missing: false, updatedAtMs: 6 },
  { name: "HEARTBEAT.md", size: 100, missing: true, updatedAtMs: 7 },
];

describe("agents.files.read grantability (server gate)", () => {
  test("an admin CAN grant agents.files.read as an extraPermission", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "admin");
    const target = await seedUser(t, "user");
    const profileId = await t.run(async (ctx) => {
      const all = await ctx.db.query("profiles").collect();
      return all.find((p) => p.userId === target.userId)!._id;
    });
    // agents.files.read is grantable (it gates the Settings "agentFiles" tab
    // and lives in GRANTABLE_USER_PERMISSIONS since CONF-4c)...
    await admin.as.mutation(api.admin.setUserPermissions, {
      profileId,
      permissions: ["agents.files.read"],
    });
    // ...while admin.manage stays NOT grantable.
    await expect(
      admin.as.mutation(api.admin.setUserPermissions, {
        profileId,
        permissions: ["admin.manage"],
      }),
    ).rejects.toThrow(/not grantable/i);
  });
});

describe("agentFiles.listAgentFiles", () => {
  test("a plain user (no grant) is rejected by the permission gate", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedUser(t, "user");
    await expect(
      as.action(api.agentFiles.listAgentFiles, {
        instanceName: "main",
        agentId: "alice",
      }),
    ).rejects.toThrow(/missing permission agents\.files\.read/);
  });

  test("a granted non-admin CANNOT target an agent outside their effective set (P2-1)", async () => {
    const t = convexTest(schema, modules);
    const { as, userId } = await seedUser(t, "user", ["agents.files.read"]);
    await grantAgent(t, userId, "main", "alice");
    // No bridge stub on purpose: the scope gate must reject BEFORE any fetch.
    await expect(
      as.action(api.agentFiles.listAgentFiles, {
        instanceName: "main",
        agentId: "someone-elses-agent",
      }),
    ).rejects.toThrow(/agent not accessible/);
    await expect(
      as.action(api.agentFiles.getAgentFile, {
        instanceName: "other-instance",
        agentId: "alice", // right agent id, WRONG instance
        name: "AGENTS.md",
      }),
    ).rejects.toThrow(/agent not accessible/);
  });

  test("a granted non-admin gets the FULL listing of THEIR agent (A3v2 — MEMORY/USER included)", async () => {
    // The report 2026-07-10: a per-user dedicated agent's owner must be able to
    // check what the agent memorized (MEMORY.md) — the former rules-only filter
    // hid exactly those files.
    const t = convexTest(schema, modules);
    const { as, userId } = await seedUser(t, "user", ["agents.files.read"]);
    await grantAgent(t, userId);
    const bridge = stubBridge(() => ({
      status: 200,
      json: { ok: true, files: FULL_LISTING },
    }));
    try {
      const res = await as.action(api.agentFiles.listAgentFiles, {
        instanceName: "main",
        agentId: "alice",
      });
      expect(res.files.map((f) => f.name)).toEqual(
        FULL_LISTING.map((f) => f.name),
      );
      expect(bridge.calls[0]!.body).toMatchObject({
        op: "list",
        instanceName: "main",
        agentId: "alice",
      });
    } finally {
      bridge.restore();
    }
  });

  test("an admin gets the full listing", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedUser(t, "admin");
    const bridge = stubBridge(() => ({
      status: 200,
      json: { ok: true, files: FULL_LISTING },
    }));
    try {
      const res = await as.action(api.agentFiles.listAgentFiles, {
        instanceName: "main",
        agentId: "alice",
      });
      expect(res.files.length).toBe(FULL_LISTING.length);
    } finally {
      bridge.restore();
    }
  });
});

describe("agentFiles.getAgentFile", () => {
  test("a granted non-admin READS a memory-class file of THEIR agent (A3v2)", async () => {
    const t = convexTest(schema, modules);
    const { as, userId } = await seedUser(t, "user", ["agents.files.read"]);
    await grantAgent(t, userId);
    const bridge = stubBridge(() => ({
      status: 200,
      json: { ok: true, file: { content: "# Memory", updatedAtMs: 7 } },
    }));
    try {
      const res = await as.action(api.agentFiles.getAgentFile, {
        instanceName: "main",
        agentId: "alice",
        name: "MEMORY.md",
      });
      expect(res.content).toBe("# Memory");
    } finally {
      bridge.restore();
    }
  });

  test("a granted non-admin reads a rules file", async () => {
    const t = convexTest(schema, modules);
    const { as, userId } = await seedUser(t, "user", ["agents.files.read"]);
    await grantAgent(t, userId);
    const bridge = stubBridge(() => ({
      status: 200,
      json: { ok: true, file: { content: "# Rules", updatedAtMs: 42 } },
    }));
    try {
      const res = await as.action(api.agentFiles.getAgentFile, {
        instanceName: "main",
        agentId: "alice",
        name: "AGENTS.md",
      });
      expect(res).toEqual({
        name: "AGENTS.md",
        content: "# Rules",
        updatedAtMs: 42,
        missing: false,
      });
    } finally {
      bridge.restore();
    }
  });

  test("a MISSING file is editable, not an error: empty content, no CAS base (P3-2)", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedUser(t, "admin");
    const bridge = stubBridge(() => ({
      status: 200,
      json: { ok: true, file: { name: "HEARTBEAT.md", missing: true, content: "" } },
    }));
    try {
      const res = await as.action(api.agentFiles.getAgentFile, {
        instanceName: "main",
        agentId: "alice",
        name: "HEARTBEAT.md",
      });
      expect(res).toEqual({
        name: "HEARTBEAT.md",
        content: "",
        updatedAtMs: null,
        missing: true,
      });
    } finally {
      bridge.restore();
    }
  });
});

describe("agentFiles.setAgentFile (admin-only, CAS, revision)", () => {
  test("a non-admin (even with the read grant) cannot write", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedUser(t, "user", ["agents.files.read"]);
    await expect(
      as.action(api.agentFiles.setAgentFile, {
        instanceName: "main",
        agentId: "alice",
        name: "AGENTS.md",
        content: "# hacked",
        baseUpdatedAtMs: 1,
      }),
    ).rejects.toThrow(/missing permission admin\.manage/);
  });

  test("over-cap content is rejected before any bridge call", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedUser(t, "admin");
    await expect(
      as.action(api.agentFiles.setAgentFile, {
        instanceName: "main",
        agentId: "alice",
        name: "AGENTS.md",
        content: "x".repeat(MAX_AGENT_FILE_CHARS + 1),
        baseUpdatedAtMs: 1,
      }),
    ).rejects.toThrow(/exceeds/);
  });

  test("a successful write records a FULL before/after revision (A4)", async () => {
    const t = convexTest(schema, modules);
    const { as, userId } = await seedUser(t, "admin");
    const bridge = stubBridge(() => ({
      status: 200,
      json: { ok: true, before: { content: "# Old rules" } },
    }));
    try {
      await as.action(api.agentFiles.setAgentFile, {
        instanceName: "main",
        agentId: "alice",
        name: "AGENTS.md",
        content: "# New rules",
        baseUpdatedAtMs: 42,
      });
      expect(bridge.calls[0]!.body).toMatchObject({
        op: "set",
        name: "AGENTS.md",
        content: "# New rules",
        baseUpdatedAtMs: 42, // the CAS token rides to the bridge
      });
      const revisions = await t.run(async (ctx) =>
        ctx.db.query("agentFileRevisions").collect(),
      );
      expect(revisions.length).toBe(1);
      expect(revisions[0]).toMatchObject({
        instanceName: "main",
        agentId: "alice",
        name: "AGENTS.md",
        before: "# Old rules",
        after: "# New rules",
        byUserId: userId,
      });
    } finally {
      bridge.restore();
    }
  });

  test("a bridge 409 surfaces the stable conflict code and records NO revision", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedUser(t, "admin");
    const bridge = stubBridge(() => ({ status: 409, json: { ok: false } }));
    try {
      await expect(
        as.action(api.agentFiles.setAgentFile, {
          instanceName: "main",
          agentId: "alice",
          name: "AGENTS.md",
          content: "# New rules",
          baseUpdatedAtMs: 42,
        }),
      ).rejects.toThrow(/conflict: file changed since load/);
      const revisions = await t.run(async (ctx) =>
        ctx.db.query("agentFileRevisions").collect(),
      );
      expect(revisions.length).toBe(0);
    } finally {
      bridge.restore();
    }
  });
});

describe("agentFiles.compactSession", () => {
  test("a user cannot compact another user's chat (ownership gate)", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "user");
    const intruder = await seedUser(t, "user");
    const chatId = (await owner.as.mutation(
      api.chats.createChat,
      {},
    )) as Id<"chats">;
    await expect(
      intruder.as.action(api.agentFiles.compactSession, { chatId }),
    ).rejects.toThrow(/not owned/);
  });

  test("the owner compacts via the routed dispatchReset-shaped body", async () => {
    const t = convexTest(schema, modules);
    const { as, userId } = await seedUser(t, "user");
    await t.run(async (ctx) => {
      await ctx.db.insert("userAgents", {
        userId,
        instanceName: "main",
        agentId: "alice",
        isDefault: true,
        source: "manual",
        createdAt: Date.now(),
      });
    });
    const chatId = (await as.mutation(api.chats.createChat, {
      instanceName: "main",
      agentId: "alice",
    })) as Id<"chats">;
    const bridge = stubBridge(() => ({ status: 200, json: { ok: true } }));
    try {
      await as.action(api.agentFiles.compactSession, { chatId });
      const call = bridge.calls.find((c) => c.url.endsWith("/compact"));
      expect(call).toBeTruthy();
      expect(call!.body).toMatchObject({
        chatId,
        instanceName: "main",
        agentId: "alice",
        canonical: "alice",
      });
    } finally {
      bridge.restore();
    }
  });
});

describe("agentFiles chat defaults (admin-only)", () => {
  test("non-admin read/write are rejected", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedUser(t, "user", ["agents.files.read"]);
    await expect(as.action(api.agentFiles.getChatDefaults, {})).rejects.toThrow(
      /missing permission admin\.manage/,
    );
    await expect(
      as.action(api.agentFiles.setChatDefaults, { fastModeDefault: true }),
    ).rejects.toThrow(/missing permission admin\.manage/);
  });

  test("setChatDefaults validates the thinking enum before any bridge call", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedUser(t, "admin");
    await expect(
      as.action(api.agentFiles.setChatDefaults, { thinkingDefault: "warp9" }),
    ).rejects.toThrow(/Invalid thinkingDefault/);
    await expect(
      as.action(api.agentFiles.setChatDefaults, {}),
    ).rejects.toThrow(/nothing to set/);
  });

  test("admin set posts op:set with only the provided fields", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedUser(t, "admin");
    const bridge = stubBridge(() => ({ status: 200, json: { ok: true } }));
    try {
      await as.action(api.agentFiles.setChatDefaults, {
        thinkingDefault: "high",
      });
      const call = bridge.calls.find((c) => c.url.endsWith("/config-defaults"));
      expect(call).toBeTruthy();
      // No instances configured -> no instance claim in the body.
      expect(call!.body).toEqual({ op: "set", thinkingDefault: "high" });
    } finally {
      bridge.restore();
    }
  });

  test("mono-instance: the resolved instanceName rides in the body (P2-3)", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedUser(t, "admin");
    await t.run(async (ctx) => {
      await ctx.db.insert("instances", { name: "main", gatewayUrl: "ws://gw" });
    });
    const bridge = stubBridge(() => ({ status: 200, json: { ok: true } }));
    try {
      await as.action(api.agentFiles.getChatDefaults, {});
      expect(bridge.calls[0]!.body).toEqual({ op: "get", instanceName: "main" });

      await as.action(api.agentFiles.setChatDefaults, { fastModeDefault: true });
      expect(bridge.calls[1]!.body).toEqual({
        op: "set",
        fastModeDefault: true,
        instanceName: "main",
      });
    } finally {
      bridge.restore();
    }
  });
});
