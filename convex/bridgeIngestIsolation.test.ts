/// <reference types="vite/client" />
//
// CROSS-GATEWAY INGEST ISOLATION — the security property that makes the bridge
// "le garant" of no cross-gateway data leakage. The /bridge/credentials path is
// already per-bridge isolated (bridgeCredentials.test.ts); this pins the SAME
// guarantee on the WRITE path (/bridge/ingest): a bridge authenticated for
// instance A must NEVER be able to write into a chat/message that belongs to
// instance B.
//
// These tests are ADVERSARIAL: each drives A's per-bridge secret against B's
// data and asserts REFUSAL. They must FAIL on the pre-fix code (which
// authenticates ingest with a single shared BRIDGE_INGEST_SECRET and never
// authorizes the target against the caller's instance), and PASS once the
// per-write authorization lands. Covers BOTH providers (openclaw + hermes).

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { toBase64 } from "./lib/crypto/cipher";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");
const URL = "/bridge/ingest";
const SHARED = "shared-ingest-secret-legacy";

// The credential-decrypt path (used to MINT the per-bridge secret) needs the
// master key; the ingest auth path needs the shared secret present for the
// dual-accept transition.
let prevShared: string | undefined;
let prevKey: string | undefined;
beforeEach(() => {
  prevShared = process.env.BRIDGE_INGEST_SECRET;
  prevKey = process.env.ATRIUM_SECRET_KEY;
  process.env.BRIDGE_INGEST_SECRET = SHARED;
  process.env.ATRIUM_SECRET_KEY = toBase64(new Uint8Array(32).fill(7));
});
afterEach(() => {
  if (prevShared === undefined) delete process.env.BRIDGE_INGEST_SECRET;
  else process.env.BRIDGE_INGEST_SECRET = prevShared;
  if (prevKey === undefined) delete process.env.ATRIUM_SECRET_KEY;
  else process.env.ATRIUM_SECRET_KEY = prevKey;
});

type T = TestConvex<typeof schema>;

const asAdmin = (t: T, uid: Id<"users">) =>
  t.withIdentity({ subject: `${uid}|session` });

async function seedAdmin(t: T) {
  return await t.run(async (ctx) => {
    const admin = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId: admin, role: "admin" });
    return admin;
  });
}

/** An instance + its per-bridge secret + a user + a streaming assistant message
 *  in a chat that belongs to that instance. */
async function seedInstanceWithChat(
  t: T,
  admin: Id<"users">,
  name: string,
  kind: "openclaw" | "hermes" = "openclaw",
) {
  const instanceId = await t.run((ctx) =>
    ctx.db.insert("instances", { name, gatewayUrl: `ws://${name}`, kind }),
  );
  const secret = await asAdmin(t, admin).action(
    api.bridgeAuth.mintBridgeSecret,
    { instanceId },
  );
  const { chatId, messageId, userId } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", {
      userId,
      role: "user" as const,
      canonical: name,
    });
    const chatId = await ctx.db.insert("chats", {
      userId,
      updatedAt: 1,
      instanceName: name,
    });
    const messageId = await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "assistant" as const,
      status: "streaming" as const,
      text: "",
      updatedAt: 1,
    });
    return { chatId, messageId, userId };
  });
  return { instanceId, name, kind, secret: secret.plaintext, chatId, messageId, userId };
}

function post(t: T, body: unknown, bearer: string) {
  return t.fetch(URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify(body),
  });
}

/** The LIVE streaming text for a message (setSnapshot writes here during a
 *  streaming turn; message.text only fills at finalize). "" when no row. */
async function streamTextOf(t: T, messageId: Id<"messages">): Promise<string> {
  return await t.run(async (ctx) => {
    const row = await ctx.db
      .query("streamingText")
      .withIndex("by_message", (q) => q.eq("messageId", messageId))
      .first();
    return row?.text ?? "";
  });
}

describe("cross-gateway ingest isolation (per-write authorization)", () => {
  test("A's per-bridge secret CANNOT setSnapshot on B's message (openclaw)", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedAdmin(t);
    const a = await seedInstanceWithChat(t, admin, "alpha");
    const b = await seedInstanceWithChat(t, admin, "bravo");

    // A, authenticated for its OWN instance, tries to overwrite B's message.
    const res = await post(
      t,
      { op: "setSnapshot", messageId: b.messageId, text: "INJECTED-BY-ALPHA" },
      a.secret,
    );
    // The write MUST be refused, and B's message MUST be untouched.
    expect(res.status).toBe(403);
    expect(await streamTextOf(t, b.messageId)).toBe("");
  });

  test("A's per-bridge secret CANNOT startAssistant on B's chat (openclaw)", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedAdmin(t);
    const a = await seedInstanceWithChat(t, admin, "alpha");
    const b = await seedInstanceWithChat(t, admin, "bravo");

    const res = await post(
      t,
      { op: "startAssistant", chatId: b.chatId, runId: "r1" },
      a.secret,
    );
    expect(res.status).toBe(403);
    // No assistant message was created in B's chat by A.
    const created = await t.run((ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_chat", (q) => q.eq("chatId", b.chatId))
        .collect(),
    );
    expect(created).toHaveLength(1); // only the one seeded, none injected
  });

  test("A's per-bridge secret CANNOT setSnapshot on B's message (hermes)", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedAdmin(t);
    const a = await seedInstanceWithChat(t, admin, "alpha-h", "hermes");
    const b = await seedInstanceWithChat(t, admin, "bravo-h", "hermes");

    const res = await post(
      t,
      { op: "setSnapshot", messageId: b.messageId, text: "INJECTED" },
      a.secret,
    );
    expect(res.status).toBe(403);
    expect(await streamTextOf(t, b.messageId)).toBe("");
  });

  test("A's OWN message write is ACCEPTED (the guard is not over-broad)", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedAdmin(t);
    const a = await seedInstanceWithChat(t, admin, "alpha");

    const res = await post(
      t,
      { op: "setSnapshot", messageId: a.messageId, text: "legit-own-write" },
      a.secret,
    );
    expect(res.status).toBe(200);
    expect(await streamTextOf(t, a.messageId)).toBe("legit-own-write");
  });

  test("cross-instance is refused ACROSS the op surface (chatId AND messageId ops)", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedAdmin(t);
    const a = await seedInstanceWithChat(t, admin, "alpha");
    const b = await seedInstanceWithChat(t, admin, "bravo");

    // A representative op from EACH target family, all aimed at B, all with A's
    // secret. Every one must be refused — the guard is at the boundary, not
    // per-op, so this pins that no op slips past it.
    const crossOps: unknown[] = [
      { op: "startAssistant", chatId: b.chatId, runId: "r" }, // chatId
      { op: "appendDelta", messageId: b.messageId, text: "x" }, // messageId (hot)
      { op: "setPhase", messageId: b.messageId, phase: "querying_gateway" }, // messageId
      { op: "finalize", messageId: b.messageId, status: "complete", text: "x" },
      { op: "bindProviderChat", chatId: b.chatId, providerChatId: "p" }, // chatId
      { op: "setSessionMeta", chatId: b.chatId, meta: { model: "m" } }, // chatId
      {
        op: "upsertSubAgent",
        chatId: b.chatId,
        childSessionKey: "c",
        status: "running",
        instanceName: "alpha", // self-asserted — must not help
      },
    ];
    for (const op of crossOps) {
      const res = await post(t, op, a.secret);
      expect(res.status, `op ${(op as { op: string }).op} must be refused`).toBe(
        403,
      );
    }
    // B's message stayed empty and no message was injected into B's chat.
    expect(await streamTextOf(t, b.messageId)).toBe("");
    const bMsgs = await t.run((ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_chat", (q) => q.eq("chatId", b.chatId))
        .collect(),
    );
    expect(bMsgs).toHaveLength(1);
  });

  test("upsertSubAgent stamps the PROVEN instance, ignoring a spoofed body field", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedAdmin(t);
    const a = await seedInstanceWithChat(t, admin, "alpha");

    // A writes to its OWN chat but LIES about the instance in the body.
    const res = await post(
      t,
      {
        op: "upsertSubAgent",
        chatId: a.chatId,
        childSessionKey: "child-1",
        status: "running",
        instanceName: "bravo-SPOOFED",
      },
      a.secret,
    );
    expect(res.status).toBe(200);
    // The row carries the PROVEN instance (alpha), never the spoofed value.
    const row = await t.run((ctx) =>
      ctx.db
        .query("subAgents")
        .withIndex("by_chat", (q) => q.eq("chatId", a.chatId))
        .first(),
    );
    expect(row?.instanceName).toBe("alpha");
  });

  test("DUAL-ACCEPT: the legacy shared secret still writes (transition window)", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedAdmin(t);
    const a = await seedInstanceWithChat(t, admin, "alpha");

    // A bridge still on the shared secret keeps working (no proven identity, so
    // no per-instance authorization — the skeleton key until the flag retires it).
    const res = await post(
      t,
      { op: "setSnapshot", messageId: a.messageId, text: "via-shared" },
      SHARED,
    );
    expect(res.status).toBe(200);
    expect(await streamTextOf(t, a.messageId)).toBe("via-shared");
  });

  test("REQUIRE flag retires the shared skeleton key (per-bridge only)", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedAdmin(t);
    const a = await seedInstanceWithChat(t, admin, "alpha");

    const prev = process.env.BRIDGE_INGEST_REQUIRE_PER_BRIDGE;
    process.env.BRIDGE_INGEST_REQUIRE_PER_BRIDGE = "true";
    try {
      // The shared secret is now rejected outright...
      const shared = await post(
        t,
        { op: "setSnapshot", messageId: a.messageId, text: "x" },
        SHARED,
      );
      expect(shared.status).toBe(401);
      // ...while the per-bridge secret still works.
      const perBridge = await post(
        t,
        { op: "setSnapshot", messageId: a.messageId, text: "per-bridge-ok" },
        a.secret,
      );
      expect(perBridge.status).toBe(200);
      expect(await streamTextOf(t, a.messageId)).toBe("per-bridge-ok");
    } finally {
      if (prev === undefined) delete process.env.BRIDGE_INGEST_REQUIRE_PER_BRIDGE;
      else process.env.BRIDGE_INGEST_REQUIRE_PER_BRIDGE = prev;
    }
  });

  test("PER-TURN routing: the routed instance MAY write to another instance's primary chat", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedAdmin(t);
    // A owns the chat (primary), B is a second instance with its own secret.
    const a = await seedInstanceWithChat(t, admin, "alpha");
    const b = await seedInstanceWithChat(t, admin, "bravo");

    // The chat flips to per-turn routing and this turn is routed to B (send.ts
    // stamps routedInstanceName on the user message before dispatch).
    await t.run(async (ctx) => {
      await ctx.db.patch(a.chatId, { perTurnRouting: true });
      await ctx.db.insert("messages", {
        chatId: a.chatId,
        userId: a.userId,
        role: "user" as const,
        status: "complete" as const,
        text: "ask B",
        routedInstanceName: "bravo",
        routedAgentId: "bob",
        updatedAt: 5,
      });
    });

    // B's bridge legitimately starts + streams the routed turn — ALLOWED, not 403.
    const start = await post(
      t,
      { op: "startAssistant", chatId: a.chatId, runId: "rb" },
      b.secret,
    );
    expect(start.status).toBe(200);

    // But an instance the turn was NOT routed to (a third, "carol") is refused.
    const carol = await seedInstanceWithChat(t, admin, "carol");
    const bad = await post(
      t,
      { op: "startAssistant", chatId: a.chatId, runId: "rc" },
      carol.secret,
    );
    expect(bad.status).toBe(403);
  });

  test("PROVENANCE not latest-route: B keeps streaming after a follow-up routes to C", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedAdmin(t);
    const a = await seedInstanceWithChat(t, admin, "alpha");
    const c = await seedInstanceWithChat(t, admin, "carol");

    // A per-turn chat: an EARLIER turn routed to B (bravo) is mid-stream; a
    // FOLLOW-UP just got queued and routed to C (carol) — so C's user message is
    // now the LATEST. A "latest route" check would wrongly 403 B's own deltas.
    const bMessageId = await t.run(async (ctx) => {
      // Primary stays "alpha"; the interesting case is a routed instance (B)
      // that is NEITHER the primary NOR the latest route.
      await ctx.db.patch(a.chatId, { perTurnRouting: true });
      // B's turn (earlier) + B's still-streaming assistant message.
      await ctx.db.insert("messages", {
        chatId: a.chatId,
        userId: a.userId,
        role: "user" as const,
        status: "complete" as const,
        text: "ask bravo",
        routedInstanceName: "bravo",
        routedAgentId: "bob",
        updatedAt: 5,
      });
      const bMessageId = await ctx.db.insert("messages", {
        chatId: a.chatId,
        userId: a.userId,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "",
        updatedAt: 6,
      });
      // The LATER follow-up, routed to C — now the latest user message.
      await ctx.db.insert("messages", {
        chatId: a.chatId,
        userId: a.userId,
        role: "user" as const,
        status: "complete" as const,
        text: "then ask carol",
        routedInstanceName: "carol",
        routedAgentId: "carl",
        updatedAt: 7,
      });
      return bMessageId;
    });
    // Mint bravo's secret so it can present per-bridge.
    const bravoInst = await t.run((ctx) =>
      ctx.db.insert("instances", {
        name: "bravo",
        gatewayUrl: "ws://bravo",
        kind: "openclaw" as const,
      }),
    );
    const bravoSecret = (
      await asAdmin(t, admin).action(api.bridgeAuth.mintBridgeSecret, {
        instanceId: bravoInst,
      })
    ).plaintext;

    // B's appendDelta on its OWN streaming message is ALLOWED despite C being the
    // latest route (B was routed here → provenance holds).
    const res = await post(
      t,
      { op: "appendDelta", messageId: bMessageId, text: "bravo streaming" },
      bravoSecret,
    );
    expect(res.status).toBe(200);
    expect(await streamTextOf(t, bMessageId)).toContain("bravo streaming");

    // A truly NEVER-routed instance (dave — neither primary nor routed here) is
    // refused, proving the guard still blocks intruders on a per-turn chat.
    const daveInst = await t.run((ctx) =>
      ctx.db.insert("instances", {
        name: "dave",
        gatewayUrl: "ws://dave",
        kind: "openclaw" as const,
      }),
    );
    const daveSecret = (
      await asAdmin(t, admin).action(api.bridgeAuth.mintBridgeSecret, {
        instanceId: daveInst,
      })
    ).plaintext;
    const bad = await post(
      t,
      { op: "appendDelta", messageId: bMessageId, text: "intruder" },
      daveSecret,
    );
    expect(bad.status).toBe(403);
    // C is routed (latest), so C could also write — proving allow is by
    // membership, not exclusivity.
    const cWrite = await post(
      t,
      { op: "setPhase", messageId: bMessageId, phase: "querying_gateway" },
      c.secret,
    );
    expect(cWrite.status).toBe(200);
  });

  test("sub-agent upsert CANNOT reach another instance's child row via its key", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedAdmin(t);
    const a = await seedInstanceWithChat(t, admin, "alpha");
    const b = await seedInstanceWithChat(t, admin, "bravo");

    // B legitimately creates a sub-agent row in ITS OWN chat.
    const childKey = "child-of-bravo";
    const create = await post(
      t,
      {
        op: "upsertSubAgent",
        chatId: b.chatId,
        childSessionKey: childKey,
        status: "running",
      },
      b.secret,
    );
    expect(create.status).toBe(200);

    // A now tries to mutate B's child row by passing its OWN chat + B's child key
    // (the mutation resolves the row GLOBALLY by key). Must be refused, and B's
    // row must keep its status.
    const hijack = await post(
      t,
      {
        op: "upsertSubAgent",
        chatId: a.chatId,
        childSessionKey: childKey,
        status: "error",
        errorMessage: "HIJACK",
      },
      a.secret,
    );
    expect(hijack.status).toBe(403);
    const row = await t.run((ctx) =>
      ctx.db
        .query("subAgents")
        .withIndex("by_child", (q) => q.eq("childSessionKey", childKey))
        .first(),
    );
    expect(row?.status).toBe("running"); // untouched
    expect(row?.chatId).toBe(b.chatId);
  });

  test("upsertSubAgent CANNOT point parentMessageId at another instance's chat", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedAdmin(t);
    const a = await seedInstanceWithChat(t, admin, "alpha");
    const b = await seedInstanceWithChat(t, admin, "bravo");

    // A creates a sub-agent in ITS OWN chat but points the parent at B's message
    // (createSubAgentReport later dereferences + copies that parent's text).
    const res = await post(
      t,
      {
        op: "upsertSubAgent",
        chatId: a.chatId,
        parentMessageId: b.messageId, // foreign parent
        childSessionKey: "child-x",
        status: "running",
      },
      a.secret,
    );
    expect(res.status).toBe(403);
    // No row was created (the atomic barrier threw before the insert).
    const rows = await t.run((ctx) =>
      ctx.db
        .query("subAgents")
        .withIndex("by_chat", (q) => q.eq("chatId", a.chatId))
        .collect(),
    );
    expect(rows).toHaveLength(0);
  });

  test("upsertSubAgentToolPart CANNOT reach another instance's tool row via its key", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedAdmin(t);
    const a = await seedInstanceWithChat(t, admin, "alpha");
    const b = await seedInstanceWithChat(t, admin, "bravo");

    // B creates a tool part in its own chat.
    const key = "childB";
    await post(
      t,
      {
        op: "upsertSubAgentToolPart",
        chatId: b.chatId,
        childSessionKey: key,
        toolCallId: "tc1",
        name: "search",
        status: "running",
      },
      b.secret,
    );
    // A tries to mutate it (own chat + B's key + same toolCallId).
    const hijack = await post(
      t,
      {
        op: "upsertSubAgentToolPart",
        chatId: a.chatId,
        childSessionKey: key,
        toolCallId: "tc1",
        name: "search",
        status: "done",
        resultText: "HIJACK",
      },
      a.secret,
    );
    expect(hijack.status).toBe(403);
    const row = await t.run((ctx) =>
      ctx.db
        .query("subAgentToolParts")
        .withIndex("by_child_tool", (q) =>
          q.eq("childSessionKey", key).eq("toolCallId", "tc1"),
        )
        .first(),
    );
    expect(row?.status).toBe("running"); // untouched
    expect(row?.resultText ?? null).toBe(null);
  });

  test("null-primary chat: transition passthrough, but DENIED under the require flag", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedAdmin(t);
    const a = await seedInstanceWithChat(t, admin, "alpha");
    // A chat with NO instanceName (created before an agent was chosen — the
    // field is optional). NOT perTurnRouting.
    const nullChat = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId,
        role: "user" as const,
        canonical: "n",
      });
      return await ctx.db.insert("chats", { userId, updatedAt: 1 });
    });

    // Transition (flag off): a per-bridge instance may write to an unowned,
    // null-primary chat (backward compat — no guarantee is claimed yet).
    const pass = await post(
      t,
      { op: "setSessionActiveTokens", chatId: nullChat, activeTokens: 1 },
      a.secret,
    );
    expect(pass.status).toBe(200);

    // Hardened (flag on): the null-primary chat is NO LONGER a free-for-all —
    // the "no cross-gateway write" guarantee cannot be defeated through it.
    const prev = process.env.BRIDGE_INGEST_REQUIRE_PER_BRIDGE;
    process.env.BRIDGE_INGEST_REQUIRE_PER_BRIDGE = "true";
    try {
      const denied = await post(
        t,
        { op: "setSessionActiveTokens", chatId: nullChat, activeTokens: 1 },
        a.secret,
      );
      expect(denied.status).toBe(403);
    } finally {
      if (prev === undefined) delete process.env.BRIDGE_INGEST_REQUIRE_PER_BRIDGE;
      else process.env.BRIDGE_INGEST_REQUIRE_PER_BRIDGE = prev;
    }
  });

  test("an unknown Bearer secret is refused (neither per-bridge nor shared)", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedAdmin(t);
    const a = await seedInstanceWithChat(t, admin, "alpha");

    const res = await post(
      t,
      { op: "setSnapshot", messageId: a.messageId, text: "x" },
      "oc_live_totally-bogus-secret",
    );
    expect(res.status).toBe(401);
    expect(await streamTextOf(t, a.messageId)).toBe("");
  });
});
