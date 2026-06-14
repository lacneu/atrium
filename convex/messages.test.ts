/// <reference types="vite/client" />
//
// listChats: the per-chat `providerKind` resolution that drives the sidebar's
// self-hiding bridge badge. A BOUND chat → its instance's kind; an UNBOUND chat
// → the user's default agent's instance kind (mirrors dispatch's fallback). The
// resolution is BATCHED (instances + userAgents loaded once) — this pins the
// mapping without asserting the query internals.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

describe("listChats providerKind (sidebar bridge badge)", () => {
  test("bound chat → its bridge; unbound chat → the default agent's bridge", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId: uid, role: "user" as const, canonical: "u" });
      // Two bridges of different kinds.
      await ctx.db.insert("instances", { name: "prod", gatewayUrl: "ws://a", kind: "openclaw" as const });
      await ctx.db.insert("instances", { name: "herm", gatewayUrl: "ws://b", kind: "hermes" as const });
      // Default agent on the OpenClaw instance; a second agent on Hermes.
      await ctx.db.insert("userAgents", {
        userId: uid, instanceName: "prod", agentId: "main",
        isDefault: true, source: "manual" as const, createdAt: 0,
      });
      await ctx.db.insert("userAgents", {
        userId: uid, instanceName: "herm", agentId: "h1",
        isDefault: false, source: "manual" as const, createdAt: 1,
      });
      // A chat BOUND to the Hermes agent + an UNBOUND (legacy) chat.
      await ctx.db.insert("chats", {
        userId: uid, updatedAt: 2, instanceName: "herm", agentId: "h1",
      });
      await ctx.db.insert("chats", { userId: uid, updatedAt: 1 }); // unbound
      return uid;
    });

    const rows = await t
      .withIdentity({ subject: `${userId}|session` })
      .query(api.messages.listChats, {});
    expect(rows.length).toBe(2);
    const kinds = rows.map((r) => r.providerKind);
    // One chat resolves to hermes (its binding), the other to openclaw (default).
    expect(kinds).toContain("hermes");
    expect(kinds).toContain("openclaw");
  });

  test("single-provider user → every chat the same kind (badge self-hides)", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId: uid, role: "user" as const, canonical: "u" });
      await ctx.db.insert("instances", { name: "prod", gatewayUrl: "ws://a", kind: "openclaw" as const });
      await ctx.db.insert("userAgents", {
        userId: uid, instanceName: "prod", agentId: "main",
        isDefault: true, source: "manual" as const, createdAt: 0,
      });
      await ctx.db.insert("chats", { userId: uid, updatedAt: 2, instanceName: "prod", agentId: "main" });
      await ctx.db.insert("chats", { userId: uid, updatedAt: 1 }); // unbound → default
      return uid;
    });
    const rows = await t
      .withIdentity({ subject: `${userId}|session` })
      .query(api.messages.listChats, {});
    const distinct = new Set(rows.map((r) => r.providerKind as string | null));
    expect(distinct.size).toBe(1); // all "openclaw" → frontend hides the badge
    expect([...distinct][0]).toBe("openclaw");
  });

  test("chat bound to a DELETED Hermes agent → badge shows the fallback bridge (OpenClaw)", async () => {
    // Codex P2: the badge must name the bridge the NEXT turn uses. A binding to a
    // deleted agent rebinds to the default (here OpenClaw), so the chat must NOT
    // resolve to Hermes (which won't handle it).
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId: uid, role: "user" as const, canonical: "u" });
      await ctx.db.insert("instances", { name: "prod", gatewayUrl: "ws://a", kind: "openclaw" as const });
      await ctx.db.insert("instances", { name: "herm", gatewayUrl: "ws://b", kind: "hermes" as const });
      // Successful polls → presentInLastOk drives deleted-ness.
      await ctx.db.insert("instanceDiscovery", { instanceName: "prod", lastPollAt: 1, lastPollOk: true, lastOkAt: 1 });
      await ctx.db.insert("instanceDiscovery", { instanceName: "herm", lastPollAt: 1, lastPollOk: true, lastOkAt: 1 });
      await ctx.db.insert("agents", {
        instanceName: "prod", agentId: "main", source: "discovered",
        presentInLastOk: true, firstSeenAt: 1, lastSeenAt: 1, // default, present
      });
      await ctx.db.insert("agents", {
        instanceName: "herm", agentId: "h1", source: "discovered",
        presentInLastOk: false, firstSeenAt: 1, lastSeenAt: 1, // DELETED on the gateway
      });
      await ctx.db.insert("userAgents", {
        userId: uid, instanceName: "prod", agentId: "main",
        isDefault: true, source: "manual" as const, createdAt: 0,
      });
      await ctx.db.insert("userAgents", {
        userId: uid, instanceName: "herm", agentId: "h1",
        isDefault: false, source: "manual" as const, createdAt: 1,
      });
      // Chat BOUND to the now-deleted Hermes agent.
      await ctx.db.insert("chats", { userId: uid, updatedAt: 2, instanceName: "herm", agentId: "h1" });
      return uid;
    });
    const rows = await t
      .withIdentity({ subject: `${userId}|session` })
      .query(api.messages.listChats, {});
    expect(rows[0].providerKind).toBe("openclaw"); // the fallback bridge, NOT dead Hermes
  });
});
