/// <reference types="vite/client" />
//
// Cross-device UI language sync (mirror of the theme preference). Pins the
// resolution chain (user pref -> admin default -> baseLocale "fr") and the three
// setLocale paths (set / clear / create-pending-on-first-write) that the live
// browser test cannot cover branch-by-branch.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

describe("locale preference (cross-device, mirror of theme)", () => {
  test("setLocale('en') persists + getMe resolves to 'en'", async () => {
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
    await as.mutation(api.me.setLocale, { locale: "en" });
    const me = await as.query(api.me.getMe, {});
    expect(me.locale).toBe("en");
    expect(me.resolvedLocale).toBe("en");
    expect(me.defaultLocale).toBe(null);
  });

  test("setLocale(null) clears the pref → resolvedLocale falls back to base 'fr'", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId: uid,
        role: "user" as const,
        canonical: "u",
        locale: "en" as const,
      });
      return uid;
    });
    const as = t.withIdentity({ subject: `${userId}|session` });
    await as.mutation(api.me.setLocale, { locale: null });
    const me = await as.query(api.me.getMe, {});
    expect(me.locale).toBe(null);
    expect(me.resolvedLocale).toBe("fr"); // baseLocale
  });

  test("setLocale with NO profile creates a minimal pending profile carrying the locale", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => {
      return await ctx.db.insert("users", {}); // no profile row yet
    });
    await t
      .withIdentity({ subject: `${userId}|session` })
      .mutation(api.me.setLocale, { locale: "en" });
    const created = await t.run(async (ctx) => {
      const all = await ctx.db.query("profiles").collect();
      return all.find((p) => p.userId === userId) ?? null;
    });
    expect(created).not.toBeNull();
    expect(created!.role).toBe("pending");
    expect(created!.locale).toBe("en");
  });

  test("resolution chain: user pref wins; else admin default; else base 'fr'", async () => {
    const t = convexTest(schema, modules);
    const { userPref, userNoPref } = await t.run(async (ctx) => {
      // Admin default = "en".
      await ctx.db.insert("appMeta", {
        key: "singleton",
        adminAssigned: true,
        defaultLocale: "en" as const,
      });
      const a = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId: a,
        role: "user" as const,
        canonical: "a",
        locale: "fr" as const, // explicit pref
      });
      const b = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId: b,
        role: "user" as const,
        canonical: "b", // no locale pref
      });
      return { userPref: a, userNoPref: b };
    });

    // User WITH a "fr" pref beats the "en" admin default.
    const mePref = await t
      .withIdentity({ subject: `${userPref}|session` })
      .query(api.me.getMe, {});
    expect(mePref.locale).toBe("fr");
    expect(mePref.resolvedLocale).toBe("fr");
    expect(mePref.defaultLocale).toBe("en");

    // User WITHOUT a pref inherits the "en" admin default (the otherwise
    // unreachable branch until the admin setter ships in I18N-4).
    const meNoPref = await t
      .withIdentity({ subject: `${userNoPref}|session` })
      .query(api.me.getMe, {});
    expect(meNoPref.locale).toBe(null);
    expect(meNoPref.resolvedLocale).toBe("en");
  });

  test("admin.setDefaultLocale: requireAdmin gate; a no-pref user then inherits it", async () => {
    const t = convexTest(schema, modules);
    // A plain user cannot set the app default.
    const plain = await t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId: uid,
        role: "user" as const,
        canonical: "u",
      });
      return uid;
    });
    await expect(
      t
        .withIdentity({ subject: `${plain}|session` })
        .mutation(api.admin.setDefaultLocale, { locale: "en" }),
    ).rejects.toThrow();

    // An admin sets it (appMeta is created defensively if absent).
    const admin = await t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId: uid,
        role: "admin" as const,
        canonical: "a",
      });
      return uid;
    });
    await t
      .withIdentity({ subject: `${admin}|session` })
      .mutation(api.admin.setDefaultLocale, { locale: "en" });

    // A fresh user with no personal locale inherits the "en" default.
    const fresh = await t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId: uid,
        role: "user" as const,
        canonical: "n",
      });
      return uid;
    });
    const me = await t
      .withIdentity({ subject: `${fresh}|session` })
      .query(api.me.getMe, {});
    expect(me.defaultLocale).toBe("en");
    expect(me.resolvedLocale).toBe("en");
  });
});

// v.string() schema + runtime membership validation (the single-source module
// is the validator now — these rejections MUST be pinned or a typo'd locale
// would silently persist).
describe("unsupported locale rejection (runtime validation)", () => {
  test("setLocale rejects a locale outside SUPPORTED_LOCALES", async () => {
    const t = convexTest(schema, modules);
    const as = t.withIdentity({ subject: "u1|s" });
    await expect(
      as.mutation(api.me.setLocale, { locale: "de" }),
    ).rejects.toThrow(/Unsupported locale/);
  });

  test("admin.setDefaultLocale rejects an unsupported locale", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId: uid, role: "admin" });
      return uid;
    });
    const as = t.withIdentity({ subject: `${userId}|s` });
    await expect(
      as.mutation(api.admin.setDefaultLocale, { locale: "xx" }),
    ).rejects.toThrow(/Unsupported locale/);
  });

  test("a STORED locale that is no longer supported resolves to the admin default, then base", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", {});
      // Simulate a language removed after being stored (schema is v.string now).
      await ctx.db.insert("profiles", { userId: uid, role: "user", locale: "removed" });
      return uid;
    });
    const as = t.withIdentity({ subject: `${userId}|s` });
    const me = await as.query(api.me.getMe, { host: "app.example.com" });
    expect(me?.resolvedLocale).toBe("fr"); // narrowed through the chain, no crash
    expect(me?.locale).toBeNull(); // the raw unsupported pref is not leaked
  });
});

