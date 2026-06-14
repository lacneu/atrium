/// <reference types="vite/client" />
//
// Email-domain auth allowlist. Pins BOTH the pure helper AND the authoritative
// gate in ensureProfile (the part that profile() — which only runs in the live
// Google OAuth flow — cannot be tested locally). The disallowed path is the one
// that matters: a bad-domain OAuth identity must NOT get a profile/role.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import {
  emailDomainAllowed,
  emailVerifiedTruthy,
  extractEntraEmail,
} from "./lib/authDomains";

const modules = import.meta.glob("./**/*.ts");

describe("emailDomainAllowed (default example.com)", () => {
  test("allows the default domain, case-insensitively", () => {
    expect(emailDomainAllowed("alice@example.com")).toBe(true);
    expect(emailDomainAllowed("Alice@Example.COM")).toBe(true);
  });
  test("rejects look-alike + substring attacks (exact post-@ match only)", () => {
    expect(emailDomainAllowed("x@evil-example.com")).toBe(false);
    expect(emailDomainAllowed("x@example.com.evil.com")).toBe(false);
    expect(emailDomainAllowed("x@notexample.com")).toBe(false);
    expect(emailDomainAllowed("example.com@gmail.com")).toBe(false);
  });
  test("rejects empty / malformed / missing", () => {
    expect(emailDomainAllowed(undefined)).toBe(false);
    expect(emailDomainAllowed(null)).toBe(false);
    expect(emailDomainAllowed("")).toBe(false);
    expect(emailDomainAllowed("no-at-sign")).toBe(false);
    expect(emailDomainAllowed("x@")).toBe(false);
  });
  test("env override (set + restore)", () => {
    const prev = process.env.AUTH_ALLOWED_EMAIL_DOMAINS;
    try {
      process.env.AUTH_ALLOWED_EMAIL_DOMAINS = " Bar.dev , foo.io ";
      expect(emailDomainAllowed("a@bar.dev")).toBe(true); // trimmed + lc
      expect(emailDomainAllowed("a@foo.io")).toBe(true);
      expect(emailDomainAllowed("a@example.com")).toBe(false); // default no longer applies
    } finally {
      if (prev === undefined) delete process.env.AUTH_ALLOWED_EMAIL_DOMAINS;
      else process.env.AUTH_ALLOWED_EMAIL_DOMAINS = prev;
    }
  });
  test("emailVerifiedTruthy accepts bool or string, rejects anything else", () => {
    expect(emailVerifiedTruthy(true)).toBe(true);
    expect(emailVerifiedTruthy("true")).toBe(true);
    expect(emailVerifiedTruthy(false)).toBe(false);
    expect(emailVerifiedTruthy("false")).toBe(false);
    expect(emailVerifiedTruthy(undefined)).toBe(false);
  });

  test("extractEntraEmail: email > upn > preferred_username; absent → undefined", () => {
    expect(extractEntraEmail({ email: "a@x.com", upn: "b@x.com" })).toBe("a@x.com");
    expect(extractEntraEmail({ upn: "b@x.com", preferred_username: "c@x.com" })).toBe(
      "b@x.com",
    );
    expect(extractEntraEmail({ preferred_username: "c@x.com" })).toBe("c@x.com");
    expect(extractEntraEmail({ sub: "123", name: "No Email" })).toBeUndefined();
    expect(extractEntraEmail({ email: "" })).toBeUndefined();
  });
});

/** A user row that exists in auth but has NO profile yet, + an identity-bound
 *  client carrying the given email (undefined = anonymous-style, no email). */
async function authedNoProfile(
  t: ReturnType<typeof convexTest>,
  email: string | undefined,
) {
  const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
  const identity: { subject: string; email?: string } = {
    subject: `${userId}|session`,
  };
  if (email !== undefined) identity.email = email;
  return { userId, as: t.withIdentity(identity) };
}

async function profileOf(t: ReturnType<typeof convexTest>, userId: string) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("profiles")
      .filter((q) => q.eq(q.field("userId"), userId))
      .first(),
  );
}

describe("ensureProfile email-domain gate (authoritative, defense-in-depth)", () => {
  test("allowed-domain OAuth identity → profile provisioned", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await authedNoProfile(t, "alice@example.com");
    await as.mutation(api.me.bootstrap, {});
    const p = await profileOf(t, userId);
    expect(p).not.toBeNull();
    expect(p!.email).toBe("alice@example.com");
  });

  test("DISALLOWED-domain OAuth identity → rejected, NO profile/role created", async () => {
    const t = convexTest(schema, modules);
    const { userId, as } = await authedNoProfile(t, "mallory@gmail.com");
    await expect(as.mutation(api.me.bootstrap, {})).rejects.toThrow(/domain/i);
    expect(await profileOf(t, userId)).toBeNull(); // never provisioned
  });

  test("no-email identity is EXEMPT ONLY when the dev Anonymous flag is ON", async () => {
    const prev = process.env.OPENCLAW_ENABLE_ANON_AUTH;
    try {
      process.env.OPENCLAW_ENABLE_ANON_AUTH = "1"; // dev Anonymous enabled
      const t = convexTest(schema, modules);
      const { userId, as } = await authedNoProfile(t, undefined);
      await as.mutation(api.me.bootstrap, {});
      expect(await profileOf(t, userId)).not.toBeNull();
    } finally {
      if (prev === undefined) delete process.env.OPENCLAW_ENABLE_ANON_AUTH;
      else process.env.OPENCLAW_ENABLE_ANON_AUTH = prev;
    }
  });

  test("PROD HOLE: anon flag OFF + no-email identity → REJECTED, no profile", async () => {
    // The bug the gate change closes: with Microsoft, a flaky OAuth token can
    // arrive with NO mapped email. Pre-fix, no-email = bypass → provisioned. Now,
    // with the dev flag off (= production), a no-email identity is refused.
    const prev = process.env.OPENCLAW_ENABLE_ANON_AUTH;
    try {
      delete process.env.OPENCLAW_ENABLE_ANON_AUTH; // production
      const t = convexTest(schema, modules);
      const { userId, as } = await authedNoProfile(t, undefined);
      await expect(as.mutation(api.me.bootstrap, {})).rejects.toThrow(/email/i);
      expect(await profileOf(t, userId)).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.OPENCLAW_ENABLE_ANON_AUTH;
      else process.env.OPENCLAW_ENABLE_ANON_AUTH = prev;
    }
  });
});
