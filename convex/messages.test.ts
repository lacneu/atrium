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

  // REGRESSION TEST for the bound (NOT a reproduction of the prod error —
  // convex-test does not enforce production's per-function op/byte budget, so
  // "too many system operations" is unreproducible in-harness). What this LOCKS:
  // listChats returns the most-recent CHAT_WINDOW (200) by updatedAt UNIONed with
  // every pinned chat of any age. It FAILS against the old unbounded `.collect()`
  // (which returned all 225 loose rows) — that unbounded read is what contributed
  // to the incident, and this prevents its return.
  test("bounded to CHAT_WINDOW recent + an OLD pinned chat is never dropped", async () => {
    const CHAT_WINDOW = 200;
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId: uid, role: "user" as const, canonical: "u" });
      // One pinned chat with the OLDEST timestamp — outside any recency window.
      await ctx.db.insert("chats", {
        userId: uid, updatedAt: 0, pinned: true, title: "PINNED-OLD",
      });
      // More loose (non-pinned) chats than the window, newest = highest updatedAt.
      for (let i = 1; i <= CHAT_WINDOW + 25; i++) {
        await ctx.db.insert("chats", { userId: uid, updatedAt: i, title: `loose-${i}` });
      }
      return uid;
    });

    const rows = await t
      .withIdentity({ subject: `${userId}|session` })
      .query(api.messages.listChats, {});

    // Loose chats are capped at the window; the pinned old chat is ADDED on top.
    const loose = rows.filter((r) => !r.pinned);
    expect(loose.length).toBe(CHAT_WINDOW);
    // The old pinned chat survived the recency cut (the load-bearing guarantee).
    const pinned = rows.filter((r) => r.pinned);
    expect(pinned.map((r) => r.title)).toEqual(["PINNED-OLD"]);
    // Newest loose chat is present; the oldest loose ones fell off the window.
    const titles = new Set(rows.map((r) => r.title));
    expect(titles.has(`loose-${CHAT_WINDOW + 25}`)).toBe(true);
    expect(titles.has("loose-1")).toBe(false);
  });

  // REGRESSION TEST for Codex P2: archived chats must NOT consume the recency
  // window. The recency index (by_user_updated) is shared by archived rows, so the
  // old `take(CHAT_WINDOW)` + post-filter would return [] for a user whose CHAT_WINDOW
  // most-recent chats are ALL archived — evicting every active chat from the sidebar.
  // The bounded scan skips archived in-flight, so active chats still surface.
  test("archived chats do not evict active chats from the recency window", async () => {
    const CHAT_WINDOW = 200;
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId: uid, role: "user" as const, canonical: "u" });
      // A handful of ACTIVE chats with the OLDEST timestamps.
      for (let i = 1; i <= 5; i++) {
        await ctx.db.insert("chats", {
          userId: uid, updatedAt: i, title: `active-${i}`, archived: false,
        });
      }
      // MORE than a full window of ARCHIVED chats, ALL more recent than the active
      // ones (higher updatedAt). Against the old code these fill take(200) entirely.
      for (let i = 1; i <= CHAT_WINDOW + 25; i++) {
        await ctx.db.insert("chats", {
          userId: uid, updatedAt: 1000 + i, title: `archived-${i}`, archived: true,
        });
      }
      return uid;
    });

    const rows = await t
      .withIdentity({ subject: `${userId}|session` })
      .query(api.messages.listChats, {});

    const titles = new Set(rows.map((r) => r.title));
    // Every active chat surfaces despite being older than a full window of archives.
    for (let i = 1; i <= 5; i++) {
      expect(titles.has(`active-${i}`)).toBe(true);
    }
    // No archived chat leaks into the sidebar.
    expect(rows.some((r) => (r.title ?? "").startsWith("archived-"))).toBe(false);
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

// The live-text split (0.9.0): a streaming message's live text lives in
// `streamingText` (read by the cheap getStreamingText), NOT in the heavy
// listByChat/loadChatView view — so the latter no longer re-runs per delta.
describe("listByChat / getStreamingText live-text split", () => {
  test("listByChat carries message.text (empty while streaming); getStreamingText carries the live text", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, messageId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId,
        role: "user" as const,
        canonical: "u",
      });
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
      await ctx.db.insert("streamingText", {
        messageId,
        chatId,
        text: "live tokens…",
        updatedAt: 2,
      });
      return { userId, chatId, messageId };
    });
    const as = t.withIdentity({ subject: `${userId}|session` });

    // The heavy view does NOT carry the live text -> reading it is not invalidated
    // by per-delta writes (which only touch streamingText).
    const view = await as.query(api.messages.listByChat, { chatId });
    const msg = view.find((m) => m._id === messageId);
    expect(msg?.status).toBe("streaming");
    expect(msg?.text).toBe(""); // NOT "live tokens…"

    // The cheap query carries the live text, keyed by messageId for the stitch.
    const live = await as.query(api.messages.getStreamingText, { chatId });
    expect(live).toEqual([{ messageId, text: "live tokens…" }]);
  });

  test("getStreamingText is owner-scoped (foreign chat throws) and empty for a malformed id", async () => {
    const t = convexTest(schema, modules);
    const { ownerId, chatId, otherId } = await t.run(async (ctx) => {
      const ownerId = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId: ownerId,
        role: "user" as const,
        canonical: "owner",
      });
      const otherId = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId: otherId,
        role: "user" as const,
        canonical: "other",
      });
      const chatId = await ctx.db.insert("chats", {
        userId: ownerId,
        updatedAt: 1,
        instanceName: "prod",
      });
      return { ownerId, chatId, otherId };
    });
    // A foreign user is rejected (IDOR guard, same as listByChat).
    await expect(
      t
        .withIdentity({ subject: `${otherId}|session` })
        .query(api.messages.getStreamingText, { chatId }),
    ).rejects.toThrow(/Forbidden/);
    // A malformed id is a clean empty array, never a throw.
    const empty = await t
      .withIdentity({ subject: `${ownerId}|session` })
      .query(api.messages.getStreamingText, { chatId: "not-an-id" });
    expect(empty).toEqual([]);
  });
});
