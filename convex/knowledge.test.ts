/// <reference types="vite/client" />
//
// WHICH KNOWLEDGE SOURCES AN AGENT SEARCHES (convex/knowledge.ts).
//
// Discovery stores what the plugin allows per agent; the conversation's OWNER chooses
// per agent among those sources (participants see, never change); the choice is applied
// at once when that agent's session is the current one and carried by every later turn to
// that agent — withheld by name when the target's bridge cannot apply it; an
// administrator writes the agent default through the bridge, and only the confirmed
// read-back is stored.

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import {
  KNOWLEDGE_DEFAULT_BRIDGE_BUDGET_MS,
  KNOWLEDGE_DEFAULT_POST_TIMEOUT_MS,
  readKnowledgeApplyResponse,
} from "./knowledge";
import {
  MAX_KNOWLEDGE_CHOICES_PER_CHAT,
  dispatchKnowledgeChoice,
  effectiveSelection,
  knowledgeChoiceRefusal,
  normalizeKnowledgeFacts,
} from "./lib/knowledge";
import { readSendAnswer } from "./bridge";

const modules = import.meta.glob("./**/*.ts");
type T = TestConvex<typeof schema>;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const SOURCES = [
  { id: "graph", type: "lightrag", label: "Graphe", description: "Le graphe", default: true },
  { id: "docs", type: "pgvector", label: "Documents", description: "Les documents", default: true },
  { id: "archive", type: "pgvector", label: "Archives", description: "Les archives", default: false },
];

async function seed(
  t: T,
  opts: {
    ownerRole?: "user" | "admin";
    kind?: "openclaw" | "hermes";
    compat?: "confirmed" | "lacking" | "none";
    facts?: "available" | "absent" | "none";
    overridesAllowed?: boolean;
  } = {},
) {
  return t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", {
      userId: owner,
      role: opts.ownerRole ?? "user",
      canonical: "owner",
      name: "owner",
      email: "owner@example.com",
    });
    const guest = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", {
      userId: guest,
      role: "admin",
      canonical: "guest",
      name: "guest",
      email: "guest@example.com",
    });
    await ctx.db.insert("instances", {
      name: "alpha",
      gatewayUrl: "ws://gw",
      ...(opts.kind === "hermes" ? { kind: "hermes" as const } : {}),
    });
    if ((opts.compat ?? "confirmed") !== "none") {
      await ctx.db.insert("bridgeCompat", {
        key: "singleton",
        reachable: true,
        bridgeVersion: "0.88.0",
        protocolVersion: 2,
        compat: null,
        fetchedAt: Date.now(),
        targets: [
          {
            instanceName: "alpha",
            provider: opts.kind === "hermes" ? "hermes" : "openclaw",
            gatewayVersion: "2026.9.6",
            capabilities:
              opts.compat === "lacking"
                ? { knobModel: true }
                : { knobModel: true, knowledgePolicy: true },
            versionBeyondValidated: false,
          },
        ],
      });
    }
    for (const agentId of ["alice", "files"]) {
      await ctx.db.insert("agents", {
        instanceName: "alpha",
        agentId,
        displayName: agentId,
        enabled: true,
        source: "discovered" as const,
        presentInLastOk: true,
        firstSeenAt: 1,
        lastSeenAt: 1,
      });
      await ctx.db.insert("userAgents", {
        userId: owner,
        instanceName: "alpha",
        agentId,
        isDefault: agentId === "alice",
        source: "manual",
        createdAt: 1,
      } as never);
    }
    if ((opts.facts ?? "available") === "available") {
      for (const agentId of ["alice", "files"]) {
        await ctx.db.insert("agentKnowledge", {
          instanceName: "alpha",
          agentId,
          available: true,
          configured: true,
          injection: "auto",
          defaultSources: agentId === "alice" ? ["graph", "docs"] : ["docs"],
          overridesAllowed: opts.overridesAllowed ?? true,
          sources: agentId === "alice" ? SOURCES : SOURCES.slice(0, 2),
          fetchedAt: Date.now(),
        });
      }
    } else if (opts.facts === "absent") {
      await ctx.db.insert("agentKnowledge", {
        instanceName: "alpha",
        agentId: "alice",
        available: false,
        reason: "plugin_absent",
        fetchedAt: Date.now(),
      });
    }
    const chatId = await ctx.db.insert("chats", {
      userId: owner,
      updatedAt: 1,
      instanceName: "alpha",
      agentId: "alice",
    });
    await ctx.db.insert("chatParticipants", {
      chatId,
      userId: guest,
      role: "member",
      addedBy: owner,
      addedAt: 1,
    } as never);
    return { owner, guest, chatId };
  });
}

/** Every page of the admin card's agent list (codex pass 22: paginated). */
async function adminAgents(t: T, owner: Id<"users">, instanceName = "alpha", numItems = 50) {
  const agents: Array<Awaited<ReturnType<typeof pageOf>>["page"][number]> = [];
  let cursor: string | null = null;
  const pageOf = (c: string | null) =>
    t.withIdentity({ subject: owner }).query(api.knowledge.agentKnowledgePage, {
      instanceName,
      paginationOpts: { numItems, cursor: c },
    });
  for (let i = 0; i < 100; i += 1) {
    const p = await pageOf(cursor);
    agents.push(...p.page);
    if (p.isDone) break;
    cursor = p.continueCursor;
  }
  return { agents };
}

function fakeBridge(answer: (path: string, body: Record<string, unknown>) => Response) {
  const prevUrl = process.env.BRIDGE_URL;
  const prevSecret = process.env.BRIDGE_SHARED_SECRET;
  process.env.BRIDGE_URL = "http://bridge.test";
  process.env.BRIDGE_SHARED_SECRET = "s3cret";
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const path = new URL(String(input)).pathname;
    calls.push({ path, body });
    return answer(path, body);
  });
  return {
    calls,
    restore: () => {
      vi.unstubAllGlobals();
      if (prevUrl === undefined) delete process.env.BRIDGE_URL;
      else process.env.BRIDGE_URL = prevUrl;
      if (prevSecret === undefined) delete process.env.BRIDGE_SHARED_SECRET;
      else process.env.BRIDGE_SHARED_SECRET = prevSecret;
    },
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const rowOf = async (t: T, chatId: Id<"chats">, agentId = "alice") =>
  t.run((ctx) =>
    ctx.db
      .query("chatKnowledgeChoices")
      .withIndex("by_chat_agent", (q) =>
        q.eq("chatId", chatId).eq("instanceName", "alpha").eq("agentId", agentId),
      )
      .first(),
  );

describe("the rules", () => {
  const facts = { available: true, overridesAllowed: true, sources: [{ id: "graph" }, { id: "docs" }] };
  test("who may choose what", () => {
    const r = (choice: Parameters<typeof knowledgeChoiceRefusal>[0]["choice"], over = {}) =>
      knowledgeChoiceRefusal({ isOwner: true, provider: "openclaw", facts, choice, ...over });
    expect(r({ kind: "sources", sources: ["docs"] })).toBeNull();
    expect(r({ kind: "off" })).toBeNull();
    expect(r({ kind: "sources", sources: ["docs"] }, { isOwner: false })).toBe("not_owner");
    expect(r({ kind: "sources", sources: ["docs"] }, { provider: "hermes" })).toBe("not_openclaw");
    expect(r({ kind: "sources", sources: ["docs"] }, { facts: null })).toBe("unavailable");
    expect(r({ kind: "sources", sources: ["docs"] }, { facts: { available: false } })).toBe("unavailable");
    // Only what the plugin lists for the agent — never an invented id.
    expect(r({ kind: "sources", sources: ["invented"] })).toBe("source_not_allowed");
    expect(r({ kind: "sources", sources: [] })).toBe("invalid");
    expect(r({ kind: "off" }, { facts: { ...facts, overridesAllowed: false } })).toBe("overrides_disabled");
    // Back to the agent's default stays possible when the operator disabled overrides:
    // it removes Atrium's choice, never adds one — the owner's way out.
    expect(r({ kind: "default" }, { facts: { ...facts, overridesAllowed: false } })).toBeNull();
    expect(r({ kind: "default" })).toBeNull();
  });

  test("what a turn carries", () => {
    const stored = { choice: { kind: "off" as const }, revision: 3 };
    expect(dispatchKnowledgeChoice({ stored: null, provider: "openclaw", confirmed: true })).toBeNull();
    expect(dispatchKnowledgeChoice({ stored, provider: "hermes", confirmed: true })).toBeNull();
    expect(dispatchKnowledgeChoice({ stored, provider: "openclaw", confirmed: true })).toEqual({
      send: { choice: { kind: "off" }, revision: 3 },
    });
    expect(dispatchKnowledgeChoice({ stored, provider: "openclaw", confirmed: false })).toEqual({ refuse: true });
    expect(
      dispatchKnowledgeChoice({ stored: { choice: { kind: "default" }, revision: 1, overrideEver: false }, provider: "openclaw", confirmed: false }),
    ).toBeNull();
    expect(
      dispatchKnowledgeChoice({ stored: { choice: { kind: "default" }, revision: 1, overrideEver: true }, provider: "openclaw", confirmed: false }),
    ).toEqual({ refuse: true });
    expect(
      dispatchKnowledgeChoice({ stored: { choice: { kind: "default" }, revision: 1 }, provider: "openclaw", confirmed: false }),
    ).toEqual({ refuse: true });
  });

  test("the effective selection shown", () => {
    const def = { injection: "auto", defaultSources: ["graph", "docs"] };
    expect(effectiveSelection(null, def)).toEqual({ off: false, sources: ["graph", "docs"] });
    expect(effectiveSelection({ kind: "off" }, def)).toEqual({ off: true, sources: [] });
    expect(effectiveSelection({ kind: "sources", sources: ["docs"] }, def)).toEqual({ off: false, sources: ["docs"] });
    expect(effectiveSelection(null, { injection: "off", defaultSources: ["docs"] })).toEqual({ off: true, sources: [] });
  });

  test("the bridge's projection is copied defensively", () => {
    expect(normalizeKnowledgeFacts({ available: false, reason: "plugin_absent" })).toEqual({
      available: false,
      reason: "plugin_absent",
    });
    expect(normalizeKnowledgeFacts({ available: false, reason: "Some Gateway Text" })).toEqual({
      available: false,
      reason: "unreadable",
    });
    const f = normalizeKnowledgeFacts({
      available: true,
      info: { injection: "hybrid", defaultSources: ["docs"], overridesAllowed: true, configured: true, sources: [{ id: "docs" }, { id: "" }] },
    });
    expect(f).toMatchObject({ available: true, injection: "hybrid", sources: [{ id: "docs", label: "docs" }] });
    expect(normalizeKnowledgeFacts({ available: true, info: { injection: "always" } })).toBeNull();
    // The plugin contract (integer >= 2, else 4.0.x) and the own-allowlist fact, which
    // rides only WITH the raw view (codex pass 18).
    const base = { injection: "auto", defaultSources: [], overridesAllowed: true, configured: true, sources: [] };
    const cfg = { injection: null, sources: null };
    expect(normalizeKnowledgeFacts({ available: true, info: { ...base, contract: 2 } })).toMatchObject({ contract: 2 });
    for (const contract of [1, "2", 2.5]) {
      const f1 = normalizeKnowledgeFacts({ available: true, info: { ...base, contract } });
      expect(f1 !== null && f1.available && "contract" in f1).toBe(false);
    }
    expect(normalizeKnowledgeFacts({ available: true, info: base, config: cfg, ownAllowlist: true })).toMatchObject({ ownAllowlist: true });
    const bare = normalizeKnowledgeFacts({ available: true, info: base, ownAllowlist: true });
    expect(bare !== null && bare.available && "ownAllowlist" in bare).toBe(false);
    // The raw view is kept WHOLE or not at all — never cut (codex pass 14).
    const info = { injection: "auto", defaultSources: [], overridesAllowed: true, configured: true, sources: [] };
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`);
    const kept = normalizeKnowledgeFacts({ available: true, info, config: { injection: null, sources: ids(64) } });
    expect(kept !== null && kept.available && kept.config?.sources).toHaveLength(64);
    const past = normalizeKnowledgeFacts({ available: true, info, config: { injection: null, sources: ids(65) } });
    expect(past !== null && past.available && "config" in past).toBe(false);
  });
});

describe("discovery stores what the plugin says, per agent", () => {
  test("available, absent, and one unreadable answer that does not erase last-good", async () => {
    const t = convexTest(schema, modules);
    await seed(t, { facts: "none" });
    await t.mutation(internal.knowledge.recordKnowledgeDiscovery, {
      instanceName: "alpha",
      entries: {
        alice: { available: true, info: { injection: "auto", defaultSources: ["docs"], overridesAllowed: true, configured: true, sources: SOURCES } },
        files: { available: false, reason: "plugin_absent" },
      },
    });
    const rows = await t.run((ctx) => ctx.db.query("agentKnowledge").collect());
    expect(rows.find((r) => r.agentId === "alice")).toMatchObject({ available: true, defaultSources: ["docs"] });
    expect(rows.find((r) => r.agentId === "files")).toMatchObject({ available: false, reason: "plugin_absent" });
    await t.mutation(internal.knowledge.recordKnowledgeDiscovery, {
      instanceName: "alpha",
      entries: { alice: { available: false, reason: "unreadable" } },
    });
    const after = await t.run((ctx) => ctx.db.query("agentKnowledge").collect());
    expect(after.find((r) => r.agentId === "alice")).toMatchObject({ available: true });
  });

  // Codex pass 4: a discovery that STARTED before an admin's confirmed save and finishes
  // after it must not bring the old default back. Both stamps are the bridge's clock.
  test("an older reading never replaces a newer one; an unstamped one (older bridge) is taken as before", async () => {
    const t = convexTest(schema, modules);
    await seed(t, { facts: "none" });
    const info = (injection: string, defaultSources: string[]) => ({
      injection,
      defaultSources,
      overridesAllowed: true,
      configured: true,
      sources: SOURCES,
    });
    // The admin's confirmed save, read back at bridge time 2000.
    await t.mutation(internal.knowledge.recordAgentDefault, {
      instanceName: "alpha",
      agentId: "alice",
      knowledge: info("hybrid", ["docs"]),
      observedAt: 2000,
    });
    const row = () =>
      t.run((ctx) =>
        ctx.db.query("agentKnowledge").withIndex("by_instance_agent", (q) => q.eq("instanceName", "alpha").eq("agentId", "alice")).first(),
      );
    // A discovery whose read was SENT at 1500 (before the save) lands now: refused.
    await t.mutation(internal.knowledge.recordKnowledgeDiscovery, {
      instanceName: "alpha",
      entries: { alice: { available: true, info: info("auto", ["graph", "docs"]), observedAt: 1500 } },
    });
    expect(await row()).toMatchObject({ injection: "hybrid", defaultSources: ["docs"], observedAt: 2000 });
    // A later reading replaces it.
    await t.mutation(internal.knowledge.recordKnowledgeDiscovery, {
      instanceName: "alpha",
      entries: { alice: { available: true, info: info("tool", ["graph"]), observedAt: 2500 } },
    });
    expect(await row()).toMatchObject({ injection: "tool", observedAt: 2500 });
    // An unstamped reading cannot be ordered: it never overwrites a stamped row (codex
    // pass 20) — the race: the plugin re-enabled and read at 2500, then a LATE, unstamped
    // copy of an older absence arrives.
    await t.mutation(internal.knowledge.recordKnowledgeDiscovery, {
      instanceName: "alpha",
      entries: { alice: { available: false, reason: "plugin_absent" } },
    });
    expect(await row()).toMatchObject({ available: true, injection: "tool", observedAt: 2500 });
    await t.mutation(internal.knowledge.recordKnowledgeDiscovery, {
      instanceName: "alpha",
      entries: { alice: { available: true, info: info("auto", ["docs"]) } },
    });
    expect(await row()).toMatchObject({ injection: "tool" });
    // A row that has no stamp yet still takes an unstamped reading, as before.
    await t.mutation(internal.knowledge.recordKnowledgeDiscovery, {
      instanceName: "alpha",
      entries: { files: { available: true, info: info("auto", ["docs"]) } },
    });
    await t.mutation(internal.knowledge.recordKnowledgeDiscovery, {
      instanceName: "alpha",
      entries: { files: { available: true, info: info("hybrid", ["docs"]) } },
    });
    const files = await t.run((ctx) =>
      ctx.db.query("agentKnowledge").withIndex("by_instance_agent", (q) => q.eq("instanceName", "alpha").eq("agentId", "files")).first(),
    );
    expect(files?.injection).toBe("hybrid");
  });

  // Codex pass 21: discovery covers a large roster over successive syncs, a WINDOW each —
  // an agent absent from this batch is not absent from the instance.
  test("150 agents over two windowed syncs: every one gets a row; a sync never touches the rows it did not probe", async () => {
    const t = convexTest(schema, modules);
    await seed(t, { facts: "none" });
    const ids = Array.from({ length: 150 }, (_, i) => `agent-${i}`);
    const batch = (from: string[], at: number) =>
      Object.fromEntries(
        from.map((id) => [id, { available: true, info: { injection: "auto", defaultSources: ["docs"], overridesAllowed: true, configured: true, sources: SOURCES }, observedAt: at }]),
      );
    const rows = () => t.run((ctx) => ctx.db.query("agentKnowledge").withIndex("by_instance", (q) => q.eq("instanceName", "alpha")).collect());
    await t.mutation(internal.knowledge.recordKnowledgeDiscovery, { instanceName: "alpha", entries: batch(ids.slice(0, 100), 1_000) });
    const afterFirst = await rows();
    expect(afterFirst).toHaveLength(100);
    await t.mutation(internal.knowledge.recordKnowledgeDiscovery, {
      instanceName: "alpha",
      entries: batch([...ids.slice(100), ...ids.slice(0, 50)], 2_000),
    });
    const afterSecond = await rows();
    expect(new Set(afterSecond.map((r) => r.agentId))).toEqual(new Set(ids));
    // agent-50..99 were not in the second window: their rows are exactly as the first left them.
    for (const id of ids.slice(50, 100)) {
      const before = afterFirst.find((r) => r.agentId === id);
      const now = afterSecond.find((r) => r.agentId === id);
      expect(now).toEqual(before);
    }
  });

  // Codex pass 22: no hidden truncation — the admin list is paged, every agent reachable.
  test("250 agents with the plugin: the admin list reaches the 250th, and its default can be saved", async () => {
    const t = convexTest(schema, modules);
    const { owner } = await seed(t, { ownerRole: "admin", facts: "none" });
    await t.run(async (ctx) => {
      for (let i = 0; i < 250; i += 1) {
        await ctx.db.insert("agentKnowledge", {
          instanceName: "alpha",
          agentId: `agent-${i}`,
          available: true,
          configured: true,
          injection: "auto",
          defaultSources: ["docs"],
          overridesAllowed: true,
          sources: SOURCES,
          fetchedAt: 1,
        });
      }
      // An agent without the plugin is not an admin row.
      await ctx.db.insert("agentKnowledge", { instanceName: "alpha", agentId: "no-plugin", available: false, reason: "plugin_absent", fetchedAt: 1 });
    });
    const listed = await adminAgents(t, owner, "alpha", 100);
    expect(listed.agents).toHaveLength(250);
    expect(listed.agents.some((a) => a.agentId === "agent-249")).toBe(true);
    expect(listed.agents.some((a) => a.agentId === "no-plugin")).toBe(false);
    const bridge = fakeBridge(() =>
      json(200, { ok: true, knowledge: { injection: "hybrid", defaultSources: ["docs"], overridesAllowed: true, configured: true, sources: SOURCES }, observedAt: 7 }),
    );
    try {
      const out = await t.withIdentity({ subject: owner }).action(api.knowledge.setAgentKnowledgeDefault, {
        instanceName: "alpha",
        agentId: "agent-249",
        injection: "hybrid",
        sources: ["docs"],
        expected: { injection: "auto", defaultSources: ["docs"] },
      });
      expect(out).toEqual({ ok: true });
    } finally {
      bridge.restore();
    }
    const after = await adminAgents(t, owner, "alpha", 100);
    expect(after.agents.find((a) => a.agentId === "agent-249")?.injection).toBe("hybrid");
  });

  test("the admin action stores the bridge's read-back stamp", async () => {
    const t = convexTest(schema, modules);
    const { owner } = await seed(t, { ownerRole: "admin" });
    const bridge = fakeBridge(() =>
      json(200, { ok: true, knowledge: { injection: "hybrid", defaultSources: ["docs"], overridesAllowed: true, configured: true, sources: SOURCES }, observedAt: 4242 }),
    );
    try {
      await t.withIdentity({ subject: owner }).action(api.knowledge.setAgentKnowledgeDefault, {
        instanceName: "alpha",
        agentId: "alice",
        injection: "hybrid",
        sources: ["docs"],
        expected: { injection: "auto", defaultSources: ["graph", "docs"] },
      });
    } finally {
      bridge.restore();
    }
    const r = await t.run((ctx) =>
      ctx.db.query("agentKnowledge").withIndex("by_instance_agent", (q) => q.eq("instanceName", "alpha").eq("agentId", "alice")).first(),
    );
    expect(r?.observedAt).toBe(4242);
  });

  test("the contract and the own-allowlist fact are stored and projected to the admin card (codex pass 18)", async () => {
    const t = convexTest(schema, modules);
    const { owner } = await seed(t, { ownerRole: "admin" });
    const bridge = fakeBridge(() =>
      json(200, {
        ok: true,
        knowledge: { injection: "hybrid", defaultSources: ["docs"], overridesAllowed: true, configured: true, sources: SOURCES, contract: 2 },
        config: { injection: "hybrid", sources: ["docs"] },
        ownAllowlist: true,
        observedAt: 4343,
      }),
    );
    try {
      await t.withIdentity({ subject: owner }).action(api.knowledge.setAgentKnowledgeDefault, {
        instanceName: "alpha",
        agentId: "alice",
        injection: "hybrid",
        sources: ["docs"],
        expected: { injection: "auto", defaultSources: ["graph", "docs"] },
      });
    } finally {
      bridge.restore();
    }
    const listed = await adminAgents(t, owner);
    expect(listed.agents.find((a) => a.agentId === "alice")).toMatchObject({ contract: 2, ownAllowlist: true });
    // A row without either: the 4.0.x contract, the own-allowlist fact unknown.
    expect(listed.agents.find((a) => a.agentId === "files")).toMatchObject({ contract: 1, ownAllowlist: null });
  });

  test("the discovery poll carries it from the bridge's /agents answer", async () => {
    const t = convexTest(schema, modules);
    await seed(t, { facts: "none" });
    const bridge = fakeBridge(() =>
      json(200, {
        ok: true,
        agents: [{ agentId: "alice" }],
        count: 1,
        knowledge: { alice: { available: true, info: { injection: "tool", defaultSources: ["graph"], overridesAllowed: false, configured: true, sources: SOURCES } } },
      }),
    );
    try {
      await t.action(internal.agents.pollAgentDiscovery, {});
    } finally {
      bridge.restore();
    }
    const row = await t.run((ctx) => ctx.db.query("agentKnowledge").first());
    expect(row).toMatchObject({ agentId: "alice", injection: "tool", overridesAllowed: false });
  });
});

describe("the owner chooses; everyone sees", () => {
  test("the owner's choice is stored pending and dispatched at once", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await seed(t);
    await t.withIdentity({ subject: owner }).mutation(api.knowledge.setKnowledgeChoice, {
      chatId,
      instanceName: "alpha",
      agentId: "alice",
      choice: { kind: "sources", sources: ["docs", "docs"] },
    });
    const row = await rowOf(t, chatId);
    expect(row).toMatchObject({ choice: { kind: "sources", sources: ["docs"] }, revision: 1, apply: { status: "pending" } });
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.map((s) => s.name)).toContain("knowledge:dispatchKnowledgeChoice");
  });

  test("a participant cannot choose — not even an administrator in the room", async () => {
    const t = convexTest(schema, modules);
    const { guest, chatId } = await seed(t);
    await expect(
      t.withIdentity({ subject: guest }).mutation(api.knowledge.setKnowledgeChoice, {
        chatId,
        instanceName: "alpha",
        agentId: "alice",
        choice: { kind: "off" },
      }),
    ).rejects.toThrow(/Forbidden/);
    expect(await rowOf(t, chatId)).toBeNull();
  });

  test("never a source the plugin does not list; never when overrides are off; never on Hermes or without the plugin", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await seed(t);
    const set = (choice: { kind: "sources"; sources: string[] } | { kind: "off" }, tt = t, o = owner, c = chatId) =>
      tt.withIdentity({ subject: o }).mutation(api.knowledge.setKnowledgeChoice, {
        chatId: c,
        instanceName: "alpha",
        agentId: "files",
        choice,
      });
    // `archive` is alice's, not files'.
    await expect(set({ kind: "sources", sources: ["archive"] })).rejects.toThrow(/source_not_allowed/);
    const t2 = convexTest(schema, modules);
    const s2 = await seed(t2, { overridesAllowed: false });
    await expect(set({ kind: "off" }, t2, s2.owner, s2.chatId)).rejects.toThrow(/overrides_disabled/);
    // …but the way back is open: the owner can always return to the agent's default.
    await t2.withIdentity({ subject: s2.owner }).mutation(api.knowledge.setKnowledgeChoice, {
      chatId: s2.chatId,
      instanceName: "alpha",
      agentId: "files",
      choice: { kind: "default" },
    });
    expect((await rowOf(t2, s2.chatId, "files"))?.choice).toEqual({ kind: "default" });
    const t3 = convexTest(schema, modules);
    const s3 = await seed(t3, { facts: "absent" });
    await expect(
      t3.withIdentity({ subject: s3.owner }).mutation(api.knowledge.setKnowledgeChoice, {
        chatId: s3.chatId,
        instanceName: "alpha",
        agentId: "alice",
        choice: { kind: "off" },
      }),
    ).rejects.toThrow(/unavailable/);
    const t4 = convexTest(schema, modules);
    const s4 = await seed(t4, { kind: "hermes" });
    await expect(
      t4.withIdentity({ subject: s4.owner }).mutation(api.knowledge.setKnowledgeChoice, {
        chatId: s4.chatId,
        instanceName: "alpha",
        agentId: "alice",
        choice: { kind: "off" },
      }),
    ).rejects.toThrow(/not_openclaw/);
  });

  test("an agent this conversation cannot reach is refused", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await seed(t);
    await expect(
      t.withIdentity({ subject: owner }).mutation(api.knowledge.setKnowledgeChoice, {
        chatId,
        instanceName: "alpha",
        agentId: "stranger",
        choice: { kind: "off" },
      }),
    ).rejects.toThrow(/agent_not_in_conversation/);
  });

  test("the participant sees the owner's choice, per agent, with the sources and the default", async () => {
    const t = convexTest(schema, modules);
    const { owner, guest, chatId } = await seed(t);
    await t.withIdentity({ subject: owner }).mutation(api.knowledge.setKnowledgeChoice, {
      chatId,
      instanceName: "alpha",
      agentId: "alice",
      choice: { kind: "off" },
    });
    const seen = await t.withIdentity({ subject: guest }).query(api.knowledge.knowledgeControl, { chatId });
    expect(seen).toMatchObject({
      viewerRole: "participant",
      target: { instanceName: "alpha", agentId: "alice" },
      supported: true,
      choice: { kind: "off" },
      facts: { available: true, defaultSources: ["graph", "docs"] },
    });
    // Another agent of the room has its own (absent) choice.
    const files = await t
      .withIdentity({ subject: owner })
      .query(api.knowledge.knowledgeControl, { chatId, routedAgent: { instanceName: "alpha", agentId: "files" } });
    expect(files?.choice).toBeNull();
  });

  // Codex pass 17: the owner's `routedAgent` is an INPUT — an agent neither in the
  // conversation nor within the owner's grants gets nothing, not its sources.
  test("a foreign agent named as the routed target: nothing about its sources", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("agentKnowledge", {
        instanceName: "alpha",
        agentId: "secret",
        available: true,
        configured: true,
        injection: "auto",
        defaultSources: ["hr"],
        overridesAllowed: true,
        sources: [{ id: "hr", type: "pgvector", label: "RH confidentiel", description: "dossiers du personnel", default: true }],
        fetchedAt: Date.now(),
      });
    });
    const seen = await t
      .withIdentity({ subject: owner })
      .query(api.knowledge.knowledgeControl, { chatId, routedAgent: { instanceName: "alpha", agentId: "secret" } });
    expect(JSON.stringify(seen ?? null)).not.toMatch(/RH confidentiel|dossiers|"hr"/);
    // …while an agent within the owner's grants still answers.
    const files = await t
      .withIdentity({ subject: owner })
      .query(api.knowledge.knowledgeControl, { chatId, routedAgent: { instanceName: "alpha", agentId: "files" } });
    expect(files?.facts?.available).toBe(true);
  });
});

describe("applied at once when that agent's session is the current one", () => {
  const choose = async (t: T, owner: Id<"users">, chatId: Id<"chats">, agentId: string, choice: Record<string, unknown>) => {
    await t.withIdentity({ subject: owner }).mutation(api.knowledge.setKnowledgeChoice, {
      chatId,
      instanceName: "alpha",
      agentId,
      choice: choice as never,
    });
    const row = await rowOf(t, chatId, agentId);
    await t.action(internal.knowledge.dispatchKnowledgeChoice, {
      chatId,
      userId: owner,
      instanceName: "alpha",
      agentId,
      revision: row!.revision,
    });
    return (await rowOf(t, chatId, agentId))?.apply;
  };

  test("applied: the bridge is asked with the routing and the choice; the plugin's effective sources are kept", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await seed(t);
    const bridge = fakeBridge(() =>
      json(200, { ok: true, result: "applied", snapshot: { injection: "auto", effectiveSources: ["docs"], origin: { injection: "agent", sources: "session" } } }),
    );
    try {
      const apply = await choose(t, owner, chatId, "alice", { kind: "sources", sources: ["docs"] });
      expect(apply).toMatchObject({ status: "applied", effectiveSources: ["docs"] });
      expect(bridge.calls.find((c) => c.path === "/knowledge")?.body).toMatchObject({
        op: "apply",
        chatId,
        instanceName: "alpha",
        agentId: "alice",
        canonical: "owner",
        choice: { kind: "sources", sources: ["docs"] },
        revision: 1,
      });
    } finally {
      bridge.restore();
    }
  });

  test("another agent's choice waits for that agent's next turn: never POSTed to the current session", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await seed(t);
    const bridge = fakeBridge(() => json(200, { ok: true, result: "applied" }));
    try {
      const apply = await choose(t, owner, chatId, "files", { kind: "off" });
      expect(apply).toMatchObject({ status: "deferred", reason: "next_turn" });
      expect(bridge.calls.filter((c) => c.path === "/knowledge")).toEqual([]);
    } finally {
      bridge.restore();
    }
  });

  test("a refusal is recorded with its reason; an unconfirmed bridge is not asked", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await seed(t);
    const bridge = fakeBridge(() =>
      json(409, { ok: false, error: { code: "knowledge_policy_not_applied", reason: "overrides_disabled" } }),
    );
    try {
      expect(await choose(t, owner, chatId, "alice", { kind: "off" })).toMatchObject({
        status: "failed",
        reason: "overrides_disabled",
      });
    } finally {
      bridge.restore();
    }
    const t2 = convexTest(schema, modules);
    const s2 = await seed(t2, { compat: "none" });
    const b2 = fakeBridge(() => json(200, { ok: true, result: "applied" }));
    try {
      expect(await choose(t2, s2.owner, s2.chatId, "alice", { kind: "off" })).toMatchObject({
        status: "failed",
        reason: "unsupported_gateway",
      });
      expect(b2.calls.filter((c) => c.path === "/knowledge")).toEqual([]);
    } finally {
      b2.restore();
    }
  });

  test("an outcome for an older revision never overwrites the current one's", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await seed(t);
    const set = (choice: Record<string, unknown>) =>
      t.withIdentity({ subject: owner }).mutation(api.knowledge.setKnowledgeChoice, {
        chatId,
        instanceName: "alpha",
        agentId: "alice",
        choice: choice as never,
      });
    await set({ kind: "off" });
    await set({ kind: "default" });
    await t.mutation(internal.knowledge.recordKnowledgeApply, {
      chatId,
      instanceName: "alpha",
      agentId: "alice",
      revision: 1,
      status: "failed",
      reason: "write_failed",
    });
    expect((await rowOf(t, chatId))?.apply).toMatchObject({ revision: 2, status: "pending" });
  });

  test("the bridge's answers, read", async () => {
    expect(await readKnowledgeApplyResponse(json(200, { ok: true, result: "deferred" }))).toEqual({ status: "deferred" });
    // Applied minus revoked ids (codex pass 19): ids only; nothing valid → an ordinary apply.
    expect(await readKnowledgeApplyResponse(json(200, { ok: true, result: "clamped", dropped: ["graph", "<x>"] }))).toEqual({
      status: "clamped",
      dropped: ["graph"],
    });
    expect(await readKnowledgeApplyResponse(json(200, { ok: true, result: "clamped", dropped: ["<x>"] }))).toEqual({ status: "applied" });
    expect(await readKnowledgeApplyResponse(json(200, { ok: true, result: "unchanged" }))).toEqual({ status: "applied" });
    expect(await readKnowledgeApplyResponse(json(409, { ok: false, error: { code: "instance_not_served" } }))).toEqual({
      status: "failed",
      reason: "instance_not_served",
    });
    expect(await readKnowledgeApplyResponse(new Response("boom", { status: 502 }))).toEqual({
      status: "failed",
      reason: "bridge_error",
    });
  });
});

describe("every turn to that agent carries the choice", () => {
  const sendOnce = async (t: T, owner: Id<"users">, chatId: Id<"chats">, answer?: (body: Record<string, unknown>) => Response) => {
    const sends: Array<Record<string, unknown>> = [];
    const bridge = fakeBridge((path, body) => {
      if (path === "/send") {
        sends.push(body);
        return answer?.(body) ?? json(200, { ok: true });
      }
      return json(200, { ok: true });
    });
    try {
      const { outboxId } = await t.withIdentity({ subject: owner }).mutation(api.send.sendMessage, {
        chatId,
        text: "bonjour",
        clientMessageId: `c-${Math.random()}`,
      });
      await t.action(internal.bridge.dispatch, { outboxId });
    } finally {
      bridge.restore();
    }
    return sends[0];
  };
  const store = (
    t: T,
    chatId: Id<"chats">,
    choice: Record<string, unknown>,
    revision = 5,
    overrideEver: boolean | "legacy" = (choice as { kind: string }).kind !== "default",
  ) =>
    t.run(async (ctx) => {
      const chat = await ctx.db.get(chatId);
      return await ctx.db.insert("chatKnowledgeChoices", {
        chatId,
        instanceName: "alpha",
        agentId: "alice",
        choice: choice as never,
        revision,
        ...(overrideEver === "legacy" ? {} : { overrideEver }),
        setBy: chat!.userId,
        setAt: 1,
        apply: { revision, status: "pending", at: 1 },
      });
    });

  test("nobody chose: nothing rides — the send exactly as before", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await seed(t);
    const send = await sendOnce(t, owner, chatId);
    expect(send && "knowledgeChoice" in send).toBe(false);
  });

  test("a choice for the turn's agent rides with its revision; the bridge's outcome is recorded", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await seed(t);
    await store(t, chatId, { kind: "sources", sources: ["docs"] });
    const send = await sendOnce(t, owner, chatId, () =>
      json(200, { ok: true, knowledge: { status: "applied", revision: 5, snapshot: { effectiveSources: ["docs"] } } }),
    );
    expect(send?.knowledgeChoice).toEqual({ kind: "sources", sources: ["docs"] });
    expect(send?.knowledgeRevision).toBe(5);
    expect((await rowOf(t, chatId))?.apply).toMatchObject({ status: "applied", effectiveSources: ["docs"] });
  });

  test("a refusal by the bridge withholds the turn by name and the reason reaches the composer", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await seed(t);
    await store(t, chatId, { kind: "off" });
    await sendOnce(t, owner, chatId, () =>
      json(502, {
        ok: false,
        error: { code: "knowledge_policy_not_applied", reason: "plugin_absent" },
        knowledge: { status: "failed", reason: "plugin_absent", revision: 5 },
      }),
    );
    const failed = await t.run(async (ctx) =>
      (await ctx.db.query("messages").withIndex("by_chat", (q) => q.eq("chatId", chatId)).collect()).some(
        (m) => m.errorCode === "knowledge_policy_not_applied",
      ),
    );
    expect(failed).toBe(true);
    expect((await rowOf(t, chatId))?.apply).toMatchObject({ status: "failed", reason: "plugin_absent" });
  });

  test("a bridge not confirmed to apply it: a non-default choice is refused by name, never POSTed", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await seed(t, { compat: "lacking" });
    await store(t, chatId, { kind: "off" });
    const send = await sendOnce(t, owner, chatId);
    expect(send).toBeUndefined();
    const failed = await t.run(async (ctx) =>
      (await ctx.db.query("messages").withIndex("by_chat", (q) => q.eq("chatId", chatId)).collect()).some(
        (m) => m.errorCode === "knowledge_policy_not_applied",
      ),
    );
    expect(failed).toBe(true);
    expect((await rowOf(t, chatId))?.apply).toMatchObject({ status: "failed", reason: "unsupported_gateway" });
  });

  test("…but 'default' still goes to such a bridge when no override was ever left on a session", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await seed(t, { compat: "lacking" });
    await store(t, chatId, { kind: "default" }, 5, false);
    const send = await sendOnce(t, owner, chatId);
    expect(send).toBeDefined();
    expect(send && "knowledgeChoice" in send).toBe(false);
  });

  // Codex P2: after a rollback to a bridge that cannot reset a session, a `default` turn
  // would run under the override an earlier choice left there.
  test("'default' with an override possibly left on a session (or unknown, a legacy row): withheld on such a bridge", async () => {
    for (const overrideEver of [true, "legacy"] as const) {
      const t = convexTest(schema, modules);
      const { owner, chatId } = await seed(t, { compat: "lacking" });
      await store(t, chatId, { kind: "default" }, 5, overrideEver);
      const send = await sendOnce(t, owner, chatId);
      expect(send).toBeUndefined();
      expect((await rowOf(t, chatId))?.apply).toMatchObject({ status: "failed", reason: "unsupported_gateway" });
    }
  });

  test("the flag: set by a non-default choice, kept by a later 'default', cleared only by a CONFIRMED reset", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await seed(t);
    const set = (choice: Record<string, unknown>) =>
      t.withIdentity({ subject: owner }).mutation(api.knowledge.setKnowledgeChoice, {
        chatId,
        instanceName: "alpha",
        agentId: "alice",
        choice: choice as never,
      });
    await set({ kind: "default" });
    expect((await rowOf(t, chatId))?.overrideEver).toBe(false);
    await set({ kind: "off" });
    await set({ kind: "default" });
    const row = await rowOf(t, chatId);
    expect(row?.overrideEver).toBe(true);
    // A failure or a deferral confirms nothing.
    await t.mutation(internal.knowledge.recordKnowledgeApply, {
      chatId, instanceName: "alpha", agentId: "alice", revision: row!.revision, status: "deferred",
    });
    expect((await rowOf(t, chatId))?.overrideEver).toBe(true);
    // An INERT default (the reset refused, overrides disabled): sent, but the override is
    // still stored — confirms nothing (codex pass 16), on the turn and the apply path.
    await t.mutation(internal.knowledge.recordKnowledgeTurn, {
      chatId, instanceName: "alpha", agentId: "alice", report: { status: "inert", revision: row!.revision },
    });
    expect(await rowOf(t, chatId)).toMatchObject({ overrideEver: true, apply: { status: "applied" } });
    await t.mutation(internal.knowledge.recordKnowledgeApply, {
      chatId, instanceName: "alpha", agentId: "alice", revision: row!.revision, status: "applied", inert: true,
    });
    expect((await rowOf(t, chatId))?.overrideEver).toBe(true);
    expect(await readKnowledgeApplyResponse(json(200, { ok: true, result: "inert" }))).toEqual({
      status: "applied",
      inert: true,
    });
    await t.mutation(internal.knowledge.recordKnowledgeTurn, {
      chatId, instanceName: "alpha", agentId: "alice", report: { status: "unchanged", revision: row!.revision },
    });
    expect((await rowOf(t, chatId))?.overrideEver).toBe(false);
  });

  test("an apply CLAMPED at once is stored as such, with its dropped ids (codex pass 19)", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await seed(t);
    await t.withIdentity({ subject: owner }).mutation(api.knowledge.setKnowledgeChoice, {
      chatId,
      instanceName: "alpha",
      agentId: "alice",
      choice: { kind: "sources", sources: ["graph", "docs"] },
    });
    const row = await rowOf(t, chatId);
    await t.mutation(internal.knowledge.recordKnowledgeApply, {
      chatId, instanceName: "alpha", agentId: "alice", revision: row!.revision, status: "clamped", dropped: ["graph"],
    });
    const after = await rowOf(t, chatId);
    expect(after?.apply).toMatchObject({ status: "clamped", dropped: ["graph"] });
    // The stored choice is unchanged: the revoked source comes back when re-authorized.
    expect(after?.choice).toEqual({ kind: "sources", sources: ["graph", "docs"] });
  });

  test("a CLAMPED turn is stored as such, with the dropped ids — ids only, bounded (codex pass 15)", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await seed(t);
    await t.withIdentity({ subject: owner }).mutation(api.knowledge.setKnowledgeChoice, {
      chatId,
      instanceName: "alpha",
      agentId: "alice",
      choice: { kind: "sources", sources: ["graph", "docs"] },
    });
    const row = await rowOf(t, chatId);
    const record = (report: Record<string, unknown>) =>
      t.mutation(internal.knowledge.recordKnowledgeTurn, {
        chatId, instanceName: "alpha", agentId: "alice", report: { revision: row!.revision, ...report },
      });
    await record({ status: "clamped", dropped: ["graph", "<script>", 7] });
    expect((await rowOf(t, chatId))?.apply).toMatchObject({ status: "clamped", dropped: ["graph"] });
    // Nothing valid dropped: not a clamp.
    await record({ status: "clamped", dropped: ["<x>"] });
    expect((await rowOf(t, chatId))?.apply.status).toBe("clamped");
    // The next applied turn clears it.
    await record({ status: "applied" });
    const after = (await rowOf(t, chatId))?.apply;
    expect(after?.status).toBe("applied");
    expect(after && "dropped" in after).toBe(false);
  });

  test("the /send answer is read once for both the cause and the outcome", async () => {
    expect(await readSendAnswer(json(502, { ok: false, error: { code: "x" }, knowledge: { status: "failed" } }))).toEqual({
      errorCode: "x",
      knowledge: { status: "failed" },
    });
    expect(await readSendAnswer(new Response("", { status: 200 }))).toEqual({});
  });
});

// Product rule (codex pass 8, Olivier's decision): a choice applies to turns dispatched
// AFTER it — a message past its last gate keeps the choice it was dispatched with.
describe("a choice applies to the turns dispatched after it", () => {
  test("a send already past its gate goes out under its own revision; the NEXT send carries the new choice", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await seed(t);
    await t.withIdentity({ subject: owner }).mutation(api.knowledge.setKnowledgeChoice, {
      chatId,
      instanceName: "alpha",
      agentId: "alice",
      choice: { kind: "sources", sources: ["docs"] },
    });
    const sends: Array<Record<string, unknown>> = [];
    let changedMidFlight = false;
    process.env.BRIDGE_URL = "http://bridge.test";
    process.env.BRIDGE_SHARED_SECRET = "s3cret";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      if (path === "/send") {
        sends.push(body);
        // The owner changes the choice while THIS message is on its way — it has
        // passed its last gate (the bridge is being asked to send it).
        if (!changedMidFlight) {
          changedMidFlight = true;
          await t.withIdentity({ subject: owner }).mutation(api.knowledge.setKnowledgeChoice, {
            chatId,
            instanceName: "alpha",
            agentId: "alice",
            choice: { kind: "off" },
          });
        }
      }
      return json(200, { ok: true, result: "applied" });
    });
    try {
      const { outboxId } = await t.withIdentity({ subject: owner }).mutation(api.send.sendMessage, {
        chatId,
        text: "premier",
        clientMessageId: "c-first",
      });
      await t.action(internal.bridge.dispatch, { outboxId });
      const { outboxId: second } = await t.withIdentity({ subject: owner }).mutation(api.send.sendMessage, {
        chatId,
        text: "second",
        clientMessageId: "c-second",
      });
      await t.action(internal.bridge.dispatch, { outboxId: second });
    } finally {
      vi.unstubAllGlobals();
      delete process.env.BRIDGE_URL;
      delete process.env.BRIDGE_SHARED_SECRET;
    }
    expect(changedMidFlight).toBe(true);
    expect(sends[0]).toMatchObject({ knowledgeChoice: { kind: "sources", sources: ["docs"] }, knowledgeRevision: 1 });
    expect(sends[sends.length - 1]).toMatchObject({ knowledgeChoice: { kind: "off" }, knowledgeRevision: 2 });
  });
});

describe("the agent default: administrators only, confirmed read-back stored", () => {
  const args = {
    instanceName: "alpha",
    agentId: "alice",
    injection: "hybrid" as const,
    sources: ["docs"],
    expected: { injection: "auto", defaultSources: ["graph", "docs"] },
  };

  test("a non-administrator is refused before the bridge is asked", async () => {
    const t = convexTest(schema, modules);
    const { owner } = await seed(t);
    const bridge = fakeBridge(() => json(200, { ok: true }));
    try {
      await expect(t.withIdentity({ subject: owner }).action(api.knowledge.setAgentKnowledgeDefault, args)).rejects.toThrow(
        /Forbidden/,
      );
      expect(bridge.calls).toEqual([]);
    } finally {
      bridge.restore();
    }
  });

  test("an administrator's write: the bridge's CONFIRMED answer is what is stored", async () => {
    const t = convexTest(schema, modules);
    const { owner } = await seed(t, { ownerRole: "admin" });
    const confirmed = { injection: "hybrid", defaultSources: ["docs"], overridesAllowed: true, configured: true, sources: SOURCES };
    const bridge = fakeBridge(() => json(200, { ok: true, knowledge: confirmed }));
    try {
      const out = await t.withIdentity({ subject: owner }).action(api.knowledge.setAgentKnowledgeDefault, args);
      expect(out).toEqual({ ok: true });
      expect(bridge.calls[0]).toMatchObject({ path: "/knowledge", body: { op: "default-set", ...args } });
      // The bridge's budget sits under this POST's own timeout (codex pass 6).
      expect(bridge.calls[0]?.body.budgetMs).toBe(KNOWLEDGE_DEFAULT_BRIDGE_BUDGET_MS);
      expect(KNOWLEDGE_DEFAULT_BRIDGE_BUDGET_MS).toBeLessThan(KNOWLEDGE_DEFAULT_POST_TIMEOUT_MS - 5_000);
      const row = await t.run((ctx) =>
        ctx.db
          .query("agentKnowledge")
          .withIndex("by_instance_agent", (q) => q.eq("instanceName", "alpha").eq("agentId", "alice"))
          .first(),
      );
      expect(row).toMatchObject({ injection: "hybrid", defaultSources: ["docs"] });
    } finally {
      bridge.restore();
    }
  });

  // Codex pass 3: the raw config view is the baseline of the next write.
  test("the raw config view: stored by discovery, sent back as `expected.config`, refreshed by the confirmed write", async () => {
    const t = convexTest(schema, modules);
    const { owner } = await seed(t, { ownerRole: "admin", facts: "none" });
    await t.mutation(internal.knowledge.recordKnowledgeDiscovery, {
      instanceName: "alpha",
      entries: {
        alice: {
          available: true,
          info: { injection: "auto", defaultSources: ["graph", "docs"], overridesAllowed: true, configured: true, sources: SOURCES },
          config: { injection: "auto", sources: ["graph", "docs", "disabled-x"] },
        },
      },
    });
    const listed = await adminAgents(t, owner);
    const alice = listed.agents.find((a) => a.agentId === "alice")!;
    expect(alice.config).toEqual({ injection: "auto", sources: ["graph", "docs", "disabled-x"] });
    const after = { injection: "hybrid", sources: ["docs"] };
    const bridge = fakeBridge(() =>
      json(200, {
        ok: true,
        knowledge: { injection: "hybrid", defaultSources: ["docs"], overridesAllowed: true, configured: true, sources: SOURCES },
        config: after,
      }),
    );
    try {
      await t.withIdentity({ subject: owner }).action(api.knowledge.setAgentKnowledgeDefault, {
        ...args,
        expected: { injection: "auto", defaultSources: ["graph", "docs"], config: alice.config! },
      });
      expect(bridge.calls[0]?.body).toMatchObject({ expected: { config: { sources: ["graph", "docs", "disabled-x"] } } });
    } finally {
      bridge.restore();
    }
    const row = await t.run((ctx) =>
      ctx.db.query("agentKnowledge").withIndex("by_instance_agent", (q) => q.eq("instanceName", "alpha").eq("agentId", "alice")).first(),
    );
    expect(row?.config).toEqual(after);
  });

  test("a scope refusal is remembered: the card then shows the default read-only, with the reason", async () => {
    const t = convexTest(schema, modules);
    const { owner } = await seed(t, { ownerRole: "admin" });
    const bridge = fakeBridge(() => json(403, { ok: false, error: { code: "scope_refused" } }));
    try {
      expect(await t.withIdentity({ subject: owner }).action(api.knowledge.setAgentKnowledgeDefault, args)).toEqual({
        ok: false,
        code: "scope_refused",
      });
      const listed = await adminAgents(t, owner);
      expect(listed.agents.find((a) => a.agentId === "alice")?.defaultWriteRefused).toBe("scope_refused");
      // Unchanged default: nothing was written.
      expect(listed.agents.find((a) => a.agentId === "alice")?.injection).toBe("auto");
    } finally {
      bridge.restore();
    }
  });
});

// Codex pass 6: a fork copies a bounded number of choices, so a conversation may hold
// no more than that — enforced at write time.
describe("a conversation's choices are bounded, and a fork carries every one", () => {
  const fill = (t: T, chatId: Id<"chats">, owner: Id<"users">, n: number, last?: Record<string, unknown>) =>
    t.run(async (ctx) => {
      for (let i = 0; i < n; i += 1) {
        const isLast = i === n - 1 && last !== undefined;
        await ctx.db.insert("chatKnowledgeChoices", {
          chatId,
          instanceName: "alpha",
          agentId: isLast ? "alice" : `agent-${i}`,
          choice: (isLast ? last : { kind: "default" }) as never,
          revision: 1,
          overrideEver: isLast,
          setBy: owner,
          setAt: 1,
          apply: { revision: 1, status: "applied", at: 1 },
        });
      }
    });

  test("at the cap, a choice for ANOTHER agent is refused; changing a held one is not", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await seed(t);
    await fill(t, chatId, owner, MAX_KNOWLEDGE_CHOICES_PER_CHAT, { kind: "sources", sources: ["docs"] });
    const set = (agentId: string) =>
      t.withIdentity({ subject: owner }).mutation(api.knowledge.setKnowledgeChoice, {
        chatId,
        instanceName: "alpha",
        agentId,
        choice: { kind: "off" },
      });
    await expect(set("files")).rejects.toThrow(/too_many_choices/);
    await set("alice");
    expect((await rowOf(t, chatId))?.choice).toEqual({ kind: "off" });
  });

  test("a fork of a conversation at the cap carries all of them — the last `off` included", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await seed(t);
    await fill(t, chatId, owner, MAX_KNOWLEDGE_CHOICES_PER_CHAT, { kind: "off" });
    const branchMessageId = await t.run((ctx) =>
      ctx.db.insert("messages", { chatId, userId: owner, role: "assistant", status: "complete", text: "x", updatedAt: 1 }),
    );
    const { chatId: forkId } = await t.withIdentity({ subject: owner }).mutation(api.chatFork.forkChat, { branchMessageId });
    const copied = await t.run((ctx) =>
      ctx.db.query("chatKnowledgeChoices").withIndex("by_chat_agent", (q) => q.eq("chatId", forkId)).collect(),
    );
    expect(copied).toHaveLength(MAX_KNOWLEDGE_CHOICES_PER_CHAT);
    expect(copied.find((c) => c.agentId === "alice")?.choice).toEqual({ kind: "off" });
  });
});

describe("cleanup", () => {
  test("deleting the conversation removes its choices", async () => {
    const t = convexTest(schema, modules);
    const { owner, chatId } = await seed(t);
    await t.withIdentity({ subject: owner }).mutation(api.knowledge.setKnowledgeChoice, {
      chatId,
      instanceName: "alpha",
      agentId: "alice",
      choice: { kind: "off" },
    });
    await t.withIdentity({ subject: owner }).mutation(api.chats.deleteChat, { chatId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run((ctx) => ctx.db.query("chatKnowledgeChoices").collect())).toEqual([]);
  });
});
