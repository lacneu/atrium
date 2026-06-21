/// <reference types="vite/client" />
//
// Tests for the global conversation search (search.searchConversations) + its
// pure helpers (lib/search). The FIRST test is a deliberate smoke check that
// convex-test's in-memory engine honors `withSearchIndex` at all — if the
// harness did not index, every search test would silently pass on empty results
// and prove nothing. The access-scoping test (user B's content must NOT surface
// for user A) is the load-bearing one.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { buildSnippet, queryTerms, titleMatches } from "./lib/search";

const modules = import.meta.glob("./**/*.ts");

/** Seed an ACTIVE user (role "user") and return an identity-bound client. */
async function seedUser(t: ReturnType<typeof convexTest>) {
  const userId = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user" });
    return userId;
  });
  return { userId, as: t.withIdentity({ subject: `${userId}|session` }) };
}

/** Insert a chat + a single message for a user. Returns the chatId. */
async function seedChat(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  opts: { title?: string; text: string; archived?: boolean },
): Promise<Id<"chats">> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const chatId = await ctx.db.insert("chats", {
      userId,
      title: opts.title,
      archived: opts.archived ?? false,
      updatedAt: now,
    });
    await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "user",
      status: "complete",
      text: opts.text,
      updatedAt: now,
    });
    return chatId;
  });
}

describe("search.searchConversations — full-text over messages", () => {
  test("SMOKE: withSearchIndex returns a hit for the caller's own message", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await seedUser(t);
    const chatId = await seedChat(t, userId, {
      title: "Notes",
      text: "The migration to Convex went smoothly today",
    });

    const hits = await as.query(api.search.searchConversations, {
      query: "migration",
    });
    // If this is empty, convex-test did not honor the search index — the rest of
    // the suite would be vacuous. (Helper unit tests below still hold.)
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].chatId).toBe(chatId);
    expect(hits[0].matchedIn).toBe("message");
    expect(hits[0].snippet.toLowerCase()).toContain("migration");
  });

  test("HIDDEN: a documentary chat never surfaces (title OR message)", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await seedUser(t);
    // A normal chat (control) AND a hidden documentary chat, both matching "rapport"
    // by title AND message — so without the filter BOTH search paths return it.
    const normal = await seedChat(t, userId, {
      title: "Rapport visible",
      text: "le rapport annuel",
    });
    const hidden = await t.run(async (ctx) => {
      const now = Date.now();
      const hidden = await ctx.db.insert("chats", {
        userId,
        title: "Documents rapport",
        kind: "documentary" as const,
        archived: false,
        updatedAt: now,
      });
      await ctx.db.insert("messages", {
        chatId: hidden,
        userId,
        role: "user" as const,
        status: "complete" as const,
        text: "fournis le rapport source",
        updatedAt: now,
      });
      return hidden;
    });
    const hits = await as.query(api.search.searchConversations, {
      query: "rapport",
    });
    const ids = hits.map((h) => h.chatId);
    expect(ids).toContain(normal); // the real chat is found...
    // Regression guard: the hidden L2 fetch chat must NEVER surface in search.
    expect(ids).not.toContain(hidden);
  });

  test("ACCESS: another user's message never surfaces for the caller", async () => {
    const t = convexTest(schema, modules);
    const a = await seedUser(t);
    const b = await seedUser(t);
    await seedChat(t, a.userId, { title: "A topic", text: "alpha keyword apple" });
    await seedChat(t, b.userId, { title: "B topic", text: "alpha keyword apple" });

    const hitsForA = await a.as.query(api.search.searchConversations, {
      query: "keyword",
    });
    // A sees exactly one hit (their own); B's identical message is excluded.
    expect(hitsForA.length).toBe(1);
    expect(hitsForA.every((h) => h.title === "A topic")).toBe(true);
  });

  test("title match surfaces a chat with no message body hit", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await seedUser(t);
    await seedChat(t, userId, {
      title: "Quarterly budget review",
      text: "unrelated body content",
    });

    const hits = await as.query(api.search.searchConversations, {
      query: "budget",
    });
    expect(hits.length).toBe(1);
    expect(hits[0].matchedIn).toBe("title");
    expect(hits[0].title).toBe("Quarterly budget review");
  });

  test("archived chats are excluded from results", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await seedUser(t);
    await seedChat(t, userId, {
      title: "Archived",
      text: "zephyr unique token",
      archived: true,
    });

    const hits = await as.query(api.search.searchConversations, {
      query: "zephyr",
    });
    expect(hits.length).toBe(0);
  });

  test("a sub-threshold query is a no-op", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await seedUser(t);
    await seedChat(t, userId, { title: "x", text: "a tiny message" });

    const hits = await as.query(api.search.searchConversations, { query: "a" });
    expect(hits).toEqual([]);
  });

  test("one row per chat — multiple matching messages collapse", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await seedUser(t);
    const chatId = await t.run(async (ctx) => {
      const now = Date.now();
      const chatId = await ctx.db.insert("chats", {
        userId,
        title: "Dense",
        archived: false,
        updatedAt: now,
      });
      for (let i = 0; i < 3; i++) {
        await ctx.db.insert("messages", {
          chatId,
          userId,
          role: "user",
          status: "complete",
          text: `recurring needle term occurrence ${i}`,
          updatedAt: now + i,
        });
      }
      return chatId;
    });

    const hits = await as.query(api.search.searchConversations, {
      query: "needle",
    });
    const forChat = hits.filter((h) => h.chatId === chatId);
    expect(forChat.length).toBe(1);
  });
});

describe("lib/search — pure helpers", () => {
  test("queryTerms lowercases and splits on whitespace", () => {
    expect(queryTerms("  Hello   World ")).toEqual(["hello", "world"]);
    expect(queryTerms("")).toEqual([]);
  });

  test("buildSnippet centers on the first matching term with ellipses", () => {
    // The match must sit beyond SNIPPET_RADIUS (90) from both edges so the
    // snippet is truncated on BOTH sides.
    const lead = "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(
      3,
    );
    const tail = " and the sentence keeps going well past the snippet radius ".repeat(
      3,
    );
    const text = `${lead}the NEEDLE is buried here${tail}`;
    const snip = buildSnippet(text, ["needle"]);
    expect(snip.toLowerCase()).toContain("needle");
    expect(snip.startsWith("…")).toBe(true);
    expect(snip.endsWith("…")).toBe(true);
  });

  test("buildSnippet falls back to a leading slice when no term is present", () => {
    const text = "short text without the searched token";
    const snip = buildSnippet(text, ["absent"]);
    expect(snip).toBe(text);
  });

  test("titleMatches requires every term (AND), case-insensitive", () => {
    expect(titleMatches("Quarterly Budget Review", ["budget"])).toBe(true);
    expect(titleMatches("Quarterly Budget Review", ["budget", "review"])).toBe(
      true,
    );
    expect(titleMatches("Quarterly Budget Review", ["budget", "xyz"])).toBe(
      false,
    );
    expect(titleMatches(undefined, ["budget"])).toBe(false);
    expect(titleMatches("anything", [])).toBe(false);
  });
});
