/// <reference types="vite/client" />
//
// The child's outcome and cost must actually PERSIST (lot 43 — G-52).
//
// The bridge computes both, the HTTP route relays both — and the mutation dropped both,
// on the insert and on the patch. So the gateway's terminal word and the branch metrics
// existed nowhere, whichever order the events arrived in. The bridge-side tests could not
// see it: they assert what the writer was HANDED, not what the row ends up holding.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
type T = ReturnType<typeof convexTest>;

async function seedChat(t: T) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    return await ctx.db.insert("chats", { userId, updatedAt: 0 });
  });
}

const row = async (t: T, chatId: Id<"chats">) =>
  await t.run(async (ctx) => {
    const rows = await ctx.db.query("subAgents").collect();
    return rows.find((r) => r.chatId === chatId);
  });

const ROLLUP = {
  inputTokens: 1200,
  outputTokens: 340,
  apiCalls: 4,
  durationSeconds: 12.5,
};

describe("upsertSubAgent persists the terminal word and the rollup", () => {
  test("on the INSERT — a complete that arrives with no prior start", async () => {
    // A child can finish before its start relays. Patching only would have lost the
    // metrics entirely on that path.
    const t = convexTest(schema, modules);
    const chatId = await seedChat(t);
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: "hermes:kid-1",
      status: "aborted",
      providerStatus: "interrupted",
      rollup: ROLLUP,
    });
    const r = await row(t, chatId);
    expect(r?.status).toBe("aborted");
    expect(r?.providerStatus).toBe("interrupted");
    expect(r?.rollup).toEqual(ROLLUP);
  });

  test("on the PATCH — a start first, then the terminal", async () => {
    const t = convexTest(schema, modules);
    const chatId = await seedChat(t);
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: "hermes:kid-1",
      status: "running",
    });
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: "hermes:kid-1",
      status: "error",
      providerStatus: "timeout",
      rollup: ROLLUP,
    });
    const r = await row(t, chatId);
    expect(r?.status).toBe("error");
    // …and the distinction the four-state enum cannot hold is kept.
    expect(r?.providerStatus).toBe("timeout");
    expect(r?.rollup).toEqual(ROLLUP);
  });

  test("a later refresh that carries NEITHER does not erase them", async () => {
    // These arrive on the terminal; a running-state refresh landing afterwards must not
    // wipe what the terminal established — the same supplied-only rule `resultText` has.
    const t = convexTest(schema, modules);
    const chatId = await seedChat(t);
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: "hermes:kid-1",
      status: "error",
      providerStatus: "timeout",
      rollup: ROLLUP,
    });
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      childSessionKey: "hermes:kid-1",
      status: "error",
    });
    const r = await row(t, chatId);
    expect(r?.providerStatus).toBe("timeout");
    expect(r?.rollup).toEqual(ROLLUP);
  });
});
