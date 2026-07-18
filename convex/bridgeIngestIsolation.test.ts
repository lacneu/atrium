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
import { api, internal } from "./_generated/api";
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
    // The live row a real startAssistant would have created — STAMPED with the
    // owning instance, so message-scoped ops exercise the real (atomic,
    // stamp-compared) barrier rather than the row-less no-op path.
    await ctx.db.insert("streamingText", {
      messageId,
      chatId,
      userId,
      generation: null,
      boundInstance: name,
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

/** Grant `instanceName/agentId` to the user (userAgents + present agent row):
 *  the per-turn authz branch RE-VALIDATES a routed stamp against the owner's
 *  effective grants, so a legitimately-routed instance must be granted. */
async function grantInstance(
  t: T,
  userId: Id<"users">,
  instanceName: string,
  agentId: string,
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("userAgents", {
      userId,
      instanceName,
      agentId,
      isDefault: false,
      source: "manual" as const,
      createdAt: 1,
    });
    await ctx.db.insert("agents", {
      instanceName,
      agentId,
      source: "discovered" as const,
      presentInLastOk: true,
      enabled: true,
      firstSeenAt: 1,
      lastSeenAt: 1,
    });
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

  test("PER-BRIDGE ONLY: the legacy shared secret is refused, permanently (no mode)", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedAdmin(t);
    const a = await seedInstanceWithChat(t, admin, "alpha");

    // The env value existing changes NOTHING: the ingest endpoint has no
    // shared-secret path at all — isolation is not configurable.
    const shared = await post(
      t,
      { op: "setSnapshot", messageId: a.messageId, text: "via-shared" },
      SHARED,
    );
    expect(shared.status).toBe(401);
    expect(await streamTextOf(t, a.messageId)).toBe("");
    // The per-bridge secret works.
    const perBridge = await post(
      t,
      { op: "setSnapshot", messageId: a.messageId, text: "per-bridge-ok" },
      a.secret,
    );
    expect(perBridge.status).toBe(200);
    expect(await streamTextOf(t, a.messageId)).toBe("per-bridge-ok");
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
    await grantInstance(t, a.userId, "bravo", "bob");

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
    await grantInstance(t, a.userId, "bravo", "bob");
    await grantInstance(t, a.userId, "carol", "carl");
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
    // C is routed in the CHAT, but this STREAM belongs to B's turn (the
    // boundInstance stamp is per-turn): C must NOT write into B's live row —
    // stricter than chat membership, and exactly the generational isolation
    // the stamp exists for.
    const cWrite = await post(
      t,
      { op: "setPhase", messageId: bMessageId, phase: "querying_gateway" },
      c.secret,
    );
    expect(cWrite.status).toBe(403);
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

  test("null-primary chat is DENIED, always (no transition mode)", async () => {
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

    // An unstamped chat is NOT a free-for-all: the widen-phase migration
    // stamped every derivable chat, and the undispatchable residue is never
    // legitimately written to — deny, with no mode to soften it.
    const denied = await post(
      t,
      { op: "setSessionActiveTokens", chatId: nullChat, activeTokens: 1 },
      a.secret,
    );
    expect(denied.status).toBe(403);
  });

  test("null-primary chat RESOLVABLE to the caller: allowed + SELF-HEALED (stamped, stale session dropped)", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedAdmin(t);
    const a = await seedInstanceWithChat(t, admin, "alpha");
    // A legacy chat (no instanceName) whose owner RESOLVES to alpha: alpha IS
    // its rightful writer. The boundary (a query) must allow WITHOUT writing,
    // and the mutation must heal — stamp the binding AND drop the pre-binding
    // provider session (bindChatTarget's rebind semantics: that session may
    // belong to a different agent, resuming it is the wrong thread).
    const legacy = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId,
        role: "user" as const,
        canonical: "lg",
      });
      const chatId = await ctx.db.insert("chats", {
        userId,
        updatedAt: 1,
        openclawChatId: "stale-pre-binding-session",
      });
      return { userId, chatId };
    });
    await grantInstance(t, legacy.userId, "alpha", "alice");

    const ok = await post(
      t,
      { op: "setSessionActiveTokens", chatId: legacy.chatId, activeTokens: 1 },
      a.secret,
    );
    expect(ok.status).toBe(200);
    const healed = await t.run((ctx) => ctx.db.get(legacy.chatId));
    expect(healed?.instanceName).toBe("alpha");
    expect(healed?.agentId).toBe("alice");
    expect(healed?.openclawChatId ?? null).toBe(null); // stale session dropped
  });

  test("null-primary chat resolvable to ANOTHER instance: caller denied, chat untouched", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedAdmin(t);
    await seedInstanceWithChat(t, admin, "alpha");
    const b = await seedInstanceWithChat(t, admin, "bravo");
    // The legacy chat resolves to ALPHA — bravo is not its writer, and the
    // self-healing path must not stamp (or clear) anything for a denied caller.
    const legacy = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId,
        role: "user" as const,
        canonical: "lx",
      });
      const chatId = await ctx.db.insert("chats", {
        userId,
        updatedAt: 1,
        openclawChatId: "pre-binding-session",
      });
      return { userId, chatId };
    });
    await grantInstance(t, legacy.userId, "alpha", "alice");

    const denied = await post(
      t,
      { op: "setSessionActiveTokens", chatId: legacy.chatId, activeTokens: 1 },
      b.secret,
    );
    expect(denied.status).toBe(403);
    const chat = await t.run((ctx) => ctx.db.get(legacy.chatId));
    expect(chat?.instanceName ?? null).toBe(null); // NOT stamped by a denied caller
    expect(chat?.openclawChatId).toBe("pre-binding-session"); // untouched
  });

  test("announce re-own is GATED by the parent's durable stamp (forged anchor + announce)", async () => {
    // B and ALPHA are both valid per-turn routes of the chat, but the parent
    // message was finalized by ALPHA (durable boundInstance stamp). B forges a
    // sub-agent anchor onto that parent, then sends the matching announce run:
    // the reopen must REFUSE to re-own alpha's message for B (403), leaving the
    // parent terminal and alpha-owned.
    const t = convexTest(schema, modules);
    const admin = await seedAdmin(t);
    const a = await seedInstanceWithChat(t, admin, "alpha");
    const b = await seedInstanceWithChat(t, admin, "bravo");
    const parentId = await t.run(async (ctx) => {
      await ctx.db.patch(a.chatId, { perTurnRouting: true });
      // Both instances have a routed turn — B IS a legitimate chat member.
      for (const [inst, agent] of [["alpha", "alice"], ["bravo", "bob"]] as const) {
        await ctx.db.insert("messages", {
          chatId: a.chatId,
          userId: a.userId,
          role: "user" as const,
          status: "complete" as const,
          text: `ask ${inst}`,
          routedInstanceName: inst,
          routedAgentId: agent,
          updatedAt: 5,
        });
      }
      // ALPHA's finalized parent — the LAST message of the chat (announce
      // position gate) with the durable ownership stamp.
      const parentId = await ctx.db.insert("messages", {
        chatId: a.chatId,
        userId: a.userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "alpha's final answer",
        boundInstance: "alpha",
        updatedAt: 9,
      });
      // B's FORGED anchor: a sub-agent row keyed to an announce child, pinned
      // to alpha's parent with an exact anchor.
      await ctx.db.insert("subAgents", {
        chatId: a.chatId,
        parentMessageId: parentId,
        childSessionKey: "spy-child",
        status: "running" as const,
        anchorExact: true,
        createdAt: 9,
        updatedAt: 9,
      });
      return parentId;
    });
    await grantInstance(t, a.userId, "bravo", "bob");

    const denied = await post(
      t,
      {
        op: "startAssistant",
        chatId: a.chatId,
        runId: "announce:1:spy-child:done",
      },
      b.secret,
    );
    expect(denied.status).toBe(403);
    const parent = await t.run((ctx) => ctx.db.get(parentId));
    expect(parent?.boundInstance).toBe("alpha"); // NOT re-owned
    expect(parent?.status).toBe("complete"); // NOT reopened
    expect(parent?.runId ?? null).toBe(null); // announce run never attached
  });

  test("per-turn re-validation honors GROUP scope: a direct grant OUTSIDE the group pool is not proof", async () => {
    // The owner is IN a group whose pool contains only ALPHA; their stale
    // direct userAgents row on BRAVO falls OUTSIDE that pool, and
    // getEffectiveGrants drops it — so bravo's historical route must NOT
    // authorize bravo's bridge (codex P1: a userAgents row alone is not an
    // effective grant for an in-group user).
    const t = convexTest(schema, modules);
    const admin = await seedAdmin(t);
    const a = await seedInstanceWithChat(t, admin, "alpha");
    const b = await seedInstanceWithChat(t, admin, "bravo");
    await t.run(async (ctx) => {
      await ctx.db.patch(a.chatId, { perTurnRouting: true });
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
    });
    // Direct grant on bravo… but the user's GROUP pool only contains alpha.
    await grantInstance(t, a.userId, "bravo", "bob");
    await t.run(async (ctx) => {
      const groupId = await ctx.db.insert("groups", {
        key: "g1",
        name: "G1",
        createdBy: admin,
        createdAt: 1,
      });
      await ctx.db.insert("groupMembers", {
        groupId,
        userId: a.userId,
        joinedAt: 1,
      });
      await ctx.db.insert("groupAgents", {
        groupId,
        instanceName: "alpha",
        agentId: "alice",
        createdAt: 1,
      });
      await ctx.db.insert("agents", {
        instanceName: "alpha",
        agentId: "alice",
        source: "discovered" as const,
        presentInLastOk: true,
        enabled: true,
        firstSeenAt: 1,
        lastSeenAt: 1,
      });
    });
    const denied = await post(
      t,
      { op: "setSessionActiveTokens", chatId: a.chatId, activeTokens: 1 },
      b.secret,
    );
    expect(denied.status).toBe(403);
  });

  test("per-turn re-validation (all-pool): an instance whose only present agent is DISABLED is not proof", async () => {
    // Groupless, grantless owner (all-pool semantics). Bravo's ONLY present
    // discovered agent is explicitly disabled — getEffectiveGrants excludes it,
    // so bravo's historical route must NOT authorize bravo's bridge (codex P1:
    // presence alone is not usability).
    const t = convexTest(schema, modules);
    const admin = await seedAdmin(t);
    const a = await seedInstanceWithChat(t, admin, "alpha");
    const b = await seedInstanceWithChat(t, admin, "bravo");
    await t.run(async (ctx) => {
      await ctx.db.patch(a.chatId, { perTurnRouting: true });
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
      await ctx.db.insert("agents", {
        instanceName: "bravo",
        agentId: "bob",
        source: "discovered" as const,
        presentInLastOk: true,
        enabled: false, // explicitly disabled — unusable in BOTH modes
        firstSeenAt: 1,
        lastSeenAt: 1,
      });
    });
    const denied = await post(
      t,
      { op: "setSessionActiveTokens", chatId: a.chatId, activeTokens: 1 },
      b.secret,
    );
    expect(denied.status).toBe(403);
  });

  test("R2: a ROUTED-but-not-OWNING instance cannot finalize/addPart/updateRunId B's stream", async () => {
    // C is legitimately routed in the chat (member), but THIS stream belongs to
    // B's turn: the row stamp must refuse C on every stream-scoped op — the
    // codex P1 quartet (finalize, addPart, updateRunId; deltas already pinned).
    const t = convexTest(schema, modules);
    const admin = await seedAdmin(t);
    const a = await seedInstanceWithChat(t, admin, "alpha");
    const c = await seedInstanceWithChat(t, admin, "carol");
    // Per-turn chat: one turn routed to bravo (owner of the live stream), and
    // one routed to carol (so carol IS a chat member).
    await t.run(async (ctx) => {
      await ctx.db.patch(a.chatId, { perTurnRouting: true });
      for (const [inst, agent] of [["bravo", "bob"], ["carol", "carl"]] as const) {
        await ctx.db.insert("messages", {
          chatId: a.chatId,
          userId: a.userId,
          role: "user" as const,
          status: "complete" as const,
          text: `ask ${inst}`,
          routedInstanceName: inst,
          routedAgentId: agent,
          updatedAt: 5,
        });
      }
    });
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
    await grantInstance(t, a.userId, "bravo", "bob");
    await grantInstance(t, a.userId, "carol", "carl");
    // Bravo starts ITS turn (stamps the row).
    const start = await post(
      t,
      { op: "startAssistant", chatId: a.chatId, runId: null },
      bravoSecret,
    );
    expect(start.status).toBe(200);
    const { messageId } = (await start.json()) as { messageId: string };

    // Carol (routed member, NOT the stream owner) is refused on all three.
    for (const op of [
      { op: "finalize", messageId, status: "complete", text: "HIJACK" },
      {
        op: "addPart",
        messageId,
        part: { kind: "reasoning", text: "inj" },
      },
      { op: "updateRunId", messageId, runId: "carol-run" },
    ]) {
      const res = await post(t, op, c.secret);
      expect(res.status, `${(op as { op: string }).op} must be 403`).toBe(403);
    }
    // Bravo finalizes its own stream fine.
    const fin = await post(
      t,
      { op: "finalize", messageId, status: "complete", text: "bravo-done" },
      bravoSecret,
    );
    expect(fin.status).toBe(200);
    const msg = await t.run((ctx) =>
      ctx.db.get(messageId as Id<"messages">),
    );
    expect(msg?.text).toBe("bravo-done");
  });

  test("R2: per-turn ownership SURVIVES finalize (terminal message stays closed to other routed instances)", async () => {
    // After B's turn finalizes, its live row (and row stamp) is deleted — the
    // DURABLE message stamp must still refuse a routed-but-not-owning C on
    // addPart/advancePlan against the terminal message (codex P1).
    const t = convexTest(schema, modules);
    const admin = await seedAdmin(t);
    const a = await seedInstanceWithChat(t, admin, "alpha");
    const c = await seedInstanceWithChat(t, admin, "carol");
    await t.run(async (ctx) => {
      await ctx.db.patch(a.chatId, { perTurnRouting: true });
      for (const [inst, agent] of [["bravo", "bob"], ["carol", "carl"]] as const) {
        await ctx.db.insert("messages", {
          chatId: a.chatId,
          userId: a.userId,
          role: "user" as const,
          status: "complete" as const,
          text: `ask ${inst}`,
          routedInstanceName: inst,
          routedAgentId: agent,
          updatedAt: 5,
        });
      }
    });
    await grantInstance(t, a.userId, "bravo", "bob");
    await grantInstance(t, a.userId, "carol", "carl");
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

    // B runs + FINALIZES its turn (the live row is gone after this).
    const start = await post(
      t,
      { op: "startAssistant", chatId: a.chatId, runId: null },
      bravoSecret,
    );
    const { messageId } = (await start.json()) as { messageId: string };
    const fin = await post(
      t,
      { op: "finalize", messageId, status: "complete", text: "bravo-answer" },
      bravoSecret,
    );
    expect(fin.status).toBe(200);

    // C (routed member) must STILL be refused on the terminal message.
    for (const op of [
      { op: "addPart", messageId, part: { kind: "reasoning", text: "inject" } },
      { op: "advancePlan", messageId, count: 1, settleIfIdle: false },
    ]) {
      const res = await post(t, op, c.secret);
      expect(res.status, `${(op as { op: string }).op} on terminal must be 403`).toBe(403);
    }
    // The terminal message is untouched.
    const parts = await t.run((ctx) =>
      ctx.db
        .query("messageParts")
        .withIndex("by_message", (q) =>
          q.eq("messageId", messageId as Id<"messages">),
        )
        .collect(),
    );
    expect(parts).toHaveLength(0);
  });

  test("R2: a FORGED routedAgent is refused AT SEND (provenance is validated at the source)", async () => {
    // chatAllowsInstance's per-turn branch trusts message.routedInstanceName —
    // so send must refuse to stamp a route the user is not entitled to. A user
    // with NO grant on "bravo" forging routedAgent {bravo} must fail the send
    // immediately (never persist the poisoned provenance).
    const t = convexTest(schema, modules);
    const admin = await seedAdmin(t);
    const a = await seedInstanceWithChat(t, admin, "alpha");
    // Give the chat owner a grant on ALPHA only (so the all-pool fallback does
    // not apply and bravo stays out of reach).
    await t.run(async (ctx) => {
      await ctx.db.insert("userAgents", {
        userId: a.userId,
        instanceName: "alpha",
        agentId: "main",
        isDefault: true,
        source: "manual" as const,
        createdAt: 1,
      });
    });
    await expect(
      t.withIdentity({ subject: `${a.userId}|session` }).mutation(
        api.send.sendMessage,
        {
          chatId: a.chatId,
          text: "forge",
          clientMessageId: "forge-1",
          routedAgent: { instanceName: "bravo", agentId: "bob" },
        },
      ),
    ).rejects.toThrow(/not assigned/);
    // The poisoned provenance was never persisted.
    const stamped = await t.run((ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_chat_routed_instance", (q) =>
          q.eq("chatId", a.chatId).eq("routedInstanceName", "bravo"),
        )
        .first(),
    );
    expect(stamped).toBeNull();
  });

  test("R2 ATOMIC: the write mutations enforce the barrier THEMSELVES (boundary bypassed)", async () => {
    // The TOCTOU proof: calling the internal mutations DIRECTLY (as if a rebind
    // slipped between the boundary check and the write) must still refuse —
    // the enforcement lives in the write transaction, not only at the boundary.
    const t = convexTest(schema, modules);
    const admin = await seedAdmin(t);
    const a = await seedInstanceWithChat(t, admin, "alpha");

    // startAssistant bound to an instance the chat does not allow → throws.
    await expect(
      t.mutation(internal.stream.startAssistant, {
        chatId: a.chatId,
        runId: "rz",
        boundInstanceName: "mallory",
      }),
    ).rejects.toThrow(/cross-instance/);

    // A legitimate start stamps the row; a delta bound to ANOTHER instance is
    // refused against the stamp (generational, zero-read compare).
    const messageId = await t.mutation(internal.stream.startAssistant, {
      chatId: a.chatId,
      runId: "rz2",
      boundInstanceName: "alpha",
    });
    await expect(
      t.mutation(internal.stream.appendDelta, {
        messageId,
        text: "intrude",
        boundInstanceName: "mallory",
      }),
    ).rejects.toThrow(/cross-instance/);
    // The legitimate writer streams fine.
    await t.mutation(internal.stream.appendDelta, {
      messageId,
      text: "ok",
      boundInstanceName: "alpha",
    });
    expect(await streamTextOf(t, messageId)).toBe("ok");
    // finalize bound to another instance is refused; the right one lands.
    await expect(
      t.mutation(internal.stream.finalize, {
        messageId,
        status: "complete",
        text: "hijack",
        boundInstanceName: "mallory",
      }),
    ).rejects.toThrow(/cross-instance/);
    await t.mutation(internal.stream.finalize, {
      messageId,
      status: "complete",
      text: "done",
      boundInstanceName: "alpha",
    });
    const msg = await t.run((ctx) => ctx.db.get(messageId));
    expect(msg?.text).toBe("done");
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
