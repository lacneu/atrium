/// <reference types="vite/client" />
//
// EVERY DOCUMENT A GROUP REPORT READS IS COUNTED (transcript redesign phase 5, codex pass 6
// #2). `submitFeedback` on a bubble of a delegation's display group reads under ONE byte
// budget (convex/feedback.ts `readBounded`, `GROUP_READ_BYTES`). This test instruments the
// reader convex-test charges every transaction with, and checks that what the mutation
// really read never exceeds what its budget counted (plus a small fixed allowance for the
// reads that follow the group's: the chat, the outbox, the documents). Large documents sit
// in EVERY read position, so a read left out of the count shows by more than the allowance.

import { convexTest } from "convex-test";
import { TransactionMetricsTracker } from "convex-test/dist/transactionMetrics.js";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { reportReadAccounting } from "./feedback";

const modules = import.meta.glob("./**/*.ts");

let bytesRead = 0;
const proto = TransactionMetricsTracker.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
const original = proto.trackRead!;
proto.trackRead = function (this: unknown, ...args: unknown[]) {
  bytesRead += typeof args[0] === "number" ? args[0] : 0;
  return original.apply(this, args);
};
afterAll(() => {
  proto.trackRead = original;
});

let prevAnon: string | undefined;
beforeEach(() => {
  prevAnon = process.env.OPENCLAW_ENABLE_ANON_AUTH;
  process.env.OPENCLAW_ENABLE_ANON_AUTH = "1";
});
afterAll(() => {
  if (prevAnon === undefined) delete process.env.OPENCLAW_ENABLE_ANON_AUTH;
  else process.env.OPENCLAW_ENABLE_ANON_AUTH = prevAnon;
});

const SK = "agent:main:atrium:chat:u:c1";
/** Reads the group path does not count (they follow it), in bytes. */
const ALLOWANCE = 512 * 1024;

describe("a group report's budget counts every document it reads", () => {
  test("old group, large older answers, many recent messages, large parts", async () => {
    const t = convexTest({ schema, modules, transactionLimits: true });
    const big = (n: number, c: string) => c.repeat(n * 1024);
    const { userId, chatId, head } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "u" });
      const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1 });
      return { userId, chatId, head: null as Id<"messages"> | null };
    });
    // Two older answers of 600 KiB (read by the walk to the prompt), the question.
    for (let i = 0; i < 2; i++) {
      await t.run((ctx) => ctx.db.insert("messages", { chatId, userId, role: "assistant" as const, status: "complete" as const, text: big(600, "o"), updatedAt: 1 }));
    }
    await t.run((ctx) => ctx.db.insert("messages", { chatId, userId, role: "user" as const, status: "complete" as const, text: "délègue", updatedAt: 1 }));
    const mP = await t.run((ctx) =>
      ctx.db.insert("messages", { chatId, userId, role: "assistant" as const, status: "complete" as const, text: big(300, "p"), runId: "webchat-p", turnSessionKey: SK, updatedAt: 1 }),
    );
    await t.run((ctx) => ctx.db.patch(mP, { displayGroupId: mP }));
    const mA = await t.run((ctx) =>
      ctx.db.insert("messages", { chatId, userId, role: "assistant" as const, status: "complete" as const, text: big(300, "a"), runId: "announce:v1:agent:files:subagent:k:r", turnSessionKey: SK, displayGroupId: mP, updatedAt: 1 }),
    );
    for (let i = 0; i < 3; i++) {
      await t.run((ctx) =>
        ctx.db.insert("messageParts", { messageId: mA, order: i, part: { kind: "tool", name: "exec", phase: "result", toolCallId: `c${i}`, output: big(700, "x") } } as never),
      );
    }
    // 61 newer short messages: the reported group falls out of the context scan.
    await t.run(async (ctx) => {
      for (let i = 0; i < 61; i++) {
        await ctx.db.insert("messages", { chatId, userId, role: i % 2 === 0 ? ("user" as const) : ("assistant" as const), status: "complete" as const, text: `m${i}`, updatedAt: 2 });
      }
    });
    void head;
    reportReadAccounting.lastBytes = 0;
    bytesRead = 0;
    await t.withIdentity({ subject: `${userId}|session` }).mutation(api.feedback.submitFeedback, {
      chatId,
      messageId: mP,
      category: "incorrect",
    });
    expect(reportReadAccounting.lastBytes).toBeGreaterThan(0);
    // What the mutation read is what its budget counted, give or take the trailing reads.
    expect(bytesRead).toBeLessThanOrEqual(reportReadAccounting.lastBytes + ALLOWANCE);
    const fb = (await t.run((ctx) => ctx.db.query("feedback").first()))!;
    expect(fb.snapshot.groupMessageIds).toEqual([mP, mA]);
  }, 120_000);

  test("codex's repro: 11 older answers of 768 KiB, 61 recent, 12 parts of 900 KiB — the report is stored", async () => {
    const t = convexTest({ schema, modules, transactionLimits: true });
    const big = (n: number, c: string) => c.repeat(n * 1024);
    const { userId, chatId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "u" });
      const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1 });
      return { userId, chatId };
    });
    for (let i = 0; i < 11; i++) {
      await t.run((ctx) => ctx.db.insert("messages", { chatId, userId, role: "assistant" as const, status: "complete" as const, text: big(768, "o"), updatedAt: 1 }));
    }
    await t.run((ctx) => ctx.db.insert("messages", { chatId, userId, role: "user" as const, status: "complete" as const, text: "délègue", updatedAt: 1 }));
    const mP = await t.run((ctx) =>
      ctx.db.insert("messages", { chatId, userId, role: "assistant" as const, status: "complete" as const, text: "Je délègue.", runId: "webchat-p", turnSessionKey: SK, updatedAt: 1 }),
    );
    await t.run((ctx) => ctx.db.patch(mP, { displayGroupId: mP }));
    const mA = await t.run((ctx) =>
      ctx.db.insert("messages", { chatId, userId, role: "assistant" as const, status: "complete" as const, text: "Résultat.", runId: "announce:v1:agent:files:subagent:k:r", turnSessionKey: SK, displayGroupId: mP, updatedAt: 1 }),
    );
    for (let i = 0; i < 12; i++) {
      await t.run((ctx) =>
        ctx.db.insert("messageParts", { messageId: mA, order: i, part: { kind: "tool", name: "exec", phase: "result", toolCallId: `c${i}`, output: big(900, "x") } } as never),
      );
    }
    await t.run(async (ctx) => {
      for (let i = 0; i < 61; i++) {
        await ctx.db.insert("messages", { chatId, userId, role: i % 2 === 0 ? ("user" as const) : ("assistant" as const), status: "complete" as const, text: `m${i}`, updatedAt: 2 });
      }
    });
    await t.withIdentity({ subject: `${userId}|session` }).mutation(api.feedback.submitFeedback, {
      chatId,
      messageId: mP,
      category: "incorrect",
    });
    const fb = (await t.run((ctx) => ctx.db.query("feedback").first()))!;
    expect(fb.snapshot.groupTruncated).toBe(true);
  }, 180_000);
});
