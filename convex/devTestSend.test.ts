/// <reference types="vite/client" />
//
// Codex P2 regression: the dev-only live-harness `testSend` enforces the
// "never touch protected tenants" barrier by gating the instance the send will
// ACTUALLY reach — i.e. the target resolved by `resolveTargetForChat`
// (chat binding first, else the user's DEFAULT userAgents row) — NOT an
// arbitrary `.first()` assignment. A user can legitimately hold an allowlisted
// assignment AND a non-allowlisted one; gating `.first()` would let a send slip
// through to the protected instance via a binding or a non-first default.

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

let prevAnon: string | undefined;
beforeEach(() => {
  prevAnon = process.env.OPENCLAW_ENABLE_ANON_AUTH;
  process.env.OPENCLAW_ENABLE_ANON_AUTH = "1"; // unlock dev.* helpers
});
afterEach(() => {
  if (prevAnon === undefined) delete process.env.OPENCLAW_ENABLE_ANON_AUTH;
  else process.env.OPENCLAW_ENABLE_ANON_AUTH = prevAnon;
});

async function seedAdmin(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const uid = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", {
      userId: uid,
      role: "admin",
      canonical: "alice",
    });
    return uid;
  });
}
const seedUA = (
  t: ReturnType<typeof convexTest>,
  userId: string,
  instanceName: string,
  agentId: string,
  isDefault: boolean,
) =>
  t.run((ctx) =>
    ctx.db.insert("userAgents", {
      userId: userId as never,
      instanceName,
      agentId,
      isDefault,
      source: "manual",
      createdAt: 1,
    }),
  );

describe("dev.testSend — gates the RESOLVED target (Codex P2)", () => {
  test("refuses when the user DEFAULT is a non-allowlisted instance, even though .first() is allowlisted", async () => {
    const t = convexTest(schema, modules);
    const uid = await seedAdmin(t);
    // .first() (by_user, insertion order) → the allowlisted "admin" row…
    await seedUA(t, uid, "admin", "alice", false);
    // …but the DEFAULT (what dispatch actually uses) is the protected instance.
    await seedUA(t, uid, "family", "bob", true);
    await expect(
      t.mutation(api.dev.testSend, { text: "hello" }),
    ).rejects.toThrow(/family|restricted|never touch/i);
  });

  test("refuses when the CHAT is bound to a non-allowlisted instance, even though .first() is allowlisted", async () => {
    const t = convexTest(schema, modules);
    const uid = await seedAdmin(t);
    await seedUA(t, uid, "admin", "alice", true); // allowlisted default + .first()
    await seedUA(t, uid, "family", "bob", false); // also assigned (legit)
    const chatId = await t.run((ctx) =>
      ctx.db.insert("chats", {
        userId: uid as never,
        updatedAt: 1,
        instanceName: "family", // chat binding → dispatch targets THIS
        agentId: "bob",
      }),
    );
    await expect(
      t.mutation(api.dev.testSend, { text: "hi", chatId }),
    ).rejects.toThrow(/family|restricted|never touch/i);
  });

  test("allows a fresh send when the resolved default is the allowlisted instance", async () => {
    const t = convexTest(schema, modules);
    const uid = await seedAdmin(t);
    await seedUA(t, uid, "admin", "alice", true);
    const r = await t.mutation(api.dev.testSend, { text: "hello" });
    expect(r.ok).toBe(true);
  });

  test("refuses when the test user has no resolvable agent", async () => {
    const t = convexTest(schema, modules);
    await seedAdmin(t); // no userAgents at all
    const r = await t.mutation(api.dev.testSend, { text: "hello" });
    expect(r).toMatchObject({ ok: false });
  });

  test("no-chatId send picks a ROUTED profile, not just the first admin (Codex P3)", async () => {
    const t = convexTest(schema, modules);
    await seedAdmin(t); // admin with NO agents
    // A routed NON-admin (as routeUser({email}) would leave it).
    const routedUid = await t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId: uid,
        role: "user",
        canonical: "alice",
        email: "u@x.com",
      });
      return uid;
    });
    await seedUA(t, routedUid, "admin", "alice", true); // only this user is routed
    const r = await t.mutation(api.dev.testSend, { text: "hi" });
    // Resolves via the routed user (instance "admin"), not no_agent on the admin.
    expect(r).toMatchObject({ ok: true });
  });
});

describe("dev.routeUser — re-run promotes an existing assignment to default (Codex P3)", () => {
  test("a re-run for an existing NON-default (instance,agent) makes it the default", async () => {
    const t = convexTest(schema, modules);
    await seedAdmin(t); // routeUser targets this admin profile
    const base = { instanceName: "admin", gatewayUrl: "ws://x", canonical: "alice" };
    await t.mutation(api.dev.routeUser, { ...base, agentId: "a1" }); // a1 default
    await t.mutation(api.dev.routeUser, { ...base, agentId: "a2" }); // a2 default, a1 not
    await t.mutation(api.dev.routeUser, { ...base, agentId: "a1" }); // re-run a1
    const rows = await t.run((ctx) => ctx.db.query("userAgents").collect());
    expect(rows.find((r) => r.agentId === "a1")!.isDefault).toBe(true); // promoted back
    expect(rows.find((r) => r.agentId === "a2")!.isDefault).toBe(false);
    expect(rows.filter((r) => r.isDefault).length).toBe(1); // still exactly one
  });
});

describe("dev user switcher (listUsersDev / setMyRole)", () => {
  test("lists profiles + marks the caller; setMyRole flips the caller's role", async () => {
    const t = convexTest(schema, modules);
    const meId = await seedAdmin(t); // role admin, canonical "alice"
    await t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId: uid, role: "user", canonical: "alice" });
    });
    const as = t.withIdentity({ subject: `${meId}|session` });

    const list = await as.query(api.dev.listUsersDev, {});
    expect(list.length).toBe(2);
    expect(list.find((u) => u.isMe)?.role).toBe("admin"); // caller marked + role
    expect(list.some((u) => u.canonical === "alice" && !u.isMe)).toBe(true);

    await as.mutation(api.dev.setMyRole, { role: "user" }); // self escape hatch
    const after = await as.query(api.dev.listUsersDev, {});
    expect(after.find((u) => u.isMe)?.role).toBe("user");
  });
});

describe("dev.enqueueAttachmentTurn — gates the RESOLVED target (Codex P2)", () => {
  test("refuses when the user DEFAULT is a non-allowlisted instance, even though .first() is allowlisted", async () => {
    const t = convexTest(schema, modules);
    const uid = await seedAdmin(t);
    await seedUA(t, uid, "admin", "alice", false); // .first() → allowlisted
    await seedUA(t, uid, "family", "bob", true); // DEFAULT → protected instance
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["x"])));
    await expect(
      t.mutation(internal.dev.enqueueAttachmentTurn, {
        storageId,
        filename: "a.png",
        mimeType: "image/png",
        text: "hi",
      }),
    ).rejects.toThrow(/family|restricted|never touch/i);
  });
});
