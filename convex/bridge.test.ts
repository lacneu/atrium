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
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { readErrorCode } from "./bridge";

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
