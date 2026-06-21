/// <reference types="vite/client" />
//
// Per-bridge auth secret (isolation foundation for 3b). Pins: admin-only mint;
// mint returns a plaintext whose HASH resolves to EXACTLY its instance (proven
// identity, not self-asserted); a WRONG/unknown secret resolves to null; rotation
// REPLACES (old secret stops resolving); revoke removes; deleteInstance cascades.

import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { hashKey } from "./lib/apikeys";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");
const as = (t: TestConvex<typeof schema>, uid: Id<"users">) =>
  t.withIdentity({ subject: `${uid}|session` });

async function seed(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const admin = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId: admin, role: "admin" });
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user" });
    const beta = await ctx.db.insert("instances", {
      name: "beta",
      gatewayUrl: "ws://beta",
    });
    const primary = await ctx.db.insert("instances", {
      name: "primary",
      gatewayUrl: "ws://primary",
    });
    return { admin, userId, beta, primary };
  });
}

const resolve = (t: TestConvex<typeof schema>, plaintext: string) =>
  hashKey(plaintext).then((hash) =>
    t.run((ctx) =>
      ctx.runQuery(internal.bridgeAuth.resolveBridgeInstanceBySecretHash, {
        hash,
      }),
    ),
  );
const authRows = (t: TestConvex<typeof schema>) =>
  t.run((ctx) => ctx.db.query("bridgeAuth").collect());

describe("mintBridgeSecret + resolution (proven instance identity)", () => {
  test("admin mints; the secret resolves to EXACTLY its instance; a wrong secret resolves to null", async () => {
    const t = convexTest(schema, modules);
    const { admin, beta, primary } = await seed(t);
    const betaSecret = await as(t, admin).action(api.bridgeAuth.mintBridgeSecret, {
      instanceId: beta,
    });
    const primarySecret = await as(t, admin).action(
      api.bridgeAuth.mintBridgeSecret,
      { instanceId: primary },
    );
    // Each secret resolves to its OWN instance — and ONLY its own.
    expect((await resolve(t, betaSecret.plaintext))?.instanceName).toBe("beta");
    expect((await resolve(t, primarySecret.plaintext))?.instanceName).toBe(
      "primary",
    );
    expect((await resolve(t, betaSecret.plaintext))?.instanceId).toBe(beta);
    // An unknown / wrong secret resolves to null (no oracle).
    expect(await resolve(t, "oc_live_totallybogus")).toBeNull();
    // Only the HASH is stored — the plaintext appears in NO row.
    const rows = await authRows(t);
    const stored = JSON.stringify(rows);
    expect(stored).not.toContain(betaSecret.plaintext);
    expect(rows.every((r) => r.hashedSecret.length === 64)).toBe(true); // sha256 hex
  });

  test("rotation REPLACES: the old secret stops resolving, the new one resolves", async () => {
    const t = convexTest(schema, modules);
    const { admin, beta } = await seed(t);
    const first = await as(t, admin).action(api.bridgeAuth.mintBridgeSecret, {
      instanceId: beta,
    });
    const second = await as(t, admin).action(api.bridgeAuth.mintBridgeSecret, {
      instanceId: beta,
    });
    expect(second.plaintext).not.toBe(first.plaintext);
    // Exactly one row for the instance (rotation replaced, not appended).
    expect((await authRows(t)).length).toBe(1);
    expect(await resolve(t, first.plaintext)).toBeNull(); // old no longer valid
    expect((await resolve(t, second.plaintext))?.instanceName).toBe("beta");
  });

  test("a non-admin cannot mint (and nothing is stored)", async () => {
    const t = convexTest(schema, modules);
    const { userId, beta } = await seed(t);
    await expect(
      as(t, userId).action(api.bridgeAuth.mintBridgeSecret, { instanceId: beta }),
    ).rejects.toThrow();
    expect(await authRows(t)).toHaveLength(0);
  });
});

describe("revoke + cascade", () => {
  test("revoke removes the secret (it stops resolving); idempotent", async () => {
    const t = convexTest(schema, modules);
    const { admin, beta } = await seed(t);
    const s = await as(t, admin).action(api.bridgeAuth.mintBridgeSecret, {
      instanceId: beta,
    });
    await as(t, admin).mutation(api.bridgeAuth.revokeBridgeSecret, {
      instanceId: beta,
    });
    expect(await resolve(t, s.plaintext)).toBeNull();
    expect(await authRows(t)).toHaveLength(0);
    // Idempotent second revoke.
    await as(t, admin).mutation(api.bridgeAuth.revokeBridgeSecret, {
      instanceId: beta,
    });
  });

  test("deleteInstance purges the bridge secret (a stale hash never resolves to a dead instance)", async () => {
    const t = convexTest(schema, modules);
    const { admin, beta } = await seed(t);
    const s = await as(t, admin).action(api.bridgeAuth.mintBridgeSecret, {
      instanceId: beta,
    });
    await as(t, admin).mutation(api.admin.deleteInstance, { instanceId: beta });
    expect(await resolve(t, s.plaintext)).toBeNull();
    expect(await authRows(t)).toHaveLength(0);
  });

  test("listBridgeAuthStatus returns presence WITHOUT the hash; non-admin refused", async () => {
    const t = convexTest(schema, modules);
    const { admin, userId, beta } = await seed(t);
    await as(t, admin).action(api.bridgeAuth.mintBridgeSecret, {
      instanceId: beta,
    });
    const status = await as(t, admin).query(api.bridgeAuth.listBridgeAuthStatus, {});
    expect(status).toHaveLength(1);
    expect(status[0]!.instanceId).toBe(beta);
    expect(JSON.stringify(status[0])).not.toContain("hashedSecret");
    await expect(
      as(t, userId).query(api.bridgeAuth.listBridgeAuthStatus, {}),
    ).rejects.toThrow();
  });
});
