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

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { afterStateFromSetResponse, writeLanded } from "./agentFiles";
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

  test("a contradicted read-back FAILS the save (and still files the truth)", async () => {
    // The editor and the curation approval hold the same evidence, and for a while only
    // the curation acted on it: the editor filed a faithful revision and still answered
    // success, so the person saw a "saved" toast and then watched the old content
    // reload. Here the gateway acknowledges the write and its re-read still shows the
    // OLD body.
    const t = convexTest(schema, modules);
    const { as } = await seedUser(t, "admin");
    const bridge = stubBridge(() => ({
      status: 200,
      json: {
        ok: true,
        before: { content: "# Old rules" },
        confirmed: { content: "# Old rules" },
        file: { name: "AGENTS.md", missing: false },
      },
    }));
    try {
      await expect(
        as.action(api.agentFiles.setAgentFile, {
          instanceName: "main",
          agentId: "alice",
          name: "AGENTS.md",
          content: "# New rules",
          baseUpdatedAtMs: 42,
        }),
      ).rejects.toThrow(/was not saved/i);
      // The revision is recorded anyway: it is the truth about the file either way, and
      // it must say the after-state was CONFIRMED to be the old body.
      const revisions = await t.run(async (ctx) =>
        ctx.db.query("agentFileRevisions").collect(),
      );
      expect(revisions.length).toBe(1);
      expect(revisions[0]).toMatchObject({
        after: "# Old rules",
        afterVerified: true,
      });
    } finally {
      bridge.restore();
    }
  });

  test("the revision RECORDS that the gateway said the file was absent", async () => {
    // "unverified" and "the gateway says it is not there" are different facts, and the
    // row used to carry only the first — so an audit could not answer "did this change
    // happen" for exactly the case where the answer is no.
    const t = convexTest(schema, modules);
    const { as } = await seedUser(t, "admin");
    const bridge = stubBridge(() => ({
      status: 200,
      json: {
        ok: true,
        before: { content: "" },
        confirmed: { content: null },
        file: { name: "HEARTBEAT.md", missing: true },
      },
    }));
    try {
      await expect(
        as.action(api.agentFiles.setAgentFile, {
          instanceName: "main",
          agentId: "alice",
          name: "HEARTBEAT.md",
          content: "# New",
        }),
      ).rejects.toThrow(/was not saved/i);
      const revisions = await t.run(async (ctx) =>
        ctx.db.query("agentFileRevisions").collect(),
      );
      expect(revisions[0]).toMatchObject({
        afterVerified: false,
        afterMissing: true,
      });
    } finally {
      bridge.restore();
    }
  });

  test("a still-MISSING file after the write FAILS the save", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedUser(t, "admin");
    const bridge = stubBridge(() => ({
      status: 200,
      json: {
        ok: true,
        before: { content: "" },
        confirmed: { content: null },
        file: { name: "HEARTBEAT.md", missing: true },
      },
    }));
    try {
      await expect(
        as.action(api.agentFiles.setAgentFile, {
          instanceName: "main",
          agentId: "alice",
          name: "HEARTBEAT.md",
          content: "# New",
        }),
      ).rejects.toThrow(/was not saved/i);
    } finally {
      bridge.restore();
    }
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

describe("agentFiles.compactSession reports a REFUSAL (W2)", () => {
  /** A chat with a routed agent — the minimum for the bridge call to be attempted. */
  async function routedChat(t: ReturnType<typeof convexTest>) {
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
    return { as, chatId };
  }

  test("the gateway refusing (HTTP 200, compacted:false) is NOT reported as success", async () => {
    // The gateway declines with a 200 (no transcript, one already running). Silently
    // succeeding told the user their session had been compacted when nothing had
    // changed — on the very button the overflow card offers as a way out.
    const t = convexTest(schema, modules);
    const { as, chatId } = await routedChat(t);
    const bridge = stubBridge(() => ({
      status: 200,
      json: { ok: true, compacted: false, reasonClass: "no transcript" },
    }));
    try {
      await expect(
        as.action(api.agentFiles.compactSession, { chatId }),
      ).rejects.toThrow(/compact_refused/);
    } finally {
      bridge.restore();
    }
  });

  test("the refusal carries its bucketed CLASS, never a gateway sentence", async () => {
    const t = convexTest(schema, modules);
    const { as, chatId } = await routedChat(t);
    const bridge = stubBridge(() => ({
      status: 200,
      json: { ok: true, compacted: false, reasonClass: "already_active" },
    }));
    try {
      await expect(
        as.action(api.agentFiles.compactSession, { chatId }),
      ).rejects.toThrow(/compact_refused:already_active/);
    } finally {
      bridge.restore();
    }
  });

  test("a CONFIRMED compaction still succeeds", async () => {
    const t = convexTest(schema, modules);
    const { as, chatId } = await routedChat(t);
    const bridge = stubBridge(() => ({
      status: 200,
      json: { ok: true, compacted: true },
    }));
    try {
      await expect(
        as.action(api.agentFiles.compactSession, { chatId }),
      ).resolves.toBeNull();
    } finally {
      bridge.restore();
    }
  });

  test("an OLD bridge (no `compacted` field) is not turned into a refusal", async () => {
    // UNKNOWN is not a refusal: inventing one would tell the user nothing happened
    // when it may well have.
    const t = convexTest(schema, modules);
    const { as, chatId } = await routedChat(t);
    const bridge = stubBridge(() => ({ status: 200, json: { ok: true } }));
    try {
      await expect(
        as.action(api.agentFiles.compactSession, { chatId }),
      ).resolves.toBeNull();
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

describe("afterStateFromSetResponse — the revision's after-state (W10)", () => {
  test("uses the gateway's CONFIRMED re-read when the bridge sends one", () => {
    expect(
      afterStateFromSetResponse({ confirmed: { content: "on disk" } }, "requested"),
    ).toEqual({
      revision: { after: "on disk", afterVerified: true, afterMissing: false },
    });
    // An empty file is a legitimate confirmed state, not a missing one.
    expect(afterStateFromSetResponse({ confirmed: { content: "" } }, "x")).toEqual({
      revision: { after: "", afterVerified: true, afterMissing: false },
    });
  });

  test("reports a still-MISSING file as such: the write did not land", () => {
    // `missing: true` on the post-write re-read is positive evidence of failure, and it
    // rides in the same response — the decision was being made without it, so an
    // acknowledged-but-unapplied create counted as landed.
    const st = afterStateFromSetResponse(
      { file: { missing: true }, confirmed: { content: null } },
      "new body",
    );
    expect(st.revision.afterMissing).toBe(true);
    expect(writeLanded(st, "new body")).toBe(false);
    // …and an existing file is not flagged.
    expect(
      afterStateFromSetResponse({ file: { missing: false }, confirmed: { content: "x" } }, "x")
        .revision.afterMissing,
    ).toBe(false);
  });

  test("marks the after-state UNVERIFIED when it cannot be confirmed", () => {
    // Three shapes, one rule: an older bridge sends no `confirmed` key; a current
    // bridge sends `content: null` when the re-read carried none (the upstream field is
    // optional, and a still-missing file reads that way — exactly the case where the
    // write may not have landed). Both store the requested content, because nothing
    // truer exists, and both must SAY the after-state is unverified.
    for (const data of [
      {},
      { confirmed: { content: null } },
      { confirmed: {} },
      // Hostile shapes: the body arrives as `unknown` from an HTTP call, and an explicit
      // `null` used to pass the presence check and then be dereferenced — a TypeError
      // raised after the curation claimed the row and before it could release the claim,
      // which left the proposal stuck in `applying`.
      { confirmed: null },
      { confirmed: "nope" },
      { confirmed: 7 },
      { confirmed: { content: 42 } },
      null,
      "not an object",
    ]) {
      expect(
        afterStateFromSetResponse(data, "requested"),
        JSON.stringify(data),
      ).toEqual({
        revision: { after: "requested", afterVerified: false, afterMissing: false },
      });
    }
  });

  test("EVERY writer of a revision derives its after-state here", () => {
    // Two call sites file the same row — the editor save and the curation approval —
    // and the first version of this contract reached only one, so an approved curation
    // still asserted the proposal had landed.
    //
    // The sweep reads EVERY convex module, not a list of two. Naming the files was the
    // same mistake one level up: a third writer in any other module would have left the
    // count at two and the test green, which is precisely the failure it exists to
    // catch. Fail-closed — every mention of the mutation must be either a recognised
    // call that derives through the helper, or the definition/import itself.
    // An explicit walk, and NOT `readdirSync({recursive:true})` with `Dirent.path`:
    // `tsc -p convex` compiles this file with lib ES2021 typings where that property
    // does not exist, so it typechecked green under vitest and broke `convex deploy` —
    // the exact failure mode lot 14 put a gate around.
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        if (e.isDirectory()) {
          return e.name === "_generated" ? [] : walk(`${dir}/${e.name}`);
        }
        return e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")
          ? [`${dir}/${e.name}`]
          : [];
      });
    const files = walk(fileURLToPath(new URL(".", import.meta.url)));
    expect(files.length, "convex modules scanned").toBeGreaterThan(20);

    const unaccounted: string[] = [];
    let callSites = 0;
    for (const f of files) {
      const src = readFileSync(f, "utf-8");
      for (const line of src.split("\n")) {
        if (!line.includes("recordFileRevision")) continue;
        // The definition and the mutation's own doc comment are not call sites.
        if (/^export const recordFileRevision\b/.test(line.trim())) continue;
        if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
        if (!line.includes("internal.agentFiles.recordFileRevision")) {
          unaccounted.push(`${f}: ${line.trim()}`);
          continue;
        }
        callSites += 1;
      }
    }
    expect(
      unaccounted,
      `a mention of recordFileRevision that is neither its definition nor a ` +
        `recognised call — widen this sweep deliberately:\n${unaccounted.join("\n")}`,
    ).toEqual([]);
    expect(callSites, "call sites of recordFileRevision").toBeGreaterThan(0);

    // The call bodies are extracted by BRACE BALANCE, not by a regex anchored on a
    // closing `\n    })`.
    //
    // The regex version matched only calls that happened to be indented that way: a
    // differently-formatted call was counted by the line sweep above and then skipped by
    // both derivation checks — present, uninspected, green. A guard that silently
    // narrows its own scope to what it can parse is the failure mode this whole lot
    // keeps finding.
    const callBodies = (src: string): string[] => {
      const out: string[] = [];
      const token = "internal.agentFiles.recordFileRevision";
      for (let i = src.indexOf(token); i !== -1; i = src.indexOf(token, i + 1)) {
        const open = src.indexOf("{", i + token.length);
        if (open === -1) continue;
        let depth = 0;
        for (let j = open; j < src.length; j += 1) {
          if (src[j] === "{") depth += 1;
          else if (src[j] === "}") {
            depth -= 1;
            if (depth === 0) {
              out.push(src.slice(open, j + 1));
              break;
            }
          }
        }
      }
      return out;
    };

    // No call site may name `after` itself.
    //
    // Stated as a PROHIBITION rather than "must mention the helper": one call spreads
    // the helper's result through a local (`...afterState.revision`), so requiring the
    // function name in the call body failed on correct code — a whitelist of spellings,
    // which is the shape of guard this programme keeps finding broken. What matters is
    // that the after-state never comes from the call site's own reasoning, and that is
    // exactly "no literal `after:` key here".
    const byHand: string[] = [];
    const untraceable: string[] = [];
    let inspected = 0;
    for (const f of files) {
      const src = readFileSync(f, "utf-8");
      for (const body of callBodies(src)) {
        inspected += 1;
        if (/\bafter(Verified)?\s*:/.test(body)) byHand.push(`${f}:\n${body}`);
        const spreads = [...body.matchAll(/\.\.\.([A-Za-z_$][\w$]*(?:\.[\w$]+)*)/g)].map(
          (x) => x[1]!,
        );
        if (spreads.length === 0) {
          untraceable.push(`${f}: the call spreads nothing — where does after come from?`);
          continue;
        }
        for (const name of spreads) {
          if (name.startsWith("afterStateFromSetResponse")) continue; // spread inline
          const root = name.split(".")[0]!;
          const assigned = new RegExp(
            `(?:const|let|var)\\s+${root}\\s*=\\s*afterStateFromSetResponse\\(`,
          ).test(src);
          if (!assigned) {
            untraceable.push(
              `${f}: spreads ${name} into recordFileRevision, but ${root} is not ` +
                `assigned from afterStateFromSetResponse()`,
            );
          }
        }
      }
    }
    // Every counted call site must have been INSPECTED — the two sweeps agree or the
    // extraction missed one.
    expect(
      inspected,
      "call bodies extracted vs call sites counted — the extraction skipped one",
    ).toBe(callSites);
    expect(
      byHand,
      `a recordFileRevision call names the after-state itself instead of deriving it ` +
        `from afterStateFromSetResponse:\n${byHand.join("\n")}`,
    ).toEqual([]);
    expect(
      untraceable,
      `after-state spread into a revision without coming from the shared derivation:\n` +
        untraceable.join("\n"),
    ).toEqual([]);

    // Deriving the evidence is not the same as ACTING on it. Both writers held
    // `stillMissing` and a confirmed after-state; for a while only the curation refused
    // to declare success, while the editor filed a faithful revision and answered
    // "saved". A module that writes a revision must also consult `writeLanded`.
    // COUNTED, not "mentioned somewhere in the file". A module that already calls
    // `writeLanded` once satisfied a substring check, so a SECOND writer added beside it
    // could derive the after-state correctly and never act on the verdict — the guard
    // would stay green on exactly the regression it names.
    const ignoresEvidence: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf-8");
      const writes = callBodies(src).length;
      if (writes === 0) continue;
      // The DECLARATION is not a check. Counting every `writeLanded(` let the module
      // that DEFINES it satisfy the count for free, so a second writer added there was
      // not caught — the first version of this very assertion.
      const checks =
        [...src.matchAll(/\bwriteLanded\(/g)].length -
        [...src.matchAll(/function\s+writeLanded\(/g)].length;
      if (checks < writes) {
        ignoresEvidence.push(
          `${f}: ${writes} revision write(s) but only ${checks} writeLanded() check(s)`,
        );
      }
    }
    expect(
      ignoresEvidence,
      `deriving the evidence is not acting on it:\n${ignoresEvidence.join("\n")}`,
    ).toEqual([]);
  });
});

describe("writeLanded — did the write actually happen (W10)", () => {
  const st = (after: string, afterVerified: boolean) => ({
    revision: { after, afterVerified, afterMissing: false },
  });

  test("a CONFIRMED read-back that matches means it landed", () => {
    expect(writeLanded(st("new", true), "new")).toBe(true);
  });

  test("a CONFIRMED read-back that DIFFERS means it did not", () => {
    // The curation apply used to mark itself "applied" regardless, and that transition
    // purges `proposedContent` — so an acknowledged-but-unapplied write destroyed the
    // proposal and left a revision claiming it had landed.
    expect(writeLanded(st("old", true), "new")).toBe(false);
  });

  test("an UNVERIFIABLE read-back is not evidence of failure", () => {
    // A gateway that does not echo content, or an older bridge, must not turn every
    // successful write into a failure. Same principle as the model-availability guard:
    // absence of confirmation is not confirmation of absence.
    expect(writeLanded(st("new", false), "new")).toBe(true);
    expect(writeLanded(st("anything", false), "new")).toBe(true);
  });
});
