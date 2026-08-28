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
  QUOTE_MAX_PER_TURN,
  composeQuotedText,
  hasQuotes,
  outboxExcerpts,
  quotePreamble,
  quotedRefsOf,
  quotesPreamble,
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
  test("ONE quote composes EXACTLY this string (frozen: the gauge sizes on it)", () => {
    // The N=1 composition is load-bearing well beyond the prompt: composedTurnBody
    // feeds freshTailCount and the context gauge, so a single extra newline here
    // silently shifts tail sizing and compaction. Frozen byte-for-byte so widening
    // the feature to SEVERAL quotes cannot move the one-quote case.
    expect(
      composeQuotedText(quotePreamble("le classement proposé", undefined, "fr"), "corrige-le"),
    ).toBe(
      "[EN RÉPONSE À]\n" +
        "L'utilisateur répond à ce passage précis d'une réponse précédente de l'assistant :\n" +
        "> le classement proposé\n" +
        "Traite sa consigne comme portant spécifiquement sur ce passage.\n" +
        "\n" +
        "corrige-le",
    );
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

describe("SEVERAL passages in one turn — the composition", () => {
  test("two passages read as two, not as one continuous quote", () => {
    const p = quotesPreamble(["le premier", "le second"], undefined, "fr");
    // Plural framing, and a blank quote line BETWEEN the passages: run together
    // as `> le premier\n> le second` they would read as one quoted paragraph
    // and the agent would answer about a passage the user never picked.
    expect(p).toBe(
      "[EN RÉPONSE À]\n" +
        "L'utilisateur répond à ces passages précis de réponses précédentes de l'assistant :\n" +
        "> le premier\n>\n> le second\n" +
        "Traite sa consigne comme portant spécifiquement sur ces passages.",
    );
  });

  test("ONE passage is byte-for-byte the singular composition", () => {
    // The widening must not move the single-quote case: composedTurnBody feeds
    // freshTailCount and the context gauge.
    for (const locale of ["fr", "en"] as const) {
      expect(quotesPreamble(["seul"], undefined, locale)).toBe(
        quotePreamble("seul", undefined, locale),
      );
    }
  });

  test("an admin template stays THE wording at any count", () => {
    // An override IS the instance's chosen phrasing — it is filled with the
    // joined list, never silently swapped for our plural default.
    const config = { quote_reply: { template: "REPLYING TO: {excerpt}" } };
    expect(quotesPreamble(["a", "b"], config, "fr")).toBe(
      "REPLYING TO: a\n>\n> b",
    );
  });

  test("disabled keeps EVERY passage as a bare quote (none silently dropped)", () => {
    const p = quotesPreamble(
      ["a", "b", "c"],
      { quote_reply: { enabled: false } },
      "fr",
    );
    expect(p).toBe("> a\n>\n> b\n>\n> c");
  });

  test("no passage at all composes nothing", () => {
    expect(quotesPreamble([], undefined, "fr")).toBe("");
  });
});

describe("quotedRefsOf — one derivation, both vintages", () => {
  test("a row written BEFORE the widening still answers with its passage", () => {
    // The retro-compatibility that lets the widening ship without a backfill.
    expect(
      quotedRefsOf({
        quotedMessageId: "m1",
        quotedBlockIndex: 2,
        quotedExcerpt: "ancien",
      }),
    ).toEqual([{ messageId: "m1", blockIndex: 2, excerpt: "ancien" }]);
  });

  test("an old row with NO block index means the whole message", () => {
    expect(quotedRefsOf({ quotedExcerpt: "tout" })).toEqual([
      { blockIndex: null, excerpt: "tout" },
    ]);
  });

  test("a DEFINED array wins even when EMPTY (no resurrection)", () => {
    // A divergent row — an empty array beside a stale singular mirror, which an
    // untrusted archive can hand us — must read as "quotes nothing". Preferring
    // the array only when non-empty brings the old passage back to life.
    expect(
      quotedRefsOf({
        quotedRefs: [],
        quotedMessageId: "m1",
        quotedBlockIndex: 0,
        quotedExcerpt: "un fantôme",
      }),
    ).toEqual([]);
    expect(
      outboxExcerpts({ quotedExcerpts: [], quotedExcerpt: "un fantôme" }),
    ).toEqual([]);
    expect(
      hasQuotes({ quotedRefs: [], quotedExcerpt: "un fantôme" }),
    ).toBe(false);
  });

  test("a turn quoting nothing quotes nothing (both vintages)", () => {
    expect(quotedRefsOf({})).toEqual([]);
    expect(quotedRefsOf({ quotedRefs: [] })).toEqual([]);
    expect(hasQuotes({})).toBe(false);
  });

  test("an attachment-only MULTI-quote turn counts as content", () => {
    // The five eligibility predicates (stream + summaries) ask hasQuotes, not
    // `quotedExcerpt !== undefined` — which would answer NO here and drop the
    // turn out of the history it belongs to.
    expect(
      hasQuotes({
        quotedRefs: [
          { messageId: "m1", blockIndex: 0, excerpt: "a" },
          { messageId: "m2", blockIndex: 1, excerpt: "b" },
        ],
      }),
    ).toBe(true);
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
    expect(quotedRefsOf(msg!)).toEqual([
      { messageId: quotedId, blockIndex: 0, excerpt: "Voici le classement proposé." },
    ]);
    const outbox = await t.run((ctx) => ctx.db.get(res.outboxId));
    expect(outbox!.quotedExcerpts).toEqual(["Voici le classement proposé."]);
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
    expect(quotedRefsOf(msg!)).toEqual([
      { messageId: quotedId, blockIndex: null, excerpt: "tout le message" },
    ]);
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
    ).rejects.toThrow(/quote shape/);
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
    expect(quotedRefsOf(msg!)[0]!.excerpt.length).toBe(QUOTE_EXCERPT_CAP);
  });
});

describe("sendMessage — SEVERAL passages", () => {
  test("both passages are stored, both ride the outbox, text stays clean", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, quotedId } = await seedUserChat(t);
    const as = t.withIdentity({ subject: `${userId}|session` });
    const res = await as.mutation(api.send.sendMessage, {
      chatId,
      text: "Corrige ces deux points",
      clientMessageId: "mq1",
      quotes: [
        { messageId: quotedId, blockIndex: 0, excerpt: "Voici le classement." },
        { messageId: quotedId, blockIndex: 1, excerpt: "Et voici la suite." },
      ],
    });
    const msg = await t.run((ctx) => ctx.db.get(res.messageId as Id<"messages">));
    expect(msg!.text).toBe("Corrige ces deux points"); // clean
    expect(quotedRefsOf(msg!)).toEqual([
      { messageId: quotedId, blockIndex: 0, excerpt: "Voici le classement." },
      { messageId: quotedId, blockIndex: 1, excerpt: "Et voici la suite." },
    ]);
    const outbox = await t.run((ctx) => ctx.db.get(res.outboxId));
    // BOTH on the outbox: the dispatch (and any redo) composes from this row,
    // so a single excerpt here would silently send one passage out of two.
    expect(outboxExcerpts(outbox!)).toEqual([
      "Voici le classement.",
      "Et voici la suite.",
    ]);
  });

  test("a row is written in BOTH vintages, so a ROLLBACK still shows a quote", async () => {
    // The array is the truth; the singular fields mirror the first passage.
    // Storing only the array is fine until the deploy is rolled back: the
    // previous revision reads only the singular fields, so every quote written
    // in between would vanish from the thread, the summaries and the forks —
    // and a still-parked outbox row would dispatch with NO preamble, sending
    // "corrige ceci" with nothing bound to "ceci".
    const t = convexTest(schema, modules);
    const { userId, chatId, quotedId } = await seedUserChat(t);
    const res = await t
      .withIdentity({ subject: `${userId}|session` })
      .mutation(api.send.sendMessage, {
        chatId,
        text: "x",
        clientMessageId: "mq2",
        quotes: [
          { messageId: quotedId, blockIndex: 0, excerpt: "un" },
          { messageId: quotedId, blockIndex: 1, excerpt: "deux" },
        ],
      });
    const msg = await t.run((ctx) => ctx.db.get(res.messageId as Id<"messages">));
    expect(quotedRefsOf(msg!).map((q) => q.excerpt)).toEqual(["un", "deux"]);
    expect(msg!.quotedExcerpt).toBe("un");
    expect(msg!.quotedMessageId).toBe(quotedId);
    expect(msg!.quotedBlockIndex).toBe(0);
    // The outbox too — that one is a pending DISPATCH.
    const outbox = await t.run((ctx) => ctx.db.get(res.outboxId));
    expect(outboxExcerpts(outbox!)).toEqual(["un", "deux"]);
    expect(outbox!.quotedExcerpt).toBe("un");
  });

  test("the array WINS while both are present (no arbitration)", () => {
    // Both vintages on one row must never compete: the derivation prefers the
    // array, so the mirror is inert rather than a second answer.
    expect(
      quotedRefsOf({
        quotedRefs: [
          { messageId: "m1", blockIndex: 0, excerpt: "un" },
          { messageId: "m1", blockIndex: 1, excerpt: "deux" },
        ],
        quotedMessageId: "m1",
        quotedBlockIndex: 0,
        quotedExcerpt: "un",
      }).map((q) => q.excerpt),
    ).toEqual(["un", "deux"]);
    expect(
      outboxExcerpts({ quotedExcerpts: ["un", "deux"], quotedExcerpt: "un" }),
    ).toEqual(["un", "deux"]);
  });

  test("the same block twice is ONE passage (idempotent double click)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, quotedId } = await seedUserChat(t);
    const res = await t
      .withIdentity({ subject: `${userId}|session` })
      .mutation(api.send.sendMessage, {
        chatId,
        text: "x",
        clientMessageId: "mq3",
        quotes: [
          { messageId: quotedId, blockIndex: 0, excerpt: "un" },
          { messageId: quotedId, blockIndex: 0, excerpt: "un" },
        ],
      });
    const msg = await t.run((ctx) => ctx.db.get(res.messageId as Id<"messages">));
    expect(quotedRefsOf(msg!)).toHaveLength(1);
  });

  test("EVERY stale target is named at once, not one per attempt", async () => {
    // Stopping at the first would make the composer drop one chip per failed
    // send: a selection of ten stale anchors would need ten attempts to clear.
    const t = convexTest(schema, modules);
    const { userId, chatId, quotedId } = await seedUserChat(t);
    const [goneA, goneB] = await t.run(async (ctx) => {
      const ids: Id<"messages">[] = [];
      for (const text of ["a", "b"]) {
        const id = await ctx.db.insert("messages", {
          chatId,
          userId,
          role: "assistant" as const,
          status: "complete" as const,
          text,
          updatedAt: 1,
        });
        await ctx.db.delete(id);
        ids.push(id);
      }
      return ids;
    });
    const failure = await t
      .withIdentity({ subject: `${userId}|session` })
      .mutation(api.send.sendMessage, {
        chatId,
        text: "x",
        clientMessageId: "mq8",
        quotes: [
          { messageId: quotedId, blockIndex: 0, excerpt: "vivante" },
          { messageId: goneA!, blockIndex: 0, excerpt: "morte a" },
          { messageId: goneB!, blockIndex: 0, excerpt: "morte b" },
        ],
      })
      .then(
        () => null,
        (e: unknown) => (e as Error).message,
      );
    expect(failure).toContain(`gone [${goneA}]`);
    expect(failure).toContain(`gone [${goneB}]`);
  });

  test("an excerpt is capped on CODE POINTS, never mid-character", async () => {
    // `slice` counts UTF-16 units: cutting between a surrogate pair leaves a
    // lone surrogate, which is not valid Unicode — the write itself then fails,
    // on an excerpt that was perfectly valid on the way in.
    const t = convexTest(schema, modules);
    const { userId, chatId, quotedId } = await seedUserChat(t);
    const res = await t
      .withIdentity({ subject: `${userId}|session` })
      .mutation(api.send.sendMessage, {
        chatId,
        text: "x",
        clientMessageId: "mq9",
        quotes: [
          {
            messageId: quotedId,
            blockIndex: 0,
            // The cap lands exactly ON the emoji.
            excerpt: "y".repeat(QUOTE_EXCERPT_CAP - 1) + "😀" + "z".repeat(20),
          },
        ],
      });
    const msg = await t.run((ctx) => ctx.db.get(res.messageId as Id<"messages">));
    const excerpt = quotedRefsOf(msg!)[0]!.excerpt;
    expect(Array.from(excerpt)).toHaveLength(QUOTE_EXCERPT_CAP);
    expect(excerpt.endsWith("😀")).toBe(true);
    // No lone surrogate survived.
    expect(excerpt).toBe(
      Buffer.from(excerpt, "utf8").toString("utf8"),
    );
  });

  test("the COUNT is bounded", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, quotedId } = await seedUserChat(t);
    await expect(
      t.withIdentity({ subject: `${userId}|session` }).mutation(
        api.send.sendMessage,
        {
          chatId,
          text: "x",
          clientMessageId: "mq4",
          quotes: Array.from({ length: QUOTE_MAX_PER_TURN + 1 }, (_, i) => ({
            messageId: quotedId,
            blockIndex: i,
            excerpt: `e${i}`,
          })),
        },
      ),
    ).rejects.toThrow(/too many quotes/);
  });

  test("the TOTAL excerpt budget is bounded (what keeps a prompt survivable)", async () => {
    // Per-excerpt capping alone lets ten maximal passages add 5 000 characters
    // to every turn — straight into a context_length failure.
    const t = convexTest(schema, modules);
    const { userId, chatId, quotedId } = await seedUserChat(t);
    await expect(
      t.withIdentity({ subject: `${userId}|session` }).mutation(
        api.send.sendMessage,
        {
          chatId,
          text: "x",
          clientMessageId: "mq5",
          quotes: Array.from({ length: 5 }, (_, i) => ({
            messageId: quotedId,
            blockIndex: i,
            excerpt: "y".repeat(QUOTE_EXCERPT_CAP),
          })),
        },
      ),
    ).rejects.toThrow(/budget/);
  });

  test("a DELETED target is NAMED in the refusal (so only it is dropped)", async () => {
    // The turn is still refused atomically — sending fewer passages than the
    // user picked would answer a question they did not ask — but the composer
    // needs to know WHICH anchor went stale, or a single regenerated reply
    // costs the user the whole selection they assembled.
    const t = convexTest(schema, modules);
    const { userId, chatId, quotedId } = await seedUserChat(t);
    const goneId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "sera supprimé",
        updatedAt: 1,
      });
      await ctx.db.delete(id);
      return id;
    });
    await expect(
      t.withIdentity({ subject: `${userId}|session` }).mutation(
        api.send.sendMessage,
        {
          chatId,
          text: "x",
          clientMessageId: "mq7",
          quotes: [
            { messageId: quotedId, blockIndex: 0, excerpt: "vivante" },
            { messageId: goneId, blockIndex: 0, excerpt: "disparue" },
          ],
        },
      ),
    ).rejects.toThrow(new RegExp(`quote target gone \\[${goneId}\\]`));
  });

  test("ONE bad passage refuses the WHOLE turn (no partial quoting)", async () => {
    // Sending a turn that quotes two passages but carries one would answer a
    // question the user did not ask.
    const t = convexTest(schema, modules);
    const { userId, chatId, quotedId } = await seedUserChat(t);
    const otherChatQuoted = await t.run(async (ctx) => {
      const otherChat = await ctx.db.insert("chats", {
        userId,
        updatedAt: 1,
        instanceName: "prod",
        agentId: "main",
      });
      return ctx.db.insert("messages", {
        chatId: otherChat,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "ailleurs",
        updatedAt: 1,
      });
    });
    await expect(
      t.withIdentity({ subject: `${userId}|session` }).mutation(
        api.send.sendMessage,
        {
          chatId,
          text: "x",
          clientMessageId: "mq6",
          quotes: [
            { messageId: quotedId, blockIndex: 0, excerpt: "légitime" },
            { messageId: otherChatQuoted, blockIndex: 0, excerpt: "volé" },
          ],
        },
      ),
    ).rejects.toThrow(/not in this chat/);
  });
});

describe("the deployment window", () => {
  test("the thread row still carries the SINGULAR fields an old bundle reads", async () => {
    // A tab running the previous bundle reads only quotedMessageId /
    // quotedBlockIndex / quotedExcerpt. Serving the array alone makes every
    // quote header vanish from it — including on rows it had just written.
    const t = convexTest(schema, modules);
    const { userId, chatId, quotedId } = await seedUserChat(t);
    const as = t.withIdentity({ subject: `${userId}|session` });
    await as.mutation(api.send.sendMessage, {
      chatId,
      text: "corrige",
      clientMessageId: "dw1",
      quotes: [
        { messageId: quotedId, blockIndex: 0, excerpt: "le premier" },
        { messageId: quotedId, blockIndex: 1, excerpt: "le second" },
      ],
    });
    const view = await as.query(api.messages.listByChat, { chatId });
    const row = view.find((r) => r.text === "corrige")!;
    // The array is the truth...
    expect(row.quotedRefs?.map((r) => r.excerpt)).toEqual([
      "le premier",
      "le second",
    ]);
    // ...and the old bundle still sees the first passage rather than nothing.
    expect(row.quotedExcerpt).toBe("le premier");
    expect(row.quotedMessageId).toBe(quotedId);
    expect(row.quotedBlockIndex).toBe(0);
  });
});

describe("SEVERAL passages survive the round trip", () => {
  test("the rebuilt history carries EVERY passage", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, quotedId } = await seedUserChat(t);
    const { currentId } = await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "user" as const,
        status: "complete" as const,
        text: "", // attachment-only: the quotes ARE its content
        quotedRefs: [
          { messageId: quotedId, blockIndex: 0, excerpt: "le premier" },
          { messageId: quotedId, blockIndex: 1, excerpt: "le second" },
        ],
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
    expect(r.history).toContain("> le premier");
    expect(r.history).toContain("> le second");
    // And in the PLURAL framing, not the singular one repeated.
    expect(r.history).toContain("ces passages précis");
  });

  test("a redo re-carries EVERY passage, not just the first", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, quotedId } = await seedUserChat(t);
    const { assistantId } = await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "user" as const,
        status: "complete" as const,
        text: "Corrige ces deux points",
        quotedRefs: [
          { messageId: quotedId, blockIndex: 0, excerpt: "le premier" },
          { messageId: quotedId, blockIndex: 1, excerpt: "le second" },
        ],
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
    expect(outboxExcerpts(outbox!)).toEqual(["le premier", "le second"]);
  });

  test("a fork REMAPS every anchor, and keeps an unmappable one anchor-less", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId, quotedId } = await seedUserChat(t);
    const orphan = await t.run(async (ctx) => {
      // An anchor that will NOT be copied (it lives in another chat), so the
      // fork must keep the passage while dropping the link — never point it at
      // whatever that identifier names.
      const otherChat = await ctx.db.insert("chats", {
        userId,
        updatedAt: 1,
        instanceName: "prod",
        agentId: "main",
      });
      return ctx.db.insert("messages", {
        chatId: otherChat,
        userId,
        role: "assistant" as const,
        status: "complete" as const,
        text: "ailleurs",
        updatedAt: 1,
      });
    });
    const { tailId } = await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "user" as const,
        status: "complete" as const,
        text: "Corrige",
        quotedRefs: [
          { messageId: quotedId, blockIndex: 0, excerpt: "le premier" },
          { messageId: orphan, blockIndex: 1, excerpt: "l'orphelin" },
        ],
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
    const refs = quotedRefsOf(forkMsgs.find((mm) => hasQuotes(mm))!);
    expect(refs.map((r) => r.excerpt)).toEqual(["le premier", "l'orphelin"]);
    expect(refs[0]!.messageId).toBeDefined();
    expect(refs[0]!.messageId).not.toBe(quotedId);
    expect(refs[1]!.messageId).toBeUndefined();
  });
});

describe("reconstruction paths re-carry the quote (codex review)", () => {
  test("deleteMessage-regenerate outbox carries the quote (OLD-vintage row)", async () => {
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
    expect(outboxExcerpts(outbox!)).toEqual(["Voici le classement proposé."]);
  });

  test("forkChat copies the quotes and REMAPS each anchor (OLD-vintage row)", async () => {
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
    const quoting = forkMsgs.find((m2) => hasQuotes(m2));
    const refs = quotedRefsOf(quoting!);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.excerpt).toBe("Voici le classement proposé.");
    expect(refs[0]!.blockIndex).toBe(0);
    // The anchor points at the COPY, not the source message.
    expect(refs[0]!.messageId).toBeDefined();
    expect(refs[0]!.messageId).not.toBe(quotedId);
    const target = forkMsgs.find((m2) => m2._id === refs[0]!.messageId);
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

  test("renderTurn sizes on EVERY passage (the gauge reads this)", async () => {
    // composedTurnBody feeds freshTailCount and the context gauge. A body built
    // from the first passage only under-counts a multi-quote turn, so the tail
    // is sized on a prompt shorter than the one actually sent.
    const t = convexTest(schema, modules);
    const { userId, chatId, quotedId } = await seedUserChat(t);
    const doc = await t.run(async (ctx) => {
      const id = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "user" as const,
        status: "complete" as const,
        text: "Corrige ces deux points",
        quotedRefs: [
          { messageId: quotedId, blockIndex: 0, excerpt: "le premier" },
          { messageId: quotedId, blockIndex: 1, excerpt: "le second" },
        ],
        updatedAt: 2,
      });
      return (await ctx.db.get(id))!;
    });
    const line = renderTurn(
      doc,
      { byMsg: new Map(), unsettled: new Set<string>() },
      "fr",
      undefined,
    );
    expect(line).toContain("> le premier");
    expect(line).toContain("> le second");
    expect(line).toContain("ces passages précis");
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
