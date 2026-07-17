/// <reference types="vite/client" />
//
// Quote-reply ("here is what I am responding to"): the pure preamble
// composition, the sendMessage anchor guards, and the rehydration re-injection.
// Discriminating properties:
//   - the preamble follows the registry (default / disabled -> bare quote /
//     admin-customized), per content locale;
//   - a quoted message must belong to THE SAME chat (cross-chat/IDOR refused);
//   - the stored user `text` stays CLEAN (preamble only on the wire);
//   - the outbox carries the excerpt (dispatch + redo prefix from it);
//   - the rebuilt rehydration history reads like the original prompt.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import {
  QUOTE_EXCERPT_CAP,
  composeQuotedText,
  quotePreamble,
} from "./lib/quoteReply";
import { renderTurn } from "./chatSummaries";

const modules = import.meta.glob("./**/*.ts");

describe("lib/quoteReply — pure preamble composition", () => {
  test("default template frames the excerpt (per locale)", () => {
    const fr = quotePreamble("le classement proposé", undefined, "fr");
    expect(fr).toContain("[EN RÉPONSE À]");
    expect(fr).toContain("> le classement proposé");
    const en = quotePreamble("the proposed layout", undefined, "en");
    expect(en).toContain("[IN REPLY TO]");
    expect(en).toContain("> the proposed layout");
  });
  test("disabled keeps the BARE markdown quote (never silently dropped)", () => {
    const p = quotePreamble(
      "extrait",
      { quote_reply: { enabled: false } },
      "fr",
    );
    expect(p).toBe("> extrait");
  });
  test("an admin-customized template wins and keeps the placeholder fill", () => {
    const p = quotePreamble(
      "extrait",
      { quote_reply: { template: "REPLYING TO: {excerpt}" } },
      "fr",
    );
    expect(p).toBe("REPLYING TO: extrait");
  });
  test("composeQuotedText prefixes; empty preamble is a no-op; empty text keeps the bare preamble", () => {
    expect(composeQuotedText("PRE", "ask")).toBe("PRE\n\nask");
    expect(composeQuotedText("", "ask")).toBe("ask");
    expect(composeQuotedText("PRE", "")).toBe("PRE");
  });
});

async function seedUserChat(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", {
      userId,
      role: "user" as const,
      canonical: "u",
    });
    await ctx.db.insert("userAgents", {
      userId,
      instanceName: "prod",
      agentId: "main",
      isDefault: true,
      source: "manual" as const,
      createdAt: 1,
    });
    const chatId = await ctx.db.insert("chats", {
      userId,
      updatedAt: 1,
      instanceName: "prod",
      agentId: "main",
    });
    const quotedId = await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "assistant" as const,
      status: "complete" as const,
      text: "Voici le classement proposé.\n\nEt voici la suite.",
      updatedAt: 1,
    });
    return { userId, chatId, quotedId };
  });
}

describe("sendMessage — quote anchor", () => {
  test("stores the anchor on the message, the excerpt on the outbox; text stays clean", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, quotedId } = await seedUserChat(t);
    const as = t.withIdentity({ subject: `${userId}|session` });
    const res = await as.mutation(api.send.sendMessage, {
      chatId,
      text: "Corrige le deuxieme dossier",
      clientMessageId: "q1",
      quote: { messageId: quotedId, blockIndex: 0, excerpt: "Voici le classement proposé." },
    });
    const msg = await t.run((ctx) => ctx.db.get(res.messageId as Id<"messages">));
    expect(msg!.text).toBe("Corrige le deuxieme dossier"); // clean
    expect(msg!.quotedMessageId).toBe(quotedId);
    expect(msg!.quotedBlockIndex).toBe(0);
    expect(msg!.quotedExcerpt).toBe("Voici le classement proposé.");
    const outbox = await t.run((ctx) => ctx.db.get(res.outboxId));
    expect(outbox!.quotedExcerpt).toBe("Voici le classement proposé.");
    expect(outbox!.text).toBe("Corrige le deuxieme dossier");
  });

  test("whole-message quote (blockIndex null) stores NO block index", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, quotedId } = await seedUserChat(t);
    const as = t.withIdentity({ subject: `${userId}|session` });
    const res = await as.mutation(api.send.sendMessage, {
      chatId,
      text: "ok",
      clientMessageId: "q2",
      quote: { messageId: quotedId, blockIndex: null, excerpt: "tout le message" },
    });
    const msg = await t.run((ctx) => ctx.db.get(res.messageId as Id<"messages">));
    expect(msg!.quotedBlockIndex).toBeUndefined();
    expect(msg!.quotedExcerpt).toBe("tout le message");
  });

  test("a quoted message from ANOTHER chat is refused (cross-chat/IDOR)", async () => {
    const t = convexTest(schema, modules);
    const a = await seedUserChat(t);
    const b = await seedUserChat(t);
    const as = t.withIdentity({ subject: `${a.userId}|session` });
    await expect(
      as.mutation(api.send.sendMessage, {
        chatId: a.chatId,
        text: "x",
        clientMessageId: "q3",
        quote: { messageId: b.quotedId, blockIndex: 0, excerpt: "vol" },
      }),
    ).rejects.toThrow(/not in this chat/);
  });

  test("a NON-assistant quoted message is refused (contract: quote YOUR reply)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedUserChat(t);
    const as = t.withIdentity({ subject: `${userId}|session` });
    const userMsgId = await t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId,
        userId,
        role: "user" as const,
        status: "complete" as const,
        text: "un message utilisateur",
        updatedAt: 2,
      }),
    );
    await expect(
      as.mutation(api.send.sendMessage, {
        chatId,
        text: "x",
        clientMessageId: "q6",
        quote: { messageId: userMsgId, blockIndex: null, excerpt: "un message" },
      }),
    ).rejects.toThrow(/not an assistant reply/);
  });

  test("empty excerpt refused; oversized excerpt capped server-side", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, quotedId } = await seedUserChat(t);
    const as = t.withIdentity({ subject: `${userId}|session` });
    await expect(
      as.mutation(api.send.sendMessage, {
        chatId,
        text: "x",
        clientMessageId: "q4",
        quote: { messageId: quotedId, blockIndex: null, excerpt: "   " },
      }),
    ).rejects.toThrow(/empty quote/);
    const res = await as.mutation(api.send.sendMessage, {
      chatId,
      text: "x",
      clientMessageId: "q5",
      quote: {
        messageId: quotedId,
        blockIndex: null,
        excerpt: "y".repeat(2000),
      },
    });
    const msg = await t.run((ctx) => ctx.db.get(res.messageId as Id<"messages">));
    expect(msg!.quotedExcerpt!.length).toBe(QUOTE_EXCERPT_CAP);
  });
});

describe("reconstruction paths re-carry the quote (codex review)", () => {
  test("deleteMessage-regenerate outbox carries quotedExcerpt", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, quotedId } = await seedUserChat(t);
    const { assistantId } = await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "user" as const,
        status: "complete" as const,
        text: "Corrige le deuxieme dossier",
        quotedMessageId: quotedId,
        quotedBlockIndex: 0,
        quotedExcerpt: "Voici le classement proposé.",
        updatedAt: 2,
      });
      const assistantId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "Fait.",
        updatedAt: 3,
      });
      return { assistantId };
    });
    await t
      .withIdentity({ subject: `${userId}|session` })
      .mutation(api.messages.deleteMessage, { messageId: assistantId });
    const outbox = await t.run((ctx) =>
      ctx.db
        .query("outbox")
        .withIndex("by_chat_status", (q) =>
          q.eq("chatId", chatId).eq("status", "pending"),
        )
        .first(),
    );
    // The regenerated dispatch re-prefixes from THIS — without it the redo
    // loses the targeted passage.
    expect(outbox?.quotedExcerpt).toBe("Voici le classement proposé.");
  });

  test("forkChat copies the quote fields and REMAPS quotedMessageId", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, quotedId } = await seedUserChat(t);
    const { tailId } = await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "user" as const,
        status: "complete" as const,
        text: "Corrige le deuxieme dossier",
        quotedMessageId: quotedId,
        quotedBlockIndex: 0,
        quotedExcerpt: "Voici le classement proposé.",
        updatedAt: 2,
      });
      const tailId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "Fait.",
        updatedAt: 3,
      });
      return { tailId };
    });
    const { chatId: forkId } = await t
      .withIdentity({ subject: `${userId}|session` })
      .mutation(api.chatFork.forkChat, { branchMessageId: tailId });
    const forkMsgs = await t.run((ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_chat", (q) => q.eq("chatId", forkId as Id<"chats">))
        .collect(),
    );
    const quoting = forkMsgs.find((m2) => m2.quotedExcerpt !== undefined);
    expect(quoting?.quotedExcerpt).toBe("Voici le classement proposé.");
    expect(quoting?.quotedBlockIndex).toBe(0);
    // The anchor points at the COPY, not the source message.
    expect(quoting?.quotedMessageId).toBeDefined();
    expect(quoting?.quotedMessageId).not.toBe(quotedId);
    const target = forkMsgs.find((m2) => m2._id === quoting?.quotedMessageId);
    expect(target?.text).toContain("Voici le classement proposé.");
  });

  test("summary renderTurn composes the preamble for a quoted user turn", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, quotedId } = await seedUserChat(t);
    const doc = await t.run(async (ctx) => {
      const id = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "user" as const,
        status: "complete" as const,
        text: "Corrige le deuxieme dossier",
        quotedMessageId: quotedId,
        quotedBlockIndex: 0,
        quotedExcerpt: "Voici le classement proposé.",
        updatedAt: 2,
      });
      return (await ctx.db.get(id))!;
    });
    const emptyChildren = { byMsg: new Map(), unsettled: new Set<string>() };
    const line = renderTurn(doc, emptyChildren, "fr", undefined);
    // The summarizer must see what "corrige ceci" binds to, or the link is
    // lost for good once the turn passes under the watermark.
    expect(line).toContain("[EN RÉPONSE À]");
    expect(line).toContain("> Voici le classement proposé.");
    expect(line).toContain("Corrige le deuxieme dossier");
  });
});

describe("rehydration — the rebuilt history re-carries the preamble", () => {
  test("an attachment-only quoted turn (empty text) still reaches the history", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, quotedId } = await seedUserChat(t);
    const { currentId } = await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "user" as const,
        status: "complete" as const,
        text: "", // attachment-only send — the quote is its whole content
        quotedMessageId: quotedId,
        quotedBlockIndex: 0,
        quotedExcerpt: "Voici le classement proposé.",
        updatedAt: 2,
      });
      const currentId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "user" as const,
        status: "complete" as const,
        text: "merci",
        updatedAt: 3,
      });
      return { currentId };
    });
    const r = await t.query(internal.stream.rehydrationContext, {
      chatId,
      excludeMessageId: currentId,
    });
    // The eligibility filters must count the quote as content, or the turn
    // vanishes from the rebuilt history (codex P2).
    expect(r.history).toContain("[EN RÉPONSE À]");
    expect(r.history).toContain("> Voici le classement proposé.");
  });

  test("a quoted user turn rehydrates WITH the default preamble; others untouched", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, quotedId } = await seedUserChat(t);
    // A prior quoted USER turn + its assistant reply, then the current send.
    const { currentId } = await t.run(async (ctx) => {
      const q = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "user" as const,
        status: "complete" as const,
        text: "Corrige le deuxieme dossier",
        quotedMessageId: quotedId,
        quotedBlockIndex: 0,
        quotedExcerpt: "Voici le classement proposé.",
        updatedAt: 2,
      });
      await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "Fait.",
        updatedAt: 3,
      });
      const currentId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "user" as const,
        status: "complete" as const,
        text: "merci",
        updatedAt: 4,
      });
      return { q, currentId };
    });
    const r = await t.query(internal.stream.rehydrationContext, {
      chatId,
      excludeMessageId: currentId,
    });
    // The quoted turn reads like the original dispatched prompt.
    expect(r.history).toContain("[EN RÉPONSE À]");
    expect(r.history).toContain("> Voici le classement proposé.");
    expect(r.history).toContain("Corrige le deuxieme dossier");
    // The plain assistant turn is untouched.
    expect(r.history).toContain("Fait.");
  });
});
