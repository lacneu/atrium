/// <reference types="vite/client" />
//
// Bridge compat: pure helpers (version parsing / body normalization / summary),
// the poller's storage through MOCKED fetches of both bridge endpoints
// (/health + /capabilities), the LEGACY-bridge backward skew (compat:null),
// the serve-last-good failure path, and the REAL RBAC gates on the public
// queries (bridge.read / active-user + chat ownership).

import { readFileSync } from "node:fs";
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
  foldProtocolInfo,
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
// The OPENCLAW target, selected by provider: the fixture is regenerated from a live
// bridge and now carries a Hermes target too, so an index is not a contract.
const ALICE_TARGET = LIVE_CAPABILITIES_BODY.targets.find(
  (t) => t.provider === "openclaw",
)!;
/** The gateway version the fixture was captured against — read, never hardcoded, so a
 *  refresh moves the expectations with it instead of reddening them. */
const FIXTURE_GATEWAY_VERSION = ALICE_TARGET.gatewayVersion;

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
    expect(parseVersion("2026.6.5")).toEqual({ nums: [2026, 6, 5], pre: null });
    expect(parseVersion("2026.7.1-beta.2")).toEqual({
      nums: [2026, 7, 1],
      pre: "beta.2",
    });
    // STRICT — aligned with the bridge parser: whitespace, missing or extra
    // segments all fail closed (badge can never contradict the bridge gating).
    expect(parseVersion(" 2026.5.19 ")).toBeNull();
    expect(parseVersion("2026.6")).toBeNull();
    expect(parseVersion("2026.6.5.1")).toBeNull();
    expect(parseVersion("")).toBeNull();
    expect(parseVersion("1.x")).toBeNull();
    expect(parseVersion("v2026.6.5")).toBeNull();
    expect(parseVersion("2026.6.5-")).toBeNull();
    expect(parseVersion("2026.8.0-beta.")).toBeNull();
    expect(parseVersion("2026.8.0-beta..1")).toBeNull();
  });

  test("compare is segment-wise with missing segments = 0", () => {
    expect(compareVersions("2026.6.1", "2026.6.5")).toBeLessThan(0);
    expect(compareVersions("2026.6.5", "2026.5.19")).toBeGreaterThan(0);
    expect(compareVersions("2026.6", "2026.6.0")).toBeNull();
    expect(compareVersions("2026.6.5", "2026.6.5")).toBe(0);
    expect(compareVersions("garbage", "2026.6.5")).toBeNull();
  });

  test("a pre-release orders BEFORE its release (bridge mirror)", () => {
    expect(compareVersions("2026.7.1-beta.2", "2026.7.1")).toBeLessThan(0);
    expect(compareVersions("2026.7.1", "2026.7.1-beta.2")).toBeGreaterThan(0);
    expect(compareVersions("2026.7.1-beta.2", "2026.6.11")).toBeGreaterThan(0);
    expect(compareVersions("2026.7.1-beta.2", "2026.7.1-beta.10")).toBeLessThan(0);
    expect(compareVersions("2026.7.1-beta.2", "2026.7.1-beta.2")).toBe(0);
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
      gatewayVersion: FIXTURE_GATEWAY_VERSION,
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
      gatewayVersion: FIXTURE_GATEWAY_VERSION,
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
    // A provider the manifest does not declare at all. Hermes used to serve as this
    // example — it no longer can: it has a real capability table since the transport-
    // independent surface was corrected (W11/G8), and a test whose premise has quietly
    // become false proves nothing.
    expect(providerCapabilityTable(MANIFEST, "nosuchprovider")).toEqual({});
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
    const r = resolveCapabilitiesFromManifest(MANIFEST, "nosuchprovider", "2026.6.5");
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
    expect(n.targets[0]!.gatewayVersion).toBe(FIXTURE_GATEWAY_VERSION);
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
  test("summary exposes the protocol-contract block (bounded) — the MCP 'unknown fields' view", () => {
    const summary = summarizeCompat({
      bridgeVersion: "1.4.0",
      protocolVersion: 2,
      compat: MANIFEST,
      targets: [],
      protocol: {
        vendoredVersion: "2026.6.11",
        coverage: { handled: 41, ignored: 50, gaps: 0, gapList: [] },
        drift: [
          { shape: "agent.spawnedCwd", count: 617 },
          { shape: "agent.label", count: 270 },
          { junk: true },
        ],
        foreign: "dropped",
      },
    });
    expect(summary.protocol).toEqual({
      vendoredVersion: "2026.6.11",
      coverage: { handled: 41, ignored: 50, gaps: 0, gapList: [] },
      drift: [
        { shape: "agent.spawnedCwd", count: 617 },
        { shape: "agent.label", count: 270 },
      ],
      driftOverflow: 0,
      // The junk entry IS counted. An earlier version of this expectation said it counted
      // in neither number "because it never was a nameable shape" — that reasoning was
      // wrong: the payload claimed three shapes and two survived, and an operator reading
      // a list of two has a right to know a third was refused.
      driftTruncated: 1,
    });
    // Absent/malformed stays null — a legacy bridge never breaks the payload.
    expect(
      summarizeCompat({
        bridgeVersion: "1.0.0",
        protocolVersion: 1,
        compat: null,
        targets: [],
      }).protocol,
    ).toBeNull();
    expect(summarizeCompat(null).protocol).toBeNull();
  });

  test("reads each provider's window; an UNKNOWN provider degrades to no range", () => {
    // Pinned to the window the fixture carries, deliberately: a support window is a
    // CLAIM, and one changing under a fixture refresh is exactly the kind of event that
    // should be read rather than absorbed. (Hermes used to be the "no range" example —
    // it has had a published window since 0.18.0 was validated, so the example moved to
    // a provider the manifest genuinely does not declare.)
    expect(providerSupport(MANIFEST, "openclaw")).toEqual({
      range: { min: "2026.5.19", maxValidated: "2026.7.1" },
      validatedVersions: [
        "2026.5.19",
        "2026.6.1",
        "2026.6.5",
        "2026.6.10",
        "2026.6.11",
        "2026.7.1-beta.2",
        "2026.7.1-beta.5",
        "2026.7.1",
      ],
    });
    expect(providerSupport(MANIFEST, "hermes")).toEqual({
      range: { min: "0.18.0", maxValidated: "0.18.2" },
      validatedVersions: ["0.18.0", "0.18.2"],
    });
    expect(providerSupport(MANIFEST, "nosuchprovider")).toEqual({
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
      gatewayVersion: FIXTURE_GATEWAY_VERSION,
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

  test("a PER-TURN selection reads the NEXT SEND's instance, not the binding", async () => {
    // The banner and the capability gates must describe the gateway the send will
    // actually hit. Bound to a validated instance, composing toward an unvalidated
    // one, the reader has to be told BEFORE sending — and switching back has to clear
    // it (raised in review; `bridgeHealth.getBridgeAvailability` already worked this
    // way and this query did not).
    const t = convexTest(schema, modules);
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
        {
          instanceName: "edge",
          provider: "openclaw",
          gatewayVersion: "2027.1.1",
          capabilities: { agentDiscovery: true, abort: true },
          versionBeyondValidated: true,
        },
      ],
    });
    const owner = await seedChatOwner(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("userAgents", {
        userId: owner.userId,
        instanceName: "edge",
        agentId: "bob",
        isDefault: false,
        source: "manual",
        createdAt: Date.now(),
      });
    });
    const chatId = await t.run((ctx) =>
      ctx.db.insert("chats", {
        userId: owner.userId,
        instanceName: "main",
        agentId: "alice",
        updatedAt: Date.now(),
      }),
    );

    // No selection: the chat's own binding, which is validated.
    const bound = await owner.as.query(api.compat.forChat, { chatId });
    expect(bound).toMatchObject({
      gatewayVersion: "2026.6.5",
      versionBeyondValidated: false,
    });

    // Composing toward the unvalidated instance: the flag follows the TARGET.
    const next = await owner.as.query(api.compat.forChat, {
      chatId,
      routedAgent: { instanceName: "edge", agentId: "bob" },
    });
    expect(next).toMatchObject({
      gatewayVersion: "2027.1.1",
      versionBeyondValidated: true,
    });
  });

  test("a routedAgent the user is NOT entitled to falls back to the chat's binding", async () => {
    // A forged selection must never scope-read another instance. The resolver
    // re-authorizes, so the answer is exactly the no-selection answer.
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
    const forged = await owner.as.query(api.compat.forChat, {
      chatId,
      routedAgent: { instanceName: "secret", agentId: "nobody" },
    });
    expect(forged).toMatchObject({
      gatewayVersion: "2026.6.5",
      versionBeyondValidated: false,
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
      // A bridge that predates the counters reports none: 0 is what we can say, and it is
      // NOT the same statement as "no drift was dropped" — see the note on the type.
      driftOverflow: 0,
      driftTruncated: 0,
    });
  });

  test("a list longer than the cap SAYS how much it dropped", () => {
    // The loss used to be a silent `.slice()`. An operator reading the badge saw a
    // truncated list presented as the whole of it.
    const p = boundProtocolInfo({
      vendoredVersion: "2026.6.11",
      coverage: { handled: 1, ignored: 1, gaps: 0, gapList: [] },
      drift: Array.from({ length: 300 }, (_, i) => ({
        shape: `chat.delta.f${i}`,
        count: 1,
      })),
      driftOverflow: 9,
    });
    expect(p!.drift.length).toBeLessThan(300);
    expect(p!.driftTruncated, "named shapes this boundary refused to store").toBe(
      300 - p!.drift.length,
    );
    expect(p!.driftOverflow, "what the bridge itself could not name").toBe(9);
  });

  test("an INCOMING truncation survives a re-bound", () => {
    // `summarizeCompat` re-bounds an already-merged document. Recomputing the count from
    // the list length alone reset a merge's truncation to zero, so the third loss went
    // silent again one function later.
    const p = boundProtocolInfo({
      vendoredVersion: "2026.6.11",
      coverage: { handled: 1, ignored: 1, gaps: 0, gapList: [] },
      drift: [{ shape: "chat.delta.x", count: 1 }],
      driftTruncated: 17,
      driftOverflow: 4,
    });
    expect(p!.driftTruncated, "what an earlier boundary already dropped").toBe(17);
    expect(p!.driftOverflow).toBe(4);
  });

  test("Infinity is CLAMPED here too, not rejected into silence", () => {
    // The `isFinite` pre-filter ran BEFORE the clamp, so the clamp could never do the one
    // thing it was added for. Same mistake, twice, in two functions.
    const p = boundProtocolInfo({
      vendoredVersion: "2026.6.11",
      coverage: { handled: 1, ignored: 1, gaps: 0, gapList: [] },
      drift: [],
      driftOverflow: Number.POSITIVE_INFINITY,
      driftTruncated: Number.POSITIVE_INFINITY,
    });
    expect(p!.driftOverflow).toBe(Number.MAX_SAFE_INTEGER);
    expect(p!.driftTruncated).toBe(Number.MAX_SAFE_INTEGER);
    expect(Number.isSafeInteger(p!.driftTruncated)).toBe(true);
  });

  test("a capped count plus new drops stays a SAFE integer", () => {
    const p = boundProtocolInfo({
      vendoredVersion: "2026.6.11",
      coverage: { handled: 1, ignored: 1, gaps: 0, gapList: [] },
      drift: Array.from({ length: 300 }, (_, i) => ({ shape: `c.d.f${i}`, count: 1 })),
      driftTruncated: Number.MAX_SAFE_INTEGER,
    });
    expect(Number.isSafeInteger(p!.driftTruncated)).toBe(true);
  });

  test("a REJECTED drift entry is counted, not silently dropped", () => {
    // Malformed entries were filtered out and nothing said so. Combined with the merge
    // overflow, a named shape could vanish between two zeroes.
    const p = boundProtocolInfo({
      vendoredVersion: "2026.6.11",
      coverage: { handled: 1, ignored: 1, gaps: 0, gapList: [] },
      drift: [
        { shape: "chat.delta.x", count: 1 },
        { junk: true },
        { shape: "chat.delta.y", count: Number.POSITIVE_INFINITY },
      ],
    });
    expect(p!.drift.length).toBe(1);
    expect(p!.driftTruncated, "the two dropped entries are named as a loss").toBe(2);
  });

  test("two shapes sharing a long prefix stay DISTINCT after the cap", () => {
    // They used to collapse into one summed entry. Counting that as a loss was honest but
    // still a loss — and it only worked inside a single parse: the multi-bridge fold sees
    // keys, never originals, so the same pair arriving from two bridges merged with
    // nothing saying so. The bounded name now carries a suffix derived from the whole
    // original, which keeps them apart at every layer instead of accounting for them.
    const long = "chat.delta." + "x".repeat(200);
    const p = boundProtocolInfo({
      vendoredVersion: "2026.6.11",
      coverage: { handled: 1, ignored: 1, gaps: 0, gapList: [] },
      drift: [
        { shape: `${long}A`, count: 3 },
        { shape: `${long}B`, count: 7 },
      ],
    })!;
    expect(p.drift.length, "two names in, two shapes out").toBe(2);
    expect(new Set(p.drift.map((d) => d.shape)).size, "and they differ").toBe(2);
    for (const d of p.drift) expect(d.shape.length).toBeLessThanOrEqual(120);
    expect(p.drift.map((d) => d.count).sort(), "no observation moved").toEqual([3, 7]);
    expect(p.driftTruncated, "nothing was lost, so nothing is reported").toBe(0);
  });

  test("the pair survives a FOLD across two bridges", () => {
    // The layer the collision counter could never protect: by the time the fold runs, the
    // originals are gone, so two bridges each reporting one of the pair produced a single
    // summed entry and a `driftTruncated` of zero.
    const long = "agent." + "y".repeat(200);
    const bound = (shape: string, count: number) =>
      boundProtocolInfo({
        vendoredVersion: "2026.6.11",
        coverage: { handled: 1, ignored: 1, gaps: 0, gapList: [] },
        drift: [{ shape, count }],
      });
    const folded = foldProtocolInfo([bound(`${long}A`, 3), bound(`${long}B`, 7)])!;
    expect(folded.drift.length, "one shape per distinct name").toBe(2);
    expect(folded.driftTruncated).toBe(0);
  });

  test("a NEGATIVE count is a rejected entry, not a shape observed zero times", () => {
    // Clamping -1 to 0 kept the shape with an "× 0" that reads as "observed never" — a
    // claim the payload never made — and it escaped the rejected tally too.
    const p = boundProtocolInfo({
      vendoredVersion: "2026.6.11",
      coverage: { handled: 1, ignored: 1, gaps: 0, gapList: [] },
      drift: [
        { shape: "agent.x", count: -1 },
        { shape: "agent.y", count: 2 },
      ],
    });
    expect(p!.drift.map((d) => d.shape)).toEqual(["agent.y"]);
    expect(p!.driftTruncated).toBe(1);
  });

  test("a huge drift array is bounded BEFORE the walk, not after it", () => {
    // The cap protected the stored document, not the poll that builds it: every entry of a
    // million-entry answer was mapped, string-sliced and indexed before the slice applied.
    // Counting the reads is the only way to see it — the resulting numbers are identical
    // either way, which is exactly why the defect survived a count-based test.
    const entries = Array.from({ length: 5000 }, (_, i) => ({
      shape: `agent.f${i}`,
      count: 1,
    }));
    let indexReads = 0;
    const watched = new Proxy(entries, {
      get(t, prop, recv) {
        if (typeof prop === "string" && /^\d+$/.test(prop)) indexReads += 1;
        return Reflect.get(t, prop, recv);
      },
    });
    const p = boundProtocolInfo({
      vendoredVersion: "2026.6.11",
      coverage: { handled: 1, ignored: 1, gaps: 0, gapList: [] },
      drift: watched,
    })!;
    expect(indexReads, "only the bounded head is ever read").toBeLessThanOrEqual(1000);
    // …and everything not read is still declared lost, not quietly forgotten.
    expect(p.drift.length).toBe(100);
    expect(p.driftTruncated, "5000 announced, 100 stored").toBe(4900);
  });

  test("a FRACTIONAL count is a rejected entry, not a shape observed zero times", () => {
    // Accepted as merely "finite", then floored by the clamp — so 0.5 became the very
    // "× 0" the negative-count branch exists to prevent, and being kept it escaped the
    // rejected tally too. An observation count is an integer.
    const p = boundProtocolInfo({
      vendoredVersion: "2026.6.11",
      coverage: { handled: 1, ignored: 1, gaps: 0, gapList: [] },
      drift: [
        { shape: "agent.x", count: 0.5 },
        { shape: "agent.y", count: 2 },
      ],
    });
    expect(p!.drift.map((d) => d.shape)).toEqual(["agent.y"]);
    expect(p!.driftTruncated).toBe(1);
  });

  test("FRACTIONAL coverage tallies are refused, not displayed", () => {
    // Same contract, same failure: handled/ignored/gaps are counts, and a fractional one
    // printed "1.5 handled" in the operator badge.
    const p = boundProtocolInfo({
      vendoredVersion: "2026.6.11",
      coverage: { handled: 1.5, ignored: 2, gaps: 0, gapList: [] },
      drift: [],
    });
    expect(p!.coverage, "a malformed tally yields no tally at all").toBeNull();
  });

  test("the SAME name twice is not a collision", () => {
    // Truncating before looking for duplicates made two IDENTICAL names look like a lost
    // distinction — the same phantom loss as at the merge, one layer up. Nothing is lost
    // when a payload repeats a shape; its counts simply add.
    const p = boundProtocolInfo({
      vendoredVersion: "2026.6.11",
      coverage: { handled: 1, ignored: 1, gaps: 0, gapList: [] },
      drift: [
        { shape: "agent.x", count: 2 },
        { shape: "agent.x", count: 3 },
      ],
    });
    expect(p!.drift).toEqual([{ shape: "agent.x", count: 5 }]);
    expect(p!.driftTruncated, "nothing was lost").toBe(0);
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

// The fold is the ONLY exported entry point: the pairwise union it is built on returns an
// unbounded value on purpose (associativity) and is deliberately not exported, so no caller
// can store a half-folded accumulator.
describe("foldProtocolInfo (multi-bridge drift union)", () => {
  const base = {
    vendoredVersion: "2026.6.11",
    coverage: { handled: 37, ignored: 47, gaps: 7, gapList: [] as string[] },
    driftOverflow: 0,
    driftTruncated: 0,
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
    expect(foldProtocolInfo([a, b])?.drift).toEqual([
      { shape: "chat.x", count: 5 },
      { shape: "agent.y", count: 1 },
    ]);
  });
  test("the losses ADD UP across bridges instead of vanishing", () => {
    // Three caps could shorten this list — each bridge's tracked-shape cap, each side's
    // parse, and this fold — and all three used to be silent. An operator reading "here
    // is the drift" was reading a number short for reasons nobody recorded.
    const a = { ...base, drift: [{ shape: "chat.delta.x", count: 1 }], driftOverflow: 4 };
    const b = {
      ...base,
      drift: [{ shape: "agent.y", count: 1 }],
      driftOverflow: 7,
      driftTruncated: 2,
    };
    const m = foldProtocolInfo([a, b]);
    expect(m?.driftOverflow, "what the bridges could not name").toBe(11);
    expect(m?.driftTruncated, "what the boundaries refused to store").toBe(2);
  });

  test("absurd counters are CLAMPED, never turned into silence", () => {
    // Summing two `Number.MAX_VALUE` gave Infinity, which the final bound rejects as
    // non-finite and replaces with 0 — so a bridge sending nonsense could make both
    // counters DISAPPEAR. A capped number is meaningless; a zeroed one is a lie. The fold
    // clamps as it sums AND survives its own closing bound.
    const a = { ...base, drift: [], driftOverflow: Number.MAX_VALUE };
    const b = { ...base, drift: [], driftOverflow: Number.MAX_VALUE };
    const m = foldProtocolInfo([a, b])!;
    expect(Number.isFinite(m.driftOverflow)).toBe(true);
    expect(m.driftOverflow).toBeGreaterThan(0);
  });

  test("a merged COUNT cannot overflow the shape out of existence", () => {
    const a = { ...base, drift: [{ shape: "chat.delta.x", count: Number.MAX_VALUE }] };
    const b = { ...base, drift: [{ shape: "chat.delta.x", count: Number.MAX_VALUE }] };
    const m = foldProtocolInfo([a, b])!;
    expect(Number.isSafeInteger(m.drift[0]!.count)).toBe(true);
    // …and the closing bound keeps the shape it used to reject as non-finite.
    expect(m.drift.map((d) => d.shape)).toEqual(["chat.delta.x"]);
  });

  test("the SAME shape from two bridges is a union, never a reported loss", () => {
    // A previous version counted every shared key as a truncation collision, which
    // reported a loss for the most ordinary case there is: two bridges seeing the same
    // unknown field. A phantom loss on an operator badge is worse than a missed one — it
    // teaches people to ignore the number. Counting collisions belongs where the ORIGINAL
    // names are still visible; by this layer they are already normalised.
    const a = { ...base, drift: [{ shape: "chat.delta.x", count: 2 }] };
    const b = { ...base, drift: [{ shape: "chat.delta.x", count: 3 }] };
    const m = foldProtocolInfo([a, b])!;
    expect(m.drift).toEqual([{ shape: "chat.delta.x", count: 5 }]);
    expect(m.driftTruncated, "nothing was dropped, so nothing is reported").toBe(0);
  });

  test("a shape that grows on a LATER bridge keeps its full count", () => {
    // The union used to be truncated at every pairwise step, which made the fold depend on
    // the order bridges were polled in: a shape that was the smallest in the running
    // accumulator was dropped at step 2 and came back at step 3 carrying only the LAST
    // bridge's count — a number short by everything the earlier bridges had observed, next
    // to a badge that named no loss for it. The union is carried whole and bounded once.
    // Distinct filler counts make the closing cap's choice order-independent, so the
    // permutation check below tests the fold and not a tie-break.
    const filler = Array.from({ length: 100 }, (_, i) => ({
      shape: `chat.delta.f${i}`,
      count: 2 + i,
    }));
    const a = { ...base, drift: filler };
    const b = { ...base, drift: [{ shape: "agent.x", count: 1 }] };
    const c = { ...base, drift: [{ shape: "agent.x", count: 1000 }] };
    const stored = foldProtocolInfo([a, b, c])!;
    const x = stored.drift.find((d) => d.shape === "agent.x");
    expect(x, "the shape survives the fold").toBeDefined();
    expect(x!.count, "1 from bridge B + 1000 from bridge C").toBe(1001);
    // The single cap still applies, and still names what it drops.
    expect(stored.drift.length).toBe(100);
    expect(stored.driftTruncated, "101 shapes, 100 stored").toBe(1);
    // …and the result does not depend on the order the bridges answered in.
    for (const order of [
      [c, b, a],
      [b, a, c],
      [a, c, b],
    ]) {
      const other = foldProtocolInfo(order)!;
      expect(new Map(other.drift.map((d) => [d.shape, d.count]))).toEqual(
        new Map(stored.drift.map((d) => [d.shape, d.count])),
      );
      expect(other.driftTruncated).toBe(stored.driftTruncated);
    }
  });

  test("EX ÆQUO shapes are cut deterministically, not by poll order", () => {
    // The scenario above deliberately used distinct counts, and the cap's choice rode on
    // `Map` insertion order — i.e. the order the bridges happened to answer in. With more
    // equally-observed shapes than the cap, an operator saw a different hundred on every
    // poll, and one shape could stay invisible run after run. The name is the tie-break.
    const shapes = Array.from({ length: 101 }, (_, i) => `agent.f${String(i).padStart(3, "0")}`);
    const bridges = [0, 1, 2].map((b) => ({
      ...base,
      drift: shapes.filter((_, i) => i % 3 === b).map((shape) => ({ shape, count: 1 })),
    }));
    const kept = (order: typeof bridges) =>
      foldProtocolInfo(order)!.drift.map((d) => d.shape);
    const first = kept(bridges);
    expect(first.length).toBe(100);
    for (const order of [
      [bridges[2]!, bridges[0]!, bridges[1]!],
      [bridges[1]!, bridges[2]!, bridges[0]!],
    ]) {
      expect(kept(order), "the same hundred, whatever the poll order").toEqual(first);
    }
  });

  test("null sides pass through", () => {
    const a = { ...base, drift: [] };
    expect(foldProtocolInfo([null, a])).toEqual(a);
    expect(foldProtocolInfo([a, null])).toEqual(a);
    expect(foldProtocolInfo([null, null])).toBeNull();
    expect(foldProtocolInfo([]), "no bridge answered").toBeNull();
  });
});

// ── The SAME shared table the bridge asserts (W10 / G7) ────────────────────
//
// `bridge/test/fixtures/capability-policy.json` is the single expectation table for
// the capability policy. This suite and the bridge's both read it, so the "EXACT
// MIRROR" claim in convex/lib/compat.ts is finally checked by something: a divergence
// between the two implementations reddens one side.
//
// Read with `readFileSync` rather than imported: `tsc -p convex` (the deploy compiler)
// has no `resolveJsonModule`, and a JSON import here would break the deploy while
// vitest stayed green — the exact trap this program hit on 2026-07-26.

describe("capability policy — the shared table (bridge <-> convex)", () => {
  interface PolicyCase {
    name: string;
    provider: string;
    version: string | null;
    beyond: boolean;
    capabilities: Record<string, boolean>;
  }
  const POLICY = JSON.parse(
    readFileSync(
      new URL("../bridge/test/fixtures/capability-policy.json", import.meta.url),
      "utf-8",
    ),
  ) as { manifest: unknown; cases: PolicyCase[] };

  test("the table carries the discriminating case", () => {
    const beyondCase = POLICY.cases.find((c) => c.beyond);
    expect(beyondCase, "no beyond-maxValidated case in the shared table").toBeDefined();
    expect(beyondCase!.capabilities.unbenchedCap).toBe(false);
  });

  for (const c of POLICY.cases) {
    test(c.name, () => {
      const resolved = resolveCapabilitiesFromManifest(
        POLICY.manifest,
        c.provider,
        c.version,
      );
      expect(resolved.capabilities).toEqual(c.capabilities);
      expect(resolved.versionBeyondValidated).toBe(c.beyond);
    });
  }
});
