/// <reference types="vite/client" />
//
// Cross-device text-size preference (mirror of the theme/locale prefs). Pins
// the resolution (user pref -> "md" code default, NO admin default) and the
// setFontScale paths (set / clear / idempotent no-op /
// create-pending-on-first-write) that the live browser test cannot cover.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

describe("text-size preference (fontScale, mirror of theme)", () => {
  test("setFontScale('lg') persists + getMe resolves to 'lg'", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId: uid,
        role: "user" as const,
        canonical: "u",
      });
      return uid;
    });
    const as = t.withIdentity({ subject: `${userId}|session` });
    await as.mutation(api.me.setFontScale, { scale: "lg" });
    const me = await as.query(api.me.getMe, {});
    expect(me.fontScale).toBe("lg");
    expect(me.resolvedFontScale).toBe("lg");
  });

  test("setFontScale(null) clears the pref → resolves to the 'md' code default", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId: uid,
        role: "user" as const,
        canonical: "u",
        fontScale: "xl" as const,
      });
      return uid;
    });
    const as = t.withIdentity({ subject: `${userId}|session` });
    await as.mutation(api.me.setFontScale, { scale: null });
    const me = await as.query(api.me.getMe, {});
    expect(me.fontScale).toBe(null);
    expect(me.resolvedFontScale).toBe("md");
  });

  test("no pref at all resolves to 'md' (code default, no admin tier)", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId: uid,
        role: "user" as const,
        canonical: "u",
      });
      return uid;
    });
    const me = await t
      .withIdentity({ subject: `${userId}|session` })
      .query(api.me.getMe, {});
    expect(me.fontScale).toBe(null);
    expect(me.resolvedFontScale).toBe("md");
  });

  test("setFontScale with NO profile creates a minimal pending profile carrying the pref", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => {
      return await ctx.db.insert("users", {}); // no profile row yet
    });
    await t
      .withIdentity({ subject: `${userId}|session` })
      .mutation(api.me.setFontScale, { scale: "xl" });
    const created = await t.run(async (ctx) => {
      const all = await ctx.db.query("profiles").collect();
      return all.find((p) => p.userId === userId) ?? null;
    });
    expect(created).not.toBeNull();
    expect(created!.role).toBe("pending");
    expect(created!.fontScale).toBe("xl");
  });

  test("idempotent skip + impersonation acts on the TARGET and audits real changes only", async () => {
    const t = convexTest(schema, modules);
    // Impersonating admin: auditImpersonated writes ONE auditLog row per REAL
    // fontScale.set — the observable discriminator for the skip path (mirror of
    // the setThemeMode test in uiPrefs.test.ts).
    const targetId = await t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId: uid,
        role: "user" as const,
        canonical: "t",
      });
      return uid;
    });
    const adminId = await t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId: uid,
        role: "admin" as const,
        impersonatingUserId: targetId,
      });
      return uid;
    });
    const asAdmin = t.withIdentity({ subject: `${adminId}|session` });
    const auditCount = () =>
      t.run(async (ctx) => (await ctx.db.query("auditLog").collect()).length);

    await asAdmin.mutation(api.me.setFontScale, { scale: "lg" });
    expect(await auditCount()).toBe(1);
    // Same scale again -> SKIP (no write, no audit).
    await asAdmin.mutation(api.me.setFontScale, { scale: "lg" });
    expect(await auditCount()).toBe(1);
    // A REAL change still writes (+ audits).
    await asAdmin.mutation(api.me.setFontScale, { scale: "sm" });
    expect(await auditCount()).toBe(2);
    // The TARGET's profile carries the pref (effective-identity write), not the
    // admin's own.
    const rows = await t.run(async (ctx) =>
      await ctx.db.query("profiles").collect(),
    );
    expect(rows.find((p) => p.userId === targetId)!.fontScale).toBe("sm");
    expect(rows.find((p) => p.userId === adminId)!.fontScale).toBeUndefined();
  });
});
