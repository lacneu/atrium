/// <reference types="vite/client" />
//
// stampNullInstanceChats — the R1 backfill for per-bridge ingest isolation.
// Pins: a null-primary chat whose owner HAS a resolvable agent is stamped with
// exactly the instance dispatch would rebind it to (resolveTargetForChat's
// target); a null-primary chat with NO resolvable agent is LEFT null (it can't
// be dispatched, so no bridge ingests for it — leaving it null denies nothing);
// an already-bound chat is untouched (idempotent).

import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");
type T = TestConvex<typeof schema>;

async function seedUser(t: T, canonical: string) {
  return await t.run(async (ctx) => {
    const uid = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId: uid, role: "user" as const, canonical });
    return uid;
  });
}
async function grant(t: T, userId: Id<"users">, instanceName: string, agentId: string) {
  await t.run((ctx) =>
    ctx.db.insert("userAgents", {
      userId,
      instanceName,
      agentId,
      isDefault: true,
      source: "manual" as const,
      createdAt: 1,
    }),
  );
  await t.run((ctx) =>
    ctx.db.insert("agents", {
      instanceName,
      agentId,
      source: "discovered" as const,
      presentInLastOk: true,
      enabled: true,
      firstSeenAt: 1,
      lastSeenAt: 1,
    }),
  );
  await t.run((ctx) =>
    ctx.db.insert("instanceDiscovery", {
      instanceName,
      lastPollAt: 1,
      lastPollOk: true,
      lastOkAt: 1,
    }),
  );
}

describe("stampNullInstanceChats", () => {
  test("stamps a resolvable null chat to dispatch's target; leaves an already-bound chat untouched", async () => {
    const t = convexTest(schema, modules);
    // Owner WITH a default agent on instance "prod".
    const bound = await seedUser(t, "bound");
    await grant(t, bound, "prod", "main");

    const { boundChat, already } = await t.run(async (ctx) => {
      const boundChat = await ctx.db.insert("chats", {
        userId: bound,
        updatedAt: 1,
        // A provider session minted BEFORE binding existed: the stamp must
        // drop it (bindChatTarget's rebind semantics — it may belong to a
        // different agent than the resolved target).
        openclawChatId: "stale-pre-binding-session",
      }); // null instanceName
      const already = await ctx.db.insert("chats", {
        userId: bound,
        updatedAt: 1,
        instanceName: "prod",
        agentId: "main",
      }); // already bound
      return { boundChat, already };
    });

    const res = await t.mutation(internal.migrations.stampNullInstanceChats, {});
    expect(res.done).toBe(true);
    expect(res.stamped).toBe(1);

    const rows = await t.run(async (ctx) => ({
      bound: await ctx.db.get(boundChat),
      already: await ctx.db.get(already),
    }));
    // Resolvable → stamped to EXACTLY the instance dispatch would rebind to,
    // and the pre-binding provider session is dropped (as the rebind would).
    expect(rows.bound?.instanceName).toBe("prod");
    expect(rows.bound?.agentId).toBe("main");
    expect(rows.bound?.openclawChatId ?? null).toBe(null);
    // Already bound → untouched (idempotent).
    expect(rows.already?.instanceName).toBe("prod");
  });

  test("leaves a truly underivable null chat null (no reachable agent → not dispatchable)", async () => {
    const t = convexTest(schema, modules);
    // Owner with NO grants AND no present agents anywhere (empty all-pool) →
    // resolveTargetForChat returns no_agent → the chat cannot be dispatched, so
    // no bridge ingests for it → leaving it null denies nothing.
    const orphan = await seedUser(t, "orphan");
    const orphanChat = await t.run((ctx) =>
      ctx.db.insert("chats", { userId: orphan, updatedAt: 1 }),
    );
    const res = await t.mutation(internal.migrations.stampNullInstanceChats, {});
    expect(res.done).toBe(true);
    expect(res.stamped).toBe(0);
    expect(res.leftNull).toBe(1);
    const row = await t.run((ctx) => ctx.db.get(orphanChat));
    expect(row?.instanceName).toBeUndefined();
  });

  test("countNullInstanceChats reports the residual, and drops to 0 after stamping", async () => {
    const t = convexTest(schema, modules);
    const bound = await seedUser(t, "bound");
    await grant(t, bound, "prod", "main");
    await t.run(async (ctx) => {
      await ctx.db.insert("chats", { userId: bound, updatedAt: 1 });
      await ctx.db.insert("chats", { userId: bound, updatedAt: 1 });
    });
    const before = await t.query(internal.migrations.countNullInstanceChats, {});
    expect(before.nullInstance).toBe(2);
    await t.mutation(internal.migrations.stampNullInstanceChats, {});
    const after = await t.query(internal.migrations.countNullInstanceChats, {});
    expect(after.nullInstance).toBe(0);
  });
});

describe("maskStoredCredentialIds — the rows written before the masker existed", () => {
  test("clears the id from all three tables in ONE invocation", async () => {
    // Fixing the ROWS is what makes every reader safe at once — the chat query, the
    // sub-agent queries, a feedback snapshot, a sub-agent report, the dev helpers.
    // Masking each of those instead would mean keeping that list correct forever, and
    // it was already five long without being complete (codex).
    const t = convexTest(schema, modules);
    const RAW =
      'Auth profile "openai:olivier@lacneu.com" is temporarily unavailable for openai/x.';
    const ids = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1 });
      const messageId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "error" as const,
        text: "",
        error: RAW,
        updatedAt: 1,
      });
      const childId = await ctx.db.insert("subAgents", {
        chatId,
        childSessionKey: "c1",
        status: "error" as const,
        errorMessage: RAW,
        updatedAt: 1,
        createdAt: 1,
      });
      const interactionId = await ctx.db.insert("subAgentInteractions", {
        chatId,
        childSessionKey: "c1",
        userText: "q",
        status: "error" as const,
        errorMessage: RAW,
        createdAt: 1,
        updatedAt: 1,
      });
      // …and one row that must come out untouched.
      const otherId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "error" as const,
        text: "",
        error: "fetch failed",
        updatedAt: 1,
      });
      return { messageId, childId, interactionId, otherId };
    });

    // The migration self-chains one table at a time, so fake timers go in BEFORE the
    // call that schedules, then the chain is run to the end.
    vi.useFakeTimers();
    await t.mutation(internal.migrations.maskStoredCredentialIds, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();

    const after = await t.run(async (ctx) => ({
      message: await ctx.db.get(ids.messageId),
      child: await ctx.db.get(ids.childId),
      interaction: await ctx.db.get(ids.interactionId),
      other: await ctx.db.get(ids.otherId),
    }));
    expect(after.message?.error).toBe('Auth profile "…');
    expect(after.child?.errorMessage).toBe('Auth profile "…');
    expect(after.interaction?.errorMessage).toBe('Auth profile "…');
    expect(after.other?.error).toBe("fetch failed");
  });

  test("clears the FROZEN snapshots too — a report outlives its row", async () => {
    // A feedback report and a sub-agent report copy the sentence and keep it, so fixing
    // the live rows alone left them holding the id forever — and the incident that
    // opened this lot was found IN one of those snapshots (codex).
    const t = convexTest(schema, modules);
    const RAW =
      'Auth profile "openai:olivier@lacneu.com" is temporarily unavailable for openai/x.';
    const ids = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1 });
      const messageId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "error" as const,
        text: "",
        updatedAt: 1,
      });
      const subAgentId = await ctx.db.insert("subAgents", {
        chatId,
        childSessionKey: "c1",
        status: "error" as const,
        updatedAt: 1,
        createdAt: 1,
      });
      const feedbackId = await ctx.db.insert("feedback", {
        userId,
        realUserId: userId,
        impersonated: false,
        chatId,
        messageId,
        at: 1,
        category: "api_error",
        snapshot: {
          messageRole: "assistant",
          messageText: "",
          messageStatus: "error",
          messageError: RAW,
          partsCount: 0,
          contextCount: 0,
          displayedText: "",
          displayedMatchesStored: true,
        },
      });
      const reportId = await ctx.db.insert("subAgentReports", {
        userId,
        realUserId: userId,
        impersonated: false,
        chatId,
        subAgentId,
        at: 1,
        snapshot: {
          flaggedChildSessionKey: "c1",
          totalCount: 1,
          failedCount: 1,
          children: [
            {
              childSessionKey: "c1",
              status: "error",
              errorMessage: RAW,
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        },
      });
      return { feedbackId, reportId };
    });

    vi.useFakeTimers();
    await t.mutation(internal.migrations.maskStoredCredentialIds, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();

    const after = await t.run(async (ctx) => ({
      feedback: await ctx.db.get(ids.feedbackId),
      report: await ctx.db.get(ids.reportId),
    }));
    // BOTH snapshot tables: the case was named for them but only asserted the report,
    // so removing the `feedback` branch left it green (codex).
    expect(after.feedback?.snapshot.messageError).toBe('Auth profile "…');
    expect(after.report?.snapshot.children[0]?.errorMessage).toBe('Auth profile "…');
  });

  test("pages the SNAPSHOT tables smaller than the rest", async () => {
    // A `subAgentReports` snapshot carries bounded but large content — four 10 KB fields
    // per captured child plus parentText and sessionMetaJson, ~850 KB worst case — so
    // 200 of them would blow past Convex's 16 MiB per-transaction limit, and the
    // mutation would throw before scheduling the next page, leaving the rest unmasked
    // (codex). Asserted by BEHAVIOUR: one invocation, no scheduler drain, and the count
    // it reports is the page size it used. BOTH snapshot tables, since the rule names
    // both and asserting one left the other free.
    const t = convexTest(schema, modules);
    const RAW = 'Auth profile "openai:someone@example.com" is temporarily unavailable.';
    await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1 });
      const subAgentId = await ctx.db.insert("subAgents", {
        chatId,
        childSessionKey: "c1",
        status: "error" as const,
        updatedAt: 1,
        createdAt: 1,
      });
      for (let i = 0; i < 8; i++) {
        await ctx.db.insert("subAgentReports", {
          userId,
          realUserId: userId,
          impersonated: false,
          chatId,
          subAgentId,
          at: 1,
          snapshot: {
            flaggedChildSessionKey: "c1",
            totalCount: 1,
            failedCount: 1,
            children: [
              {
                childSessionKey: "c1",
                status: "error",
                errorMessage: RAW,
                createdAt: 1,
                updatedAt: 1,
              },
            ],
          },
        });
      }
    });

    // Straight to that table, one page, nothing drained.
    const res = await t.mutation(internal.migrations.maskStoredCredentialIds, {
      table: "subAgentReports",
    });
    expect(res.done, "8 rows fitted in one page — the small size is not in effect").toBe(
      false,
    );
    expect(res.masked).toBe(5);

    // …and `feedback`, which carries a snapshot of comparable weight.
    await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1 });
      const messageId = await ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "error" as const,
        text: "",
        updatedAt: 1,
      });
      for (let i = 0; i < 8; i++) {
        await ctx.db.insert("feedback", {
          userId,
          realUserId: userId,
          impersonated: false,
          chatId,
          messageId,
          at: 1,
          category: "api_error",
          snapshot: {
            messageRole: "assistant",
            messageText: "",
            messageStatus: "error",
            messageError: RAW,
            partsCount: 0,
            contextCount: 0,
            displayedText: "",
            displayedMatchesStored: true,
          },
        });
      }
    });
    const fb = await t.mutation(internal.migrations.maskStoredCredentialIds, {
      table: "feedback",
    });
    expect(fb.done, "8 feedback rows fitted in one page").toBe(false);
    expect(fb.masked).toBe(5);
  });

  test("a page is bounded in BYTES, not only in rows", async () => {
    // A row count was the wrong bound twice: this query reads whole DOCUMENTS, and a
    // message near the 1 MiB document limit makes any fixed count unsafe — the page
    // would exceed the transaction's read limit and throw before scheduling the next
    // one, leaving the backfill silently unfinished (codex).
    const t = convexTest(schema, modules);
    const RAW = 'Auth profile "openai:someone@example.com" is temporarily unavailable.';
    const BIG = "x".repeat(600_000); // well under the document limit, big in a page
    await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1 });
      for (let i = 0; i < 12; i++) {
        await ctx.db.insert("messages", {
          chatId,
          userId,
          role: "assistant" as const,
          status: "error" as const,
          text: BIG,
          error: RAW,
          updatedAt: 1,
        });
      }
    });

    // Twelve rows is far under the 200-row ceiling, so only a BYTE bound can stop the
    // page early.
    const res = await t.mutation(internal.migrations.maskStoredCredentialIds, {
      table: "messages",
    });
    expect(res.done, "the whole 7 MB of rows went into one page").toBe(false);

    // …and the chain still finishes the table.
    vi.useFakeTimers();
    await t.mutation(internal.migrations.maskStoredCredentialIds, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();
    const left = await t.run(async (ctx) => {
      const all = await ctx.db.query("messages").collect();
      return all.filter((m) => (m.error ?? "").includes("someone@example.com")).length;
    });
    expect(left).toBe(0);
  });

  test("drains a table LARGER than one page", async () => {
    // Nothing exercised the continuation: with fewer than BATCH rows, deleting the
    // self-chaining `runAfter` entirely left the suite green (codex). One table over
    // the page size is the smallest thing that can tell them apart.
    const t = convexTest(schema, modules);
    const RAW = 'Auth profile "openai:someone@example.com" is temporarily unavailable for x.';
    const OVER_ONE_PAGE = 205;
    await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1 });
      for (let i = 0; i < OVER_ONE_PAGE; i++) {
        await ctx.db.insert("messages", {
          chatId,
          userId,
          role: "assistant" as const,
          status: "error" as const,
          text: "",
          error: RAW,
          updatedAt: 1,
        });
      }
    });

    vi.useFakeTimers();
    await t.mutation(internal.migrations.maskStoredCredentialIds, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();

    const left = await t.run(async (ctx) => {
      const all = await ctx.db.query("messages").collect();
      return all.filter((m) => (m.error ?? "").includes("someone@example.com")).length;
    });
    expect(left, "rows past the first page kept the credential id").toBe(0);
  });

  test("is IDEMPOTENT — a second run over REAL rows changes nothing", async () => {
    const t = convexTest(schema, modules);
    const messageId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const chatId = await ctx.db.insert("chats", { userId, updatedAt: 1 });
      return ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: "error" as const,
        text: "",
        // A RAW row, so the first run has real work to do — pre-inserting an
        // already-masked value and running once proved nothing (codex).
        error: 'Auth profile "openai:someone@example.com" is temporarily unavailable.',
        updatedAt: 1,
      });
    });

    vi.useFakeTimers();
    const first = await t.mutation(internal.migrations.maskStoredCredentialIds, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(first.masked).toBe(1);
    const second = await t.mutation(internal.migrations.maskStoredCredentialIds, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();
    expect(second.masked).toBe(0);
    expect(await t.run((ctx) => ctx.db.get(messageId))).toMatchObject({
      error: 'Auth profile "…',
    });
  });
});
