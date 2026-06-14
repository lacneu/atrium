/// <reference types="vite/client" />
//
// Generic notification feed: per-user read/clear, the badge count, the
// impersonation-safe write rule (an admin peeking AS a user never mutates the
// target's feed), and the feedback-reply producer (non-PHI label, never the
// reply text).

import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "user" | "admin" = "user",
) {
  return t.run(async (ctx) => {
    const uid = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId: uid, role, canonical: "u" });
    return uid;
  });
}
const seedNotif = (
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  extra: Record<string, unknown> = {},
) =>
  t.run((ctx) =>
    ctx.db.insert("notifications", {
      userId,
      kind: "anomaly_open" as const,
      title: "T",
      body: "B",
      createdAt: 1,
      ...extra,
    }),
  );

describe("notifications — read/clear", () => {
  test("unread count + markRead + markAllRead", async () => {
    const t = convexTest(schema, modules);
    const uid = await seedUser(t);
    const n1 = await seedNotif(t, uid);
    await seedNotif(t, uid, { readAt: 5 }); // already read
    const as = t.withIdentity({ subject: `${uid}|session` });

    expect(await as.query(api.notifications.myUnreadCount, {})).toBe(1);
    await as.mutation(api.notifications.markRead, { notificationId: n1 });
    expect(await as.query(api.notifications.myUnreadCount, {})).toBe(0);
    const list = await as.query(api.notifications.myNotifications, {});
    expect(list.length).toBe(2);
    expect(list.every((x) => !x.unread)).toBe(true);
  });

  test("clearOne + clearAll (even unread)", async () => {
    const t = convexTest(schema, modules);
    const uid = await seedUser(t);
    const n1 = await seedNotif(t, uid);
    await seedNotif(t, uid);
    const as = t.withIdentity({ subject: `${uid}|session` });
    await as.mutation(api.notifications.clearOne, { notificationId: n1 });
    expect((await as.query(api.notifications.myNotifications, {})).length).toBe(1);
    await as.mutation(api.notifications.clearAll, {});
    expect((await as.query(api.notifications.myNotifications, {})).length).toBe(0);
  });

  test("bulk actions drain across transactions beyond one batch (BULK_BATCH=256)", async () => {
    // Codex R2-P2: markAllRead/clearAll process a bounded batch then self-schedule
    // the rest. Seed MORE than one batch and prove the scheduled chain drains it.
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, modules);
      const uid = await seedUser(t);
      const N = 300; // > BULK_BATCH (256) -> at least two transactions
      await t.run(async (ctx) => {
        for (let i = 0; i < N; i++) {
          await ctx.db.insert("notifications", {
            userId: uid,
            kind: "anomaly_open" as const,
            title: "T",
            body: "B",
            createdAt: i,
          });
        }
      });
      const as = t.withIdentity({ subject: `${uid}|session` });

      // markAllRead: first batch runs inline, the tail drains via the scheduler.
      // (cutoff = newest existing row's _creationTime, so all 300 are in range.)
      await as.mutation(api.notifications.markAllRead, {});
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(await as.query(api.notifications.myUnreadCount, {})).toBe(0);

      // clearAll: same drain, deletes everything (read OR unread).
      await as.mutation(api.notifications.clearAll, {});
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const left = await t.run((ctx) => ctx.db.query("notifications").collect());
      expect(left.length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("bulk drain respects the click cutoff (a row arriving mid-drain is spared)", async () => {
    // Codex R3-P1: the continuation must NOT consume notifications created AFTER
    // the user clicked. We drive the internal continuation directly with a cutoff
    // BETWEEN an old row and a newer one — deterministic, no scheduler/timers.
    const t = convexTest(schema, modules);
    const uid = await seedUser(t);
    const older = await seedNotif(t, uid); // exists at click
    const newer = await seedNotif(t, uid); // "arrives" after the cutoff
    const [olderCt, newerCt] = await t.run(async (ctx) => {
      const a = await ctx.db.get(older);
      const b = await ctx.db.get(newer);
      return [a!._creationTime, b!._creationTime];
    });
    expect(newerCt).toBeGreaterThan(olderCt); // convex-test bumps each insert

    // markAllRead drain bounded at `olderCt`: marks `older`, spares `newer`.
    await t.mutation(internal.notifications.markAllReadContinue, {
      userId: uid,
      cutoff: olderCt,
    });
    const afterMark = await t.run(async (ctx) => ({
      older: await ctx.db.get(older),
      newer: await ctx.db.get(newer),
    }));
    expect(afterMark.older?.readAt).not.toBeUndefined();
    expect(afterMark.newer?.readAt).toBeUndefined(); // mid-drain arrival untouched

    // clearAll drain bounded at `olderCt`: deletes `older`, keeps `newer`.
    await t.mutation(internal.notifications.clearAllContinue, {
      userId: uid,
      cutoff: olderCt,
    });
    const left = await t.run((ctx) =>
      ctx.db
        .query("notifications")
        .withIndex("by_user", (q) => q.eq("userId", uid))
        .collect(),
    );
    expect(left.map((r) => r._id)).toEqual([newer]); // only the fresh one remains
  });

  test("writes NO-OP under impersonation; reads see the target's feed", async () => {
    const t = convexTest(schema, modules);
    const targetId = await seedUser(t, "user");
    const n1 = await seedNotif(t, targetId);
    const adminId = await t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", {
        userId: uid,
        role: "admin",
        canonical: "a",
        impersonatingUserId: targetId,
      });
      return uid;
    });
    const asAdmin = t.withIdentity({ subject: `${adminId}|session` });

    // Reads resolve the EFFECTIVE (impersonated) user's feed…
    expect(await asAdmin.query(api.notifications.myUnreadCount, {})).toBe(1);
    // …but writes are no-ops, so the target's feed is untouched.
    await asAdmin.mutation(api.notifications.markRead, { notificationId: n1 });
    await asAdmin.mutation(api.notifications.clearAll, {});
    const still = await t.run((ctx) => ctx.db.get(n1));
    expect(still?.readAt).toBeUndefined();
  });
});

describe("admin fan-out (UI-10 review R5) — scheduled + paginated", () => {
  test("notifies EVERY admin (not non-admins), idempotent per event", async () => {
    const t = convexTest(schema, modules);
    const a1 = await seedUser(t, "admin");
    const a2 = await seedUser(t, "admin");
    const u = await seedUser(t, "user"); // must NOT be notified
    const args = {
      kind: "anomaly_open" as const,
      title: "Anomalie : x",
      body: "msg",
      href: "/settings/anomalies",
      dedupeKey: "anomaly_open:abc",
    };
    await t.mutation(internal.notifications.fanOutAnomalyToAdmins, args);

    const count = (uid: Id<"users">) =>
      t.run(async (ctx) =>
        (
          await ctx.db
            .query("notifications")
            .withIndex("by_user", (q) => q.eq("userId", uid))
            .collect()
        ).length,
      );
    expect(await count(a1)).toBe(1);
    expect(await count(a2)).toBe(1);
    expect(await count(u)).toBe(0); // non-admin spared

    // Same event again → dedupeKey makes it a no-op (no double-notify).
    await t.mutation(internal.notifications.fanOutAnomalyToAdmins, args);
    expect(await count(a1)).toBe(1);
    expect(await count(a2)).toBe(1);
  });

  test("fan-out drains across pages beyond one batch (FANOUT_PAGE=100)", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, modules);
      const N = 105; // > FANOUT_PAGE -> at least two scheduled transactions
      const admins = await t.run(async (ctx) => {
        const ids: Id<"users">[] = [];
        for (let i = 0; i < N; i++) {
          const uid = await ctx.db.insert("users", {});
          await ctx.db.insert("profiles", {
            userId: uid,
            role: "admin" as const,
            canonical: `a${i}`,
          });
          ids.push(uid);
        }
        return ids;
      });

      await t.mutation(internal.notifications.fanOutAnomalyToAdmins, {
        kind: "anomaly_resolved" as const,
        title: "résolue",
        body: "msg",
        dedupeKey: "anomaly_resolved:z",
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const total = await t.run(
        async (ctx) => (await ctx.db.query("notifications").collect()).length,
      );
      expect(total).toBe(N); // every admin got exactly one, across pages
      // spot-check the last admin (only reachable via the 2nd page)
      const last = await t.run(async (ctx) =>
        ctx.db
          .query("notifications")
          .withIndex("by_user", (q) => q.eq("userId", admins[N - 1]))
          .collect(),
      );
      expect(last.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("feedback reply → notification (UI-10c)", () => {
  test("respondToFeedback notifies the owner with a NON-PHI label", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await seedUser(t, "user");
    const adminId = await seedUser(t, "admin");
    const fbId = await t.run(async (ctx) => {
      const chatId = await ctx.db.insert("chats", {
        userId: ownerId,
        updatedAt: 1,
      });
      const messageId = await ctx.db.insert("messages", {
        chatId,
        userId: ownerId,
        role: "assistant",
        status: "complete",
        text: "x",
        updatedAt: 1,
      });
      return ctx.db.insert("feedback", {
        userId: ownerId,
        realUserId: ownerId,
        impersonated: false,
        chatId,
        messageId,
        at: 1,
        category: "other",
        snapshot: { messageRole: "assistant", messageText: "x" },
      });
    });

    await t
      .withIdentity({ subject: `${adminId}|session` })
      .mutation(api.feedback.respondToFeedback, {
        feedbackId: fbId,
        text: "voici la réponse secrète",
      });

    const list = await t
      .withIdentity({ subject: `${ownerId}|session` })
      .query(api.notifications.myNotifications, {});
    const fr = list.find((n) => n.kind === "feedback_reply");
    expect(fr).toBeTruthy();
    expect(fr?.body ?? "").not.toContain("secrète"); // reply text never leaked
    // R4: clickable — deep-links to the reported conversation.
    expect(fr?.href).toMatch(/^\/chat\//);
  });
});
