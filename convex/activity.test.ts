/// <reference types="vite/client" />
//
// Platform-activity snapshot (activity.ts) — the deploy go/no-go read behind
// GET /api/v1/activity. Discriminating properties:
//   - counts come from the right status slices (running-only sub-agents,
//     queued/pending-only outbox, streamingText cardinality);
//   - the distinct-user windows (5/15/60 min) count DISTINCT principalIds of
//     chat.send traces only, window-bounded;
//   - the deployReadiness verdict flips to "active" on EACH blocking signal
//     (and names it) and is "idle" only when everything is quiet;
//   - SOC2: the response never carries content, chat ids, or principal ids.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { computeActivity } from "./activity";

const modules = import.meta.glob("./**/*.ts");

/** Seed a user+chat pair (the FK targets most rows need). */
async function seedChat(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const chatId = await ctx.db.insert("chats", { userId, updatedAt: 0 });
    return { userId, chatId };
  });
}

describe("computeActivity — counts come from the right slices", () => {
  test("empty platform: all zero, verdict idle, no reasons", async () => {
    const t = convexTest(schema, modules);
    const snap = await t.run(async (ctx) => computeActivity(ctx, Date.now()));
    expect(snap.activeStreams).toEqual({
      count: 0,
      maxAgeSeconds: null,
      capped: false,
    });
    expect(snap.runningSubAgents.count).toBe(0);
    expect(snap.outbox).toEqual({ queued: 0, pending: 0, capped: false });
    expect(snap.activeUsers).toEqual({
      last5m: 0,
      last15m: 0,
      last60m: 0,
      capped: false,
    });
    expect(snap.lastChatSendAgeSeconds).toBeNull();
    expect(snap.deployReadiness).toEqual({ verdict: "idle", reasons: [] });
  });

  test("streamingText rows are counted with a max age (invariant: row ⇔ live turn)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedChat(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < 2; i++) {
        const messageId = await ctx.db.insert("messages", {
          chatId,
          userId,
          role: "assistant" as const,
          status: "streaming" as const,
          text: "",
          runId: `run-${i}`,
          updatedAt: Date.now(),
        });
        await ctx.db.insert("streamingText", {
          messageId,
          chatId,
          text: "partial",
          updatedAt: Date.now(),
        });
      }
    });
    const snap = await t.run(async (ctx) => computeActivity(ctx, Date.now()));
    expect(snap.activeStreams.count).toBe(2);
    expect(snap.activeStreams.maxAgeSeconds).not.toBeNull();
    expect(snap.activeStreams.maxAgeSeconds).toBeGreaterThanOrEqual(0);
    expect(snap.deployReadiness.verdict).toBe("active");
    expect(snap.deployReadiness.reasons).toContain("2 active stream(s)");
  });

  test("sub-agents: running rows count (incl. task + legacy kind-less), terminal rows do not", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seedChat(t);
    const now = Date.now();
    await t.run(async (ctx) => {
      // Running child (kind subagent) + running task + legacy row (no kind).
      await ctx.db.insert("subAgents", {
        chatId,
        childSessionKey: "agent:main:subagent:aaaa",
        kind: "subagent" as const,
        status: "running" as const,
        createdAt: now - 30_000,
        updatedAt: now,
      });
      await ctx.db.insert("subAgents", {
        chatId,
        childSessionKey: "task:tsk-1",
        kind: "task" as const,
        status: "running" as const,
        createdAt: now - 5_000,
        updatedAt: now,
      });
      await ctx.db.insert("subAgents", {
        chatId,
        childSessionKey: "agent:main:subagent:bbbb",
        status: "running" as const,
        createdAt: now - 60_000,
        updatedAt: now,
      });
      // Terminal rows must NOT count.
      await ctx.db.insert("subAgents", {
        chatId,
        childSessionKey: "agent:main:subagent:cccc",
        status: "done" as const,
        createdAt: now - 120_000,
        updatedAt: now,
      });
      await ctx.db.insert("subAgents", {
        chatId,
        childSessionKey: "agent:main:subagent:dddd",
        status: "error" as const,
        createdAt: now - 120_000,
        updatedAt: now,
      });
    });
    const snap = await t.run(async (ctx) => computeActivity(ctx, Date.now()));
    expect(snap.runningSubAgents.count).toBe(3);
    // The stalest running row is ~60s old.
    expect(snap.runningSubAgents.maxAgeSeconds).toBeGreaterThanOrEqual(59);
    expect(snap.deployReadiness.verdict).toBe("active");
    expect(snap.deployReadiness.reasons).toContain(
      "3 running sub-agent(s)/task(s)",
    );
  });

  test("outbox: queued + pending count separately; sent/failed are ignored", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedChat(t);
    await t.run(async (ctx) => {
      const statuses = ["queued", "queued", "pending", "sent", "failed"] as const;
      for (let i = 0; i < statuses.length; i++) {
        await ctx.db.insert("outbox", {
          chatId,
          userId,
          clientMessageId: `cm-${i}`,
          text: `msg-${i}`,
          attachmentIds: [],
          status: statuses[i],
        });
      }
    });
    const snap = await t.run(async (ctx) => computeActivity(ctx, Date.now()));
    expect(snap.outbox.queued).toBe(2);
    expect(snap.outbox.pending).toBe(1);
    expect(snap.deployReadiness.verdict).toBe("active");
    expect(snap.deployReadiness.reasons).toContain("2 queued send(s)");
    expect(snap.deployReadiness.reasons).toContain("1 pending dispatch(es)");
  });
});

describe("computeActivity — distinct-user windows over chat.send traces", () => {
  test("windows count DISTINCT principalIds; other kinds and >60min sends are excluded", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      const send = (at: number, principalId: string) =>
        ctx.db.insert("traceEvents", {
          at,
          kind: "chat.send",
          principalType: "user" as const,
          principalId,
          redacted: true,
        });
      await send(now - 2 * 60_000, "user-A"); // in 5m
      await send(now - 10 * 60_000, "user-B"); // in 15m
      await send(now - 40 * 60_000, "user-A"); // in 60m (dup of A)
      await send(now - 70 * 60_000, "user-C"); // OUTSIDE the 60m window
      // A non-send kind inside the 5m window must not count as activity.
      await ctx.db.insert("traceEvents", {
        at: now - 60_000,
        kind: "api.call",
        principalType: "service" as const,
        principalId: "svc-obs",
        redacted: true,
      });
    });
    const snap = await t.run(async (ctx) => computeActivity(ctx, now));
    expect(snap.activeUsers.last5m).toBe(1); // A
    expect(snap.activeUsers.last15m).toBe(2); // A, B
    expect(snap.activeUsers.last60m).toBe(2); // A, B (A deduped; C out of window)
    expect(snap.lastChatSendAgeSeconds).toBe(120);
  });

  test("no chat.send within 60min ⇒ null age, and the quiet horizon is satisfied", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("traceEvents", {
        at: now - 90 * 60_000,
        kind: "chat.send",
        principalType: "user" as const,
        principalId: "user-old",
        redacted: true,
      });
    });
    const snap = await t.run(async (ctx) => computeActivity(ctx, now));
    expect(snap.lastChatSendAgeSeconds).toBeNull();
    expect(snap.deployReadiness.verdict).toBe("idle");
  });
});

describe("computeActivity — deployReadiness verdict", () => {
  test("a lone recent chat.send (<15min) blocks: verdict active with the quiet-horizon reason", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("traceEvents", {
        at: now - 10 * 60_000,
        kind: "chat.send",
        principalType: "user" as const,
        principalId: "user-A",
        redacted: true,
      });
    });
    const snap = await t.run(async (ctx) => computeActivity(ctx, now));
    expect(snap.deployReadiness.verdict).toBe("active");
    expect(snap.deployReadiness.reasons).toEqual([
      "last user send 600s ago (< 15 min)",
    ]);
  });

  test("a chat.send older than 15min alone does NOT block: verdict idle", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("traceEvents", {
        at: now - 20 * 60_000,
        kind: "chat.send",
        principalType: "user" as const,
        principalId: "user-A",
        redacted: true,
      });
    });
    const snap = await t.run(async (ctx) => computeActivity(ctx, now));
    expect(snap.lastChatSendAgeSeconds).toBe(1200);
    expect(snap.deployReadiness).toEqual({ verdict: "idle", reasons: [] });
  });
});

describe("activity — SOC2: counts and timestamps only", () => {
  test("the response never carries content, chat ids, principal ids or emails", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedChat(t);
    const now = Date.now();
    await t.run(async (ctx) => {
      const messageId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "streaming" as const,
        text: "",
        runId: "run-soc2",
        updatedAt: now,
      });
      await ctx.db.insert("streamingText", {
        messageId,
        chatId,
        text: "SECRET-STREAM-CONTENT",
        updatedAt: now,
      });
      await ctx.db.insert("subAgents", {
        chatId,
        childSessionKey: "agent:main:subagent:soc2",
        status: "running" as const,
        taskName: "SECRET-TASK-NAME",
        resultText: "SECRET-RESULT",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("outbox", {
        chatId,
        userId,
        clientMessageId: "cm-soc2",
        text: "SECRET-OUTBOX-TEXT",
        attachmentIds: [],
        status: "queued" as const,
      });
      await ctx.db.insert("traceEvents", {
        at: now - 60_000,
        kind: "chat.send",
        principalType: "user" as const,
        principalId: "someone@example.com",
        chatId,
        redacted: true,
      });
    });
    // Through the real internal query (the exact payload the route returns).
    const snap = await t.query(internal.activity.activityInternal, {});
    const json = JSON.stringify(snap);
    expect(json).not.toContain("SECRET"); // no stream/outbox/task content
    expect(json).not.toContain(chatId); // no chat ids
    expect(json).not.toContain(userId); // no user ids
    expect(json).not.toContain("@"); // no emails / principal ids
    expect(json).not.toContain("someone"); // the principalId itself never leaks
    // ...while the aggregates are still there.
    expect(snap.activeStreams.count).toBe(1);
    expect(snap.runningSubAgents.count).toBe(1);
    expect(snap.outbox.queued).toBe(1);
    expect(snap.activeUsers.last5m).toBe(1);
  });
});
