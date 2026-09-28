/**
 * WHICH KNOWLEDGE SOURCES AN AGENT SEARCHES (providers/openclaw/knowledge-policy.ts): the
 * owner's per-conversation choice put on every session before `chat.send`, applied now
 * on request, refused loudly — and the admin's agent default written through the
 * gateway's own validated `config.patch`, touching nothing but that agent's entry.
 *
 * Shapes below were CAPTURED LIVE on the 2026.9.6 bench with openclaw-knowledge 4.0.3
 * (2026-09-27): `knowledge.sources`, a `policy.set` answer, the `write_failed` refusal on
 * a key with no session, and a `sessions.describe` row carrying the override under
 * `pluginExtensions`.
 */

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  announceKnowledgeApply,
  withOneRePreparation,
  discoverAgents,
  knowledgeDiscoveryCursorKey,
  parseKnowledgeBody,
  parseSendBody,
  performKnowledgeApply,
  performSend,
  type SendReport,
} from "../src/server.js";
import { SessionRegistry } from "../src/session.js";
import type { BridgeConfig } from "../src/config.js";
import type { ConvexWriter } from "../src/convex-writer.js";
import {
  GatewayAnsweredError,
  OpenClawConnection,
} from "../src/providers/openclaw/openclaw-client.js";
import {
  KnowledgePolicyNotAppliedError,
  UnguardedConfigError,
  buildAgentDefaultPatch,
  classifyKnowledgeActionError,
  clearKnowledgeGuards,
  KNOWLEDGE_DEFAULT_BUDGET_MS,
  KNOWLEDGE_GUARD_IDLE_MS,
  KNOWLEDGE_GUARD_SOFT_CAP,
  KNOWLEDGE_PROBE_BUDGET_MS,
  KNOWLEDGE_PROBE_CONCURRENCY,
  knowledgeChatSendGate,
  knowledgeGuard,
  knowledgeGuardCount,
  noteAppliedKnowledgeRevision,
  noteKnowledgeRevision,
  withKnowledgeLock,
  desiredOverride,
  enforceKnowledgePolicy,
  overrideMatches,
  parseKnowledgeChoice,
  parseKnowledgeSources,
  performKnowledgeDefaultOp,
  probeKnowledgeForAgents,
  clearKnowledgeDiscoveryCursors,
  probeKnowledgeSources,
  readKnowledgeOverride,
  readKnowledgeBaseline,
  readSessionPolicy,
  writeKnowledgePolicy,
  concreteOverride,
  snapshotConfirms,
  pluginViewLags,
  rawAllowlistBound,
  KNOWLEDGE_ALLOWLIST_CAP,
  rawAgentDefault,
  type SessionPolicyRead,
  rawReflected,
  KNOWLEDGE_BASELINE_ATTEMPTS,
  type KnowledgeRouteBody,
} from "../src/providers/openclaw/knowledge-policy.js";
import { classifyGatewayError, faultDomain } from "../src/core/dispatch-errors.js";
import { COMPAT_MANIFEST } from "../src/compat.js";
import type { GatewayRequester } from "../src/conf.js";
import { fakeGateway } from "./helpers/fake-gateway.js";
import { servedMap } from "./helpers/served.js";
import { sleep } from "./helpers/sleep.js";

afterEach(() => {
  vi.restoreAllMocks();
  clearKnowledgeGuards();
});

const answered = (text: string) => new GatewayAnsweredError(text);

// --- Live-captured shapes (2026.9.6 + openclaw-knowledge 4.0.3) --------------------

const SOURCES_ALICE = {
  agentId: "alice",
  configured: true,
  injection: "auto",
  defaultSources: ["graph", "docs"],
  overridesAllowed: true,
  injectionTarget: "prependContext",
  sources: [
    { id: "graph", type: "lightrag", label: "Graphe de test", description: "Graphe LightRAG simulé (banc)", default: true },
    { id: "docs", type: "pgvector", label: "Documents de test", description: "Collection pgvector simulée (banc)", default: true },
    { id: "archive", type: "pgvector", label: "Archives de test", description: "Autre collection simulée", default: false },
  ],
};

const SET_ANSWER = {
  ok: true,
  result: {
    agentId: "alice",
    injection: "auto",
    sources: SOURCES_ALICE.sources,
    origin: { injection: "agent", sources: "session" },
    allowedSources: ["graph", "docs", "archive"],
    overridesAllowed: true,
    injectionTarget: "prependContext",
    session: { v: 1, sources: ["docs"], updatedAt: 1790561853009, updatedBy: "session-action" },
    effectiveSources: ["docs"],
  },
};

const WRITE_FAILED = { ok: false, error: "policy update failed", code: "write_failed" };

/** The plugin's answer to a policy write, shaped like the live ones (off: injection off,
 *  origin.injection session; sources: origin.sources session; reset: origin agent). */
function liveAnswer(params: Record<string, unknown>): Record<string, unknown> {
  if (params.actionId === "policy.reset") {
    return { ok: true, result: { injection: "auto", effectiveSources: ["graph", "docs"], origin: { injection: "agent", sources: "agent" } } };
  }
  const p = (params.payload ?? {}) as { injection?: string; sources?: string[] };
  return {
    ok: true,
    result: {
      injection: p.injection ?? "auto",
      effectiveSources: p.sources ?? ["graph", "docs"],
      origin: { injection: p.injection !== undefined ? "session" : "agent", sources: p.sources !== undefined ? "session" : "agent" },
    },
  };
}

/** The plugin's `policy.get` answer for a session holding `state` (openclaw-knowledge
 *  control-plane.ts readPolicySnapshot: the snapshot plus the session projection). */
function policyGetAnswer(
  state: Record<string, unknown> | null,
  overridesAllowed = true,
  /** The plugin's clamp to the allowlist, applied at read time (policy.ts filterAllowed). */
  effectiveSources?: string[],
): Record<string, unknown> {
  const s = (state ?? {}) as { injection?: string; sources?: string[]; oneShot?: unknown };
  const { oneShot, ...held } = s;
  return {
    ok: true,
    result: {
      agentId: "alice",
      injection: s.injection ?? "auto",
      effectiveSources: effectiveSources ?? s.sources ?? ["graph", "docs"],
      origin: { injection: s.injection ? "session" : "agent", sources: s.sources ? "session" : "agent" },
      overridesAllowed,
      // A pending one-shot as the plugin projects it (policy.ts:171).
      session: { v: 1, ...held, ...(oneShot ? { oneShot: ONE_SHOT } : {}) },
    },
  };
}

/** A one-shot another client put on the session (`/knowledge once graph`). */
const ONE_SHOT = { sources: ["graph"], setAt: 1790000000000, updatedBy: "command" };

const isPolicyGet = (method: string, params: Record<string, unknown>) =>
  method === "plugins.sessionAction" && params.actionId === "policy.get";

/** Answer every plugins.sessionAction like the live plugin, unless a test scripts it. */
function liveActions(
  gw: ReturnType<typeof fakeGateway>,
  scripted: boolean,
  policyGet: { throws?: Error; overridesAllowed?: boolean; effectiveSources?: string[] } = {},
): void {
  const base = gw.request.bind(gw);
  // What a landed write left on the session: every later describe shows it (the send
  // path re-reads the session right before chat.send — codex pass 7).
  let written: Record<string, unknown> | null | undefined = undefined;
  // What the session held as last described, for a `policy.get` before any write.
  let described: Record<string, unknown> | null = null;
  gw.request = async (method: string, params: Record<string, unknown>, timeoutMs?: number) => {
    if (isPolicyGet(method, params)) {
      gw.calls.push([method, params]);
      if (policyGet.throws) throw policyGet.throws;
      return {
        payload: policyGetAnswer(
          written !== undefined ? written : described,
          policyGet.overridesAllowed ?? true,
          policyGet.effectiveSources,
        ),
      };
    }
    if (method === "sessions.describe") {
      const out = await base(method, params, timeoutMs);
      const seen = readKnowledgeOverride((out.payload as { session?: Record<string, unknown> | null }).session);
      described = seen === undefined || seen === null ? null : (seen as Record<string, unknown>);
      if (written === undefined) return out;
      const sess = (out.payload as { session?: Record<string, unknown> | null }).session;
      return {
        payload: {
          session: {
            ...(sess ?? { sessionId: "s-1", systemSent: true }),
            pluginExtensions:
              written === null ? [] : [{ pluginId: "openclaw-knowledge", namespace: "policy", value: { v: 1, ...written } }],
          },
        },
      };
    }
    if (method !== "plugins.sessionAction") return base(method, params, timeoutMs);
    let payload: Record<string, unknown>;
    if (scripted) {
      payload = (await base(method, params, timeoutMs)).payload;
    } else {
      gw.calls.push([method, params]);
      payload = liveAnswer(params);
    }
    if (payload.ok === true) {
      written =
        params.actionId === "policy.reset"
          ? null
          : Object.fromEntries(Object.entries((params.payload ?? {}) as Record<string, unknown>).filter(([k]) => k !== "reset"));
    }
    return { payload };
  };
}

const describedWith = (value: Record<string, unknown> | null) => ({
  sessionId: "s-1",
  systemSent: true,
  ...(value === null
    ? {}
    : { pluginExtensions: [{ pluginId: "openclaw-knowledge", namespace: "policy", value }] }),
});

/** A requester double for the pure functions. */
function requester(answer: (method: string, params: Record<string, unknown>) => unknown) {
  const calls: [string, Record<string, unknown>][] = [];
  const conn: GatewayRequester = {
    async request(method, params) {
      calls.push([method, params]);
      const v = await answer(method, params);
      return { payload: v as Record<string, unknown> };
    },
  };
  return { conn, calls };
}

// --- Reads -------------------------------------------------------------------------

describe("knowledge.sources — what an agent may select", () => {
  it("the live answer parses to the allowlist, the default and the switches", () => {
    const info = parseKnowledgeSources(SOURCES_ALICE)!;
    expect(info.injection).toBe("auto");
    expect(info.defaultSources).toEqual(["graph", "docs"]);
    expect(info.overridesAllowed).toBe(true);
    expect(info.sources.map((s) => [s.id, s.label, s.default])).toEqual([
      ["graph", "Graphe de test", true],
      ["docs", "Documents de test", true],
      ["archive", "Archives de test", false],
    ]);
  });

  it("anything that is not that answer is no answer (never a guessed default)", () => {
    expect(parseKnowledgeSources(null)).toBeNull();
    expect(parseKnowledgeSources({ ...SOURCES_ALICE, injection: "always" })).toBeNull();
    expect(parseKnowledgeSources({ ...SOURCES_ALICE, sources: "graph" })).toBeNull();
    // Malformed entries are dropped, duplicates kept once, labels fall back to the id.
    const info = parseKnowledgeSources({
      ...SOURCES_ALICE,
      sources: [{ id: "" }, { id: "docs" }, { id: "docs", label: "x" }, 7],
    })!;
    expect(info.sources).toEqual([
      { id: "docs", type: "unknown", label: "docs", description: "", default: false },
    ]);
  });

  it("`unknown method` means the plugin is absent; a scope refusal and a lost answer are said as such", async () => {
    const absent = requester(() => {
      throw answered("INVALID_REQUEST: unknown method: knowledge.sources");
    });
    expect(await probeKnowledgeSources(absent.conn, "alice")).toEqual({
      available: false,
      reason: "plugin_absent",
      observedAt: expect.any(Number),
    });
    const scope = requester(() => {
      throw answered("FORBIDDEN: missing scope: operator.read");
    });
    expect(await probeKnowledgeSources(scope.conn, "alice")).toEqual({
      available: false,
      reason: "scope_refused",
    });
    const lost = requester(() => {
      throw new Error("knowledge.sources timed out");
    });
    expect(await probeKnowledgeSources(lost.conn, "alice")).toEqual({
      available: false,
      reason: "unreadable",
    });
  });

  it("discovery asks per agent and stops at the first `plugin_absent` (the plugin is gateway-wide)", async () => {
    const r = requester(() => {
      throw answered("INVALID_REQUEST: unknown method: knowledge.sources");
    });
    const out = await probeKnowledgeForAgents(r.conn, ["alice", "files", "bob"], { concurrency: 1 });
    expect(r.calls).toHaveLength(1);
    expect(Object.values(out).every((p) => !p.available && p.reason === "plugin_absent")).toBe(true);
    expect(Object.keys(out)).toEqual(["alice", "files", "bob"]);
    const present = requester(() => SOURCES_ALICE);
    const got = await probeKnowledgeForAgents(present.conn, ["Alice", "files"]);
    // The plugin keys agents in lower case: the id is normalized for the CALL only.
    expect(present.calls.map(([, p]) => p.agentId)).toEqual(["alice", "files"]);
    expect(got.Alice?.available).toBe(true);
  });
});

// --- The conversation's choice -------------------------------------------------------

describe("the owner's choice, as it travels", () => {
  it("parses strictly: carried but malformed is `invalid`, never 'nobody chose'", () => {
    expect(parseKnowledgeChoice(undefined)).toBeUndefined();
    expect(parseKnowledgeChoice({ kind: "default" })).toEqual({ kind: "default" });
    expect(parseKnowledgeChoice({ kind: "off" })).toEqual({ kind: "off" });
    expect(parseKnowledgeChoice({ kind: "sources", sources: ["docs", "docs"] })).toEqual({
      kind: "sources",
      sources: ["docs"],
    });
    expect(parseKnowledgeChoice({ kind: "sources", sources: ["docs"], injection: "hybrid" })).toEqual({
      kind: "sources",
      sources: ["docs"],
      injection: "hybrid",
    });
    // `sources` needs at least one id (contract §4.1): "everything off" is `off`.
    expect(parseKnowledgeChoice({ kind: "sources", sources: [] })).toBe("invalid");
    expect(parseKnowledgeChoice({ kind: "sources", sources: ["docs"], injection: "off" })).toBe("invalid");
    expect(parseKnowledgeChoice({ kind: "sources", sources: Array.from({ length: 17 }, (_, i) => `s${i}`) })).toBe(
      "invalid",
    );
    expect(parseKnowledgeChoice({ kind: "all" })).toBe("invalid");
    expect(parseKnowledgeChoice("default")).toBe("invalid");
  });

  it("a send body carrying a malformed choice is refused whole; a valid one is kept", () => {
    const raw = (extra: Record<string, unknown>) =>
      JSON.stringify({ chatId: "c1", text: "x", clientMessageId: "cm", agentId: "alice", canonical: "olivier", ...extra });
    expect(parseSendBody(raw({ knowledgeChoice: { kind: "off" }, knowledgeRevision: 3 }))).toMatchObject({
      knowledgeChoice: { kind: "off" },
      knowledgeRevision: 3,
    });
    expect(parseSendBody(raw({ knowledgeChoice: { kind: "sources", sources: [] } }))).toBeNull();
    const none = parseSendBody(raw({}))!;
    expect("knowledgeChoice" in none).toBe(false);
  });

  it("the override a described session holds, from the live row", () => {
    expect(readKnowledgeOverride(describedWith({ v: 1, sources: ["docs"], updatedAt: 1, updatedBy: "session-action" }))).toEqual({
      sources: ["docs"],
    });
    expect(readKnowledgeOverride(describedWith({ v: 1, injection: "off" }))).toEqual({ injection: "off" });
    // No entry for the plugin (the row omits `pluginExtensions` when empty) = none.
    expect(readKnowledgeOverride(describedWith(null))).toBeNull();
    expect(readKnowledgeOverride({ pluginExtensions: [{ pluginId: "other", namespace: "policy", value: {} }] })).toBeNull();
    // Unreadable is not "none".
    expect(readKnowledgeOverride({ pluginExtensions: "x" })).toBeUndefined();
    expect(readKnowledgeOverride(undefined)).toBeUndefined();
  });

  it("what each choice must leave on the session, and when it already does", () => {
    expect(desiredOverride({ kind: "default" })).toBeNull();
    expect(desiredOverride({ kind: "off" })).toEqual({ injection: "off" });
    expect(desiredOverride({ kind: "sources", sources: ["docs"] })).toEqual({ sources: ["docs"] });
    expect(overrideMatches({ sources: ["graph", "docs"] }, { sources: ["docs", "graph"] })).toBe(true);
    expect(overrideMatches({ sources: ["docs"], injection: "tool" }, { sources: ["docs"] })).toBe(false);
    expect(overrideMatches({ sources: ["docs"], lightragQueryMode: "mix" }, { sources: ["docs"] })).toBe(false);
    expect(overrideMatches(null, null)).toBe(true);
    expect(overrideMatches(null, { injection: "off" })).toBe(false);
  });
});

describe("enforceKnowledgePolicy — one session brought to the choice", () => {
  const base = { sessionKey: "agent:alice:k", agentId: "alice", sessionAbsent: false };

  it("already there: no write — only the agent default's mode is read (codex pass 13)", async () => {
    const r = requester(() => SET_ANSWER);
    const out = await enforceKnowledgePolicy({
      ...base,
      conn: r.conn,
      choice: { kind: "sources", sources: ["docs"] },
      stored: { sources: ["docs"] },
    });
    expect(out).toEqual({ desired: { sources: ["docs"] }, changed: false, snapshot: null });
    expect(r.calls).toEqual([["knowledge.sources", { agentId: "alice" }]]);
  });

  it("different: `policy.set` with `reset: true` so the session holds EXACTLY the choice", async () => {
    const r = requester(() => SET_ANSWER);
    const out = await enforceKnowledgePolicy({
      ...base,
      conn: r.conn,
      choice: { kind: "sources", sources: ["docs"] },
      stored: null,
    });
    expect(r.calls.filter(([m]) => m !== "knowledge.sources")).toEqual([
      [
        "plugins.sessionAction",
        {
          pluginId: "openclaw-knowledge",
          actionId: "policy.set",
          sessionKey: "agent:alice:k",
          agentId: "alice",
          payload: { reset: true, sources: ["docs"] },
        },
      ],
    ]);
    expect(out.changed).toBe(true);
    expect(out.snapshot).toEqual({
      injection: "auto",
      effectiveSources: ["docs"],
      origin: { injection: "agent", sources: "session" },
    });
  });

  // Codex pass 19: the agent's CURRENT allowlist, read before the write.
  it("a chosen id the allowlist no longer holds is left out of the write and reported dropped", async () => {
    const view = { ...SOURCES_ALICE, sources: SOURCES_ALICE.sources.filter((x) => x.id !== "graph") };
    const r = requester((method, params) => (method === "knowledge.sources" ? view : liveAnswer(params)));
    const out = await enforceKnowledgePolicy({ ...base, conn: r.conn, choice: { kind: "sources", sources: ["graph", "docs"] }, stored: null });
    expect(r.calls.find(([m]) => m === "plugins.sessionAction")?.[1].payload).toEqual({ reset: true, sources: ["docs"] });
    expect(out).toMatchObject({ desired: { sources: ["docs"] }, changed: true, dropped: ["graph"] });
    // An existing session holding the full choice is rewritten to the same.
    const again = requester((method, params) => (method === "knowledge.sources" ? view : liveAnswer(params)));
    const ex = await enforceKnowledgePolicy({ ...base, conn: again.conn, choice: { kind: "sources", sources: ["graph", "docs"] }, stored: { sources: ["graph", "docs"] } });
    expect(ex).toMatchObject({ changed: true, dropped: ["graph"] });
  });

  it("EVERY chosen id revoked: the existing-session rule — withheld when the agent default would search outside the choice, sent with nothing when it searches nothing", async () => {
    const onlyArchive = { ...SOURCES_ALICE, defaultSources: ["archive"], sources: SOURCES_ALICE.sources.filter((x) => x.id === "archive") };
    const r = requester((method, params) => (method === "knowledge.sources" ? onlyArchive : liveAnswer(params)));
    await expect(
      enforceKnowledgePolicy({ ...base, conn: r.conn, choice: { kind: "sources", sources: ["graph"] }, stored: null }),
    ).rejects.toMatchObject({ reason: "source_not_allowed" });
    expect(r.calls.map(([m]) => m)).not.toContain("plugins.sessionAction");
    const empty = { ...onlyArchive, defaultSources: [] };
    const e = requester((method, params) => (method === "knowledge.sources" ? empty : liveAnswer(params)));
    const out = await enforceKnowledgePolicy({ ...base, conn: e.conn, choice: { kind: "sources", sources: ["graph"] }, stored: null });
    expect(out).toMatchObject({ desired: null, changed: false, dropped: ["graph"] });
  });

  it("everything off is `injection: off`; back to the agent's default is `policy.reset` (no payload)", async () => {
    const r = requester((_m, params) => liveAnswer(params));
    await enforceKnowledgePolicy({ ...base, conn: r.conn, choice: { kind: "off" }, stored: { sources: ["docs"] } });
    await enforceKnowledgePolicy({ ...base, conn: r.conn, choice: { kind: "default" }, stored: { injection: "off" } });
    expect(r.calls.map(([, p]) => [p.actionId, p.payload])).toEqual([
      ["policy.set", { reset: true, injection: "off" }],
      ["policy.reset", undefined],
    ]);
  });

  it("an unknown stored state is written (unknown ≠ equal)", async () => {
    const r = requester(() => SET_ANSWER);
    await enforceKnowledgePolicy({ ...base, conn: r.conn, choice: { kind: "sources", sources: ["docs"] }, stored: undefined });
    expect(r.calls.filter(([m]) => m === "plugins.sessionAction")).toHaveLength(1);
  });

  it("no session yet: `default` needs nothing; a choice creates it on the given socket, then writes", async () => {
    const r = requester((method) => {
      if (method === "sessions.create") return { ok: true };
      // The live answer for a key with no session, then the write that lands.
      return r.calls.filter(([m]) => m === "plugins.sessionAction").length === 1 ? WRITE_FAILED : SET_ANSWER;
    });
    const none = await enforceKnowledgePolicy({
      ...base,
      conn: r.conn,
      sessionAbsent: true,
      choice: { kind: "default" },
      stored: null,
    });
    expect(none.changed).toBe(false);
    expect(r.calls).toEqual([]);
    let created = 0;
    const out = await enforceKnowledgePolicy({
      ...base,
      conn: r.conn,
      sessionAbsent: true,
      choice: { kind: "sources", sources: ["docs"] },
      stored: null,
      createSession: async () => {
        created += 1;
        return r.conn.request("sessions.create", { key: base.sessionKey, agentId: "alice" });
      },
    });
    expect(created).toBe(1);
    expect(r.calls.map(([m]) => m).filter((m) => m !== "knowledge.sources")).toEqual([
      "plugins.sessionAction",
      "sessions.create",
      "plugins.sessionAction",
    ]);
    expect(out.changed).toBe(true);
  });

  it("a session that exists and still refuses the write is a refusal, not a reason to create one", async () => {
    const r = requester(() => WRITE_FAILED);
    let created = 0;
    await expect(
      enforceKnowledgePolicy({
        ...base,
        conn: r.conn,
        choice: { kind: "off" },
        stored: null,
        createSession: async () => {
          created += 1;
        },
      }),
    ).rejects.toMatchObject({ reason: "write_failed" });
    expect(created).toBe(0);
  });

  it("the plugin's own refusals pass through by name; the transport's are classified", async () => {
    for (const code of ["overrides_disabled", "source_not_allowed", "unknown_source", "invalid_payload"]) {
      const r = requester(() => ({ ok: false, error: "x", code }));
      await expect(
        enforceKnowledgePolicy({ ...base, conn: r.conn, choice: { kind: "off" }, stored: null }),
      ).rejects.toMatchObject({ reason: code });
    }
    const odd = requester(() => ({ ok: false, error: "x", code: "brand_new" }));
    await expect(
      enforceKnowledgePolicy({ ...base, conn: odd.conn, choice: { kind: "off" }, stored: null }),
    ).rejects.toMatchObject({ reason: "rejected" });
    expect(classifyKnowledgeActionError(answered("UNAVAILABLE: unknown plugin session action: openclaw-knowledge/policy.set"))).toBe(
      "plugin_absent",
    );
    expect(classifyKnowledgeActionError(answered("FORBIDDEN: missing scope: operator.write"))).toBe("scope_refused");
    expect(
      classifyKnowledgeActionError(answered("INVALID_REQUEST: plugin session action payload does not match schema: x")),
    ).toBe("invalid_payload");
  });

  it("a write that got NO answer is rethrown as is: it may have landed", async () => {
    const lost = new Error("plugins.sessionAction timed out");
    const r = requester(() => {
      throw lost;
    });
    await expect(
      enforceKnowledgePolicy({ ...base, conn: r.conn, choice: { kind: "off" }, stored: null }),
    ).rejects.toBe(lost);
  });
});

describe("the refusal is a dispatch code of its own, raised by the bridge", () => {
  it("classified by type, local fault domain", () => {
    const err = new KnowledgePolicyNotAppliedError("overrides_disabled");
    expect(classifyGatewayError(err)).toBe("knowledge_policy_not_applied");
    expect(faultDomain("knowledge_policy_not_applied")).toBe("local");
  });
  it("the capability is declared from 2026.9.6 on OpenClaw, never on Hermes", () => {
    expect(COMPAT_MANIFEST.providers.openclaw!.capabilities.knowledgePolicy).toBe("2026.9.6");
    expect(COMPAT_MANIFEST.providers.hermes!.capabilities.knowledgePolicy).toBeUndefined();
  });
});

// --- performSend: before chat.send, every session -------------------------------------

const config = {
  openclawGatewayUrl: "ws://127.0.0.1:1",
  openclawToken: "t",
  deviceIdentity: { id: "i", publicKey: "p", privateKey: "k" },
  instanceName: "primary",
} as unknown as BridgeConfig;
const ROUTING = { chatId: "c1", openclawChatId: "oc1", agentId: "alice", canonical: "olivier", instanceName: "primary" };

function writerSpy() {
  const w = {
    startAssistant: async () => "msg-1",
    appendDelta: async () => {},
    setSnapshot: async () => true,
    addToolPart: async () => {},
    addMedia: async () => {},
    finalize: async () => {},
    reportSessionMeta: async () => {},
    reportSessionRoster: async () => {},
    recordGatewayPressure: async () => {},
    clearSessionState: async () => {},
    getRehydrationContext: async () => ({ history: null, turnCount: 0 }),
    emitRehydrateTrace: () => {},
  } as unknown as ConvexWriter;
  return w;
}

describe("performSend puts the owner's knowledge choice on the session before chat.send", () => {
  const run = async (opts: {
    extra: Record<string, unknown>;
    describe: Array<Record<string, unknown> | null>;
    absentAsNull?: boolean;
    action?: Array<{ payload?: Record<string, unknown>; throws?: Error }>;
    policyGet?: { throws?: Error; overridesAllowed?: boolean; effectiveSources?: string[] };
    /** What `knowledge.sources` answers for the agent (default: nothing readable). */
    agentView?: Record<string, unknown>;
  }) => {
    const gw = fakeGateway({
      describe: opts.describe as never,
      ...(opts.absentAsNull ? { describeAbsentAsNull: true } : {}),
      ...(opts.action ? { sequences: { "plugins.sessionAction": opts.action } } : {}),
      ...(opts.agentView ? { answers: { "knowledge.sources": { payload: opts.agentView } } } : {}),
    });
    liveActions(gw, opts.action !== undefined, opts.policyGet);
    (gw as unknown as { gatewayVersion: string }).gatewayVersion = "2026.9.6";
    gw.verboseFullApplied = true;
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => gw as never);
    const w = writerSpy();
    const reg = new SessionRegistry(servedMap(config, w), () => 1000);
    const session = await reg.acquire(ROUTING);
    await sleep(5);
    const report: SendReport = {};
    let error: unknown = null;
    await performSend(
      session,
      {
        ...ROUTING,
        text: "bonjour",
        clientMessageId: "cm-1",
        messageId: "um-1",
        providerResetCount: null,
        outboxId: "ob-1",
        dispatchAgeMs: 0,
        switchedFromAgentId: null,
        switchedFromInstanceName: null,
        sessionSettings: null,
        referenceAttachments: [],
        config: null,
        ...opts.extra,
      } as unknown as Parameters<typeof performSend>[1],
      w,
      null,
      null,
      null,
      Date.now(),
      config,
      undefined,
      report,
    ).catch((e) => {
      error = e;
    });
    await sleep(5);
    const methods = gw.calls.map(([m]) => m);
    // Writes only; the final `policy.get` read (codex pass 10) is reported apart.
    const isWrite = ([m, p]: [string, Record<string, unknown>]) =>
      m === "plugins.sessionAction" && p.actionId !== "policy.get";
    const actions = gw.calls.filter(isWrite).map(([, p]) => p);
    const reads = gw.calls.filter(([m, p]) => isPolicyGet(m, p)).map(([, p]) => p);
    return {
      methods,
      actions,
      reads,
      actionIndex: gw.calls.findIndex(isWrite),
      readIndex: gw.calls.findIndex(([m, p]) => isPolicyGet(m, p)),
      sendIndex: methods.indexOf("chat.send"),
      error,
      report,
    };
  };

  it("a different selection: written BEFORE the send, the outcome reported with its revision", async () => {
    const r = await run({
      extra: { knowledgeChoice: { kind: "sources", sources: ["docs"] }, knowledgeRevision: 4 },
      describe: [describedWith(null)],
    });
    expect(r.actions).toEqual([
      expect.objectContaining({ actionId: "policy.set", payload: { reset: true, sources: ["docs"] } }),
    ]);
    expect(r.actionIndex).toBeGreaterThanOrEqual(0);
    expect(r.actionIndex).toBeLessThan(r.sendIndex);
    expect(r.report.knowledge).toEqual({
      status: "applied",
      revision: 4,
      snapshot: { injection: "auto", effectiveSources: ["docs"], origin: { injection: "agent", sources: "session" } },
    });
  });

  it("the session already holds it (a per-turn return, a warm session): no RPC, the send as before", async () => {
    const r = await run({
      extra: { knowledgeChoice: { kind: "sources", sources: ["docs"] } },
      describe: [describedWith({ v: 1, sources: ["docs"] })],
    });
    expect(r.actions).toEqual([]);
    expect(r.sendIndex).toBeGreaterThanOrEqual(0);
    expect(r.report.knowledge?.status).toBe("unchanged");
    // The one read before the request is the PLUGIN's (codex pass 10): proof it still
    // processes the choice, in place of the describe it replaced.
    expect(r.reads).toEqual([
      { pluginId: "openclaw-knowledge", actionId: "policy.get", sessionKey: expect.any(String), agentId: "alice" },
    ]);
    expect(r.readIndex).toBe(r.sendIndex - 1);
  });

  // Codex pass 10: an override readable on the session proves nothing about the plugin
  // processing it. The last read is the plugin's own `policy.get`.
  const GONE = answered("UNAVAILABLE: unknown plugin session action: openclaw-knowledge/policy.get");

  it("the session still shows the choice but the plugin is gone: withheld (plugin_absent), never sent", async () => {
    const r = await run({
      extra: { knowledgeChoice: { kind: "sources", sources: ["docs"] }, knowledgeRevision: 5 },
      describe: [describedWith({ v: 1, sources: ["docs"] })],
      policyGet: { throws: GONE },
    });
    expect(r.actions).toEqual([]);
    expect(r.sendIndex).toBe(-1);
    expect((r.error as KnowledgePolicyNotAppliedError).reason).toBe("plugin_absent");
    expect(r.report.knowledge).toEqual({ status: "failed", reason: "plugin_absent", revision: 5 });
  });

  it("…a `default` choice needs nothing of the plugin: sent", async () => {
    const r = await run({
      extra: { knowledgeChoice: { kind: "default" } },
      describe: [describedWith(null)],
      policyGet: { throws: GONE },
    });
    expect(r.error).toBeNull();
    expect(r.sendIndex).toBeGreaterThanOrEqual(0);
  });

  it("the plugin there but overrides disabled since: the override is inert — withheld (overrides_disabled)", async () => {
    const r = await run({
      extra: { knowledgeChoice: { kind: "sources", sources: ["docs"] }, knowledgeRevision: 6 },
      describe: [describedWith({ v: 1, sources: ["docs"] })],
      policyGet: { overridesAllowed: false },
    });
    expect(r.sendIndex).toBe(-1);
    expect((r.error as KnowledgePolicyNotAppliedError).reason).toBe("overrides_disabled");
    const d = await run({
      extra: { knowledgeChoice: { kind: "default" } },
      describe: [describedWith(null)],
      policyGet: { overridesAllowed: false },
    });
    expect(d.sendIndex).toBeGreaterThanOrEqual(0);
  });

  it("an unreadable plugin answer (no answer) says nothing: the enforcement that just ran stands", async () => {
    const r = await run({
      extra: { knowledgeChoice: { kind: "sources", sources: ["docs"] } },
      describe: [describedWith({ v: 1, sources: ["docs"] })],
      policyGet: { throws: new Error("plugins.sessionAction timed out") },
    });
    expect(r.error).toBeNull();
    expect(r.sendIndex).toBeGreaterThanOrEqual(0);
  });

  it("'default' over an override left on the session: reset before the turn", async () => {
    const r = await run({
      extra: { knowledgeChoice: { kind: "default" } },
      describe: [describedWith({ v: 1, injection: "off" })],
    });
    expect(r.actions).toEqual([expect.objectContaining({ actionId: "policy.reset" })]);
    expect(r.actionIndex).toBeLessThan(r.sendIndex);
  });

  it("a fresh session (token mode: the verbose patch already made it): the choice lands before the first turn", async () => {
    const r = await run({
      extra: { knowledgeChoice: { kind: "off" } },
      describe: [null],
      absentAsNull: true,
    });
    expect(r.actions).toEqual([expect.objectContaining({ payload: { reset: true, injection: "off" } })]);
    expect(r.actionIndex).toBeLessThan(r.sendIndex);
  });

  it("a key the plugin cannot write yet: the session is created on the conversation's socket, then written, then sent", async () => {
    const r = await run({
      extra: { knowledgeChoice: { kind: "off" } },
      describe: [null],
      absentAsNull: true,
      action: [{ payload: WRITE_FAILED }, { payload: liveAnswer({ actionId: "policy.set", payload: { reset: true, injection: "off" } }) }],
    });
    const create = r.methods.indexOf("sessions.create");
    expect(create).toBeGreaterThan(r.actionIndex);
    expect(r.methods.lastIndexOf("plugins.sessionAction")).toBeGreaterThan(create);
    expect(r.methods.lastIndexOf("plugins.sessionAction")).toBeLessThan(r.sendIndex);
  });

  it("a refusal withholds the turn: no chat.send, named error, the reason reported", async () => {
    const r = await run({
      extra: { knowledgeChoice: { kind: "sources", sources: ["docs"] }, knowledgeRevision: 2 },
      describe: [describedWith(null)],
      action: [{ payload: { ok: false, error: "x", code: "overrides_disabled" } }],
    });
    expect(r.sendIndex).toBe(-1);
    expect(r.error).toBeInstanceOf(KnowledgePolicyNotAppliedError);
    expect(classifyGatewayError(r.error)).toBe("knowledge_policy_not_applied");
    expect(r.report.knowledge).toEqual({ status: "failed", reason: "overrides_disabled", revision: 2 });
  });

  // Decided 2026-09-28: back to the default is the owner's way out when the operator
  // disabled overrides. The plugin refuses the reset then, but ignores session state
  // (openclaw-knowledge policy.ts:422): satisfied, the turn goes under the default.
  it("'default' over a leftover override, the reset refused `overrides_disabled`: satisfied — the turn is sent", async () => {
    const r = await run({
      extra: { knowledgeChoice: { kind: "default" }, knowledgeRevision: 3 },
      describe: [describedWith({ v: 1, injection: "off" })],
      action: [{ payload: { ok: false, error: "x", code: "overrides_disabled" } }],
      policyGet: { overridesAllowed: false },
    });
    expect(r.actions).toEqual([expect.objectContaining({ actionId: "policy.reset" })]);
    expect(r.error).toBeNull();
    expect(r.sendIndex).toBeGreaterThanOrEqual(0);
    // Sent — but reported `inert`, never "no override left": the override is still stored
    // (codex pass 16), so Convex keeps `overrideEver`.
    expect(r.report.knowledge).toEqual({ status: "inert", revision: 3 });
  });

  it("…while a NON-default choice on that agent stays withheld (`overrides_disabled`)", async () => {
    const r = await run({
      extra: { knowledgeChoice: { kind: "off" }, knowledgeRevision: 4 },
      describe: [describedWith(null)],
      action: [{ payload: { ok: false, error: "x", code: "overrides_disabled" } }],
      policyGet: { overridesAllowed: false },
    });
    expect(r.sendIndex).toBe(-1);
    expect(r.report.knowledge).toEqual({ status: "failed", reason: "overrides_disabled", revision: 4 });
  });

  // Codex pass 11: a one-shot from another client takes priority over the session
  // override for the next turn — a session carrying one never holds the owner's choice.
  it("the session holds the choice AND a foreign one-shot: rewritten (reset:true clears it) before the send", async () => {
    const r = await run({
      extra: { knowledgeChoice: { kind: "sources", sources: ["docs"] }, knowledgeRevision: 7 },
      describe: [describedWith({ v: 1, sources: ["docs"], oneShot: ONE_SHOT })],
    });
    expect(r.actions).toEqual([
      expect.objectContaining({ actionId: "policy.set", payload: { reset: true, sources: ["docs"] } }),
    ]);
    expect(r.actionIndex).toBeLessThan(r.sendIndex);
    expect(r.error).toBeNull();
  });

  it("`default` with only a foreign one-shot pending: reset before the turn", async () => {
    const r = await run({
      extra: { knowledgeChoice: { kind: "default" } },
      describe: [describedWith({ v: 1, oneShot: ONE_SHOT })],
    });
    expect(r.actions).toEqual([expect.objectContaining({ actionId: "policy.reset" })]);
    expect(r.actionIndex).toBeLessThan(r.sendIndex);
  });

  it("…and with overrides disabled the one-shot is inert: the refused reset is satisfied, the turn sent", async () => {
    const r = await run({
      extra: { knowledgeChoice: { kind: "default" }, knowledgeRevision: 8 },
      describe: [describedWith({ v: 1, oneShot: ONE_SHOT })],
      action: [{ payload: { ok: false, error: "x", code: "overrides_disabled" } }],
      policyGet: { overridesAllowed: false },
    });
    expect(r.error).toBeNull();
    expect(r.sendIndex).toBeGreaterThanOrEqual(0);
  });

  // Codex pass 19: a FRESH write of a choice holding a revoked id behaves like an
  // existing session carrying it — the allowed ids written, the rest reported dropped.
  it("a revoked chosen source on a fresh session: only the allowed ids written, sent, reported `clamped`", async () => {
    const r = await run({
      extra: { knowledgeChoice: { kind: "sources", sources: ["graph", "docs"] }, knowledgeRevision: 11 },
      describe: [describedWith(null)],
      agentView: { ...SOURCES_ALICE, sources: SOURCES_ALICE.sources.filter((x) => x.id !== "graph") },
    });
    expect(r.actions).toEqual([
      expect.objectContaining({ actionId: "policy.set", payload: { reset: true, sources: ["docs"] } }),
    ]);
    expect(r.error).toBeNull();
    expect(r.sendIndex).toBeGreaterThanOrEqual(0);
    expect(r.report.knowledge).toMatchObject({ status: "clamped", dropped: ["graph"], revision: 11 });
  });

  // Codex pass 21: the last gate bounds what is searched by the ORIGINAL selection, on
  // every path — including those where the override written was clamped or left out.
  describe("the last gate keeps the ORIGINAL selection (codex pass 21)", () => {
    const noGraph = { ...SOURCES_ALICE, sources: SOURCES_ALICE.sources.filter((x) => x.id !== "graph") };

    it("every chosen id revoked, agent default empty: nothing written — sent while nothing is searched…", async () => {
      const r = await run({
        extra: { knowledgeChoice: { kind: "sources", sources: ["graph"] }, knowledgeRevision: 21 },
        describe: [describedWith(null)],
        agentView: { ...noGraph, defaultSources: [] },
        policyGet: { effectiveSources: [] },
      });
      expect(r.actions).toEqual([]);
      expect(r.sendIndex).toBeGreaterThanOrEqual(0);
      expect(r.report.knowledge).toMatchObject({ status: "clamped", dropped: ["graph"], revision: 21 });
    });

    it("…and WITHHELD when the default gained a source between the apply and the send", async () => {
      const r = await run({
        extra: { knowledgeChoice: { kind: "sources", sources: ["graph"] }, knowledgeRevision: 22 },
        describe: [describedWith(null)],
        agentView: { ...noGraph, defaultSources: [] },
        policyGet: { effectiveSources: ["archive"] },
      });
      expect(r.sendIndex).toBe(-1);
      expect(r.report.knowledge).toEqual({ status: "failed", reason: "source_not_allowed", revision: 22 });
    });

    it("the clamped path: the allowed ids written; a source outside the selection at the send is withheld", async () => {
      const ok = await run({
        extra: { knowledgeChoice: { kind: "sources", sources: ["graph", "docs"] }, knowledgeRevision: 23 },
        describe: [describedWith(null)],
        agentView: noGraph,
        policyGet: { effectiveSources: ["docs"] },
      });
      expect(ok.sendIndex).toBeGreaterThanOrEqual(0);
      // Reported against the ORIGINAL selection: graph was not searched.
      expect(ok.report.knowledge).toMatchObject({ status: "clamped", dropped: ["graph"], revision: 23 });
      const raced = await run({
        extra: { knowledgeChoice: { kind: "sources", sources: ["graph", "docs"] }, knowledgeRevision: 24 },
        describe: [describedWith(null)],
        agentView: noGraph,
        // docs revoked too meanwhile: the plugin falls back to a default that gained archive.
        policyGet: { effectiveSources: ["archive"] },
      });
      expect(raced.sendIndex).toBe(-1);
      expect(raced.report.knowledge).toEqual({ status: "failed", reason: "source_not_allowed", revision: 24 });
    });

    it("a turn running under a NEWER confirmed choice is bounded by THAT choice's selection", async () => {
      const g = knowledgeGuard("i", "k-newer-selection");
      noteKnowledgeRevision(g, 2);
      // Revision 2 was every-id-revoked: nothing written (override null), selection [graph].
      noteAppliedKnowledgeRevision(g, 2, null, ["graph"]);
      const gate = knowledgeChatSendGate(g, 1, () => {}, {
        desired: { injection: "off" },
        selection: null,
        read: async (): Promise<SessionPolicyRead> => ({
          kind: "held", override: null, overridesAllowed: true, injection: "auto", effectiveSources: ["archive"],
        }),
      });
      await gate.refresh?.();
      expect(() => gate.check()).toThrow(expect.objectContaining({ reason: "source_not_allowed" }));
    });
  });

  // Codex pass 15: the operator's clamp is legitimate — the turn goes, reported.
  it("a chosen source taken out of the allowlist since: sent, reported `clamped` with the dropped ids", async () => {
    const r = await run({
      extra: { knowledgeChoice: { kind: "sources", sources: ["graph", "docs"] }, knowledgeRevision: 9 },
      describe: [describedWith({ v: 1, sources: ["graph", "docs"] })],
      policyGet: { effectiveSources: ["docs"] },
    });
    expect(r.error).toBeNull();
    expect(r.sendIndex).toBeGreaterThanOrEqual(0);
    expect(r.report.knowledge).toEqual({ status: "clamped", dropped: ["graph"], revision: 9 });
  });

  it("clamped to NOTHING, the plugin falls back to the agent default's sources: withheld, never searched", async () => {
    const r = await run({
      extra: { knowledgeChoice: { kind: "sources", sources: ["archive"] }, knowledgeRevision: 10 },
      describe: [describedWith({ v: 1, sources: ["archive"] })],
      policyGet: { effectiveSources: ["graph", "docs"] },
    });
    expect(r.sendIndex).toBe(-1);
    expect(r.report.knowledge).toEqual({ status: "failed", reason: "source_not_allowed", revision: 10 });
  });

  it("the plugin removed from the gateway: the turn is withheld, said as `plugin_absent`", async () => {
    const r = await run({
      extra: { knowledgeChoice: { kind: "off" } },
      describe: [describedWith(null)],
      action: [{ throws: answered("UNAVAILABLE: unknown plugin session action: openclaw-knowledge/policy.set") }],
    });
    expect(r.sendIndex).toBe(-1);
    expect((r.error as KnowledgePolicyNotAppliedError).reason).toBe("plugin_absent");
  });

  it("no choice: no knowledge RPC at all, the send exactly as before", async () => {
    const r = await run({ extra: {}, describe: [describedWith({ v: 1, injection: "off" })] });
    expect(r.actions).toEqual([]);
    expect(r.sendIndex).toBeGreaterThanOrEqual(0);
    expect(r.report.knowledge).toBeUndefined();
  });
});

// --- /knowledge apply ------------------------------------------------------------------

describe("/knowledge applies the choice NOW, or says why not", () => {
  const change = async (opts: {
    describe: Array<Record<string, unknown> | null>;
    absentAsNull?: boolean;
    action?: Array<{ payload?: Record<string, unknown>; throws?: Error }>;
    choice: Record<string, unknown>;
    agentView?: Record<string, unknown>;
  }) => {
    const gw = fakeGateway({
      describe: opts.describe as never,
      ...(opts.absentAsNull ? { describeAbsentAsNull: true } : {}),
      ...(opts.action ? { sequences: { "plugins.sessionAction": opts.action } } : {}),
      ...(opts.agentView ? { answers: { "knowledge.sources": { payload: opts.agentView } } } : {}),
    });
    liveActions(gw, opts.action !== undefined);
    (gw as unknown as { gatewayVersion: string }).gatewayVersion = "2026.9.6";
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => gw as never);
    const w = writerSpy();
    const reg = new SessionRegistry(servedMap(config, w), () => 1000);
    const session = await reg.acquire(ROUTING);
    await sleep(5);
    const body = parseKnowledgeBody(JSON.stringify({ ...ROUTING, op: "apply", choice: opts.choice, revision: 1 }));
    expect(body?.op).toBe("apply");
    const outcome = await performKnowledgeApply(session, body as never, config);
    return { outcome, methods: gw.calls.map(([m]) => m) };
  };

  it("an existing session: written, the plugin's snapshot returned", async () => {
    const r = await change({ describe: [describedWith(null)], choice: { kind: "sources", sources: ["docs"] } });
    expect(r.outcome).toEqual({
      ok: true,
      result: "applied",
      snapshot: { injection: "auto", effectiveSources: ["docs"], origin: { injection: "agent", sources: "session" } },
    });
  });

  it("back to the default while the operator disabled overrides: the refused reset is satisfied", async () => {
    const r = await change({
      describe: [describedWith({ v: 1, sources: ["docs"] })],
      action: [{ payload: { ok: false, error: "x", code: "overrides_disabled" } }],
      choice: { kind: "default" },
    });
    expect(r.outcome).toEqual({ ok: true, result: "inert" });
    // …a non-default one is still refused by name.
    const n = await change({
      describe: [describedWith(null)],
      action: [{ payload: { ok: false, error: "x", code: "overrides_disabled" } }],
      choice: { kind: "off" },
    });
    expect(n.outcome).toEqual({ ok: false, reason: "overrides_disabled" });
  });

  it("a revoked chosen source: applied now minus it, reported `clamped` with the dropped ids (codex pass 19)", async () => {
    const r = await change({
      describe: [describedWith(null)],
      choice: { kind: "sources", sources: ["graph", "docs"] },
      agentView: { ...SOURCES_ALICE, sources: SOURCES_ALICE.sources.filter((x) => x.id !== "graph") },
    });
    expect(r.outcome).toMatchObject({ ok: true, result: "clamped", dropped: ["graph"] });
  });

  it("no session yet: deferred to the first turn, nothing created here", async () => {
    const r = await change({ describe: [null], absentAsNull: true, choice: { kind: "off" } });
    expect(r.outcome).toEqual({ ok: true, result: "deferred" });
    expect(r.methods).not.toContain("plugins.sessionAction");
    expect(r.methods).not.toContain("sessions.create");
  });

  it("already there: unchanged, no write", async () => {
    const r = await change({ describe: [describedWith({ v: 1, injection: "off" })], choice: { kind: "off" } });
    expect(r.outcome).toEqual({ ok: true, result: "unchanged" });
    expect(r.methods).not.toContain("plugins.sessionAction");
  });

  it("a refusal is returned, not swallowed", async () => {
    const r = await change({
      describe: [describedWith(null)],
      choice: { kind: "sources", sources: ["archive"] },
      action: [{ payload: { ok: false, error: "x", code: "source_not_allowed" } }],
    });
    expect(r.outcome).toEqual({ ok: false, reason: "source_not_allowed" });
  });

  it("the body: an apply needs a valid choice and routing; the admin ops need a safe agent id", () => {
    const k = (o: Record<string, unknown>) => parseKnowledgeBody(JSON.stringify(o));
    expect(k({ ...ROUTING, op: "apply", choice: { kind: "sources", sources: [] } })).toBeNull();
    expect(k({ ...ROUTING, op: "apply" })).toBeNull();
    expect(k({ op: "default-get", agentId: "Alice", instanceName: "primary" })).toEqual({
      op: "default-get",
      agentId: "alice",
      instanceName: "primary",
    });
    // An id that could address another config path never reaches the patch.
    expect(k({ op: "default-get", agentId: "a.b", instanceName: "primary" })).toBeNull();
    expect(k({ op: "default-get", agentId: "__proto__", instanceName: "primary" })).toBeNull();
    expect(k({ op: "default-set", agentId: "alice", instanceName: "p", injection: "auto", sources: [] })).toBeNull();
    expect(k({ op: "default-set", agentId: "alice", instanceName: "p", injection: "always", sources: ["docs"] })).toBeNull();
  });
});

// --- The agent default (config.patch) -------------------------------------------------

describe("the agent default: the gateway's own validated write, that agent's entry only", () => {
  // A contract-2 plugin (openclaw-knowledge 4.1.0): the default is writable whatever the
  // agent's allowlist (codex pass 18). The 4.0.x branch has its own tests below.
  const SOURCES_V2 = { ...SOURCES_ALICE, contract: 2 };
  /** The 4.0.x plugin's view after our write (no contract field). */
  const AFTER_V1 = { ...SOURCES_ALICE, injection: "hybrid", defaultSources: ["docs"] };
  const CONFIG_GET = (agentEntry: Record<string, unknown> | null) => ({
    hash: "h-1",
    exists: true,
    config: {
      plugins: {
        entries: {
          "openclaw-knowledge": {
            config: {
              apiKey: "__OPENCLAW_REDACTED__",
              // What the live-captured plugin view (SOURCES_ALICE) resolves from: an
              // agent without its own keys inherits these (codex pass 20 compares them).
              defaults: { sources: ["graph", "docs"] },
              agents: agentEntry === null ? {} : { alice: agentEntry },
            },
          },
        },
      },
    },
  });

  const setBody = (over: Partial<Extract<KnowledgeRouteBody, { op: "default-set" }>> = {}) =>
    ({
      op: "default-set",
      instanceName: "primary",
      agentId: "alice",
      injection: "hybrid",
      sources: ["docs"],
      expected: { injection: "auto", defaultSources: ["graph", "docs"] },
      ...over,
    }) as KnowledgeRouteBody;

  const gatewayFor = (opts: {
    entry: Record<string, unknown> | null;
    patch?: (params: Record<string, unknown>) => unknown;
    after?: Record<string, unknown>;
    /** The entry the config reads carry once written (default: the patch merged over
     *  `entry`, like the gateway's merge patch). */
    afterEntry?: Record<string, unknown> | null;
    /** What the plugin shows BEFORE the write (default: SOURCES_V2). */
    before?: Record<string, unknown>;
  }) => {
    let written = false;
    let patched: Record<string, unknown> | null = null;
    return requester((method, params) => {
      if (method === "knowledge.sources") {
        return written ? (opts.after ?? SOURCES_V2) : (opts.before ?? SOURCES_V2);
      }
      if (method === "config.get") {
        if (!written) return CONFIG_GET(opts.entry);
        return { ...CONFIG_GET(opts.afterEntry !== undefined ? opts.afterEntry : patched), hash: "h-2" };
      }
      if (method === "config.patch") {
        const out = opts.patch?.(params) ?? { ok: true };
        written = true;
        const own = JSON.parse(params.raw as string).plugins.entries["openclaw-knowledge"].config.agents.alice;
        patched = { ...(opts.entry ?? {}), ...own };
        return out;
      }
      return {};
    });
  };

  const AFTER = { ...SOURCES_V2, injection: "hybrid", defaultSources: ["docs"] };

  it("the patch names ONLY that agent's entry, guarded by the base hash, with the array path confirmed", async () => {
    const g = gatewayFor({
      entry: { injection: "auto", sources: ["graph", "docs"], allowedSources: ["graph", "docs", "archive"] },
      after: AFTER,
      afterEntry: { injection: "hybrid", sources: ["docs"], allowedSources: ["graph", "docs", "archive"] },
    });
    const out = await performKnowledgeDefaultOp(g.conn, setBody());
    expect(out.status).toBe(200);
    const patch = g.calls.find(([m]) => m === "config.patch")![1];
    expect(patch.baseHash).toBe("h-1");
    expect(JSON.parse(patch.raw as string)).toEqual({
      plugins: { entries: { "openclaw-knowledge": { config: { agents: { alice: { injection: "hybrid", sources: ["docs"] } } } } } },
    });
    expect(patch.replacePaths).toEqual(["plugins.entries.openclaw-knowledge.config.agents.alice.sources"]);
    // The confirmed read-back, never the request echoed — with the raw config values
    // the next write will be checked against.
    expect(out.body).toEqual({
      ok: true,
      knowledge: parseKnowledgeSources(AFTER),
      config: { injection: "hybrid", sources: ["docs"] },
      // The agent's own allowlist, from the same config snapshot (codex pass 18).
      ownAllowlist: true,
      observedAt: expect.any(Number),
    });
  });

  // Codex pass 18 (Olivier's design): the allowlist is the operator's — never written.
  it("the patch is `injection` + `sources`, never `allowedSources`", () => {
    const patch = buildAgentDefaultPatch({ agentId: "alice", injection: "auto", sources: ["docs"] });
    expect(JSON.parse(patch.raw)).toEqual({
      plugins: { entries: { "openclaw-knowledge": { config: { agents: { alice: { injection: "auto", sources: ["docs"] } } } } } },
    });
  });

  it("a default changed since the admin looked is refused, with what it is now — nothing written", async () => {
    const g = gatewayFor({ entry: null });
    const out = await performKnowledgeDefaultOp(g.conn, setBody({ expected: { injection: "tool", defaultSources: ["docs"] } }));
    expect(out.status).toBe(409);
    expect(out.body.error).toEqual({ code: "stale_default" });
    expect(g.calls.map(([m]) => m)).toEqual(["config.get", "knowledge.sources"]);
  });

  it("a source outside the plugin's allowlist is refused before any write", async () => {
    const g = gatewayFor({ entry: null });
    const out = await performKnowledgeDefaultOp(g.conn, setBody({ sources: ["invented"] }));
    expect(out).toEqual({ status: 409, body: { ok: false, error: { code: "source_not_allowed" } } });
    expect(g.calls.map(([m]) => m)).not.toContain("config.patch");
  });

  it("a socket without admin: `scope_refused`, said as such", async () => {
    const g = gatewayFor({
      entry: null,
      patch: () => {
        throw answered("FORBIDDEN: missing scope: operator.admin");
      },
    });
    const out = await performKnowledgeDefaultOp(g.conn, setBody());
    expect(out).toEqual({ status: 403, body: { ok: false, error: { code: "scope_refused" } } });
  });

  it("a concurrent edit: one retry on a fresh hash, then a clear conflict", async () => {
    let patches = 0;
    const g = gatewayFor({
      entry: null,
      after: AFTER,
      patch: () => {
        patches += 1;
        if (patches === 1) throw answered("INVALID_REQUEST: config changed since last load; re-run config.get and retry with baseHash");
        return { ok: true };
      },
    });
    expect((await performKnowledgeDefaultOp(g.conn, setBody())).status).toBe(200);
    expect(patches).toBe(2);
    const always = gatewayFor({
      entry: null,
      patch: () => {
        throw answered("INVALID_REQUEST: config changed since last load; re-run config.get and retry with baseHash");
      },
    });
    expect((await performKnowledgeDefaultOp(always.conn, setBody())).body.error).toEqual({ code: "base_hash_conflict" });
  });

  // Codex P2: the retry after a hash conflict re-reads and re-verifies everything.
  const conflictThen = (secondProbe: Record<string, unknown>, secondEntry: Record<string, unknown> | null = null) => {
    let patches = 0;
    let probes = 0;
    const r = requester((method) => {
      if (method === "knowledge.sources") {
        probes += 1;
        return probes === 1 ? SOURCES_V2 : secondProbe;
      }
      if (method === "config.get") return CONFIG_GET(patches === 0 ? null : secondEntry);
      if (method === "config.patch") {
        patches += 1;
        if (patches === 1) throw answered("INVALID_REQUEST: config changed since last load; re-run config.get and retry with baseHash");
        return { ok: true };
      }
      return {};
    });
    return { ...r, patches: () => patches };
  };

  it("a retry after a conflict: another operator changed the default meanwhile — refused, never overwritten", async () => {
    // The config and the plugin agree on the other operator's value (no reload lag).
    const g = conflictThen({ ...SOURCES_V2, injection: "tool" }, { injection: "tool" });
    const out = await performKnowledgeDefaultOp(g.conn, setBody());
    expect(out.body.error).toEqual({ code: "stale_default" });
    expect(g.patches()).toBe(1);
  });

  it("a retry after a conflict: the requested source left the allowlist meanwhile — refused", async () => {
    const g = conflictThen(
      { ...SOURCES_V2, defaultSources: ["graph"], sources: SOURCES_V2.sources.filter((x) => x.id !== "docs") },
      { allowedSources: ["graph", "archive"] },
    );
    const out = await performKnowledgeDefaultOp(g.conn, setBody({ expected: null }));
    expect(out.body.error).toEqual({ code: "source_not_allowed" });
    expect(g.patches()).toBe(1);
  });

  it("the hash's own snapshot binds the check: an entry stating another default, or an allowlist without the source, refuses the write even while the plugin still answers the old values", async () => {
    for (const entry of [
      { injection: "tool", sources: ["graph", "docs"] },
      { injection: "auto", sources: ["graph"] },
    ]) {
      const stale = gatewayFor({ entry });
      const out = await performKnowledgeDefaultOp(stale.conn, setBody());
      // The plugin still answers the OLD values under the new hash: nothing is compared
      // with that lagging view (codex pass 20) — refused by name, before any write.
      expect(out.body.error).toEqual({ code: "plugin_config_lag" });
      expect(stale.calls.map(([m]) => m)).not.toContain("config.patch");
    }
    const narrowed = gatewayFor({ entry: { allowedSources: ["graph"] } });
    expect((await performKnowledgeDefaultOp(narrowed.conn, setBody({ expected: null }))).body.error).toEqual({
      code: "plugin_config_lag",
    });
    expect(narrowed.calls.map(([m]) => m)).not.toContain("config.patch");
  });

  // Codex pass 3: an edit adding a source the plugin filters out (disabled) must not read
  // as "unchanged" — the comparison is on the config as WRITTEN, unfiltered.
  it("the config as written decides 'changed': an added (disabled) id is a change, raw view or not", async () => {
    const edited = { injection: "auto", sources: ["graph", "docs", "disabled-x"] };
    const withView = gatewayFor({ entry: edited });
    const out = await performKnowledgeDefaultOp(
      withView.conn,
      setBody({ expected: { injection: "auto", defaultSources: ["graph", "docs"], config: { injection: "auto", sources: ["graph", "docs"] } } }),
    );
    expect(out.body.error).toEqual({ code: "stale_default" });
    expect(out.body.config).toEqual(edited);
    expect(withView.calls.map(([m]) => m)).not.toContain("config.patch");
    const noView = gatewayFor({ entry: edited });
    expect((await performKnowledgeDefaultOp(noView.conn, setBody())).body.error).toEqual({ code: "stale_default" });
    expect(noView.calls.map(([m]) => m)).not.toContain("config.patch");
  });

  it("…and the view the admin saw, disabled id included, is not a change: the write goes through", async () => {
    const edited = { injection: "auto", sources: ["graph", "docs", "disabled-x"] };
    const g = gatewayFor({ entry: edited, after: { ...SOURCES_V2, injection: "hybrid", defaultSources: ["docs"] } });
    const out = await performKnowledgeDefaultOp(
      g.conn,
      setBody({ expected: { injection: "auto", defaultSources: ["graph", "docs"], config: edited } }),
    );
    expect(out.status).toBe(200);
    expect(g.calls.map(([m]) => m)).toContain("config.patch");
  });

  // Codex pass 4: the raw config is compared AS WRITTEN — order included.
  it("a reorder by another operator is a change (raw view, and the fallback without it)", async () => {
    const reordered = { injection: "auto", sources: ["docs", "graph"] };
    // The plugin shows the reorder too (it follows the config's order): no reload lag.
    const shown = { ...SOURCES_V2, defaultSources: ["docs", "graph"] };
    const withView = gatewayFor({ entry: reordered, before: shown });
    const out = await performKnowledgeDefaultOp(
      withView.conn,
      setBody({ expected: { injection: "auto", defaultSources: ["graph", "docs"], config: { injection: "auto", sources: ["graph", "docs"] } } }),
    );
    expect(out.body.error).toEqual({ code: "stale_default" });
    expect(withView.calls.map(([m]) => m)).not.toContain("config.patch");
    const noView = gatewayFor({ entry: reordered, before: shown });
    expect((await performKnowledgeDefaultOp(noView.conn, setBody())).body.error).toEqual({ code: "stale_default" });
  });

  it("…while the plugin's EFFECTIVE view is compared for content only (its order is the config's, checked above)", async () => {
    const g = gatewayFor({
      entry: { injection: "auto", sources: ["graph", "docs"] },
      after: { ...SOURCES_V2, injection: "hybrid", defaultSources: ["docs"] },
    });
    const out = await performKnowledgeDefaultOp(
      g.conn,
      setBody({ expected: { injection: "auto", defaultSources: ["docs", "graph"], config: { injection: "auto", sources: ["graph", "docs"] } } }),
    );
    expect(out.status).toBe(200);
  });

  // Codex pass 4: the read-back is stamped on the bridge's clock, after the write.
  it("a confirmed write is stamped with its read-back's send time — after the write, on the bridge clock", async () => {
    let patchedAt = 0;
    const g = gatewayFor({
      entry: null,
      after: { ...SOURCES_V2, injection: "hybrid", defaultSources: ["docs"] },
      patch: () => {
        patchedAt = Date.now();
        return { ok: true };
      },
    });
    const out = await performKnowledgeDefaultOp(g.conn, setBody());
    expect(out.status).toBe(200);
    expect(out.body.observedAt as number).toBeGreaterThanOrEqual(patchedAt);
  });

  it("the raw view travels in the body strictly", () => {
    const k = (config: unknown) =>
      parseKnowledgeBody(
        JSON.stringify({ op: "default-set", instanceName: "p", agentId: "alice", injection: "auto", sources: ["docs"], expected: { injection: "auto", defaultSources: ["docs"], config } }),
      );
    expect(k({ injection: null, sources: null })).toMatchObject({ expected: { config: { injection: null, sources: null } } });
    expect(k({ injection: "auto", sources: [1] })).toBeNull();
  });

  // Codex pass 6: one deadline, under the caller's, for the whole procedure.
  describe("the whole write lives within one deadline below the caller's", () => {
    it("every request is capped by what remains", async () => {
      const timeouts: number[] = [];
      const g = requester((method) => {
        if (method === "knowledge.sources") return { ...SOURCES_V2, injection: "hybrid", defaultSources: ["docs"] };
        if (method === "config.get") return CONFIG_GET({ injection: "hybrid", sources: ["docs"] });
        return { ok: true };
      });
      const recording: GatewayRequester = {
        request: (m, p, t) => {
          timeouts.push(t ?? -1);
          return g.conn.request(m, p, t);
        },
      };
      await performKnowledgeDefaultOp(recording, setBody({ expected: null }), { deadline: Date.now() + 3_000 });
      expect(timeouts.length).toBeGreaterThan(2);
      expect(Math.max(...timeouts)).toBeLessThanOrEqual(3_000);
    });

    it("a lost answer and a gateway that never comes back: `write_unknown` AT the deadline, never after", async () => {
      vi.useFakeTimers();
      try {
        // The patch's answer is lost like a real transport loses it: its own timeout
        // (15 s) fires; the fresh read-back then never gets an answer either.
        const g = gatewayFor({
          entry: null,
          patch: () => new Promise((_, reject) => setTimeout(() => reject(new Error("config.patch timed out")), 15_000)),
        });
        let done = false;
        const out = performKnowledgeDefaultOp(g.conn, setBody(), {
          deadline: Date.now() + 40_000,
          readFresh: () => new Promise(() => {}),
        }).then((o) => {
          done = true;
          return o;
        });
        await vi.advanceTimersByTimeAsync(39_000);
        expect(done).toBe(false);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(done).toBe(true);
        expect((await out).body.error).toEqual({ code: "write_unknown" });
      } finally {
        vi.useRealTimers();
      }
    });

    it("out of time before the patch left: `deadline_before_write` — nothing was sent", async () => {
      vi.useFakeTimers();
      try {
        const g = requester((method) =>
          method === "config.get" ? new Promise(() => {}) : method === "knowledge.sources" ? SOURCES_V2 : { ok: true },
        );
        const out = performKnowledgeDefaultOp(g.conn, setBody(), { deadline: Date.now() + 5_000 });
        await vi.advanceTimersByTimeAsync(6_000);
        expect((await out).body.error).toEqual({ code: "deadline_before_write" });
        expect(g.calls.map(([m]) => m)).not.toContain("config.patch");
      } finally {
        vi.useRealTimers();
      }
    });

    it("the caller's budget travels in the body (bounded), else the default under Convex's 45 s", () => {
      const k = (budgetMs: unknown) =>
        parseKnowledgeBody(JSON.stringify({ op: "default-set", instanceName: "p", agentId: "alice", injection: "auto", sources: ["docs"], budgetMs }));
      expect(k(30_000)).toMatchObject({ budgetMs: 30_000 });
      expect(k(10) !== null && "budgetMs" in k(10)!).toBe(false);
      expect(KNOWLEDGE_DEFAULT_BUDGET_MS).toBeLessThan(45_000);
    });
  });

  it("no hash on the read: refused locally, never retried as a conflict", async () => {
    const g = requester((method) => {
      if (method === "knowledge.sources") return SOURCES_V2;
      if (method === "config.get") return { exists: true, config: {} };
      return {};
    });
    const out = await performKnowledgeDefaultOp(g.conn, setBody());
    expect(out.body.error).toEqual({ code: "config_unguarded" });
    expect(g.calls.filter(([m]) => m === "config.get")).toHaveLength(1);
    expect(new UnguardedConfigError().message).not.toMatch(/base ?hash/i);
  });

  it("a write the read-back does not confirm is never reported saved: unknown without a fresh read, unconfirmed when the config carries it but the plugin does not show it", async () => {
    vi.useFakeTimers();
    try {
      // Nothing readable after the write (the socket died with the restart it caused).
      let written = false;
      const dead = requester((method) => {
        if (method === "config.patch") {
          written = true;
          return { ok: true };
        }
        if (written) throw new Error("socket closed");
        return method === "config.get" ? CONFIG_GET(null) : SOURCES_V2;
      });
      const pending0 = performKnowledgeDefaultOp(dead.conn, setBody());
      await vi.runAllTimersAsync();
      expect((await pending0).body.error).toEqual({ code: "write_unknown" });
      // The config carries it, the plugin never shows it (codex pass 10): not_confirmed,
      // and nothing the route answers is stored as the default.
      const g = gatewayFor({ entry: null, after: SOURCES_V2 });
      const pending = performKnowledgeDefaultOp(g.conn, setBody());
      await vi.runAllTimersAsync();
      const unreflected = await pending;
      expect(unreflected.body.error).toEqual({ code: "not_confirmed" });
      expect("knowledge" in unreflected.body).toBe(false);
      const g2 = gatewayFor({ entry: null, after: SOURCES_V2 });
      const fresh = requester((method) =>
        method === "config.get" ? CONFIG_GET({ injection: "hybrid", sources: ["docs"] }) : SOURCES_V2,
      );
      const pending2 = performKnowledgeDefaultOp(g2.conn, setBody(), {
        readFresh: (fn) => fn(fresh.conn),
        wait: async () => {},
      });
      await vi.runAllTimersAsync();
      expect((await pending2).body.error).toEqual({ code: "not_confirmed" });
    } finally {
      vi.useRealTimers();
    }
  });

  // Codex P2: config.patch applied, then the socket died with the restart it caused.
  describe("a config.patch whose answer was lost is confirmed on a FRESH connection", () => {
    const lostPatch = () =>
      gatewayFor({
        entry: null,
        patch: () => {
          throw new Error("socket closed before the answer");
        },
      });
    const freshReading = (entry: Record<string, unknown> | null, sources = { ...SOURCES_V2, injection: "hybrid", defaultSources: ["docs"] }) =>
      requester((method) => (method === "config.get" ? CONFIG_GET(entry) : sources));

    it("applied: the fresh read shows the entry and the plugin in force — reported saved, with the confirmed read-back", async () => {
      const fresh = freshReading({ injection: "hybrid", sources: ["docs"] });
      const out = await performKnowledgeDefaultOp(lostPatch().conn, setBody(), {
        readFresh: (fn) => fn(fresh.conn),
        wait: async () => {},
      });
      expect(out.status).toBe(200);
      expect(out.body).toMatchObject({ ok: true, confirmedAfterReconnect: true, knowledge: { injection: "hybrid", defaultSources: ["docs"] } });
    });

    it("not applied only on POSITIVE evidence: the config moved past our base hash without our write", async () => {
      const fresh = requester((method) =>
        method === "config.get"
          ? { ...CONFIG_GET({ injection: "auto", sources: ["graph", "docs"] }), hash: "h-2" }
          : SOURCES_V2,
      );
      const out = await performKnowledgeDefaultOp(lostPatch().conn, setBody(), {
        readFresh: (fn) => fn(fresh.conn),
        wait: async () => {},
      });
      expect(out.body.error).toEqual({ code: "not_applied" });
    });

    // Codex pass 5: the first fresh read is not the verdict.
    const sequenced = (readings: Array<{ entry: Record<string, unknown> | null; hash?: string; sources?: Record<string, unknown> }>) => {
      let n = 0;
      let current = readings[0]!;
      return requester((method) => {
        if (method === "config.get") {
          current = readings[Math.min(n, readings.length - 1)]!;
          n += 1;
          return { ...CONFIG_GET(current.entry), hash: current.hash ?? "h-1" };
        }
        return current.sources ?? SOURCES_V2;
      });
    };
    const HYBRID = { ...SOURCES_V2, injection: "hybrid", defaultSources: ["docs"] };

    it("still in flight at the first read (config unchanged, same hash): read again — it lands, applied", async () => {
      const fresh = sequenced([
        { entry: { injection: "auto", sources: ["graph", "docs"] } },
        { entry: { injection: "hybrid", sources: ["docs"] }, hash: "h-3", sources: HYBRID },
      ]);
      const out = await performKnowledgeDefaultOp(lostPatch().conn, setBody(), {
        readFresh: (fn) => fn(fresh.conn),
        wait: async () => {},
      });
      expect(out.status).toBe(200);
      expect(out.body).toMatchObject({ confirmedAfterReconnect: true });
    });

    it("written but the plugin reloads later: read again — confirmed, applied", async () => {
      vi.useFakeTimers();
      try {
        const fresh = sequenced([
          { entry: { injection: "hybrid", sources: ["docs"] }, hash: "h-3" },
          { entry: { injection: "hybrid", sources: ["docs"] }, hash: "h-3", sources: HYBRID },
        ]);
        const pending = performKnowledgeDefaultOp(lostPatch().conn, setBody(), {
          readFresh: (fn) => fn(fresh.conn),
          wait: async () => {},
        });
        await vi.runAllTimersAsync();
        expect((await pending).status).toBe(200);
      } finally {
        vi.useRealTimers();
      }
    });

    it("never settled within the budget (same hash, no write seen): write_unknown, not a refusal", async () => {
      const fresh = sequenced([{ entry: { injection: "auto", sources: ["graph", "docs"] } }]);
      const out = await performKnowledgeDefaultOp(lostPatch().conn, setBody(), {
        readFresh: (fn) => fn(fresh.conn),
        wait: async () => {},
      });
      expect(out.body.error).toEqual({ code: "write_unknown" });
      // One stable read (a config read on each side of the plugin's) per attempt.
      expect(fresh.calls.filter(([m]) => m === "config.get")).toHaveLength(16);
    });

    it("an ANSWERED patch the config no longer carries: replaced by another write — stale_default", async () => {
      vi.useFakeTimers();
      try {
        const g = gatewayFor({ entry: null, after: SOURCES_V2 });
        const fresh = sequenced([{ entry: { injection: "tool", sources: ["graph"] }, hash: "h-9" }]);
        const pending = performKnowledgeDefaultOp(g.conn, setBody(), {
          readFresh: (fn) => fn(fresh.conn),
          wait: async () => {},
        });
        await vi.runAllTimersAsync();
        expect((await pending).body.error).toEqual({ code: "stale_default" });
      } finally {
        vi.useRealTimers();
      }
    });

    it("unknown: the gateway cannot be read back in time — said as such, never a plain failure", async () => {
      let tries = 0;
      const out = await performKnowledgeDefaultOp(lostPatch().conn, setBody(), {
        readFresh: async () => {
          tries += 1;
          throw new Error("ECONNREFUSED");
        },
        wait: async () => {},
      });
      expect(out.body.error).toEqual({ code: "write_unknown" });
      expect(tries).toBe(8);
    });

    it("an ANSWERED refusal is not a lost answer: no fresh read at all", async () => {
      let tries = 0;
      const g = gatewayFor({
        entry: null,
        patch: () => {
          throw answered("INVALID_REQUEST: invalid config");
        },
      });
      const out = await performKnowledgeDefaultOp(g.conn, setBody(), {
        readFresh: async (fn) => {
          tries += 1;
          return fn(freshReading(null).conn);
        },
        wait: async () => {},
      });
      expect(out.body.error).toEqual({ code: "config_rejected" });
      expect(tries).toBe(0);
    });
  });

  it("the plugin absent: the admin read says so, nothing else is asked", async () => {
    const g = requester(() => {
      throw answered("INVALID_REQUEST: unknown method: knowledge.sources");
    });
    const out = await performKnowledgeDefaultOp(g.conn, { op: "default-get", instanceName: "p", agentId: "alice" });
    expect(out).toEqual({
      status: 409,
      body: { ok: false, error: { code: "knowledge_unavailable", reason: "plugin_absent" } },
    });
  });

  // Codex pass 9: the effective view and the raw entry go out as ONE baseline only when
  // they describe the same config — never a raw read from after the effective one.
  describe("one coherent baseline: config.get → knowledge.sources → config.get", () => {
    /** A gateway whose successive config reads answer `configs` in turn (the last one
     *  repeated), and whose plugin answers `sources`. */
    const sequenced = (
      configs: Array<{ hash: string; entry: Record<string, unknown> | null }>,
      sources: Record<string, unknown> = SOURCES_V2,
    ) => {
      let n = 0;
      const configAt: number[] = [];
      const g = requester(async (method) => {
        if (method === "config.get") {
          configAt.push(Date.now());
          const c = configs[Math.min(n, configs.length - 1)]!;
          n += 1;
          // The probe that follows is sent strictly later than this read.
          await sleep(5);
          return { ...CONFIG_GET(c.entry), hash: c.hash };
        }
        if (method === "knowledge.sources") return sources;
        return {};
      });
      return { ...g, configAt, order: () => g.calls.map(([m]) => m) };
    };
    const probeAlice = (conn: GatewayRequester) => async () => ({
      alice: await probeKnowledgeSources(conn, "alice"),
    });
    const soon = () => Date.now() + 20_000;
    const COHERENT = { injection: "auto", sources: ["graph", "docs"] };

    it("paired when both reads carry the same hash and the plugin reflects the entry — stamped by the FIRST read", async () => {
      const g = sequenced([{ hash: "h-1", entry: COHERENT }]);
      const out = await readKnowledgeBaseline(g.conn, probeAlice(g.conn), { deadline: soon() });
      expect(g.order()).toEqual(["config.get", "knowledge.sources", "config.get"]);
      const alice = out.alice!;
      expect(alice.available && alice.config).toEqual(COHERENT);
      // …with whether the agent has its OWN allowlist, from the same snapshot (codex pass 18).
      expect(alice.available && alice.ownAllowlist).toBe(false);
      const own = sequenced([{ hash: "h-1", entry: { ...COHERENT, allowedSources: ["graph", "docs"] } }]);
      const withOwn = (await readKnowledgeBaseline(own.conn, probeAlice(own.conn), { deadline: soon() })).alice!;
      expect(withOwn.available && withOwn.ownAllowlist).toBe(true);
      // The pair is only as fresh as its first read (sent before the probe).
      expect(alice.observedAt).toBeLessThanOrEqual(g.configAt[0]!);
    });

    it("an edit between the two reads (H1 ≠ H2): read again; still moving at the bound → no raw view at all", async () => {
      const g = sequenced([
        { hash: "h-1", entry: COHERENT },
        { hash: "h-2", entry: COHERENT },
        { hash: "h-3", entry: COHERENT },
        { hash: "h-4", entry: COHERENT },
      ]);
      const out = await readKnowledgeBaseline(g.conn, probeAlice(g.conn), { deadline: soon() });
      expect(out.alice!.available).toBe(true);
      expect(out.alice!.available && "config" in out.alice!).toBe(false);
      // Bounded: KNOWLEDGE_BASELINE_ATTEMPTS sandwiches, no more.
      expect(g.calls.filter(([m]) => m === "config.get")).toHaveLength(2 * KNOWLEDGE_BASELINE_ATTEMPTS);
      expect(g.calls.filter(([m]) => m === "knowledge.sources")).toHaveLength(KNOWLEDGE_BASELINE_ATTEMPTS);
    });

    it("an edit that settles: the re-read pairs the config as it is NOW", async () => {
      const now = { injection: "auto", sources: ["docs", "graph", "gone"] };
      const g = sequenced(
        [
          { hash: "h-1", entry: COHERENT },
          { hash: "h-2", entry: now },
        ],
        { ...SOURCES_V2, defaultSources: ["docs", "graph"] },
      );
      const out = await readKnowledgeBaseline(g.conn, probeAlice(g.conn), { deadline: soon() });
      const alice = out.alice!;
      expect(alice.available && alice.config).toEqual(now);
      // Stamped by the SECOND sandwich's first read (reads 0-1 were the first sandwich).
      expect(alice.observedAt).toBeLessThanOrEqual(g.configAt[2]!);
      expect(alice.observedAt).toBeGreaterThanOrEqual(g.configAt[1]!);
    });

    it("same hash, but the plugin does not show the entry yet (hot-reload lag): never paired", async () => {
      const g = sequenced([{ hash: "h-1", entry: { injection: "tool", sources: ["archive"] } }]);
      const out = await readKnowledgeBaseline(g.conn, probeAlice(g.conn), { deadline: soon() });
      expect(out.alice!.available).toBe(true);
      expect(out.alice!.available && "config" in out.alice!).toBe(false);
      expect(g.calls.filter(([m]) => m === "knowledge.sources")).toHaveLength(KNOWLEDGE_BASELINE_ATTEMPTS);
    });

    it("no config read at all: the effective view alone, and nothing more is asked", async () => {
      const g = requester((method) => {
        if (method === "config.get") throw answered("INVALID_REQUEST: missing scope: operator.read");
        return SOURCES_V2;
      });
      const out = await readKnowledgeBaseline(g.conn, probeAlice(g.conn), { deadline: soon() });
      expect(out.alice!.available && "config" in out.alice!).toBe(false);
      expect(g.calls.map(([m]) => m)).toEqual(["config.get", "knowledge.sources"]);
    });

    it("what the plugin reflects mirrors its resolution: known+allowed ids, de-duplicated, IN ORDER; absent keys unchecked", () => {
      const info = parseKnowledgeSources(SOURCES_V2)!;
      expect(rawReflected({ injection: "auto", sources: ["graph", "zzz", "docs", "graph"] }, info)).toBe(true);
      expect(rawReflected({ injection: null, sources: null }, info)).toBe(true);
      expect(rawReflected({ injection: "not-a-mode", sources: null }, info)).toBe(true);
      expect(rawReflected({ injection: "hybrid", sources: null }, info)).toBe(false);
      expect(rawReflected({ injection: null, sources: ["docs", "graph"] }, info)).toBe(false);
      expect(rawReflected({ injection: null, sources: ["graph", "docs", "archive"] }, info)).toBe(false);
    });

    // The three admin sites and discovery all go through it.
    const EDITED = { injection: "tool", sources: ["graph", "docs"] };

    it("admin read: a raw entry the plugin does not reflect is not sent as the baseline", async () => {
      const g = sequenced([{ hash: "h-1", entry: EDITED }]);
      const out = await performKnowledgeDefaultOp(g.conn, { op: "default-get", instanceName: "p", agentId: "alice" });
      expect(out.status).toBe(200);
      expect(out.body.knowledge).toEqual(parseKnowledgeSources(SOURCES_V2));
      expect("config" in out.body).toBe(false);
      expect(g.order().slice(0, 3)).toEqual(["config.get", "knowledge.sources", "config.get"]);
    });

    // Codex pass 10: the write is settled on a STABLE config read, never on the plugin's
    // view alone — a plugin still showing our value while the config already carries
    // another operator's is a replaced write, not a confirmation.
    it("after a confirmed write: another operator's value in the config, the plugin not reloaded yet — stale_default with the config as it is, never stored as ours", async () => {
      let written = false;
      const g = requester(async (method) => {
        if (method === "knowledge.sources") return written ? AFTER : SOURCES_V2;
        if (method === "config.get") return written ? { ...CONFIG_GET(EDITED), hash: "h-9" } : CONFIG_GET(null);
        if (method === "config.patch") written = true;
        return { ok: true };
      });
      const out = await performKnowledgeDefaultOp(g.conn, setBody());
      expect(out.status).toBe(409);
      expect(out.body.error).toEqual({ code: "stale_default" });
      expect(out.body.config).toEqual(EDITED);
      // The plugin's view does not reflect that config: no pair, so nothing to store.
      expect("knowledge" in out.body).toBe(false);
    });

    it("…and once the plugin reflects the other value, the pair rides along with the refusal", async () => {
      let written = false;
      const EDITED_VIEW = { ...SOURCES_V2, injection: "tool" };
      const g = requester(async (method) => {
        if (method === "knowledge.sources") return written ? EDITED_VIEW : SOURCES_V2;
        if (method === "config.get") return written ? { ...CONFIG_GET(EDITED), hash: "h-9" } : CONFIG_GET(null);
        if (method === "config.patch") written = true;
        return { ok: true };
      });
      const out = await performKnowledgeDefaultOp(g.conn, setBody());
      expect(out.body.error).toEqual({ code: "stale_default" });
      expect(out.body).toMatchObject({ knowledge: parseKnowledgeSources(EDITED_VIEW), config: EDITED });
    });

    // Codex pass 16: the allowlist the pin is built from is never a cut list.
    it("an allowlist past 64 sources is read WHOLE: a source past the 64th can become the default — and no allowlist is written", async () => {
      const many = Array.from({ length: 100 }, (_, i) => ({ id: `s${i}`, type: "pgvector", label: `S${i}`, description: "", default: i < 2 }));
      const info = parseKnowledgeSources({ ...SOURCES_V2, defaultSources: ["s0", "s1"], sources: many })!;
      expect(info.sources).toHaveLength(100);
      expect("incomplete" in info).toBe(false);
      let written: Record<string, unknown> | null = null;
      const g = requester((method, params) => {
        if (method === "knowledge.sources") {
          return written === null
            ? { ...SOURCES_V2, defaultSources: ["s0", "s1"], sources: many }
            : { ...SOURCES_V2, injection: "hybrid", defaultSources: ["s80"], sources: many };
        }
        if (method === "config.get") {
          // The inherited default the plugin shows (s0, s1): coherent, no reload lag.
          const c = written === null ? CONFIG_GET(null) : { ...CONFIG_GET(written), hash: "h-2" };
          (c as { config: { plugins: { entries: Record<string, { config: Record<string, unknown> }> } } }).config.plugins.entries[
            "openclaw-knowledge"
          ]!.config.defaults = { sources: ["s0", "s1"] };
          return c;
        }
        if (method === "config.patch") {
          written = JSON.parse(params.raw as string).plugins.entries["openclaw-knowledge"].config.agents.alice;
          return { ok: true };
        }
        return {};
      });
      const out = await performKnowledgeDefaultOp(
        g.conn,
        setBody({ sources: ["s80"], expected: { injection: "auto", defaultSources: ["s0", "s1"] } }),
      );
      expect(out.status).toBe(200);
      expect(written).toEqual({ injection: "hybrid", sources: ["s80"] });
    });

    // Codex pass 19: the allowlist the RAW config imposes binds the write, even while the
    // plugin's view still lists a source the operator revoked (hot-reload lag).
    it("a source revoked in `defaults.allowedSources` but still listed by a lagging plugin: refused, nothing written", async () => {
      const withDefaults = (entry: Record<string, unknown> | null) => {
        const c = CONFIG_GET(entry) as { config: { plugins: { entries: Record<string, { config: Record<string, unknown> }> } } };
        c.config.plugins.entries["openclaw-knowledge"]!.config.defaults = { allowedSources: ["graph", "docs"] };
        return c;
      };
      const g = requester((method) =>
        method === "knowledge.sources" ? SOURCES_V2 : method === "config.get" ? withDefaults(null) : { ok: true },
      );
      const out = await performKnowledgeDefaultOp(g.conn, setBody({ sources: ["archive"], expected: null }));
      // Refused by the lag guard that closes this class (codex pass 20); the raw bound
      // check of pass 19 stays behind it.
      expect(out).toEqual({ status: 409, body: { ok: false, error: { code: "plugin_config_lag" } } });
      expect(g.calls.map(([m]) => m)).not.toContain("config.patch");
      // The agent's OWN allowlist wins over the defaults' (never widened, never replaced).
      expect(rawAllowlistBound(withDefaults(null) as never, { allowedSources: ["archive"] })).toEqual(["archive"]);
      expect(rawAllowlistBound(withDefaults(null) as never, null)).toEqual(["graph", "docs"]);
      expect(rawAllowlistBound(CONFIG_GET(null) as never, null)).toBeNull();
    });

    // Codex pass 20: the plugin's view must be the config's — resolved exactly like the
    // plugin resolves it (openclaw-knowledge 4.1.0 resolvePolicy), one shape per test.
    describe("the plugin's view lags the config snapshot: refused `plugin_config_lag`", () => {
      const cfg = (defaults: Record<string, unknown> | undefined, entry: Record<string, unknown> | null) => {
        const c = CONFIG_GET(entry) as { config: { plugins: { entries: Record<string, { config: Record<string, unknown> }> } } };
        const pc = c.config.plugins.entries["openclaw-knowledge"]!.config;
        if (defaults === undefined) delete pc.defaults;
        else pc.defaults = defaults;
        return c as unknown as Record<string, unknown>;
      };
      const view = parseKnowledgeSources(SOURCES_V2)!; // auto, [graph, docs], lists graph/docs/archive
      const lags = (defaults: Record<string, unknown> | undefined, entry: Record<string, unknown> | null, v = view) =>
        pluginViewLags(cfg(defaults, entry), entry, v);

      it("the agent's OWN key changed (injection, sources, order)", () => {
        expect(lags({ sources: ["graph", "docs"] }, { injection: "tool" })).toBe(true);
        expect(lags({ sources: ["graph", "docs"] }, { sources: ["docs"] })).toBe(true);
        expect(lags({ sources: ["graph", "docs"] }, { sources: ["docs", "graph"] })).toBe(true);
      });

      it("an INHERITED injection changed in `defaults`", () => {
        expect(lags({ injection: "tool", sources: ["graph", "docs"] }, null)).toBe(true);
      });

      it("an INHERITED selection changed in `defaults`", () => {
        expect(lags({ sources: ["docs"] }, null)).toBe(true);
      });

      it("`defaults.allowedSources` revoked a source the plugin still lists", () => {
        expect(lags({ sources: ["graph", "docs"], allowedSources: ["graph", "docs"] }, null)).toBe(true);
      });

      it("no false alarm: a view that IS the config's, whatever level it comes from", () => {
        expect(lags({ sources: ["graph", "docs"] }, null)).toBe(false);
        // Built-ins: injection auto, every enabled (listed) source, in registry order.
        expect(lags(undefined, null, { ...view, defaultSources: ["graph", "docs", "archive"] })).toBe(false);
        // defaults.allowedSources clamps the inherited selection first: unclamped, the
        // selection would hold archive, which this view does not show as a default…
        expect(
          lags({ sources: ["graph", "docs", "archive"], allowedSources: ["graph", "docs", "archive"] }, null),
        ).toBe(true);
        // …clamped, it matches exactly.
        expect(
          lags({ sources: ["graph", "docs", "archive"], allowedSources: ["graph", "docs"] }, null, {
            ...view,
            sources: view.sources.filter((x) => x.id !== "archive"),
          }),
        ).toBe(false);
        // …even when the agent's OWN allowlist lets that source through: the inherited
        // selection was clamped at the defaults level (config.ts:719), before the agent's.
        expect(
          lags(
            { sources: ["graph", "docs", "archive"], allowedSources: ["graph", "docs"] },
            { allowedSources: ["graph", "docs", "archive"] },
          ),
        ).toBe(false);
        // Own ids the plugin drops (unknown, disabled) and an invalid own injection.
        expect(lags({ sources: ["graph", "docs"] }, { injection: "loud", sources: ["graph", "gone", "docs", "graph"] })).toBe(false);
        // An own allowlist: the plugin may list fewer (a disabled id), never more.
        expect(lags({ sources: ["graph", "docs"] }, { allowedSources: ["graph", "docs", "archive", "gone"] })).toBe(false);
      });

      it("the write route refuses it before any write", async () => {
        const g = requester((method) =>
          method === "knowledge.sources" ? SOURCES_V2 : method === "config.get" ? cfg({ injection: "tool", sources: ["graph", "docs"] }, null) : { ok: true },
        );
        const out = await performKnowledgeDefaultOp(g.conn, setBody());
        expect(out).toEqual({ status: 409, body: { ok: false, error: { code: "plugin_config_lag" } } });
        expect(g.calls.map(([m]) => m)).not.toContain("config.patch");
      });
    });

    // Codex pass 18: the plugin contract decides whether a default can be written at all.
    it("the contract level is read defensively: an integer >= 2, else the 4.0.x contract", () => {
      expect(parseKnowledgeSources({ ...SOURCES_ALICE, contract: 2 })?.contract).toBe(2);
      for (const contract of [undefined, 1, "2", 2.5, -3, null]) {
        expect(parseKnowledgeSources({ ...SOURCES_ALICE, contract })?.contract).toBeUndefined();
      }
    });

    it("4.0.x (no contract): an agent without its own allowlist is refused `plugin_too_old` — nothing written", async () => {
      for (const entry of [null, { injection: "auto", sources: ["graph", "docs"] }]) {
        const g = requester((method) =>
          method === "knowledge.sources" ? SOURCES_ALICE : method === "config.get" ? CONFIG_GET(entry) : { ok: true },
        );
        const out = await performKnowledgeDefaultOp(g.conn, setBody({ expected: null }));
        expect(out).toEqual({ status: 409, body: { ok: false, error: { code: "plugin_too_old" } } });
        expect(g.calls.map(([m]) => m)).not.toContain("config.patch");
      }
    });

    it("4.0.x with the agent's OWN allowlist: writable — `sources` alone, the allowlist untouched", async () => {
      let written: Record<string, unknown> | null = null;
      const own = { injection: "auto", sources: ["graph", "docs"], allowedSources: ["graph", "docs", "archive"] };
      const g = requester((method, params) => {
        if (method === "knowledge.sources") return written === null ? SOURCES_ALICE : AFTER_V1;
        if (method === "config.get") return written === null ? CONFIG_GET(own) : { ...CONFIG_GET({ ...own, ...written }), hash: "h-2" };
        if (method === "config.patch") {
          written = JSON.parse(params.raw as string).plugins.entries["openclaw-knowledge"].config.agents.alice;
          return { ok: true };
        }
        return {};
      });
      const out = await performKnowledgeDefaultOp(g.conn, setBody({ expected: null }));
      expect(out.status).toBe(200);
      expect(written).toEqual({ injection: "hybrid", sources: ["docs"] });
    });

    it("the contract is re-read on the retry: a plugin reloaded to 4.0.x meanwhile refuses the write", async () => {
      let patches = 0;
      const g = requester((method) => {
        if (method === "knowledge.sources") return patches === 0 ? SOURCES_V2 : SOURCES_ALICE;
        if (method === "config.get") return CONFIG_GET(null);
        if (method === "config.patch") {
          patches += 1;
          throw answered("INVALID_REQUEST: config changed since last load; re-run config.get and retry with baseHash");
        }
        return {};
      });
      const out = await performKnowledgeDefaultOp(g.conn, setBody({ expected: null }));
      expect(out.body.error).toEqual({ code: "plugin_too_old" });
      expect(patches).toBe(1);
    });

    it("the default list is kept WHOLE (never cut to 64); one longer than the admin's view can carry is refused", async () => {
      const ids = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`);
      const allow = ids(80).map((id) => ({ id }));
      const info = parseKnowledgeSources({ ...SOURCES_V2, sources: allow, defaultSources: ids(70) })!;
      expect(info.defaultSources).toHaveLength(70);
      expect(parseKnowledgeSources({ ...SOURCES_V2, defaultSources: ids(KNOWLEDGE_ALLOWLIST_CAP + 1) })).toMatchObject({ incomplete: true });
      expect(parseKnowledgeSources({ ...SOURCES_V2, defaultSources: ["docs", 7] })).toMatchObject({ incomplete: true });
      const g = requester((method) =>
        method === "knowledge.sources"
          ? { ...SOURCES_V2, sources: allow, defaultSources: ids(70) }
          : method === "config.get"
            ? CONFIG_GET(null)
            : {},
      );
      const out = await performKnowledgeDefaultOp(g.conn, setBody({ sources: ["s1"], expected: null }));
      expect(out).toEqual({ status: 409, body: { ok: false, error: { code: "default_too_large" } } });
      expect(g.calls.map(([m]) => m)).not.toContain("config.patch");
    });

    it("an allowlist that cannot be read whole is refused, never pinned cut", async () => {
      const over = Array.from({ length: KNOWLEDGE_ALLOWLIST_CAP + 1 }, (_, i) => ({ id: `s${i}` }));
      expect(parseKnowledgeSources({ ...SOURCES_V2, sources: over })).toMatchObject({ incomplete: true });
      const unreadable = [...SOURCES_V2.sources, { id: 42 }];
      expect(parseKnowledgeSources({ ...SOURCES_V2, sources: unreadable })).toMatchObject({ incomplete: true });
      for (const sources of [over, unreadable]) {
        const g = requester((method) =>
          method === "knowledge.sources" ? { ...SOURCES_V2, sources } : method === "config.get" ? CONFIG_GET(null) : {},
        );
        const out = await performKnowledgeDefaultOp(g.conn, setBody({ expected: null }));
        expect(out).toEqual({ status: 409, body: { ok: false, error: { code: "allowlist_too_large" } } });
        expect(g.calls.map(([m]) => m)).not.toContain("config.patch");
      }
    });

    // Codex pass 14: the raw default is carried WHOLE or not at all.
    it("a default past the stored bound (or not representable) is refused, never checked against a cut view", async () => {
      const ids = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`);
      for (const entry of [
        { injection: "auto", sources: ids(65) },
        { injection: "auto", sources: ["graph", 7, "docs"] },
        { injection: "auto", sources: ["x".repeat(65)] },
        { injection: 3, sources: ["graph"] },
      ]) {
        const g = gatewayFor({ entry: entry as Record<string, unknown> });
        const out = await performKnowledgeDefaultOp(g.conn, setBody({ expected: null }));
        expect(out).toEqual({ status: 409, body: { ok: false, error: { code: "default_too_large" } } });
        expect(g.calls.map(([m]) => m)).not.toContain("config.patch");
      }
      // Within the bound: the full value is compared — a change at the 64th id is one.
      // (graph and docs first: what the plugin shows, so its view is not lagging.)
      const full = ["graph", "docs", ...ids(62)];
      const changed = [...full.slice(0, 63), "other"];
      const g = gatewayFor({ entry: { injection: "auto", sources: changed } });
      const out = await performKnowledgeDefaultOp(
        g.conn,
        setBody({ expected: { injection: "auto", defaultSources: ["graph", "docs"], config: { injection: "auto", sources: full } } }),
      );
      expect(out.body.error).toEqual({ code: "stale_default" });
      expect(rawAgentDefault({ sources: ids(70) }).sources).toHaveLength(70);
    });

    it("replaced after our write by a default past the bound: stale_default, with no (cut) raw view", async () => {
      const ids = Array.from({ length: 65 }, (_, i) => `s${i}`);
      let written = false;
      const g = requester(async (method) => {
        if (method === "knowledge.sources") return SOURCES_V2;
        if (method === "config.get") {
          return written ? { ...CONFIG_GET({ injection: "auto", sources: ids }), hash: "h-9" } : CONFIG_GET(null);
        }
        if (method === "config.patch") written = true;
        return { ok: true };
      });
      const out = await performKnowledgeDefaultOp(g.conn, setBody());
      expect(out.body.error).toEqual({ code: "stale_default" });
      expect("config" in out.body).toBe(false);
      expect("knowledge" in out.body).toBe(false);
    });

    it("a default past the bound is never published as a baseline", async () => {
      const ids = Array.from({ length: 65 }, (_, i) => `s${i}`);
      const g = sequenced([{ hash: "h-1", entry: { injection: "auto", sources: ids } }]);
      const out = await readKnowledgeBaseline(g.conn, probeAlice(g.conn), { deadline: soon() });
      expect(out.alice!.available && "config" in out.alice!).toBe(false);
      // Nothing a re-read would change: one sandwich.
      expect(g.calls.filter(([m]) => m === "knowledge.sources")).toHaveLength(1);
    });

    it("the config holding our sources in ANOTHER order is another operator's value: stale_default", async () => {
      const g = gatewayFor({
        entry: null,
        after: { ...SOURCES_V2, injection: "hybrid", defaultSources: ["docs", "graph"] },
        afterEntry: { injection: "hybrid", sources: ["docs", "graph"] },
      });
      const out = await performKnowledgeDefaultOp(g.conn, setBody({ sources: ["graph", "docs"] }));
      expect(out.body.error).toEqual({ code: "stale_default" });
    });

    it("the config moving under every read: never `applied` on the plugin's view alone", async () => {
      let written = false;
      let n = 0;
      const g = requester(async (method) => {
        if (method === "knowledge.sources") return written ? AFTER : SOURCES_V2;
        if (method === "config.get") {
          if (!written) return CONFIG_GET(null);
          n += 1;
          return { ...CONFIG_GET({ injection: "hybrid", sources: ["docs"] }), hash: `h-${n}` };
        }
        if (method === "config.patch") written = true;
        return { ok: true };
      });
      const out = await performKnowledgeDefaultOp(g.conn, setBody(), { deadline: Date.now() + 3_000 });
      expect(out.status).not.toBe(200);
      expect("knowledge" in out.body).toBe(false);
    });

    it("after a lost answer, confirmed on a fresh socket: same rule", async () => {
      const lost = gatewayFor({
        entry: null,
        patch: () => {
          throw new Error("socket closed before the answer");
        },
      });
      // The fresh config carries ANOTHER value — after our write was committed? No: the
      // answer was lost, so only the hash can tell. It moved past our base hash without
      // our value: not_applied — whatever the plugin still shows.
      const fresh = requester(async (method) =>
        method === "config.get" ? { ...CONFIG_GET(EDITED), hash: "h-9" } : AFTER,
      );
      const out = await performKnowledgeDefaultOp(lost.conn, setBody(), {
        readFresh: (fn) => fn(fresh.conn),
        wait: async () => {},
      });
      expect(out.body.error).toEqual({ code: "not_applied" });
      expect("knowledge" in out.body).toBe(false);
    });
  });
});

// --- Discovery -------------------------------------------------------------------------

describe("discovery carries each agent's knowledge answer", () => {
  it("the raw default each agent has in the config rides along, read on both sides of the probes", async () => {
    const gw = fakeGateway({
      answers: {
        "agents.list": { payload: { agents: [{ id: "alice" }, { id: "files" }] } },
        "knowledge.sources": { payload: SOURCES_ALICE },
        "config.get": {
          payload: {
            hash: "h",
            // `x` is no source the plugin offers: filtered out of its view, kept in the raw one.
            config: { plugins: { entries: { "openclaw-knowledge": { config: { agents: { alice: { injection: "auto", sources: ["graph", "x", "docs"] } } } } } } },
          },
        },
      },
    });
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => gw as never);
    const out = await discoverAgents(config);
    expect(gw.countOf("config.get")).toBe(2);
    const alice = out.knowledge?.alice;
    expect(alice?.available && alice.config).toEqual({ injection: "auto", sources: ["graph", "x", "docs"] });
    const files = out.knowledge?.files;
    expect(files?.available && files.config).toEqual({ injection: null, sources: null });
  });

  it("an edit between the config reads around the probes: no raw view rides along (codex pass 9)", async () => {
    const cfg = (n: number) => ({
      payload: {
        hash: `h-${n}`,
        config: { plugins: { entries: { "openclaw-knowledge": { config: { agents: { alice: { injection: "auto", sources: ["graph", "docs"] } } } } } } },
      },
    });
    const gw = fakeGateway({
      answers: {
        "agents.list": { payload: { agents: [{ id: "alice" }] } },
        "knowledge.sources": { payload: SOURCES_ALICE },
      },
      sequences: { "config.get": [cfg(1), cfg(2), cfg(3), cfg(4), cfg(5)] },
    });
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => gw as never);
    const out = await discoverAgents(config);
    const alice = out.knowledge?.alice;
    expect(alice?.available).toBe(true);
    expect(alice?.available && "config" in alice).toBe(false);
  });

  it("an absence established by one agent's read is propagated WITH that read's stamp (codex pass 20)", async () => {
    const r = requester(() => {
      throw answered("INVALID_REQUEST: unknown method: knowledge.sources");
    });
    const before = Date.now();
    const out = await probeKnowledgeForAgents(r.conn, ["alice", "files", "bob"], { concurrency: 1 });
    expect(r.calls).toHaveLength(1);
    const stamp = out.alice!.observedAt;
    expect(typeof stamp === "number" && stamp >= before).toBe(true);
    for (const id of ["files", "bob"]) {
      expect(out[id]).toEqual({ available: false, reason: "plugin_absent", observedAt: stamp });
    }
  });

  it("two instances on ONE gateway, interleaved syncs: each instance covers every agent (codex pass 22)", async () => {
    clearKnowledgeDiscoveryCursors();
    try {
      const roster = Array.from({ length: 200 }, (_, i) => ({ id: `agent-${i}` }));
      const gw = fakeGateway({
        answers: {
          "agents.list": { payload: { agents: roster } },
          "knowledge.sources": { payload: SOURCES_ALICE },
        },
      });
      vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => gw as never);
      const a = { ...config, instanceName: "inst-a" };
      const b = { ...config, instanceName: "inst-b" };
      expect(knowledgeDiscoveryCursorKey(a)).not.toBe(knowledgeDiscoveryCursorKey(b));
      const seen = { a: new Set<string>(), b: new Set<string>() };
      for (let i = 0; i < 2; i += 1) {
        for (const [k, c] of [["a", a], ["b", b]] as const) {
          const out = await discoverAgents(c);
          for (const id of Object.keys(out.knowledge ?? {})) seen[k].add(id);
        }
      }
      expect(seen.a.size).toBe(200);
      expect(seen.b.size).toBe(200);
    } finally {
      clearKnowledgeDiscoveryCursors();
    }
  });

  it("one `knowledge.sources` per agent on the discovery socket", async () => {
    const gw = fakeGateway({
      answers: {
        "agents.list": { payload: { agents: [{ id: "alice" }, { id: "files" }] } },
        "knowledge.sources": { payload: SOURCES_ALICE },
      },
    });
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => gw as never);
    const out = await discoverAgents(config);
    expect(gw.calls.filter(([m]) => m === "knowledge.sources").map(([, p]) => p)).toEqual([
      { agentId: "alice" },
      { agentId: "files" },
    ]);
    expect(out.knowledge?.alice?.available).toBe(true);
    expect(out.knowledge?.files?.available).toBe(true);
  });
});

describe("ticked sources are SEARCHED: never under an inactive mode (codex pass 13)", () => {
  it("a sources choice without its own mode carries `auto` only over an `off` default", () => {
    const docs = { kind: "sources" as const, sources: ["docs"] };
    expect(concreteOverride(docs, "off")).toEqual({ sources: ["docs"], injection: "auto" });
    expect(concreteOverride(docs, "hybrid")).toEqual({ sources: ["docs"] });
    expect(concreteOverride(docs, null)).toEqual({ sources: ["docs"] });
    expect(concreteOverride({ ...docs, injection: "tool" }, "off")).toEqual({ sources: ["docs"], injection: "tool" });
    expect(concreteOverride({ kind: "off" }, "off")).toEqual({ injection: "off" });
    expect(concreteOverride({ kind: "default" }, "off")).toBeNull();
  });

  it("a write whose effective mode is `off` does not confirm chosen sources", () => {
    const snap = { injection: "off" as const, effectiveSources: ["docs"], origin: { injection: "agent", sources: "session" } };
    expect(snapshotConfirms(snap, { sources: ["docs"] })).toBe(false);
    expect(snapshotConfirms({ ...snap, injection: "auto" }, { sources: ["docs"] })).toBe(true);
  });

  it("the last gate: the choice held, but the effective mode turned `off` — withheld", async () => {
    const g = knowledgeGuard("i", "k-inactive");
    noteKnowledgeRevision(g, 1);
    noteAppliedKnowledgeRevision(g, 1, { sources: ["docs"] });
    const read = (injection: "off" | "auto") => async (): Promise<SessionPolicyRead> => ({
      kind: "held",
      override: { sources: ["docs"] },
      overridesAllowed: true,
      injection,
    });
    const off = knowledgeChatSendGate(g, 1, () => {}, { desired: { sources: ["docs"] }, read: read("off") });
    await off.refresh?.();
    expect(() => off.check()).toThrow(expect.objectContaining({ reason: "unconfirmed" }));
    const on = knowledgeChatSendGate(g, 1, () => {}, { desired: { sources: ["docs"] }, read: read("auto") });
    await on.refresh?.();
    expect(() => on.check()).not.toThrow();
  });
});

describe("the operator's clamp at the last gate (codex pass 15)", () => {
  const gateWith = (effectiveSources: string[]) => {
    const g = knowledgeGuard("i", `k-clamp-${effectiveSources.join("-")}`);
    noteKnowledgeRevision(g, 1);
    noteAppliedKnowledgeRevision(g, 1, { sources: ["graph", "docs"] });
    const clamped: string[][] = [];
    const gate = knowledgeChatSendGate(g, 1, () => {}, {
      desired: { sources: ["graph", "docs"] },
      read: async (): Promise<SessionPolicyRead> => ({
        kind: "held",
        override: { sources: ["graph", "docs"] },
        overridesAllowed: true,
        injection: "auto",
        effectiveSources,
      }),
      onClamped: (d) => clamped.push(d),
    });
    return { gate, clamped };
  };

  it("fewer of the chosen sources: goes, the dropped ids reported", async () => {
    const { gate, clamped } = gateWith(["docs"]);
    await gate.refresh?.();
    expect(() => gate.check()).not.toThrow();
    expect(clamped).toEqual([["graph"]]);
  });

  it("none left (an empty effective list): goes, everything reported dropped — nothing is searched", async () => {
    const { gate, clamped } = gateWith([]);
    await gate.refresh?.();
    expect(() => gate.check()).not.toThrow();
    expect(clamped).toEqual([["graph", "docs"]]);
  });

  it("the same sources: nothing reported", async () => {
    const { gate, clamped } = gateWith(["docs", "graph"]);
    await gate.refresh?.();
    expect(() => gate.check()).not.toThrow();
    expect(clamped).toEqual([]);
  });

  it("a source OUTSIDE the choice (the plugin's fallback to the agent default): withheld", async () => {
    const { gate } = gateWith(["archive"]);
    await gate.refresh?.();
    expect(() => gate.check()).toThrow(expect.objectContaining({ reason: "source_not_allowed" }));
  });
});

describe("a pending one-shot is never the owner's choice (codex pass 11)", () => {
  it("read from the session row and from policy.get alike; alone it is still something held", async () => {
    expect(readKnowledgeOverride(describedWith({ v: 1, sources: ["docs"], oneShot: ONE_SHOT }))).toEqual({
      sources: ["docs"],
      oneShot: true,
    });
    expect(readKnowledgeOverride(describedWith({ v: 1, oneShot: ONE_SHOT }))).toEqual({ oneShot: true });
    const read = await readSessionPolicy(requester(() => policyGetAnswer({ injection: "off", oneShot: true })).conn, "k", "alice");
    expect(read).toEqual({
      kind: "held",
      override: { injection: "off", oneShot: true },
      overridesAllowed: true,
      injection: "off",
      effectiveSources: ["graph", "docs"],
    });
  });

  it("never matches — not the choice, not `default`", () => {
    expect(overrideMatches({ sources: ["docs"], oneShot: true }, { sources: ["docs"] })).toBe(false);
    expect(overrideMatches({ oneShot: true }, null)).toBe(false);
    expect(overrideMatches({ sources: ["docs"] }, { sources: ["docs"] })).toBe(true);
  });

  it("a write whose answer still shows a one-shot is not confirmed", async () => {
    const r = requester(() => ({ ...liveAnswer({ actionId: "policy.set", payload: { reset: true, injection: "off" } }) }));
    const answer = liveAnswer({ actionId: "policy.set", payload: { reset: true, injection: "off" } }) as { result: Record<string, unknown> };
    const withShot = requester(() => ({ ok: true, result: { ...answer.result, session: { v: 1, injection: "off", oneShot: ONE_SHOT } } }));
    await expect(writeKnowledgePolicy(r.conn, "k", "alice", { injection: "off" })).resolves.not.toBeNull();
    await expect(writeKnowledgePolicy(withShot.conn, "k", "alice", { injection: "off" })).rejects.toMatchObject({ reason: "unconfirmed" });
  });

  it("the last gate: a one-shot appearing right before the send withholds it (session_replaced)", async () => {
    const g = knowledgeGuard("i", "k-oneshot");
    noteKnowledgeRevision(g, 1);
    noteAppliedKnowledgeRevision(g, 1, { injection: "off" });
    const gate = knowledgeChatSendGate(g, 1, () => {}, {
      desired: { injection: "off" },
      read: async () => ({ kind: "held", override: { injection: "off", oneShot: true }, overridesAllowed: true }),
    });
    await gate.refresh?.();
    expect(() => gate.check()).toThrow(expect.objectContaining({ reason: "session_replaced" }));
  });
});

describe("readSessionPolicy: the plugin's own read of the session (codex pass 10)", () => {
  it("answers with the session projection and whether overrides are allowed", async () => {
    const held = requester(() => policyGetAnswer({ sources: ["docs"] }));
    expect(await readSessionPolicy(held.conn, "k", "alice")).toEqual({
      kind: "held",
      override: { sources: ["docs"] },
      overridesAllowed: true,
      injection: "auto",
      effectiveSources: ["docs"],
    });
    expect(held.calls).toEqual([
      ["plugins.sessionAction", { pluginId: "openclaw-knowledge", actionId: "policy.get", sessionKey: "k", agentId: "alice" }],
    ]);
    // `{ v: 1 }` alone: no override.
    const none = requester(() => policyGetAnswer(null, false));
    expect(await readSessionPolicy(none.conn, "k", "alice")).toEqual({
      kind: "held",
      override: null,
      overridesAllowed: false,
      injection: "auto",
      effectiveSources: ["graph", "docs"],
    });
  });

  it("the gateway saying the plugin cannot take it is `plugin_gone`; no answer or a malformed one says nothing", async () => {
    const as = async (f: () => unknown) => readSessionPolicy(requester(f).conn, "k", "alice");
    for (const text of [
      "UNAVAILABLE: unknown plugin session action: openclaw-knowledge/policy.get",
      "UNAVAILABLE: plugin session action failed",
      "INVALID_REQUEST: unknown method: plugins.sessionAction",
    ]) {
      expect(
        await as(() => {
          throw answered(text);
        }),
      ).toEqual({ kind: "plugin_gone" });
    }
    expect(
      await as(() => {
        throw new Error("plugins.sessionAction timed out");
      }),
    ).toEqual({ kind: "unknown" });
    expect(
      await as(() => {
        throw answered("FORBIDDEN: missing scope: operator.read");
      }),
    ).toEqual({ kind: "unknown" });
    expect(await as(() => ({ ok: true, result: { injection: "auto" } }))).toEqual({ kind: "unknown" });
    expect(await as(() => ({ ok: false, code: "invalid_payload" }))).toEqual({ kind: "unknown" });
  });
});

// --- Codex P1: an on-the-spot apply can never land after a newer choice --------------

describe("ordering: an older choice never lands after a newer one (codex P1)", () => {
  /** A gateway that REMEMBERS the override: policy.set/reset change it, describe shows it,
   *  and the apply's write can be held in flight. */
  const statefulGateway = (initial: Record<string, unknown> | null, agentMode?: string) => {
    const gw = fakeGateway({});
    (gw as unknown as { gatewayVersion: string }).gatewayVersion = "2026.9.6";
    gw.verboseFullApplied = true;
    let stored: Record<string, unknown> | null = initial;
    let hold: Promise<void> | null = null;
    const heldAtSend: Array<Record<string, unknown> | null> = [];
    const actions: Array<Record<string, unknown>> = [];
    const base = gw.request.bind(gw);
    gw.request = async (method: string, params: Record<string, unknown>, timeoutMs?: number) => {
      if (method === "sessions.describe") {
        gw.calls.push([method, params]);
        return { payload: { session: describedWith(stored === null ? null : { v: 1, ...stored }) } };
      }
      if (isPolicyGet(method, params)) {
        gw.calls.push([method, params]);
        return { payload: policyGetAnswer(stored) };
      }
      if (method === "knowledge.sources" && agentMode !== undefined) {
        gw.calls.push([method, params]);
        return { payload: { ...SOURCES_ALICE, injection: agentMode } };
      }
      if (method === "plugins.sessionAction") {
        gw.calls.push([method, params]);
        actions.push(params);
        if (hold !== null && (params.payload as { sources?: unknown } | undefined)?.sources !== undefined) {
          await hold;
        }
        const payload = params.payload as Record<string, unknown> | undefined;
        stored =
          params.actionId === "policy.reset"
            ? null
            : Object.fromEntries(Object.entries(payload ?? {}).filter(([k]) => k !== "reset"));
        return { payload: liveAnswer(params) };
      }
      if (method === "chat.send") heldAtSend.push(stored);
      return base(method, params, timeoutMs);
    };
    return {
      gw,
      heldAtSend,
      actions,
      current: () => stored,
      holdWrites: () => {
        let release: () => void = () => {};
        hold = new Promise<void>((r) => {
          release = r;
        });
        return () => {
          hold = null;
          release();
        };
      },
    };
  };

  const setup = async (initial: Record<string, unknown> | null, agentMode?: string) => {
    const g = statefulGateway(initial, agentMode);
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => g.gw as never);
    const w = writerSpy();
    const reg = new SessionRegistry(servedMap(config, w), () => 1000);
    const session = await reg.acquire(ROUTING);
    await sleep(5);
    const send = (extra: Record<string, unknown>, report: SendReport = {}) =>
      performSend(
        session,
        {
          ...ROUTING,
          text: "bonjour",
          clientMessageId: `cm-${Math.random()}`,
          messageId: "um-1",
          providerResetCount: null,
          outboxId: "ob-1",
          dispatchAgeMs: 0,
          switchedFromAgentId: null,
          switchedFromInstanceName: null,
          sessionSettings: null,
          referenceAttachments: [],
          config: null,
          ...extra,
        } as unknown as Parameters<typeof performSend>[1],
        w,
        null,
        null,
        null,
        Date.now(),
        config,
        undefined,
        report,
      );
    const apply = (choice: Record<string, unknown>, revision: number) =>
      performKnowledgeApply(
        session,
        parseKnowledgeBody(JSON.stringify({ ...ROUTING, op: "apply", choice, revision })) as never,
        config,
      );
    return { ...g, send, apply };
  };

  // Codex pass 13: ticking sources means "search these" — over an `off` agent default
  // the choice carries `auto`, on the send path and the on-the-spot apply alike.
  it("sources over an agent default turned `off` since: rewritten with `auto` before the send", async () => {
    const g = await setup({ sources: ["docs"] }, "off");
    await g.send({ knowledgeChoice: { kind: "sources", sources: ["docs"] }, knowledgeRevision: 1 });
    expect(g.actions.map((a) => a.payload)).toEqual([{ reset: true, sources: ["docs"], injection: "auto" }]);
    expect(g.heldAtSend).toEqual([{ sources: ["docs"], injection: "auto" }]);
  });

  it("…and an apply that did so is what an older send, running under it, checks for", async () => {
    const g = await setup(null, "off");
    expect((await g.apply({ kind: "sources", sources: ["docs"] }, 2)).ok).toBe(true);
    await g.send({ knowledgeChoice: { kind: "off" }, knowledgeRevision: 1 });
    expect(g.heldAtSend).toEqual([{ sources: ["docs"], injection: "auto" }]);    // Same when a SEND put it there: the older send checks the override that send wrote.
    const h = await setup(null, "off");
    await h.send({ knowledgeChoice: { kind: "sources", sources: ["docs"] }, knowledgeRevision: 2 });
    await h.send({ knowledgeChoice: { kind: "off" }, knowledgeRevision: 1 });
    expect(h.heldAtSend).toEqual([
      { sources: ["docs"], injection: "auto" },
      { sources: ["docs"], injection: "auto" },
    ]);
  });

  it("an active agent default: the choice keeps following it (no mode written)", async () => {
    const g = await setup(null, "hybrid");
    await g.send({ knowledgeChoice: { kind: "sources", sources: ["docs"] }, knowledgeRevision: 1 });
    expect(g.actions.map((a) => a.payload)).toEqual([{ reset: true, sources: ["docs"] }]);
  });

  it("an OLDER apply still writing when the send describes: the send re-reads under the lock and puts its own choice back before chat.send", async () => {
    // The owner went sources -> off; `off` (rev 2) is on the session. The rev-1 apply was
    // checked before `off` existed and its write is in flight.
    const g = await setup({ injection: "off" });
    const release = g.holdWrites();
    const late = g.apply({ kind: "sources", sources: ["docs"] }, 1);
    await sleep(5);
    const report: SendReport = {};
    const sending = g.send({ knowledgeChoice: { kind: "off" }, knowledgeRevision: 2 }, report);
    await sleep(10);
    release();
    await late;
    await sending;
    // What the session held when the turn went out: the owner's LATEST choice — and
    // still holds once everything settled (the late write never lands last).
    expect(g.heldAtSend).toEqual([{ injection: "off" }]);
    expect(g.current()).toEqual({ injection: "off" });
    expect(report.knowledge?.status).toBe("applied");
  });

  it("an OLDER apply arriving after a send noted a newer revision is refused — no write", async () => {
    const g = await setup(null);
    await g.send({ knowledgeChoice: { kind: "off" }, knowledgeRevision: 3 });
    const before = g.actions.length;
    expect(await g.apply({ kind: "sources", sources: ["docs"] }, 2)).toEqual({ ok: false, reason: "superseded" });
    expect(g.actions.length).toBe(before);
  });

  it("a send decided at an older gate, after a NEWER send put its choice on the session: it goes out under the newest (confirmed) choice", async () => {
    const g = await setup(null);
    await g.send({ knowledgeChoice: { kind: "off" }, knowledgeRevision: 5 });
    const report: SendReport = {};
    const before = g.actions.length;
    await g.send({ knowledgeChoice: { kind: "sources", sources: ["graph"] }, knowledgeRevision: 4 }, report);
    expect(g.actions.length).toBe(before);
    expect(g.heldAtSend).toEqual([{ injection: "off" }, { injection: "off" }]);
    expect(report.knowledge).toEqual({ status: "superseded", revision: 4 });
  });

  it("a send deciding an older revision than an apply that already landed: the newer choice stands", async () => {
    const g = await setup(null);
    expect((await g.apply({ kind: "off" }, 5)).ok).toBe(true);
    const report: SendReport = {};
    const before = g.actions.length;
    await g.send({ knowledgeChoice: { kind: "sources", sources: ["graph"] }, knowledgeRevision: 4 }, report);
    expect(g.actions.length).toBe(before);
    expect(g.heldAtSend).toEqual([{ injection: "off" }]);
    expect(report.knowledge).toEqual({ status: "superseded", revision: 4 });
  });
});

// --- Codex pass 2 --------------------------------------------------------------------

describe("the guards: an in-use guard is never evicted (codex P2)", () => {
  it("past the soft cap only an IDLE, STALE guard goes; a busy one keeps its identity and revision", async () => {
    const t0 = 1_000_000;
    const busyKey = "agent:alice:busy";
    const busy = knowledgeGuard("i", busyKey, t0);
    noteKnowledgeRevision(busy, 7);
    let release: () => void = () => {};
    const held = withKnowledgeLock(busy, () => new Promise<void>((r) => (release = r)));
    busy.lastUsed = t0; // the oldest in the map, and stale by time
    for (let i = 0; i < KNOWLEDGE_GUARD_SOFT_CAP - 1; i += 1) knowledgeGuard("i", `k${i}`, t0);
    expect(knowledgeGuardCount()).toBe(KNOWLEDGE_GUARD_SOFT_CAP);
    // Everything is past the idle bound; the busy one is first in line — and skipped.
    knowledgeGuard("i", "new-1", t0 + KNOWLEDGE_GUARD_IDLE_MS + 1);
    expect(knowledgeGuardCount()).toBe(KNOWLEDGE_GUARD_SOFT_CAP);
    const again = knowledgeGuard("i", busyKey, t0 + KNOWLEDGE_GUARD_IDLE_MS + 2);
    expect(again).toBe(busy);
    expect(again.revision).toBe(7);
    expect(busy.pending).toBe(1);
    await sleep(1);
    release();
    await held;
  });

  it("nothing idle long enough: the map grows past the soft cap rather than drop a recent guard", () => {
    const t0 = 5_000_000;
    const first = knowledgeGuard("i", "first", t0);
    noteKnowledgeRevision(first, 3);
    for (let i = 0; i < KNOWLEDGE_GUARD_SOFT_CAP - 1; i += 1) knowledgeGuard("i", `r${i}`, t0);
    knowledgeGuard("i", "one-more", t0 + 1_000);
    expect(knowledgeGuardCount()).toBe(KNOWLEDGE_GUARD_SOFT_CAP + 1);
    expect(knowledgeGuard("i", "first", t0 + 2_000)).toBe(first);
  });

  it("an idle, stale guard is the one evicted", () => {
    const t0 = 9_000_000;
    knowledgeGuard("i", "stale", t0);
    for (let i = 0; i < KNOWLEDGE_GUARD_SOFT_CAP - 1; i += 1) knowledgeGuard("i", `s${i}`, t0 + KNOWLEDGE_GUARD_IDLE_MS);
    knowledgeGuard("i", "fresh", t0 + KNOWLEDGE_GUARD_IDLE_MS + 1);
    expect(knowledgeGuardCount()).toBe(KNOWLEDGE_GUARD_SOFT_CAP);
    expect(knowledgeGuard("i", "stale", t0 + KNOWLEDGE_GUARD_IDLE_MS + 2).revision).toBe(0);
  });
});

describe("a roster past the window is covered over successive syncs (codex pass 21)", () => {
  afterEach(() => clearKnowledgeDiscoveryCursors());
  const ids = Array.from({ length: 150 }, (_, i) => `agent-${i}`);
  const answering = () => requester((_m, params) => ({ ...SOURCES_ALICE, agentId: params.agentId }));

  it("150 agents, two syncs: every one probed; each sync answers ONLY its window", async () => {
    const first = await probeKnowledgeForAgents(answering().conn, ids, { cursorKey: "gw-a" });
    const second = await probeKnowledgeForAgents(answering().conn, ids, { cursorKey: "gw-a" });
    expect(Object.keys(first)).toEqual(ids.slice(0, 100));
    // The next window starts where the first stopped, wrapping round.
    expect(Object.keys(second)).toEqual([...ids.slice(100), ...ids.slice(0, 50)]);
    const covered = new Set([...Object.keys(first), ...Object.keys(second)]);
    expect(covered.size).toBe(150);
    // An agent outside a window gets NO entry at all — never an "unknown" that could
    // stand for it.
    expect(ids.slice(100).some((id) => id in first)).toBe(false);
  });

  it("the cursor advances by what the window ANSWERED; cursors are per instance", async () => {
    const hang = requester(() => new Promise(() => {}));
    await probeKnowledgeForAgents(hang.conn, ids, { cursorKey: "gw-b", budgetMs: 30 });
    // Nothing answered: the next sync starts at the same place.
    expect(Object.keys(await probeKnowledgeForAgents(answering().conn, ids, { cursorKey: "gw-b" }))[0]).toBe("agent-0");
    // Another instance keeps its own cursor.
    expect(Object.keys(await probeKnowledgeForAgents(answering().conn, ids, { cursorKey: "gw-c" }))[0]).toBe("agent-0");
    // A roster within the window always probes everyone from the start.
    const small = ids.slice(0, 10);
    await probeKnowledgeForAgents(answering().conn, small, { cursorKey: "gw-d" });
    expect(Object.keys(await probeKnowledgeForAgents(answering().conn, small, { cursorKey: "gw-d" }))).toEqual(small);
  });
});

describe("discovery's knowledge probe is bounded (codex P2)", () => {
  it("a method that never answers: the probe returns on its budget, every agent unknown — not absent", async () => {
    const hang = requester(() => new Promise(() => {}));
    const started = Date.now();
    const out = await probeKnowledgeForAgents(hang.conn, ["alice", "files", "bob", "carol", "dan", "eve"], {
      budgetMs: 60,
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(Object.values(out).every((p) => !p.available && p.reason === "unreadable")).toBe(true);
    expect(Object.keys(out)).toHaveLength(6);
  });

  it("the default budget holds the whole discovery to seconds, not minutes, whatever the agent count", async () => {
    vi.useFakeTimers();
    try {
      const hang = requester(() => new Promise(() => {}));
      const ids = Array.from({ length: 100 }, (_, i) => `agent-${i}`);
      let done = false;
      const p = probeKnowledgeForAgents(hang.conn, ids).then((o) => {
        done = true;
        return o;
      });
      await vi.advanceTimersByTimeAsync(KNOWLEDGE_PROBE_BUDGET_MS);
      expect(done).toBe(true);
      expect(Object.keys(await p)).toHaveLength(100);
      expect(KNOWLEDGE_PROBE_BUDGET_MS).toBeLessThanOrEqual(10_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a few at a time", async () => {
    let live = 0;
    let peak = 0;
    const slow = requester(async () => {
      live += 1;
      peak = Math.max(peak, live);
      await sleep(5);
      live -= 1;
      return SOURCES_ALICE;
    });
    const out = await probeKnowledgeForAgents(slow.conn, Array.from({ length: 12 }, (_, i) => `a${i}`));
    expect(peak).toBeLessThanOrEqual(KNOWLEDGE_PROBE_CONCURRENCY);
    expect(Object.values(out).every((p) => p.available)).toBe(true);
  });
});

// --- Codex pass 3 --------------------------------------------------------------------

describe("a write counts only with the plugin's proof (codex pass 3)", () => {
  const base = { sessionKey: "agent:alice:k", agentId: "alice", sessionAbsent: false, stored: null };
  it("an empty, malformed or non-matching success is `unconfirmed`, never applied", async () => {
    const answers: unknown[] = [
      {},
      { ok: true },
      { ok: true, result: { nope: 1 } },
      // A snapshot that does not show the choice.
      { ok: true, result: { injection: "auto", effectiveSources: ["graph"], origin: { injection: "agent", sources: "session" } } },
      { ok: true, result: { injection: "auto", effectiveSources: ["docs"], origin: { injection: "agent", sources: "agent" } } },
    ];
    for (const a of answers) {
      const r = requester(() => a);
      await expect(
        enforceKnowledgePolicy({ ...base, conn: r.conn, choice: { kind: "sources", sources: ["docs"] } }),
      ).rejects.toMatchObject({ reason: "unconfirmed" });
    }
    const offWrong = requester(() => ({ ok: true, result: { injection: "auto", effectiveSources: [], origin: { injection: "agent", sources: "agent" } } }));
    await expect(enforceKnowledgePolicy({ ...base, conn: offWrong.conn, choice: { kind: "off" } })).rejects.toMatchObject({
      reason: "unconfirmed",
    });
    const resetWrong = requester(() => ({ ok: true, result: { injection: "off", effectiveSources: [], origin: { injection: "session", sources: "agent" } } }));
    await expect(
      enforceKnowledgePolicy({ ...base, conn: resetWrong.conn, choice: { kind: "default" }, stored: { injection: "off" } }),
    ).rejects.toMatchObject({ reason: "unconfirmed" });
  });

  it("performSend: an unproven write withholds the turn", async () => {
    const gw = fakeGateway({ describe: [describedWith(null)] as never, answers: { "plugins.sessionAction": { payload: { ok: true } } } });
    (gw as unknown as { gatewayVersion: string }).gatewayVersion = "2026.9.6";
    gw.verboseFullApplied = true;
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => gw as never);
    const w = writerSpy();
    const reg = new SessionRegistry(servedMap(config, w), () => 1000);
    const session = await reg.acquire(ROUTING);
    await sleep(5);
    const report: SendReport = {};
    let error: unknown = null;
    await performSend(
      session,
      {
        ...ROUTING, text: "x", clientMessageId: "cm-u", messageId: "um", providerResetCount: null, outboxId: "ob",
        dispatchAgeMs: 0, switchedFromAgentId: null, switchedFromInstanceName: null, sessionSettings: null,
        referenceAttachments: [], config: null, knowledgeChoice: { kind: "off" }, knowledgeRevision: 1,
      } as unknown as Parameters<typeof performSend>[1],
      w, null, null, null, Date.now(), config, undefined, report,
    ).catch((e) => {
      error = e;
    });
    expect(gw.calls.some(([m]) => m === "chat.send")).toBe(false);
    expect((error as KnowledgePolicyNotAppliedError).reason).toBe("unconfirmed");
    expect(report.knowledge).toEqual({ status: "failed", reason: "unconfirmed", revision: 1 });
  });
});

describe("the last check before chat.send (codex pass 3, P1)", () => {
  /** The owner makes a NEWER choice while the turn is being prepared — right after the
   *  send put its own choice on the session. The newer apply is noted on arrival; its
   *  own work is then held (or fails), so the session never holds it. */
  const race = async (newerOutcome: "fails" | "held") => {
    const gw = fakeGateway({});
    (gw as unknown as { gatewayVersion: string }).gatewayVersion = "2026.9.6";
    gw.verboseFullApplied = true;
    let stored: Record<string, unknown> | null = null;
    let holdDescribes: Promise<void> | null = null;
    let releaseDescribes: () => void = () => {};
    let newer: Promise<unknown> | null = null;
    let session: Awaited<ReturnType<SessionRegistry["acquire"]>>;
    const base = gw.request.bind(gw);
    gw.request = async (method: string, params: Record<string, unknown>, timeoutMs?: number) => {
      if (method === "sessions.describe") {
        gw.calls.push([method, params]);
        return { payload: { session: describedWith(stored === null ? null : { v: 1, ...stored }) } };
      }
      if (method === "plugins.sessionAction") {
        gw.calls.push([method, params]);
        const isNewer = (params.payload as { sources?: string[] } | undefined)?.sources?.includes("archive") === true;
        if (isNewer && newerOutcome === "held") await holdDescribes;
        if (isNewer) return { payload: { ok: false, error: "x", code: "overrides_disabled" } };
        const payload = params.payload as Record<string, unknown> | undefined;
        stored = Object.fromEntries(Object.entries(payload ?? {}).filter(([k]) => k !== "reset"));
        // The send's own write just landed: the owner's newer choice arrives NOW.
        if (newer === null) {
          if (newerOutcome === "held") {
            holdDescribes = new Promise<void>((r) => (releaseDescribes = r));
          }
          newer = performKnowledgeApply(
            session,
            parseKnowledgeBody(JSON.stringify({ ...ROUTING, op: "apply", choice: { kind: "sources", sources: ["archive"] }, revision: 3 })) as never,
            config,
          );
        }
        return { payload: liveAnswer(params) };
      }
      return base(method, params, timeoutMs);
    };
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => gw as never);
    const w = writerSpy();
    const reg = new SessionRegistry(servedMap(config, w), () => 1000);
    session = await reg.acquire(ROUTING);
    await sleep(5);
    const report: SendReport = {};
    let error: unknown = null;
    await performSend(
      session,
      {
        ...ROUTING, text: "x", clientMessageId: "cm-r", messageId: "um", providerResetCount: null, outboxId: "ob",
        dispatchAgeMs: 0, switchedFromAgentId: null, switchedFromInstanceName: null, sessionSettings: null,
        referenceAttachments: [], config: null, knowledgeChoice: { kind: "off" }, knowledgeRevision: 2,
      } as unknown as Parameters<typeof performSend>[1],
      w, null, null, null, Date.now(), config, undefined, report,
    ).catch((e) => {
      error = e;
    });
    releaseDescribes();
    await newer;
    return { sent: gw.calls.some(([m]) => m === "chat.send"), error, report };
  };

  it("a newer choice whose apply failed: the prepared turn is withheld (superseded), never sent under the old one", async () => {
    const r = await race("fails");
    expect(r.sent).toBe(false);
    expect((r.error as KnowledgePolicyNotAppliedError).reason).toBe("superseded");
    expect(r.report.knowledge).toEqual({ status: "failed", reason: "superseded", revision: 2 });
  });

  it("a newer choice announced but not yet on the session: withheld too", async () => {
    const r = await race("held");
    expect(r.sent).toBe(false);
    expect((r.error as KnowledgePolicyNotAppliedError).reason).toBe("superseded");
  });
});

// --- Codex pass 5: the apply is announced before ANY await ------------------------------

describe("an on-the-spot apply is announced on arrival, before any await (codex pass 5)", () => {
  const sendAfter = async (arrange: (session: Awaited<ReturnType<SessionRegistry["acquire"]>>, gw: ReturnType<typeof fakeGateway>) => Promise<() => void>) => {
    const gw = fakeGateway({});
    (gw as unknown as { gatewayVersion: string }).gatewayVersion = "2026.9.6";
    gw.verboseFullApplied = true;
    let hold: Promise<void> | null = null;
    let release: () => void = () => {};
    const base = gw.request.bind(gw);
    gw.request = async (method: string, params: Record<string, unknown>, timeoutMs?: number) => {
      if (method === "sessions.describe") {
        gw.calls.push([method, params]);
        if (hold !== null) {
          const h = hold;
          hold = null;
          await h;
        }
        return { payload: { session: describedWith(null) } };
      }
      if (method === "plugins.sessionAction") {
        gw.calls.push([method, params]);
        return { payload: liveAnswer(params) };
      }
      return base(method, params, timeoutMs);
    };
    (gw as unknown as { holdNextDescribe: () => void }).holdNextDescribe = () => {
      hold = new Promise<void>((r) => (release = r));
    };
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => gw as never);
    const w = writerSpy();
    const reg = new SessionRegistry(servedMap(config, w), () => 1000);
    const session = await reg.acquire(ROUTING);
    await sleep(5);
    const cleanup = await arrange(session, gw);
    const report: SendReport = {};
    let error: unknown = null;
    await performSend(
      session,
      {
        ...ROUTING, text: "x", clientMessageId: `cm-${Math.random()}`, messageId: "um", providerResetCount: null, outboxId: "ob",
        dispatchAgeMs: 0, switchedFromAgentId: null, switchedFromInstanceName: null, sessionSettings: null,
        referenceAttachments: [], config: null, knowledgeChoice: { kind: "off" }, knowledgeRevision: 2,
      } as unknown as Parameters<typeof performSend>[1],
      w, null, null, null, Date.now(), config, undefined, report,
    ).catch((e) => {
      error = e;
    });
    release();
    cleanup();
    return { sent: gw.calls.some(([m]) => m === "chat.send"), error, report };
  };
  const newerBody = () =>
    parseKnowledgeBody(JSON.stringify({ ...ROUTING, op: "apply", choice: { kind: "sources", sources: ["archive"] }, revision: 3 })) as never;

  it("the claim of a NEWER apply is still open when a prepared send reaches its last check: the send is withheld", async () => {
    let pending: Promise<unknown> | null = null;
    const r = await sendAfter(async (session, gw) => {
      // Trusted-proxy: the apply's ownership claim asks the gateway first — held open.
      (gw as unknown as { holdNextDescribe: () => void }).holdNextDescribe();
      const tp = { ...(config as unknown as Record<string, unknown>), openclawAuthMode: "trusted-proxy", openclawToken: "" } as unknown as BridgeConfig;
      pending = performKnowledgeApply(session, newerBody(), tp);
      await sleep(5);
      return () => {
        void pending?.catch(() => {});
      };
    });
    expect(r.sent).toBe(false);
    expect((r.error as KnowledgePolicyNotAppliedError).reason).toBe("superseded");
  });

  it("the /knowledge route calls it before acquiring the session", () => {
    const src = readFileSync(new URL("../src/server.ts", import.meta.url), "utf-8");
    const route = src.slice(src.indexOf('if (req.url === "/knowledge")'));
    const announce = route.indexOf("announceKnowledgeApply(kb).superseded");
    const acquire = route.indexOf("registry.acquire(toRouting(kb, kb.instanceName))");
    expect(announce).toBeGreaterThan(-1);
    expect(acquire).toBeGreaterThan(announce);
  });

  it("the route announces BEFORE the session is even acquired, on the key the registry derives", async () => {
    const r = await sendAfter(async () => {
      expect(announceKnowledgeApply(newerBody()).superseded).toBe(false);
      return () => {};
    });
    expect(r.sent).toBe(false);
    expect(r.report.knowledge).toEqual({ status: "failed", reason: "superseded", revision: 2 });
    // …and an older one arriving afterwards is refused at the door.
    const older = parseKnowledgeBody(JSON.stringify({ ...ROUTING, op: "apply", choice: { kind: "off" }, revision: 1 })) as never;
    expect(announceKnowledgeApply(older).superseded).toBe(true);
  });
});

// --- Codex pass 7: the session still HOLDS the choice at the request ---------------------

describe("a reset from another client between the write and the send (codex pass 7)", () => {
  /** A gateway that remembers the override; `resetAfterWrites` drops it (as a reset
   *  rebuilding the entry does) right after that many writes; `sticky: false` makes
   *  every write vanish. */
  const setupReset = async (opts: { resetAfterWrites: number[]; sticky?: boolean }) => {
    const gw = fakeGateway({});
    (gw as unknown as { gatewayVersion: string }).gatewayVersion = "2026.9.6";
    gw.verboseFullApplied = true;
    let stored: Record<string, unknown> | null = null;
    let writes = 0;
    const heldAtSend: Array<Record<string, unknown> | null> = [];
    const base = gw.request.bind(gw);
    gw.request = async (method: string, params: Record<string, unknown>, timeoutMs?: number) => {
      if (method === "sessions.describe") {
        gw.calls.push([method, params]);
        return { payload: { session: describedWith(stored === null ? null : { v: 1, ...stored }) } };
      }
      if (isPolicyGet(method, params)) {
        gw.calls.push([method, params]);
        return { payload: policyGetAnswer(stored) };
      }
      if (method === "plugins.sessionAction") {
        gw.calls.push([method, params]);
        const payload = params.payload as Record<string, unknown> | undefined;
        stored = Object.fromEntries(Object.entries(payload ?? {}).filter(([k]) => k !== "reset"));
        writes += 1;
        const answer = liveAnswer(params);
        // Another client resets the session right after this write.
        if (opts.resetAfterWrites.includes(writes) || opts.sticky === false) stored = null;
        return { payload: answer };
      }
      if (method === "chat.send") heldAtSend.push(stored);
      return base(method, params, timeoutMs);
    };
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => gw as never);
    const w = writerSpy();
    const reg = new SessionRegistry(servedMap(config, w), () => 1000);
    const session = await reg.acquire(ROUTING);
    await sleep(5);
    const report: SendReport = {};
    const sendOnce = () =>
      performSend(
        session,
        {
          ...ROUTING, text: "x", clientMessageId: "cm-reset", messageId: "um", providerResetCount: null, outboxId: "ob",
          dispatchAgeMs: 0, switchedFromAgentId: null, switchedFromInstanceName: null, sessionSettings: null,
          referenceAttachments: [], config: null, knowledgeChoice: { kind: "off" }, knowledgeRevision: 2,
        } as unknown as Parameters<typeof performSend>[1],
        w, null, null, null, Date.now(), config, undefined, report,
      );
    return { gw, heldAtSend, report, sendOnce, writes: () => writes };
  };

  it("the choice dropped before the send: withheld, prepared again ONCE, then sent holding it", async () => {
    const r = await setupReset({ resetAfterWrites: [1] });
    await withOneRePreparation(r.sendOnce, "c1");
    expect(r.heldAtSend).toEqual([{ injection: "off" }]);
    expect(r.writes()).toBe(2);
  });

  it("dropped again after the re-preparation: withheld by name, never sent", async () => {
    const r = await setupReset({ resetAfterWrites: [], sticky: false });
    await expect(withOneRePreparation(r.sendOnce, "c1")).rejects.toMatchObject({ reason: "session_replaced" });
    expect(r.heldAtSend).toEqual([]);
    expect(r.report.knowledge).toEqual({ status: "failed", reason: "session_replaced", revision: 2 });
  });
});

// --- Codex pass 11: a foreign one-shot put on the session right before the send -------

describe("a one-shot put on the session between the write and the send (codex pass 11)", () => {
  const setupShot = async (injectAt: "first" | "always") => {
    const gw = fakeGateway({});
    (gw as unknown as { gatewayVersion: string }).gatewayVersion = "2026.9.6";
    gw.verboseFullApplied = true;
    let stored: Record<string, unknown> | null = null;
    let gets = 0;
    const heldAtSend: Array<Record<string, unknown> | null> = [];
    const base = gw.request.bind(gw);
    gw.request = async (method: string, params: Record<string, unknown>, timeoutMs?: number) => {
      if (isPolicyGet(method, params)) {
        gw.calls.push([method, params]);
        gets += 1;
        // Another client (`/knowledge once graph`) adds a one-shot right before this read.
        if (injectAt === "always" || gets === 1) stored = { ...(stored ?? {}), oneShot: true };
        return { payload: policyGetAnswer(stored) };
      }
      if (method === "sessions.describe") {
        gw.calls.push([method, params]);
        const { oneShot, ...held } = (stored ?? {}) as Record<string, unknown>;
        const value = stored === null ? null : { v: 1, ...held, ...(oneShot ? { oneShot: ONE_SHOT } : {}) };
        return { payload: { session: describedWith(value) } };
      }
      if (method === "plugins.sessionAction") {
        gw.calls.push([method, params]);
        const payload = params.payload as Record<string, unknown> | undefined;
        // reset:true starts from an empty state: the one-shot is gone (policy.ts:283).
        stored = Object.fromEntries(Object.entries(payload ?? {}).filter(([k]) => k !== "reset"));
        return { payload: liveAnswer(params) };
      }
      if (method === "chat.send") heldAtSend.push(stored);
      return base(method, params, timeoutMs);
    };
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => gw as never);
    const w = writerSpy();
    const reg = new SessionRegistry(servedMap(config, w), () => 1000);
    const session = await reg.acquire(ROUTING);
    await sleep(5);
    const report: SendReport = {};
    const sendOnce = () =>
      performSend(
        session,
        {
          ...ROUTING, text: "x", clientMessageId: "cm-shot", messageId: "um", providerResetCount: null, outboxId: "ob",
          dispatchAgeMs: 0, switchedFromAgentId: null, switchedFromInstanceName: null, sessionSettings: null,
          referenceAttachments: [], config: null, knowledgeChoice: { kind: "off" }, knowledgeRevision: 2,
        } as unknown as Parameters<typeof performSend>[1],
        w, null, null, null, Date.now(), config, undefined, report,
      );
    return { heldAtSend, report, sendOnce };
  };

  it("withheld at the last gate, prepared again ONCE — the rewrite clears the one-shot — then sent holding the choice", async () => {
    const r = await setupShot("first");
    await withOneRePreparation(r.sendOnce, "c1");
    expect(r.heldAtSend).toEqual([{ injection: "off" }]);
  });

  it("put back every time: withheld by name, never sent", async () => {
    const r = await setupShot("always");
    await expect(withOneRePreparation(r.sendOnce, "c1")).rejects.toMatchObject({ reason: "session_replaced" });
    expect(r.heldAtSend).toEqual([]);
    expect(r.report.knowledge).toEqual({ status: "failed", reason: "session_replaced", revision: 2 });
  });
});

// --- Codex pass 8: a NEWER confirmed choice must still be on the session -------------

describe("a send running under a newer confirmed choice checks THAT choice is still there (codex pass 8)", () => {
  it("revision 2 confirmed while revision 1 was prepared, then a reset: withheld (session_replaced), never sent under the agent default", async () => {
    const gw = fakeGateway({});
    (gw as unknown as { gatewayVersion: string }).gatewayVersion = "2026.9.6";
    gw.verboseFullApplied = true;
    let stored: Record<string, unknown> | null = null;
    let resetOnNextGet = false;
    const base = gw.request.bind(gw);
    gw.request = async (method: string, params: Record<string, unknown>, timeoutMs?: number) => {
      if (isPolicyGet(method, params)) {
        gw.calls.push([method, params]);
        // Another client resets the session right before this (last) read.
        if (resetOnNextGet) stored = null;
        return { payload: policyGetAnswer(stored) };
      }
      if (method === "sessions.describe") {
        gw.calls.push([method, params]);
        return { payload: { session: describedWith(stored === null ? null : { v: 1, ...stored }) } };
      }
      if (method === "plugins.sessionAction") {
        gw.calls.push([method, params]);
        const payload = params.payload as Record<string, unknown> | undefined;
        stored = params.actionId === "policy.reset" ? null : Object.fromEntries(Object.entries(payload ?? {}).filter(([k]) => k !== "reset"));
        return { payload: liveAnswer(params) };
      }
      return base(method, params, timeoutMs);
    };
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => gw as never);
    const w = writerSpy();
    const reg = new SessionRegistry(servedMap(config, w), () => 1000);
    const session = await reg.acquire(ROUTING);
    await sleep(5);
    // The owner's NEWER choice (off, revision 2) is confirmed on the session…
    const applied = await performKnowledgeApply(
      session,
      parseKnowledgeBody(JSON.stringify({ ...ROUTING, op: "apply", choice: { kind: "off" }, revision: 2 })) as never,
      config,
    );
    expect(applied.ok).toBe(true);
    // …then a send prepared under revision 1 goes: its first describe sees `off`; the
    // session is reset before its LAST read.
    resetOnNextGet = true;
    const report: SendReport = {};
    let error: unknown = null;
    await performSend(
      session,
      {
        ...ROUTING, text: "x", clientMessageId: "cm-p8", messageId: "um", providerResetCount: null, outboxId: "ob",
        dispatchAgeMs: 0, switchedFromAgentId: null, switchedFromInstanceName: null, sessionSettings: null,
        referenceAttachments: [], config: null, knowledgeChoice: { kind: "sources", sources: ["docs"] }, knowledgeRevision: 1,
      } as unknown as Parameters<typeof performSend>[1],
      w, null, null, null, Date.now(), config, undefined, report,
    ).catch((e) => {
      error = e;
    });
    expect(gw.calls.some(([m]) => m === "chat.send")).toBe(false);
    expect((error as KnowledgePolicyNotAppliedError).reason).toBe("session_replaced");
    expect(report.knowledge).toEqual({ status: "failed", reason: "session_replaced", revision: 1 });
  });

  // Codex pass 12: the turn runs under a NEWER confirmed `default` — a default, even
  // though this send was prepared for another choice.
  it("a newer confirmed `default`, overrides disabled since: the older non-default send goes out under the default", async () => {
    const g = knowledgeGuard("i", "k-newer-default");
    noteKnowledgeRevision(g, 2);
    noteAppliedKnowledgeRevision(g, 2, null);
    for (const read of [
      { kind: "held", override: null, overridesAllowed: false } as const,
      { kind: "plugin_gone" } as const,
    ]) {
      const gate = knowledgeChatSendGate(g, 1, () => {}, {
        desired: { injection: "off" },
        read: async () => read,
      });
      await gate.refresh?.();
      expect(() => gate.check()).not.toThrow();
    }
    // An UNKNOWN confirmed override still defers to the send's own choice.
    const h = knowledgeGuard("i", "k-unknown-applied");
    noteKnowledgeRevision(h, 2);
    h.appliedRevision = 2;
    h.appliedOverride = undefined;
    const unknown = knowledgeChatSendGate(h, 1, () => {}, {
      desired: { injection: "off" },
      read: async () => ({ kind: "held", override: { injection: "off" }, overridesAllowed: false }),
    });
    await unknown.refresh?.();
    expect(() => unknown.check()).toThrow(expect.objectContaining({ reason: "overrides_disabled" }));
  });

  it("…and with the newer choice still there, the older send goes out under it", async () => {
    const g = knowledgeGuard("i", "k-still");
    noteKnowledgeRevision(g, 2);
    noteAppliedKnowledgeRevision(g, 2, { injection: "off" });
    const gate = knowledgeChatSendGate(g, 1, () => {}, {
      desired: { sources: ["docs"] },
      read: async () => ({ kind: "held", override: { injection: "off" }, overridesAllowed: true }),
    });
    await gate.refresh?.();
    expect(() => gate.check()).not.toThrow();
    const gone = knowledgeChatSendGate(g, 1, () => {}, {
      desired: { sources: ["docs"] },
      read: async () => ({ kind: "held", override: null, overridesAllowed: true }),
    });
    await gone.refresh?.();
    expect(() => gone.check()).toThrow(KnowledgePolicyNotAppliedError);
  });
});
