/// <reference types="vite/client" />
//
// NON-INTERACTIVE instance provisioning (POST /api/v1/instances/provision).
//
// Driven THROUGH THE HTTP BOUNDARY with a real minted API key, never by calling
// the action directly. That is deliberate: the route is where the payload is
// validated, kind-discriminated and assembled, and a suite that starts at the
// action would pass while the route silently dropped a field on the way in —
// exactly the defect that shipped in 0.71.8, where fixtures inserted a field by
// hand that the ingest path was discarding.
//
// What is pinned here is the pair of contracts the feature is sold on:
//   - REPLAY-SAFETY, because the caller is a control plane that retries on
//     timeout: a second call must not fork the routing key, must not rotate a
//     secret the installed bridge is using, and must report that it changed
//     nothing;
//   - PARITY with a hand-created instance: provisioning grants NOTHING, so a new
//     entity's gateway stays invisible until an admin curates it. Ungranted users
//     fall into the default-allow all-pool, so a single stray `enabled: true`
//     would expose the new instance company-wide.

import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { ConvexError, type Value } from "convex/values";
import { getFunctionName, type FunctionReference } from "convex/server";
import { api, internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import http from "./http";
import schema from "./schema";
import { hashKey } from "./lib/apikeys";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");

const PROVISION_KEY = "oc_test_provisioner_key";
const READONLY_KEY = "oc_test_observer_key";

/** Seed two service accounts: one that may provision, one that may not. */
async function seed(t: TestConvex<typeof schema>) {
  const provisionHash = await hashKey(PROVISION_KEY);
  const observerHash = await hashKey(READONLY_KEY);
  return await t.run(async (ctx) => {
    const admin = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId: admin, role: "admin" });
    const mk = async (roleKey: string, hashedKey: string) => {
      const serviceAccountId = await ctx.db.insert("serviceAccounts", {
        name: `svc-${roleKey}`,
        roleKey,
        disabled: false,
        createdByUserId: admin,
      });
      await ctx.db.insert("apiKeys", {
        serviceAccountId,
        hashedKey,
        prefix: `oc_test_${roleKey}`,
        lastFour: "key1",
        disabled: false,
        createdAt: Date.now(),
      });
      return serviceAccountId;
    };
    await mk("provisioner", provisionHash);
    await mk("observer", observerHash);
    return { admin };
  });
}

type ProvisionBody = Record<string, unknown>;
type ProvisionResponse = {
  ok: boolean;
  error?: string;
  instance?: string;
  outcome?: "created" | "updated" | "unchanged";
  bridgeSecret?: "minted" | "rotated" | "existing" | "staged";
  secret?: string;
  rotationId?: string;
};

type DeprovisionResponse = {
  ok: boolean;
  error?: string;
  instance?: string;
  outcome?: "deleted" | "absent";
};

async function provision(
  t: TestConvex<typeof schema>,
  body: ProvisionBody,
  key: string = PROVISION_KEY,
): Promise<{ status: number; json: ProvisionResponse }> {
  const res = await t.fetch("/api/v1/instances/provision", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as ProvisionResponse };
}

async function deprovision(
  t: TestConvex<typeof schema>,
  body: Record<string, unknown>,
  key: string = PROVISION_KEY,
): Promise<{ status: number; json: DeprovisionResponse }> {
  const response = await t.fetch("/api/v1/instances/deprovision", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    json: (await response.json()) as DeprovisionResponse,
  };
}

const OPENCLAW: ProvisionBody = {
  name: "compta",
  gatewayUrl: "ws://compta.internal",
  kind: "openclaw",
};

const instances = (t: TestConvex<typeof schema>) =>
  t.run((ctx) => ctx.db.query("instances").collect());

/** Does this plaintext still authenticate as a bridge? */
const resolves = async (t: TestConvex<typeof schema>, plaintext: string) => {
  const hash = await hashKey(plaintext);
  const row = await t.run((ctx) =>
    ctx.runQuery(internal.bridgeAuth.resolveBridgeInstanceBySecretHash, { hash }),
  );
  return row !== null;
};

async function advanceRotation(
  t: TestConvex<typeof schema>, operation: "seal" | "retire", body: unknown,
  key: string = PROVISION_KEY,
) {
  const response = await t.fetch(`/api/v1/instances/bridge-secret/${operation}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json(), headers: response.headers };
}

describe("staged bridge-secret rotation through the authenticated HTTP boundary", () => {
  test.each(["development", "production"] as const)(
    "structured rotation refusals survive the %s error envelope",
    async (deployment) => {
      const t = convexTest(schema, modules);
      await seed(t);
      const original = await provision(t, OPENCLAW);
      const staged = await provision(t, { ...OPENCLAW, stageBridgeSecret: true });
      const handle = { name: OPENCLAW.name, rotationId: staged.json.rotationId };
      // convex-test forwards raw errors. Model only the documented transport
      // boundary: the message changes, while ConvexError.data remains intact.
      const acrossBoundary = async <T,>(call: () => Promise<T>): Promise<T> => {
        try {
          return await call();
        } catch (error) {
          const message = deployment === "development"
            ? `[Request ID: fixture] Uncaught Error: ${String(error)}\n at server/function.ts:1:1`
            : "[Request ID: fixture] Server Error";
          if (error instanceof ConvexError) {
            const wrapped = new ConvexError(error.data);
            wrapped.message = message;
            throw wrapped;
          }
          throw new Error(message);
        }
      };
      let injected: Error | undefined;
      const ctx = {
        runQuery: t.query,
        runMutation: (reference: FunctionReference<"mutation">, args: Record<string, Value> = {}) =>
          acrossBoundary(() => {
            if (injected && getFunctionName(reference) === "instanceProvision:advanceBridgeSecretRotation") {
              throw injected;
            }
            return t.mutation(reference, args);
          }),
        runAction: (reference: FunctionReference<"action">, args: Record<string, Value> = {}) =>
          acrossBoundary(() => {
            if (injected && getFunctionName(reference) === "instanceProvision:provisionInstance") {
              throw injected;
            }
            return t.action(reference, args);
          }),
      } as ActionCtx;
      const request = async (path: string, body: unknown) => {
        const route = http.lookup(path, "POST");
        expect(route).not.toBeNull();
        // This SDK runtime hook is omitted from its public declaration files.
        const handler = Reflect.get(route![0], "_handler") as
          (context: ActionCtx, request: Request) => Promise<Response>;
        return await handler(ctx, new Request(`https://fixture.invalid${path}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${PROVISION_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }));
      };
      for (const [path, body, code] of [
        ["/api/v1/instances/bridge-secret/retire", handle, "bridge_rotation_not_sealed"],
        ["/api/v1/instances/bridge-secret/seal", { ...handle, rotationId: "z".repeat(16) }, "bridge_rotation_not_found"],
        ["/api/v1/instances/provision", { ...OPENCLAW, stageBridgeSecret: true }, "bridge_rotation_pending"],
        ["/api/v1/instances/provision", { ...OPENCLAW, name: "absent", stageBridgeSecret: true }, "bridge_rotation_requires_existing_instance"],
      ] as const) {
        const response = await request(path, body);
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ ok: false, error: code });
        expect(response.headers.get("Cache-Control")).toBe("no-store");
      }
      expect(await resolves(t, original.json.secret!)).toBe(true);
      expect(await resolves(t, staged.json.secret!)).toBe(false);
      await t.run(async (context) => {
        const active = await context.db.query("bridgeAuth").first();
        await context.db.patch("bridgeAuth", active!._id, { hashedSecret: "drift-fixture" });
      });
      const drift = await request("/api/v1/instances/bridge-secret/seal", handle);
      expect(drift.status).toBe(409);
      expect(await drift.json()).toEqual({ ok: false, error: "bridge_rotation_drift" });
      for (const error of [
        new Error("bridge_rotation_drift private-decoy"),
        new ConvexError({ code: "bridge_rotation_drift", detail: "private-decoy" }),
        new ConvexError("unclassified private-decoy"),
      ]) {
        injected = error;
        for (const [path, body, code] of [
          ["/api/v1/instances/bridge-secret/seal", handle, "bridge_rotation_failed"],
          ["/api/v1/instances/bridge-secret/retire", handle, "bridge_rotation_failed"],
          ["/api/v1/instances/provision", OPENCLAW, "provision_failed"],
        ] as const) {
          const response = await request(path, body);
          expect(response.status).toBe(500);
          expect(await response.json()).toEqual({ ok: false, error: code });
        }
      }
      expect(JSON.stringify(await t.run((context) => context.db.query("traceEvents").collect())))
        .not.toContain("private-decoy");
    },
  );

  test("stage is inactive, seal keeps both keys, retire removes only the predecessor", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const original = await provision(t, OPENCLAW);
    const staged = await provision(t, { ...OPENCLAW, stageBridgeSecret: true });
    expect(staged.status).toBe(200);
    expect(staged.json.bridgeSecret).toBe("staged");
    expect(staged.json.rotationId).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    const handle = { name: OPENCLAW.name, rotationId: staged.json.rotationId };
    expect(await resolves(t, original.json.secret!)).toBe(true);
    expect(await resolves(t, staged.json.secret!)).toBe(false);
    const replay = await provision(t, OPENCLAW);
    expect(replay.json.bridgeSecret).toBe("existing");
    expect(replay.json.secret).toBeUndefined();
    expect((await advanceRotation(t, "retire", handle)).status).toBe(409);
    const seal = await advanceRotation(t, "seal", handle);
    expect(seal.json).toEqual({ ok: true, status: "sealed" });
    expect(seal.headers.get("Cache-Control")).toBe("no-store");
    expect(await resolves(t, original.json.secret!)).toBe(true);
    expect(await resolves(t, staged.json.secret!)).toBe(true);
    expect((await advanceRotation(t, "seal", handle)).json).toEqual({ ok: true, status: "already-sealed" });
    expect((await advanceRotation(t, "retire", handle)).json).toEqual({ ok: true, status: "retired" });
    expect(await resolves(t, original.json.secret!)).toBe(false);
    expect(await resolves(t, staged.json.secret!)).toBe(true);
    expect((await advanceRotation(t, "retire", handle)).json).toEqual({ ok: true, status: "already-retired" });
    expect((await advanceRotation(t, "seal", handle)).json).toEqual({ ok: true, status: "already-active" });
    const persisted = await t.run(async (ctx) => ({
      auth: await ctx.db.query("bridgeAuth").collect(),
      rotations: await ctx.db.query("bridgeSecretRotations").collect(),
      events: await ctx.db.query("traceEvents").collect(),
    }));
    expect(persisted.auth).toHaveLength(1);
    expect(persisted.rotations).toHaveLength(1);
    expect(JSON.stringify(persisted)).not.toContain(original.json.secret);
    expect(JSON.stringify(persisted)).not.toContain(staged.json.secret);
    // A completed receipt is replaced, not accumulated as unbounded history.
    const next = await provision(t, { ...OPENCLAW, stageBridgeSecret: true });
    expect(next.status).toBe(200);
    expect(next.json.rotationId).not.toBe(handle.rotationId);
    expect(await t.run((ctx) => ctx.db.query("bridgeSecretRotations").collect())).toHaveLength(1);
    expect((await advanceRotation(t, "retire", handle)).status).toBe(409);
  });

  test("an uncertain stage cannot rotate again or partially change managed configuration", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const original = await provision(t, OPENCLAW);
    expect((await provision(t, { ...OPENCLAW, stageBridgeSecret: true })).status).toBe(200);
    const refused = await provision(t, { ...OPENCLAW, gatewayUrl: "ws://other.internal", stageBridgeSecret: true });
    expect(refused.status).toBe(409);
    expect(refused.json.error).toBe("bridge_rotation_pending");
    expect((await instances(t))[0]!.gatewayUrl).toBe(OPENCLAW.gatewayUrl);
    expect(await resolves(t, original.json.secret!)).toBe(true);
  });

  test("concurrent stages create only one pending candidate", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const original = await provision(t, OPENCLAW);
    const results = await Promise.all([
      provision(t, { ...OPENCLAW, stageBridgeSecret: true }),
      provision(t, { ...OPENCLAW, stageBridgeSecret: true }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(await t.run((ctx) => ctx.db.query("bridgeSecretRotations").collect())).toHaveLength(1);
    expect(await resolves(t, original.json.secret!)).toBe(true);
  });

  test("a delayed ordinary provision cannot replace a credential or invalidate its rotation", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const original = await provision(t, OPENCLAW);
    const staged = await provision(t, { ...OPENCLAW, stageBridgeSecret: true });
    const handle = { name: "compta", rotationId: staged.json.rotationId };
    await advanceRotation(t, "seal", handle);
    const instanceId = (await instances(t))[0]!._id;
    // This is the write boundary of an action whose earlier query saw no key.
    const stored = await t.mutation(internal.instanceProvision.storeProvisionedBridgeSecret, {
      instanceId, hashedSecret: await hashKey("late-provision"), prefix: "test", lastFour: "test",
      principalId: "service", replaceExisting: false,
    });
    expect(stored).toBe(false);
    expect(await resolves(t, original.json.secret!)).toBe(true);
    expect(await resolves(t, staged.json.secret!)).toBe(true);
    expect((await advanceRotation(t, "retire", handle)).json).toEqual({ ok: true, status: "retired" });
  });

  test("concurrent first provisions mint only one active credential", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const results = await Promise.all([provision(t, OPENCLAW), provision(t, OPENCLAW)]);
    expect(results.map((result) => result.json.bridgeSecret).sort()).toEqual(["existing", "minted"]);
    const minted = results.find((result) => result.json.bridgeSecret === "minted")!;
    expect(await resolves(t, minted.json.secret!)).toBe(true);
    expect(await t.run((ctx) => ctx.db.query("bridgeAuth").collect())).toHaveLength(1);
  });

  test("stage refuses absent instances, absent credentials and ambiguous credentials without creating state", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    expect((await provision(t, { ...OPENCLAW, stageBridgeSecret: true })).status).toBe(409);
    expect(await instances(t)).toHaveLength(0);
    await provision(t, OPENCLAW);
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("bridgeAuth").collect())[0]!;
      await ctx.db.delete(row._id);
    });
    expect((await provision(t, { ...OPENCLAW, stageBridgeSecret: true })).json.error).toBe("bridge_rotation_requires_one_secret");
    await provision(t, OPENCLAW);
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("bridgeAuth").collect())[0]!;
      await ctx.db.insert("bridgeAuth", { instanceId: row.instanceId, hashedSecret: "other", prefix: "test", lastFour: "test", createdAt: Date.now() });
    });
    expect((await provision(t, { ...OPENCLAW, stageBridgeSecret: true })).status).toBe(409);
    expect(await t.run((ctx) => ctx.db.query("bridgeSecretRotations").collect())).toHaveLength(0);
  });

  test.each(["seal", "retire"] as const)("%s rejects untrusted bodies and insufficient permissions", async (operation) => {
    const t = convexTest(schema, modules);
    await seed(t);
    const handle = { name: "compta", rotationId: "a".repeat(16) };
    expect((await advanceRotation(t, operation, handle, "invalid")).status).toBe(401);
    expect((await advanceRotation(t, operation, handle, READONLY_KEY)).status).toBe(403);
    for (const body of [null, [], "string", {}, { ...handle, principalId: "spoofed" },
      { ...handle, secret: "forbidden" }, { ...handle, rotationId: "a".repeat(15) },
      { ...handle, rotationId: "a".repeat(129) }, { ...handle, rotationId: "x/".repeat(10) },
      { ...handle, name: " " }, { ...handle, rotationId: 42 }]) {
      expect((await advanceRotation(t, operation, body)).status).toBe(400);
    }
    expect((await advanceRotation(t, operation, handle)).status).toBe(409);
    expect(await instances(t)).toHaveLength(0);
  });

  test("stage validates exact flags and never accepts a caller-supplied identity", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    for (const flags of [{ stageBridgeSecret: "true" }, { stageBridgeSecret: null },
      { stageBridgeSecret: true, rotateBridgeSecret: true }, { principalId: "spoof" }]) {
      expect((await provision(t, { ...OPENCLAW, ...flags })).status).toBe(400);
    }
    expect((await provision(t, { ...OPENCLAW, stageBridgeSecret: true }, READONLY_KEY)).status).toBe(403);
    expect(await instances(t)).toHaveLength(0);
  });

  test("malformed JSON and non-object provision bodies are refused without state", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    for (const path of ["/api/v1/instances/provision", "/api/v1/instances/bridge-secret/seal", "/api/v1/instances/bridge-secret/retire"]) {
      for (const body of ["{", "null", "[]", '"string"']) {
        const response = await t.fetch(path, {
          method: "POST", headers: { Authorization: `Bearer ${PROVISION_KEY}`, "Content-Type": "application/json" }, body,
        });
        expect(response.status).toBe(400);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
      }
    }
    expect(await instances(t)).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query("bridgeSecretRotations").collect())).toHaveLength(0);
  });

  test("another provisioner or instance cannot use the rotation handle", async () => {
    const t = convexTest(schema, modules);
    const { admin } = await seed(t);
    await provision(t, OPENCLAW);
    await provision(t, { ...OPENCLAW, name: "other" });
    const staged = await provision(t, { ...OPENCLAW, stageBridgeSecret: true });
    const hash = await hashKey("second-provisioner");
    await t.run(async (ctx) => {
      const serviceAccountId = await ctx.db.insert("serviceAccounts", {
        name: "other-provisioner", roleKey: "provisioner", disabled: false, createdByUserId: admin,
      });
      await ctx.db.insert("apiKeys", { serviceAccountId, hashedKey: hash, prefix: "test", lastFour: "test", disabled: false, createdAt: Date.now() });
    });
    const handle = { name: "compta", rotationId: staged.json.rotationId };
    for (const operation of ["seal", "retire"] as const) {
      expect((await advanceRotation(t, operation, handle, "second-provisioner")).status).toBe(409);
      expect((await advanceRotation(t, operation, { ...handle, name: "other" })).status).toBe(409);
      expect((await advanceRotation(t, operation, { ...handle, rotationId: "z".repeat(16) })).status).toBe(409);
    }
    expect(await resolves(t, staged.json.secret!)).toBe(false);
  });

  test.each(["staged", "sealed"] as const)("admin revocation, mint and immediate rotation invalidate a %s handle", async (phase) => {
    for (const override of ["revoke", "mint", "rotate"] as const) {
      const t = convexTest(schema, modules);
      const { admin } = await seed(t);
      const original = await provision(t, OPENCLAW);
      const staged = await provision(t, { ...OPENCLAW, stageBridgeSecret: true });
      const handle = { name: "compta", rotationId: staged.json.rotationId };
      if (phase === "sealed") await advanceRotation(t, "seal", handle);
      const instanceId = (await instances(t))[0]!._id;
      const operator = t.withIdentity({ subject: admin });
      if (override === "revoke") await operator.mutation(api.bridgeAuth.revokeBridgeSecret, { instanceId });
      else if (override === "mint") await operator.action(api.bridgeAuth.mintBridgeSecret, { instanceId });
      else await provision(t, { ...OPENCLAW, rotateBridgeSecret: true });
      expect((await advanceRotation(t, "retire", handle)).status).toBe(409);
      expect((await advanceRotation(t, "seal", handle)).status).toBe(409);
      expect(await resolves(t, original.json.secret!)).toBe(false);
      expect(await resolves(t, staged.json.secret!)).toBe(false);
      expect(await t.run((ctx) => ctx.db.query("bridgeSecretRotations").collect())).toHaveLength(0);
    }
  });

  test.each(["staged", "sealed"] as const)("deletion removes the %s receipt and all authentication atomically", async (phase) => {
    const t = convexTest(schema, modules);
    await seed(t);
    const original = await provision(t, OPENCLAW);
    const staged = await provision(t, { ...OPENCLAW, stageBridgeSecret: true });
    const handle = { name: "compta", rotationId: staged.json.rotationId };
    if (phase === "sealed") await advanceRotation(t, "seal", handle);
    expect((await deprovision(t, { name: "compta" })).status).toBe(200);
    expect(await resolves(t, original.json.secret!)).toBe(false);
    expect(await resolves(t, staged.json.secret!)).toBe(false);
    expect(await t.run((ctx) => ctx.db.query("bridgeSecretRotations").collect())).toHaveLength(0);
    expect((await advanceRotation(t, "seal", handle)).status).toBe(409);
  });

  test("predecessor or candidate drift never deletes an unrelated authentication row", async () => {
    for (const target of ["predecessor", "candidate", "extra"] as const) {
      const t = convexTest(schema, modules);
      await seed(t);
      await provision(t, OPENCLAW);
      const staged = await provision(t, { ...OPENCLAW, stageBridgeSecret: true });
      const handle = { name: "compta", rotationId: staged.json.rotationId };
      await advanceRotation(t, "seal", handle);
      await t.run(async (ctx) => {
        const row = (await ctx.db.query("bridgeSecretRotations").collect())[0]!;
        if (target === "extra") await ctx.db.insert("bridgeAuth", {
          instanceId: row.instanceId, hashedSecret: "unrelated", prefix: "test", lastFour: "test", createdAt: Date.now(),
        });
        else await ctx.db.patch(target === "predecessor" ? row.predecessorId : row.candidateId!, { hashedSecret: "changed" });
      });
      const before = await t.run((ctx) => ctx.db.query("bridgeAuth").collect());
      expect((await advanceRotation(t, "retire", handle)).json).toEqual({ ok: false, error: "bridge_rotation_drift" });
      expect(await t.run((ctx) => ctx.db.query("bridgeAuth").collect())).toEqual(before);
    }
  });
});

describe("provisioning is replay-safe", () => {
  test("a retried create patches by NAME instead of forking the routing key", async () => {
    const t = convexTest(schema, modules);
    await seed(t);

    const first = await provision(t, OPENCLAW);
    expect(first.status).toBe(200);
    expect(first.json.outcome).toBe("created");

    // The control plane's HTTP client timed out and retried the same payload.
    const second = await provision(t, OPENCLAW);
    expect(second.status).toBe(200);
    expect(second.json.outcome).toBe("unchanged");

    // ONE row. `name` is the routing key that agents, userAgents, chats and
    // instanceDiscovery all reference — two rows sharing it would have the script
    // configure one while the bridge routes to the other.
    const rows = await instances(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("compta");
  });

  test("a replay does NOT rotate the secret the installed bridge is using", async () => {
    const t = convexTest(schema, modules);
    await seed(t);

    const first = await provision(t, OPENCLAW);
    expect(first.json.bridgeSecret).toBe("minted");
    const plaintext = first.json.secret;
    expect(typeof plaintext).toBe("string");
    expect(await resolves(t, plaintext!)).toBe(true);

    const second = await provision(t, OPENCLAW);
    expect(second.json.bridgeSecret).toBe("existing");
    // No plaintext on a replay: only the hash is stored, so there is nothing
    // truthful to return — and the installed bridge already holds it.
    expect(second.json.secret).toBeUndefined();
    // The decisive assertion: the FIRST secret must still authenticate. A mint on
    // replay would have deleted it and locked the bridge out of its own gateway.
    expect(await resolves(t, plaintext!)).toBe(true);
  });

  test("rotation happens ONLY when asked for explicitly, and invalidates the old secret", async () => {
    const t = convexTest(schema, modules);
    await seed(t);

    const first = await provision(t, OPENCLAW);
    const old = first.json.secret!;

    const rotated = await provision(t, {
      ...OPENCLAW,
      rotateBridgeSecret: true,
    });
    expect(rotated.json.bridgeSecret).toBe("rotated");
    expect(typeof rotated.json.secret).toBe("string");
    expect(rotated.json.secret).not.toBe(old);
    // One active secret per instance: the previous one must stop resolving,
    // otherwise "rotation" would leave a second working credential behind.
    expect(await resolves(t, old)).toBe(false);
    expect(await resolves(t, rotated.json.secret!)).toBe(true);
  });

  test("an unchanged replay does not even touch the row", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await provision(t, OPENCLAW);
    const before = (await instances(t))[0]!;

    await provision(t, OPENCLAW);
    const after = (await instances(t))[0]!;
    // Same document, untouched. The qualification criterion is a second pass with
    // NO persistent change — a patch that rewrites identical values still bumps
    // the row and would show up as a change in any diff taken against it.
    expect(after._id).toBe(before._id);
    expect(after).toEqual(before);
  });

  test("a trusted-proxy replay upgrades posture without rotating the bridge secret", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const created = await provision(t, OPENCLAW);
    const plaintext = created.json.secret!;

    const upgraded = await provision(t, {
      ...OPENCLAW,
      authMode: "trusted-proxy",
      personScopes: "full",
    });
    expect(upgraded.status).toBe(200);
    expect(upgraded.json.outcome).toBe("updated");
    expect(upgraded.json.bridgeSecret).toBe("existing");
    expect(upgraded.json.secret).toBeUndefined();
    expect(await resolves(t, plaintext)).toBe(true);
    expect((await instances(t))[0]).toMatchObject({
      authMode: "trusted-proxy",
      personScopes: "full",
    });

    const replay = await provision(t, {
      ...OPENCLAW,
      authMode: "trusted-proxy",
      personScopes: "full",
    });
    expect(replay.json.outcome).toBe("unchanged");
    expect(replay.json.bridgeSecret).toBe("existing");
  });

  test("an explicit token posture clears stale trusted-proxy scope metadata", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await provision(t, {
      ...OPENCLAW,
      authMode: "trusted-proxy",
      personScopes: "full",
    });

    const downgraded = await provision(t, { ...OPENCLAW, authMode: "token" });
    expect(downgraded.status).toBe(200);
    expect(downgraded.json.outcome).toBe("updated");
    const row = (await instances(t))[0]!;
    expect(row.authMode).toBe("token");
    expect(row.personScopes).toBeUndefined();
  });
});

describe("provisioning grants nothing", () => {
  test("no agent, no user access and no group access are created", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await provision(t, OPENCLAW);

    const granted = await t.run(async (ctx) => ({
      agents: await ctx.db.query("agents").collect(),
      userAgents: await ctx.db.query("userAgents").collect(),
      groupAgents: await ctx.db.query("groupAgents").collect(),
    }));
    // Parity with a hand-created instance. Ungranted users fall into the
    // default-allow all-pool (agents.ts: `direct.length > 0 ? direct :
    // allPoolKeys`), gated only by `enabled` — so a single row written here would
    // expose a new entity's gateway to everyone who has no grant of their own.
    expect(granted.agents).toEqual([]);
    expect(granted.userAgents).toEqual([]);
    expect(granted.groupAgents).toEqual([]);
  });
});

describe("the permission is the gate", () => {
  test("a key without instances.provision is refused and writes nothing", async () => {
    const t = convexTest(schema, modules);
    await seed(t);

    const res = await provision(t, OPENCLAW, READONLY_KEY);
    expect(res.status).toBe(403);
    expect(await instances(t)).toEqual([]);
  });

  test("an unauthenticated call is refused", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const res = await t.fetch("/api/v1/instances/provision", {
      method: "POST",
      body: JSON.stringify(OPENCLAW),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await instances(t)).toEqual([]);
  });
});

describe("a provisioning key can verify its own work", () => {
  const sync = (t: TestConvex<typeof schema>, key: string, instance: string) =>
    t.fetch("/api/v1/instances/sync", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ instance }),
    });

  test("instances.provision reaches /instances/sync", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await provision(t, OPENCLAW);

    // NOT 403. Without this the installer had to carry a second key holding
    // `selfheal`, which outside `admin` lives only in the `agent` role — dragging
    // openclaw.query, trace/KPI reads, feedback.respond and reconcile-chat onto a
    // VPS installer just so it could poke the bridge it had itself created.
    const res = await sync(t, PROVISION_KEY, "compta");
    expect(res.status).not.toBe(403);
  });

  test("a key with neither permission is still refused", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await provision(t, OPENCLAW);
    // The observer key holds neither — widening the gate must not open it to all.
    const res = await sync(t, READONLY_KEY, "compta");
    expect(res.status).toBe(403);
  });

  test("an unknown instance is a clean 404, not a permission answer", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const res = await sync(t, PROVISION_KEY, "never-provisioned");
    expect(res.status).toBe(404);
  });
});

describe("a pre-existing duplicate name is refused, never silently resolved", () => {
  test("two rows sharing a name yield 409 rather than patching whichever sorts first", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("instances", { name: "twin", gatewayUrl: "ws://a" });
      await ctx.db.insert("instances", { name: "twin", gatewayUrl: "ws://b" });
    });

    const res = await provision(t, { name: "twin", gatewayUrl: "ws://c" });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("instance_name_ambiguous");
    // Neither row was touched — a guess here is worse than a refusal.
    const rows = await instances(t);
    expect(rows.map((r) => r.gatewayUrl).sort()).toEqual(["ws://a", "ws://b"]);
  });
});

describe("partial payloads never wipe what an admin set", () => {
  test("an omitted field is LEFT ALONE and an explicit null CLEARS it", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await provision(t, { ...OPENCLAW, gatewayHttpUrl: "http://media" });

    // The control plane replays without the field it never manages.
    const replay = await provision(t, OPENCLAW);
    expect(replay.json.outcome).toBe("unchanged");
    expect((await instances(t))[0]!.gatewayHttpUrl).toBe("http://media");

    // Only an EXPLICIT null unsets it — the caller saying so, not omitting it.
    const cleared = await provision(t, { ...OPENCLAW, gatewayHttpUrl: null });
    expect(cleared.json.outcome).toBe("updated");
    expect((await instances(t))[0]!.gatewayHttpUrl).toBeUndefined();
  });

  test("admin-owned settings survive a provisioning replay", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await provision(t, OPENCLAW);
    const id = (await instances(t))[0]!._id as Id<"instances">;
    // Things the admin UI owns and provisioning must never roll back.
    await t.run((ctx) =>
      ctx.db.patch(id, { streamTransport: "sse", defaultAgentId: "chosen" }),
    );

    await provision(t, { ...OPENCLAW, displayName: "Comptabilité" });
    const row = (await instances(t))[0]!;
    expect(row.streamTransport).toBe("sse");
    expect(row.defaultAgentId).toBe("chosen");
    expect(row.displayName).toBe("Comptabilité");
  });
});

describe("the payload is kind-discriminated", () => {
  test("a Hermes instance takes its transport", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const res = await provision(t, {
      name: "hermes-rh",
      gatewayUrl: "ws://rh",
      kind: "hermes",
      transport: "rest",
    });
    expect(res.status).toBe(200);
    const row = (await instances(t))[0]!;
    expect(row.kind).toBe("hermes");
    expect(row.transport).toBe("rest");
  });

  test("a field that does not apply to the kind is REFUSED, not ignored", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    // The schema says `transport` is ignored for OpenClaw. Accepting it would let
    // a control plane believe a setting took effect when nothing reads it.
    const wrongTransport = await provision(t, { ...OPENCLAW, transport: "ws" });
    expect(wrongTransport.status).toBe(400);
    // Symmetrically, the gateway-version/media overrides are OpenClaw's.
    const wrongVersion = await provision(t, {
      name: "hermes-rh",
      gatewayUrl: "ws://rh",
      kind: "hermes",
      gatewayVersion: "2026.7.1",
    });
    expect(wrongVersion.status).toBe(400);
    expect(await instances(t)).toEqual([]);
  });

  test("an unknown kind is refused", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const res = await provision(t, { ...OPENCLAW, kind: "gemini" });
    expect(res.status).toBe(400);
    expect(await instances(t)).toEqual([]);
  });

  test("OpenClaw authentication posture is validated and never ignored", async () => {
    const t = convexTest(schema, modules);
    await seed(t);

    const invalidMode = await provision(t, {
      ...OPENCLAW,
      authMode: "password",
    });
    expect(invalidMode.status).toBe(400);

    const orphanScope = await provision(t, {
      ...OPENCLAW,
      personScopes: "full",
    });
    expect(orphanScope.status).toBe(400);

    const hermesPosture = await provision(t, {
      name: "hermes-rh",
      gatewayUrl: "ws://rh",
      kind: "hermes",
      authMode: "trusted-proxy",
      personScopes: "full",
    });
    expect(hermesPosture.status).toBe(400);
    expect(await instances(t)).toEqual([]);
  });

  test("unknown provisioning fields are rejected instead of silently dropped", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const res = await provision(t, { ...OPENCLAW, ignoredPosture: "unsafe" });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("unsupported field: ignoredPosture");
    expect(await instances(t)).toEqual([]);
  });
});

describe("the routing key is validated where it can still be fixed", () => {
  test("a malformed name is refused at CREATE", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const res = await provision(t, { ...OPENCLAW, name: "bad name/../x" });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("invalid_instance_name");
    expect(await instances(t)).toEqual([]);
  });

  test("but an instance that ALREADY carries a legacy name stays updatable", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await t.run((ctx) =>
      ctx.db.insert("instances", { name: "legacy name", gatewayUrl: "ws://old" }),
    );
    // Rejecting it here would strand an instance created before the rule existed:
    // the name cannot be changed (it is the routing key), so the script could
    // never manage it again.
    const res = await provision(t, {
      name: "legacy name",
      gatewayUrl: "ws://new",
    });
    expect(res.status).toBe(200);
    expect(res.json.outcome).toBe("updated");
    expect((await instances(t))[0]!.gatewayUrl).toBe("ws://new");
  });
});

describe("a minted secret stays attributable", () => {
  test("the service principal is recorded on the bridgeAuth row", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await provision(t, OPENCLAW);
    const row = (await t.run((ctx) => ctx.db.query("bridgeAuth").collect()))[0]!;
    // `auditLog` cannot hold this — it requires two Id<"users"> and an API key has
    // no user identity. Without this field a minted bridge secret, which unlocks
    // an instance's encrypted gateway credentials, would have no owner at all.
    expect(row.createdByPrincipal).toBeTruthy();
    expect(row.createdBy).toBeUndefined();
  });
});

describe("deprovisioning is replay-safe and fail-closed", () => {
  test("deletes the instance and invalidates its bridge secret", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const created = await provision(t, OPENCLAW);
    const secret = created.json.secret!;

    const removed = await deprovision(t, { name: "compta" });
    expect(removed.status).toBe(200);
    expect(removed.json).toEqual({
      ok: true,
      instance: "compta",
      outcome: "deleted",
    });
    expect(await instances(t)).toEqual([]);
    expect(await resolves(t, secret)).toBe(false);
  });

  test("a replay reports absent without writing anything", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await provision(t, OPENCLAW);
    await deprovision(t, { name: "compta" });

    const replay = await deprovision(t, { name: "compta" });
    expect(replay.status).toBe(200);
    expect(replay.json.outcome).toBe("absent");
    expect(await instances(t)).toEqual([]);
  });

  test("a key without the provision permission cannot remove an instance", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await provision(t, OPENCLAW);

    const denied = await deprovision(t, { name: "compta" }, READONLY_KEY);
    expect(denied.status).toBe(403);
    expect(await instances(t)).toHaveLength(1);
  });

  test("unknown fields are rejected before deletion", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await provision(t, OPENCLAW);

    const rejected = await deprovision(t, {
      name: "compta",
      rotateBridgeSecret: true,
    });
    expect(rejected.status).toBe(400);
    expect(rejected.json.error).toBe("unsupported field: rotateBridgeSecret");
    expect(await instances(t)).toHaveLength(1);
  });

  test("duplicate names yield 409 and neither row is deleted", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("instances", { name: "twin", gatewayUrl: "ws://a" });
      await ctx.db.insert("instances", { name: "twin", gatewayUrl: "ws://b" });
    });

    const rejected = await deprovision(t, { name: "twin" });
    expect(rejected.status).toBe(409);
    expect(rejected.json.error).toBe("instance_name_ambiguous");
    expect(await instances(t)).toHaveLength(2);
  });
});
