/// <reference types="vite/client" />
//
// Display-name + service-account editing. Pins:
//  - me.setMyName: a user edits their OWN profile name; blank clears it; the
//    edit STICKS across a re-bootstrap (ensureProfile backfills only when
//    missing, never overwrites — the new married-name scenario).
//  - admin.setUserName: an admin edits ANY user's name; a non-admin is refused.
//  - apiKeys.updateServiceAccount: rename + role change (valid role); rejects a
//    human-only role and a blank name; a non-admin is refused.

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
type T = ReturnType<typeof convexTest>;

async function seedAdmin(t: T) {
  return await t.run(async (ctx) => {
    const uid = await ctx.db.insert("users", { email: "admin@example.com" });
    await ctx.db.insert("profiles", { userId: uid, role: "admin" as const });
    return uid;
  });
}

async function seedUser(t: T, email = "user@example.com") {
  return await t.run(async (ctx) => {
    const uid = await ctx.db.insert("users", { email });
    const profileId = await ctx.db.insert("profiles", {
      userId: uid,
      role: "user" as const,
      email,
    });
    return { uid, profileId };
  });
}

const asUser = (t: T, uid: string) =>
  t.withIdentity({ subject: `${uid}|session` });

const nameOf = (t: T, profileId: string) =>
  t.run((ctx) => ctx.db.get(profileId as never).then((p) => (p as { name?: string } | null)?.name));

describe("me.setMyName (self-service display name)", () => {
  test("sets and clears the caller's own name", async () => {
    const t = convexTest(schema, modules);
    const { uid, profileId } = await seedUser(t);
    await asUser(t, uid).mutation(api.me.setMyName, { name: "  Alice Married  " });
    expect(await nameOf(t, profileId)).toBe("Alice Married"); // trimmed
    // Blank clears it (the list then falls back to the email). The cleared
    // field reads back as absent — undefined on a real deployment, null under
    // convex-test; normalize so the assertion holds in both.
    await asUser(t, uid).mutation(api.me.setMyName, { name: "   " });
    expect((await nameOf(t, profileId)) ?? null).toBeNull();
  });

  test("a user edit STICKS across a re-bootstrap (IdP never clobbers it)", async () => {
    const t = convexTest(schema, modules);
    // users.name is the IdP value; the user overrides it via setMyName.
    const { uid, profileId } = await seedUser(t, "married@example.com");
    await t.run((ctx) => ctx.db.patch(uid, { name: "Maiden Name" }));
    await asUser(t, uid).mutation(api.me.setMyName, { name: "Married Name" });
    await asUser(t, uid).mutation(api.me.bootstrap, {}); // re-sign-in
    expect(await nameOf(t, profileId)).toBe("Married Name");
  });
});

describe("admin.setUserName", () => {
  test("an admin sets another user's name", async () => {
    const t = convexTest(schema, modules);
    const adminUid = await seedAdmin(t);
    const { profileId } = await seedUser(t);
    await asUser(t, adminUid).mutation(api.admin.setUserName, {
      profileId,
      name: "Renamed By Admin",
    });
    expect(await nameOf(t, profileId)).toBe("Renamed By Admin");
  });

  test("a non-admin is refused", async () => {
    const t = convexTest(schema, modules);
    const caller = await seedUser(t, "caller@example.com");
    const victim = await seedUser(t, "victim@example.com");
    await expect(
      asUser(t, caller.uid).mutation(api.admin.setUserName, {
        profileId: victim.profileId,
        name: "hacked",
      }),
    ).rejects.toThrow(/forbidden/i); // the RBAC gate, not an incidental error
    // The gate fired before any write: the victim's name was NOT changed.
    expect(
      (await t.run((ctx) => ctx.db.get(victim.profileId)))?.name,
    ).not.toBe("hacked");
  });
});

describe("apiKeys.updateServiceAccount", () => {
  let prevDomains: string | undefined;
  beforeEach(() => {
    prevDomains = process.env.AUTH_ALLOWED_EMAIL_DOMAINS;
    process.env.AUTH_ALLOWED_EMAIL_DOMAINS = "example.com";
  });
  afterEach(() => {
    if (prevDomains === undefined) delete process.env.AUTH_ALLOWED_EMAIL_DOMAINS;
    else process.env.AUTH_ALLOWED_EMAIL_DOMAINS = prevDomains;
  });

  async function makeAccount(t: T, adminUid: string) {
    return await asUser(t, adminUid).mutation(api.apiKeys.createServiceAccount, {
      name: "Claude Local",
      roleKey: "observer",
    });
  }

  test("renames + changes role (valid) and persists", async () => {
    const t = convexTest(schema, modules);
    const adminUid = await seedAdmin(t);
    const id = await makeAccount(t, adminUid);
    await asUser(t, adminUid).mutation(api.apiKeys.updateServiceAccount, {
      serviceAccountId: id,
      name: "Claude Local Renamed",
      roleKey: "agent",
    });
    const acc = await t.run((ctx) => ctx.db.get(id));
    expect(acc?.name).toBe("Claude Local Renamed");
    expect(acc?.roleKey).toBe("agent");
  });

  test("rejects a human-only role and a blank name", async () => {
    const t = convexTest(schema, modules);
    const adminUid = await seedAdmin(t);
    const id = await makeAccount(t, adminUid);
    await expect(
      asUser(t, adminUid).mutation(api.apiKeys.updateServiceAccount, {
        serviceAccountId: id,
        roleKey: "admin",
      }),
    ).rejects.toThrow(/human-only/);
    await expect(
      asUser(t, adminUid).mutation(api.apiKeys.updateServiceAccount, {
        serviceAccountId: id,
        name: "   ",
      }),
    ).rejects.toThrow(/empty/);
    // Neither rejected call mutated the row.
    const acc = await t.run((ctx) => ctx.db.get(id));
    expect(acc?.name).toBe("Claude Local");
    expect(acc?.roleKey).toBe("observer");
  });

  test("a non-admin is refused", async () => {
    const t = convexTest(schema, modules);
    const adminUid = await seedAdmin(t);
    const id = await makeAccount(t, adminUid);
    const intruder = await seedUser(t, "intruder@example.com");
    await expect(
      asUser(t, intruder.uid).mutation(api.apiKeys.updateServiceAccount, {
        serviceAccountId: id,
        name: "pwned",
      }),
    ).rejects.toThrow(/forbidden/i); // the RBAC gate, not an incidental error
    // The gate fired before any write: the account name was NOT changed.
    expect(
      (await t.run((ctx) => ctx.db.get(id)))?.name,
    ).not.toBe("pwned");
  });
});
