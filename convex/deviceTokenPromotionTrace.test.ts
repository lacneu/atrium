/// <reference types="vite/client" />
//
// THE TRACE POLICY OF A DEVICE-TOKEN PROMOTION (prod anomaly jh7fkb549k35ssyryz5bhhr6ed8getbk,
// 2026-10-18): 360 `openclaw.device_token.promote` traces in 6 h, all `unchanged`, one per
// instance every two minutes, burying the useful events. A change and a failure are traced
// every time; an `unchanged` promotion at most once an hour per instance, and it writes no
// credential at all.

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { toBase64 } from "./lib/crypto/cipher";
import type { Id } from "./_generated/dataModel";
import type { BridgeConfig } from "../bridge/src/config";
import { deviceTokenPromotion, resetDeviceTokenPromotionStates } from "../bridge/src/core/device-token-promotion";

const modules = import.meta.glob("./**/*.ts");
beforeAll(() => {
  process.env.ATRIUM_SECRET_KEY = toBase64(new Uint8Array(32).fill(7));
});
beforeEach(() => {
  resetDeviceTokenPromotionStates();
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
});
afterEach(() => vi.useRealTimers());

type T = TestConvex<typeof schema>;

async function bridgeOf(t: T, name: string): Promise<Id<"bridgeAuth">> {
  return await t.run(async (ctx) => {
    const instanceId = await ctx.db.insert("instances", { name, gatewayUrl: `ws://${name}` });
    return await ctx.db.insert("bridgeAuth", { instanceId, hashedSecret: `h-${name}`, prefix: "p", lastFour: "0000", createdAt: 0 });
  });
}

const promoteTraces = (t: T) =>
  t.run(async (ctx) => (await ctx.db.query("traceEvents").collect()).filter((e) => e.kind === "openclaw.device_token.promote"));

describe("device-token promotion traces", () => {
  test("two instances, six hours, a promotion every two minutes, no change: at most 12 traces", async () => {
    const t = convexTest(schema, modules);
    const bridges = [await bridgeOf(t, "lacneu"), await bridgeOf(t, "ataraxis")];
    for (let minute = 0; minute < 6 * 60; minute += 2) {
      for (const [i, authId] of bridges.entries()) {
        await t.mutation(internal.bridgeAuth.recordDeviceTokenPromotion, {
          authId,
          instance: i === 0 ? "lacneu" : "ataraxis",
          status: 200,
          outcome: "unchanged",
        });
      }
      vi.advanceTimersByTime(2 * 60 * 1000);
    }
    const traces = await promoteTraces(t);
    expect(traces.length).toBeLessThanOrEqual(12);
    // …and the heartbeat is there: one per instance per hour.
    expect(traces.filter((e) => JSON.parse(e.meta ?? "{}").instance === "lacneu")).toHaveLength(6);
    expect(traces.filter((e) => JSON.parse(e.meta ?? "{}").instance === "ataraxis")).toHaveLength(6);
  });

  test("a change, a superseded token and a failure are always traced, never sampled", async () => {
    const t = convexTest(schema, modules);
    const authId = await bridgeOf(t, "lacneu");
    await t.mutation(internal.bridgeAuth.recordDeviceTokenPromotion, { authId, instance: "lacneu", status: 200, outcome: "unchanged" });
    for (const outcome of ["stored", "superseded", "rejected", "stored", "rejected"] as const) {
      expect(
        await t.mutation(internal.bridgeAuth.recordDeviceTokenPromotion, { authId, instance: "lacneu", status: outcome === "rejected" ? 409 : 200, outcome }),
      ).toBe(true);
    }
    const outcomes = (await promoteTraces(t)).map((e) => JSON.parse(e.meta ?? "{}").outcome);
    expect(outcomes).toEqual(["unchanged", "stored", "superseded", "rejected", "stored", "rejected"]);
  });

  test("an unchanged promotion through the route writes no credential and no second trace", async () => {
    const t = convexTest(schema, modules);
    const instanceId = await t.run((ctx) => ctx.db.insert("instances", { name: "beta", gatewayUrl: "ws://beta" }));
    const admin = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId: id, role: "admin" });
      return id;
    });
    const as = t.withIdentity({ subject: `${admin}|session` });
    const identity = { id: "a".repeat(64), publicKey: "A".repeat(43), privateKey: "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIA==\n-----END PRIVATE KEY-----" };
    await as.action(api.instanceSecrets.setInstanceSecret, { instanceId, field: "token", plaintext: "bootstrap-token" });
    await as.action(api.instanceSecrets.setInstanceSecret, { instanceId, field: "deviceIdentity", plaintext: JSON.stringify(identity) });
    const secret = await as.action(api.bridgeAuth.mintBridgeSecret, { instanceId });
    const promote = () =>
      t.fetch("/bridge/device-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${secret.plaintext}`, "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: identity.id, publicKey: identity.publicKey, token: "paired-device-token" }),
      });
    expect(await (await promote()).json()).toEqual({ ok: true, outcome: "stored" });
    const tokenRow = () =>
      t.run((ctx) => ctx.db.query("instanceSecrets").withIndex("by_instance_field", (q) => q.eq("instanceId", instanceId).eq("field", "token")).unique());
    const before = await tokenRow();
    const auth = () => t.run((ctx) => ctx.db.query("bridgeAuth").withIndex("by_instance", (q) => q.eq("instanceId", instanceId)).unique());
    const lastUsed = (await auth())?.lastUsedAt;
    vi.advanceTimersByTime(60_000);
    expect(await (await promote()).json()).toEqual({ ok: true, outcome: "unchanged" });
    vi.advanceTimersByTime(60_000);
    expect(await (await promote()).json()).toEqual({ ok: true, outcome: "unchanged" });
    const after = await tokenRow();
    expect(after?._creationTime).toBe(before?._creationTime);
    expect(after?.updatedAt).toBe(before?.updatedAt);
    expect((await auth())?.lastUsedAt).toBe(lastUsed);
    // stored + ONE unchanged heartbeat; the second unchanged, a minute later, traces nothing.
    expect((await promoteTraces(t)).map((e) => JSON.parse(e.meta ?? "{}").outcome)).toEqual(["stored", "unchanged"]);
  });

  // Codex review 1 of 0.101.1 [high], THROUGH THE BRIDGE AND CONVEX: A promoted without an
  // issuance time, A presented again WITH one, then B issued later. The bridge's cache must
  // let the second promotion through so Convex records the time, else B is `superseded`.
  test("A undated, A dated, B dated: Convex adopts the time, then rotates to B", async () => {
    const t = convexTest(schema, modules);
    const instanceId = await t.run((ctx) => ctx.db.insert("instances", { name: "gamma", gatewayUrl: "ws://gamma" }));
    const admin = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId: id, role: "admin" });
      return id;
    });
    const as = t.withIdentity({ subject: `${admin}|session` });
    const identity = { id: "b".repeat(64), publicKey: "B".repeat(43), privateKey: "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIA==\n-----END PRIVATE KEY-----" };
    await as.action(api.instanceSecrets.setInstanceSecret, { instanceId, field: "token", plaintext: "bootstrap-token" });
    await as.action(api.instanceSecrets.setInstanceSecret, { instanceId, field: "deviceIdentity", plaintext: JSON.stringify(identity) });
    const secret = await as.action(api.bridgeAuth.mintBridgeSecret, { instanceId });
    const config = {
      kind: "openclaw",
      openclawToken: "bootstrap-token",
      openclawCredentialSource: "provisioner",
      deviceIdentity: identity,
      bridgeInstanceSecret: secret.plaintext,
      convexHttpActionsUrl: "https://convex.example.test",
    } as unknown as BridgeConfig;
    // The bridge's own fetch, routed into this Convex: only the path crosses over.
    const toConvex = (async (url: string | URL | Request, init?: RequestInit) =>
      await t.fetch(new URL(String(url)).pathname, init)) as typeof fetch;
    const promote = deviceTokenPromotion(config, toConvex)!;
    const tokenRow = () =>
      t.run((ctx) => ctx.db.query("instanceSecrets").withIndex("by_instance_field", (q) => q.eq("instanceId", instanceId).eq("field", "token")).unique());

    expect(await promote("token-a")).toBe("stored");
    expect((await tokenRow())?.issuedAtMs).toBeUndefined();
    expect(await promote("token-a", 1000)).toBe("stored");
    expect((await tokenRow())?.issuedAtMs).toBe(1000);
    expect(await promote("token-b", 2000)).toBe("stored");
    expect((await tokenRow())?.issuedAtMs).toBe(2000);
    expect(config.openclawToken).toBe("token-b");
    // And the cadence fix still holds: B again, with the same facts, asks nothing.
    const traces = (await promoteTraces(t)).length;
    expect(await promote("token-b", 2000)).toBe("unchanged");
    expect((await promoteTraces(t)).length).toBe(traces);
  });
});
