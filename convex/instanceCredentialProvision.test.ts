/// <reference types="vite/client" />

import { readFileSync } from "node:fs";

import { convexTest, type TestConvex } from "convex-test";
import { beforeAll, describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { mintDeviceIdentity } from "./deviceIdentity";
import { toBase64 } from "./lib/crypto/cipher";
import { loadLocalCrypto } from "./lib/crypto/keyProvider";
import { hashKey } from "./lib/apikeys";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const PROVISION_KEY = "oc_test_credential_provisioner";
const OBSERVER_KEY = "oc_test_credential_observer";
const MASTER_KEY = toBase64(new Uint8Array(32).fill(17));
beforeAll(() => {
  process.env.ATRIUM_SECRET_KEY = MASTER_KEY;
});

async function seed(t: TestConvex<typeof schema>) {
  const provisionHash = await hashKey(PROVISION_KEY);
  const observerHash = await hashKey(OBSERVER_KEY);
  return await t.run(async (ctx) => {
    const admin = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId: admin, role: "admin" });
    for (const [roleKey, hashedKey] of [
      ["provisioner", provisionHash],
      ["observer", observerHash],
    ] as const) {
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
        lastFour: "test",
        disabled: false,
        createdAt: Date.now(),
      });
    }
    return admin;
  });
}

/** The admin paths (`storeInstanceSecret`) check a signed-in identity. */
const asAdmin = (t: TestConvex<typeof schema>, admin: Id<"users">) =>
  t.withIdentity({ subject: `${admin}|session` });

async function provision(
  t: TestConvex<typeof schema>,
  kind: "openclaw" | "hermes" = "openclaw",
) {
  return await t.fetch("/api/v1/instances/provision", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${PROVISION_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: "operations",
      gatewayUrl: "ws://operations.internal",
      kind,
      ...(kind === "hermes" ? { transport: "ws" } : {}),
    }),
  });
}

async function enroll(
  t: TestConvex<typeof schema>,
  body: Record<string, unknown>,
  key = PROVISION_KEY,
) {
  const response = await t.fetch("/api/v1/instances/credentials", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    json: (await response.json()) as Record<string, unknown>,
  };
}

const openclawBody = (token = "operator-token") => ({
  name: "operations",
  kind: "openclaw",
  credentials: { token },
});

async function secretRows(t: TestConvex<typeof schema>) {
  return await t.run((ctx) => ctx.db.query("instanceSecrets").collect());
}

describe("provisioner credential enrollment", () => {
  test("stores a complete OpenClaw bundle encrypted and returns no secret", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await provision(t);

    const result = await enroll(t, openclawBody());
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({
      ok: true,
      name: "operations",
      outcome: "stored",
      fields: ["deviceIdentity", "token"],
    });
    expect(result.json.deviceIdentity).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{64}$/),
      publicKey: expect.any(String),
    });
    expect(JSON.stringify(result.json)).not.toContain("operator-token");
    expect(JSON.stringify(result.json)).not.toContain("PRIVATE KEY");

    const rows = await secretRows(t);
    expect(rows.map(({ field }) => field).sort()).toEqual([
      "deviceIdentity",
      "token",
    ]);
    const instanceId = rows[0]!.instanceId;
    const { registry } = loadLocalCrypto({ ATRIUM_SECRET_KEY: MASTER_KEY });
    const token = rows.find(({ field }) => field === "token")!;
    const identity = rows.find(({ field }) => field === "deviceIdentity")!;
    expect(await registry.decrypt(token.secret, `${instanceId}:token`)).toBe(
      "operator-token",
    );
    const storedIdentity = JSON.parse(
      await registry.decrypt(identity.secret, `${instanceId}:deviceIdentity`),
    ) as Record<string, unknown>;
    expect(storedIdentity).toMatchObject(result.json.deviceIdentity as object);
    expect(storedIdentity.privateKey).toMatch(/^-----BEGIN PRIVATE KEY-----/);
  });

  test("an identical replay writes nothing and rotating one value preserves the other", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await provision(t);
    await enroll(t, openclawBody());
    const first = await secretRows(t);

    const replay = await enroll(t, openclawBody());
    expect(replay.status).toBe(200);
    expect(replay.json.outcome).toBe("unchanged");
    expect(replay.json.deviceIdentity).toEqual(
      (await enroll(t, openclawBody())).json.deviceIdentity,
    );
    expect(await secretRows(t)).toEqual(first);

    const rotated = await enroll(t, openclawBody("new-token"));
    expect(rotated.json.outcome).toBe("stored");
    const next = await secretRows(t);
    expect(
      next.find(({ field }) => field === "deviceIdentity")!.secret,
    ).toEqual(first.find(({ field }) => field === "deviceIdentity")!.secret);
    expect(next.find(({ field }) => field === "token")!.secret).not.toEqual(
      first.find(({ field }) => field === "token")!.secret,
    );
  });

  test("a provisioner replay cannot downgrade a promoted device token", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await provision(t);
    const enrolled = await enroll(t, openclawBody());
    const identity = enrolled.json.deviceIdentity as {
      id: string;
      publicKey: string;
    };
    const instanceId = (await secretRows(t))[0]!.instanceId;
    await t.action(
      internal.instanceCredentialProvision.promoteOpenClawDeviceToken,
      {
        instanceId,
        deviceId: identity.id,
        publicKey: identity.publicKey,
        token: "paired-device-token",
      },
    );
    const before = await secretRows(t);

    const replay = await enroll(t, openclawBody("rotated-bootstrap-token"));

    expect(replay.json.outcome).toBe("unchanged");
    expect(await secretRows(t)).toEqual(before);
    expect(before.find(({ field }) => field === "token")?.source).toBe("device");
  });

  /** Rewrite the token row the way a deployment predating `source` left it:
   *  the column is OPTIONAL and nothing backfills it, so production carries rows
   *  whose provenance is genuinely unknown. */
  async function stripTokenProvenance(t: TestConvex<typeof schema>) {
    await t.run(async (ctx) => {
      const rows = await ctx.db.query("instanceSecrets").collect();
      for (const row of rows) {
        if (row.field !== "token") continue;
        const { source: _dropped, ...rest } = row;
        await ctx.db.replace(row._id, rest);
      }
    });
  }

  test("a token of UNKNOWN provenance is never overwritten — it may be a promoted one", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await provision(t);
    await enroll(t, openclawBody("paired-then-legacy-token"));
    // The row now looks exactly like one written before `source` existed. It could
    // be a bootstrap token, or a device token promoted long ago — indistinguishable.
    await stripTokenProvenance(t);
    const before = await secretRows(t);

    const replaced = await enroll(t, openclawBody("different-bootstrap-token"));

    // Refused, not silently skipped: a caller told "unchanged" would believe its
    // token is in place. And refused rather than written: "not device" does not
    // mean "not promoted", so writing could cut a gateway that works.
    expect(replaced.status).toBe(409);
    expect(replaced.json.error).toBe("credential_provenance_unknown");
    expect(await secretRows(t)).toEqual(before);
  });

  test("but an identical replay on that same unknown row still reports unchanged", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await provision(t);
    await enroll(t, openclawBody("steady-token"));
    await stripTokenProvenance(t);
    const before = await secretRows(t);

    // Nothing would be written, so there is nothing to refuse. A qualification
    // second pass over a legacy instance must stay green rather than 409.
    const replay = await enroll(t, openclawBody("steady-token"));

    expect(replay.status).toBe(200);
    expect(replay.json.outcome).toBe("unchanged");
    expect(await secretRows(t)).toEqual(before);
  });

  test("a Hermes key of unknown provenance stays updatable — it has no second writer", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await provision(t, "hermes");
    await enroll(t, { name: "operations", kind: "hermes", credentials: { apiKey: "first" } });
    await t.run(async (ctx) => {
      const rows = await ctx.db.query("instanceSecrets").collect();
      for (const row of rows) {
        const { source: _dropped, ...rest } = row;
        await ctx.db.replace(row._id, rest);
      }
    });

    // Only OpenClaw tokens can be promoted by the bridge, so an absent `source`
    // here carries no such ambiguity — refusing would strand every legacy Hermes
    // instance behind a manual step for no safety gain.
    const updated = await enroll(t, {
      name: "operations",
      kind: "hermes",
      credentials: { apiKey: "second" },
    });

    expect(updated.status).toBe(200);
    expect(updated.json.outcome).toBe("stored");
    expect((await secretRows(t)).find(({ field }) => field === "apiKey")?.source).toBe(
      "provisioner",
    );
  });

  test("a concurrent write in the SAME millisecond is still a conflict", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await provision(t);
    await enroll(t, openclawBody("first-token"));

    const observedBefore = await t.run((ctx) =>
      ctx.runQuery(
        internal.instanceCredentialProvision.readCredentialEnrollmentState,
        { name: "operations" },
      ),
    );
    const state = observedBefore!;

    // Another writer replaces the token, KEEPING updatedAt byte-identical. That is
    // the millisecond-collision case: a revision made of (field, updatedAt) alone
    // still compares equal, so the compare-and-set would pass and this action would
    // overwrite a value it never observed — the opposite of failing closed.
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("instanceSecrets").collect()).find(
        ({ field }) => field === "token",
      )!;
      await ctx.db.patch(row._id, {
        secret: { ...row.secret, ciphertext: `${row.secret.ciphertext}X` },
      });
    });

    await expect(
      t.run((ctx) =>
        ctx.runMutation(
          internal.instanceCredentialProvision.storeProvisionedCredentials,
          {
            instanceId: state.instanceId,
            kind: "openclaw",
            observed: state.revision,
            changes: [],
          },
        ),
      ),
    ).rejects.toThrow("credential_state_changed");
  });

  test("replacing the device identity drops the token promoted against the old one", async () => {
    const t = convexTest(schema, modules);
    const admin = await seed(t);
    await provision(t);
    const enrolled = await enroll(t, openclawBody());
    const identity = enrolled.json.deviceIdentity as {
      id: string;
      publicKey: string;
    };
    const instanceId = (await secretRows(t))[0]!.instanceId;
    await t.action(
      internal.instanceCredentialProvision.promoteOpenClawDeviceToken,
      {
        instanceId,
        deviceId: identity.id,
        publicKey: identity.publicKey,
        token: "paired-device-token",
      },
    );
    expect(
      (await secretRows(t)).find(({ field }) => field === "token")?.source,
    ).toBe("device");

    // An admin regenerates the identity. The promoted token was minted BY the
    // gateway AGAINST the old key — keeping it would have the bridge present a new
    // key with a token bound to the old one, which the gateway rejects: locked out
    // by two credentials that are each valid and jointly meaningless.
    const { encryptCipher } = loadLocalCrypto({ ATRIUM_SECRET_KEY: MASTER_KEY });
    await asAdmin(t, admin).mutation(
      internal.instanceSecrets.storeInstanceSecret,
      {
        instanceId,
        field: "deviceIdentity",
        secret: await encryptCipher.encrypt(
          JSON.stringify({
            id: "b".repeat(64),
            publicKey: "new-public-key",
            privateKey: "-----BEGIN PRIVATE KEY-----\nnew\n-----END PRIVATE KEY-----",
          }),
          `${instanceId}:deviceIdentity`,
        ),
      },
    );

    const after = await secretRows(t);
    expect(after.find(({ field }) => field === "token")).toBeUndefined();
    expect(after.find(({ field }) => field === "deviceIdentity")).toBeDefined();
  });

  test("an identity of the right TYPE but the wrong SHAPE is refused", async () => {
    const t = convexTest(schema, modules);
    const admin = await seed(t);
    await provision(t);
    await enroll(t, openclawBody());
    const instanceId = (await secretRows(t))[0]!.instanceId;

    // Three strings — the old check passed. None of them is a usable Ed25519
    // identity, and the failure used to surface only later, inside the bridge's
    // createPrivateKey, on a configuration Atrium had reported as valid.
    const { encryptCipher } = loadLocalCrypto({ ATRIUM_SECRET_KEY: MASTER_KEY });
    await asAdmin(t, admin).mutation(
      internal.instanceSecrets.storeInstanceSecret,
      {
        instanceId,
        field: "deviceIdentity",
        secret: await encryptCipher.encrypt(
          JSON.stringify({ id: "", publicKey: "nope", privateKey: "nope" }),
          `${instanceId}:deviceIdentity`,
        ),
      },
    );

    const rejected = await enroll(t, openclawBody("another-token"));
    expect(rejected.status).toBe(409);
    expect(rejected.json.error).toBe("credential_state_invalid");
  });

  test("an admin write DURING the action makes 'unchanged' a conflict, not a lie", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await provision(t);
    await enroll(t, openclawBody("steady-token"));

    // Read the state the action would have read, then let another writer move it.
    // The old code returned early on "nothing to change" and never revalidated, so
    // the API reported the caller's token as installed while a different value had
    // just been stored.
    const state = (await t.run((ctx) =>
      ctx.runQuery(
        internal.instanceCredentialProvision.readCredentialEnrollmentState,
        { name: "operations" },
      ),
    ))!;
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("instanceSecrets").collect()).find(
        ({ field }) => field === "token",
      )!;
      await ctx.db.patch(row._id, {
        secret: { ...row.secret, ciphertext: `${row.secret.ciphertext}Z` },
      });
    });

    await expect(
      t.run((ctx) =>
        ctx.runMutation(
          internal.instanceCredentialProvision.storeProvisionedCredentials,
          {
            instanceId: state.instanceId,
            kind: "openclaw",
            observed: state.revision,
            changes: [],
          },
        ),
      ),
    ).rejects.toThrow("credential_state_changed");
  });

  test("neither 'unchanged' path may answer WITHOUT revalidating what it read", async () => {
    // A concurrent admin write between the action's read and its return is not
    // injectable from convex-test, so this is asserted on the SOURCE — the same
    // technique the connect-contract gate uses. What it pins is an ordering: both
    // early returns must sit AFTER the compare-and-set, never before it.
    //
    // The behaviour under it is covered above ("a concurrent write in the SAME
    // millisecond is still a conflict"); what this adds is that the enrollment and
    // promotion paths actually GO THROUGH that check instead of answering from a
    // state they read earlier and never confirmed.
    const src = readFileSync(
      new URL("./instanceCredentialProvision.ts", import.meta.url),
      "utf8",
    );
    for (const [label, region, stop] of [
      [
        "enrollInstanceCredentials",
        "export const enrollInstanceCredentials",
        "export const",
      ],
      // The promotion's logic lives in `promoteOnce`; the exported action around it
      // is the bounded retry that re-runs it after a lost revision race.
      ["promoteOnce", "async function promoteOnce", "export const"],
    ] as const) {
      const start = src.indexOf(region);
      expect(start, `${label} moved — this gate sweeps nothing`).toBeGreaterThan(-1);
      const next = src.indexOf(stop, start + 20);
      const body = src.slice(start, next === -1 ? undefined : next);
      const guard = body.indexOf("storeProvisionedCredentials");
      // The RETURN, not the return TYPE — matching the bare string also hit the
      // `Promise<{ outcome: "stored" | "unchanged" }>` annotation at the top of the
      // function and made this gate compare against the signature.
      // Covers `outcome: "unchanged"` and the ternary form the promotion now uses,
      // where an unchanged VALUE can still store a newly supplied timestamp.
      const answer = body.search(/outcome: (?:"unchanged"|[A-Za-z]+ \?)/);
      expect(guard, `${label} never calls the compare-and-set`).toBeGreaterThan(-1);
      expect(answer, `${label} has no unchanged answer`).toBeGreaterThan(-1);
      expect(
        guard,
        `${label} answers "unchanged" before revalidating the state it read — a caller would be told its value is installed while another writer had just replaced it`,
      ).toBeLessThan(answer);
    }
  });

  test("an identity whose private key does not match its public key is refused", async () => {
    const t = convexTest(schema, modules);
    const admin = await seed(t);
    await provision(t);
    await enroll(t, openclawBody());
    const instanceId = (await secretRows(t))[0]!.instanceId;

    // A well-formed identity — right id length, right base64url public key, a real
    // PKCS#8 PEM — whose three parts simply do not belong together. Every shape
    // check passes; only signing catches it. The bridge would otherwise sign the
    // gateway's challenge with the wrong key, failing at the far end of an install
    // Atrium had reported as valid.
    const stranger = await mintDeviceIdentity();
    const owner = await mintDeviceIdentity();
    const { encryptCipher } = loadLocalCrypto({ ATRIUM_SECRET_KEY: MASTER_KEY });
    await asAdmin(t, admin).mutation(
      internal.instanceSecrets.storeInstanceSecret,
      {
        instanceId,
        field: "deviceIdentity",
        secret: await encryptCipher.encrypt(
          JSON.stringify({
            id: owner.id,
            publicKey: owner.publicKey,
            privateKey: stranger.privateKey,
          }),
          `${instanceId}:deviceIdentity`,
        ),
      },
    );

    const rejected = await enroll(t, openclawBody("another-token"));
    expect(rejected.status).toBe(409);
    expect(rejected.json.error).toBe("credential_state_invalid");
  });

  test("a REGENERATED identity never keeps the token promoted against the old one", async () => {
    const t = convexTest(schema, modules);
    const admin = await seed(t);
    await provision(t);
    const enrolled = await enroll(t, openclawBody());
    const identity = enrolled.json.deviceIdentity as {
      id: string;
      publicKey: string;
    };
    const instanceId = (await secretRows(t))[0]!.instanceId;
    await t.action(
      internal.instanceCredentialProvision.promoteOpenClawDeviceToken,
      {
        instanceId,
        deviceId: identity.id,
        publicKey: identity.publicKey,
        token: "paired-device-token",
      },
    );

    // Clearing the IDENTITY alone is reachable from the admin interface, and leaves
    // a promoted token behind with nothing to pair it to.
    await asAdmin(t, admin).mutation(api.instanceSecrets.clearInstanceSecret, {
      instanceId,
      field: "deviceIdentity",
    });

    // Enrollment mints a fresh identity. Keeping the promoted token beside it would
    // store two credentials that are individually valid and jointly unusable: the
    // bridge presents the NEW key with a token minted for the old one and is
    // refused — while the API answers "stored".
    const reenrolled = await enroll(t, openclawBody("fresh-bootstrap"));
    expect(reenrolled.status).toBe(200);
    const rows = await secretRows(t);
    const token = rows.find(({ field }) => field === "token")!;
    expect(token.source).toBe("provisioner");
    const { registry } = loadLocalCrypto({ ATRIUM_SECRET_KEY: MASTER_KEY });
    expect(await registry.decrypt(token.secret, `${instanceId}:token`)).toBe(
      "fresh-bootstrap",
    );
  });

  test("a fresh identity replaces a promoted token even when the VALUE is identical", async () => {
    const t = convexTest(schema, modules);
    const admin = await seed(t);
    await provision(t);
    const enrolled = await enroll(t, openclawBody("shared-value"));
    const identity = enrolled.json.deviceIdentity as {
      id: string;
      publicKey: string;
    };
    const instanceId = (await secretRows(t))[0]!.instanceId;
    // The gateway promotes a device token that happens to equal the bootstrap
    // string. Value equality says nothing about what the token is BOUND to.
    await t.action(
      internal.instanceCredentialProvision.promoteOpenClawDeviceToken,
      {
        instanceId,
        deviceId: identity.id,
        publicKey: identity.publicKey,
        token: "shared-value",
      },
    );
    await asAdmin(t, admin).mutation(api.instanceSecrets.clearInstanceSecret, {
      instanceId,
      field: "deviceIdentity",
    });

    // A new identity is minted, so the promoted token's binding is dead. The
    // equality short-circuit must NOT run ahead of that: it would keep the old
    // binding and store a bundle the bridge cannot authenticate with.
    const reenrolled = await enroll(t, openclawBody("shared-value"));
    expect(reenrolled.status).toBe(200);
    const token = (await secretRows(t)).find(({ field }) => field === "token")!;
    expect(token.source).toBe("provisioner");
  });

  test("an OLDER issuance never overwrites a newer promoted token", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await provision(t);
    const enrolled = await enroll(t, openclawBody());
    const identity = enrolled.json.deviceIdentity as {
      id: string;
      publicKey: string;
    };
    const instanceId = (await secretRows(t))[0]!.instanceId;
    const promote = (token: string, issuedAtMs: number) =>
      t.action(internal.instanceCredentialProvision.promoteOpenClawDeviceToken, {
        instanceId,
        deviceId: identity.id,
        publicKey: identity.publicKey,
        token,
        issuedAtMs,
      });

    // Two handshakes to the same gateway overlap and are handed different tokens.
    // The compare-and-set only protects the revision each one READ, so both writes
    // succeed in sequence — and whichever lands last wins, which may be the older.
    expect(await promote("newer", 2_000)).toEqual({ outcome: "stored" });
    expect(await promote("older", 1_000)).toEqual({ outcome: "superseded" });

    const { registry } = loadLocalCrypto({ ATRIUM_SECRET_KEY: MASTER_KEY });
    const token = (await secretRows(t)).find(({ field }) => field === "token")!;
    expect(await registry.decrypt(token.secret, `${instanceId}:token`)).toBe(
      "newer",
    );
    expect(token.issuedAtMs).toBe(2_000);
  });

  test("an ADMIN replacement clears the promotion timestamp it inherits", async () => {
    const t = convexTest(schema, modules);
    const admin = await seed(t);
    await provision(t);
    const enrolled = await enroll(t, openclawBody());
    const identity = enrolled.json.deviceIdentity as {
      id: string;
      publicKey: string;
    };
    const instanceId = (await secretRows(t))[0]!.instanceId;
    await t.action(
      internal.instanceCredentialProvision.promoteOpenClawDeviceToken,
      {
        instanceId,
        deviceId: identity.id,
        publicKey: identity.publicKey,
        token: "paired",
        issuedAtMs: 5_000,
      },
    );

    // An admin pastes a token by hand. It is not a gateway issuance, so the
    // timestamp of what it replaces must go with it — kept, it would order future
    // promotions against a moment unrelated to anything, and a genuinely new token
    // arriving with a lower clock would be classified `superseded` for ever.
    const { encryptCipher } = loadLocalCrypto({ ATRIUM_SECRET_KEY: MASTER_KEY });
    await asAdmin(t, admin).mutation(
      internal.instanceSecrets.storeInstanceSecret,
      {
        instanceId,
        field: "token",
        secret: await encryptCipher.encrypt("hand-typed", `${instanceId}:token`),
      },
    );
    expect(
      (await secretRows(t)).find(({ field }) => field === "token")?.issuedAtMs,
    ).toBeUndefined();

    // ...so a later promotion with an EARLIER clock is still accepted.
    expect(
      await t.action(
        internal.instanceCredentialProvision.promoteOpenClawDeviceToken,
        {
          instanceId,
          deviceId: identity.id,
          publicKey: identity.publicKey,
          token: "genuinely-new",
          issuedAtMs: 1_000,
        },
      ),
    ).toEqual({ outcome: "stored" });
  });

  test("a timestamp supplied LATER is adopted, so rotations stay possible", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await provision(t);
    const enrolled = await enroll(t, openclawBody());
    const identity = enrolled.json.deviceIdentity as {
      id: string;
      publicKey: string;
    };
    const instanceId = (await secretRows(t))[0]!.instanceId;
    const promote = (token: string, issuedAtMs?: number) =>
      t.action(internal.instanceCredentialProvision.promoteOpenClawDeviceToken, {
        instanceId,
        deviceId: identity.id,
        publicKey: identity.publicKey,
        token,
        ...(issuedAtMs === undefined ? {} : { issuedAtMs }),
      });

    // `auth.issuedAtMs` is OPTIONAL, so the first promotion can land without one.
    expect(await promote("paired")).toEqual({ outcome: "stored" });
    expect(
      (await secretRows(t)).find(({ field }) => field === "token")?.issuedAtMs,
    ).toBeUndefined();

    // An upgraded gateway then re-announces the SAME token, now with its issuance.
    // Ignoring it would leave the row unordered for ever, and every later rotation
    // refused as `superseded` — a deadlock built out of a missing timestamp.
    expect(await promote("paired", 5_000)).toEqual({ outcome: "stored" });
    expect(
      (await secretRows(t)).find(({ field }) => field === "token")?.issuedAtMs,
    ).toBe(5_000);

    // ...and a genuine rotation is accepted again.
    expect(await promote("rotated", 9_000)).toEqual({ outcome: "stored" });
  });

  test("a lost revision race is RETRIED, not surfaced as a refusal", async () => {
    // Interleaving two in-flight actions is not reachable from convex-test, so the
    // structure is pinned instead: the exported action must wrap `promoteOnce` in a
    // bounded retry keyed on `credential_state_changed`. Without it, the handshake
    // that loses the race — possibly the one carrying the NEWER token — surfaces a
    // 409 the bridge treats as final, and Convex keeps the older token.
    const src = readFileSync(
      new URL("./instanceCredentialProvision.ts", import.meta.url),
      "utf8",
    );
    const start = src.indexOf("export const promoteOpenClawDeviceToken");
    const body = src.slice(start, src.indexOf("async function promoteOnce"));
    expect(start, "the promotion action moved").toBeGreaterThan(-1);
    expect(body).toContain("promoteOnce(");
    expect(
      body,
      "the retry must be keyed on the lost-race error, not on any failure",
    ).toContain("credential_state_changed");
    expect(
      body,
      "the retry must be BOUNDED — a continuously rewritten row must eventually refuse",
    ).toMatch(/attempt >= \d+/);
  });

  test("switching provider removes stale fields in the same transaction", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await provision(t);
    await enroll(t, openclawBody());
    await provision(t, "hermes");

    const result = await enroll(t, {
      name: "operations",
      kind: "hermes",
      credentials: { apiKey: "hermes-key" },
    });
    expect(result.status).toBe(200);
    expect(result.json.fields).toEqual(["apiKey"]);
    expect((await secretRows(t)).map(({ field }) => field)).toEqual(["apiKey"]);
  });

  test("fails closed on permissions, missing instances, kind mismatch, and malformed shapes", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await provision(t);

    expect((await enroll(t, openclawBody(), OBSERVER_KEY)).status).toBe(403);
    expect(
      (
        await enroll(t, {
          ...openclawBody(),
          name: "missing",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await enroll(t, {
          name: "operations",
          kind: "hermes",
          credentials: { apiKey: "key" },
        })
      ).status,
    ).toBe(409);
    for (const body of [
      { ...openclawBody(), extra: true },
      {
        ...openclawBody(),
        credentials: {
          token: "token",
          deviceIdentity: "caller-controlled-private-key",
        },
      },
    ]) {
      expect((await enroll(t, body)).status).toBe(400);
    }
    expect(await secretRows(t)).toEqual([]);
  });

  test("duplicate names and concurrent row changes are conflicts", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("instances", {
        name: "operations",
        gatewayUrl: "ws://one",
      });
      await ctx.db.insert("instances", {
        name: "operations",
        gatewayUrl: "ws://two",
      });
    });
    expect((await enroll(t, openclawBody())).status).toBe(409);

    const clean = convexTest(schema, modules);
    await seed(clean);
    await provision(clean);
    await enroll(clean, openclawBody());
    const state = await clean.run((ctx) =>
      ctx.runQuery(
        internal.instanceCredentialProvision.readCredentialEnrollmentState,
        { name: "operations" },
      ),
    );
    const row = (await secretRows(clean))[0]!;
    await clean.run((ctx) =>
      ctx.db.patch(row._id, { updatedAt: row.updatedAt + 1 }),
    );
    await expect(
      clean.run((ctx) =>
        ctx.runMutation(
          internal.instanceCredentialProvision.storeProvisionedCredentials,
          {
            instanceId: state!.instanceId as Id<"instances">,
            kind: "openclaw",
            observed: state!.revision,
            changes: [],
          },
        ),
      ),
    ).rejects.toThrow("credential_state_changed");
  });

  test("a corrupted existing envelope returns a generic error and preserves state", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await provision(t);
    await enroll(t, openclawBody());
    const row = (await secretRows(t)).find(({ field }) => field === "token")!;
    await t.run((ctx) =>
      ctx.db.patch(row._id, {
        secret: { ...row.secret, ciphertext: "invalid" },
      }),
    );
    const before = await secretRows(t);

    const result = await enroll(t, openclawBody());
    expect(result.status).toBe(500);
    expect(result.json.error).toBe("credential_enrollment_failed");
    expect(await secretRows(t)).toEqual(before);
  });

  test("rejects a decrypted OpenClaw identity with an invalid shape", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await provision(t);
    await enroll(t, openclawBody());
    const row = (await secretRows(t)).find(
      ({ field }) => field === "deviceIdentity",
    )!;
    const { encryptCipher } = loadLocalCrypto({
      ATRIUM_SECRET_KEY: MASTER_KEY,
    });
    const invalidIdentity = await encryptCipher.encrypt(
      JSON.stringify({ id: "only-id" }),
      `${row.instanceId}:deviceIdentity`,
    );
    await t.run((ctx) =>
      ctx.db.patch(row._id, {
        secret: invalidIdentity,
      }),
    );
    const before = await secretRows(t);

    const result = await enroll(t, openclawBody());
    expect(result.status).toBe(409);
    expect(result.json.error).toBe("credential_state_invalid");
    expect(await secretRows(t)).toEqual(before);
  });
});
