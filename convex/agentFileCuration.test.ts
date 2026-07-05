/// <reference types="vite/client" />
//
// Behavioral coverage of the agent-file CURATION state machine — the code the
// 13 Codex hardening rounds rewrote (claim/apply lock, correlate, dispatch
// serialization, PII sweep). Pure helpers live in curation.test.ts; this pins
// the assembled transitions against regression (advisor 2026-07-05). No gateway:
// the bridge-touching apply is NOT exercised here (that path needs a live admin
// UI run before deploy), but every DB transition around it is.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { correlateCuration } from "./agentFileCuration";
import { curationSessionNonce } from "./lib/rehydration";

const modules = import.meta.glob("./**/*.ts");

async function seedAdmin(t: ReturnType<typeof convexTest>) {
  const userId = await t.run(async (ctx) => {
    const uid = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId: uid, role: "admin" });
    return uid;
  });
  return { userId, as: t.withIdentity({ subject: `${userId}|session` }) };
}

async function seedCuration(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  overrides: Partial<{
    status:
      | "dispatched"
      | "proposed"
      | "applying"
      | "applied"
      | "rejected"
      | "failed";
    beforeContent: string;
    proposedContent: string;
  }> = {},
): Promise<Id<"agentFileCurations">> {
  const now = 1_700_000_000_000;
  return await t.run((ctx) =>
    ctx.db.insert("agentFileCurations", {
      instanceName: "primary",
      agentId: "alice",
      name: "MEMORY.md",
      status: overrides.status ?? "proposed",
      baseUpdatedAtMs: 100,
      beforeSize: (overrides.beforeContent ?? "x".repeat(30_000)).length,
      beforeContent: overrides.beforeContent ?? "x".repeat(30_000),
      ...(overrides.proposedContent !== undefined
        ? {
            proposedContent: overrides.proposedContent,
            proposedSize: overrides.proposedContent.length,
          }
        : overrides.status === "proposed"
          ? { proposedContent: "# Memory\n- kept fact", proposedSize: 20 }
          : {}),
      budgetChars: 16_000,
      requestedByUserId: userId,
      trigger: "manual" as const,
      createdAt: now,
      updatedAt: now,
    }),
  );
}

describe("markResolved terminal guard (codex round 3/7)", () => {
  test("never overwrites an APPLIED row (concurrent approve+reject)", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await seedAdmin(t);
    const id = await seedCuration(t, userId, { status: "applied" });
    await t.mutation(internal.agentFileCuration.markResolved, {
      curationId: id,
      status: "failed",
      failureReason: "conflict",
    });
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.status).toBe("applied"); // NOT overwritten by the loser's 409
  });
});

describe("claimForApply transactional lock (codex round 7/8)", () => {
  test("proposed -> applying atomically, then reject is refused and the row stays applying", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await seedAdmin(t);
    const id = await seedCuration(t, userId, {
      status: "proposed",
      proposedContent: "# Memory\n- kept",
    });
    const claim = await t.mutation(internal.agentFileCuration.claimForApply, {
      curationId: id,
    });
    expect(claim).not.toBeNull();
    expect(claim?.proposedContent).toBe("# Memory\n- kept");
    const afterClaim = await t.run((ctx) => ctx.db.get(id));
    expect(afterClaim?.status).toBe("applying");
    // A reject racing the in-flight apply must NOT flip an applying row.
    const rej = await as.mutation(api.agentFileCuration.rejectCuration, {
      curationId: id,
    });
    expect(rej.ok).toBe(false);
    const afterReject = await t.run((ctx) => ctx.db.get(id));
    expect(afterReject?.status).toBe("applying");
  });

  test("claimForApply on a non-proposed row returns null (no double-claim)", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await seedAdmin(t);
    const id = await seedCuration(t, userId, { status: "applying" });
    const claim = await t.mutation(internal.agentFileCuration.claimForApply, {
      curationId: id,
    });
    expect(claim).toBeNull();
  });

  test("releaseApplyClaim reverts applying -> proposed (retryable after a transient error)", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await seedAdmin(t);
    const id = await seedCuration(t, userId, {
      status: "applying",
      proposedContent: "# Memory\n- kept",
    });
    await t.mutation(internal.agentFileCuration.releaseApplyClaim, {
      curationId: id,
    });
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.status).toBe("proposed");
  });
});

describe("rejectCuration (codex round 9/10)", () => {
  test("rejects a proposed row + purges the content copies", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await seedAdmin(t);
    const id = await seedCuration(t, userId, {
      status: "proposed",
      proposedContent: "# Memory\n- kept",
    });
    const res = await as.mutation(api.agentFileCuration.rejectCuration, {
      curationId: id,
    });
    expect(res.ok).toBe(true);
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.status).toBe("rejected");
    expect(row?.beforeContent).toBeUndefined(); // PII purged
    expect(row?.proposedContent).toBeUndefined();
  });

  test("reject with a comment records it (the relaunch seed) + purges content", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await seedAdmin(t);
    const id = await seedCuration(t, userId, {
      status: "proposed",
      proposedContent: "# Memory\n- kept",
    });
    const res = await as.mutation(api.agentFileCuration.rejectCuration, {
      curationId: id,
      comment: "Trop agressif — conserve les références.",
      relaunch: true,
    });
    expect(res.ok).toBe(true);
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.status).toBe("rejected");
    expect(row?.rejectionComment).toBe("Trop agressif — conserve les références.");
    expect(row?.proposedContent).toBeUndefined(); // PII still purged
  });

  test("refuses to reject a still-dispatched (in-flight) job", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await seedAdmin(t);
    const id = await seedCuration(t, userId, { status: "dispatched" });
    const res = await as.mutation(api.agentFileCuration.rejectCuration, {
      curationId: id,
    });
    expect(res.ok).toBe(false);
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.status).toBe("dispatched"); // untouched
  });
});

// --- correlateCuration: the reply -> proposal transition ---------------------

async function seedCuratorChat(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  curationId: Id<"agentFileCurations">,
  createdAt: number,
) {
  return await t.run((ctx) =>
    ctx.db.insert("chats", {
      userId,
      kind: "curator" as const,
      title: "Curation",
      instanceName: "primary",
      agentId: "alice",
      pendingCurate: { curationId, createdAt },
      updatedAt: createdAt,
    }),
  );
}

async function callCorrelate(
  t: ReturnType<typeof convexTest>,
  chatId: Id<"chats">,
  messageId: Id<"messages">,
): Promise<boolean> {
  return await t.run(async (ctx) => {
    const chat = (await ctx.db.get(chatId))!;
    const message = (await ctx.db.get(messageId))!;
    return await correlateCuration(ctx, chat, message);
  });
}

describe("correlateCuration reply -> proposal (codex round 5)", () => {
  const createdAt = 1_700_000_000_000;

  async function seedReply(
    t: ReturnType<typeof convexTest>,
    userId: Id<"users">,
    curationId: Id<"agentFileCurations">,
    chatId: Id<"chats">,
    opts: { status: "complete" | "error"; text: string; goodNonce: boolean },
  ) {
    const nonce = curationSessionNonce(String(curationId), createdAt);
    return await t.run((ctx) =>
      ctx.db.insert("messages", {
        chatId,
        userId,
        role: "assistant" as const,
        status: opts.status,
        text: opts.text,
        turnSessionKey: opts.goodNonce
          ? `agent:alice:curate:x:${nonce}`
          : "agent:alice:curate:x:WRONG",
        updatedAt: createdAt + 1,
      }),
    );
  }

  test("a COMPLETE valid reply -> proposed with content, lock cleared", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await seedAdmin(t);
    const id = await seedCuration(t, userId, {
      status: "dispatched",
      beforeContent: "x".repeat(30_000),
    });
    const chatId = await seedCuratorChat(t, userId, id, createdAt);
    // A REALISTIC rationalization: > 5% of the source (else validateCuration
    // rejects it as a suspiciously-short truncation — which is correct behavior).
    const proposedBody =
      "# Memory\n- kept the one load-bearing fact\n" + "- detail\n".repeat(300);
    const msgId = await seedReply(t, userId, id, chatId, {
      status: "complete",
      text: proposedBody,
      goodNonce: true,
    });
    const settled = await callCorrelate(t, chatId, msgId);
    expect(settled).toBe(true);
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.status).toBe("proposed");
    expect(row?.proposedContent).toContain("load-bearing fact");
    const chat = await t.run((ctx) => ctx.db.get(chatId));
    expect(chat?.pendingCurate).toBeUndefined(); // lock cleared
  });

  test("a NON-complete (error) reply -> failed, no proposal (never a truncated rewrite)", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await seedAdmin(t);
    const id = await seedCuration(t, userId, { status: "dispatched" });
    const chatId = await seedCuratorChat(t, userId, id, createdAt);
    const msgId = await seedReply(t, userId, id, chatId, {
      status: "error",
      text: "# Memory\n- partial",
      goodNonce: true,
    });
    const settled = await callCorrelate(t, chatId, msgId);
    expect(settled).toBe(true);
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.status).toBe("failed");
    expect(row?.failureReason).toBe("incomplete_reply");
    expect(row?.proposedContent).toBeUndefined();
  });

  test("a STALE-nonce reply settles nothing (job untouched)", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await seedAdmin(t);
    const id = await seedCuration(t, userId, { status: "dispatched" });
    const chatId = await seedCuratorChat(t, userId, id, createdAt);
    const msgId = await seedReply(t, userId, id, chatId, {
      status: "complete",
      text: "# Memory\n- from a cancelled job",
      goodNonce: false,
    });
    const settled = await callCorrelate(t, chatId, msgId);
    expect(settled).toBe(false);
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.status).toBe("dispatched"); // NOT settled by a foreign reply
  });
});
