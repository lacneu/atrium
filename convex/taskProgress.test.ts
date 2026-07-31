/// <reference types="vite/client" />
//
// Telling the user WHERE a long task is (2026-07-31).
//
// Production report: a user launched a multi-hour cycle, was told he could close his
// laptop, and then asked three times "où ça en est ?" — the indicator showed a spinner
// and a clock and nothing else. The gateway publishes `TaskSummary.progressSummary` on
// every task record; the bridge kept only `terminalSummary`, which by definition exists
// only once the task is OVER. So at the exact moment the user was asking, Atrium had the
// answer available and was throwing it away.
//
// The rule that carries this feature is not "write the line" — it is ABSENCE MUST NOT
// ERASE. The probe runs every ~30s and a task does not publish a line on every poll; if a
// silent poll cleared the field, the indicator would flick between the real progress and
// a bare spinner twice a minute, which is worse than never having shown anything.

import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

/** A chat with one RUNNING task engagement, as the probe would find it. */
async function seedRunningTask(
  t: TestConvex<typeof schema>,
  taskId: string,
): Promise<Id<"chats">> {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const chatId = await ctx.db.insert("chats", {
      userId,
      title: "t",
      archived: false,
      sortKey: 0,
      updatedAt: Date.now(),
    });
    await ctx.db.insert("subAgents", {
      chatId,
      userId,
      childSessionKey: `task:${taskId}`,
      status: "running",
      kind: "task",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return chatId;
  });
}

const lineOf = async (
  t: TestConvex<typeof schema>,
  chatId: Id<"chats">,
): Promise<string | undefined> =>
  await t.run(async (ctx) => {
    const row = await ctx.db
      .query("subAgents")
      .withIndex("by_chat_status_updated", (q) =>
        q.eq("chatId", chatId).eq("status", "running"),
      )
      .first();
    return row?.progressSummary;
  });

describe("a running task's progress line reaches the row", () => {
  test("the line the gateway published is stored", async () => {
    const t = convexTest(schema, modules);
    const chatId = await seedRunningTask(t, "task-1");
    await t.mutation(internal.subAgents.refreshTaskEngagement, {
      chatId,
      taskId: "task-1",
      progressSummary: "Veille 3/8 — analyse en cours",
    });
    expect(await lineOf(t, chatId)).toBe("Veille 3/8 — analyse en cours");
  });

  test("a LATER line replaces the earlier one", async () => {
    const t = convexTest(schema, modules);
    const chatId = await seedRunningTask(t, "task-1");
    for (const line of ["Veille 1/8", "Veille 2/8", "Veille 3/8"]) {
      await t.mutation(internal.subAgents.refreshTaskEngagement, {
        chatId,
        taskId: "task-1",
        progressSummary: line,
      });
    }
    expect(await lineOf(t, chatId)).toBe("Veille 3/8");
  });
});

describe("absence does not erase", () => {
  test("a poll that carries NO line leaves the last one standing", async () => {
    // The rule this feature rests on. The probe fires every ~30s and a task does not
    // publish on every one; clearing on silence would make the indicator blink between
    // the real progress and nothing, twice a minute.
    const t = convexTest(schema, modules);
    const chatId = await seedRunningTask(t, "task-1");
    await t.mutation(internal.subAgents.refreshTaskEngagement, {
      chatId,
      taskId: "task-1",
      progressSummary: "Veille 3/8",
    });
    await t.mutation(internal.subAgents.refreshTaskEngagement, {
      chatId,
      taskId: "task-1",
    });
    expect(
      await lineOf(t, chatId),
      "a silent poll has learned nothing — it must not unlearn",
    ).toBe("Veille 3/8");
  });

  test("an EMPTY line is treated as silence, not as a new value", async () => {
    // `""` from a gateway that sends the field unset is not the agent saying "nothing
    // is happening" — it is the agent saying nothing.
    const t = convexTest(schema, modules);
    const chatId = await seedRunningTask(t, "task-1");
    await t.mutation(internal.subAgents.refreshTaskEngagement, {
      chatId,
      taskId: "task-1",
      progressSummary: "Veille 3/8",
    });
    await t.mutation(internal.subAgents.refreshTaskEngagement, {
      chatId,
      taskId: "task-1",
      progressSummary: "   ",
    });
    expect(await lineOf(t, chatId)).toBe("Veille 3/8");
  });
});

describe("what the line may not do", () => {
  test("it is CAPPED — model prose cannot arrive unbounded on chat chrome", async () => {
    const t = convexTest(schema, modules);
    const chatId = await seedRunningTask(t, "task-1");
    await t.mutation(internal.subAgents.refreshTaskEngagement, {
      chatId,
      taskId: "task-1",
      progressSummary: "x".repeat(5000),
    });
    expect((await lineOf(t, chatId))?.length).toBe(600);
  });

  test("a task that is no longer running is not refreshed at all", async () => {
    // The row is terminal: writing progress onto it would resurrect a line under a
    // finished task, and the indicator reads the running row.
    const t = convexTest(schema, modules);
    const chatId = await seedRunningTask(t, "task-1");
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("subAgents")
        .withIndex("by_child", (q) => q.eq("childSessionKey", "task:task-1"))
        .first();
      if (row !== null) await ctx.db.patch(row._id, { status: "done" });
    });
    await t.mutation(internal.subAgents.refreshTaskEngagement, {
      chatId,
      taskId: "task-1",
      progressSummary: "late line",
    });
    const stored = await t.run(async (ctx) => {
      const row = await ctx.db
        .query("subAgents")
        .withIndex("by_child", (q) => q.eq("childSessionKey", "task:task-1"))
        .first();
      return row?.progressSummary;
    });
    // `t.run` serialises `undefined` to `null` on the way back, so the assertion is
    // "no line at all" rather than a specific absent-value spelling.
    expect(stored ?? null).toBeNull();
  });
});
