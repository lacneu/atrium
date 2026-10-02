import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");

const CHILD = "agent:alice:subagent:ix-test-uuid";

async function seed(t: ReturnType<typeof convexTest>, canonical = "alice") {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user", canonical });
    const chatId = await ctx.db.insert("chats", { userId, updatedAt: 0 });
    // A sub-agent of THIS chat (the IDOR link the interaction requires).
    await ctx.db.insert("subAgents", {
      chatId,
      childSessionKey: CHILD,
      status: "done",
      createdAt: 0,
      updatedAt: 0,
    });
    return { userId, chatId };
  });
}

async function insertInteraction(
  t: ReturnType<typeof convexTest>,
  chatId: Id<"chats">,
) {
  return await t.run((ctx) =>
    ctx.db.insert("subAgentInteractions", {
      chatId,
      childSessionKey: CHILD,
      userText: "hello sub-agent",
      status: "pending" as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

describe("subAgentInteractions.recordInteractionReply", () => {
  test("patches the reply + flips pending -> done (bridge write)", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const id = await insertInteraction(t, chatId);
    await t.mutation(internal.subAgentInteractions.recordInteractionReply, {
      interactionId: id,
      status: "done" as const,
      replyText: "INTERACTOK",
    });
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row).toMatchObject({ status: "done", replyText: "INTERACTOK" });
  });

  test("a reply that carried a widget: kept as widgetOmitted, read back by the panel", async () => {
    // The sub-agent panel renders text and cannot show a widget: the bridge removes the
    // shortcode from the text and flags the reply, and the panel says a widget was shown.
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    const id = await insertInteraction(t, chatId);
    await t.mutation(internal.subAgentInteractions.recordInteractionReply, {
      interactionId: id,
      status: "done" as const,
      replyText: "Voici le compteur.",
      widgetOmitted: true,
    });
    const rows = await t
      .withIdentity({ subject: `${userId}|session` })
      .query(api.subAgentInteractions.listSubAgentInteractions, { chatId, childSessionKey: CHILD });
    expect(rows[0]).toMatchObject({ replyText: "Voici le compteur.", widgetOmitted: true });
    // A later reply without one clears it.
    await t.mutation(internal.subAgentInteractions.recordInteractionReply, {
      interactionId: id,
      status: "done" as const,
      replyText: "ok",
    });
    expect((await t.run((ctx) => ctx.db.get(id)))?.widgetOmitted).toBeUndefined();
  });

  test("records an error reply (status error + message)", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seed(t);
    const id = await insertInteraction(t, chatId);
    await t.mutation(internal.subAgentInteractions.recordInteractionReply, {
      interactionId: id,
      status: "error" as const,
      errorMessage: "the sub-agent failed",
    });
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row).toMatchObject({ status: "error", errorMessage: "the sub-agent failed" });
  });
});

describe("subAgentInteractions.listSubAgentInteractions — owner scoping", () => {
  test("the owner sees their thread; a non-owner is rejected", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t, "alice");
    await insertInteraction(t, chatId);
    const otherId = await t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId: uid, role: "user", canonical: "bob" });
      return uid as Id<"users">;
    });

    const asOwner = t.withIdentity({ subject: `${userId}|session` });
    const rows = await asOwner.query(
      api.subAgentInteractions.listSubAgentInteractions,
      { chatId, childSessionKey: CHILD },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userText).toBe("hello sub-agent");

    const asOther = t.withIdentity({ subject: `${otherId}|session` });
    await expect(
      asOther.query(api.subAgentInteractions.listSubAgentInteractions, {
        chatId,
        childSessionKey: CHILD,
      }),
    ).rejects.toThrow(/not owned/i);
  });
});

describe("subAgentInteractions cleanup", () => {
  test("deleting the chat PURGES its interactions (cascade — no orphaned content)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    await insertInteraction(t, chatId);
    const count = () =>
      t.run((ctx) =>
        ctx.db
          .query("subAgentInteractions")
          .withIndex("by_chat", (q) => q.eq("chatId", chatId))
          .collect(),
      );
    expect(await count()).toHaveLength(1);
    await t
      .withIdentity({ subject: `${userId}|session` })
      .mutation(api.chats.deleteChat, { chatId });
    await t
      .withIdentity({ subject: `${userId}|session` })
      .mutation(api.trash.purgeChat, { chatId });
    expect(await count()).toHaveLength(0);
  });
});

describe("subAgentInteractions.prepareInteraction — safety gates", () => {
  test("REJECTS interacting with a RUNNING sub-agent (steer-live gated to terminal)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId: uid, role: "user", canonical: "alice" });
      const cid = await ctx.db.insert("chats", { userId: uid, updatedAt: 0 });
      await ctx.db.insert("subAgents", {
        chatId: cid,
        childSessionKey: CHILD,
        status: "running", // still in flight
        createdAt: 0,
        updatedAt: 0,
      });
      return { userId: uid as Id<"users">, chatId: cid as Id<"chats"> };
    });
    await expect(
      t
        .withIdentity({ subject: `${userId}|session` })
        .mutation(internal.subAgentInteractions.prepareInteraction, {
          chatId,
          childSessionKey: CHILD,
          userText: "steer it",
        }),
    ).rejects.toThrow(/still running/i);
  });

  test("REJECTS a second interaction while one is still pending (single-slot concurrency)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t); // done child
    await insertInteraction(t, chatId); // an existing PENDING interaction
    await expect(
      t
        .withIdentity({ subject: `${userId}|session` })
        .mutation(internal.subAgentInteractions.prepareInteraction, {
          chatId,
          childSessionKey: CHILD,
          userText: "second message",
        }),
    ).rejects.toThrow(/already pending/i);
  });

  test("REJECTS a child that is NOT a sub-agent of this chat (IDOR)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    await expect(
      t
        .withIdentity({ subject: `${userId}|session` })
        .mutation(internal.subAgentInteractions.prepareInteraction, {
          chatId,
          childSessionKey: "agent:evil:subagent:not-mine",
          userText: "hi",
        }),
    ).rejects.toThrow(/not found in this chat/i);
  });
});

describe("prepareInteraction — attachment IDOR gate", () => {
  test("REJECTS an attachment storageId the user does NOT own", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t); // done child in this user's chat
    // A stored blob that was NEVER registerUpload'd to this user → assertOwnsUpload
    // must throw BEFORE any dispatch (the upload-storageId IDOR lesson).
    const storageId = await t.run((ctx) =>
      ctx.storage.store(new Blob(["x"], { type: "image/png" })),
    );
    await expect(
      t
        .withIdentity({ subject: `${userId}|session` })
        .mutation(internal.subAgentInteractions.prepareInteraction, {
          chatId,
          childSessionKey: CHILD,
          userText: "look at this",
          attachments: [
            { storageId, filename: "x.png", mimeType: "image/png" },
          ],
        }),
    ).rejects.toThrow(/not owned/i);
  });
});

// codex pass 12: interaction A got a PROVISIONAL chat error (the gateway's overflow
// recovery may still resume its run). A new interaction B allowed meanwhile took A's
// place on the bridge — and A's recovered reply went to the sub-agent's result.
// Convex now holds new interactions with that child for the recovery grace.
describe("a provisional interaction error holds new interactions for the grace", () => {
  const prepare = (t: ReturnType<typeof convexTest>, userId: Id<"users">, chatId: Id<"chats">) =>
    t
      .withIdentity({ subject: `${userId}|session` })
      .mutation(internal.subAgentInteractions.prepareInteraction, {
        chatId,
        childSessionKey: CHILD,
        userText: "B",
      });

  test("provisional error: refused with SUBAGENT_RECOVERING until the grace is over", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    const a = await insertInteraction(t, chatId);
    await t.mutation(internal.subAgentInteractions.recordInteractionReply, {
      interactionId: a,
      status: "error" as const,
      errorMessage: "context overflow",
      provisional: true,
    });
    await expect(prepare(t, userId, chatId)).rejects.toThrow(/SUBAGENT_RECOVERING/);
    // The grace is over: the hold goes (the seed has no agent, so the next gate speaks).
    await t.run(async (ctx) => ctx.db.patch(a, { recoveringUntil: Date.now() - 1 }));
    await expect(prepare(t, userId, chatId)).rejects.toThrow(/no resolvable agent/);
  });

  test("the recovered reply settles it at once", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    const a = await insertInteraction(t, chatId);
    await t.mutation(internal.subAgentInteractions.recordInteractionReply, {
      interactionId: a,
      status: "error" as const,
      provisional: true,
    });
    await t.mutation(internal.subAgentInteractions.recordInteractionReply, {
      interactionId: a,
      status: "done" as const,
      replyText: "recovered",
    });
    expect((await t.run((ctx) => ctx.db.get(a)))?.recoveringUntil).toBeUndefined();
    await expect(prepare(t, userId, chatId)).rejects.toThrow(/no resolvable agent/);
  });

  test("a DEFINITIVE error (timeout, a send that never left) holds nothing", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seed(t);
    const a = await insertInteraction(t, chatId);
    await t.mutation(internal.subAgentInteractions.recordInteractionReply, {
      interactionId: a,
      status: "error" as const,
    });
    await expect(prepare(t, userId, chatId)).rejects.toThrow(/no resolvable agent/);
  });

  test("the grace is the bridge's own", async () => {
    const { INTERACTION_RECOVERY_GRACE_MS } = await import("./subAgentInteractions");
    const { INTERACTION_RECOVERY_GRACE_SECONDS } = await import(
      "../bridge/src/providers/openclaw/sub-agent-observer"
    );
    expect(INTERACTION_RECOVERY_GRACE_MS).toBe(INTERACTION_RECOVERY_GRACE_SECONDS * 1000);
  });
});
