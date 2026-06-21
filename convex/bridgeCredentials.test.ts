/// <reference types="vite/client" />
//
// The /bridge/credentials httpAction END-TO-END (the GLUE the component tests don't
// cover): Bearer parse -> resolve per-bridge secret to its instance -> decrypt ONLY
// that instance's envelopes -> response shape; plus the 401 branches and the
// cross-instance isolation guarantee (a secret returns its OWN instance's creds, never
// another's). Exercised via convex-test's t.fetch, which routes through http.ts.

import { convexTest, type TestConvex } from "convex-test";
import { beforeAll, describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { toBase64 } from "./lib/crypto/cipher";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");
const KEY_B64 = toBase64(new Uint8Array(32).fill(7));
beforeAll(() => {
  process.env.ATRIUM_SECRET_KEY = KEY_B64;
});

const as = (t: TestConvex<typeof schema>, uid: Id<"users">) =>
  t.withIdentity({ subject: `${uid}|session` });

async function seedAdmin(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const admin = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId: admin, role: "admin" });
    return admin;
  });
}
async function seedInstance(t: TestConvex<typeof schema>, name: string) {
  return await t.run((ctx) =>
    ctx.db.insert("instances", { name, gatewayUrl: `ws://${name}` }),
  );
}

const get = (t: TestConvex<typeof schema>, auth?: string) =>
  t.fetch("/bridge/credentials", {
    method: "GET",
    headers: auth ? { Authorization: auth } : {},
  });

describe("/bridge/credentials end-to-end", () => {
  test("a valid per-bridge secret returns ONLY its instance's decrypted creds", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedAdmin(t);
    const beta = await seedInstance(t, "beta");
    const primary = await seedInstance(t, "primary");

    // Store gateway secrets for BOTH instances (so we can prove isolation).
    await as(t, admin).action(api.instanceSecrets.setInstanceSecret, {
      instanceId: beta,
      field: "token",
      plaintext: "beta-token",
    });
    await as(t, admin).action(api.instanceSecrets.setInstanceSecret, {
      instanceId: beta,
      field: "deviceIdentity",
      plaintext: '{"id":"b","publicKey":"bpk","privateKey":"bpem"}',
    });
    await as(t, admin).action(api.instanceSecrets.setInstanceSecret, {
      instanceId: primary,
      field: "token",
      plaintext: "primary-token-SECRET",
    });

    // Mint beta's per-bridge secret.
    const betaSecret = await as(t, admin).action(
      api.bridgeAuth.mintBridgeSecret,
      { instanceId: beta },
    );

    const res = await get(t, `Bearer ${betaSecret.plaintext}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as {
      instanceName: string;
      credentials: Record<string, string>;
    };
    // ISOLATION: beta's secret resolves to beta and returns ONLY beta's creds —
    // never primary's (the cross-instance leak the whole design prevents).
    expect(body.instanceName).toBe("beta");
    expect(body.credentials.token).toBe("beta-token");
    expect(body.credentials.deviceIdentity).toBe(
      '{"id":"b","publicKey":"bpk","privateKey":"bpem"}',
    );
    expect(JSON.stringify(body)).not.toContain("primary-token-SECRET");
  });

  test("no / unknown Bearer secret -> 401, no credentials", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedAdmin(t);
    const beta = await seedInstance(t, "beta");
    await as(t, admin).action(api.instanceSecrets.setInstanceSecret, {
      instanceId: beta,
      field: "token",
      plaintext: "beta-token",
    });

    const noAuth = await get(t);
    expect(noAuth.status).toBe(401);

    const bad = await get(t, "Bearer oc_live_not-a-real-secret");
    expect(bad.status).toBe(401);
    expect(JSON.stringify(await bad.json())).not.toContain("beta-token");
  });

  test("a revoked secret no longer authenticates (401)", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedAdmin(t);
    const beta = await seedInstance(t, "beta");
    const secret = await as(t, admin).action(api.bridgeAuth.mintBridgeSecret, {
      instanceId: beta,
    });
    await as(t, admin).mutation(api.bridgeAuth.revokeBridgeSecret, {
      instanceId: beta,
    });
    const res = await get(t, `Bearer ${secret.plaintext}`);
    expect(res.status).toBe(401);
  });

  test("an instance with no stored secrets returns an empty credentials map", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedAdmin(t);
    const beta = await seedInstance(t, "beta");
    const secret = await as(t, admin).action(api.bridgeAuth.mintBridgeSecret, {
      instanceId: beta,
    });
    const res = await get(t, `Bearer ${secret.plaintext}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { credentials: Record<string, string> };
    expect(body.credentials).toEqual({});
  });
});
