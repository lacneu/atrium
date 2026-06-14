/// <reference types="vite/client" />
//
// Multi-agent backbone invariants (red-team-critical):
//  - discovery is RESILIENT: a failed poll keeps last-good + lastOkAt; an agent
//    absent from a SUCCESSFUL poll flips presentInLastOk (deleted) but is NEVER
//    removed from the cache (B2 / blind-spot-1).
//  - assignAgent only accepts DISCOVERED + present agents (prod-bug fix / M1).
//  - exactly one default whenever >=1 userAgent (first→default, setDefault clears
//    the old, removeAgent re-elects — H2/H3).

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const A = (
  agentId: string,
  isDefaultOnInstance = false,
  displayName: string | null = null,
) => ({ agentId, displayName, emoji: null, model: "m", isDefaultOnInstance });

async function seedAdminAndTarget(t: ReturnType<typeof convexTest>) {
  const adminId = await t.run(async (ctx) => {
    const uid = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId: uid, role: "admin" });
    return uid;
  });
  const { profileId, userId } = await t.run(async (ctx) => {
    const uid = await ctx.db.insert("users", {});
    const pid = await ctx.db.insert("profiles", { userId: uid, role: "user" });
    return { profileId: pid, userId: uid };
  });
  return {
    as: t.withIdentity({ subject: `${adminId}|session` }),
    profileId,
    userId,
  };
}

// Filter in JS (convexTest's t.run ctx loses index types via ReturnType<...>).
const uaOf = async (t: ReturnType<typeof convexTest>, userId: string) => {
  const rows = await t.run((ctx) => ctx.db.query("userAgents").collect());
  return rows.filter((r) => r.userId === userId);
};

describe("discovery cache resilience (B2)", () => {
  test("successful poll inserts present agents; a later poll omitting one marks it deleted (not removed)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.agents.applyDiscovery, {
      instanceName: "prod",
      agents: [A("alice", true), A("bob")],
    });
    let rows = await t.run((ctx) =>
      ctx.db
        .query("agents")
        .withIndex("by_instance", (q) => q.eq("instanceName", "prod"))
        .collect(),
    );
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.presentInLastOk)).toBe(true);

    // bob deleted on the gateway -> omitted from the next SUCCESSFUL poll.
    await t.mutation(internal.agents.applyDiscovery, {
      instanceName: "prod",
      agents: [A("alice", true)],
    });
    rows = await t.run((ctx) =>
      ctx.db
        .query("agents")
        .withIndex("by_instance", (q) => q.eq("instanceName", "prod"))
        .collect(),
    );
    expect(rows.length).toBe(2); // never removed
    expect(rows.find((r) => r.agentId === "bob")!.presentInLastOk).toBe(false);
    expect(rows.find((r) => r.agentId === "alice")!.presentInLastOk).toBe(true);
  });

  test("a FAILED poll preserves last-good rows + lastOkAt, flips lastPollOk", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.agents.applyDiscovery, {
      instanceName: "prod",
      agents: [A("alice", true)],
    });
    await t.mutation(internal.agents.recordDiscoveryFailure, {
      instanceName: "prod",
      error: "unreachable",
    });
    const disc = await t.run((ctx) =>
      ctx.db
        .query("instanceDiscovery")
        .withIndex("by_instance", (q) => q.eq("instanceName", "prod"))
        .unique(),
    );
    expect(disc!.lastPollOk).toBe(false);
    expect(disc!.error).toBe("unreachable");
    expect(typeof disc!.lastOkAt).toBe("number"); // staleness window preserved
    const rows = await t.run((ctx) =>
      ctx.db
        .query("agents")
        .withIndex("by_instance", (q) => q.eq("instanceName", "prod"))
        .collect(),
    );
    expect(rows.length).toBe(1); // cache NOT emptied
    expect(rows[0].presentInLastOk).toBe(true); // presence NOT flipped on failure
  });

  test("empty discovery: allowEmpty marks ALL deleted (genuine); without it, presence is kept (shape-drift) — Codex P2", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.agents.applyDiscovery, {
      instanceName: "prod",
      agents: [A("alice", true), A("bob")],
    });
    const rowsOf = () =>
      t.run((ctx) =>
        ctx.db
          .query("agents")
          .withIndex("by_instance", (q) => q.eq("instanceName", "prod"))
          .collect(),
      );

    // Shape-drift / old-bridge empty (no allowEmpty) → presence PRESERVED (MAJOR 1).
    await t.mutation(internal.agents.applyDiscovery, { instanceName: "prod", agents: [] });
    let rows = await rowsOf();
    expect(rows.every((r) => r.presentInLastOk)).toBe(true);

    // GENUINELY empty gateway (allowEmpty) → every agent flipped deleted (Codex P2),
    // never removed.
    await t.mutation(internal.agents.applyDiscovery, {
      instanceName: "prod",
      agents: [],
      allowEmpty: true,
    });
    rows = await rowsOf();
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.presentInLastOk === false)).toBe(true);
  });

  // IDEMPOTENT WRITES (prod incident): the 2-min discovery poll must NOT rewrite
  // `agents` / `instanceDiscovery` when nothing a consumer reads changed — a
  // steady-state rewrite invalidates the reactive chat queries (enrichUserAgents)
  // every interval, a re-execution storm a constrained backend can't sustain.
  test("a steady-state poll re-seeing identical agents does NOT rewrite the row (no churn), but a CHANGE does", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.agents.applyDiscovery, {
      instanceName: "prod",
      agents: [A("alice", true, "Alice")],
    });
    // Stamp a sentinel so a later write is detectable (lastSeenAt is unread).
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("agents").collect())[0];
      await ctx.db.patch(row._id, { lastSeenAt: 1 });
    });
    // IDENTICAL poll → SKIP → lastSeenAt stays 1.
    await t.mutation(internal.agents.applyDiscovery, {
      instanceName: "prod",
      agents: [A("alice", true, "Alice")],
    });
    let row = (await t.run((ctx) => ctx.db.query("agents").collect()))[0];
    expect(row.lastSeenAt).toBe(1);
    expect(row.displayName).toBe("Alice");
    // A CHANGED poll (new displayName) → WRITES → lastSeenAt moves off the sentinel.
    await t.mutation(internal.agents.applyDiscovery, {
      instanceName: "prod",
      agents: [A("alice", true, "Renamed")],
    });
    row = (await t.run((ctx) => ctx.db.query("agents").collect()))[0];
    expect(row.lastSeenAt).not.toBe(1);
    expect(row.displayName).toBe("Renamed");
  });

  test("RECOVERY (deleted -> returned) STILL writes: presentInLastOk transition is consumer-visible, never swallowed by the idempotent skip", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.agents.applyDiscovery, {
      instanceName: "prod",
      agents: [A("alice", true)],
    });
    // Genuine empty gateway → alice flips deleted.
    await t.mutation(internal.agents.applyDiscovery, {
      instanceName: "prod",
      agents: [],
      allowEmpty: true,
    });
    let row = (await t.run((ctx) => ctx.db.query("agents").collect()))[0];
    expect(row.presentInLastOk).toBe(false);
    // It REAPPEARS on a later poll → must flip back to present (a write happens).
    await t.mutation(internal.agents.applyDiscovery, {
      instanceName: "prod",
      agents: [A("alice", true)],
    });
    row = (await t.run((ctx) => ctx.db.query("agents").collect()))[0];
    expect(row.presentInLastOk).toBe(true);
  });

  test("instanceDiscovery: a steady-state successful poll is a NO-OP write (lastPollOk already true); a fail then a recovery DO write", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.agents.applyDiscovery, {
      instanceName: "prod",
      agents: [A("alice", true)],
    });
    const discOf = () =>
      t.run((ctx) =>
        ctx.db
          .query("instanceDiscovery")
          .withIndex("by_instance", (q) => q.eq("instanceName", "prod"))
          .unique(),
      );
    // Sentinel the timestamps; nothing reads them, so the idempotent skip must
    // leave them untouched on a steady-state success.
    await t.run(async (ctx) => {
      const d = (await ctx.db.query("instanceDiscovery").collect())[0];
      await ctx.db.patch(d._id, { lastPollAt: 1, lastOkAt: 1 });
    });
    await t.mutation(internal.agents.applyDiscovery, {
      instanceName: "prod",
      agents: [A("alice", true)],
    });
    expect((await discOf())!.lastPollAt).toBe(1); // no-op: not rewritten

    // A FAILURE is a state change → writes lastPollOk=false.
    await t.mutation(internal.agents.recordDiscoveryFailure, {
      instanceName: "prod",
      error: "unreachable",
    });
    expect((await discOf())!.lastPollOk).toBe(false);

    // Recovery (success after a failure) is a state change → writes lastPollOk=true.
    await t.mutation(internal.agents.applyDiscovery, {
      instanceName: "prod",
      agents: [A("alice", true)],
    });
    const d = await discOf();
    expect(d!.lastPollOk).toBe(true);
    expect(d!.lastPollAt).not.toBe(1);
  });
});

describe("assignAgent — discovered-only whitelist + first-is-default", () => {
  test("rejects a non-discovered agent (prod-bug fix)", async () => {
    const t = convexTest(schema, modules);
    const { as, profileId } = await seedAdminAndTarget(t);
    await t.mutation(internal.agents.applyDiscovery, {
      instanceName: "prod",
      agents: [A("alice", true)],
    });
    await expect(
      as.mutation(api.agents.assignAgent, {
        profileId,
        instanceName: "prod",
        agentId: "ghost",
      }),
    ).rejects.toThrow(/not assignable/);
  });

  test("first assigned agent becomes default; second does not; idempotent", async () => {
    const t = convexTest(schema, modules);
    const { as, profileId, userId } = await seedAdminAndTarget(t);
    await t.mutation(internal.agents.applyDiscovery, {
      instanceName: "prod",
      agents: [A("alice", true), A("bob")],
    });
    await as.mutation(api.agents.assignAgent, {
      profileId,
      instanceName: "prod",
      agentId: "alice",
    });
    let ua = await uaOf(t, userId);
    expect(ua.length).toBe(1);
    expect(ua[0].isDefault).toBe(true);

    await as.mutation(api.agents.assignAgent, {
      profileId,
      instanceName: "prod",
      agentId: "bob",
    });
    ua = await uaOf(t, userId);
    expect(ua.length).toBe(2);
    expect(ua.filter((r) => r.isDefault).length).toBe(1);

    // idempotent re-assign — no duplicate row
    await as.mutation(api.agents.assignAgent, {
      profileId,
      instanceName: "prod",
      agentId: "alice",
    });
    ua = await uaOf(t, userId);
    expect(ua.length).toBe(2);
  });
});

describe("setDefaultAgent / removeAgent — exactly-one-default (H2/H3)", () => {
  async function setup() {
    const t = convexTest(schema, modules);
    const { as, profileId, userId } = await seedAdminAndTarget(t);
    await t.mutation(internal.agents.applyDiscovery, {
      instanceName: "prod",
      agents: [A("alice", true), A("bob")],
    });
    for (const agentId of ["alice", "bob"]) {
      await as.mutation(api.agents.assignAgent, {
        profileId,
        instanceName: "prod",
        agentId,
      });
    }
    return { t, as, profileId, userId };
  }

  test("setDefault moves the default and clears the old one", async () => {
    const { t, as, profileId, userId } = await setup();
    await as.mutation(api.agents.setDefaultAgent, {
      profileId,
      instanceName: "prod",
      agentId: "bob",
    });
    const ua = await uaOf(t, userId);
    expect(ua.filter((r) => r.isDefault).length).toBe(1);
    expect(ua.find((r) => r.agentId === "bob")!.isDefault).toBe(true);
    expect(ua.find((r) => r.agentId === "alice")!.isDefault).toBe(false);
  });

  test("removing the default re-elects another (never agents-but-no-default)", async () => {
    const { t, as, profileId, userId } = await setup();
    // alice is the default (first). Remove it.
    await as.mutation(api.agents.removeAgent, {
      profileId,
      instanceName: "prod",
      agentId: "alice",
    });
    const ua = await uaOf(t, userId);
    expect(ua.length).toBe(1);
    expect(ua[0].agentId).toBe("bob");
    expect(ua[0].isDefault).toBe(true); // re-elected
  });

  test("removing a non-default leaves the default intact", async () => {
    const { t, as, profileId, userId } = await setup();
    await as.mutation(api.agents.removeAgent, {
      profileId,
      instanceName: "prod",
      agentId: "bob",
    });
    const ua = await uaOf(t, userId);
    expect(ua.length).toBe(1);
    expect(ua[0].agentId).toBe("alice");
    expect(ua[0].isDefault).toBe(true);
  });
});

describe("enrichUserAgents state priority (Codex P2 — deleted wins over stale)", () => {
  async function seedUserWithAgent(
    t: ReturnType<typeof convexTest>,
    opts: { present: boolean; lastPollOk: boolean | null },
  ) {
    const userId = await t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId: uid, role: "user", canonical: "alice" });
      await ctx.db.insert("userAgents", {
        userId: uid,
        instanceName: "prod",
        agentId: "bob",
        isDefault: true,
        source: "manual",
        createdAt: 1,
      });
      await ctx.db.insert("agents", {
        instanceName: "prod",
        agentId: "bob",
        source: "discovered",
        presentInLastOk: opts.present,
        firstSeenAt: 1,
        lastSeenAt: 1,
      });
      if (opts.lastPollOk !== null) {
        await ctx.db.insert("instanceDiscovery", {
          instanceName: "prod",
          lastPollAt: 1,
          lastPollOk: opts.lastPollOk,
          lastOkAt: 1,
        });
      }
      return uid;
    });
    return t.withIdentity({ subject: `${userId}|session` });
  }
  const stateOf = async (as: Awaited<ReturnType<typeof seedUserWithAgent>>) => {
    const agents = await as.query(api.agents.listMyAgents, {});
    return agents.find((a) => a.agentId === "bob")!.state;
  };

  test("known-deleted stays 'deleted' even when the LATEST poll FAILED (blip must not re-offer it)", async () => {
    const t = convexTest(schema, modules);
    const as = await seedUserWithAgent(t, { present: false, lastPollOk: false });
    expect(await stateOf(as)).toBe("deleted");
  });

  test("present agent during a failed poll is 'stale' (not deleted)", async () => {
    const t = convexTest(schema, modules);
    const as = await seedUserWithAgent(t, { present: true, lastPollOk: false });
    expect(await stateOf(as)).toBe("stale");
  });

  test("present agent after a successful poll is 'ok'", async () => {
    const t = convexTest(schema, modules);
    const as = await seedUserWithAgent(t, { present: true, lastPollOk: true });
    expect(await stateOf(as)).toBe("ok");
  });
});

describe("deleteInstance cascade (Codex P2 — no orphan grants)", () => {
  // Filter in JS — a `t: ReturnType<typeof convexTest>` PARAMETER loses the
  // inferred data model, so `withIndex("by_instance")` fails `npx convex
  // typecheck` (Codex P1). Same workaround as `uaOf` above.
  const agentsOf = (t: ReturnType<typeof convexTest>, name: string) =>
    t.run(async (ctx) => {
      const rows = await ctx.db.query("agents").collect();
      return rows.filter((r) => r.instanceName === name);
    });

  test("removes the instance's agents/discovery/userAgents and re-elects a default", async () => {
    const t = convexTest(schema, modules);
    const { as, profileId, userId } = await seedAdminAndTarget(t);
    await t.mutation(internal.agents.applyDiscovery, {
      instanceName: "prod",
      agents: [A("alice", true)],
    });
    await t.mutation(internal.agents.applyDiscovery, {
      instanceName: "other",
      agents: [A("bob", true)],
    });
    const prodId = await t.run((ctx) =>
      ctx.db.insert("instances", { name: "prod", gatewayUrl: "ws://p", kind: "openclaw" }),
    );
    await t.run((ctx) =>
      ctx.db.insert("instances", { name: "other", gatewayUrl: "ws://o", kind: "openclaw" }),
    );
    await as.mutation(api.agents.assignAgent, {
      profileId,
      instanceName: "prod",
      agentId: "alice",
    }); // default (first)
    await as.mutation(api.agents.assignAgent, {
      profileId,
      instanceName: "other",
      agentId: "bob",
    }); // not default

    await as.mutation(api.admin.deleteInstance, { instanceId: prodId });

    expect((await agentsOf(t, "prod")).length).toBe(0);
    const prodDisc = await t.run((ctx) =>
      ctx.db
        .query("instanceDiscovery")
        .withIndex("by_instance", (q) => q.eq("instanceName", "prod"))
        .collect(),
    );
    expect(prodDisc.length).toBe(0);
    const ua = await uaOf(t, userId);
    expect(ua.length).toBe(1); // prod grant gone
    expect(ua[0].instanceName).toBe("other");
    expect(ua[0].isDefault).toBe(true); // re-elected (prod/alice was the default)
    expect((await agentsOf(t, "other")).length).toBe(1); // other untouched
  });

  test("does NOT orphan-clean when a DUPLICATE instance row still serves the name", async () => {
    const t = convexTest(schema, modules);
    const { as, profileId, userId } = await seedAdminAndTarget(t);
    await t.mutation(internal.agents.applyDiscovery, {
      instanceName: "prod",
      agents: [A("alice", true)],
    });
    const dupId = await t.run((ctx) =>
      ctx.db.insert("instances", { name: "prod", gatewayUrl: "ws://a", kind: "openclaw" }),
    );
    await t.run((ctx) =>
      ctx.db.insert("instances", { name: "prod", gatewayUrl: "ws://b", kind: "openclaw" }),
    ); // duplicate name
    await as.mutation(api.agents.assignAgent, {
      profileId,
      instanceName: "prod",
      agentId: "alice",
    });
    await as.mutation(api.admin.deleteInstance, { instanceId: dupId });
    expect((await uaOf(t, userId)).length).toBe(1); // grant kept
    expect((await agentsOf(t, "prod")).length).toBe(1); // agents kept
  });
});

describe("getChatAgent — the multi-agent header chip (UX-A)", () => {
  // Seed an instance + N discovered/present agents + grant them to a fresh user
  // (the FIRST granted becomes the default). Returns the identity + a chat factory.
  async function seedUserWithAgents(
    t: ReturnType<typeof convexTest>,
    agentIds: string[],
  ) {
    const userId = await t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId: uid, role: "user", canonical: "u" });
      await ctx.db.insert("instances", {
        name: "prod",
        gatewayUrl: "ws://x",
        kind: "openclaw",
      });
      await ctx.db.insert("instanceDiscovery", {
        instanceName: "prod",
        lastPollAt: 1,
        lastPollOk: true,
        lastOkAt: 1,
      });
      for (let i = 0; i < agentIds.length; i++) {
        await ctx.db.insert("agents", {
          instanceName: "prod",
          agentId: agentIds[i],
          source: "discovered",
          presentInLastOk: true,
          displayName: agentIds[i].toUpperCase(),
          firstSeenAt: 1,
          lastSeenAt: 1,
        });
        await ctx.db.insert("userAgents", {
          userId: uid,
          instanceName: "prod",
          agentId: agentIds[i],
          isDefault: i === 0, // first granted = default
          source: "manual",
          createdAt: i,
        });
      }
      return uid;
    });
    const as = t.withIdentity({ subject: `${userId}|session` });
    const mkChat = (bind?: { agentId: string }) =>
      t.run((ctx) =>
        ctx.db.insert("chats", {
          userId,
          updatedAt: 1,
          ...(bind
            ? { instanceName: "prod", agentId: bind.agentId }
            : {}),
        }),
      );
    return { as, mkChat };
  }

  test("single-agent user: multiAgent=false, no chip (the explicit requirement)", async () => {
    const t = convexTest(schema, modules);
    const { as, mkChat } = await seedUserWithAgents(t, ["solo"]);
    const chatId = await mkChat();
    const res = await as.query(api.agents.getChatAgent, { chatId });
    expect(res?.multiAgent).toBe(false);
    expect(res?.agent).toBeNull();
  });

  test("multi-agent, BOUND chat: chip names the bound (non-default) agent", async () => {
    const t = convexTest(schema, modules);
    const { as, mkChat } = await seedUserWithAgents(t, ["main", "bob"]);
    const chatId = await mkChat({ agentId: "bob" }); // bound to the non-default
    const res = await as.query(api.agents.getChatAgent, { chatId });
    expect(res?.multiAgent).toBe(true);
    expect(res?.agent?.agentId).toBe("bob");
    expect(res?.agent?.displayName).toBe("BOB");
    expect(res?.agent?.inheritedDefault).toBe(false);
    expect(res?.agent?.state).toBe("ok");
  });

  test("multi-agent, UNBOUND chat: chip shows the DEFAULT (what the next turn binds to)", async () => {
    const t = convexTest(schema, modules);
    const { as, mkChat } = await seedUserWithAgents(t, ["main", "bob"]);
    const chatId = await mkChat(); // legacy/unbound
    const res = await as.query(api.agents.getChatAgent, { chatId });
    expect(res?.multiAgent).toBe(true);
    expect(res?.agent?.agentId).toBe("main"); // the default (first granted)
    expect(res?.agent?.inheritedDefault).toBe(true);
  });

  test("a malformed/foreign chatId returns null (no throw for malformed)", async () => {
    const t = convexTest(schema, modules);
    const { as } = await seedUserWithAgents(t, ["main", "bob"]);
    expect(await as.query(api.agents.getChatAgent, { chatId: "not-an-id" })).toBeNull();
  });

  test("bound agent DELETED on the gateway → chip falls back to the default (mirrors dispatch)", async () => {
    // The chip must name the agent the NEXT turn actually dispatches to. Dispatch
    // (resolveTargetForChat) refuses a deleted binding and rebinds to the default,
    // so a chip bound to a deleted agent must show the DEFAULT, not the dead agent.
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId: uid, role: "user" as const, canonical: "u" });
      await ctx.db.insert("instances", { name: "prod", gatewayUrl: "ws://x", kind: "openclaw" });
      // Successful poll → presentInLastOk:false means KNOWN-deleted (not stale).
      await ctx.db.insert("instanceDiscovery", {
        instanceName: "prod",
        lastPollAt: 1,
        lastPollOk: true,
        lastOkAt: 1,
      });
      await ctx.db.insert("agents", {
        instanceName: "prod",
        agentId: "main",
        source: "discovered",
        presentInLastOk: true,
        displayName: "MAIN",
        firstSeenAt: 1,
        lastSeenAt: 1,
      });
      await ctx.db.insert("agents", {
        instanceName: "prod",
        agentId: "bob",
        source: "discovered",
        presentInLastOk: false, // deleted on the gateway
        displayName: "BOB",
        firstSeenAt: 1,
        lastSeenAt: 1,
      });
      await ctx.db.insert("userAgents", {
        userId: uid,
        instanceName: "prod",
        agentId: "main",
        isDefault: true,
        source: "manual" as const,
        createdAt: 0,
      });
      await ctx.db.insert("userAgents", {
        userId: uid,
        instanceName: "prod",
        agentId: "bob",
        isDefault: false,
        source: "manual" as const,
        createdAt: 1,
      });
      // Chat BOUND to the now-deleted bob.
      return uid;
    });
    const chatId = await t.run((ctx) =>
      ctx.db.insert("chats", {
        userId,
        updatedAt: 1,
        instanceName: "prod",
        agentId: "bob",
      }),
    );
    const as = t.withIdentity({ subject: `${userId}|session` });
    const res = await as.query(api.agents.getChatAgent, { chatId });
    expect(res?.multiAgent).toBe(true);
    expect(res?.agent?.agentId).toBe("main"); // NOT the dead "bob"
    expect(res?.agent?.inheritedDefault).toBe(true);
  });

  test("DELETED default → chip falls to the first non-deleted agent (mirrors pickFallback)", async () => {
    // An unbound chat resolves to the user's default — but if the DEFAULT is
    // deleted on the gateway, dispatch routes to the next present agent, so the
    // chip must name THAT one, not the dead default (Codex P2).
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", {});
      await ctx.db.insert("profiles", { userId: uid, role: "user" as const, canonical: "u" });
      await ctx.db.insert("instances", { name: "prod", gatewayUrl: "ws://x", kind: "openclaw" });
      await ctx.db.insert("instanceDiscovery", {
        instanceName: "prod", lastPollAt: 1, lastPollOk: true, lastOkAt: 1,
      });
      await ctx.db.insert("agents", {
        instanceName: "prod", agentId: "main", source: "discovered",
        presentInLastOk: false, displayName: "MAIN", firstSeenAt: 1, lastSeenAt: 1, // default, DELETED
      });
      await ctx.db.insert("agents", {
        instanceName: "prod", agentId: "bob", source: "discovered",
        presentInLastOk: true, displayName: "BOB", firstSeenAt: 1, lastSeenAt: 1, // present
      });
      await ctx.db.insert("userAgents", {
        userId: uid, instanceName: "prod", agentId: "main",
        isDefault: true, source: "manual" as const, createdAt: 0,
      });
      await ctx.db.insert("userAgents", {
        userId: uid, instanceName: "prod", agentId: "bob",
        isDefault: false, source: "manual" as const, createdAt: 1,
      });
      return uid;
    });
    const chatId = await t.run((ctx) => ctx.db.insert("chats", { userId, updatedAt: 1 })); // unbound
    const res = await t
      .withIdentity({ subject: `${userId}|session` })
      .query(api.agents.getChatAgent, { chatId });
    expect(res?.multiAgent).toBe(true);
    expect(res?.agent?.agentId).toBe("bob"); // NOT the dead default "main"
    expect(res?.agent?.state).toBe("ok");
  });
});
