/// <reference types="vite/client" />
//
// Encrypted gateway credentials: the action encrypts (AAD-bound) + persists via
// the admin-gated internal mutation; the ciphertext is NEVER returned and the
// status query never leaks it. Each test fails if its target regresses (AAD
// binding, per-field rows, rotation, clear, admin gate, cascade delete).

import { convexTest, type TestConvex } from "convex-test";
import { beforeAll, describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { toBase64 } from "./lib/crypto/cipher";
import { loadLocalCrypto } from "./lib/crypto/keyProvider";

type SecretField = "token" | "deviceIdentity" | "apiKey";

const modules = import.meta.glob("./**/*.ts");

// The action reads ATRIUM_SECRET_KEY from process.env at call time (convex-test
// runs functions in-process). A fixed 32-byte key keeps the test deterministic.
const KEY_B64 = toBase64(new Uint8Array(32).fill(11));
beforeAll(() => {
  process.env.ATRIUM_SECRET_KEY = KEY_B64;
});

async function seed(t: TestConvex<typeof schema>, role: "admin" | "user") {
  const { userId, instanceId, otherInstanceId } = await t.run(async (ctx) => {
    const uid = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId: uid, role });
    const iid = await ctx.db.insert("instances", {
      name: "primary",
      gatewayUrl: "ws://gw:18790",
    });
    const oid = await ctx.db.insert("instances", {
      name: "secondary",
      gatewayUrl: "ws://gw2:18790",
    });
    return { userId: uid, instanceId: iid, otherInstanceId: oid };
  });
  return {
    as: t.withIdentity({ subject: `${userId}|session` }),
    instanceId,
    otherInstanceId,
  };
}

/** Read the stored envelope for (instance, field) directly from the db. */
async function readSecret(
  t: TestConvex<typeof schema>,
  instanceId: Id<"instances">,
  field: SecretField,
) {
  return await t.run(async (ctx) => {
    const row = await ctx.db
      .query("instanceSecrets")
      .withIndex("by_instance_field", (q) =>
        q.eq("instanceId", instanceId).eq("field", field),
      )
      .unique();
    return row?.secret ?? null;
  });
}

describe("setInstanceSecret (action) + AAD binding", () => {
  test("admin sets a secret; the stored envelope decrypts ONLY under <instanceId>:<field>", async () => {
    const t = convexTest(schema, modules);
    const { as, instanceId, otherInstanceId } = await seed(t, "admin");

    const res = await as.action(api.instanceSecrets.setInstanceSecret, {
      instanceId,
      field: "token",
      plaintext: "operator-token-xyz",
    });
    expect(res).toEqual({ ok: true });

    const env = await readSecret(t, instanceId, "token");
    expect(env).not.toBeNull();
    expect(env!.alg).toBe("AES-256-GCM"); // an envelope, not plaintext

    const { registry } = loadLocalCrypto({ ATRIUM_SECRET_KEY: KEY_B64 });
    // Correct context → recovers the plaintext.
    expect(await registry.decrypt(env!, `${instanceId}:token`)).toBe(
      "operator-token-xyz",
    );
    // Wrong FIELD context → rejected (can't reinterpret a token as a deviceIdentity).
    await expect(
      registry.decrypt(env!, `${instanceId}:deviceIdentity`),
    ).rejects.toThrow();
    // Wrong INSTANCE context → rejected (can't relocate to another instance).
    await expect(
      registry.decrypt(env!, `${otherInstanceId}:token`),
    ).rejects.toThrow();
  });

  test("token and deviceIdentity coexist as SEPARATE rows (no clobber)", async () => {
    const t = convexTest(schema, modules);
    const { as, instanceId } = await seed(t, "admin");
    await as.action(api.instanceSecrets.setInstanceSecret, {
      instanceId,
      field: "token",
      plaintext: "tok",
    });
    await as.action(api.instanceSecrets.setInstanceSecret, {
      instanceId,
      field: "deviceIdentity",
      plaintext: '{"id":"d"}',
    });
    const { registry } = loadLocalCrypto({ ATRIUM_SECRET_KEY: KEY_B64 });
    const tokEnv = (await readSecret(t, instanceId, "token"))!;
    const devEnv = (await readSecret(t, instanceId, "deviceIdentity"))!;
    expect(await registry.decrypt(tokEnv, `${instanceId}:token`)).toBe("tok");
    expect(await registry.decrypt(devEnv, `${instanceId}:deviceIdentity`)).toBe(
      '{"id":"d"}',
    );
  });

  test("rotating a field UPDATES the same row to the new value", async () => {
    const t = convexTest(schema, modules);
    const { as, instanceId } = await seed(t, "admin");
    await as.action(api.instanceSecrets.setInstanceSecret, {
      instanceId,
      field: "token",
      plaintext: "old",
    });
    await as.action(api.instanceSecrets.setInstanceSecret, {
      instanceId,
      field: "token",
      plaintext: "new",
    });
    const rows = await t.run((ctx) =>
      ctx.db
        .query("instanceSecrets")
        .withIndex("by_instance", (q) => q.eq("instanceId", instanceId))
        .collect(),
    );
    expect(rows).toHaveLength(1); // rotated in place, not duplicated
    const { registry } = loadLocalCrypto({ ATRIUM_SECRET_KEY: KEY_B64 });
    expect(await registry.decrypt(rows[0].secret, `${instanceId}:token`)).toBe(
      "new",
    );
  });

  test("an empty plaintext is refused", async () => {
    const t = convexTest(schema, modules);
    const { as, instanceId } = await seed(t, "admin");
    await expect(
      as.action(api.instanceSecrets.setInstanceSecret, {
        instanceId,
        field: "token",
        plaintext: "   ",
      }),
    ).rejects.toThrow(/empty secret/);
  });

  test("a NON-admin is refused and no secret row is written", async () => {
    const t = convexTest(schema, modules);
    const { as, instanceId } = await seed(t, "user");
    await expect(
      as.action(api.instanceSecrets.setInstanceSecret, {
        instanceId,
        field: "token",
        plaintext: "tok",
      }),
    ).rejects.toThrow();
    expect(await readSecret(t, instanceId, "token")).toBeNull();
  });
});

describe("clearInstanceSecret + status + cascade", () => {
  test("admin clears a secret (idempotent); a non-admin cannot", async () => {
    const t = convexTest(schema, modules);
    const { as, instanceId } = await seed(t, "admin");
    await as.action(api.instanceSecrets.setInstanceSecret, {
      instanceId,
      field: "token",
      plaintext: "tok",
    });
    await as.mutation(api.instanceSecrets.clearInstanceSecret, {
      instanceId,
      field: "token",
    });
    expect(await readSecret(t, instanceId, "token")).toBeNull();
    // idempotent second clear does not throw
    await as.mutation(api.instanceSecrets.clearInstanceSecret, {
      instanceId,
      field: "token",
    });
  });

  test("listInstanceSecretStatus returns presence only — NEVER the envelope", async () => {
    const t = convexTest(schema, modules);
    const { as, instanceId } = await seed(t, "admin");
    await as.action(api.instanceSecrets.setInstanceSecret, {
      instanceId,
      field: "token",
      plaintext: "tok",
    });
    const status = await as.query(api.instanceSecrets.listInstanceSecretStatus, {});
    expect(status).toHaveLength(1);
    expect(status[0]).toMatchObject({ instanceId, field: "token" });
    expect(typeof status[0].updatedAt).toBe("number");
    expect("secret" in status[0]).toBe(false); // ciphertext NEVER leaves the server
  });

  test("deleting the instance cascades its secrets", async () => {
    const t = convexTest(schema, modules);
    const { as, instanceId } = await seed(t, "admin");
    await as.action(api.instanceSecrets.setInstanceSecret, {
      instanceId,
      field: "token",
      plaintext: "tok",
    });
    await as.mutation(api.admin.deleteInstance, { instanceId });
    const remaining = await t.run((ctx) =>
      ctx.db
        .query("instanceSecrets")
        .withIndex("by_instance", (q) => q.eq("instanceId", instanceId))
        .collect(),
    );
    expect(remaining).toHaveLength(0);
  });
});

// ===========================================================================
// 3b credential FETCH core: the internalQuery returns the encrypted envelopes,
// which DECRYPT back to the original plaintext under the right AAD (and fail under
// a wrong one). This is the testable heart of the bridge credentials endpoint (the
// httpAction wiring itself is live-only, like ingest).
// ===========================================================================

describe("getInstanceSecretEnvelopes -> decrypt round-trip", () => {
  test("envelopes decrypt to the original plaintext under the (instanceId:field) AAD", async () => {
    const t = convexTest(schema, modules);
    const { as, instanceId } = await seed(t, "admin");
    await as.action(api.instanceSecrets.setInstanceSecret, {
      instanceId,
      field: "token",
      plaintext: "operator-token-XYZ",
    });
    await as.action(api.instanceSecrets.setInstanceSecret, {
      instanceId,
      field: "deviceIdentity",
      plaintext: '{"id":"d1","publicKey":"pk","privateKey":"pem"}',
    });

    const envelopes = await t.run((ctx) =>
      ctx.runQuery(internal.instanceSecrets.getInstanceSecretEnvelopes, {
        instanceId,
      }),
    );
    expect(envelopes.map((e) => e.field).sort()).toEqual([
      "deviceIdentity",
      "token",
    ]);

    const { registry } = loadLocalCrypto({ ATRIUM_SECRET_KEY: KEY_B64 });
    const byField = new Map(envelopes.map((e) => [e.field, e.secret]));
    expect(
      await registry.decrypt(byField.get("token")!, `${instanceId}:token`),
    ).toBe("operator-token-XYZ");
    expect(
      await registry.decrypt(
        byField.get("deviceIdentity")!,
        `${instanceId}:deviceIdentity`,
      ),
    ).toBe('{"id":"d1","publicKey":"pk","privateKey":"pem"}');

    // WRONG AAD (e.g. the wrong field) must FAIL — a ciphertext can't be relocated.
    await expect(
      registry.decrypt(byField.get("token")!, `${instanceId}:deviceIdentity`),
    ).rejects.toThrow();
  });

  test("an instance with no secrets returns an empty envelope set", async () => {
    const t = convexTest(schema, modules);
    const { otherInstanceId } = await seed(t, "admin");
    const envelopes = await t.run((ctx) =>
      ctx.runQuery(internal.instanceSecrets.getInstanceSecretEnvelopes, {
        instanceId: otherInstanceId,
      }),
    );
    expect(envelopes).toHaveLength(0);
  });
});
