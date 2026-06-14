/// <reference types="vite/client" />
//
// admin.deleteUser — the destructive "remove a user" action. Pins:
//  - the requireAdmin gate (a regular user can't call it);
//  - the self-delete guard (an admin can't delete their OWN profile, even though
//    the row is reachable in the list — requireAdmin returns the REAL id);
//  - the owned-data cascade: a user's chat (+message+part), notification and
//    agent grant are ALL purged (chat data via the shared cascadeDeleteChat),
//    while a SECOND user's data is left untouched;
//  - an audit row ("user.delete") is written;
//  - the duplicate-identity cleanup: two profiles share an email (Google +
//    Microsoft of the same person); deleting the dup keeps the canonical profile
//    and its data, so the kept identity can still sign in (P1 then re-blocks the
//    dangling provider).

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

type T = ReturnType<typeof convexTest>;

async function seedAdmin(t: T) {
  return await t.run(async (ctx) => {
    const uid = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId: uid, role: "admin" as const });
    return uid;
  });
}

/** A regular user WITH owned data across every cascaded table. Returns the ids
 *  so the test can assert each row was purged. */
async function seedUserWithData(t: T, email?: string) {
  return await t.run(async (ctx) => {
    const uid = await ctx.db.insert("users", {});
    const profileId = await ctx.db.insert("profiles", {
      userId: uid,
      role: "user" as const,
      ...(email ? { email } : {}),
    });
    const chatId = await ctx.db.insert("chats", { userId: uid, updatedAt: 0 });
    const messageId = await ctx.db.insert("messages", {
      chatId,
      userId: uid,
      role: "user" as const,
      status: "complete" as const,
      text: "hi",
      updatedAt: 0,
    });
    const partId = await ctx.db.insert("messageParts", {
      messageId,
      order: 0,
      part: { kind: "reasoning" as const, text: "x" },
    });
    const notifId = await ctx.db.insert("notifications", {
      userId: uid,
      kind: "feedback_reply" as const,
      title: "t",
      body: "b",
      createdAt: 0,
    });
    const agentId = await ctx.db.insert("userAgents", {
      userId: uid,
      instanceName: "primary",
      agentId: "main",
      isDefault: true,
      source: "manual" as const,
      createdAt: 0,
    });
    return { uid, profileId, chatId, messageId, partId, notifId, agentId };
  });
}

const asUser = (t: T, uid: string) =>
  t.withIdentity({ subject: `${uid}|session` });

describe("admin.deleteUser", () => {
  test("a non-admin caller is refused", async () => {
    const t = convexTest(schema, modules);
    const caller = await seedUserWithData(t);
    const victim = await seedUserWithData(t);
    await expect(
      asUser(t, caller.uid).mutation(api.admin.deleteUser, {
        profileId: victim.profileId,
      }),
    ).rejects.toThrow();
    // The victim survived (the gate fired before any write).
    expect(await t.run((ctx) => ctx.db.get(victim.profileId))).not.toBeNull();
  });

  test("an admin cannot delete their own account", async () => {
    const t = convexTest(schema, modules);
    const adminUid = await seedAdmin(t);
    const ownProfile = await t.run((ctx) =>
      ctx.db
        .query("profiles")
        .collect()
        .then((rows) => rows.find((r) => r.userId === adminUid)!),
    );
    await expect(
      asUser(t, adminUid).mutation(api.admin.deleteUser, {
        profileId: ownProfile._id,
      }),
    ).rejects.toThrow(/your own account/i);
    expect(await t.run((ctx) => ctx.db.get(ownProfile._id))).not.toBeNull();
  });

  test("deletes the user + ALL owned data, leaving other users untouched", async () => {
    const t = convexTest(schema, modules);
    const adminUid = await seedAdmin(t);
    const target = await seedUserWithData(t);
    const bystander = await seedUserWithData(t);

    await asUser(t, adminUid).mutation(api.admin.deleteUser, {
      profileId: target.profileId,
    });

    // Every owned row of the target is gone.
    await t.run(async (ctx) => {
      expect(await ctx.db.get(target.profileId)).toBeNull();
      expect(await ctx.db.get(target.chatId)).toBeNull();
      expect(await ctx.db.get(target.messageId)).toBeNull();
      expect(await ctx.db.get(target.partId)).toBeNull();
      expect(await ctx.db.get(target.notifId)).toBeNull();
      expect(await ctx.db.get(target.agentId)).toBeNull();
      // The bystander is fully intact.
      expect(await ctx.db.get(bystander.profileId)).not.toBeNull();
      expect(await ctx.db.get(bystander.chatId)).not.toBeNull();
      expect(await ctx.db.get(bystander.messageId)).not.toBeNull();
      expect(await ctx.db.get(bystander.agentId)).not.toBeNull();
      // An audit row attributes the deletion.
      const audit = await ctx.db.query("auditLog").collect();
      const del = audit.find((a) => a.action === "user.delete");
      expect(del).toBeDefined();
      expect(del!.realUserId).toBe(adminUid);
      expect(del!.resourceId).toBe(target.uid);
    });
  });

  test("duplicate-identity cleanup: deleting the dup keeps the canonical one", async () => {
    const t = convexTest(schema, modules);
    const adminUid = await seedAdmin(t);
    // Same human, two OAuth identities sharing one email.
    const kept = await seedUserWithData(t, "dupe@example.com");
    const dup = await seedUserWithData(t, "dupe@example.com");

    await asUser(t, adminUid).mutation(api.admin.deleteUser, {
      profileId: dup.profileId,
    });

    await t.run(async (ctx) => {
      expect(await ctx.db.get(dup.profileId)).toBeNull();
      // The canonical profile + its data are intact -> still usable.
      expect(await ctx.db.get(kept.profileId)).not.toBeNull();
      expect(await ctx.db.get(kept.chatId)).not.toBeNull();
      // Exactly one profile now owns the shared email.
      const owners = (await ctx.db.query("profiles").collect()).filter(
        (p) => p.email === "dupe@example.com",
      );
      expect(owners).toHaveLength(1);
      expect(owners[0]!._id).toBe(kept.profileId);
    });
  });
});
