/// <reference types="vite/client" />
//
// Bridge compat: pure helpers (version parsing / body normalization / summary),
// the poller's storage through MOCKED fetches of both bridge endpoints
// (/health + /capabilities), the LEGACY-bridge backward skew (compat:null),
// the serve-last-good failure path, and the REAL RBAC gates on the public
// queries (bridge.read / active-user + chat ownership).

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import {
  boundCompatManifest,
  capabilitiesForInstance,
  compareVersions,
  dedupeTargetsByInstance,
  boundProtocolInfo,
  mergeProtocolInfo,
  normalizeCapabilitiesBody,
  normalizeCompatTarget,
  parseVersion,
  providerCapabilityTable,
  providerSupport,
  resolveCapabilitiesFromManifest,
  summarizeCompat,
  withinSupport,
  type CompatTarget,
} from "./lib/compat";
import { LIVE_CAPABILITIES_BODY } from "../src/chat/bridgeCapabilitiesFixture";

const modules = import.meta.glob("./**/*.ts");

// ---------------------------------------------------------------------------
// Fixtures. The protocol-2 body is the CONTRACT FIXTURE captured verbatim from
// a live bridge (src/chat/bridgeCapabilitiesFixture.ts — red-team P2-1: the
// cross-repo anchor with the REAL capability keys), extended with a second
// per-session target (bob, no captured version) for the dedupe scenario.
// ---------------------------------------------------------------------------

const MANIFEST = LIVE_CAPABILITIES_BODY.compat;
const ALICE_TARGET = LIVE_CAPABILITIES_BODY.targets[0];

const NEW_CAPABILITIES_BODY = {
  ...LIVE_CAPABILITIES_BODY,
  targets: [
    ALICE_TARGET,
    {
      ...ALICE_TARGET,
      key: "bob",
      agentId: "bob",
      gatewayVersion: null,
      capabilities: { agentsDiscovery: true },
    },
  ],
};

// An OLD bridge: only the pre-protocol-2 fields (backward skew path).
const LEGACY_CAPABILITIES_BODY = {
  instanceName: "main",
  capabilities: {
    kind: "openclaw",
    agentDiscovery: true,
    abort: true,
    history: true,
    attachments: true,
    media: true,
    streaming: "delta",
  },
};

const HEALTH_BODY = {
  status: "ok",
  startedAt: 1_000,
  targets: [
    {
      key: "alice",
      instanceName: "main",
      canonical: "alice",
      agentId: "alice",
      gatewayHost: "gateway.example.org:18789",
      state: "connected",
      lastOkAt: 9,
      attempts: 1,
      okCount: 1,
      errorCount: 0,
    },
  ],
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("parseVersion / compareVersions", () => {
  test("dotted numeric versions parse; junk does not", () => {
    expect(parseVersion("2026.6.5")).toEqual([2026, 6, 5]);
    // STRICT — aligned with the bridge parser: whitespace, missing or extra
    // segments all fail closed (badge can never contradict the bridge gating).
    expect(parseVersion(" 2026.5.19 ")).toBeNull();
    expect(parseVersion("2026.6")).toBeNull();
    expect(parseVersion("2026.6.5.1")).toBeNull();
    expect(parseVersion("")).toBeNull();
    expect(parseVersion("1.x")).toBeNull();
    expect(parseVersion("v2026.6.5")).toBeNull();
  });

  test("compare is segment-wise with missing segments = 0", () => {
    expect(compareVersions("2026.6.1", "2026.6.5")).toBeLessThan(0);
    expect(compareVersions("2026.6.5", "2026.5.19")).toBeGreaterThan(0);
    expect(compareVersions("2026.6", "2026.6.0")).toBeNull();
    expect(compareVersions("2026.6.5", "2026.6.5")).toBe(0);
    expect(compareVersions("garbage", "2026.6.5")).toBeNull();
  });
});

describe("withinSupport (fail CLOSED)", () => {
  const range = { min: "2026.5.19", maxValidated: "2026.6.5" };
  test("in-range and beyond-maxValidated are both within support", () => {
    expect(withinSupport(range, "2026.6.1")).toBe(true);
    expect(withinSupport(range, "2026.5.19")).toBe(true); // min inclusive
    expect(withinSupport(range, "2026.7.1")).toBe(true); // beyond validated, still supported
  });
  test("below min, unknown version, unparseable, or no range -> false", () => {
    expect(withinSupport(range, "2026.5.1")).toBe(false);
    expect(withinSupport(range, null)).toBe(false);
    expect(withinSupport(range, "dev-build")).toBe(false);
    expect(withinSupport(null, "2026.6.5")).toBe(false); // e.g. hermes today
  });
});

describe("normalizeCompatTarget (defensive parse)", () => {
  test("a full target drops key/agentId and keeps boolean capabilities", () => {
    const t = normalizeCompatTarget(NEW_CAPABILITIES_BODY.targets[0]);
    expect(t).toEqual({
      instanceName: "main",
      provider: "openclaw",
      gatewayVersion: "2026.5.19",
      capabilities: ALICE_TARGET.capabilities,
      versionBeyondValidated: false,
    });
  });

  test("versionBeyondValidated:true is preserved; non-boolean caps dropped", () => {
    const t = normalizeCompatTarget({
      instanceName: "main",
      provider: "openclaw",
      gatewayVersion: "2026.7.1",
      versionBeyondValidated: true,
      capabilities: { abort: true, streaming: "delta", _hidden: true, "": true },
    });
    expect(t?.versionBeyondValidated).toBe(true);
    expect(t?.capabilities).toEqual({ abort: true }); // "delta", "_hidden", "" dropped
  });

  test("a malformed target -> null (dropped)", () => {
    expect(normalizeCompatTarget({ provider: "openclaw" })).toBeNull();
    expect(normalizeCompatTarget(null)).toBeNull();
    expect(normalizeCompatTarget("nope")).toBeNull();
  });
});

describe("dedupeTargetsByInstance", () => {
  test("per-session duplicates collapse to one row, preferring a known version", () => {
    const mk = (gv: string | null): CompatTarget => ({
      instanceName: "main",
      provider: "openclaw",
      gatewayVersion: gv,
      capabilities: {},
      versionBeyondValidated: false,
    });
    const out = dedupeTargetsByInstance([mk(null), mk("2026.6.5"), mk(null)]);
    expect(out).toHaveLength(1);
    expect(out[0]!.gatewayVersion).toBe("2026.6.5");
  });
});

describe("normalizeCapabilitiesBody (new vs LEGACY bridge)", () => {
  test("a protocol-2 body normalizes versions + manifest + deduped targets", () => {
    const n = normalizeCapabilitiesBody(NEW_CAPABILITIES_BODY);
    expect(n.bridgeVersion).toBe(LIVE_CAPABILITIES_BODY.bridgeVersion);
    expect(n.protocolVersion).toBe(2);
    expect(n.compat).toEqual(MANIFEST);
    // alice + bob ride the SAME instance -> one stored target, version kept.
    expect(n.targets).toHaveLength(1);
    expect(n.targets[0]).toMatchObject({
      instanceName: "main",
      provider: "openclaw",
      gatewayVersion: "2026.5.19",
    });
  });

  test("a LEGACY body (old bridge, backward skew) -> nulls + empty targets", () => {
    const n = normalizeCapabilitiesBody(LEGACY_CAPABILITIES_BODY);
    expect(n.bridgeVersion).toBeNull();
    expect(n.protocolVersion).toBeNull();
    expect(n.compat).toBeNull();
    expect(n.targets).toEqual([]);
  });

  test("boundCompatManifest rejects non-objects and oversized blobs", () => {
    expect(boundCompatManifest("raw string")).toBeNull();
    expect(boundCompatManifest([1, 2, 3])).toBeNull();
    expect(boundCompatManifest({ big: "x".repeat(70 * 1024) })).toBeNull();
    expect(boundCompatManifest({ ok: true })).toEqual({ ok: true });
  });
});

describe("resolveCapabilitiesFromManifest (Convex mirrors the bridge)", () => {
  test("reads a provider's capability->minVersion table; odd shapes -> {}", () => {
    expect(providerCapabilityTable(MANIFEST, "openclaw").agentFiles).toBe(
      "2026.6.5",
    );
    expect(providerCapabilityTable(MANIFEST, "hermes")).toEqual({});
    expect(providerCapabilityTable(null, "openclaw")).toEqual({});
    expect(providerCapabilityTable({ providers: 7 }, "openclaw")).toEqual({});
  });

  test("a within-range version: 6.5 unlocks the 6.5-only caps", () => {
    const r = resolveCapabilitiesFromManifest(MANIFEST, "openclaw", "2026.6.5");
    expect(r.versionBeyondValidated).toBe(false);
    expect(r.capabilities.agentFiles).toBe(true);
    expect(r.capabilities.configDefaults).toBe(true);
    expect(r.capabilities.knobThinkingLevel).toBe(true);
  });

  test("6.1: the 6.5-only caps stay OFF, the 6.1 cap is ON", () => {
    const r = resolveCapabilitiesFromManifest(MANIFEST, "openclaw", "2026.6.1");
    expect(r.capabilities.agentFiles).toBe(false);
    expect(r.capabilities.configDefaults).toBe(false);
    expect(r.capabilities.inboundAttachments).toBe(true);
    expect(r.capabilities.knobThinkingLevel).toBe(true);
  });

  test("the floor (5.19): only floor-min caps are on", () => {
    const r = resolveCapabilitiesFromManifest(MANIFEST, "openclaw", "2026.5.19");
    expect(r.capabilities.agentFiles).toBe(false);
    expect(r.capabilities.inboundAttachments).toBe(false);
    expect(r.capabilities.knobThinkingLevel).toBe(true);
  });

  test("null/unparseable version -> CONSERVATIVE floor (minVersion === range.min)", () => {
    for (const v of [null, "v2026.6.5", "garbage"]) {
      const r = resolveCapabilitiesFromManifest(MANIFEST, "openclaw", v);
      expect(r.capabilities.agentFiles).toBe(false); // min 6.5 != floor
      expect(r.capabilities.knobThinkingLevel).toBe(true); // min == floor
      expect(r.versionBeyondValidated).toBe(false);
    }
  });

  test("a version BEYOND maxValidated -> all caps true + the flag", () => {
    const r = resolveCapabilitiesFromManifest(MANIFEST, "openclaw", "2027.1.0");
    expect(r.versionBeyondValidated).toBe(true);
    expect(r.capabilities.agentFiles).toBe(true);
    expect(r.capabilities.inboundAttachments).toBe(true);
  });

  test("a provider with no published range -> zero capabilities", () => {
    const r = resolveCapabilitiesFromManifest(MANIFEST, "hermes", "2026.6.5");
    expect(r.capabilities).toEqual({});
    expect(r.versionBeyondValidated).toBe(false);
  });
});

describe("normalizeCapabilitiesBody — Convex attributes the served instance", () => {
  // THE prod scenario: an IDLE bridge (no live session, no OPENCLAW_INSTANCE_NAME)
  // reports its gateway version ONLY at the top level. Convex, owning instance
  // identity via BRIDGE_INSTANCE_NAME, synthesizes the served instance's target
  // and resolves its capabilities — so AgentFiles/ChatDefaults resolve with no
  // env on the bridge and no chat open.
  const IDLE_BODY = {
    instanceName: null,
    gatewayVersion: "2026.6.5",
    bridgeVersion: "0.1.0",
    protocolVersion: 2,
    compat: MANIFEST,
    targets: [] as unknown[],
  };

  test("idle bridge + top-level version -> served target synthesized + resolved", () => {
    const n = normalizeCapabilitiesBody(IDLE_BODY, "primary");
    expect(n.targets).toHaveLength(1);
    const t = n.targets[0]!;
    expect(t.instanceName).toBe("primary");
    expect(t.provider).toBe("openclaw");
    expect(t.gatewayVersion).toBe("2026.6.5");
    expect(t.capabilities.agentFiles).toBe(true);
    expect(t.capabilities.configDefaults).toBe(true);
    // End-to-end through the projection the frontend reads:
    const cap = capabilitiesForInstance(n.targets, "primary");
    expect(cap?.capabilities?.agentFiles).toBe(true);
  });

  test("a live target already covering the served instance is NOT duplicated", () => {
    // NEW_CAPABILITIES_BODY's live target is instanceName "main" — serve "main".
    const body = { ...NEW_CAPABILITIES_BODY, gatewayVersion: "2026.6.5" };
    const n = normalizeCapabilitiesBody(body, "main");
    expect(n.targets).toHaveLength(1);
    // The LIVE target wins (its real captured version 5.19), no synthetic 6.5 dupe.
    expect(n.targets[0]!.gatewayVersion).toBe("2026.5.19");
  });

  test("no servedInstance -> no synthesis (backward compatible)", () => {
    const n = normalizeCapabilitiesBody(IDLE_BODY);
    expect(n.targets).toEqual([]);
  });

  test("served set but NO top-level version -> no synthesis", () => {
    const n = normalizeCapabilitiesBody({ ...IDLE_BODY, gatewayVersion: null }, "primary");
    expect(n.targets).toEqual([]);
  });

  test("served set but LEGACY bridge (compat:null) -> no all-false target", () => {
    const n = normalizeCapabilitiesBody(
      { instanceName: null, gatewayVersion: "2026.6.5", targets: [] },
      "primary",
    );
    expect(n.targets).toEqual([]);
  });
});

describe("providerSupport + summarizeCompat (the /api/v1/compat payload)", () => {
  test("reads the openclaw window; hermes degrades to no range", () => {
    expect(providerSupport(MANIFEST, "openclaw")).toEqual({
      range: { min: "2026.5.19", maxValidated: "2026.6.5" },
      validatedVersions: ["2026.5.19", "2026.6.1", "2026.6.5"],
    });
    expect(providerSupport(MANIFEST, "hermes")).toEqual({
      range: null,
      validatedVersions: [],
    });
    expect(providerSupport(null, "openclaw").range).toBeNull();
  });

  test("summary computes withinSupport per instance from the manifest", () => {
    const summary = summarizeCompat({
      bridgeVersion: "1.4.0",
      protocolVersion: 2,
      compat: MANIFEST,
      targets: [
        {
          instanceName: "main",
          provider: "openclaw",
          gatewayVersion: "2026.6.5",
          capabilities: { abort: true },
          versionBeyondValidated: false,
        },
        {
          instanceName: "edge",
          provider: "openclaw",
          gatewayVersion: "2026.7.1",
          capabilities: {},
          versionBeyondValidated: true,
        },
        {
          instanceName: "h1",
          provider: "hermes",
          gatewayVersion: "0.3.0",
          capabilities: {},
          versionBeyondValidated: false,
        },
      ],
    });
    expect(summary.bridge.version).toBe("1.4.0");
    expect(summary.bridge.protocolVersion).toBe(2);
    expect(summary.bridge.supported.openclaw.range?.min).toBe("2026.5.19");
    expect(summary.instances).toEqual([
      {
        instanceName: "main",
        provider: "openclaw",
        gatewayVersion: "2026.6.5",
        withinSupport: true,
        versionBeyondValidated: false,
      },
      {
        instanceName: "edge",
        provider: "openclaw",
        gatewayVersion: "2026.7.1",
        withinSupport: true, // supported (>= min) even beyond validated
        versionBeyondValidated: true,
      },
      {
        instanceName: "h1",
        provider: "hermes",
        gatewayVersion: "0.3.0",
        withinSupport: false, // no published hermes range yet
        versionBeyondValidated: false,
      },
    ]);
  });

  test("no snapshot yet -> empty, null-version summary (never throws)", () => {
    const s = summarizeCompat(null);
    expect(s.bridge.version).toBeNull();
    expect(s.bridge.supported.openclaw.range).toBeNull();
    expect(s.instances).toEqual([]);
    // Freshness/health are null when no poll has ever landed.
    expect(s.reachable).toBeNull();
    expect(s.lastError).toBeNull();
    expect(s.fetchedAt).toBeNull();
  });

  test("surfaces snapshot freshness/health (reachable/lastError/fetchedAt)", () => {
    // A FRESH, reachable poll.
    const ok = summarizeCompat({
      bridgeVersion: "0.1.0",
      protocolVersion: 2,
      compat: MANIFEST,
      targets: [],
      reachable: true,
      lastError: null,
      fetchedAt: 1781330000000,
    });
    expect(ok.reachable).toBe(true);
    expect(ok.lastError).toBeNull();
    expect(ok.fetchedAt).toBe(1781330000000);

    // A FAILED poll preserving last-good: reachable false + a reason code, but
    // fetchedAt still advances (timestamp of the last ATTEMPT) so a reader can
    // tell the snapshot was just re-checked even though it stayed stale.
    const failed = summarizeCompat({
      bridgeVersion: "0.1.0",
      protocolVersion: 2,
      compat: MANIFEST,
      targets: [],
      reachable: false,
      lastError: "unreachable",
      fetchedAt: 1781330300000,
    });
    expect(failed.reachable).toBe(false);
    expect(failed.lastError).toBe("unreachable");
    expect(failed.fetchedAt).toBe(1781330300000);
  });

  test("capabilitiesForInstance projects one target or null", () => {
    const targets: CompatTarget[] = [
      {
        instanceName: "main",
        provider: "openclaw",
        gatewayVersion: "2026.6.5",
        capabilities: { abort: true },
        versionBeyondValidated: false,
      },
    ];
    expect(capabilitiesForInstance(targets, "main")).toEqual({
      provider: "openclaw",
      gatewayVersion: "2026.6.5",
      capabilities: { abort: true },
      versionBeyondValidated: false,
    });
    expect(capabilitiesForInstance(targets, "ghost")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Poller storage — mock fetch serving BOTH bridge endpoints by URL.
// ---------------------------------------------------------------------------

/** Stub BRIDGE_URL + global fetch with per-endpoint JSON responders. */
function stubBridge(routes: Record<string, () => Response>) {
  const prevUrl = process.env.BRIDGE_URL;
  process.env.BRIDGE_URL = "https://bridge.example.org";
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    const responder = routes[path];
    if (!responder) throw new Error(`unstubbed path: ${path}`);
    return responder();
  });
  return {
    restore: () => {
      vi.unstubAllGlobals();
      if (prevUrl === undefined) delete process.env.BRIDGE_URL;
      else process.env.BRIDGE_URL = prevUrl;
    },
  };
}

const json = (value: unknown) => () =>
  new Response(JSON.stringify(value), { status: 200 });

// TestConvex<typeof schema> (NOT ReturnType<typeof convexTest>): the bare
// ReturnType loses the schema instantiation, leaving only system indexes —
// .withIndex("by_key") would not typecheck under `tsc -p convex`.
async function readCompatDoc(t: TestConvex<typeof schema>) {
  return await t.run((ctx) =>
    ctx.db
      .query("bridgeCompat")
      .withIndex("by_key", (q) => q.eq("key", "singleton"))
      .unique(),
  );
}

describe("pollBridgeCompat (cron storage, both endpoints mocked)", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("a protocol-2 bridge: /health and /capabilities both persist", async () => {
    const t = convexTest(schema, modules);
    const stub = stubBridge({
      "/health": json(HEALTH_BODY),
      "/capabilities": json(NEW_CAPABILITIES_BODY),
    });
    try {
      await t.action(internal.bridgeHealth.pollBridgeHealth, {});
      await t.action(internal.compat.pollBridgeCompat, {});
    } finally {
      stub.restore();
    }

    // The 1-min health poller is untouched by the new compat snapshot.
    const health = await t.run((ctx) =>
      ctx.db
        .query("bridgeHealth")
        .withIndex("by_key", (q) => q.eq("key", "singleton"))
        .unique(),
    );
    expect(health?.reachable).toBe(true);
    expect(health?.targets).toHaveLength(1);

    const doc = await readCompatDoc(t);
    expect(doc?.reachable).toBe(true);
    expect(doc?.lastError).toBeUndefined();
    expect(doc?.bridgeVersion).toBe(LIVE_CAPABILITIES_BODY.bridgeVersion);
    expect(doc?.protocolVersion).toBe(2);
    expect(doc?.compat).toEqual(MANIFEST);
    expect(doc?.targets).toHaveLength(1); // deduped by instance
    expect(doc?.targets[0]).toMatchObject({
      instanceName: "main",
      provider: "openclaw",
      gatewayVersion: "2026.5.19",
      versionBeyondValidated: false,
    });
    expect(typeof doc?.fetchedAt).toBe("number");
  });

  test("idle bridge + BRIDGE_INSTANCE_NAME: Convex synthesizes the served target (full wiring)", async () => {
    // THE prod scenario, end-to-end through the REAL poller: an idle bridge with
    // NO live session and NO OPENCLAW_INSTANCE_NAME reports its gateway version
    // ONLY at the top level (empty targets). Convex, owning instance identity via
    // BRIDGE_INSTANCE_NAME, must synthesize the served target — and it must survive
    // the bridgeCompatTarget schema on upsert + surface through summarizeCompat +
    // capabilitiesForInstance (the front path). This is the wiring the pure-function
    // tests cannot prove (poller env -> normalize -> stored doc -> readers).
    const t = convexTest(schema, modules);
    const prevInst = process.env.BRIDGE_INSTANCE_NAME;
    process.env.BRIDGE_INSTANCE_NAME = "primary";
    const IDLE_BODY = {
      instanceName: null,
      gatewayVersion: "2026.6.5",
      bridgeVersion: "0.1.0",
      protocolVersion: 2,
      compat: MANIFEST,
      targets: [],
    };
    const stub = stubBridge({ "/capabilities": json(IDLE_BODY) });
    try {
      await t.action(internal.compat.pollBridgeCompat, {});
    } finally {
      stub.restore();
      if (prevInst === undefined) delete process.env.BRIDGE_INSTANCE_NAME;
      else process.env.BRIDGE_INSTANCE_NAME = prevInst;
    }

    const doc = await readCompatDoc(t);
    expect(doc?.reachable).toBe(true);
    expect(doc?.targets).toHaveLength(1);
    expect(doc?.targets[0]).toMatchObject({
      instanceName: "primary",
      provider: "openclaw",
      gatewayVersion: "2026.6.5",
    });
    expect(doc?.targets[0]?.capabilities.agentFiles).toBe(true);
    expect(doc?.targets[0]?.capabilities.configDefaults).toBe(true);

    // get_compat path: summarizeCompat exposes the synthesized instance.
    const summary = summarizeCompat(doc);
    expect(summary.instances).toEqual([
      {
        instanceName: "primary",
        provider: "openclaw",
        gatewayVersion: "2026.6.5",
        withinSupport: true,
        versionBeyondValidated: false,
      },
    ]);
    // front path: capabilitiesForInstance resolves agentFiles for the served chat.
    expect(
      capabilitiesForInstance(doc!.targets, "primary")?.capabilities?.agentFiles,
    ).toBe(true);
  });

  test("a LEGACY bridge (backward skew) stores compat:null", async () => {
    const t = convexTest(schema, modules);
    const stub = stubBridge({ "/capabilities": json(LEGACY_CAPABILITIES_BODY) });
    try {
      await t.action(internal.compat.pollBridgeCompat, {});
    } finally {
      stub.restore();
    }
    const doc = await readCompatDoc(t);
    expect(doc?.reachable).toBe(true);
    expect(doc?.compat).toBeNull();
    expect(doc?.bridgeVersion).toBeNull();
    expect(doc?.protocolVersion).toBeNull();
    expect(doc?.targets).toEqual([]);
  });

  test("a FAILED poll preserves the last-good snapshot (serve last-good)", async () => {
    const t = convexTest(schema, modules);
    const good = stubBridge({ "/capabilities": json(NEW_CAPABILITIES_BODY) });
    try {
      await t.action(internal.compat.pollBridgeCompat, {});
    } finally {
      good.restore();
    }

    const prevUrl = process.env.BRIDGE_URL;
    process.env.BRIDGE_URL = "https://bridge.example.org";
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });
    try {
      await t.action(internal.compat.pollBridgeCompat, {});
    } finally {
      vi.unstubAllGlobals();
      if (prevUrl === undefined) delete process.env.BRIDGE_URL;
      else process.env.BRIDGE_URL = prevUrl;
    }

    const doc = await readCompatDoc(t);
    expect(doc?.reachable).toBe(false);
    expect(doc?.lastError).toBe("unreachable");
    // Last-good manifest + targets stay served through the blip.
    expect(doc?.compat).toEqual(MANIFEST);
    expect(doc?.bridgeVersion).toBe(LIVE_CAPABILITIES_BODY.bridgeVersion);
    expect(doc?.targets).toHaveLength(1);
  });

  test("no BRIDGE_URL -> a not_configured stub row (compat:null)", async () => {
    const t = convexTest(schema, modules);
    const prevUrl = process.env.BRIDGE_URL;
    delete process.env.BRIDGE_URL;
    try {
      await t.action(internal.compat.pollBridgeCompat, {});
    } finally {
      if (prevUrl !== undefined) process.env.BRIDGE_URL = prevUrl;
    }
    const doc = await readCompatDoc(t);
    expect(doc?.reachable).toBe(false);
    expect(doc?.lastError).toBe("not_configured");
    expect(doc?.compat).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Public queries — REAL RBAC gates.
// ---------------------------------------------------------------------------

/** Seed the singleton snapshot directly (what a successful poll writes). */
async function seedSnapshot(t: ReturnType<typeof convexTest>) {
  await t.mutation(internal.compat.upsertBridgeCompat, {
    bridgeVersion: "1.4.0",
    protocolVersion: 2,
    compat: MANIFEST,
    targets: [
      {
        instanceName: "main",
        provider: "openclaw",
        gatewayVersion: "2026.6.5",
        capabilities: { agentDiscovery: true, abort: true },
        versionBeyondValidated: false,
      },
    ],
  });
}

/** Seed a user with the given role (+ optional granted extra permissions). */
async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "pending" | "user" | "admin",
  extraPermissions?: string[],
) {
  const userId = await t.run(async (ctx) => {
    const uid = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", {
      userId: uid,
      role,
      canonical: "alice",
      extraPermissions,
    });
    return uid;
  });
  return { userId, as: t.withIdentity({ subject: `${userId}|session` }) };
}

describe("getBridgeCompat / forInstance (bridge.read gate)", () => {
  test("a plain user (no grant) is rejected; granted user and admin pass", async () => {
    const t = convexTest(schema, modules);
    await seedSnapshot(t);

    const plain = await seedUser(t, "user");
    await expect(plain.as.query(api.compat.getBridgeCompat, {})).rejects.toThrow(
      /missing permission bridge\.read/,
    );
    await expect(
      plain.as.query(api.compat.forInstance, { instanceName: "main" }),
    ).rejects.toThrow(/missing permission bridge\.read/);

    const granted = await seedUser(t, "user", ["bridge.read"]);
    const snap = await granted.as.query(api.compat.getBridgeCompat, {});
    expect(snap?.bridgeVersion).toBe("1.4.0");
    expect(snap?.protocolVersion).toBe(2);
    expect(snap?.targets).toHaveLength(1);
    expect(snap?.configuredInstances).toEqual([]); // no instances rows seeded

    const admin = await seedUser(t, "admin");
    const forMain = await admin.as.query(api.compat.forInstance, {
      instanceName: "main",
    });
    expect(forMain).toEqual({
      provider: "openclaw",
      gatewayVersion: "2026.6.5",
      capabilities: { agentDiscovery: true, abort: true },
      versionBeyondValidated: false,
    });
    // Unknown instance -> null (the frontend's legacy policy).
    expect(
      await admin.as.query(api.compat.forInstance, { instanceName: "ghost" }),
    ).toBeNull();
  });

  test("unauthenticated callers are rejected", async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(api.compat.getBridgeCompat, {})).rejects.toThrow(
      /authentication required/,
    );
  });

  test("configuredInstances mirrors the instances table (Codex P2 input)", async () => {
    // snapshotTabGate fails CLOSED when a CONFIGURED instance is missing from
    // the live targets — this pins the input it needs: the SAME list
    // resolveInstanceClaim resolves the /config-defaults write target from.
    const t = convexTest(schema, modules);
    await seedSnapshot(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("instances", { name: "main", gatewayUrl: "ws://gw" });
      await ctx.db.insert("instances", { name: "edge", gatewayUrl: "ws://e" });
    });
    const admin = await seedUser(t, "admin");
    const snap = await admin.as.query(api.compat.getBridgeCompat, {});
    expect(snap?.configuredInstances?.sort()).toEqual(["edge", "main"]);
  });
});

describe("forChat (active user, OWN chat only)", () => {
  async function seedChatOwner(t: ReturnType<typeof convexTest>) {
    const owner = await seedUser(t, "user");
    await t.run(async (ctx) => {
      await ctx.db.insert("userAgents", {
        userId: owner.userId,
        instanceName: "main",
        agentId: "alice",
        isDefault: true,
        source: "manual",
        createdAt: Date.now(),
      });
    });
    return owner;
  }

  test("the owner of a BOUND chat reads its instance capabilities", async () => {
    const t = convexTest(schema, modules);
    await seedSnapshot(t);
    const owner = await seedChatOwner(t);
    const chatId = await t.run((ctx) =>
      ctx.db.insert("chats", {
        userId: owner.userId,
        instanceName: "main",
        agentId: "alice",
        updatedAt: Date.now(),
      }),
    );
    const caps = await owner.as.query(api.compat.forChat, { chatId });
    expect(caps).toMatchObject({
      provider: "openclaw",
      gatewayVersion: "2026.6.5",
      capabilities: { agentDiscovery: true, abort: true },
    });
  });

  test("an UNBOUND legacy chat resolves through the routing resolver", async () => {
    const t = convexTest(schema, modules);
    await seedSnapshot(t);
    const owner = await seedChatOwner(t);
    const chatId = await t.run((ctx) =>
      ctx.db.insert("chats", { userId: owner.userId, updatedAt: Date.now() }),
    );
    const caps = await owner.as.query(api.compat.forChat, { chatId });
    expect(caps?.provider).toBe("openclaw"); // via the user's default agent
  });

  test("a NON-owner (even active) is rejected; a pending user is blocked", async () => {
    const t = convexTest(schema, modules);
    await seedSnapshot(t);
    const owner = await seedChatOwner(t);
    const chatId = await t.run((ctx) =>
      ctx.db.insert("chats", {
        userId: owner.userId,
        instanceName: "main",
        agentId: "alice",
        updatedAt: Date.now(),
      }),
    );

    const intruder = await seedUser(t, "user");
    await expect(
      intruder.as.query(api.compat.forChat, { chatId }),
    ).rejects.toThrow(/not owned/);

    const pending = await seedUser(t, "pending");
    await expect(
      pending.as.query(api.compat.forChat, { chatId }),
    ).rejects.toThrow(/pending approval/);
  });
});

describe("boundProtocolInfo (protocol-contract section)", () => {
  test("picks + bounds a valid section", () => {
    const p = boundProtocolInfo({
      vendoredVersion: "2026.6.11",
      coverage: { handled: 37, ignored: 47, gaps: 7, gapList: ["A.b", "C.d"] },
      drift: [{ shape: "chat.newField", count: 12 }],
    });
    expect(p).toEqual({
      vendoredVersion: "2026.6.11",
      coverage: { handled: 37, ignored: 47, gaps: 7, gapList: ["A.b", "C.d"] },
      drift: [{ shape: "chat.newField", count: 12 }],
    });
  });

  test("null on a pre-0.23 bridge (absent/foreign shapes)", () => {
    expect(boundProtocolInfo(undefined)).toBeNull();
    expect(boundProtocolInfo(null)).toBeNull();
    expect(boundProtocolInfo("junk")).toBeNull();
    expect(boundProtocolInfo({ coverage: {} })).toBeNull(); // no vendoredVersion
  });

  test("hostile input is bounded (lists capped, strings truncated, junk dropped)", () => {
    const p = boundProtocolInfo({
      vendoredVersion: "x".repeat(500),
      coverage: {
        handled: 1,
        ignored: 2,
        gaps: 3,
        gapList: Array.from({ length: 500 }, (_, i) => `g${i}`),
      },
      drift: [
        { shape: "ok.field", count: 1 },
        { shape: 42, count: "junk" },
        "garbage",
      ],
    });
    expect(p?.vendoredVersion.length).toBeLessThanOrEqual(120);
    expect(p?.coverage?.gapList.length).toBeLessThanOrEqual(100);
    expect(p?.drift).toEqual([{ shape: "ok.field", count: 1 }]);
  });

  test("normalizeCapabilitiesBody carries the section (and null when absent)", () => {
    const withIt = normalizeCapabilitiesBody({
      bridgeVersion: "0.23.0",
      protocol: { vendoredVersion: "2026.6.11", drift: [] },
    });
    expect(withIt.protocol?.vendoredVersion).toBe("2026.6.11");
    const without = normalizeCapabilitiesBody({ bridgeVersion: "0.22.0" });
    expect(without.protocol).toBeNull();
  });
});

describe("mergeProtocolInfo (multi-bridge drift union)", () => {
  const base = {
    vendoredVersion: "2026.6.11",
    coverage: { handled: 37, ignored: 47, gaps: 7, gapList: [] as string[] },
  };
  test("drift unions across bridges (counts summed per shape) — never first-wins", () => {
    const a = { ...base, drift: [{ shape: "chat.x", count: 2 }] };
    const b = {
      ...base,
      drift: [
        { shape: "chat.x", count: 3 },
        { shape: "agent.y", count: 1 },
      ],
    };
    expect(mergeProtocolInfo(a, b)?.drift).toEqual([
      { shape: "chat.x", count: 5 },
      { shape: "agent.y", count: 1 },
    ]);
  });
  test("null sides pass through", () => {
    const a = { ...base, drift: [] };
    expect(mergeProtocolInfo(null, a)).toBe(a);
    expect(mergeProtocolInfo(a, null)).toBe(a);
    expect(mergeProtocolInfo(null, null)).toBeNull();
  });
});
