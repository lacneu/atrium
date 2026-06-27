/// <reference types="vite/client" />
//
// listChats: the per-chat `providerKind` resolution that drives the sidebar's
// self-hiding bridge badge. A BOUND chat → its instance's kind; an UNBOUND chat
// → the user's default agent's instance kind (mirrors dispatch's fallback). The
// resolution is BATCHED (instances + userAgents loaded once) — this pins the
// mapping without asserting the query internals.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
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

  // Deploy-cutover graceful render: a message MID-STREAM across the upgrade to the split
  // carries its partial on the legacy `liveText` and has NO streamingText row. loadChatView
  // reads `liveText ?? text` for a streaming message, so listByChat still renders that
  // partial instead of showing it empty until its next delta/finalize. Guards the
  // CHANGELOG claim "replies already streaming across the deploy are handled gracefully".
  test("listByChat renders a LEGACY streaming message's liveText when it has no row", async () => {
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
        liveText: "legacy mid-stream text", // pre-split partial, NO streamingText row
        updatedAt: 1,
      });
      return { userId, chatId, messageId };
    });
    const as = t.withIdentity({ subject: `${userId}|session` });
    const view = await as.query(api.messages.listByChat, { chatId });
    const msg = view.find((m) => m._id === messageId);
    expect(msg?.status).toBe("streaming");
    expect(msg?.text).toBe("legacy mid-stream text"); // liveText fallback, not ""
  });
});

// The streamingText row must be deleted WITH its message on every removal path, or
// getStreamingText would resurface the live text of a message the user deleted. The
// per-delta write path makes this easy to forget, so pin both removal paths.
describe("streamingText row removal on delete / cascade", () => {
  test("deleteMessage truncation drops a LATER streaming message's row (no orphan)", async () => {
    const t = convexTest(schema, modules);
    const { userId, questionId, streamingId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId,
        role: "user" as const,
        canonical: "u",
      });
      const chatId = await ctx.db.insert("chats", {
        userId,
        updatedAt: 2,
        instanceName: "prod",
      });
      // A user question, then its in-flight (streaming) assistant reply with a row.
      const questionId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "user" as const,
        status: "complete" as const,
        text: "question",
        updatedAt: 1,
      });
      const streamingId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "",
        runId: "r",
        updatedAt: 2,
      });
      await ctx.db.insert("streamingText", {
        messageId: streamingId,
        chatId,
        text: "in-flight partial",
        updatedAt: 2,
      });
      return { userId, questionId, streamingId };
    });

    // Deleting the question truncates forward, removing the later streaming reply too.
    await t
      .withIdentity({ subject: `${userId}|session` })
      .mutation(api.messages.deleteMessage, { messageId: questionId });

    await t.run(async (ctx) => {
      expect(await ctx.db.get(streamingId)).toBeNull(); // the reply was truncated...
      const orphan = await ctx.db
        .query("streamingText")
        .withIndex("by_message", (q) => q.eq("messageId", streamingId))
        .first();
      expect(orphan).toBeNull(); // ...and its live-text row went with it
    });
  });

  test("deleteMessage regenerate re-routes to the user turn's agent (per-turn chat), not the primary", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, assistantId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId,
        role: "user" as const,
        canonical: "u",
      });
      const chatId = await ctx.db.insert("chats", {
        userId,
        updatedAt: 2,
        instanceName: "prod",
        agentId: "alice", // chat primary
        perTurnRouting: true,
      });
      // A user turn ROUTED to bob (≠ the primary alice), then its complete reply.
      await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "user" as const,
        status: "complete" as const,
        text: "q",
        updatedAt: 1,
        routedInstanceName: "prod",
        routedAgentId: "bob",
      });
      const assistantId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "a",
        updatedAt: 2,
      });
      return { userId, chatId, assistantId };
    });

    // Delete the assistant reply → regenerate the bob-routed user turn.
    await t
      .withIdentity({ subject: `${userId}|session` })
      .mutation(api.messages.deleteMessage, { messageId: assistantId });

    // The regenerate outbox must carry bob (the turn's agent), so the re-dispatch + the
    // session reset target bob — NOT the chat's primary alice (codex P2).
    const outbox = await t.run((ctx) =>
      ctx.db
        .query("outbox")
        .withIndex("by_chat_status", (q) =>
          q.eq("chatId", chatId).eq("status", "pending"),
        )
        .first(),
    );
    expect(outbox?.routedAgent).toEqual({ instanceName: "prod", agentId: "bob" });
  });

  test("deleteChat cascade drops a streaming message's row (no orphan)", async () => {
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
        runId: "r",
        updatedAt: 1,
      });
      await ctx.db.insert("streamingText", {
        messageId,
        chatId,
        text: "in-flight partial",
        updatedAt: 1,
      });
      return { userId, chatId, messageId };
    });

    await t
      .withIdentity({ subject: `${userId}|session` })
      .mutation(api.chats.deleteChat, { chatId });

    await t.run(async (ctx) => {
      const orphan = await ctx.db
        .query("streamingText")
        .withIndex("by_chat", (q) => q.eq("chatId", chatId))
        .collect();
      expect(orphan).toEqual([]); // no streamingText row survives the chat delete
    });
  });
});

// Window-payload guard (perf): loadChatView ships the WHOLE message window and
// re-runs on any message change, so a large tool/reasoning field re-pushed in full
// over the WS stalled delivery over the WAN (measured: one web_search turn = ~89KB
// of raw `output`). listByChat must ELIDE oversized part fields (flag + byte size),
// keeping small ones intact. This is the regression guard for that fix.
describe("listByChat elides oversized part fields from the window", () => {
  test("big tool output/input + big reasoning omitted (flagged); small kept; window bounded", async () => {
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
        status: "complete" as const,
        text: "hi",
        updatedAt: 1,
      });
      // 0: tool with a BIG output (> PART_FIELD_CAP 8192) -> output elided
      await ctx.db.insert("messageParts", {
        messageId,
        order: 0,
        part: {
          kind: "tool" as const,
          name: "web_search",
          phase: "completed",
          input: { q: "x" },
          output: "Z".repeat(20000),
        },
      });
      // 1: tool with a small output -> kept in full
      await ctx.db.insert("messageParts", {
        messageId,
        order: 1,
        part: {
          kind: "tool" as const,
          name: "calc",
          phase: "completed",
          input: { a: 1 },
          output: "42",
        },
      });
      // 2: tool with a BIG input -> input elided
      await ctx.db.insert("messageParts", {
        messageId,
        order: 2,
        part: {
          kind: "tool" as const,
          name: "ingest",
          phase: "completed",
          input: "Y".repeat(20000),
        },
      });
      // 3: BIG reasoning -> text elided
      await ctx.db.insert("messageParts", {
        messageId,
        order: 3,
        part: { kind: "reasoning" as const, text: "R".repeat(20000) },
      });
      // 4: CJK output ~9KB UTF-8 but only 3000 UTF-16 units -> must still elide
      // (the cap counts real bytes, not `.length`).
      await ctx.db.insert("messageParts", {
        messageId,
        order: 4,
        part: {
          kind: "tool" as const,
          name: "cjk",
          phase: "completed",
          output: "好".repeat(3000),
        },
      });
      return { userId, chatId, messageId };
    });

    const as = t.withIdentity({ subject: `${userId}|session` });
    const view = await as.query(api.messages.listByChat, { chatId });
    const msg = view.find((m) => m._id === messageId);
    if (!msg) throw new Error("message not in view");
    const part = (i: number) => msg.parts[i] as Record<string, unknown>;

    // big output ELIDED: flagged + byte size, NO output payload
    expect(part(0).outputOmitted).toBe(true);
    expect(part(0).outputBytes as number).toBeGreaterThan(8192);
    expect(part(0).output).toBeUndefined();
    // small output kept in full
    expect(part(1).output).toBe("42");
    expect(part(1).outputOmitted).toBeUndefined();
    // big input ELIDED
    expect(part(2).inputOmitted).toBe(true);
    expect(part(2).input).toBeUndefined();
    // big reasoning ELIDED
    expect(part(3).textOmitted).toBe(true);
    expect(part(3).text).toBeUndefined();
    // CJK: 3000 chars (.length < cap) but ~9KB UTF-8 -> elided (real-byte cap).
    expect(part(4).outputOmitted).toBe(true);
    expect(part(4).outputBytes as number).toBeGreaterThan(8192);

    // The whole window payload is BOUNDED — the big fields are NOT in it.
    expect(JSON.stringify(view).length).toBeLessThan(5000);

    // The SOC2 diagnostic (chatStateInternal) consumes this same elided view; an
    // elided tool must still report hasOutput (presence flag preserved, not dropped).
    const state = await t.query(internal.messages.chatStateInternal, { chatId });
    if (!state.ok) throw new Error("chat-state not ok");
    const diagTool = state.messages
      .flatMap((mm) => mm.parts)
      .find((p) => p.kind === "tool" && p.name === "web_search");
    expect(diagTool).toMatchObject({ hasInput: true, hasOutput: true });
  });
});
