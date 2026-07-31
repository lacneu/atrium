/// <reference types="vite/client" />
//
// Bounding a session's refresh-token chain (2026-07-31).
//
// The defect this guards is a SIGN-IN OUTAGE, not a tidiness concern.
// `@convex-dev/auth` mints a refresh token per session refresh and chains them, and
// its `deleteAllRefreshTokens` collects EVERY token of a session without pagination.
// Nothing prunes the chain, so ordinary use grows it until that collect exceeds
// Convex's 4096-read limit — at which point the refresh inside sign-in throws and
// nobody using that session can log in again. Observed on a real backend with ~5000
// tokens on ONE session, reported as an error naming a library internal.
//
// So what is asserted here is the property the failing call needs: after a prune, a
// session's chain is SHORT. Counting deletions would pass while leaving the chain
// long — the first version of the prune did exactly that (it scanned the table
// unindexed with `.take()`, freed thousands of unrelated expired rows, reported
// success and never touched the session that was blocking).

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

/** A session with `n` refresh tokens chained to it. */
async function seedChain(
  t: ReturnType<typeof convexTest>,
  n: number,
): Promise<Id<"authSessions">> {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const sessionId = await ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 86_400_000,
    });
    for (let i = 0; i < n; i += 1) {
      await ctx.db.insert("authRefreshTokens", {
        sessionId,
        expirationTime: Date.now() + 86_400_000,
      });
    }
    return sessionId;
  });
}

const chainLength = async (
  t: ReturnType<typeof convexTest>,
  sessionId: Id<"authSessions">,
): Promise<number> =>
  await t.run(async (ctx) => {
    const rows = await ctx.db
      .query("authRefreshTokens")
      .withIndex("sessionIdAndParentRefreshTokenId", (q) =>
        q.eq("sessionId", sessionId),
      )
      .collect();
    return rows.length;
  });

describe("a session's refresh-token chain stays short", () => {
  test("a long chain is trimmed", async () => {
    const t = convexTest(schema, modules);
    const sessionId = await seedChain(t, 400);
    await t.mutation(internal.authPrune.pruneRefreshTokenChains, {});
    const left = await chainLength(t, sessionId);
    expect(
      left,
      "the chain must end SHORT — this is what `deleteAllRefreshTokens` has to read",
    ).toBeLessThanOrEqual(16);
  });

  test("the NEWEST tokens are the ones kept", async () => {
    // Trimming the wrong end would log the user out on the next refresh: the current
    // token is the newest one, and it is the only one the library still needs.
    const t = convexTest(schema, modules);
    const sessionId = await seedChain(t, 100);
    const newestBefore = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("authRefreshTokens")
        .withIndex("sessionIdAndParentRefreshTokenId", (q) =>
          q.eq("sessionId", sessionId),
        )
        .collect();
      return [...rows].sort((a, b) => b._creationTime - a._creationTime)[0]?._id;
    });
    await t.mutation(internal.authPrune.pruneRefreshTokenChains, {});
    const stillThere = await t.run((ctx) => ctx.db.get(newestBefore as Id<"authRefreshTokens">));
    expect(stillThere, "the current token must survive the prune").not.toBeNull();
  });

  test("a chain already short is left alone", async () => {
    const t = convexTest(schema, modules);
    const sessionId = await seedChain(t, 3);
    await t.mutation(internal.authPrune.pruneRefreshTokenChains, {});
    expect(await chainLength(t, sessionId)).toBe(3);
  });

  test("one session's long chain does not cost another session its tokens", async () => {
    // The prune walks sessions; a bug in the walk would trim the wrong one, and the
    // symptom (someone logged out) would look nothing like its cause.
    const t = convexTest(schema, modules);
    const big = await seedChain(t, 300);
    const small = await seedChain(t, 5);
    await t.mutation(internal.authPrune.pruneRefreshTokenChains, {});
    expect(await chainLength(t, big)).toBeLessThanOrEqual(16);
    expect(await chainLength(t, small)).toBe(5);
  });
});
