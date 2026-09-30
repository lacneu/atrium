/// <reference types="vite/client" />
//
// THE WHOLE JOURNEY: an agent-building agent (the OpenClaw "forge") appends a new
// agent to its gateway's `agents.list` → Atrium discovers it through the normal
// instance sync (pollAgentDiscovery → bridge `/agents` → applyDiscovery) → the
// group's manager claims it → the group's members use it through the very
// mutations the UI calls (createChat, sendMessage, the scheduled bridge dispatch).
//
// Everything goes through the real entry points: the discovery is a bridge
// `/agents` answer in the bridge's own shape (server.ts NormalizedAgent + `count`),
// fed to the cron action; the claim epoch is stamped by its cron mutation; a turn
// is proven routed by the POST the dispatch makes to the instance's bridge.
//
// What groupManagerClaim.test.ts already pins (claim rules, reservation in every
// resolver, manager scope, invitations, per-member restriction, audit, cascades)
// is not repeated here; this file walks the journey end to end and the cases that
// file leaves open.

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { getEffectiveGrants } from "./agents";
import { knowledgeAgentReachable } from "./knowledge";

const modules = import.meta.glob("./**/*.ts");
type T = TestConvex<typeof schema>;
const as = (t: T, uid: Id<"users">) => t.withIdentity({ subject: `${uid}|session` });

const SECRET = "forge-journey-secret";
const bridgeOf = (instanceName: string) => `http://bridge-${instanceName}.test`;

// ---------------------------------------------------------------------------
// The gateway side: what each instance's `agents.list` holds right now.
// ---------------------------------------------------------------------------

type ListEntry = {
  id: string;
  name: string;
  emoji?: string;
  model: string;
};

/** One OpenClaw `agents.list` entry, as the forge writes it (6.1+ RPC shape). */
function openclawEntry(e: ListEntry): Record<string, unknown> {
  return {
    id: e.id,
    name: e.name,
    identity: { name: e.name, ...(e.emoji !== undefined ? { emoji: e.emoji } : {}) },
    workspace: `/home/node/.openclaw/workspace-${e.id}`,
    model: { primary: e.model },
  };
}

/** The bridge `/agents` answer for one instance: normalizeOpenClawAgent's output
 *  (list-level `defaultId`) + the raw count, exactly as server.ts sends it. */
function bridgeAgentsBody(
  instanceName: string,
  list: ListEntry[],
  defaultId: string | null,
): Record<string, unknown> {
  return {
    ok: true,
    instanceName,
    agents: list.map((e) => ({
      agentId: e.id,
      displayName: e.name,
      emoji: e.emoji ?? null,
      model: e.model,
      isDefaultOnInstance: defaultId !== null && e.id === defaultId,
      defaultPermissionMode: null,
      raw: openclawEntry(e),
    })),
    count: list.length,
    usage: null,
    capturedAt: Date.now(),
  };
}

type Gateways = Record<string, { list: ListEntry[]; defaultId: string | null }>;

/** Run the discovery cron against the gateways as they stand (every instance with a
 *  bridgeUrl is polled on its own bridge). */
async function sync(t: T, gateways: Gateways): Promise<void> {
  const orig = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const instanceName = url.searchParams.get("instance") ?? "";
    const gw = gateways[instanceName];
    if (url.pathname === "/agents" && gw !== undefined) {
      return new Response(
        JSON.stringify(bridgeAgentsBody(instanceName, gw.list, gw.defaultId)),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
  try {
    await t.action(internal.agents.pollAgentDiscovery, {});
  } finally {
    globalThis.fetch = orig;
  }
}

/** Run every scheduled function (the dispatch of each accepted send) against a
 *  bridge that accepts everything; return the `/send` bodies it received. */
async function runDispatches(t: T): Promise<Array<Record<string, unknown>>> {
  const sent: Array<Record<string, unknown>> = [];
  const orig = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/send")) {
      sent.push(JSON.parse(init!.body as string) as Record<string, unknown>);
    }
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
  try {
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  } finally {
    globalThis.fetch = orig;
  }
  return sent;
}

// ---------------------------------------------------------------------------
// Atrium side
// ---------------------------------------------------------------------------

async function user(
  t: T,
  canonical: string,
  opts: { role?: "admin" | "user"; perms?: string[] } = {},
): Promise<Id<"users">> {
  return await t.run(async (ctx) => {
    const uid = await ctx.db.insert("users", {});
    const email = `${canonical}@example.com`;
    await ctx.db.insert("profiles", {
      userId: uid,
      role: opts.role ?? "user",
      canonical,
      email,
      emailLower: email,
      ...(opts.perms ? { extraPermissions: opts.perms } : {}),
    });
    return uid;
  });
}

const profileIdOf = (t: T, uid: Id<"users">) =>
  t.run(async (ctx) =>
    (await ctx.db.query("profiles").withIndex("by_user", (q) => q.eq("userId", uid)).unique())!._id,
  );

const agentRow = (t: T, instanceName: string, agentId: string) =>
  t.run((ctx) =>
    ctx.db
      .query("agents")
      .withIndex("by_instance_agent", (q) => q.eq("instanceName", instanceName).eq("agentId", agentId))
      .first(),
  );

const effective = async (t: T, uid: Id<"users">) =>
  (await t.run((ctx) => getEffectiveGrants(ctx, uid)))
    .map((g) => `${g.instanceName}/${g.agentId}`)
    .sort();

// The forged agent, as the forge appends it to agents.list.
const SCRIBE: ListEntry = {
  id: "scribe",
  name: "Scribe",
  emoji: "\u{1FAB6}",
  model: "openai/gpt-5.5",
};

let clientSeq = 0;
const send = (
  t: T,
  uid: Id<"users">,
  chatId: Id<"chats">,
  extra: Partial<{ routedAgent: { instanceName: string; agentId: string } }> = {},
) =>
  as(t, uid).mutation(api.send.sendMessage, {
    chatId,
    text: "Bonjour",
    clientMessageId: `forge-journey-${++clientSeq}`,
    ...extra,
  });

const outboxOf = (t: T, outboxId: Id<"outbox">) => t.run((ctx) => ctx.db.get(outboxId));

/** How a dispatch ended: the outbox status, and the error card's code when it failed. */
const outcome = (t: T, outboxId: Id<"outbox">) =>
  t.run(async (ctx) => {
    const row = await ctx.db.get(outboxId);
    const card = (await ctx.db.query("messages").collect()).find(
      (m) => m.dispatchOutboxId === String(outboxId),
    );
    return { status: row?.status ?? null, errorCode: card?.errorCode ?? null };
  });

/**
 * A deployment in production before the forge acts:
 *   - instance `prod` (its own bridge): main (gateway default), helper, open — all
 *     discovered by the sync and enabled by the admin; they PREDATE the claim epoch,
 *     which the cron stamps afterwards (the lot's deploy);
 *   - group G (main shared) with its manager `mgr` (groups.manage) and two members;
 *     group H (helper shared) with one member; `loner` is in no group.
 */
async function world(t: T) {
  vi.setSystemTime(new Date("2026-09-30T08:00:00Z"));
  const admin = await user(t, "admin", { role: "admin" });
  const mgr = await user(t, "mgr", { perms: ["groups.manage"] });
  const member = await user(t, "member");
  const member2 = await user(t, "member2");
  const hMember = await user(t, "hmember");
  const loner = await user(t, "loner");
  await t.run(async (ctx) => {
    await ctx.db.insert("appMeta", {
      key: "singleton",
      adminAssigned: true,
      agentEnabledBackfillDone: true,
    });
    await ctx.db.insert("instances", {
      name: "prod",
      gatewayUrl: "ws://gw-prod:18789",
      bridgeUrl: bridgeOf("prod"),
    });
  });
  const gateways: Gateways = {
    prod: {
      defaultId: "main",
      list: [
        { id: "main", name: "Main", model: "openai/gpt-5.5" },
        { id: "helper", name: "Helper", model: "openai/gpt-5.5" },
        { id: "open", name: "Open", model: "openai/gpt-5.5" },
      ],
    },
  };
  await sync(t, gateways);
  for (const agentId of ["main", "helper", "open"]) {
    await as(t, admin).mutation(api.agents.setAgentEnabled, { instanceName: "prod", agentId, enabled: true });
  }
  vi.advanceTimersByTime(60_000);
  expect(await t.mutation(internal.agents.stampAgentClaimEpoch, {})).toEqual({ stamped: true });
  vi.advanceTimersByTime(60_000);
  const G = await as(t, admin).mutation(api.groups.createGroup, { name: "G" });
  const H = await as(t, admin).mutation(api.groups.createGroup, { name: "H" });
  for (const uid of [mgr, member, member2]) {
    await as(t, admin).mutation(api.groups.addMember, { groupId: G, userId: uid });
  }
  await as(t, admin).mutation(api.groups.setGroupManager, { groupId: G, userId: mgr, manager: true });
  await as(t, admin).mutation(api.groups.addMember, { groupId: H, userId: hMember });
  await as(t, admin).mutation(api.groups.assignAgentToGroup, { groupId: G, instanceName: "prod", agentId: "main" });
  await as(t, admin).mutation(api.groups.assignAgentToGroup, { groupId: H, instanceName: "prod", agentId: "helper" });
  // The setup's own scheduled work (none expected to matter) is flushed so a later
  // runDispatches only sees what the scenario schedules.
  await runDispatches(t);
  return { admin, mgr, member, member2, hMember, loner, G, H, gateways };
}

type World = Awaited<ReturnType<typeof world>>;

/** The forge appends `entry` to prod's agents.list; the next sync discovers it. */
async function forge(t: T, w: World, entry: ListEntry = SCRIBE): Promise<void> {
  vi.advanceTimersByTime(60_000);
  w.gateways.prod!.list.push({ ...entry });
  await sync(t, w.gateways);
}

/** forge + the manager's claim for G. */
async function forgedAndClaimed(t: T, w: World): Promise<void> {
  await forge(t, w);
  await as(t, w.mgr).mutation(api.groups.claimAgentForGroup, {
    groupId: w.G,
    instanceName: "prod",
    agentId: "scribe",
  });
}

let prevSecret: string | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  prevSecret = process.env.BRIDGE_SHARED_SECRET;
  process.env.BRIDGE_SHARED_SECRET = SECRET;
});
afterEach(() => {
  vi.useRealTimers();
  if (prevSecret === undefined) delete process.env.BRIDGE_SHARED_SECRET;
  else process.env.BRIDGE_SHARED_SECRET = prevSecret;
});

// ===========================================================================
describe("A. discovery: the forged agent reaches Atrium through the instance sync", () => {
  test("it arrives disabled, undecided, unreserved — claimable by G's manager, usable by nobody yet", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await forge(t, w);
    const row = await agentRow(t, "prod", "scribe");
    expect(row).toMatchObject({
      source: "discovered",
      presentInLastOk: true,
      enabled: false,
      displayName: "Scribe",
      emoji: "\u{1FAB6}",
      model: "openai/gpt-5.5",
      isDefaultOnInstance: false,
    });
    expect(row?.enablementDecidedAt).toBeUndefined();
    expect(row?.reservedForGroupId).toBeUndefined();
    const view = await as(t, w.mgr).query(api.groups.listAssignableAgents, { instanceName: "prod", groupId: w.G });
    expect(view.agents.find((a) => a.agentId === "scribe")).toMatchObject({ claimable: true, enabled: false });
    // Disabled: in nobody's effective set, the no-group all-pool included.
    for (const uid of [w.member, w.hMember, w.loner]) {
      expect(await effective(t, uid)).not.toContain("prod/scribe");
    }
    await expect(
      as(t, w.loner).mutation(api.chats.createChat, { instanceName: "prod", agentId: "scribe" }),
    ).rejects.toThrow(/not assigned/);
  });

  test("the claim is refused for every row that is not a fresh, undecided discovery", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    const claim = (by: Id<"users">, groupId: Id<"groups">, agentId: string) =>
      as(t, by).mutation(api.groups.claimAgentForGroup, { groupId, instanceName: "prod", agentId });
    // unknown: never discovered.
    await expect(claim(w.mgr, w.G, "ghost")).rejects.toThrow(/not claimable \(unknown\)/);
    // not_discovered: an admin's manual fallback row.
    await t.run((ctx) =>
      ctx.db.insert("agents", {
        instanceName: "prod",
        agentId: "manual",
        source: "manual",
        presentInLastOk: true,
        enabled: false,
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now(),
      }),
    );
    await expect(claim(w.mgr, w.G, "manual")).rejects.toThrow(/not claimable \(not_discovered\)/);
    // absent: forged, then removed from agents.list before anyone claimed it.
    await forge(t, w, { id: "gone", name: "Gone", model: "m" });
    w.gateways.prod!.list = w.gateways.prod!.list.filter((e) => e.id !== "gone");
    await sync(t, w.gateways);
    await expect(claim(w.mgr, w.G, "gone")).rejects.toThrow(/not claimable \(absent\)/);
    // enabled: an admin enabled it for everyone before the manager got to it.
    await forge(t, w, { id: "public", name: "Public", model: "m" });
    await as(t, w.admin).mutation(api.agents.setAgentEnabled, { instanceName: "prod", agentId: "public", enabled: true });
    await expect(claim(w.mgr, w.G, "public")).rejects.toThrow(/not claimable \(enabled\)/);
    // reserved: claimed once — again by the same group, or by another (admin for H).
    await forgedAndClaimed(t, w);
    await expect(claim(w.mgr, w.G, "scribe")).rejects.toThrow(/not claimable \(reserved\)/);
    await expect(claim(w.admin, w.H, "scribe")).rejects.toThrow(/not claimable \(reserved\)/);
    expect((await agentRow(t, "prod", "scribe"))?.reservedForGroupId).toBe(w.G);
  });

  test("the forge edits the agent (name, emoji, model): the next sync patches it, the claim stands", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await forgedAndClaimed(t, w);
    const before = (await agentRow(t, "prod", "scribe"))!;
    const entry = w.gateways.prod!.list.find((e) => e.id === "scribe")!;
    entry.name = "Scribe II";
    entry.emoji = "\u{1F4DC}";
    entry.model = "anthropic/claude-opus-5";
    vi.advanceTimersByTime(60_000);
    await sync(t, w.gateways);
    const after = (await agentRow(t, "prod", "scribe"))!;
    expect(after._id).toBe(before._id);
    expect(after).toMatchObject({
      displayName: "Scribe II",
      emoji: "\u{1F4DC}",
      model: "anthropic/claude-opus-5",
      enabled: true,
      reservedForGroupId: w.G,
      enablementDecidedAt: before.enablementDecidedAt,
    });
    expect(await effective(t, w.member)).toContain("prod/scribe");
    expect(await effective(t, w.loner)).not.toContain("prod/scribe");
  });

  test("the forge removes it: absent (members see it deleted, no turn reaches it), then it returns — same row, still reserved, usable again", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await forgedAndClaimed(t, w);
    const id = (await agentRow(t, "prod", "scribe"))!._id;
    const mainChat = await as(t, w.member).mutation(api.chats.createChat, { instanceName: "prod", agentId: "main" });

    w.gateways.prod!.list = w.gateways.prod!.list.filter((e) => e.id !== "scribe");
    vi.advanceTimersByTime(60_000);
    await sync(t, w.gateways);
    expect(await agentRow(t, "prod", "scribe")).toMatchObject({
      presentInLastOk: false,
      enabled: true,
      reservedForGroupId: w.G,
    });
    const picker = await as(t, w.member).query(api.agents.listMyAgents, {});
    expect(picker.find((a) => a.agentId === "scribe")?.state).toBe("deleted");
    await expect(
      send(t, w.member, mainChat, { routedAgent: { instanceName: "prod", agentId: "scribe" } }),
    ).rejects.toThrow(/not dispatchable/);
    // The manager still sees it as their group's (reserved) agent.
    const view = await as(t, w.mgr).query(api.groups.listAssignableAgents, { instanceName: "prod", groupId: w.G });
    expect(view.agents.find((a) => a.agentId === "scribe")).toMatchObject({
      reservedForGroup: true,
      presentInLastOk: false,
    });

    w.gateways.prod!.list.push({ ...SCRIBE });
    vi.advanceTimersByTime(60_000);
    await sync(t, w.gateways);
    const back = (await agentRow(t, "prod", "scribe"))!;
    expect(back._id).toBe(id);
    expect(back).toMatchObject({ presentInLastOk: true, enabled: true, reservedForGroupId: w.G });
    const chatId = await as(t, w.member).mutation(api.chats.createChat, { instanceName: "prod", agentId: "scribe" });
    await send(t, w.member, chatId);
    const sent = await runDispatches(t);
    expect(sent.map((b) => `${b.instanceName}/${b.agentId}`)).toEqual(["prod/scribe"]);
    expect(await effective(t, w.loner)).not.toContain("prod/scribe");
  });
});

// ===========================================================================
describe("B. who may see and claim the forged agent", () => {
  test("a plain member of the group: neither the list nor the claim", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await forge(t, w);
    await expect(
      as(t, w.member).query(api.groups.listAssignableAgents, { instanceName: "prod", groupId: w.G }),
    ).rejects.toThrow(/missing permission groups.manage/);
    await expect(
      as(t, w.member).mutation(api.groups.claimAgentForGroup, { groupId: w.G, instanceName: "prod", agentId: "scribe" }),
    ).rejects.toThrow(/missing permission groups.manage/);
  });

  test("the manager flag without the groups.manage permission: neither", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await as(t, w.admin).mutation(api.groups.setGroupManager, { groupId: w.G, userId: w.member, manager: true });
    await forge(t, w);
    await expect(
      as(t, w.member).query(api.groups.listAssignableAgents, { instanceName: "prod", groupId: w.G }),
    ).rejects.toThrow(/missing permission groups.manage/);
    await expect(
      as(t, w.member).mutation(api.groups.claimAgentForGroup, { groupId: w.G, instanceName: "prod", agentId: "scribe" }),
    ).rejects.toThrow(/missing permission groups.manage/);
    expect((await agentRow(t, "prod", "scribe"))?.enabled).toBe(false);
  });

  test("an admin sees it claimable for a group, and may claim it even where the group has no footprint", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await forge(t, w);
    const view = await as(t, w.admin).query(api.groups.listAssignableAgents, { instanceName: "prod", groupId: w.G });
    expect(view.agents.find((a) => a.agentId === "scribe")?.claimable).toBe(true);
    // A second gateway G has never used: a manager could not claim there, an admin can.
    await t.run((ctx) =>
      ctx.db.insert("instances", { name: "lab", gatewayUrl: "ws://gw-lab:18789", bridgeUrl: bridgeOf("lab") }),
    );
    w.gateways.lab = { defaultId: null, list: [{ id: "probe", name: "Probe", model: "m" }] };
    vi.advanceTimersByTime(60_000);
    await sync(t, w.gateways);
    await expect(
      as(t, w.mgr).mutation(api.groups.claimAgentForGroup, { groupId: w.G, instanceName: "lab", agentId: "probe" }),
    ).rejects.toThrow(/no agent on that instance/);
    await as(t, w.admin).mutation(api.groups.claimAgentForGroup, { groupId: w.G, instanceName: "lab", agentId: "probe" });
    expect(await effective(t, w.member)).toContain("lab/probe");
    expect(await effective(t, w.loner)).not.toContain("lab/probe");
  });
});

// ===========================================================================
describe("C/D. a member of the group uses it — through the UI's own mutations", () => {
  test("an unrestricted member picks it, creates a chat, sends: the dispatch goes to prod/scribe under their identity", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await forgedAndClaimed(t, w);
    const picker = await as(t, w.member).query(api.agents.listMyAgents, {});
    expect(picker.find((a) => a.agentId === "scribe")).toMatchObject({
      instanceName: "prod",
      state: "ok",
      enabled: true,
      displayName: "Scribe",
      via: { group: "g" },
    });
    const chatId = await as(t, w.member).mutation(api.chats.createChat, { instanceName: "prod", agentId: "scribe" });
    const { outboxId } = await send(t, w.member, chatId);
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(
      scheduled.filter((s) => s.state.kind === "pending" && s.name.includes("dispatch")).map((s) => s.args[0]),
    ).toEqual([{ outboxId }]);
    const sent = await runDispatches(t);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ chatId, instanceName: "prod", agentId: "scribe", canonical: "member" });
    expect((await outboxOf(t, outboxId))?.status).toBe("sent");
  });

  test("a new chat without a pick resolves to the member default, else to the group default — both set to the forged agent", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await forgedAndClaimed(t, w);
    // G's default = the forged agent; member2 gets it by default.
    await as(t, w.mgr).mutation(api.groups.setGroupDefaultAgent, {
      groupId: w.G,
      agent: { instanceName: "prod", agentId: "scribe" },
    });
    // member: the manager points THEIR default at main, overriding the group's.
    await as(t, w.mgr).mutation(api.groups.setMemberDefaultAgent, {
      groupId: w.G,
      userId: w.member,
      agent: { instanceName: "prod", agentId: "main" },
    });
    const c2 = await as(t, w.member2).mutation(api.chats.createChat, {});
    const c1 = await as(t, w.member).mutation(api.chats.createChat, {});
    await send(t, w.member2, c2);
    await send(t, w.member, c1);
    let sent = await runDispatches(t);
    expect(sent.map((b) => `${b.canonical}:${b.agentId}`).sort()).toEqual(["member2:scribe", "member:main"]);
    // …and the member default itself may be the forged agent.
    await as(t, w.mgr).mutation(api.groups.setMemberDefaultAgent, {
      groupId: w.G,
      userId: w.member,
      agent: { instanceName: "prod", agentId: "scribe" },
    });
    const c3 = await as(t, w.member).mutation(api.chats.createChat, {});
    await send(t, w.member, c3);
    sent = await runDispatches(t);
    expect(sent.map((b) => b.agentId)).toEqual(["scribe"]);
    expect((await t.run((ctx) => ctx.db.get(c3)))?.agentId).toBe("scribe");
  });

  test("a member of two groups keeps both shares and uses the forged agent", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await forgedAndClaimed(t, w);
    await as(t, w.admin).mutation(api.groups.addMember, { groupId: w.H, userId: w.member });
    expect(await effective(t, w.member)).toEqual(["prod/helper", "prod/main", "prod/scribe"]);
    const chatId = await as(t, w.member).mutation(api.chats.createChat, { instanceName: "prod", agentId: "scribe" });
    await send(t, w.member, chatId);
    expect((await runDispatches(t)).map((b) => b.agentId)).toEqual(["scribe"]);
  });

  test("a member the manager restricts to main: refused at creation, at the per-turn route, and their scribe chat goes read-only at dispatch", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await forgedAndClaimed(t, w);
    const scribeChat = await as(t, w.member).mutation(api.chats.createChat, { instanceName: "prod", agentId: "scribe" });
    const mainChat = await as(t, w.member).mutation(api.chats.createChat, { instanceName: "prod", agentId: "main" });
    expect((await as(t, w.member).query(api.agents.getChatAgent, { chatId: scribeChat }))?.readOnly).toBe(false);
    await as(t, w.mgr).mutation(api.groups.setMemberAgents, {
      groupId: w.G,
      userId: w.member,
      agents: [{ instanceName: "prod", agentId: "main" }],
    });
    await expect(
      as(t, w.member).mutation(api.chats.createChat, { instanceName: "prod", agentId: "scribe" }),
    ).rejects.toThrow(/not assigned/);
    await expect(
      send(t, w.member, mainChat, { routedAgent: { instanceName: "prod", agentId: "scribe" } }),
    ).rejects.toThrow(/not assigned/);
    // The UI locks the composer for the same reason the dispatch refuses.
    expect(await as(t, w.member).query(api.agents.getChatAgent, { chatId: scribeChat })).toMatchObject({
      readOnly: true,
      readOnlyReason: "agent",
    });
    const { outboxId } = await send(t, w.member, scribeChat);
    expect(await runDispatches(t)).toEqual([]);
    expect(await outcome(t, outboxId)).toEqual({ status: "failed", errorCode: "agent_restricted" });
    expect((await t.run((ctx) => ctx.db.get(scribeChat)))?.agentId).toBe("scribe");
    // member2, unrestricted, is untouched.
    expect(await effective(t, w.member2)).toContain("prod/scribe");
  });

  test("a member an admin narrows with a direct grant on main: refused at creation and at the per-turn route", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await forgedAndClaimed(t, w);
    const mainChat = await as(t, w.member).mutation(api.chats.createChat, { instanceName: "prod", agentId: "main" });
    await as(t, w.admin).mutation(api.agents.assignAgent, {
      profileId: await profileIdOf(t, w.member),
      instanceName: "prod",
      agentId: "main",
    });
    expect(await effective(t, w.member)).toEqual(["prod/main"]);
    await expect(
      as(t, w.member).mutation(api.chats.createChat, { instanceName: "prod", agentId: "scribe" }),
    ).rejects.toThrow(/not assigned/);
    await expect(
      send(t, w.member, mainChat, { routedAgent: { instanceName: "prod", agentId: "scribe" } }),
    ).rejects.toThrow(/not assigned/);
  });

  test("someone outside the group — groupless or in H — is refused everywhere, even knowing the agentId", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await forgedAndClaimed(t, w);
    const scribe = { instanceName: "prod", agentId: "scribe" };
    for (const [uid, own] of [
      [w.loner, "open"],
      [w.hMember, "helper"],
    ] as const) {
      expect(await effective(t, uid)).not.toContain("prod/scribe");
      await expect(as(t, uid).mutation(api.chats.createChat, scribe)).rejects.toThrow(/not assigned/);
      const chatId = await as(t, uid).mutation(api.chats.createChat, { instanceName: "prod", agentId: own });
      await expect(send(t, uid, chatId, { routedAgent: scribe })).rejects.toThrow(/not assigned/);
      await expect(
        as(t, uid).mutation(api.chatAgents.addChatAgent, { chatId, ...scribe }),
      ).rejects.toThrow(/not assigned/);
      await expect(as(t, uid).mutation(api.chats.rebindChatAgent, { chatId, ...scribe })).rejects.toThrow(
        /not assigned/,
      );
    }
    expect(await runDispatches(t)).toEqual([]);
  });

  test("a guest of a member's conversation reaches it only on the owner's delegation — and loses it with the owner", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await forgedAndClaimed(t, w);
    const chatId = await as(t, w.member).mutation(api.chats.createChat, { instanceName: "prod", agentId: "scribe" });
    await as(t, w.member).mutation(api.chatParticipants.addMember, { chatId, memberId: w.loner });
    // The guest's composer is open, on the owner's answer (getChatAgent).
    expect(await as(t, w.loner).query(api.agents.getChatAgent, { chatId })).toMatchObject({
      readOnly: false,
      agent: { instanceName: "prod", agentId: "scribe" },
    });
    // The guest's turn (implicit, and explicitly addressed) runs on the owner's session.
    await send(t, w.loner, chatId);
    let sent = await runDispatches(t);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ instanceName: "prod", agentId: "scribe", canonical: "member" });
    await send(t, w.loner, chatId, { routedAgent: { instanceName: "prod", agentId: "scribe" } });
    sent = await runDispatches(t);
    expect(sent.map((b) => b.agentId)).toEqual(["scribe"]);
    // Their own entitlement is untouched: no chat of their own on it.
    await expect(
      as(t, w.loner).mutation(api.chats.createChat, { instanceName: "prod", agentId: "scribe" }),
    ).rejects.toThrow(/not assigned/);
    // The owner leaves G (an admin removes them): the delegation ends with it.
    await as(t, w.admin).mutation(api.groups.removeMember, { groupId: w.G, userId: w.member });
    await expect(send(t, w.loner, chatId)).rejects.toThrow(/agent is gone/);
    expect(await as(t, w.loner).query(api.agents.getChatAgent, { chatId })).toMatchObject({
      readOnly: true,
      readOnlyReason: "agent",
    });
  });

  test("agent files and the knowledge picker gate on the same resolver", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await forgedAndClaimed(t, w);
    for (const uid of [w.member, w.loner, w.hMember]) {
      await as(t, w.admin).mutation(api.admin.setUserPermissions, {
        profileId: await profileIdOf(t, uid),
        permissions: ["agents.files.read"],
      });
    }
    const target = { instanceName: "prod", agentId: "scribe" };
    await expect(as(t, w.member).query(internal.agentFiles.checkFilesReadAccess, target)).resolves.toEqual({
      isAdmin: false,
    });
    for (const uid of [w.loner, w.hMember]) {
      await expect(as(t, uid).query(internal.agentFiles.checkFilesReadAccess, target)).rejects.toThrow(
        /agent not accessible/,
      );
    }
    const memberChat = await as(t, w.member).mutation(api.chats.createChat, { instanceName: "prod", agentId: "main" });
    const lonerChat = await as(t, w.loner).mutation(api.chats.createChat, { instanceName: "prod", agentId: "open" });
    const reach = (chatId: Id<"chats">) =>
      t.run(async (ctx) => knowledgeAgentReachable(ctx, (await ctx.db.get(chatId))!, target));
    expect(await reach(memberChat)).toBe(true);
    expect(await reach(lonerChat)).toBe(false);
  });
});

// ===========================================================================
describe("E. lifecycle after the claim", () => {
  test("the manager unshares it: members lose it (creation and dispatch); re-added, it works again", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await forgedAndClaimed(t, w);
    const chatId = await as(t, w.member).mutation(api.chats.createChat, { instanceName: "prod", agentId: "scribe" });
    await as(t, w.mgr).mutation(api.groups.removeAgentFromGroup, { groupId: w.G, instanceName: "prod", agentId: "scribe" });
    await expect(
      as(t, w.member).mutation(api.chats.createChat, { instanceName: "prod", agentId: "scribe" }),
    ).rejects.toThrow(/not assigned/);
    const { outboxId } = await send(t, w.member, chatId);
    expect(await runDispatches(t)).toEqual([]);
    expect(await outcome(t, outboxId)).toEqual({ status: "failed", errorCode: "agent_restricted" });
    await as(t, w.mgr).mutation(api.groups.assignAgentToGroup, { groupId: w.G, instanceName: "prod", agentId: "scribe" });
    await send(t, w.member, chatId);
    expect((await runDispatches(t)).map((b) => b.agentId)).toEqual(["scribe"]);
  });

  test("an admin lifts the reservation: an ordinary enabled agent — the groupless user may now use it", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await forgedAndClaimed(t, w);
    await as(t, w.admin).mutation(api.agents.setAgentReservation, { instanceName: "prod", agentId: "scribe", groupId: null });
    const chatId = await as(t, w.loner).mutation(api.chats.createChat, { instanceName: "prod", agentId: "scribe" });
    await send(t, w.loner, chatId);
    expect((await runDispatches(t)).map((b) => `${b.canonical}:${b.agentId}`)).toEqual(["loner:scribe"]);
    // H (a group) still gets only what H shares.
    expect(await effective(t, w.hMember)).toEqual(["prod/helper"]);
  });

  test("an admin moves the reservation to H: G's chat on it goes read-only, H's member uses it", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await forgedAndClaimed(t, w);
    const gChat = await as(t, w.member).mutation(api.chats.createChat, { instanceName: "prod", agentId: "scribe" });
    await as(t, w.admin).mutation(api.agents.setAgentReservation, { instanceName: "prod", agentId: "scribe", groupId: w.H });
    const { outboxId } = await send(t, w.member, gChat);
    expect(await runDispatches(t)).toEqual([]);
    expect(await outcome(t, outboxId)).toEqual({ status: "failed", errorCode: "agent_restricted" });
    const hChat = await as(t, w.hMember).mutation(api.chats.createChat, { instanceName: "prod", agentId: "scribe" });
    await send(t, w.hMember, hChat);
    expect((await runDispatches(t)).map((b) => `${b.canonical}:${b.agentId}`)).toEqual(["hmember:scribe"]);
  });

  test("an admin disables it: gone for the members, reservation kept; re-enabled, back for G only", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await forgedAndClaimed(t, w);
    const chatId = await as(t, w.member).mutation(api.chats.createChat, { instanceName: "prod", agentId: "scribe" });
    await as(t, w.admin).mutation(api.agents.setAgentEnabled, { instanceName: "prod", agentId: "scribe", enabled: false });
    expect(await agentRow(t, "prod", "scribe")).toMatchObject({ enabled: false, reservedForGroupId: w.G });
    expect(await effective(t, w.member)).toEqual(["prod/main"]);
    await expect(
      as(t, w.member).mutation(api.chats.createChat, { instanceName: "prod", agentId: "scribe" }),
    ).rejects.toThrow(/not assigned/);
    const { outboxId } = await send(t, w.member, chatId);
    expect(await runDispatches(t)).toEqual([]);
    expect(await outcome(t, outboxId)).toEqual({ status: "failed", errorCode: "agent_restricted" });
    // An admin decision: never claimable again, whoever asks.
    await expect(
      as(t, w.mgr).mutation(api.groups.claimAgentForGroup, { groupId: w.G, instanceName: "prod", agentId: "scribe" }),
    ).rejects.toThrow(/not claimable \(reserved\)/);
    await as(t, w.admin).mutation(api.agents.setAgentEnabled, { instanceName: "prod", agentId: "scribe", enabled: true });
    expect(await effective(t, w.member)).toEqual(["prod/main", "prod/scribe"]);
    expect(await effective(t, w.loner)).not.toContain("prod/scribe");
    const inst = await t.run((ctx) => ctx.db.query("instances").withIndex("by_name", (q) => q.eq("name", "prod")).first());
    expect(inst?.defaultAgentId).toBe("main");
  });

  test("an admin purges it once absent: reservation, share and member default go; the forge re-adding it brings back a decided, unclaimable, disabled agent", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await forgedAndClaimed(t, w);
    await as(t, w.mgr).mutation(api.groups.setMemberDefaultAgent, {
      groupId: w.G,
      userId: w.member,
      agent: { instanceName: "prod", agentId: "scribe" },
    });
    w.gateways.prod!.list = w.gateways.prod!.list.filter((e) => e.id !== "scribe");
    vi.advanceTimersByTime(60_000);
    await sync(t, w.gateways);
    await as(t, w.admin).mutation(api.agents.removeInstanceAgent, { instanceName: "prod", agentId: "scribe" });
    expect(await agentRow(t, "prod", "scribe")).toBeNull();
    const leftovers = await t.run(async (ctx) => ({
      shares: (await ctx.db.query("groupAgents").collect()).filter((r) => r.agentId === "scribe"),
      defaults: (await ctx.db.query("groupMembers").collect()).filter((m) => m.defaultAgent?.agentId === "scribe"),
    }));
    expect(leftovers).toEqual({ shares: [], defaults: [] });

    w.gateways.prod!.list.push({ ...SCRIBE });
    vi.advanceTimersByTime(60_000);
    await sync(t, w.gateways);
    const back = (await agentRow(t, "prod", "scribe"))!;
    expect(back.enabled).toBe(false);
    expect(back.reservedForGroupId).toBeUndefined();
    expect(back.enablementDecidedAt).toBeTypeOf("number");
    await expect(
      as(t, w.mgr).mutation(api.groups.claimAgentForGroup, { groupId: w.G, instanceName: "prod", agentId: "scribe" }),
    ).rejects.toThrow(/not claimable \(decided\)/);
    for (const uid of [w.member, w.loner]) expect(await effective(t, uid)).not.toContain("prod/scribe");
  });

  test("the group is deleted: its former members lose it (the reservation outlives the group, reaching nobody) until an admin moves it", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await forgedAndClaimed(t, w);
    await as(t, w.admin).mutation(api.groups.deleteGroup, { groupId: w.G });
    // Groupless now: the all-pool, which never holds a reserved agent.
    expect(await effective(t, w.member)).toEqual(["prod/helper", "prod/main", "prod/open"]);
    await expect(
      as(t, w.member).mutation(api.chats.createChat, { instanceName: "prod", agentId: "scribe" }),
    ).rejects.toThrow(/not assigned/);
    await as(t, w.admin).mutation(api.agents.setAgentReservation, { instanceName: "prod", agentId: "scribe", groupId: w.H });
    expect(await effective(t, w.hMember)).toEqual(["prod/helper", "prod/scribe"]);
  });

  test("a demoted manager — flag or permission removed — can no longer claim or manage; the claimed agent stays with G", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await forgedAndClaimed(t, w);
    await forge(t, w, { id: "second", name: "Second", model: "m" });
    await as(t, w.admin).mutation(api.groups.setGroupManager, { groupId: w.G, userId: w.mgr, manager: false });
    const claimSecond = () =>
      as(t, w.mgr).mutation(api.groups.claimAgentForGroup, { groupId: w.G, instanceName: "prod", agentId: "second" });
    await expect(claimSecond()).rejects.toThrow(/not a manager/);
    await expect(
      as(t, w.mgr).mutation(api.groups.removeAgentFromGroup, { groupId: w.G, instanceName: "prod", agentId: "scribe" }),
    ).rejects.toThrow(/not a manager/);
    await expect(
      as(t, w.mgr).query(api.groups.listAssignableAgents, { instanceName: "prod", groupId: w.G }),
    ).rejects.toThrow(/not a manager/);
    // Re-flagged, but the permission is withdrawn.
    await as(t, w.admin).mutation(api.groups.setGroupManager, { groupId: w.G, userId: w.mgr, manager: true });
    await as(t, w.admin).mutation(api.admin.setUserPermissions, { profileId: await profileIdOf(t, w.mgr), permissions: [] });
    await expect(claimSecond()).rejects.toThrow(/missing permission groups.manage/);
    expect(await effective(t, w.member)).toEqual(["prod/main", "prod/scribe"]);
    expect((await agentRow(t, "prod", "second"))?.enabled).toBe(false);
  });

  test("a member removed from G loses it: creation refused, their chat on it read-only", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await forgedAndClaimed(t, w);
    await as(t, w.admin).mutation(api.groups.addMember, { groupId: w.H, userId: w.member });
    const chatId = await as(t, w.member).mutation(api.chats.createChat, { instanceName: "prod", agentId: "scribe" });
    await as(t, w.mgr).mutation(api.groups.removeMember, { groupId: w.G, userId: w.member });
    expect(await effective(t, w.member)).toEqual(["prod/helper"]);
    await expect(
      as(t, w.member).mutation(api.chats.createChat, { instanceName: "prod", agentId: "scribe" }),
    ).rejects.toThrow(/not assigned/);
    const { outboxId } = await send(t, w.member, chatId);
    expect(await runDispatches(t)).toEqual([]);
    expect(await outcome(t, outboxId)).toEqual({ status: "failed", errorCode: "agent_restricted" });
  });

  test("an invitation approved by an admin: the new member uses the forged agent at once", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await forgedAndClaimed(t, w);
    const invitee = await user(t, "invitee");
    await expect(
      as(t, invitee).mutation(api.chats.createChat, { instanceName: "prod", agentId: "scribe" }),
    ).rejects.toThrow(/not assigned/);
    const requestId = await as(t, w.mgr).mutation(api.groupInvites.requestGroupInvite, {
      groupId: w.G,
      email: "invitee@example.com",
    });
    await as(t, w.admin).mutation(api.groupInvites.decideGroupInvite, { requestId, approve: true });
    expect(await effective(t, invitee)).toEqual(["prod/main", "prod/scribe"]);
    const chatId = await as(t, invitee).mutation(api.chats.createChat, { instanceName: "prod", agentId: "scribe" });
    await send(t, invitee, chatId);
    expect((await runDispatches(t)).map((b) => `${b.canonical}:${b.agentId}`)).toEqual(["invitee:scribe"]);
  });
});

// ===========================================================================
describe("F. the forge's 'delegable' axis: a sub-agent run happens on the gateway", () => {
  // The forge may also list the new agent in agents.defaults.subagents.allowAgents:
  // then ANY agent of the gateway may spawn it as a child. The spawn is the
  // gateway's decision; Atrium only observes it. These pin what Atrium does with
  // such a child in the chat of someone OUTSIDE the group.
  async function lonerChatWithScribeChild(t: T) {
    const w = await world(t);
    await forgedAndClaimed(t, w);
    const chatId = await as(t, w.loner).mutation(api.chats.createChat, { instanceName: "prod", agentId: "open" });
    const childSessionKey = "agent:scribe:subagent:5b0f6c1e-2d3a-4c55-9e1b-7a8d9c0e1f23";
    return { w, chatId, childSessionKey };
  }

  test("the child's run is recorded and shown in that chat: ingest authorizes by INSTANCE, not by agent", async () => {
    const t = convexTest(schema, modules);
    const { chatId, childSessionKey } = await lonerChatWithScribeChild(t);
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      instanceName: "prod",
      boundInstanceName: "prod",
      childSessionKey,
      status: "running",
    });
    const rows = await t.run((ctx) =>
      ctx.db.query("subAgents").withIndex("by_chat", (q) => q.eq("chatId", chatId)).collect(),
    );
    expect(rows.map((r) => r.childSessionKey)).toEqual([childSessionKey]);
    // The instance boundary is the one that holds: another instance's bridge cannot.
    await expect(
      t.mutation(internal.subAgents.upsertSubAgent, {
        chatId,
        instanceName: "lab",
        boundInstanceName: "lab",
        childSessionKey: "agent:scribe:subagent:other",
        status: "running",
      }),
    ).rejects.toThrow(/cross-instance sub-agent target/);
  });

  test("…and that user's Stop cannot reach it: the kill is routed on the child's agent, which they are not entitled to", async () => {
    const t = convexTest(schema, modules);
    const { chatId, childSessionKey, w } = await lonerChatWithScribeChild(t);
    await t.mutation(internal.subAgents.upsertSubAgent, {
      chatId,
      instanceName: "prod",
      boundInstanceName: "prod",
      childSessionKey,
      status: "running",
    });
    const res = await as(t, w.loner).mutation(api.messages.abortTurn, { chatId });
    expect(res.ok).toBe(true);
    const aborts: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/abort")) aborts.push(String(input));
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    try {
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      globalThis.fetch = orig;
    }
    expect(aborts).toEqual([]);
    const row = await t.run((ctx) =>
      ctx.db.query("subAgents").withIndex("by_chat", (q) => q.eq("chatId", chatId)).first(),
    );
    expect(row?.status).toBe("running");
  });
});

