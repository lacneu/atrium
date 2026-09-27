/// <reference types="vite/client" />
//
// A SEND REFUSED ON THE PERMISSION MODE IT CARRIED (Codex pass 4, 2026-09-26).
//
// The guard is the mode the reader was shown (lib/sessionAccess.ts); the gateway
// refuses a send whose guard differs from the mode stored on the session it lands on
// (`session_settings_changed`, nothing ran). When the session is GONE from under the key
// (pruned, deleted), the bridge's pre-send describe answers nothing and publishes
// nothing, so the meta kept the mode of the session that no longer exists: every
// retry carried it and was refused again — for ever. Pinned here: the refusal replaces
// the refused guard by `null` (what the session the send creates holds), unless a
// newer describe has landed meanwhile — that one is the truth and stays.

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
type T = TestConvex<typeof schema>;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function guardedChat(t: T) {
  return t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", {
      userId: owner,
      role: "user",
      canonical: "owner",
      name: "owner",
      email: "owner@example.com",
    });
    await ctx.db.insert("instances", { name: "alpha", gatewayUrl: "ws://gw" });
    await ctx.db.insert("agents", {
      instanceName: "alpha",
      agentId: "alice",
      displayName: "Alice",
      enabled: true,
      source: "discovered" as const,
      presentInLastOk: true,
      firstSeenAt: 1,
      lastSeenAt: 1,
    });
    const chatId = await ctx.db.insert("chats", {
      userId: owner,
      updatedAt: 1,
      instanceName: "alpha",
      agentId: "alice",
      // What the reader was shown: the mode of a session since gone from the gateway.
      sessionMeta: {
        permissionMode: "guarded",
        permissionModePending: false,
        visibility: "shared",
        accessAt: 10,
      },
    });
    return { owner, chatId };
  });
}

/** A bridge that refuses every send as the gateway does, optionally learning a newer
 *  describe while the send is in flight (the bridge publishes before chat.send). */
function refusingBridge(t: T, duringSend?: () => Promise<void>) {
  const prevUrl = process.env.BRIDGE_URL;
  const prevSecret = process.env.BRIDGE_SHARED_SECRET;
  process.env.BRIDGE_URL = "http://bridge.test";
  process.env.BRIDGE_SHARED_SECRET = "s3cret";
  const sends: Array<Record<string, unknown>> = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (String(input).endsWith("/send")) {
      sends.push(body);
      if (duringSend) await duringSend();
      return new Response(
        JSON.stringify({ ok: false, error: { code: "session_settings_changed" } }),
        { status: 502 },
      );
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  void t;
  return {
    sends,
    restore: () => {
      vi.unstubAllGlobals();
      if (prevUrl === undefined) delete process.env.BRIDGE_URL;
      else process.env.BRIDGE_URL = prevUrl;
      if (prevSecret === undefined) delete process.env.BRIDGE_SHARED_SECRET;
      else process.env.BRIDGE_SHARED_SECRET = prevSecret;
    },
  };
}

async function refusedSend(t: T, owner: Id<"users">, chatId: Id<"chats">, key: string) {
  const { outboxId } = await t.withIdentity({ subject: owner }).mutation(api.send.sendMessage, {
    chatId,
    text: "bonjour",
    clientMessageId: key,
  });
  await t.action(internal.bridge.dispatch, { outboxId });
  return outboxId;
}

describe("a send refused on its permission guard", () => {
  test("the session gone from under the key: the retry carries `null`, not the refused mode", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await guardedChat(t);
    const bridge = refusingBridge(t);
    try {
      await refusedSend(t, owner, chatId, "c1");
      expect(bridge.sends[0]?.expectedPermissionMode).toBe("guarded");
      const card = await t.run(async (ctx) =>
        (
          await ctx.db
            .query("messages")
            .withIndex("by_chat", (q) => q.eq("chatId", chatId))
            .collect()
        ).find((m) => m.role === "assistant" && m.status === "error"),
      );
      expect(card?.errorCode).toBe("session_settings_changed");
      // The retry the refusal asks for.
      const retry = await t.query(internal.bridge.getChatRouting, { chatId, userId: owner });
      expect(retry?.permissionGuard?.mode).toBeNull();
      // The reader is shown what the retry will run under — not a gone session's facts.
      const meta = (await t.run((ctx) => ctx.db.get(chatId)))!.sessionMeta!;
      expect(meta.permissionMode).toBeNull();
      expect(meta.visibility).toBeUndefined();
      expect(meta.accessAt).toBe(10);
    } finally {
      bridge.restore();
    }
  });

  test("a newer describe landed meanwhile: it is the truth, and it stays", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await guardedChat(t);
    const bridge = refusingBridge(t, async () => {
      await t.mutation(internal.stream.setSessionMeta, {
        chatId,
        meta: { permissionMode: "workspace", permissionModePending: false, observedAt: 20 },
      });
    });
    try {
      await refusedSend(t, owner, chatId, "c1");
      const retry = await t.query(internal.bridge.getChatRouting, { chatId, userId: owner });
      expect(retry?.permissionGuard?.mode).toBe("workspace");
    } finally {
      bridge.restore();
    }
  });
});

// The bridge's half: a pre-send describe that STATES no session exists under the key
// reports `{ permissionMode: null }` under its own stamp (bridge server.ts, performSend).
describe("the absence reported by the bridge", () => {
  test("the mode becomes `null`, the gone session's other access facts go, the rest stays", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await guardedChat(t);
    await t.mutation(internal.stream.setSessionMeta, {
      chatId,
      meta: { permissionMode: null, observedAt: 20 },
    });
    const meta = (await t.run((ctx) => ctx.db.get(chatId)))!.sessionMeta!;
    expect(meta.permissionMode).toBeNull();
    expect(meta.visibility).toBeUndefined();
    expect(meta.permissionModePending).toBeUndefined();
    const next = await t.query(internal.bridge.getChatRouting, { chatId, userId: owner });
    expect(next?.permissionGuard?.mode).toBeNull();
  });

  test("an absence observed before the describe on record changes nothing", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await guardedChat(t);
    await t.mutation(internal.stream.setSessionMeta, {
      chatId,
      meta: { permissionMode: null, observedAt: 5 },
    });
    const next = await t.query(internal.bridge.getChatRouting, { chatId, userId: owner });
    expect(next?.permissionGuard?.mode).toBe("guarded");
  });
});
