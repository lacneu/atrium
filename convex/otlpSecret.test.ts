/// <reference types="vite/client" />
//
// OTLP auth headers — the encrypted SECRET round-trip (the load-bearing core per
// the design review): admin sets headers via the action → an AAD-bound envelope is
// stored (never plaintext) → decryptOtlpHeaders recovers them. Plus: the admin
// gate, idempotent clear, and SET-time validation (a malformed blob is rejected
// BEFORE anything is stored, so the vendor can't be silently wedged). Each test
// fails if its target regresses. Lives at the convex/ root (like instanceSecrets
// .test.ts) so the convex-test module glob resolves the action's runMutation.

import { convexTest, type TestConvex } from "convex-test";
import { beforeAll, describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { toBase64 } from "./lib/crypto/cipher";
import { loadLocalCrypto } from "./lib/crypto/keyProvider";
import {
  decryptOtlpHeaders,
  OTLP_HEADERS_AAD,
} from "./integrations/otlpSecret";

const modules = import.meta.glob("./**/*.ts");

const KEY_B64 = toBase64(new Uint8Array(32).fill(7));
beforeAll(() => {
  process.env.ATRIUM_SECRET_KEY = KEY_B64;
});

async function seed(t: TestConvex<typeof schema>, role: "admin" | "user") {
  const userId = await t.run(async (ctx) => {
    const uid = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId: uid, role });
    return uid;
  });
  return t.withIdentity({ subject: `${userId}|session` });
}

/** Read the stored OTLP headers envelope from the integrationConfig singleton. */
async function readEnvelope(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const row = await ctx.db
      .query("integrationConfig")
      .withIndex("by_key", (q) => q.eq("key", "singleton"))
      .unique();
    return row?.otlp?.headersSecret ?? null;
  });
}

describe("setOtlpHeaders round-trip + AAD binding", () => {
  test("admin sets headers; an AAD-bound envelope is stored and decrypts back", async () => {
    const t = convexTest(schema, modules);
    const as = await seed(t, "admin");

    const res = await as.action(api.integrations.otlpSecret.setOtlpHeaders, {
      headersJson: '{"Authorization":"Bearer xyz","X-Scope":"prod"}',
    });
    expect(res).toEqual({ ok: true, count: 2 });

    const env = await readEnvelope(t);
    expect(env).not.toBeNull();
    expect(env!.alg).toBe("AES-256-GCM"); // an envelope, not plaintext

    // The flush helper recovers the exact headers.
    expect(await decryptOtlpHeaders(env!)).toEqual({
      Authorization: "Bearer xyz",
      "X-Scope": "prod",
    });

    // AAD binding: decrypting under any OTHER context fails (can't be relocated).
    const { registry } = loadLocalCrypto({ ATRIUM_SECRET_KEY: KEY_B64 });
    expect(await registry.decrypt(env!, OTLP_HEADERS_AAD)).toBe(
      '{"Authorization":"Bearer xyz","X-Scope":"prod"}',
    );
    await expect(
      registry.decrypt(env!, "integration:otlp:WRONG"),
    ).rejects.toThrow();
  });

  test("decryptOtlpHeaders(undefined) → {} (auth-less collector)", async () => {
    expect(await decryptOtlpHeaders(undefined)).toEqual({});
  });

  test("non-admin is rejected and stores NOTHING", async () => {
    const t = convexTest(schema, modules);
    const asUser = await seed(t, "user");
    await expect(
      asUser.action(api.integrations.otlpSecret.setOtlpHeaders, {
        headersJson: '{"Authorization":"Bearer xyz"}',
      }),
    ).rejects.toThrow();
    expect(await readEnvelope(t)).toBeNull();
  });

  test("malformed headers are rejected BEFORE storage (no silent wedge)", async () => {
    const t = convexTest(schema, modules);
    const as = await seed(t, "admin");
    await expect(
      as.action(api.integrations.otlpSecret.setOtlpHeaders, {
        headersJson: '{"Bad Name":"v"}', // illegal header name (space)
      }),
    ).rejects.toThrow();
    expect(await readEnvelope(t)).toBeNull(); // validation ran before encrypt/store
  });

  test("clearOtlpHeaders removes the envelope (idempotent)", async () => {
    const t = convexTest(schema, modules);
    const as = await seed(t, "admin");
    await as.action(api.integrations.otlpSecret.setOtlpHeaders, {
      headersJson: '{"Authorization":"Bearer xyz"}',
    });
    expect(await readEnvelope(t)).not.toBeNull();
    await as.mutation(api.integrations.otlpSecret.clearOtlpHeaders, {});
    expect(await readEnvelope(t)).toBeNull();
    // Idempotent: clearing again is a no-op (does not throw).
    await as.mutation(api.integrations.otlpSecret.clearOtlpHeaders, {});
    expect(await readEnvelope(t)).toBeNull();
  });
});
