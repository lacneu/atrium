/// <reference types="vite/client" />
//
// Unit tests for internal.stream.rehydrationContext — the pure logic that builds
// the bounded prior-conversation block the bridge prepends to chat.send when it
// detects a fresh/rolled OpenClaw session (docs/SESSION_CONTINUITY_DESIGN.md §6).
// This is the SOURCE OF TRUTH for "what the user sees" being re-grounded into the
// model, so its filtering/exclusion/budget logic must be exact. Version-agnostic:
// pure Convex; the version-sensitive half (sessions.describe.systemSent detection
// + the prepend) is covered by the live decision-acceptance on each OpenClaw version.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { QUEUED_ORDER_SENTINEL } from "./lib/messageOrder";

const modules = import.meta.glob("./**/*.ts");

type MsgRole = "user" | "assistant" | "system";
type MsgStatus = "streaming" | "complete" | "error" | "aborted";

/** Seed a chat + ordered messages (insertion order == chronological). */
async function seedChat(
  t: ReturnType<typeof convexTest>,
  msgs: Array<{ role: MsgRole; status?: MsgStatus; text: string }>,
  opts?: { contextTokens?: number },
): Promise<{ chatId: Id<"chats">; messageIds: Id<"messages">[] }> {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const now = Date.now();
    const chatId = await ctx.db.insert("chats", {
      userId,
      archived: false,
      updatedAt: now,
      ...(opts?.contextTokens
        ? { sessionMeta: { contextTokens: opts.contextTokens } }
        : {}),
    });
    const messageIds: Id<"messages">[] = [];
    for (const m of msgs) {
      const id = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: m.role,
        status: m.status ?? "complete",
        text: m.text,
        updatedAt: now,
      });
      messageIds.push(id);
    }
    return { chatId, messageIds };
  });
}

function run(t: ReturnType<typeof convexTest>, chatId: Id<"chats">, excludeMessageId?: Id<"messages">) {
  return t.query(internal.stream.rehydrationContext, { chatId, excludeMessageId });
}

describe("stream.rehydrationContext", () => {
  test("empty chat -> null history, 0 turns", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seedChat(t, []);
    const r = await run(t, chatId);
    expect(r).toEqual({ history: null, turnCount: 0 });
  });

  test("formats user/assistant turns chronologically with header + footer", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seedChat(t, [
      { role: "user", text: "Première question" },
      { role: "assistant", text: "Première réponse" },
      { role: "user", text: "Deuxième question" },
    ]);
    const r = await run(t, chatId);
    expect(r.turnCount).toBe(3);
    expect(r.history).toContain("Utilisateur : Première question");
    expect(r.history).toContain("Assistant : Première réponse");
    expect(r.history).toContain("Utilisateur : Deuxième question");
    // chronological order (oldest first)
    const iFirst = r.history!.indexOf("Première question");
    const iSecond = r.history!.indexOf("Deuxième question");
    expect(iFirst).toBeGreaterThanOrEqual(0);
    expect(iFirst).toBeLessThan(iSecond);
    // header + footer present, no truncation notice for a tiny conversation
    expect(r.history).toContain("Reprise");
    expect(r.history).toContain("Fin de l’historique");
    expect(r.history).not.toContain("début de la conversation");
  });

  test("excludes the current turn's message (excludeMessageId)", async () => {
    const t = convexTest(schema, modules);
    const { chatId, messageIds } = await seedChat(t, [
      { role: "user", text: "Vieux message" },
      { role: "assistant", text: "Vieille réponse" },
      { role: "user", text: "MESSAGE COURANT" },
    ]);
    const current = messageIds[2];
    const r = await run(t, chatId, current);
    expect(r.turnCount).toBe(2);
    expect(r.history).toContain("Vieux message");
    expect(r.history).not.toContain("MESSAGE COURANT");
  });

  test("orderTime (#A): keeps the prior assistant + excludes a still-queued follow-up", async () => {
    const t = convexTest(schema, modules);
    // The OUTCOME of the queue flow: USER2 was queued in USER1's pre-ack window, so it
    // was inserted BEFORE ASSISTANT1 (USER2._ct < ASSISTANT1._ct) — but it was DRAINED,
    // so its orderTime is AFTER ASSISTANT1. USER3 is a later, STILL-queued follow-up.
    const { chatId, messageIds } = await seedChat(t, [
      { role: "user", text: "USER1" },
      { role: "user", text: "USER2" }, // queued during USER1's pre-ack (early _ct)
      { role: "assistant", text: "ASSISTANT1" }, // USER1's reply, created later
      { role: "user", text: "USER3" }, // a later, still-parked follow-up
    ]);
    await t.run(async (ctx) => {
      const a1 = (await ctx.db.get(messageIds[2]))!;
      await ctx.db.patch(messageIds[1], { orderTime: a1._creationTime + 1 }); // USER2 drained AFTER ASSISTANT1
      await ctx.db.patch(messageIds[3], { orderTime: QUEUED_ORDER_SENTINEL }); // USER3 still queued
    });
    const r = await run(t, chatId, messageIds[1]); // rehydrate USER2's turn
    expect(r.history).toContain("USER1");
    expect(r.history).toContain("ASSISTANT1"); // round-11 guard: prior assistant KEPT
    expect(r.history).not.toContain("USER2"); // the current turn (excluded by id)
    expect(r.history).not.toContain("USER3"); // round-9 guard: future follow-up EXCLUDED
    expect(r.history!.indexOf("USER1")).toBeLessThan(
      r.history!.indexOf("ASSISTANT1"),
    );
    expect(r.turnCount).toBe(2);
  });

  test("skips streaming/incomplete and empty rows", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seedChat(t, [
      { role: "user", text: "Garde-moi" },
      { role: "assistant", status: "streaming", text: "réponse en cours…" },
      { role: "user", status: "error", text: "tour en erreur" },
      { role: "assistant", text: "   " }, // whitespace-only
    ]);
    const r = await run(t, chatId);
    expect(r.turnCount).toBe(1);
    expect(r.history).toContain("Garde-moi");
    expect(r.history).not.toContain("réponse en cours");
    expect(r.history).not.toContain("tour en erreur");
  });

  test("ignores system rows (only user/assistant are re-injected)", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seedChat(t, [
      { role: "system", text: "evenement systeme" },
      { role: "user", text: "vrai message" },
    ]);
    const r = await run(t, chatId);
    expect(r.turnCount).toBe(1);
    expect(r.history).not.toContain("evenement systeme");
  });

  test("budget truncation keeps the MOST RECENT turns + notes omission", async () => {
    const t = convexTest(schema, modules);
    // Tiny window so the budget (window*0.5*3 chars, floored at 2000) truncates.
    // 2000 char budget; each line ~520 chars -> only the most recent few fit.
    const big = (n: number) => `Tour numero ${n} ` + "x".repeat(500);
    const msgs = Array.from({ length: 12 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as MsgRole,
      text: big(i),
    }));
    const { chatId } = await seedChat(t, msgs, { contextTokens: 1000 });
    const r = await run(t, chatId);
    expect(r.history).toContain("début de la conversation"); // omission notice
    expect(r.turnCount).toBeLessThan(12); // older turns dropped
    expect(r.turnCount).toBeGreaterThan(0);
    // most-recent turn (11) kept; an early one (0) dropped
    expect(r.history).toContain("Tour numero 11");
    expect(r.history).not.toContain("Tour numero 0 ");
  });
});

describe("listByChat logical order (#A)", () => {
  test("a drained queued follow-up renders AFTER the in-flight turn's assistant", async () => {
    const t = convexTest(schema, modules);
    const { chatId, userId, u1, u2, a1 } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId,
        role: "user" as const,
        canonical: "u",
      });
      const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1 });
      const mk = (role: MsgRole, text: string) =>
        ctx.db.insert("messages", {
          chatId,
          userId,
          role,
          status: "complete" as const,
          text,
          updatedAt: 1,
        });
      const u1 = await mk("user", "USER1");
      const u2 = await mk("user", "USER2"); // queued in the pre-ack window (early _ct)
      const a1 = await mk("assistant", "ASSISTANT1"); // USER1's reply, created later
      const a1Row = (await ctx.db.get(a1))!;
      // USER2 was DRAINED → orderTime stamped AFTER ASSISTANT1's creation.
      await ctx.db.patch(u2, { orderTime: a1Row._creationTime + 1 });
      return { chatId, userId, u1, u2, a1 };
    });
    const rows = await t
      .withIdentity({ subject: `${userId}|session` })
      .query(api.messages.listByChat, { chatId });
    // Logical order: USER1, ASSISTANT1, USER2 — NOT USER1, USER2, ASSISTANT1 (raw _ct).
    expect(rows.map((r) => r._id)).toEqual([u1, a1, u2]);
  });
});
