/// <reference types="vite/client" />
//
// Regression: the REAL OAuth bootstrap path on self-hosted.
//
// The production bug (NAS deploy 2026-06-07): @convex-dev/auth's JWT does NOT
// carry an `email` claim, so `ctx.auth.getUserIdentity().email` is undefined on a
// real OAuth session. `ensureProfile` used to gate on that and threw
// "Forbidden: identity has no email" with anon OFF → the bootstrap mutation
// (transactional) rolled back → NO profile, NO appMeta → every real user was
// stuck "pending" forever. The pre-existing tests never caught it: they seed
// `users {}` (no email) and pre-insert the profile directly, so they never run
// the ensureProfile email gate on a real OAuth identity.
//
// Fix: ensureProfile resolves the email from the `users` ROW (written by the
// provider profile()), not only from the JWT. These tests pin that, with anon
// OFF (the production posture).

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

describe("bootstrap resolves the email from the users row (JWT has no email claim)", () => {
  let prevAnon: string | undefined;
  let prevDomains: string | undefined;
  beforeEach(() => {
    prevAnon = process.env.OPENCLAW_ENABLE_ANON_AUTH;
    prevDomains = process.env.AUTH_ALLOWED_EMAIL_DOMAINS;
    delete process.env.OPENCLAW_ENABLE_ANON_AUTH; // anon OFF = production posture
    process.env.AUTH_ALLOWED_EMAIL_DOMAINS = "example.com,example.org";
  });
  afterEach(() => {
    if (prevAnon === undefined) delete process.env.OPENCLAW_ENABLE_ANON_AUTH;
    else process.env.OPENCLAW_ENABLE_ANON_AUTH = prevAnon;
    if (prevDomains === undefined) delete process.env.AUTH_ALLOWED_EMAIL_DOMAINS;
    else process.env.AUTH_ALLOWED_EMAIL_DOMAINS = prevDomains;
  });

  test("identity has NO email + users.email in an allowed domain → first user becomes admin", async () => {
    const t = convexTest(schema, modules);
    // A real OAuth users row carries the verified email; the JWT identity does NOT.
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "alice@example.com", name: "Alice Example" }),
    );
    const as = t.withIdentity({ subject: `${userId}|session` }); // no email claim

    const res = await as.mutation(api.me.bootstrap, {});
    expect(res.role).toBe("admin"); // first ever user → admin (no "no email" throw)

    await t.run(async (ctx) => {
      const profile = await ctx.db
        .query("profiles")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .unique();
      expect(profile?.role).toBe("admin");
      expect(profile?.email).toBe("alice@example.com");
      const meta = await ctx.db.query("appMeta").first();
      expect(meta?.adminAssigned).toBe(true);
    });
  });

  test("identity has NO email + users.email in a DISALLOWED domain → rejected", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "intrus@evil.com" }),
    );
    const as = t.withIdentity({ subject: `${userId}|session` });
    await expect(as.mutation(api.me.bootstrap, {})).rejects.toThrow(
      /domain not allowed/,
    );
  });

  test("anon ON + no email anywhere → still allowed (dev Anonymous provider)", async () => {
    process.env.OPENCLAW_ENABLE_ANON_AUTH = "1";
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const as = t.withIdentity({ subject: `${userId}|session` });
    const res = await as.mutation(api.me.bootstrap, {});
    expect(res.role).toBe("admin"); // first user, no-email exempt when anon on
  });

  test("anon ON: a NON-bootstrap sign-in is auto-approved as active 'user' (dev multi-user)", async () => {
    process.env.OPENCLAW_ENABLE_ANON_AUTH = "1";
    const t = convexTest(schema, modules);
    // First user claims admin (bootstrap).
    const firstId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const first = await t
      .withIdentity({ subject: `${firstId}|session` })
      .mutation(api.me.bootstrap, {});
    expect(first.role).toBe("admin");
    // A SECOND dev identity → active "user" (NOT pending) so it's immediately
    // usable for live multi-user testing.
    const secondId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const second = await t
      .withIdentity({ subject: `${secondId}|session` })
      .mutation(api.me.bootstrap, {});
    expect(second.role).toBe("user");
  });

  test("anon OFF (production posture): a NON-bootstrap sign-in is 'pending'", async () => {
    delete process.env.OPENCLAW_ENABLE_ANON_AUTH;
    const t = convexTest(schema, modules);
    const firstId = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "admin@example.com" }),
    );
    const first = await t
      .withIdentity({ subject: `${firstId}|session` })
      .mutation(api.me.bootstrap, {});
    expect(first.role).toBe("admin");
    const secondId = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "second@example.com" }),
    );
    const second = await t
      .withIdentity({ subject: `${secondId}|session` })
      .mutation(api.me.bootstrap, {});
    expect(second.role).toBe("pending"); // prod: approval required
  });
});

// Cross-provider duplicate-account guard (the two-same-name accounts bug). A second
// OAuth identity (provider+subject -> a fresh convex-auth userId) whose email
// already owns a profile must be BLOCKED at provisioning — linking is explicit
// (signed-in, from settings), never an implicit second profile. anon OFF =
// production posture.
describe("cross-provider email collision is blocked (no silent duplicate profile)", () => {
  let prevAnon: string | undefined;
  let prevDomains: string | undefined;
  beforeEach(() => {
    prevAnon = process.env.OPENCLAW_ENABLE_ANON_AUTH;
    prevDomains = process.env.AUTH_ALLOWED_EMAIL_DOMAINS;
    delete process.env.OPENCLAW_ENABLE_ANON_AUTH;
    process.env.AUTH_ALLOWED_EMAIL_DOMAINS = "example.com,example.org";
  });
  afterEach(() => {
    if (prevAnon === undefined) delete process.env.OPENCLAW_ENABLE_ANON_AUTH;
    else process.env.OPENCLAW_ENABLE_ANON_AUTH = prevAnon;
    if (prevDomains === undefined) delete process.env.AUTH_ALLOWED_EMAIL_DOMAINS;
    else process.env.AUTH_ALLOWED_EMAIL_DOMAINS = prevDomains;
  });

  test("a NEW identity with an already-owned email is refused, with ZERO side effects", async () => {
    const t = convexTest(schema, modules);
    // Identity A (e.g. Google) signs in first -> admin, owns the email.
    const userA = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "alice@example.com", name: "Alice Anderson" }),
    );
    expect(
      (await t.withIdentity({ subject: `${userA}|sA` }).mutation(api.me.bootstrap, {}))
        .role,
    ).toBe("admin");

    // Identity B (e.g. Microsoft Entra) — a fresh userId, SAME email.
    const userB = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "alice@example.com", name: "Alice Anderson" }),
    );
    await expect(
      t.withIdentity({ subject: `${userB}|sB` }).mutation(api.me.bootstrap, {}),
    ).rejects.toThrow(/compte existe déjà pour cet email/);

    // No second profile; admin flag not re-flipped (blocked BEFORE any write).
    await t.run(async (ctx) => {
      const profiles = await ctx.db.query("profiles").collect();
      expect(profiles).toHaveLength(1);
      expect(profiles[0].userId).toBe(userA);
      const metas = await ctx.db.query("appMeta").collect();
      expect(metas).toHaveLength(1);
      expect(metas[0].adminAssigned).toBe(true);
    });
  });

  test("identity A re-signs in -> resolves to its existing profile (never blocked)", async () => {
    const t = convexTest(schema, modules);
    const userA = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "alice@example.com", name: "Alice Anderson" }),
    );
    const asA = t.withIdentity({ subject: `${userA}|s1` });
    await asA.mutation(api.me.bootstrap, {});
    await expect(asA.mutation(api.me.bootstrap, {})).resolves.toBeDefined();
    await t.run(async (ctx) => {
      expect(await ctx.db.query("profiles").collect()).toHaveLength(1);
    });
  });

  test("a DIFFERENT email is NOT blocked (distinct person -> own profile)", async () => {
    const t = convexTest(schema, modules);
    const userA = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "alice@example.com", name: "Alice" }),
    );
    await t.withIdentity({ subject: `${userA}|s` }).mutation(api.me.bootstrap, {});
    const userC = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "bob@example.com", name: "Bob Brown" }),
    );
    await t.withIdentity({ subject: `${userC}|s` }).mutation(api.me.bootstrap, {});
    await t.run(async (ctx) => {
      expect(await ctx.db.query("profiles").collect()).toHaveLength(2);
    });
  });
});

// Display fields (email/name) self-heal on re-sign-in: a profile created before
// name persistence — or whose name changed at the IdP — is refreshed from the
// users row WITHOUT touching role or canonical. anon OFF = production posture.
describe("ensureProfile refreshes display name/email on re-sign-in", () => {
  let prevAnon: string | undefined;
  let prevDomains: string | undefined;
  beforeEach(() => {
    prevAnon = process.env.OPENCLAW_ENABLE_ANON_AUTH;
    prevDomains = process.env.AUTH_ALLOWED_EMAIL_DOMAINS;
    delete process.env.OPENCLAW_ENABLE_ANON_AUTH;
    process.env.AUTH_ALLOWED_EMAIL_DOMAINS = "example.com";
  });
  afterEach(() => {
    if (prevAnon === undefined) delete process.env.OPENCLAW_ENABLE_ANON_AUTH;
    else process.env.OPENCLAW_ENABLE_ANON_AUTH = prevAnon;
    if (prevDomains === undefined) delete process.env.AUTH_ALLOWED_EMAIL_DOMAINS;
    else process.env.AUTH_ALLOWED_EMAIL_DOMAINS = prevDomains;
  });

  test("backfills a missing name (legacy profile) without changing role/canonical", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "alice@example.com", name: "Alice Anderson" }),
    );
    const as = t.withIdentity({ subject: `${userId}|session` });
    await as.mutation(api.me.bootstrap, {}); // first user -> admin, name persisted
    // Simulate a profile created BEFORE name persistence: clear the name.
    const canonicalBefore = await t.run(async (ctx) => {
      const p = await ctx.db
        .query("profiles")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .unique();
      await ctx.db.patch(p!._id, { name: undefined });
      return p!.canonical;
    });

    await as.mutation(api.me.bootstrap, {}); // re-sign-in heals the name

    await t.run(async (ctx) => {
      const p = await ctx.db
        .query("profiles")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .unique();
      expect(p?.name).toBe("Alice Anderson");
      expect(p?.role).toBe("admin"); // role untouched
      expect(p?.canonical).toBe(canonicalBefore); // routing key untouched
    });
  });

  test("does NOT overwrite an existing (user-owned) name with the IdP value", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: "alice@example.com", name: "Maiden Name" }),
    );
    const as = t.withIdentity({ subject: `${userId}|session` });
    await as.mutation(api.me.bootstrap, {}); // seeds profile.name = "Maiden Name"
    // The user edits their display name (e.g. newly married). The IdP users row
    // still carries the old name (the IdP may even change later too).
    await t.run(async (ctx) => {
      const p = await ctx.db
        .query("profiles")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .unique();
      await ctx.db.patch(p!._id, { name: "Married Name" });
      await ctx.db.patch(userId, { name: "IdP Changed Name" });
    });

    await as.mutation(api.me.bootstrap, {}); // re-sign-in must NOT clobber it

    await t.run(async (ctx) => {
      const p = await ctx.db
        .query("profiles")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .unique();
      expect(p?.name).toBe("Married Name"); // user edit wins, IdP never overwrites
    });
  });
});
