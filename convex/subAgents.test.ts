/// <reference types="vite/client" />
//
// Sub-agent observation store (increment 1 of the sub-agent monitor).
//
// Pins:
//   - upsertSubAgent UPSERTS by childSessionKey (insert, then patch the same row).
//   - the reorder-tolerance guard: a terminal status (done) is never downgraded
//     back to running by a late registration.
//   - listSubAgents is OWNER-SCOPED (the per-user access boundary): the owner sees
//     their chat's rows; a non-owner is rejected.

import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { MAX_SUBAGENT_BATCH_RECORDS, mergeSubAgentTools } from "./subAgents";

const modules = import.meta.glob("./**/*.ts");

async function seedUserAndChat(t: ReturnType<typeof convexTest>, canonical = "alice") {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user", canonical });
    const chatId = await ctx.db.insert("chats", { userId, updatedAt: 0 });
    return { userId, chatId };
  });
}

const CHILD = "agent:alice:subagent:50a9857b-5b2f-40ce-867d-2e20d2e2b737";

describe("subAgents.upsertSubAgent", () => {
  test("insert then update BY childSessionKey (one row, patched in place)", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seedUserAndChat(t);

    // First sight: register (running) + task name.
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: CHILD,
      taskName: "do the thing",
      status: "running" as const,
    });
    // Later child frame: terminal result.
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: CHILD,
      status: "done" as const,
      resultText: "SUBAGENT_PONG_42",
    });

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("subAgents")
        .withIndex("by_child", (q) => q.eq("childSessionKey", CHILD))
        .collect(),
    );
    // Exactly ONE row (upsert, not append).
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      childSessionKey: CHILD,
      status: "done",
      resultText: "SUBAGENT_PONG_42",
      taskName: "do the thing", // preserved from the registration insert
    });
    // createdAt set on insert, updatedAt advanced on patch.
    expect(rows[0]!.updatedAt).toBeGreaterThanOrEqual(rows[0]!.createdAt);
  });

  test("overflow RECOVERY: error -> done overwrites, purges errorMessage, takes the final telemetry", async () => {
    // The gateway can abandon an attempt with chat:error (mid-turn overflow
    // recovery), truncate tool results, resume the SAME run and finish clean
    // (NAS capture 2026-07-03). The observer keeps observing and delivers BOTH
    // writes; this row must end as a clean success — no stale error text, and
    // the resumed run's FINAL telemetry (not the provisional attempt's).
    const t = convexTest(schema, modules);
    const { chatId } = await seedUserAndChat(t);

    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: CHILD,
      status: "error" as const,
      errorMessage: "Context overflow: prompt too large for the model.",
      telemetry: { runtimeMs: 60_000, totalTokens: 279_947 },
    });
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: CHILD,
      status: "done" as const,
      resultText: "RECOVERED_OK",
      telemetry: { runtimeMs: 141_781, totalTokens: 13_025, estimatedCostUsd: 0.02 },
    });

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("subAgents")
        .withIndex("by_child", (q) => q.eq("childSessionKey", CHILD))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "done",
      resultText: "RECOVERED_OK",
      telemetry: { runtimeMs: 141_781, totalTokens: 13_025, estimatedCostUsd: 0.02 },
    });
    // The provisional error must be PURGED on the recovery transition — a
    // succeeded child card must not keep a stale "Context overflow" banner.
    expect(rows[0]!.errorMessage).toBeUndefined();
  });

  test("a child's STORAGE failure keeps its class; the gateway's sentence never becomes one", async () => {
    // The child path goes through the SAME non-PHI allowlist as the parent message (G-11), so
    // a class missing from it reaches the row as "unknown" and loses its localized title —
    // which is exactly what happened to the two storage classes until they were allowlisted.
    const t = convexTest(schema, modules);
    const { chatId } = await seedUserAndChat(t);

    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: CHILD,
      status: "error" as const,
      errorCode: "gateway_storage_unavailable",
      errorMessage:
        "⚠️ Agent run failed: the Gateway state database was full (SQLite: database or disk is full). Free disk space on the Gateway host and retry.",
    });
    let rows = await t.run(async (ctx) =>
      ctx.db
        .query("subAgents")
        .withIndex("by_child", (q) => q.eq("childSessionKey", CHILD))
        .collect(),
    );
    expect(rows[0]!.errorCode).toBe("gateway_storage_unavailable");

    // The raw sentence is NOT a class: passed as a code it collapses, so no gateway text can
    // ride into the row's code field.
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: `${CHILD}-raw`,
      status: "error" as const,
      errorCode:
        "⚠️ Agent run failed: the Gateway state database was busy (SQLite: database is locked). Retry; if it repeats, check Gateway storage health.",
    });
    rows = await t.run(async (ctx) =>
      ctx.db
        .query("subAgents")
        .withIndex("by_child", (q) => q.eq("childSessionKey", `${CHILD}-raw`))
        .collect(),
    );
    expect(rows[0]!.errorCode).toBe("unknown");
  });

  test("a reaper's NO-ACTIVITY code is provisional: the gateway's later word replaces it", async () => {
    // The bridge's sweep (or Convex's reaper) gives up on a child it saw nothing from and
    // stores `subagent_no_activity`. If the gateway's own terminal then arrives, the code
    // must not keep naming the reaper — neither under the gateway's error sentence (which
    // brought no class of its own), nor on a child that finished after all.
    const t = convexTest(schema, modules);
    const { chatId } = await seedUserAndChat(t);
    const read = (key: string) =>
      t.run(async (ctx) =>
        ctx.db
          .query("subAgents")
          .withIndex("by_child", (q) => q.eq("childSessionKey", key))
          .first(),
      );
    for (const key of [`${CHILD}-err`, `${CHILD}-done`]) {
      await t.mutation(internal.subAgents.upsertSubAgent, {
        chatId,
        childSessionKey: key,
        status: "error" as const,
        errorMessage: "Sub-agent timed out: no activity for 900s and the gateway never reported it finishing.",
        errorCode: "subagent_no_activity",
      });
      expect((await read(key))?.errorCode, key).toBe("subagent_no_activity");
    }
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: `${CHILD}-err`,
      status: "error" as const,
      errorMessage: "tool exploded",
    });
    expect((await read(`${CHILD}-err`))?.errorCode).toBeUndefined();
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: `${CHILD}-done`,
      status: "done" as const,
      resultText: "LATE_BUT_DONE",
    });
    const done = await read(`${CHILD}-done`);
    expect(done?.status).toBe("done");
    expect(done?.errorCode).toBeUndefined();
    // A refresh that says nothing about the failure leaves the verdict alone.
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: `${CHILD}-keep`,
      status: "error" as const,
      errorCode: "subagent_no_activity",
    });
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: `${CHILD}-keep`,
      status: "error" as const,
      telemetry: { runtimeMs: 1 },
    });
    expect((await read(`${CHILD}-keep`))?.errorCode).toBe("subagent_no_activity");
  });

  test("a terminal status is never downgraded back to running (reorder-tolerance)", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seedUserAndChat(t);

    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: CHILD,
      status: "done" as const,
      resultText: "FINAL",
    });
    // A late spawn-registration arriving out of order must NOT un-finalize it.
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: CHILD,
      status: "running" as const,
    });

    const row = await t.run(async (ctx) =>
      ctx.db
        .query("subAgents")
        .withIndex("by_child", (q) => q.eq("childSessionKey", CHILD))
        .unique(),
    );
    expect(row!.status).toBe("done");
    expect(row!.resultText).toBe("FINAL");
  });

  test("sessionMeta MERGES last-known (a later partial never wipes a captured field)", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seedUserAndChat(t);
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: CHILD,
      status: "running" as const,
      sessionMeta: { model: "gpt-5.5", thinkingLevel: "high" },
    });
    // A later frame carries only a NEW field — it must merge, not replace.
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: CHILD,
      status: "running" as const,
      sessionMeta: { fastMode: false, controlScope: "none" },
    });
    const row = await t.run((ctx) =>
      ctx.db
        .query("subAgents")
        .withIndex("by_child", (q) => q.eq("childSessionKey", CHILD))
        .unique(),
    );
    expect(row!.sessionMeta).toEqual({
      model: "gpt-5.5", // preserved across the second upsert
      thinkingLevel: "high",
      fastMode: false, // merged in
      controlScope: "none",
    });
  });
});

describe("subAgents.listSubAgents — owner scoping", () => {
  test("the owner sees their chat's sub-agents", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedUserAndChat(t);
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: CHILD,
      status: "running" as const,
      taskName: "task A",
    });

    const as = t.withIdentity({ subject: `${userId}|session` });
    const rows = await as.query(api.subAgents.listSubAgents, { chatId });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.childSessionKey).toBe(CHILD);
  });

  test("a NON-owner is rejected (the access boundary)", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seedUserAndChat(t, "alice");
    // A second, unrelated user.
    const otherUserId = await t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId: uid, role: "user", canonical: "bob" });
      return uid as Id<"users">;
    });
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: CHILD,
      status: "running" as const,
    });

    const asOther = t.withIdentity({ subject: `${otherUserId}|session` });
    await expect(
      asOther.query(api.subAgents.listSubAgents, { chatId }),
    ).rejects.toThrow(/not owned/i);
  });

  test("returns [] for a chat with no sub-agents", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedUserAndChat(t);
    const as = t.withIdentity({ subject: `${userId}|session` });
    expect(await as.query(api.subAgents.listSubAgents, { chatId })).toEqual([]);
  });
});

// codex P1: the store holds chat content (result/error text) -> it must not outlive its chat.
describe("subAgents cleanup (no orphaned chat content)", () => {
  test("deleting a chat PURGES its sub-agent rows (cascade)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedUserAndChat(t);
    // Raw count via the chat-scoped index (a deleted chat would make the owner-scoped
    // listSubAgents throw, so we read the table directly with the schema-bound `t`).
    const countRows = () =>
      t.run((ctx) =>
        ctx.db
          .query("subAgents")
          .withIndex("by_chat", (q) => q.eq("chatId", chatId))
          .collect(),
      );
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: CHILD,
      status: "done" as const,
      resultText: "private result text",
    });
    expect(await countRows()).toHaveLength(1);
    await t
      .withIdentity({ subject: `${userId}|session` })
      .mutation(api.chats.deleteChat, { chatId });
    await t
      .withIdentity({ subject: `${userId}|session` })
      .mutation(api.trash.purgeChat, { chatId });
    expect(await countRows()).toHaveLength(0); // no orphan left
  });

  test("upsert for a VANISHED chat is ignored (a late child frame never recreates an orphan)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedUserAndChat(t);
    await t
      .withIdentity({ subject: `${userId}|session` })
      .mutation(api.chats.deleteChat, { chatId });
    await t
      .withIdentity({ subject: `${userId}|session` })
      .mutation(api.trash.purgeChat, { chatId });
    // A child frame arrives AFTER the chat is gone.
    const ret = await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: CHILD,
      status: "running" as const,
    });
    expect(ret).toBeNull(); // ignored, not re-inserted
    const orphans = await t.run((ctx) =>
      ctx.db
        .query("subAgents")
        .withIndex("by_child", (q) => q.eq("childSessionKey", CHILD))
        .collect(),
    );
    expect(orphans).toHaveLength(0);
  });
});

describe("subAgents.upsertSubAgentToolPart — per-tool detail (args + result)", () => {
  test("start INSERTS args (running); result PATCHES the SAME row to done + keeps args", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seedUserAndChat(t);
    // start frame: args known, running.
    await t.mutation(internal.subAgents.upsertSubAgentToolPart, {
      chatId,
      childSessionKey: CHILD,
      toolCallId: "call_1",
      name: "exec",
      status: "running" as const,
      argsText: '{"command":"echo hi"}',
    });
    // result frame: output known, done — args omitted (must NOT be wiped).
    await t.mutation(internal.subAgents.upsertSubAgentToolPart, {
      chatId,
      childSessionKey: CHILD,
      toolCallId: "call_1",
      name: "exec",
      status: "done" as const,
      resultText: "hi",
    });

    const rows = await t.run((ctx) =>
      ctx.db
        .query("subAgentToolParts")
        .withIndex("by_child", (q) => q.eq("childSessionKey", CHILD))
        .collect(),
    );
    expect(rows).toHaveLength(1); // upsert by (child, toolCallId) — not appended
    expect(rows[0]).toMatchObject({
      toolCallId: "call_1",
      status: "done",
      argsText: '{"command":"echo hi"}', // set-once survives the result patch
      resultText: "hi",
    });
  });

  test("a terminal tool part is never downgraded back to running (reorder-tolerance)", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seedUserAndChat(t);
    await t.mutation(internal.subAgents.upsertSubAgentToolPart, {
      chatId,
      childSessionKey: CHILD,
      toolCallId: "call_1",
      name: "exec",
      status: "done" as const,
      resultText: "OK",
    });
    // A late running frame for the same call must not un-finish it.
    await t.mutation(internal.subAgents.upsertSubAgentToolPart, {
      chatId,
      childSessionKey: CHILD,
      toolCallId: "call_1",
      name: "exec",
      status: "running" as const,
    });
    const row = await t.run((ctx) =>
      ctx.db
        .query("subAgentToolParts")
        .withIndex("by_child", (q) => q.eq("childSessionKey", CHILD))
        .first(),
    );
    expect(row!.status).toBe("done");
    expect(row!.resultText).toBe("OK");
  });

  test("listSubAgentToolParts is OWNER-SCOPED (owner sees, non-owner rejected)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedUserAndChat(t, "alice");
    await t.mutation(internal.subAgents.upsertSubAgentToolPart, {
      chatId,
      childSessionKey: CHILD,
      toolCallId: "call_1",
      name: "web_search",
      status: "done" as const,
      argsText: '{"query":"news"}',
      resultText: "results...",
    });
    const otherUserId = await t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId: uid, role: "user", canonical: "bob" });
      return uid as Id<"users">;
    });

    const asOwner = t.withIdentity({ subject: `${userId}|session` });
    const rows = await asOwner.query(api.subAgents.listSubAgentToolParts, {
      chatId,
      childSessionKey: CHILD,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "web_search", resultText: "results..." });

    const asOther = t.withIdentity({ subject: `${otherUserId}|session` });
    await expect(
      asOther.query(api.subAgents.listSubAgentToolParts, {
        chatId,
        childSessionKey: CHILD,
      }),
    ).rejects.toThrow(/not owned/i);
  });

  test("deleting a chat PURGES its tool-part rows (cascade — no orphaned content)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedUserAndChat(t);
    await t.mutation(internal.subAgents.upsertSubAgentToolPart, {
      chatId,
      childSessionKey: CHILD,
      toolCallId: "call_1",
      name: "exec",
      status: "done" as const,
      resultText: "private tool output",
    });
    const count = () =>
      t.run((ctx) =>
        ctx.db
          .query("subAgentToolParts")
          .withIndex("by_chat", (q) => q.eq("chatId", chatId))
          .collect(),
      );
    expect(await count()).toHaveLength(1);
    await t
      .withIdentity({ subject: `${userId}|session` })
      .mutation(api.chats.deleteChat, { chatId });
    await t
      .withIdentity({ subject: `${userId}|session` })
      .mutation(api.trash.purgeChat, { chatId });
    expect(await count()).toHaveLength(0); // purged with the chat
  });

  test("upsert for a VANISHED chat is ignored (no orphan tool detail re-created)", async () => {
    const t = convexTest(schema, modules);
    const { userId, chatId } = await seedUserAndChat(t);
    await t
      .withIdentity({ subject: `${userId}|session` })
      .mutation(api.chats.deleteChat, { chatId });
    await t
      .withIdentity({ subject: `${userId}|session` })
      .mutation(api.trash.purgeChat, { chatId });
    const ret = await t.mutation(internal.subAgents.upsertSubAgentToolPart, {
      chatId,
      childSessionKey: CHILD,
      toolCallId: "call_1",
      name: "exec",
      status: "running" as const,
      argsText: "{}",
    });
    expect(ret).toBeNull();
    const orphans = await t.run((ctx) =>
      ctx.db
        .query("subAgentToolParts")
        .withIndex("by_child", (q) => q.eq("childSessionKey", CHILD))
        .collect(),
    );
    expect(orphans).toHaveLength(0);
  });
});

describe("mergeSubAgentTools (Inc 4 — reorder-tolerant child-tool merge)", () => {
  test("appends a new tool, keeping first-seen order", () => {
    expect(
      mergeSubAgentTools(
        [{ name: "exec", status: "done", toolCallId: "c1" }],
        [{ name: "web_search", status: "running", toolCallId: "c2" }],
      ),
    ).toEqual([
      { name: "exec", status: "done", toolCallId: "c1" },
      { name: "web_search", status: "running", toolCallId: "c2" },
    ]);
  });

  test("running -> done flips the same tool (deduped by toolCallId)", () => {
    expect(
      mergeSubAgentTools(
        [{ name: "exec", status: "running", toolCallId: "c1" }],
        [{ name: "exec", status: "done", toolCallId: "c1" }],
      ),
    ).toEqual([{ name: "exec", status: "done", toolCallId: "c1" }]);
  });

  test("a LATE running frame never un-finishes a done tool (the whole point)", () => {
    expect(
      mergeSubAgentTools(
        [{ name: "exec", status: "done", toolCallId: "c1" }],
        [{ name: "exec", status: "running", toolCallId: "c1" }],
      ),
    ).toEqual([{ name: "exec", status: "done", toolCallId: "c1" }]);
  });

  test("undefined incoming leaves the stored list unchanged (same reference)", () => {
    const existing = [{ name: "exec", status: "done" as const, toolCallId: "c1" }];
    expect(mergeSubAgentTools(existing, undefined)).toBe(existing);
  });
});

// A BATCH IS SUCCESSIVE WRITES. The bridge sends the records of one child that arrived
// during a write as one batch; folding them before the row's stored state is known gave a
// different row in five cases a review named (the scenarios below). The batch mutation
// applies the single write's own function per record, so each scenario is asserted as
// "same row as the single writes", plus the one fact the folding got wrong.
describe("subAgents.upsertSubAgentBatch: the row successive writes would leave", () => {
  type T = TestConvex<typeof schema>;
  type Rec = Record<string, unknown> & { status: "running" | "done" | "error" | "aborted" };
  const TASK = "0a1b2c3d-1111-2222-3333-444455556666";

  /** The row as two runs can compare it: no ids of its own, anchors by label. */
  async function rowOf(t: T, labels: Map<string, string>) {
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("subAgents")
        .withIndex("by_child", (q) => q.eq("childSessionKey", CHILD))
        .first(),
    );
    if (row === null) return null;
    const { _id, _creationTime, createdAt, updatedAt, chatId, userId, parentMessageId, gatewayRow, ...rest } = row;
    void _id; void _creationTime; void createdAt; void updatedAt; void chatId; void userId;
    const { readAt: _readAt, ...heldRow } = gatewayRow ?? { readAt: 0 };
    return {
      ...rest,
      parent: parentMessageId === undefined ? null : (labels.get(parentMessageId) ?? "unknown"),
      ...(gatewayRow === undefined ? {} : { gatewayRow: heldRow }),
    };
  }

  /** Run one scenario both ways, on a fresh database each. */
  async function bothWays(
    prepare: (t: T, chatId: Id<"chats">, userId: Id<"users">, labels: Map<string, string>) => Promise<void>,
    records: (labels: Map<string, string>) => Rec[],
  ) {
    const run = async (mode: "single" | "batch") => {
      const t = convexTest(schema, modules);
      const { chatId, userId } = await seedUserAndChat(t);
      const labels = new Map<string, string>();
      await prepare(t, chatId, userId, labels);
      const byLabel = new Map([...labels].map(([id, label]) => [label, id]));
      const list = records(byLabel);
      if (mode === "single") {
        for (const r of list) {
          await t.mutation(internal.subAgents.upsertSubAgent, { chatId, childSessionKey: CHILD, ...r } as never);
        }
      } else {
        // As the bridge does: what a transaction did not write is sent next.
        let rest = list;
        while (rest.length > 0) {
          const { applied } = await t.mutation(internal.subAgents.upsertSubAgentBatch, {
            chatId,
            childSessionKey: CHILD,
            records: rest,
          } as never);
          expect(applied).toBeGreaterThan(0);
          rest = rest.slice(applied);
        }
      }
      return await rowOf(t, labels);
    };
    const single = await run("single");
    const batch = await run("batch");
    expect(batch).toEqual(single);
    return batch!;
  }

  const running = async (t: T, chatId: Id<"chats">) => {
    await t.mutation(internal.subAgents.upsertSubAgent, { chatId, childSessionKey: CHILD, status: "running" });
  };

  test("error then done: the failure's words go, the recovered run's numbers stand", async () => {
    const row = await bothWays(
      async (t, chatId) => running(t, chatId),
      () => [
        { status: "error", errorMessage: "overflow", errorCode: "context_overflow", telemetry: { totalTokens: 10 } },
        { status: "done", resultText: "answer", telemetry: { runtimeMs: 5 } },
      ],
    );
    expect(row).toMatchObject({ status: "done", resultText: "answer", telemetry: { totalTokens: 10, runtimeMs: 5 } });
    expect(row.errorMessage).toBeUndefined();
  });

  test("done then error: the status stays done, and the row carries what the second write supplied", async () => {
    const row = await bothWays(
      async (t, chatId) => running(t, chatId),
      () => [
        { status: "done", resultText: "answer" },
        { status: "error", errorMessage: "timed out", errorCode: "timeout", providerStatus: "timeout" },
      ],
    );
    expect(row).toMatchObject({ status: "done", resultText: "answer", errorMessage: "timed out", providerStatus: "timeout" });
  });

  test("a row already done, then aborted, then error: not associative, so nothing is folded", async () => {
    const row = await bothWays(
      async (t, chatId) => {
        await running(t, chatId);
        await t.mutation(internal.subAgents.upsertSubAgent, { chatId, childSessionKey: CHILD, status: "done" });
      },
      () => [{ status: "aborted" }, { status: "error", errorMessage: "late" }],
    );
    // done -> aborted is taken, aborted -> error is taken: folding the pair first gave
    // `error` over `done`, which the mutation refuses.
    expect(row.status).toBe("error");
  });

  test("a row the gateway holds as live: an `error` record ends nothing, the next record's phase and numbers land", async () => {
    const row = await bothWays(
      async (t, chatId) => {
        await running(t, chatId);
        await t.mutation(internal.subAgents.applySubAgentRowStatus, {
          chatId,
          childSessionKey: CHILD,
          status: "running",
          hasActiveRun: true,
          snapshotAt: 1,
        });
      },
      () => [
        { status: "error", errorMessage: "attempt abandoned", telemetry: { totalTokens: 10 } },
        { status: "running", phase: "start", telemetry: { runtimeMs: 5 } },
      ],
    );
    expect(row).toMatchObject({ status: "running", phase: "start", telemetry: { totalTokens: 10, runtimeMs: 5 } });
  });

  test("a finished row with no numbers: the first late telemetry stands, the second is refused", async () => {
    const row = await bothWays(
      async (t, chatId) => {
        await running(t, chatId);
        await t.mutation(internal.subAgents.upsertSubAgent, { chatId, childSessionKey: CHILD, status: "done" });
      },
      () => [
        { status: "running", telemetry: { totalTokens: 10 } },
        { status: "running", telemetry: { runtimeMs: 5 } },
      ],
    );
    expect(row.telemetry).toEqual({ totalTokens: 10 });
  });

  test("late chain correlation, then a fallback anchor: the inherited anchor is kept", async () => {
    const row = await bothWays(
      async (t, chatId, userId, labels) => {
        const [carrierBubble, fallbackBubble] = await t.run(async (ctx) => {
          const mk = () =>
            ctx.db.insert("messages", {
              chatId,
              userId,
              role: "assistant" as const,
              status: "complete" as const,
              text: "",
              updatedAt: 1,
            });
          return [await mk(), await mk()];
        });
        labels.set(carrierBubble, "carrier-bubble");
        labels.set(fallbackBubble, "fallback-bubble");
        // The task whose delivery run the child is born of, anchored exactly.
        await t.mutation(internal.subAgents.upsertSubAgent, {
          chatId,
          childSessionKey: `task:${TASK}`,
          kind: "task",
          status: "done",
          parentMessageId: carrierBubble,
          anchorExact: true,
        });
        await running(t, chatId);
      },
      (ids) => [
        { status: "running", bornOfRun: `image_generate:${TASK}:ok` },
        { status: "running", parentMessageId: ids.get("fallback-bubble") },
      ],
    );
    expect(row).toMatchObject({ parent: "carrier-bubble", anchorExact: true });
  });

  test("the terminal effects run once per transaction: the batch stops after the record that ran them", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seedUserAndChat(t);
    const records = [
      { status: "running" as const, phase: "a" },
      { status: "running" as const, phase: "b" },
      { status: "done" as const, resultText: "answer" },
      { status: "running" as const, tools: [{ name: "exec", status: "done" as const, toolCallId: "t1" }] },
      { status: "running" as const, tools: [{ name: "read", status: "done" as const, toolCallId: "t2" }] },
    ];
    const send = (rest: typeof records) =>
      t.mutation(internal.subAgents.upsertSubAgentBatch, { chatId, childSessionKey: CHILD, records: rest });
    // Through the end; then one record of the finished row at a time.
    expect(await send(records)).toEqual({ applied: 3 });
    expect(await send(records.slice(3))).toEqual({ applied: 1 });
    expect(await send(records.slice(4))).toEqual({ applied: 1 });
    const row = await rowOf(t, new Map());
    expect(row).toMatchObject({ status: "done", resultText: "answer", phase: "b" });
    expect(row!.tools).toHaveLength(2);
  });

  test("bounded: more records than the cap are refused whole", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seedUserAndChat(t);
    const records = Array.from({ length: MAX_SUBAGENT_BATCH_RECORDS + 1 }, () => ({ status: "running" as const }));
    await expect(
      t.mutation(internal.subAgents.upsertSubAgentBatch, { chatId, childSessionKey: CHILD, records }),
    ).rejects.toThrow(/batch too large/);
    expect(await rowOf(t, new Map())).toBeNull();
    // The cap itself is taken.
    expect(
      await t.mutation(internal.subAgents.upsertSubAgentBatch, {
        chatId,
        childSessionKey: CHILD,
        records: records.slice(1),
      }),
    ).toEqual({ applied: MAX_SUBAGENT_BATCH_RECORDS });
  });

  test("the same per-instance barrier as a single write: another instance's chat is refused, nothing written", async () => {
    const t = convexTest(schema, modules);
    const { chatId } = await seedUserAndChat(t);
    await t.run((ctx) => ctx.db.patch(chatId, { instanceName: "alpha" }));
    await expect(
      t.mutation(internal.subAgents.upsertSubAgentBatch, {
        chatId,
        boundInstanceName: "bravo",
        childSessionKey: CHILD,
        records: [{ status: "running" as const }, { status: "done" as const }],
      }),
    ).rejects.toThrow(/forbidden: cross-instance/);
    expect(await rowOf(t, new Map())).toBeNull();
  });
});
