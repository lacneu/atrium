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
import { describe, expect, test, vi } from "vitest";

import { api, internal } from "./_generated/api";
import { settleFromLedger } from "./subAgents";
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

describe("the ledger's own terminal status settles the engagement (codex)", () => {
  // `completed` is the gateway's success status; `succeeded` belongs to the SEPARATE
  // `terminalOutcome` field. Mapping the latter while omitting the former sent a
  // finished task down the "still running" branch: reconcile refreshed the engagement
  // instead of settling it, so a lost delivery announce left the spinner up and later
  // messages queued until the declared deadline or the 24 h reaper.
  const answerWith = (
    status: string,
    extra: Record<string, unknown> = {},
  ) => {
    const fetchSpy = vi.fn(async (url: string) => {
      if (String(url).includes("/tasks-probe")) {
        return new Response(
          // `ledgerDimensions` is what a CURRENT bridge publishes; the old-bridge case
          // is covered on its own below.
          JSON.stringify({
            ok: true,
            tasks: [{ taskId: "T1", status, ledgerDimensions: true, ...extra }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    return fetchSpy;
  };

  const reconcileWith = async (
    status: string,
    extra: Record<string, unknown> = {},
  ): Promise<string | undefined> => {
    const t = convexTest(schema, modules);
    const chatId = await seedRunningTask(t, "T1");
    const userId = await t.run(async (ctx) => {
      await ctx.db.insert("instances", { name: "primary", gatewayUrl: "ws://gw" });
      const chat = await ctx.db.get(chatId);
      // The probe is per INSTANCE: without one on the chat there is nothing to ask.
      await ctx.db.patch(chatId, { instanceName: "primary", agentId: "main" });
      await ctx.db.insert("profiles", {
        userId: chat!.userId,
        role: "user" as const,
        canonical: "u",
      });
      return chat!.userId;
    });
    const asUser = t.withIdentity({ subject: `${userId}|session` });
    const prevUrl = process.env.BRIDGE_URL;
    const prevSecret = process.env.BRIDGE_SHARED_SECRET;
    process.env.BRIDGE_URL = "http://bridge:8787";
    process.env.BRIDGE_SHARED_SECRET = "s";
    const origFetch = globalThis.fetch;
    globalThis.fetch = answerWith(status, extra) as unknown as typeof fetch;
    try {
      await asUser.action(api.subAgents.reconcileTaskEngagements, { chatId });
    } finally {
      globalThis.fetch = origFetch;
      if (prevUrl === undefined) delete process.env.BRIDGE_URL;
      else process.env.BRIDGE_URL = prevUrl;
      if (prevSecret === undefined) delete process.env.BRIDGE_SHARED_SECRET;
      else process.env.BRIDGE_SHARED_SECRET = prevSecret;
    }
    return await t.run(async (ctx) => {
      const rows = await ctx.db.query("subAgents").collect();
      return rows.find((r) => r.childSessionKey === "task:T1")?.status;
    });
  };

  test("`completed` settles the engagement DONE, it does not refresh it as running", async () => {
    expect(await reconcileWith("completed")).toBe("done");
  });

  test("`running` still refreshes rather than settles", async () => {
    expect(await reconcileWith("running")).toBe("running");
  });

  test("a failing status still settles as an error", async () => {
    expect(await reconcileWith("failed")).toBe("error");
  });

  test("completed + delivery STILL IN FLIGHT keeps the engagement active (codex)", async () => {
    // `status` says the run ended; `deliveryStatus` says the report has not landed.
    // Settling here drains the next queued message before the answer arrives.
    for (const deliveryStatus of ["pending", "session_queued"]) {
      expect(
        await reconcileWith("completed", { deliveryStatus }),
        deliveryStatus,
      ).toBe("running");
    }
  });

  test("completed + BLOCKED outcome is an error, not a success", async () => {
    expect(
      await reconcileWith("completed", {
        terminalOutcome: "blocked",
        deliveryStatus: "delivered",
      }),
    ).toBe("error");
  });

  test("completed + delivery FAILED is an error: the report will never arrive", async () => {
    expect(
      await reconcileWith("completed", { deliveryStatus: "failed" }),
    ).toBe("error");
  });

  test("the report will NEVER arrive: dismissed and parent_missing are errors (codex)", async () => {
    // The coverage manifest already said three delivery states mean the report never
    // arrives. Handling only `failed` settled the other two as successes — hiding a lost
    // result and releasing the next queued message.
    for (const deliveryStatus of ["failed", "dismissed", "parent_missing"]) {
      expect(await reconcileWith("completed", { deliveryStatus }), deliveryStatus).toBe(
        "error",
      );
    }
  });

  test("an UNKNOWN delivery state keeps waiting rather than inventing an outcome", async () => {
    expect(
      await reconcileWith("completed", { deliveryStatus: "teleported" }),
    ).toBe("running");
  });

  test("not_applicable defers to the terminal outcome, like delivered", async () => {
    expect(
      await reconcileWith("completed", {
        deliveryStatus: "not_applicable",
        terminalOutcome: "succeeded",
      }),
    ).toBe("done");
    expect(
      await reconcileWith("completed", {
        deliveryStatus: "not_applicable",
        terminalOutcome: "blocked",
      }),
    ).toBe("error");
  });

  test("an UNKNOWN terminal outcome keeps waiting too, like an unknown delivery (codex)", async () => {
    // The asymmetry WAS the defect: an unrecognised delivery state kept waiting while
    // an unrecognised outcome silently meant success. A gateway beyond the validated
    // ceiling — which the support policy explicitly serves — can answer either.
    expect(
      await reconcileWith("completed", {
        deliveryStatus: "delivered",
        terminalOutcome: "partial",
      }),
    ).toBe("running");
  });

  test("an OLD bridge cannot close a task as a success (codex)", async () => {
    // It omits `ledgerDimensions`, so its nulls mean "not asked", not "not set". During
    // a rolling upgrade this closed blocked and still-delivering tasks as done.
    const t = convexTest(schema, modules);
    // Same probe answer, minus the flag this build publishes.
    expect(
      settleFromLedger("completed", null, null, false),
      "no dimensions: a success must not be inferred",
    ).toBeUndefined();
    expect(
      settleFromLedger("completed", null, null, true),
      "with dimensions, a plain completed is done",
    ).toBe("done");
    // An ERROR is still an error: the status alone carries that much.
    expect(settleFromLedger("failed", null, null, false)).toBe("error");
    expect(settleFromLedger("timed_out", null, null, false)).toBe("error");
    void t;
  });

  test("completed + succeeded + delivered settles DONE", async () => {
    expect(
      await reconcileWith("completed", {
        terminalOutcome: "succeeded",
        deliveryStatus: "delivered",
      }),
    ).toBe("done");
  });
});
