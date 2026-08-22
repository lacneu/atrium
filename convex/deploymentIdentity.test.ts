/// <reference types="vite/client" />
//
// The identity that decides whether an imported archive came from HERE.
//
// What is pinned: it is minted once and does not move within a deployment (an
// identity that changed would orphan this deployment's own archives), two
// deployments never share one (a collision makes a foreign archive look local —
// the failure the whole mechanism exists to prevent), a database restored
// elsewhere notices and mints its own, and none of this ever touches the
// first-admin bootstrap lock.

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import { DEPLOYMENT_ID_PATTERN } from "./lib/deploymentIdentity";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function activeUser(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "admin" });
    return userId;
  });
}

const ensure = (t: TestConvex<typeof schema>) =>
  t.action(internal.deploymentIdentity.ensureDeploymentId, {});

/** `ensure` where an identity MUST come back — a deployment with nothing merged. */
async function ensureSome(t: TestConvex<typeof schema>): Promise<string> {
  const id = await ensure(t);
  expect(id).not.toBe(null);
  return id!;
}

const commit = (
  t: TestConvex<typeof schema>,
  candidate: string,
  origin: string | null,
) =>
  t.mutation(internal.deploymentIdentity.commitDeploymentId, {
    candidate,
    origin,
  });

/** Pin what the backend reports as its origin, the way a deployment does. */
function atOrigin(origin: string | null): void {
  if (origin === null) delete process.env.CONVEX_CLOUD_URL;
  else process.env.CONVEX_CLOUD_URL = origin;
}

const savedOrigin = process.env.CONVEX_CLOUD_URL;
afterEach(() => {
  if (savedOrigin === undefined) delete process.env.CONVEX_CLOUD_URL;
  else process.env.CONVEX_CLOUD_URL = savedOrigin;
});

const rows = (t: TestConvex<typeof schema>) =>
  t.run((ctx) => ctx.db.query("deploymentIdentity").collect());

describe("deployment identity", () => {
  test("is minted once and does not move within a deployment", async () => {
    const t = convexTest(schema, modules);

    const first = await ensure(t);
    expect(first).toMatch(DEPLOYMENT_ID_PATTERN);
    expect(await ensure(t)).toBe(first);

    expect(await rows(t)).toHaveLength(1);
  });

  test("two deployments never share an identity", async () => {
    // THE property. A shared value would make a foreign archive look local, and
    // reattachment would then run against identifiers that mean something else
    // here. Two fresh deployments run the same code over the same schema, so
    // anything DERIVED from what they contain collides by construction — only
    // real entropy separates them.
    const ids = new Set<string>();
    for (let i = 0; i < 16; i += 1) {
      ids.add(await ensureSome(convexTest(schema, modules)));
    }
    expect(ids.size).toBe(16);
  });

  test("racing mints cannot produce two identities", async () => {
    // Each caller arrives with its OWN candidate — that is what an action-side
    // mint means. The mutation is the only place that can decide between them.
    const t = convexTest(schema, modules);

    const results = await Promise.all(
      Array.from({ length: 8 }, () => ensure(t)),
    );

    expect(new Set(results).size).toBe(1);
    expect(await rows(t)).toHaveLength(1);
  });

  test("a database RESTORED into another deployment mints its own identity", async () => {
    // The row travels with the data. Without this, a clone and its original would
    // share one identity, and each would read the other's archives as local —
    // reattaching them to agents and instances that mean something else there.
    const t = convexTest(schema, modules);
    const original = await commit(t, "atr_" + "a".repeat(32), "https://one.test");

    const afterRestore = await commit(
      t,
      "atr_" + "b".repeat(32),
      "https://two.test",
    );

    expect(afterRestore).not.toBe(original);
    expect(await rows(t)).toHaveLength(1);
    // And the clone is now stable in its own right.
    expect(await commit(t, "atr_" + "c".repeat(32), "https://two.test")).toBe(
      afterRestore,
    );
  });

  test("an origin the backend does not report keeps the identity rather than churning it", async () => {
    // "Cannot tell" is not "has moved". Re-minting on every call because the
    // backend reports nothing would orphan archives continuously.
    const t = convexTest(schema, modules);
    const first = await commit(t, "atr_" + "a".repeat(32), null);

    expect(await commit(t, "atr_" + "b".repeat(32), null)).toBe(first);
    expect(await commit(t, "atr_" + "b".repeat(32), "https://one.test")).toBe(
      first,
    );
  });

  test("an origin that only becomes available later is RECORDED, not left null", async () => {
    // Minted before the backend reported an origin. Leaving the field null for
    // ever would make every later restore undetectable — the one thing it exists
    // for. Recording it must not disturb the identity itself.
    const t = convexTest(schema, modules);
    const minted = await commit(t, "atr_" + "a".repeat(32), null);

    expect(await commit(t, "atr_" + "b".repeat(32), "https://one.test")).toBe(
      minted,
    );

    // ...and the move is detectable from now on, which it would not be if the
    // origin had stayed null.
    expect(
      await commit(t, "atr_" + "c".repeat(32), "https://two.test"),
    ).not.toBe(minted);
  });

  test("a MERGED restore keeps the row that speaks for this deployment", async () => {
    // Two databases restored into one. Taking the first row would re-mint over a
    // row that already matches this origin and delete the correct one — orphaning
    // local archives for nothing.
    const t = convexTest(schema, modules);
    const foreign = "atr_" + "a".repeat(32);
    const mine = "atr_" + "b".repeat(32);
    await t.run(async (ctx) => {
      await ctx.db.insert("deploymentIdentity", {
        deploymentId: foreign,
        mintedForOrigin: "https://other.test",
        mintedAt: 1,
      });
      await ctx.db.insert("deploymentIdentity", {
        deploymentId: mine,
        mintedForOrigin: "https://mine.test",
        mintedAt: 2,
      });
    });

    expect(await commit(t, "atr_" + "c".repeat(32), "https://mine.test")).toBe(
      mine,
    );
    const remaining = await rows(t);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.deploymentId).toBe(mine);
  });

  test("minting NEVER touches the first-admin bootstrap lock", async () => {
    // `appMeta.adminAssigned === false` hands admin to the next sign-in, and
    // `true` closes bootstrap before any admin exists. Neither is a decision this
    // feature may make, so it must not create or modify that row at all.
    const t = convexTest(schema, modules);

    await ensure(t);

    expect(await t.run((ctx) => ctx.db.query("appMeta").collect())).toEqual([]);
  });

  test("reading REFUSES to name an identity among several it cannot tell apart", async () => {
    // Same reason as the mutation: what this returns is what an archive would be
    // stamped with. Picking one of a merged set would have that archive claim an
    // identity that is not this deployment's.
    const t = convexTest(schema, modules);
    const userId = await activeUser(t);
    await t.run(async (ctx) => {
      for (const origin of ["https://one.test", "https://two.test"]) {
        await ctx.db.insert("deploymentIdentity", {
          deploymentId: `atr_${origin.length}`.padEnd(36, "0"),
          mintedForOrigin: origin,
          mintedAt: 1,
        });
      }
    });
    atOrigin(null);

    expect(
      await t
        .withIdentity({ subject: userId })
        .query(api.deploymentIdentity.getDeploymentId, {}),
    ).toBe(null);
  });

  test("an identity already stamped into archives is never rewritten", async () => {
    const t = convexTest(schema, modules);
    // A value that does NOT match the current format — an older mint, or one a
    // future version writes differently. It is still the identity every archive
    // exported so far carries, so "fixing" it would orphan all of them.
    await t.run(async (ctx) => {
      await ctx.db.insert("deploymentIdentity", {
        deploymentId: "legacy-value",
        mintedForOrigin: null,
        mintedAt: 0,
      });
    });

    expect(await ensure(t)).toBe("legacy-value");
  });

  test("reading it requires an authenticated user, and does not mint", async () => {
    const t = convexTest(schema, modules);
    const userId = await activeUser(t);

    await expect(
      t.query(api.deploymentIdentity.getDeploymentId, {}),
    ).rejects.toThrow();

    const asUser = t.withIdentity({ subject: userId });
    // Nothing minted yet: the read says so instead of creating one. A query that
    // minted would put a write on every page load.
    expect(await asUser.query(api.deploymentIdentity.getDeploymentId, {})).toBe(
      null,
    );
    expect(await rows(t)).toHaveLength(0);

    const minted = await ensure(t);
    expect(await asUser.query(api.deploymentIdentity.getDeploymentId, {})).toBe(
      minted,
    );
  });

  test("reading DECLINES an identity minted for another deployment", async () => {
    // A query cannot reconcile — it cannot write. After a database is restored
    // from elsewhere, the stored row still names that other deployment; answering
    // with it would make ITS archives read as local here. "Cannot say" is the safe
    // answer, because an archive of unknown origin is treated as foreign.
    const t = convexTest(schema, modules);
    const userId = await activeUser(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("deploymentIdentity", {
        deploymentId: "atr_" + "a".repeat(32),
        mintedForOrigin: "https://elsewhere.test",
        mintedAt: 1,
      });
    });
    atOrigin("https://here.test");

    expect(
      await t
        .withIdentity({ subject: userId })
        .query(api.deploymentIdentity.getDeploymentId, {}),
    ).toBe(null);

    // Reconciled — the same row, now speaking for this deployment — and it answers.
    atOrigin("https://elsewhere.test");
    expect(
      await t
        .withIdentity({ subject: userId })
        .query(api.deploymentIdentity.getDeploymentId, {}),
    ).toBe("atr_" + "a".repeat(32));
  });

  test("a merge is left ALONE when nothing positively speaks for this deployment", async () => {
    // Two databases restored into one, and the backend reports no origin — so
    // neither row can be shown to be ours. Keeping one arbitrarily would adopt
    // another deployment's identity and make ITS archives read as local here,
    // then delete the evidence.
    const t = convexTest(schema, modules);
    const a = "atr_" + "a".repeat(32);
    const b = "atr_" + "b".repeat(32);
    await t.run(async (ctx) => {
      for (const [deploymentId, mintedForOrigin] of [
        [a, "https://one.test"],
        [b, "https://two.test"],
      ] as const) {
        await ctx.db.insert("deploymentIdentity", {
          deploymentId,
          mintedForOrigin,
          mintedAt: 1,
        });
      }
    });

    // NO identity, rather than one of theirs: the caller would stamp whatever it
    // is handed onto an exported archive.
    expect(await commit(t, "atr_" + "c".repeat(32), null)).toBe(null);

    expect(await rows(t)).toHaveLength(2);
    expect((await rows(t)).map((r) => r.deploymentId).sort()).toEqual([a, b]);
  });

  test("a merge too large to see whole is left ALONE, never re-minted", async () => {
    // The row that speaks for this deployment could be just past the edge of the
    // scan. Concluding "moved" from a partial view would re-mint over a valid
    // local identity and then delete it, orphaning every archive exported here.
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (let i = 0; i < 40; i += 1) {
        await ctx.db.insert("deploymentIdentity", {
          deploymentId: `atr_${String(i).padStart(32, "0")}`,
          mintedForOrigin: `https://other-${i}.test`,
          mintedAt: i,
        });
      }
    });

    // Nothing minted, nothing destroyed, and nothing claimed.
    expect(await commit(t, "atr_" + "f".repeat(32), "https://mine.test")).toBe(
      null,
    );
    expect(await rows(t)).toHaveLength(40);
  });

  test("a malformed stored value reads as absent rather than as an origin", async () => {
    // The read feeds an origin comparison. Returning a value that cannot be one
    // would have an archive match — or fail to match — on nonsense.
    const t = convexTest(schema, modules);
    const userId = await activeUser(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("deploymentIdentity", {
        deploymentId: "legacy-value",
        mintedForOrigin: null,
        mintedAt: 0,
      });
    });

    expect(
      await t
        .withIdentity({ subject: userId })
        .query(api.deploymentIdentity.getDeploymentId, {}),
    ).toBe(null);
  });
});
