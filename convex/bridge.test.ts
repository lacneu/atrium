/// <reference types="vite/client" />
//
// Regression: a dispatch that never reached the bridge (BRIDGE_* unset), hit an
// unrouted user, or was refused by the gateway (bridge 502) used to leave the
// user staring at their own message with NO reply and NO signal. `failDispatch`
// is the single transactional failure transition that BOTH marks the outbox
// failed AND surfaces a user-visible assistant `error` turn (rendered by the
// frontend's RunStatus). These tests pin: it surfaces the bubble, is retry-safe
// (no duplicate bubble), never touches an already-terminal row, and is resilient
// to a chat deleted mid-turn.

import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { readErrorCode } from "./bridge";
import { maxRawInboundBytes } from "./lib/attachmentLimits";

const modules = import.meta.glob("./**/*.ts");

/** Seed a user + chat + a PENDING outbox row (the dispatch's starting state). */
async function seed(
  t: ReturnType<typeof convexTest>,
): Promise<{ chatId: Id<"chats">; outboxId: Id<"outbox"> }> {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const now = Date.now();
    const chatId = await ctx.db.insert("chats", {
      userId,
      archived: false,
      updatedAt: now,
    });
    const outboxId = await ctx.db.insert("outbox", {
      chatId,
      userId,
      clientMessageId: "cmid-1",
      text: "hello",
      attachmentIds: [],
      status: "pending",
    });
    return { chatId, outboxId };
  });
}

function messagesOf(t: ReturnType<typeof convexTest>, chatId: Id<"chats">) {
  // Filter in JS rather than withIndex: convexTest's generic `ctx` type does not
  // carry the custom index list, so `.withIndex("by_chat")` would not typecheck
  // here. A full scan is fine at test scale.
  return t.run(async (ctx) => {
    const all = await ctx.db.query("messages").collect();
    return all.filter((m) => m.chatId === chatId);
  });
}

describe("bridge.failDispatch", () => {
  test("marks the outbox failed AND surfaces a user-visible assistant error turn", async () => {
    const t = convexTest(schema, modules);
    const { chatId, outboxId } = await seed(t);

    await t.mutation(internal.bridge.failDispatch, { outboxId, reason: "no_agent" });

    const row = await t.run((ctx) => ctx.db.get(outboxId));
    expect(row?.status).toBe("failed");

    const msgs = await messagesOf(t, chatId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.role).toBe("assistant");
    expect(msgs[0]!.status).toBe("error");
    expect(msgs[0]!.text).toBe(""); // RunStatus renders from `error`, not `text`
    expect(msgs[0]!.error).toMatch(/administrateur/i);
    expect(msgs[0]!.error).toMatch(/no-agent/); // reason-specific ref
  });

  test("is idempotent — a retry inserts NO second error bubble", async () => {
    const t = convexTest(schema, modules);
    const { chatId, outboxId } = await seed(t);

    await t.mutation(internal.bridge.failDispatch, { outboxId, reason: "send_failed" });
    await t.mutation(internal.bridge.failDispatch, { outboxId, reason: "send_failed" });

    const msgs = await messagesOf(t, chatId);
    expect(msgs).toHaveLength(1); // not 2 — the pending-guard makes it single-fire
  });

  test("never clobbers an already-sent row (success path stays clean)", async () => {
    const t = convexTest(schema, modules);
    const { chatId, outboxId } = await seed(t);
    await t.run((ctx) => ctx.db.patch(outboxId, { status: "sent" }));

    await t.mutation(internal.bridge.failDispatch, { outboxId, reason: "send_failed" });

    const row = await t.run((ctx) => ctx.db.get(outboxId));
    expect(row?.status).toBe("sent"); // unchanged
    expect(await messagesOf(t, chatId)).toHaveLength(0); // no spurious error bubble
  });

  test("resilient to a chat deleted mid-turn — marks failed, inserts nothing", async () => {
    const t = convexTest(schema, modules);
    const { chatId, outboxId } = await seed(t);
    await t.run((ctx) => ctx.db.delete(chatId));

    await t.mutation(internal.bridge.failDispatch, { outboxId, reason: "send_failed" });

    const row = await t.run((ctx) => ctx.db.get(outboxId));
    expect(row?.status).toBe("failed");
    expect(await messagesOf(t, chatId)).toHaveLength(0);
  });

  test("reason selects the matching message (not_configured -> bridge-config ref)", async () => {
    const t = convexTest(schema, modules);
    const { chatId, outboxId } = await seed(t);

    await t.mutation(internal.bridge.failDispatch, {
      outboxId,
      reason: "not_configured",
    });

    const msgs = await messagesOf(t, chatId);
    expect(msgs[0]!.error).toMatch(/bridge-config/);
  });

  test("an attachment errorCode is PRESERVED on the message (so diagnose can classify it) + drives the user message", async () => {
    const t = convexTest(schema, modules);
    const { chatId, outboxId } = await seed(t);

    await t.mutation(internal.bridge.failDispatch, {
      outboxId,
      reason: "send_failed",
      errorCode: "ATTACHMENT_TOO_LARGE",
    });

    const msgs = await messagesOf(t, chatId);
    // The STABLE code is stored — /api/v1/diagnose reads it (via chatStateInternal)
    // to reach the `attachment_problem` class instead of normalizing the localized
    // text to "unknown" (the codex-review gap this fixes).
    expect(msgs[0]!.errorCode).toBe("ATTACHMENT_TOO_LARGE");
    // The user still sees the attachment-specific message, not the generic one.
    expect(msgs[0]!.error).toMatch(/volumineuse/i);
  });
});

// readErrorCode is the version-skew guard: a Convex deploy can land BEFORE the new
// bridge image is pulled, so it must tolerate the OLD ({error:"string"}) and NEW
// ({error:{code}}) 502 shapes, and never throw on an empty / non-JSON body (which
// would regress the dispatch into a SILENT failure — the bug we are fixing).
describe("bridge.readErrorCode (tolerant 502 body parsing)", () => {
  const make = (body: string) => new Response(body, { status: 502 });

  test("new bridge shape { error: { code } } -> the code", async () => {
    const code = await readErrorCode(
      make(JSON.stringify({ ok: false, error: { code: "AGENT_NOT_FOUND" } })),
    );
    expect(code).toBe("AGENT_NOT_FOUND");
  });

  test("OLD bridge shape { error: 'string' } -> undefined (no code, no throw)", async () => {
    const code = await readErrorCode(
      make(JSON.stringify({ ok: false, error: "upstream send failed" })),
    );
    expect(code).toBeUndefined();
  });

  test("empty body -> undefined (never throws)", async () => {
    expect(await readErrorCode(make(""))).toBeUndefined();
  });

  test("non-JSON body -> undefined (never throws)", async () => {
    expect(await readErrorCode(make("<html>502 Bad Gateway</html>"))).toBeUndefined();
  });

  test("error object without a code -> undefined", async () => {
    const code = await readErrorCode(
      make(JSON.stringify({ ok: false, error: {} })),
    );
    expect(code).toBeUndefined();
  });
});

describe("bridge.dispatchReset — regenerate with NO agent surfaces an error (no silent failure)", () => {
  test("no-agent regenerate → failDispatch (outbox failed + assistant error bubble)", async () => {
    const t = convexTest(schema, modules);
    const prevUrl = process.env.BRIDGE_URL;
    const prevSecret = process.env.BRIDGE_SHARED_SECRET;
    process.env.BRIDGE_URL = "http://127.0.0.1:8787"; // pass the config gate
    process.env.BRIDGE_SHARED_SECRET = "x";
    try {
      const { chatId, userId, regenId } = await t.run(async (ctx) => {
        const userId = await ctx.db.insert("users", {});
        await ctx.db.insert("profiles", {
          userId,
          role: "user",
          canonical: "alice",
        });
        const now = Date.now();
        const chatId = await ctx.db.insert("chats", {
          userId,
          archived: false,
          updatedAt: now,
        });
        const regenId = await ctx.db.insert("outbox", {
          chatId,
          userId,
          clientMessageId: "regen-1",
          text: "hi",
          attachmentIds: [],
          status: "pending",
        });
        return { chatId, userId, regenId };
      });

      // No userAgents → resolveTargetForChat → no_agent. dispatchReset hits the
      // no-agent branch and returns BEFORE any fetch — so this is hermetic.
      await t.action(internal.bridge.dispatchReset, {
        chatId,
        userId,
        regenerateOutboxId: regenId,
      });

      const outbox = await t.run((ctx) => ctx.db.get(regenId));
      expect(outbox?.status).toBe("failed"); // no longer pending + silent

      const msgs = await messagesOf(t, chatId);
      const err = msgs.find(
        (m) => m.role === "assistant" && m.status === "error",
      );
      expect(err).toBeTruthy();
      expect(err?.error ?? "").toMatch(/agent/i); // the "no agent" bubble
    } finally {
      if (prevUrl === undefined) delete process.env.BRIDGE_URL;
      else process.env.BRIDGE_URL = prevUrl;
      if (prevSecret === undefined) delete process.env.BRIDGE_SHARED_SECRET;
      else process.env.BRIDGE_SHARED_SECRET = prevSecret;
    }
  });
});

// The user's prod bug: a 20.9 MiB attachment was SILENTLY skipped (`continue`)
// here, so the text went out fileless with no error. The fix FAILS the send with a
// clear ATTACHMENT_TOO_LARGE and NEVER POSTs (an oversized base64 frame closes the
// gateway connection). This is the server-side "no silent drop" — the PRIMARY
// defense in the cold-start window where the composer cap is still unknown.
describe("bridge.dispatch — over-cap inbound attachment FAILS (never silently dropped)", () => {
  test("an over-cap attachment -> outbox failed ATTACHMENT_TOO_LARGE, NO POST to the bridge", async () => {
    const t = convexTest(schema, modules);
    const prevUrl = process.env.BRIDGE_URL;
    const prevSecret = process.env.BRIDGE_SHARED_SECRET;
    process.env.BRIDGE_URL = "http://127.0.0.1:0";
    process.env.BRIDGE_SHARED_SECRET = "test-secret";
    // The over-cap path must NEVER POST; spy so we assert that — and so a regression
    // to the old silent `continue` (which WOULD POST text-only) is caught.
    const fetchSpy = vi.fn(async () => new Response(null, { status: 200 }));
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const { outboxId, chatId } = await t.run(async (ctx) => {
        const userId = await ctx.db.insert("users", {});
        const now = Date.now();
        // A routed default agent so resolveTargetForChat returns a target.
        await ctx.db.insert("userAgents", {
          userId,
          instanceName: "primary",
          agentId: "alice",
          isDefault: true,
          source: "manual",
          createdAt: now,
        });
        const chatId = await ctx.db.insert("chats", {
          userId,
          archived: false,
          updatedAt: now,
        });
        const messageId = await ctx.db.insert("messages", {
          chatId,
          userId,
          role: "user",
          status: "complete",
          text: "read this",
          updatedAt: now,
        });
        // A TINY (5-byte) blob — but maxPayload=1000 derives maxRawInboundBytes=0,
        // so ANY attachment is over-cap (no multi-MB blob needed to trip the path).
        const storageId = await ctx.storage.store(
          new Blob([new Uint8Array([1, 2, 3, 4, 5])]),
        );
        const outboxId = await ctx.db.insert("outbox", {
          chatId,
          userId,
          clientMessageId: "cmid-over",
          messageId,
          text: "read this",
          attachmentIds: [storageId],
          attachments: [
            { storageId, filename: "a.bin", mimeType: "application/octet-stream" },
          ],
          status: "pending",
        });
        await ctx.db.insert("bridgeHealth", {
          key: "singleton",
          reachable: true,
          checkedAt: now,
          maxPayload: 1000, // -> maxRawInboundBytes 0 -> the 5-byte blob is over-cap
          targets: [],
        });
        return { outboxId, chatId };
      });

      await t.action(internal.bridge.dispatch, { outboxId });

      const row = await t.run((ctx) => ctx.db.get(outboxId));
      expect(row?.status).toBe("failed"); // NOT silently sent text-only
      expect(fetchSpy).not.toHaveBeenCalled(); // never POSTed the socket-killing frame
      const msgs = await messagesOf(t, chatId);
      const err = msgs.find((m) => m.role === "assistant" && m.status === "error");
      expect(err?.error ?? "").toMatch(/attach-size/); // the ATTACHMENT_TOO_LARGE message
    } finally {
      globalThis.fetch = origFetch;
      if (prevUrl === undefined) delete process.env.BRIDGE_URL;
      else process.env.BRIDGE_URL = prevUrl;
      if (prevSecret === undefined) delete process.env.BRIDGE_SHARED_SECRET;
      else process.env.BRIDGE_SHARED_SECRET = prevSecret;
    }
  });

  test("AGGREGATE: two files each UNDER the per-file cap but over the frame TOGETHER -> FAIL", async () => {
    const t = convexTest(schema, modules);
    const prevUrl = process.env.BRIDGE_URL;
    const prevSecret = process.env.BRIDGE_SHARED_SECRET;
    process.env.BRIDGE_URL = "http://127.0.0.1:0";
    process.env.BRIDGE_SHARED_SECRET = "test-secret";
    const fetchSpy = vi.fn(async () => new Response(null, { status: 200 }));
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    // envelope (131072) + 8 -> per-file raw cap 6 bytes; ONE 5-byte file fits the
    // frame, TWO do not. maxPayload bounds the WHOLE frame, not each file — a
    // per-blob check (the bug Codex flagged) would wrongly accept both.
    const MAXP = 131072 + 8;
    try {
      const { outboxId, chatId } = await t.run(async (ctx) => {
        const userId = await ctx.db.insert("users", {});
        const now = Date.now();
        await ctx.db.insert("userAgents", {
          userId,
          instanceName: "primary",
          agentId: "alice",
          isDefault: true,
          source: "manual",
          createdAt: now,
        });
        const chatId = await ctx.db.insert("chats", {
          userId,
          archived: false,
          updatedAt: now,
        });
        const messageId = await ctx.db.insert("messages", {
          chatId,
          userId,
          role: "user",
          status: "complete",
          text: "",
          updatedAt: now,
        });
        const five = () =>
          ctx.storage.store(new Blob([new Uint8Array([1, 2, 3, 4, 5])]));
        const s1 = await five();
        const s2 = await five();
        const outboxId = await ctx.db.insert("outbox", {
          chatId,
          userId,
          clientMessageId: "cmid-2att",
          messageId,
          text: "",
          attachmentIds: [s1, s2],
          attachments: [
            { storageId: s1, filename: "a.bin", mimeType: "application/octet-stream" },
            { storageId: s2, filename: "b.bin", mimeType: "application/octet-stream" },
          ],
          status: "pending",
        });
        await ctx.db.insert("bridgeHealth", {
          key: "singleton",
          reachable: true,
          checkedAt: now,
          maxPayload: MAXP,
          targets: [],
        });
        return { outboxId, chatId };
      });

      // Each 5-byte file IS under the per-file raw cap -> a per-blob check passes both.
      expect(maxRawInboundBytes(MAXP)).toBeGreaterThan(5);

      await t.action(internal.bridge.dispatch, { outboxId });

      const row = await t.run((ctx) => ctx.db.get(outboxId));
      expect(row?.status).toBe("failed"); // the aggregate frame is over -> fail
      expect(fetchSpy).not.toHaveBeenCalled();
      const msgs = await messagesOf(t, chatId);
      expect(msgs.some((m) => /attach-size/.test(m.error ?? ""))).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
      if (prevUrl === undefined) delete process.env.BRIDGE_URL;
      else process.env.BRIDGE_URL = prevUrl;
      if (prevSecret === undefined) delete process.env.BRIDGE_SHARED_SECRET;
      else process.env.BRIDGE_SHARED_SECRET = prevSecret;
    }
  });

  test("MIXED DEPLOY: maxPayload UNKNOWN (old bridge) still enforces a conservative cap, never skips", async () => {
    // Regression for the deployment-compat hole (Codex P1): an old bridge image
    // does not report maxPayload (no bridgeHealth doc here), and the old hardcoded
    // INBOUND_MAX_BYTES was removed. Without the fallback, a 20+ MiB attachment
    // would be POSTed to a bridge with NO frame guard -> gateway disconnect. The
    // conservative default must still FAIL it locally.
    const t = convexTest(schema, modules);
    const prevUrl = process.env.BRIDGE_URL;
    const prevSecret = process.env.BRIDGE_SHARED_SECRET;
    process.env.BRIDGE_URL = "http://127.0.0.1:0";
    process.env.BRIDGE_SHARED_SECRET = "test-secret";
    const fetchSpy = vi.fn(async () => new Response(null, { status: 200 }));
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const { outboxId, chatId } = await t.run(async (ctx) => {
        const userId = await ctx.db.insert("users", {});
        const now = Date.now();
        await ctx.db.insert("userAgents", {
          userId,
          instanceName: "primary",
          agentId: "alice",
          isDefault: true,
          source: "manual",
          createdAt: now,
        });
        const chatId = await ctx.db.insert("chats", {
          userId,
          archived: false,
          updatedAt: now,
        });
        const messageId = await ctx.db.insert("messages", {
          chatId,
          userId,
          role: "user",
          status: "complete",
          text: "",
          updatedAt: now,
        });
        // 20 MiB > the conservative default's ~18.6 MiB raw cap (the size check runs
        // on blob.size BEFORE base64-encoding, so no 27 MiB string is built here).
        const storageId = await ctx.storage.store(
          new Blob([new Uint8Array(20 * 1024 * 1024)]),
        );
        const outboxId = await ctx.db.insert("outbox", {
          chatId,
          userId,
          clientMessageId: "cmid-mixed",
          messageId,
          text: "",
          attachmentIds: [storageId],
          attachments: [
            { storageId, filename: "big.bin", mimeType: "application/octet-stream" },
          ],
          status: "pending",
        });
        // NO bridgeHealth doc -> maxPayloadInternal returns null (old/cold bridge).
        return { outboxId, chatId };
      });

      await t.action(internal.bridge.dispatch, { outboxId });

      const row = await t.run((ctx) => ctx.db.get(outboxId));
      expect(row?.status).toBe("failed"); // enforced by the conservative default
      expect(fetchSpy).not.toHaveBeenCalled(); // never POSTed to the (guard-less) old bridge
      const msgs = await messagesOf(t, chatId);
      expect(msgs.some((m) => /attach-size/.test(m.error ?? ""))).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
      if (prevUrl === undefined) delete process.env.BRIDGE_URL;
      else process.env.BRIDGE_URL = prevUrl;
      if (prevSecret === undefined) delete process.env.BRIDGE_SHARED_SECRET;
      else process.env.BRIDGE_SHARED_SECRET = prevSecret;
    }
  });

  test("a file at the cap PLUS a long prompt is NOT rejected (message rides the envelope, not double-counted)", async () => {
    // Codex P3/P2: the message text must NOT be added to the frame size on top of
    // the reserved envelope — else a file exactly at the advertised cap + a normal
    // prompt is accepted by the composer then rejected at dispatch (and a UTF-16 vs
    // UTF-8 mismatch could push a frame over). Here a blob at the cap + a 5000-char
    // prompt must SEND (fetch called), proving the message does not shrink the file
    // budget. The pre-fix code (frameBytes = text.length) would have failed this.
    const t = convexTest(schema, modules);
    const prevUrl = process.env.BRIDGE_URL;
    const prevSecret = process.env.BRIDGE_SHARED_SECRET;
    process.env.BRIDGE_URL = "http://127.0.0.1:0";
    process.env.BRIDGE_SHARED_SECRET = "test-secret";
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    // maxPayload so the per-file raw cap is exactly 900 bytes (base64 1200 == usable).
    const MAXP = 131072 + 1200;
    const longText = "x".repeat(5000);
    try {
      const outboxId = await t.run(async (ctx) => {
        const userId = await ctx.db.insert("users", {});
        const now = Date.now();
        await ctx.db.insert("userAgents", {
          userId,
          instanceName: "primary",
          agentId: "alice",
          isDefault: true,
          source: "manual",
          createdAt: now,
        });
        const chatId = await ctx.db.insert("chats", {
          userId,
          archived: false,
          updatedAt: now,
        });
        const messageId = await ctx.db.insert("messages", {
          chatId,
          userId,
          role: "user",
          status: "complete",
          text: longText,
          updatedAt: now,
        });
        const storageId = await ctx.storage.store(
          new Blob([new Uint8Array(maxRawInboundBytes(MAXP))]),
        );
        return await ctx.db.insert("outbox", {
          chatId,
          userId,
          clientMessageId: "cmid-cap-plus-text",
          messageId,
          text: longText,
          attachmentIds: [storageId],
          attachments: [
            { storageId, filename: "f.bin", mimeType: "application/octet-stream" },
          ],
          status: "pending",
        });
      });
      await t.run(async (ctx) => {
        await ctx.db.insert("bridgeHealth", {
          key: "singleton",
          reachable: true,
          checkedAt: Date.now(),
          maxPayload: MAXP,
          targets: [],
        });
      });

      await t.action(internal.bridge.dispatch, { outboxId });

      // The file fit the frame; the long prompt did NOT shrink its budget -> SENT.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const row = await t.run((ctx) => ctx.db.get(outboxId));
      expect(row?.status).toBe("sent");
    } finally {
      globalThis.fetch = origFetch;
      if (prevUrl === undefined) delete process.env.BRIDGE_URL;
      else process.env.BRIDGE_URL = prevUrl;
      if (prevSecret === undefined) delete process.env.BRIDGE_SHARED_SECRET;
      else process.env.BRIDGE_SHARED_SECRET = prevSecret;
    }
  });
});

// openclawThreadForChat reconstructs the OpenClaw `thread_id` (== gateway session
// key) so trace-enrichment can find OpenClaw's OWN Opik traces for a chat. It MUST
// produce the SAME string the bridge sends with (session-keys.ts) — these pin that
// the Convex-side reconstruction (resolveTargetForChat + the openclawChatId??chatId
// + rebind rules) agrees with the bridge byte-for-byte.
describe("bridge.openclawThreadForChat — reconstruct the OpenClaw thread_id", () => {
  async function seedChat(
    t: ReturnType<typeof convexTest>,
    opts: { bound?: boolean; openclawChatId?: string; withAgent?: boolean } = {},
  ): Promise<Id<"chats">> {
    return await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId,
        role: "user",
        canonical: "alice",
      });
      if (opts.withAgent !== false) {
        await ctx.db.insert("userAgents", {
          userId,
          instanceName: "prod",
          agentId: "bob",
          isDefault: true,
          source: "manual",
          createdAt: 1,
        });
        await ctx.db.insert("agents", {
          instanceName: "prod",
          agentId: "bob",
          source: "discovered",
          presentInLastOk: true,
          firstSeenAt: 1,
          lastSeenAt: 1,
        });
      }
      return await ctx.db.insert("chats", {
        userId,
        archived: false,
        updatedAt: Date.now(),
        ...(opts.bound ? { instanceName: "prod", agentId: "bob" } : {}),
        ...(opts.openclawChatId ? { openclawChatId: opts.openclawChatId } : {}),
      });
    });
  }

  test("unbound chat -> agent:<default agent>:webchat:chat:<canonical>:<convex chatId>", async () => {
    const t = convexTest(schema, modules);
    const chatId = await seedChat(t);
    const thread = await t.query(internal.bridge.openclawThreadForChat, { chatId });
    // Unbound -> rebind to default -> stale openclawChatId dropped -> convex chatId.
    expect(thread).toBe(`agent:bob:webchat:chat:alice:${chatId}`);
  });

  test("bound chat with a provider conversation id -> uses that openclawChatId segment", async () => {
    const t = convexTest(schema, modules);
    const chatId = await seedChat(t, { bound: true, openclawChatId: "oc-xyz" });
    const thread = await t.query(internal.bridge.openclawThreadForChat, { chatId });
    expect(thread).toBe("agent:bob:webchat:chat:alice:oc-xyz");
  });

  test("no assigned agent -> null (never query with a partial/guessed key)", async () => {
    const t = convexTest(schema, modules);
    const chatId = await seedChat(t, { withAgent: false });
    expect(
      await t.query(internal.bridge.openclawThreadForChat, { chatId }),
    ).toBeNull();
  });

  test("a nonexistent chat id -> null (no throw)", async () => {
    const t = convexTest(schema, modules);
    expect(
      await t.query(internal.bridge.openclawThreadForChat, {
        chatId: "not-a-real-id",
      }),
    ).toBeNull();
  });
});

// Model M (one bridge per instance): dispatch POSTs to the ROUTED instance's own
// bridgeUrl (else the env BRIDGE_URL fallback) and carries the resolved per-
// instance NON-secret config in-band. These pin the routing + the hot-config wire.
describe("bridge.dispatch — per-instance bridgeUrl + in-band config (Model M)", () => {
  /** Seed a user routed to `instanceName`, that instance row, a chat + pending
   *  outbox WITHOUT attachments (so the send reaches the POST). */
  async function seedRouted(
    t: ReturnType<typeof convexTest>,
    opts: { bridgeUrl?: string; config?: Record<string, unknown> },
  ): Promise<Id<"outbox">> {
    return await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const now = Date.now();
      await ctx.db.insert("userAgents", {
        userId,
        instanceName: "primary",
        agentId: "alice",
        isDefault: true,
        source: "manual",
        createdAt: now,
      });
      await ctx.db.insert("instances", {
        name: "primary",
        gatewayUrl: "ws://gw:18790",
        ...(opts.bridgeUrl ? { bridgeUrl: opts.bridgeUrl } : {}),
        ...(opts.config ? { config: opts.config } : {}),
      });
      const chatId = await ctx.db.insert("chats", {
        userId,
        archived: false,
        updatedAt: now,
      });
      return await ctx.db.insert("outbox", {
        chatId,
        userId,
        clientMessageId: "cmid-route",
        text: "hello",
        attachmentIds: [],
        status: "pending",
      });
    });
  }

  test("POSTs to the instance's OWN bridgeUrl (wins over env BRIDGE_URL) with ONLY the stored overrides", async () => {
    const t = convexTest(schema, modules);
    const prevUrl = process.env.BRIDGE_URL;
    const prevSecret = process.env.BRIDGE_SHARED_SECRET;
    process.env.BRIDGE_URL = "http://env-fallback:1"; // must be OVERRIDDEN
    process.env.BRIDGE_SHARED_SECRET = "test-secret";
    const fetchSpy = vi.fn(async () => new Response(null, { status: 200 }));
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const outboxId = await seedRouted(t, {
        bridgeUrl: "http://instance-host:9999",
        config: { mediaMode: "shared-fs", inboundMediaMode: "shared-fs" },
      });
      await t.action(internal.bridge.dispatch, { outboxId });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("http://instance-host:9999/send"); // per-instance, NOT env
      const body = JSON.parse(init.body as string);
      // ONLY the admin's stored overrides — NOT the defaults-filled object. Sending
      // the filled defaults would shadow an env-configured bridge (e.g. force its
      // OPENCLAW_MEDIA_MODE/MAX_MB/REHYDRATION back to Convex defaults on every send).
      // The unset fields (rehydration/mediaMaxMb/mounts) are ABSENT so the bridge
      // keeps its own env default.
      expect(body.config).toEqual({
        mediaMode: "shared-fs",
        inboundMediaMode: "shared-fs",
      });
      const row = await t.run((ctx) => ctx.db.get(outboxId));
      expect(row?.status).toBe("sent");
    } finally {
      globalThis.fetch = origFetch;
      if (prevUrl === undefined) delete process.env.BRIDGE_URL;
      else process.env.BRIDGE_URL = prevUrl;
      if (prevSecret === undefined) delete process.env.BRIDGE_SHARED_SECRET;
      else process.env.BRIDGE_SHARED_SECRET = prevSecret;
    }
  });

  test("shared-fs: a tool-read file rides BY REFERENCE (getUrl, not base64); an image stays inline", async () => {
    const t = convexTest(schema, modules);
    const prevSecret = process.env.BRIDGE_SHARED_SECRET;
    process.env.BRIDGE_SHARED_SECRET = "test-secret";
    const fetchSpy = vi.fn(async () => new Response(null, { status: 200 }));
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const outboxId = await t.run(async (ctx) => {
        const userId = await ctx.db.insert("users", {});
        const now = Date.now();
        await ctx.db.insert("userAgents", {
          userId,
          instanceName: "primary",
          agentId: "alice",
          isDefault: true,
          source: "manual",
          createdAt: now,
        });
        await ctx.db.insert("instances", {
          name: "primary",
          gatewayUrl: "ws://gw:18790",
          bridgeUrl: "http://b:9",
          config: { inboundMediaMode: "shared-fs" },
        });
        const chatId = await ctx.db.insert("chats", {
          userId,
          archived: false,
          updatedAt: now,
        });
        const videoId = await ctx.storage.store(
          new Blob([new Uint8Array([1, 2, 3, 4])]),
        );
        const imageId = await ctx.storage.store(
          new Blob([new Uint8Array([5, 6, 7, 8])]),
        );
        return await ctx.db.insert("outbox", {
          chatId,
          userId,
          clientMessageId: "cmid-ref",
          text: "transcribe this",
          attachmentIds: [videoId, imageId],
          attachments: [
            { storageId: videoId, filename: "clip.mp4", mimeType: "video/mp4" },
            { storageId: imageId, filename: "pic.png", mimeType: "image/png" },
          ],
          status: "pending",
        });
      });

      await t.action(internal.bridge.dispatch, { outboxId });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      // The video → reference (a getUrl, NO base64 content).
      expect(body.referenceAttachments).toHaveLength(1);
      expect(body.referenceAttachments[0].fileName).toBe("clip.mp4");
      expect(typeof body.referenceAttachments[0].url).toBe("string");
      expect(body.referenceAttachments[0].content).toBeUndefined();
      // The image (model-native) stays inline base64.
      expect(body.attachments).toHaveLength(1);
      expect(body.attachments[0].fileName).toBe("pic.png");
      expect(typeof body.attachments[0].content).toBe("string");
    } finally {
      globalThis.fetch = origFetch;
      if (prevSecret === undefined) delete process.env.BRIDGE_SHARED_SECRET;
      else process.env.BRIDGE_SHARED_SECRET = prevSecret;
    }
  });

  test("falls back to env BRIDGE_URL when the instance has no bridgeUrl (single-bridge path)", async () => {
    const t = convexTest(schema, modules);
    const prevUrl = process.env.BRIDGE_URL;
    const prevSecret = process.env.BRIDGE_SHARED_SECRET;
    process.env.BRIDGE_URL = "http://env-fallback:1";
    process.env.BRIDGE_SHARED_SECRET = "test-secret";
    const fetchSpy = vi.fn(async () => new Response(null, { status: 200 }));
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const outboxId = await seedRouted(t, {}); // no bridgeUrl, no config
      await t.action(internal.bridge.dispatch, { outboxId });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("http://env-fallback:1/send");
      // No instance config → NO config override sent (null), so the bridge keeps its
      // OWN env defaults (not shadowed by Convex defaults on every send). This is the
      // backward-compat path D-F-b: an env-only-configured bridge is untouched.
      const body = JSON.parse(init.body as string);
      expect(body.config).toBeNull();
    } finally {
      globalThis.fetch = origFetch;
      if (prevUrl === undefined) delete process.env.BRIDGE_URL;
      else process.env.BRIDGE_URL = prevUrl;
      if (prevSecret === undefined) delete process.env.BRIDGE_SHARED_SECRET;
      else process.env.BRIDGE_SHARED_SECRET = prevSecret;
    }
  });

  test("getChatInboundPolicy: shared-fs instance → shared-fs mode + its cap; default → inline", async () => {
    const t = convexTest(schema, modules);
    // shared-fs instance with a 200 MB cap.
    const { userId, sharedChatId, defaultChatId } = await t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId: uid, role: "user" });
      const now = Date.now();
      await ctx.db.insert("userAgents", {
        userId: uid,
        instanceName: "primary",
        agentId: "alice",
        isDefault: true,
        source: "manual",
        createdAt: now,
      });
      await ctx.db.insert("instances", {
        name: "primary",
        gatewayUrl: "ws://gw",
        config: { inboundMediaMode: "shared-fs", mediaMaxMb: 200 },
      });
      const sharedChatId = await ctx.db.insert("chats", {
        userId: uid,
        archived: false,
        updatedAt: now,
      });
      return { userId: uid, sharedChatId, defaultChatId: sharedChatId };
    });
    const as = t.withIdentity({ subject: `${userId}|session` });

    const policy = await as.query(api.bridge.getChatInboundPolicy, {
      chatId: sharedChatId,
    });
    expect(policy).toEqual({
      inboundMediaMode: "shared-fs",
      sharedFsMaxBytes: 200 * 1024 * 1024,
    });

    // An instance WITHOUT config resolves to the inline default.
    const { uid2, plainChatId } = await t.run(async (ctx) => {
      const u = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId: u, role: "user" });
      const now = Date.now();
      await ctx.db.insert("userAgents", {
        userId: u,
        instanceName: "plain",
        agentId: "bob",
        isDefault: true,
        source: "manual",
        createdAt: now,
      });
      await ctx.db.insert("instances", { name: "plain", gatewayUrl: "ws://gw2" });
      const c = await ctx.db.insert("chats", {
        userId: u,
        archived: false,
        updatedAt: now,
      });
      return { uid2: u, plainChatId: c };
    });
    const as2 = t.withIdentity({ subject: `${uid2}|session` });
    const plain = await as2.query(api.bridge.getChatInboundPolicy, {
      chatId: plainChatId,
    });
    expect(plain?.inboundMediaMode).toBe("inline");

    // IDOR: user 2 must NOT learn user 1's chat routing/media policy. Returns null
    // (fail-closed), NOT user 1's shared-fs policy. Delete the ownership check and
    // this leaks {inboundMediaMode:"shared-fs", ...} cross-user.
    const leak = await as2.query(api.bridge.getChatInboundPolicy, {
      chatId: sharedChatId,
    });
    expect(leak).toBeNull();
    void defaultChatId;
  });

  test("no instance bridgeUrl AND no env BRIDGE_URL -> failed not_configured, NO POST", async () => {
    const t = convexTest(schema, modules);
    const prevUrl = process.env.BRIDGE_URL;
    const prevSecret = process.env.BRIDGE_SHARED_SECRET;
    delete process.env.BRIDGE_URL;
    process.env.BRIDGE_SHARED_SECRET = "test-secret";
    const fetchSpy = vi.fn(async () => new Response(null, { status: 200 }));
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const outboxId = await seedRouted(t, {}); // neither URL set
      await t.action(internal.bridge.dispatch, { outboxId });

      expect(fetchSpy).not.toHaveBeenCalled();
      const row = await t.run((ctx) => ctx.db.get(outboxId));
      expect(row?.status).toBe("failed");
    } finally {
      globalThis.fetch = origFetch;
      if (prevUrl === undefined) delete process.env.BRIDGE_URL;
      else process.env.BRIDGE_URL = prevUrl;
      if (prevSecret === undefined) delete process.env.BRIDGE_SHARED_SECRET;
      else process.env.BRIDGE_SHARED_SECRET = prevSecret;
    }
  });

  test("two instances dispatch INDEPENDENTLY: each POSTs to its OWN bridge with its OWN config (no crossover)", async () => {
    // The robustness proof of Model M isolation: with TWO instances configured at
    // once, a dispatch for one NEVER reaches the other's bridge nor carries the
    // other's config. The single-instance tests above prove routing reads the
    // instance row; this proves two such reads stay independent in one run.
    const t = convexTest(schema, modules);
    const prevUrl = process.env.BRIDGE_URL;
    const prevSecret = process.env.BRIDGE_SHARED_SECRET;
    delete process.env.BRIDGE_URL; // no env fallback → force per-instance routing
    process.env.BRIDGE_SHARED_SECRET = "test-secret";
    // Record every POST keyed by its target URL.
    const calls: Record<string, { config?: { mediaMode?: string } }> = {};
    const fetchSpy = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        calls[String(input)] = JSON.parse((init?.body as string) ?? "{}");
        return new Response(null, { status: 200 });
      },
    );
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const seedInstance = (
        name: string,
        agentId: string,
        bridgeUrl: string,
        config: Record<string, unknown>,
      ): Promise<Id<"outbox">> =>
        t.run(async (ctx) => {
          const userId = await ctx.db.insert("users", {});
          const now = Date.now();
          await ctx.db.insert("userAgents", {
            userId,
            instanceName: name,
            agentId,
            isDefault: true,
            source: "manual",
            createdAt: now,
          });
          await ctx.db.insert("instances", {
            name,
            gatewayUrl: `ws://gw-${name}`,
            bridgeUrl,
            config,
          });
          const chatId = await ctx.db.insert("chats", {
            userId,
            archived: false,
            updatedAt: now,
          });
          return ctx.db.insert("outbox", {
            chatId,
            userId,
            clientMessageId: `cmid-${name}`,
            text: "hi",
            attachmentIds: [],
            status: "pending",
          });
        });

      // Two fully-separate instances: different bridge URLs AND different configs.
      const outA = await seedInstance("primary", "alice", "http://bridge-primary:8787", {
        mediaMode: "shared-fs",
      });
      const outB = await seedInstance("beta", "bob", "http://bridge-beta:8787", {
        mediaMode: "off",
      });

      await t.action(internal.bridge.dispatch, { outboxId: outA });
      await t.action(internal.bridge.dispatch, { outboxId: outB });

      // Routing isolation: each instance hit its OWN bridge, exactly once. A crossover
      // (primary's send reaching bridge-beta) would change these keys.
      expect(Object.keys(calls).sort()).toEqual([
        "http://bridge-beta:8787/send",
        "http://bridge-primary:8787/send",
      ]);
      // Config isolation: primary's shared-fs did NOT bleed onto beta (off), nor the
      // reverse. Swap the routing OR the config and one of these flips.
      expect(calls["http://bridge-primary:8787/send"].config?.mediaMode).toBe(
        "shared-fs",
      );
      expect(calls["http://bridge-beta:8787/send"].config?.mediaMode).toBe("off");
      expect(calls["http://bridge-primary:8787/send"].config?.mediaMode).not.toBe(
        "off",
      );
      expect(calls["http://bridge-beta:8787/send"].config?.mediaMode).not.toBe(
        "shared-fs",
      );

      // Both sends succeeded independently.
      const [rowA, rowB] = await t.run(async (ctx) => [
        await ctx.db.get(outA),
        await ctx.db.get(outB),
      ]);
      expect(rowA?.status).toBe("sent");
      expect(rowB?.status).toBe("sent");
    } finally {
      globalThis.fetch = origFetch;
      if (prevUrl === undefined) delete process.env.BRIDGE_URL;
      else process.env.BRIDGE_URL = prevUrl;
      if (prevSecret === undefined) delete process.env.BRIDGE_SHARED_SECRET;
      else process.env.BRIDGE_SHARED_SECRET = prevSecret;
    }
  });
});
