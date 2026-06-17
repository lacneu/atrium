/// <reference types="vite/client" />
//
// Provenance parts — payload discipline (Codex review P2) + on-demand detail.
// The REACTIVE listByChat must ship the COMPACT projection (item texts
// stripped, hasExcerpts flag) so the window-wide stream never carries
// megabytes of excerpts; messages.getProvenanceParts returns the FULL reports
// for ONE message, owner-gated.

import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

/** Seed an active user (same idiom as compat.test.ts). */
async function seedUser(t: TestConvex<typeof schema>, canonical: string) {
  const userId = await t.run(async (ctx) => {
    const uid = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId: uid, role: "user", canonical });
    return uid;
  });
  return { userId, as: t.withIdentity({ subject: `${userId}|session` }) };
}

const FULL_PART = {
  kind: "provenance" as const,
  v: 1,
  pluginId: "provenance-probe",
  source: "hindsight",
  group: "memory" as const,
  injected: { chars: 420, position: "system_prepend" },
  retrieval: { route: "ALL", bank: "bench::probe::user" },
  items: [
    {
      id: "mem_1",
      type: "observation",
      date: "2026-06-01",
      score: 0.91,
      text: "secret excerpt that must NOT ride the reactive stream",
    },
    { id: "mem_2", type: "world", score: 0.84 }, // metadata-level item (no text)
  ],
};

/** Seed owner + chat + assistant message carrying one full provenance part. */
async function seedMessageWithProvenance(t: TestConvex<typeof schema>) {
  const owner = await seedUser(t, "alice");
  const { chatId, messageId } = await t.run(async (ctx) => {
    const chatId = await ctx.db.insert("chats", {
      userId: owner.userId,
      updatedAt: Date.now(),
    });
    const messageId = await ctx.db.insert("messages", {
      chatId,
      userId: owner.userId,
      role: "assistant",
      status: "complete",
      text: "the reply",
      updatedAt: Date.now(),
    });
    await ctx.db.insert("messageParts", {
      messageId,
      order: 0,
      part: FULL_PART,
    });
    return { chatId, messageId };
  });
  return { owner, chatId, messageId };
}

describe("listByChat — compact provenance projection (Codex P2)", () => {
  test("item texts are STRIPPED from the reactive stream; hasExcerpts flags the detail", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await seedMessageWithProvenance(t);
    const rows = await owner.as.query(api.messages.listByChat, {
      chatId: chatId as string,
    });
    expect(rows).toHaveLength(1);
    const part = rows[0].parts.find((p) => p.kind === "provenance");
    expect(part).toBeDefined();
    const prov = part as Extract<typeof part, { kind: "provenance" }> & {
      hasExcerpts?: boolean;
    };
    // Compact: NO text anywhere, metadata intact, flag set.
    expect(prov.items).toEqual([
      { id: "mem_1", type: "observation", date: "2026-06-01", score: 0.91 },
      { id: "mem_2", type: "world", score: 0.84 },
    ]);
    expect(prov.hasExcerpts).toBe(true);
    expect(JSON.stringify(prov)).not.toContain("secret excerpt");
    expect(prov.retrieval).toEqual({ route: "ALL", bank: "bench::probe::user" });
  });

  test("a metadata-only report carries NO hasExcerpts flag (nothing to fetch)", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "alice");
    const chatId = await t.run(async (ctx) => {
      const chatId = await ctx.db.insert("chats", {
        userId: owner.userId,
        updatedAt: Date.now(),
      });
      const messageId = await ctx.db.insert("messages", {
        chatId,
        userId: owner.userId,
        role: "assistant",
        status: "complete",
        text: "x",
        updatedAt: Date.now(),
      });
      await ctx.db.insert("messageParts", {
        messageId,
        order: 0,
        part: {
          ...FULL_PART,
          items: [{ id: "mem_1", type: "observation", score: 0.9 }],
        },
      });
      return chatId;
    });
    const rows = await owner.as.query(api.messages.listByChat, {
      chatId: chatId as string,
    });
    const prov = rows[0].parts.find((p) => p.kind === "provenance") as {
      hasExcerpts?: boolean;
    };
    expect(prov.hasExcerpts).toBeUndefined();
  });
});

describe("getProvenanceParts — bounded on-demand detail", () => {
  test("owner gets the FULL reports (excerpts included), in part order", async () => {
    const t = convexTest(schema, modules);
    const { owner, messageId } = await seedMessageWithProvenance(t);
    const parts = await owner.as.query(api.messages.getProvenanceParts, {
      messageId: messageId as Id<"messages">,
    });
    expect(parts).toHaveLength(1);
    expect(parts[0].items[0].text).toBe(
      "secret excerpt that must NOT ride the reactive stream",
    );
  });

  test("a NON-owner is rejected; a deleted message returns []", async () => {
    const t = convexTest(schema, modules);
    const { messageId } = await seedMessageWithProvenance(t);
    const intruder = await seedUser(t, "bob");
    await expect(
      intruder.as.query(api.messages.getProvenanceParts, {
        messageId: messageId as Id<"messages">,
      }),
      // Read-only query (no side effect to negate) -> a specific matcher is the
      // sole guard: pin the IDOR gate so an unrelated earlier throw can't mask it.
    ).rejects.toThrow(/not owned/i);

    const { owner: owner2, messageId: gone } = await seedMessageWithProvenance(t);
    await t.run((ctx) => ctx.db.delete(gone as Id<"messages">));
    await expect(
      owner2.as.query(api.messages.getProvenanceParts, {
        messageId: gone as Id<"messages">,
      }),
    ).resolves.toEqual([]);
  });
});
