/// <reference types="vite/client" />
//
// stampNullInstanceChats — the R1 backfill for per-bridge ingest isolation.
// Pins: a null-primary chat whose owner HAS a resolvable agent is stamped with
// exactly the instance dispatch would rebind it to (resolveTargetForChat's
// target); a null-primary chat with NO resolvable agent is LEFT null (it can't
// be dispatched, so no bridge ingests for it — leaving it null denies nothing);
// an already-bound chat is untouched (idempotent).

import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
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
