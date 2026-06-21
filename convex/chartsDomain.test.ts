/// <reference types="vite/client" />
//
// "Charte par domaine" (multi-tenant) — server surface. Pins the SECURITY +
// resolution behavior of the domain feature, with the INVERSE (negative) cases
// front and center:
//  - brandForHost (PUBLIC, pre-auth): a builtin / custom-"common" chart mapped to
//    a domain IS painted on the anonymous login; a "personal" or group-restricted
//    chart is NOT (no private-brand leak) — the discriminator for the read-side
//    guard chartIsPubliclyExposable. An unmapped / invalid host => app default.
//  - resolveDomainChartKey: most-specific-first (exact host beats a wildcard).
//  - addChartDomain / removeChartDomain: admin-only (CHARTS_MANAGE), normalize +
//    reject invalid, reject a domain already mapped elsewhere, unknown chart,
//    idempotency; a non-admin is rejected on BOTH.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { resolveDomainChartKey, detectLogoMime } from "./charts";
import { BUILTIN_CHARTS } from "./lib/charts";

const modules = import.meta.glob("./**/*.ts");

const BUILTIN_KEY = BUILTIN_CHARTS[0]!.key;
const BUILTIN_KEY_2 = BUILTIN_CHARTS[1]!.key;

// --- seed helpers (mirror charts.test.ts idioms) ---------------------------

async function seedAdmin(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const uid = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId: uid, role: "admin" as const });
    return uid;
  });
}

async function seedUser(t: ReturnType<typeof convexTest>, canonical = "u") {
  return await t.run(async (ctx) => {
    const uid = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", {
      userId: uid,
      role: "user" as const,
      canonical,
    });
    return uid;
  });
}

const as = (t: ReturnType<typeof convexTest>, uid: string) =>
  t.withIdentity({ subject: `${uid}|session` });

/** Insert a custom `charts` row directly (bypasses import/RBAC — fixture only). */
async function insertCustomChart(
  t: ReturnType<typeof convexTest>,
  opts: {
    key: string;
    name: string;
    scope: "common" | "personal";
    createdBy: string;
    ownerUserId?: string;
  },
) {
  await t.run((ctx) =>
    ctx.db.insert("charts", {
      key: opts.key,
      name: opts.name,
      scope: opts.scope,
      ...(opts.ownerUserId ? { ownerUserId: opts.ownerUserId as never } : {}),
      tokens: { colors: { light: { primary: "x" }, dark: { primary: "y" } } },
      createdBy: opts.createdBy as never,
      createdAt: 0,
    }),
  );
}

/** Map a domain to a chart directly (isolates brandForHost from the CRUD path). */
async function mapDomain(
  t: ReturnType<typeof convexTest>,
  chartKey: string,
  domain: string,
  createdBy: string,
) {
  await t.run((ctx) =>
    ctx.db.insert("chartDomains", {
      chartKey,
      domain,
      createdBy: createdBy as never,
      createdAt: 0,
    }),
  );
}

// ===========================================================================
// brandForHost — only a TRULY PUBLIC chart may paint an anonymous login
// ===========================================================================

describe("brandForHost (pre-auth) exposure rules", () => {
  test("a BUILTIN mapped to a domain IS exposed (tokens served, default brand)", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedAdmin(t);
    await mapDomain(t, BUILTIN_KEY, "chat.acme.com", admin);

    const r = await t.query(api.charts.brandForHost, { host: "chat.acme.com" });
    expect(r.tokens).not.toBeNull(); // the builtin's palette paints the login
    expect(r.brand.isDefault).toBe(true); // builtins carry the default brand
  });

  test("a CUSTOM 'common' chart mapped to a domain IS exposed (its own label + tokens)", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedAdmin(t);
    await insertCustomChart(t, {
      key: "common-x",
      name: "Common X",
      scope: "common",
      createdBy: admin,
    });
    await mapDomain(t, "common-x", "chat.acme.com", admin);

    const r = await t.query(api.charts.brandForHost, { host: "chat.acme.com" });
    expect(r.tokens).not.toBeNull();
    expect(r.brand.isDefault).toBe(false);
    expect(r.brand.label).toBe("Common X");
  });

  test("a CUSTOM 'common' chart with STALE group rows (promoted from personal) is STILL exposed (consistent with getMe)", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedAdmin(t);
    await insertCustomChart(t, {
      key: "promoted-x",
      name: "Promoted X",
      scope: "common",
      createdBy: admin,
    });
    // A groupCharts row left over from before the chart was promoted to "common".
    // availableChartsForUser offers a common custom to ALL despite such rows, so
    // brandForHost MUST expose it too (else: app paints it for everyone via getMe
    // but the login falls back to the Atrium mark -> a login->app flip).
    await t.run(async (ctx) => {
      const gid = await ctx.db.insert("groups", {
        key: "leftover",
        name: "Leftover",
        createdBy: admin as never,
        createdAt: 0,
      });
      await ctx.db.insert("groupCharts", {
        groupId: gid,
        chartKey: "promoted-x",
        createdAt: 0,
      });
    });
    await mapDomain(t, "promoted-x", "chat.acme.com", admin);

    const r = await t.query(api.charts.brandForHost, { host: "chat.acme.com" });
    expect(r.tokens).not.toBeNull(); // exposed despite the stale group row
    expect(r.brand.label).toBe("Promoted X");
  });

  test("INVERSE: a CUSTOM 'personal' chart mapped to a domain is NOT exposed (no private-brand leak)", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "owner");
    await insertCustomChart(t, {
      key: "perso-x",
      name: "Perso X",
      scope: "personal",
      createdBy: owner,
      ownerUserId: owner,
    });
    await mapDomain(t, "perso-x", "chat.acme.com", owner);

    const r = await t.query(api.charts.brandForHost, { host: "chat.acme.com" });
    expect(r.tokens).toBeNull(); // the owner-private palette never leaks pre-auth
    expect(r.brand.isDefault).toBe(true);
    expect(r.brand.label).not.toBe("Perso X"); // nor does the private name
  });

  test("INVERSE: a GROUP-RESTRICTED builtin mapped to a domain is NOT exposed (no user to evaluate the group)", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedAdmin(t);
    const asAdmin = as(t, admin);
    const groupId = await asAdmin.mutation(api.groups.createGroup, { name: "G" });
    // 3-tier: pool the builtin for the group, then select it (Tier 2) so the
    // group-restriction (>=1 groupCharts row) holds for the pre-auth exposure check.
    await asAdmin.mutation(api.charts.addChartToGroupPool, {
      groupId,
      chartKey: BUILTIN_KEY,
    });
    await asAdmin.mutation(api.charts.assignChartToGroup, {
      groupId,
      chartKey: BUILTIN_KEY,
    });
    await mapDomain(t, BUILTIN_KEY, "chat.acme.com", admin);

    const r = await t.query(api.charts.brandForHost, { host: "chat.acme.com" });
    expect(r.tokens).toBeNull();
    expect(r.brand.isDefault).toBe(true);
  });

  test("INVERSE: an unmapped host, a missing host, and an invalid host all fall back to the app default", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedAdmin(t);
    await mapDomain(t, BUILTIN_KEY, "chat.acme.com", admin);

    for (const host of [
      "unmapped.example.com",
      undefined,
      "localhost",
      "",
    ] as const) {
      const r = await t.query(api.charts.brandForHost, { host });
      expect(r.tokens).toBeNull();
      expect(r.brand.isDefault).toBe(true);
    }
  });
});

// ===========================================================================
// resolveDomainChartKey — most-specific first (exact beats wildcard)
// ===========================================================================

describe("resolveDomainChartKey precedence", () => {
  test("an EXACT host mapping beats a wildcard covering the same host", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedAdmin(t);
    await mapDomain(t, BUILTIN_KEY, "*.acme.com", admin); // wildcard
    await mapDomain(t, BUILTIN_KEY_2, "chat.acme.com", admin); // exact

    const exact = await t.run((ctx) =>
      resolveDomainChartKey(ctx, "chat.acme.com"),
    );
    expect(exact).toBe(BUILTIN_KEY_2); // exact wins

    // a sibling host with no exact row falls to the wildcard
    const wild = await t.run((ctx) =>
      resolveDomainChartKey(ctx, "other.acme.com"),
    );
    expect(wild).toBe(BUILTIN_KEY);
  });

  test("INVERSE: an unmapped / invalid host resolves to null", async () => {
    const t = convexTest(schema, modules);
    expect(await t.run((ctx) => resolveDomainChartKey(ctx, "nope.example.com"))).toBeNull();
    expect(await t.run((ctx) => resolveDomainChartKey(ctx, "localhost"))).toBeNull();
    expect(await t.run((ctx) => resolveDomainChartKey(ctx, undefined))).toBeNull();
  });
});

// ===========================================================================
// addChartDomain / removeChartDomain — admin CRUD + RBAC + inverse cases
// ===========================================================================

describe("addChartDomain / removeChartDomain", () => {
  test("admin maps a domain (normalized) and resolution finds it", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedAdmin(t);
    // Mixed case + port: stored normalized as chat.acme.com.
    await as(t, admin).mutation(api.charts.addChartDomain, {
      chartKey: BUILTIN_KEY,
      domain: "Chat.ACME.com:443",
    });
    const r = await t.query(api.charts.brandForHost, { host: "chat.acme.com" });
    expect(r.tokens).not.toBeNull();
  });

  test("idempotent: mapping the SAME chart+domain twice keeps exactly one row", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedAdmin(t);
    const asAdmin = as(t, admin);
    await asAdmin.mutation(api.charts.addChartDomain, {
      chartKey: BUILTIN_KEY,
      domain: "x.acme.com",
    });
    await asAdmin.mutation(api.charts.addChartDomain, {
      chartKey: BUILTIN_KEY,
      domain: "x.acme.com",
    });
    const rows = await t.run((ctx) =>
      ctx.db.query("chartDomains").collect(),
    );
    expect(rows.filter((row) => row.domain === "x.acme.com")).toHaveLength(1);
  });

  test("listChartsAdmin surfaces each chart's mapped domains (so the admin UI can map domains for PUBLIC charts)", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedAdmin(t);
    const asAdmin = as(t, admin);
    await asAdmin.mutation(api.charts.addChartDomain, {
      chartKey: BUILTIN_KEY,
      domain: "chat.acme.com",
    });
    const rows = await asAdmin.query(api.charts.listChartsAdmin, {});
    expect(rows.find((r) => r.key === BUILTIN_KEY)?.domains).toContain(
      "chat.acme.com",
    );
    // a chart with no mapping carries an empty (never undefined) domains array
    expect(rows.find((r) => r.key === BUILTIN_KEY_2)?.domains).toEqual([]);
  });

  test("INVERSE: a non-admin is rejected on add (permission gate) and NO mapping is created", async () => {
    const t = convexTest(schema, modules);
    const user = await seedUser(t);
    await expect(
      as(t, user).mutation(api.charts.addChartDomain, {
        chartKey: BUILTIN_KEY,
        domain: "x.acme.com",
      }),
      // Specific matcher: the rejection must be the RBAC gate, not an incidental error.
    ).rejects.toThrow(/missing permission/i);
    // ...and it must have had NO effect.
    expect(await t.run((ctx) => ctx.db.query("chartDomains").collect())).toEqual(
      [],
    );
  });

  test("INVERSE: an invalid domain is rejected and NO mapping is created", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedAdmin(t);
    await expect(
      as(t, admin).mutation(api.charts.addChartDomain, {
        chartKey: BUILTIN_KEY,
        domain: "localhost", // normalizeDomain -> null
      }),
    ).rejects.toThrow(/invalide/i);
    expect(await t.run((ctx) => ctx.db.query("chartDomains").collect())).toEqual(
      [],
    );
  });

  test("INVERSE: a domain already mapped to ANOTHER chart is rejected, leaving the FIRST mapping intact", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedAdmin(t);
    const asAdmin = as(t, admin);
    await asAdmin.mutation(api.charts.addChartDomain, {
      chartKey: BUILTIN_KEY,
      domain: "x.acme.com",
    });
    await expect(
      asAdmin.mutation(api.charts.addChartDomain, {
        chartKey: BUILTIN_KEY_2,
        domain: "x.acme.com",
      }),
    ).rejects.toThrow(/déjà associé/i);
    // The original mapping is UNCHANGED (the rejected re-map didn't steal it).
    const row = await t.run((ctx) =>
      ctx.db
        .query("chartDomains")
        .withIndex("by_domain", (q) => q.eq("domain", "x.acme.com"))
        .unique(),
    );
    expect(row?.chartKey).toBe(BUILTIN_KEY);
  });

  test("INVERSE: an unknown chart key is rejected and NO mapping is created", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedAdmin(t);
    await expect(
      as(t, admin).mutation(api.charts.addChartDomain, {
        chartKey: "does-not-exist",
        domain: "x.acme.com",
      }),
    ).rejects.toThrow(/not found/i);
    expect(await t.run((ctx) => ctx.db.query("chartDomains").collect())).toEqual(
      [],
    );
  });

  test("removeChartDomain: admin unmaps; non-admin rejected; removing a missing mapping is a no-op", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedAdmin(t);
    const user = await seedUser(t);
    const asAdmin = as(t, admin);
    await asAdmin.mutation(api.charts.addChartDomain, {
      chartKey: BUILTIN_KEY,
      domain: "x.acme.com",
    });

    // non-admin cannot remove (permission gate) — and the mapping SURVIVES.
    await expect(
      as(t, user).mutation(api.charts.removeChartDomain, {
        chartKey: BUILTIN_KEY,
        domain: "x.acme.com",
      }),
    ).rejects.toThrow(/missing permission/i);
    expect(
      (await t.query(api.charts.brandForHost, { host: "x.acme.com" })).tokens,
    ).not.toBeNull();

    // admin removes -> the host no longer resolves
    await asAdmin.mutation(api.charts.removeChartDomain, {
      chartKey: BUILTIN_KEY,
      domain: "x.acme.com",
    });
    const r = await t.query(api.charts.brandForHost, { host: "x.acme.com" });
    expect(r.tokens).toBeNull();

    // idempotent: removing a never-mapped domain does not throw
    await asAdmin.mutation(api.charts.removeChartDomain, {
      chartKey: BUILTIN_KEY,
      domain: "never.acme.com",
    });
  });
});

// ===========================================================================
// getMe × domain × availability — the POST-auth wiring (resolveChart "domain"
// tier only fires when the domain chart is actually AVAILABLE to the user).
// ===========================================================================

describe("getMe domain resolution", () => {
  test("a COMMON chart mapped to the request host resolves with source 'domain' (and only WITH the host)", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedAdmin(t);
    const user = await seedUser(t, "viewer");
    await insertCustomChart(t, {
      key: "dom-common",
      name: "Domain Common",
      scope: "common",
      createdBy: admin,
    });
    await mapDomain(t, "dom-common", "chat.acme.com", admin);

    // WITH the host → the domain chart wins (no user pick, common ⇒ available).
    const withHost = await as(t, user).query(api.me.getMe, {
      host: "chat.acme.com",
    });
    expect(withHost.resolvedChartKey).toBe("dom-common");
    expect(withHost.chartSource).toBe("domain");

    // WITHOUT the host → the domain tier never fires.
    const noHost = await as(t, user).query(api.me.getMe, {});
    expect(noHost.chartSource).not.toBe("domain");
    expect(noHost.resolvedChartKey).not.toBe("dom-common");
  });

  test("INVERSE: a PERSONAL chart mapped to a host applies for its OWNER but NOT for another user", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "owner");
    const other = await seedUser(t, "other");
    await insertCustomChart(t, {
      key: "dom-perso",
      name: "Domain Perso",
      scope: "personal",
      createdBy: owner,
      ownerUserId: owner,
    });
    await mapDomain(t, "dom-perso", "chat.acme.com", owner);

    // Owner: the personal chart IS available ⇒ domain tier applies.
    const asOwner = await as(t, owner).query(api.me.getMe, {
      host: "chat.acme.com",
    });
    expect(asOwner.resolvedChartKey).toBe("dom-perso");
    expect(asOwner.chartSource).toBe("domain");

    // Non-owner: the personal chart is NOT available ⇒ domain tier is skipped
    // (isChartAvailableToUser gate), so the private chart never applies for them.
    const asOther = await as(t, other).query(api.me.getMe, {
      host: "chat.acme.com",
    });
    expect(asOther.resolvedChartKey).not.toBe("dom-perso");
    expect(asOther.chartSource).not.toBe("domain");
  });
});

// ===========================================================================
// setChartLogo — SERVER-SIDE store (the action mints the storageId from the
// uploaded BYTES, so there is no client-provided id to alias/replay/share — the
// whole IDOR / shared-blob data-loss class is eliminated structurally).
// ===========================================================================

// Minimal valid PNG signature (passes sniffWebpOrPng); the body is irrelevant.
const PNG_MAGIC = () =>
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer;

describe("setChartLogo (server-side store)", () => {
  test("a valid logo is stored SERVER-SIDE and attached to the chart", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedAdmin(t);
    const chartId = await t.run((ctx) =>
      ctx.db.insert("charts", {
        key: "logo-ok",
        name: "OK",
        scope: "common" as const,
        tokens: { colors: { light: {}, dark: {} } },
        createdBy: admin as never,
        createdAt: 0,
      }),
    );
    await as(t, admin).action(api.charts.setChartLogo, {
      chartId,
      bytes: PNG_MAGIC(),
      mode: "light",
    });
    const stored = await t.run((ctx) => ctx.db.get(chartId));
    expect(stored?.logoLightStorageId).toBeDefined();
    // The id is server-minted -> a real blob exists behind it. (The PNG-vs-WebP
    // Content-Type DERIVATION itself is pinned directly by the detectLogoMime tests
    // below; convex-test's storage emulator does not record a blob's contentType,
    // so it can't be asserted through the store path here.)
    expect(
      await t.run((ctx) => ctx.storage.getUrl(stored!.logoLightStorageId!)),
    ).not.toBeNull();
  });

  test("WebP magic bytes are ACCEPTED and stored (the other valid logo format)", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedAdmin(t);
    const chartId = await t.run((ctx) =>
      ctx.db.insert("charts", {
        key: "logo-webp",
        name: "WebP",
        scope: "common" as const,
        tokens: { colors: { light: {}, dark: {} } },
        createdBy: admin as never,
        createdAt: 0,
      }),
    );
    const webpBytes = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
    ]).buffer;
    await as(t, admin).action(api.charts.setChartLogo, {
      chartId,
      bytes: webpBytes,
      mode: "dark",
    });
    // The WebP sniff branch accepts it -> a blob is minted + attached for dark.
    const id = (await t.run((ctx) => ctx.db.get(chartId)))?.logoDarkStorageId;
    expect(id).toBeDefined();
    expect(await t.run((ctx) => ctx.storage.getUrl(id!))).not.toBeNull();
  });

  test("INVERSE: a caller who may NOT edit the chart is rejected, and NOTHING is stored", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "owner");
    const attacker = await seedUser(t, "attacker");
    const chartId = await t.run((ctx) =>
      ctx.db.insert("charts", {
        key: "victim",
        name: "Victim",
        scope: "personal" as const,
        ownerUserId: owner as never,
        tokens: { colors: { light: {}, dark: {} } },
        createdBy: owner as never,
        createdAt: 0,
      }),
    );
    await expect(
      as(t, attacker).action(api.charts.setChartLogo, {
        chartId,
        bytes: PNG_MAGIC(),
        mode: "light",
      }),
    ).rejects.toThrow(/forbidden|not your/i);
    // Authorization fails BEFORE any blob is minted -> the chart has no logo.
    const stored = await t.run((ctx) => ctx.db.get(chartId));
    expect(stored?.logoLightStorageId).toBeUndefined();
  });

  test("INVERSE: non-image bytes are rejected (magic-byte sniff)", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedAdmin(t);
    const chartId = await t.run((ctx) =>
      ctx.db.insert("charts", {
        key: "logo-bad",
        name: "Bad",
        scope: "common" as const,
        tokens: { colors: { light: {}, dark: {} } },
        createdBy: admin as never,
        createdAt: 0,
      }),
    );
    await expect(
      as(t, admin).action(api.charts.setChartLogo, {
        chartId,
        bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer, // not WebP/PNG
        mode: "light",
      }),
    ).rejects.toThrow(/non valide|format/i);
    // Rejected at the sniff -> nothing stored on the chart.
    expect((await t.run((ctx) => ctx.db.get(chartId)))?.logoLightStorageId).toBeUndefined();
  });

  test("INVERSE: oversized bytes are rejected before storing", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedAdmin(t);
    const chartId = await t.run((ctx) =>
      ctx.db.insert("charts", {
        key: "logo-big",
        name: "Big",
        scope: "common" as const,
        tokens: { colors: { light: {}, dark: {} } },
        createdBy: admin as never,
        createdAt: 0,
      }),
    );
    await expect(
      as(t, admin).action(api.charts.setChartLogo, {
        chartId,
        bytes: new Uint8Array(1024 * 1024 + 1).buffer, // > MAX_LOGO_BYTES
        mode: "light",
      }),
    ).rejects.toThrow(/volumineuse/i);
    // Rejected before any store -> no logo on the chart.
    expect((await t.run((ctx) => ctx.db.get(chartId)))?.logoLightStorageId).toBeUndefined();
  });
});

// ===========================================================================
// detectLogoMime — the STORED Content-Type is derived from the magic bytes
// (a PNG produced as the WebP-encode fallback must not be mislabeled webp).
// ===========================================================================

describe("detectLogoMime", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const WEBP = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
  ]);

  test("derives the REAL MIME per signature (PNG stays png, WebP stays webp)", () => {
    // Discriminates the fix: if the PNG branch returned "image/webp", this fails.
    expect(detectLogoMime(PNG)).toBe("image/png");
    expect(detectLogoMime(WEBP)).toBe("image/webp");
  });

  test("returns null for non-image OR truncated magic (rejected, never stored)", () => {
    expect(detectLogoMime(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull();
    expect(detectLogoMime(PNG.slice(0, 4))).toBeNull(); // too short for the PNG sig
    expect(detectLogoMime(WEBP.slice(0, 8))).toBeNull(); // RIFF but no "WEBP" tag
  });
});
