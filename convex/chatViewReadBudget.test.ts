/// <reference types="vite/client" />
//
// THE CHAT VIEW IS BOUNDED IN BYTES (0.103.4). A long conversation of heavy turns read
// past Convex's 16 MiB per-function read limit and `listByChat` THREW: the conversation no
// longer opened ("Too many bytes read in a single function execution", prod). convex-test
// does not enforce that limit, so these tests pin the BUDGET LOGIC itself: the window stops
// before CHAT_VIEW_READ_BUDGET_BYTES with the newest messages whole, says it is truncated,
// never throws on a single message heavier than the budget — and a normal conversation
// reads exactly as it did.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { CHAT_VIEW_READ_BUDGET_BYTES, DISPLAY_REPORT_READ_BUDGET_BYTES, MESSAGE_WINDOW, displayReport } from "./messages";

const modules = import.meta.glob("./**/*.ts");

/** One heavy tool output: well under Convex's 1 MiB document cap. */
const HEAVY_BYTES = 700 * 1024;
const heavy = (tag: string) => tag + "x".repeat(HEAVY_BYTES);

const newTest = () => convexTest(schema, modules);
type T = ReturnType<typeof newTest>;

async function seedUser(t: T) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "u" });
    const chatId = await ctx.db.insert("chats", { userId, updatedAt: 0 });
    return { userId, chatId };
  });
}

/** `n` assistant turns in creation order, each carrying `partsPerTurn` heavy tool parts. */
async function seedTurns(
  t: T,
  chatId: Id<"chats">,
  userId: Id<"users">,
  n: number,
  partsPerTurn: number,
): Promise<Id<"messages">[]> {
  const ids: Id<"messages">[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(
      await t.run(async (ctx) => {
        const mid = await ctx.db.insert("messages", {
          chatId,
          userId,
          role: "assistant" as const,
          status: "complete" as const,
          text: `turn ${i}`,
          updatedAt: i,
        });
        for (let p = 0; p < partsPerTurn; p++) {
          await ctx.db.insert("messageParts", {
            messageId: mid,
            order: p,
            part: { kind: "tool" as const, name: "web_fetch", phase: "completed", output: heavy(`o${i}.${p}`) },
          });
        }
        return mid;
      }),
    );
  }
  return ids;
}

const asUser = (t: T, userId: Id<"users">) => t.withIdentity({ subject: `${userId}|session` });

describe("loadChatView read budget", () => {
  test("a conversation heavier than the budget opens with its NEWEST messages, marked truncated", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedUser(t);
    // 20 turns × 700 KB ≈ 14 MB of parts: the whole window would read past 16 MiB in prod.
    const ids = await seedTurns(t, chatId, userId, 20, 1);
    expect(20 * HEAVY_BYTES).toBeGreaterThan(CHAT_VIEW_READ_BUDGET_BYTES);

    const rows = await asUser(t, userId).query(api.messages.listByChat, { chatId });

    // Fewer than all of them — and exactly the newest ones, in thread order, each WHOLE.
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.length).toBeLessThan(20);
    expect(rows.map((r) => r._id)).toEqual(ids.slice(-rows.length));
    for (const r of rows) {
      expect(r.partsOmitted).toBeUndefined();
      expect(r.parts).toHaveLength(1);
    }
    // What the window kept fits the budget (each part is read whole).
    expect(rows.length * HEAVY_BYTES).toBeLessThanOrEqual(CHAT_VIEW_READ_BUDGET_BYTES);
    // The window says so, on its first row only — the client's one signal.
    expect(rows[0]!.windowTruncated).toBe(true);
    expect(rows.slice(1).some((r) => r.windowTruncated !== undefined)).toBe(false);

    // The diagnostic reads the SAME window, and says so too.
    const state = await t.query(internal.messages.chatStateInternal, { chatId, includeParts: false });
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.messageCount).toBe(rows.length);
    expect(state.windowTruncated).toBe(true);
  });

  test("a single message heavier than the budget does not throw: it opens bare", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedUser(t);
    const [older] = await seedTurns(t, chatId, userId, 1, 1);
    // 13 × 700 KB ≈ 9.1 MB of parts on ONE turn: past the budget on its own.
    const [giant] = await seedTurns(t, chatId, userId, 1, 13);
    expect(13 * HEAVY_BYTES).toBeGreaterThan(CHAT_VIEW_READ_BUDGET_BYTES);

    const rows = await asUser(t, userId).query(api.messages.listByChat, { chatId });

    // The newest turn is never dropped: its text, without its parts, flagged.
    expect(rows.map((r) => r._id)).toEqual([giant]);
    expect(rows[0]!.text).toBe("turn 0");
    expect(rows[0]!.parts).toEqual([]);
    expect(rows[0]!.partsOmitted).toBe(true);
    // The older turn did not fit after it: the window is truncated.
    expect(rows[0]!.windowTruncated).toBe(true);
    expect(rows.some((r) => r._id === older)).toBe(false);

    const state = await t.query(internal.messages.chatStateInternal, { chatId, includeParts: false });
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.messages[0]!.partsOmitted).toBe(true);
  });

  test("a lone giant message: bare, and the window is NOT truncated (nothing older exists)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedUser(t);
    const [giant] = await seedTurns(t, chatId, userId, 1, 13);

    const rows = await asUser(t, userId).query(api.messages.listByChat, { chatId });

    expect(rows.map((r) => r._id)).toEqual([giant]);
    expect(rows[0]!.partsOmitted).toBe(true);
    expect(rows[0]!.windowTruncated).toBeUndefined();
  });

  test("a normal conversation reads exactly as before: every message, whole, in thread order, no flag", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedUser(t);
    const ids = await t.run(async (ctx) => {
      const out: Id<"messages">[] = [];
      const storageId = await ctx.storage.store(new Blob(["pdf"]));
      for (let i = 0; i < 6; i++) {
        const role = i % 2 === 0 ? ("user" as const) : ("assistant" as const);
        const mid = await ctx.db.insert("messages", {
          chatId,
          userId,
          role,
          status: "complete" as const,
          text: `m${i}`,
          updatedAt: i,
        });
        out.push(mid);
        if (role === "assistant") {
          await ctx.db.insert("messageParts", {
            messageId: mid,
            order: 1,
            part: { kind: "tool" as const, name: "bash", phase: "completed", input: { cmd: "ls" }, output: "a b" },
          });
          await ctx.db.insert("messageParts", {
            messageId: mid,
            order: 0,
            part: { kind: "reasoning" as const, text: `note ${i}` },
          });
          await ctx.db.insert("messageParts", {
            messageId: mid,
            order: 2,
            part: { kind: "file" as const, storageId, filename: `f${i}.pdf`, mimeType: "application/pdf" },
          });
        }
      }
      // A queued follow-up written EARLY but ordered last (orderTime): thread order, not
      // creation order, is what the window presents.
      const queued = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "user" as const,
        status: "complete" as const,
        text: "late",
        updatedAt: 9,
        orderTime: Date.now() + 60_000,
      });
      out.push(queued);
      return out;
    });

    const rows = await asUser(t, userId).query(api.messages.listByChat, { chatId });

    expect(rows.map((r) => r._id)).toEqual(ids);
    expect(rows.some((r) => r.windowTruncated !== undefined || r.partsOmitted !== undefined)).toBe(false);
    for (const r of rows.filter((x) => x.role === "assistant")) {
      // Parts in their stored `order`, each kind projected as before.
      expect(r.parts.map((p) => p.kind)).toEqual(["reasoning", "tool", "file"]);
    }
  });

  test("a full window is flagged exactly when the old rule said so (length === MESSAGE_WINDOW)", async () => {
    for (const [count, flagged] of [
      [MESSAGE_WINDOW - 1, false],
      [MESSAGE_WINDOW, true],
      [MESSAGE_WINDOW + 1, true],
    ] as const) {
      const t = convexTest(schema, modules);
      const { userId, chatId } = await seedUser(t);
      const ids = await t.run(async (ctx) => {
        const out: Id<"messages">[] = [];
        for (let i = 0; i < count; i++) {
          out.push(
            await ctx.db.insert("messages", {
              chatId,
              userId,
              role: "user" as const,
              status: "complete" as const,
              text: `m${i}`,
              updatedAt: i,
            }),
          );
        }
        return out;
      });
      const rows = await asUser(t, userId).query(api.messages.listByChat, { chatId });
      expect(rows.length).toBe(Math.min(count, MESSAGE_WINDOW));
      expect(rows.map((r) => r._id)).toEqual(ids.slice(-MESSAGE_WINDOW));
      expect(rows[0]!.windowTruncated === true).toBe(flagged);
      expect(rows.length === MESSAGE_WINDOW).toBe(flagged);
    }
  });
});

describe("forkChat read budget", () => {
  const forkMessages = async (t: T, forkId: Id<"chats">) =>
    await t.run(async (ctx) => {
      const msgs = await ctx.db
        .query("messages")
        .withIndex("by_chat", (q) => q.eq("chatId", forkId))
        .take(MESSAGE_WINDOW + 1);
      return msgs.map((m) => ({ text: m.text, rowLayout: m.rowLayout }));
    });

  test("a heavy conversation forks its NEWEST history within the budget, marked truncated", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedUser(t);
    // 15 turns × 700 KB ≈ 10 MB of parts: past FORK_COPY_BUDGET_BYTES (6 MiB).
    const ids = await seedTurns(t, chatId, userId, 15, 1);

    const res = await asUser(t, userId).mutation(api.chatFork.forkChat, { branchMessageId: ids[14]! });

    expect((res as { truncated?: boolean }).truncated).toBe(true);
    const copied = await forkMessages(t, res.chatId);
    expect(copied.length).toBeGreaterThan(1);
    expect(copied.length).toBeLessThan(15);
    // The newest ones, branch point included, in order.
    expect(copied.map((m) => m.text)).toEqual(
      Array.from({ length: 15 }, (_, i) => `turn ${i}`).slice(-copied.length),
    );
  });

  test("a branch point heavier than the budget forks bare instead of throwing", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedUser(t);
    await seedTurns(t, chatId, userId, 1, 1);
    // 10 × 700 KB ≈ 7 MB of parts on the branch point alone.
    const [giant] = await seedTurns(t, chatId, userId, 1, 10);

    const res = await asUser(t, userId).mutation(api.chatFork.forkChat, { branchMessageId: giant! });

    expect((res as { truncated?: boolean }).truncated).toBe(true);
    const copied = await forkMessages(t, res.chatId);
    expect(copied.map((m) => m.text)).toEqual(["turn 0"]);
  });
});

describe("displayReport read budget (diagnose_chat)", () => {
  test("decides over the newest bubbles that fit, and says older ones were left out", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedUser(t);
    await seedTurns(t, chatId, userId, 10, 1);
    expect(10 * HEAVY_BYTES).toBeGreaterThan(DISPLAY_REPORT_READ_BUDGET_BYTES);

    const report = await t.run(async (ctx) => await displayReport(ctx, chatId));

    expect(report.bubbles).toBeGreaterThan(0);
    expect(report.bubbles).toBeLessThan(10);
    expect(report.windowTruncated).toBe(true);
  });

  test("a light conversation: every bubble, not truncated", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedUser(t);
    await seedTurns(t, chatId, userId, 3, 0);

    const report = await t.run(async (ctx) => await displayReport(ctx, chatId));

    expect(report.bubbles).toBe(3);
    expect(report.windowTruncated).toBe(false);
  });
});
