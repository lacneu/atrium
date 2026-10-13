/// <reference types="vite/client" />
//
// `chat.gateway_pressure` — THE TELEMETRY GAP MADE EXPLICIT (prod 2026-10-10: 53 of 58
// traces in six hours carried `totalTokens/contextTokens/fillPct: null`, all of them
// gateway-initiated runs of one conversation, alternating with complete ones).
//
// Invariance first: a trace whose counters ARE present must stay what 0.97.0 stored. The
// expectations of the PRESENT cases below are MEASURED, not chosen —
// `fixtures/gateway-pressure-baseline-v0970.json` was produced by running this file on
// the v0.97.0 tree with GATEWAY_PRESSURE_RECORD=<path>, before any change.

import { readFileSync, writeFileSync } from "node:fs";
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { PRESSURE_TELEMETRY_CAUSES } from "./lib/pressureTelemetry";
import { PRESSURE_TELEMETRY_CAUSES as BRIDGE_CAUSES } from "../bridge/src/core/pressure-telemetry";

const modules = import.meta.glob("./**/*.ts");
type T = TestConvex<typeof schema>;
const URL = "/bridge/ingest";
let SECRET = "";

async function seed(t: T) {
  const seeded = await t.run(async (ctx) => {
    const admin = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId: admin, role: "admin" as const });
    const instanceId = await ctx.db.insert("instances", { name: "prod", gatewayUrl: "ws://prod" });
    const agentDocId = await ctx.db.insert("agents", {
      instanceName: "prod",
      agentId: "denis",
      source: "discovered" as const,
      presentInLastOk: true,
      firstSeenAt: 1,
      lastSeenAt: 1,
    });
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", { userId, role: "user" as const, canonical: "u" });
    const chatId = await ctx.db.insert("chats", {
      userId,
      updatedAt: 1,
      instanceName: "prod",
      // What the conversation's gateway DECLARED (models.list roster + describe's model).
      sessionMeta: { model: "gpt-5.5", availableModels: [{ id: "gpt-5.5", label: "GPT-5.5" }, { id: "gpt-5.6-luna", label: "Luna" }] },
    } as never);
    const messageId = await ctx.db.insert("messages", {
      chatId,
      userId,
      role: "assistant" as const,
      status: "streaming" as const,
      text: "",
      updatedAt: 1,
    });
    return { admin, instanceId, chatId, messageId, agentDocId };
  });
  const minted = await t
    .withIdentity({ subject: `${seeded.admin}|session` })
    .action(api.bridgeAuth.mintBridgeSecret, { instanceId: seeded.instanceId });
  SECRET = minted.plaintext;
  return seeded;
}

function post(t: T, body: unknown) {
  return t.fetch(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` },
    body: JSON.stringify(body),
  });
}

async function metas(t: T): Promise<Array<Record<string, unknown>>> {
  return await t.run(async (ctx) => {
    const all = await ctx.db.query("traceEvents").collect();
    return all
      .filter((e) => e.kind === "chat.gateway_pressure")
      .sort((a, b) => a._creationTime - b._creationTime)
      .map((e) => JSON.parse(e.meta ?? "{}") as Record<string, unknown>);
  });
}

/** The bodies a 0.97.0 bridge posts (turn-sink.ts `recordGatewayPressure`), one per
 *  shape seen in production plus the boundary cases. `present` = the three counters are
 *  valid numbers: the stored meta must not change. */
const CASES: Array<{ name: string; present: boolean; body: Record<string, unknown> }> = [
  {
    name: "dispatch, presend describe, gateway estimate",
    present: true,
    body: {
      totalTokens: 41_000,
      contextTokens: 272_000,
      costUsd: 0.42,
      fillPct: 15,
      fillSource: "gateway_estimate",
      model: "gpt-5.5",
      toolCalls: 3,
      pressureSource: "presend_describe",
      turnOrigin: "dispatch",
      compaction: null,
      errorKind: null,
      stopReason: "stop",
      finalizeCause: "gateway_final",
      postTotalTokens: 43_000,
      postInputTokens: 40_000,
      postOutputTokens: 3_000,
      postCostUsd: 0.45,
    },
  },
  {
    name: "dispatch, presend describe, counter fill, no post usage",
    present: true,
    body: {
      totalTokens: 9_000,
      contextTokens: 372_000,
      costUsd: null,
      fillPct: 2,
      fillSource: "counter",
      model: "gpt-5.6-luna",
      toolCalls: 0,
      pressureSource: "presend_describe",
      turnOrigin: "dispatch",
      compaction: "preflight",
      compactionReason: "threshold",
      errorKind: null,
      stopReason: "end_turn",
      finalizeCause: "gateway_final",
      postTotalTokens: null,
      postInputTokens: null,
      postOutputTokens: null,
      postCostUsd: null,
    },
  },
  {
    name: "gateway-initiated delivery (the prod anomaly)",
    present: false,
    body: {
      totalTokens: null,
      contextTokens: null,
      costUsd: null,
      toolCalls: 23,
      pressureSource: "absent",
      turnOrigin: "gateway_initiated",
      compaction: null,
      errorKind: null,
      stopReason: "end_turn",
      finalizeCause: "gateway_final",
      postTotalTokens: null,
      postInputTokens: null,
      postOutputTokens: null,
      postCostUsd: null,
    },
  },
  {
    name: "dispatch whose describe answered without counters",
    present: false,
    body: {
      totalTokens: null,
      contextTokens: 272_000,
      costUsd: null,
      fillPct: null,
      fillSource: null,
      model: "gpt-5.5",
      toolCalls: 1,
      pressureSource: "presend_describe",
      turnOrigin: "dispatch",
      compaction: null,
      errorKind: null,
      stopReason: "stop",
      finalizeCause: "gateway_final",
      postTotalTokens: null,
      postInputTokens: null,
      postOutputTokens: null,
      postCostUsd: null,
    },
  },
];

const RECORD = process.env.GATEWAY_PRESSURE_RECORD;
const BASELINE_PATH = new globalThis.URL("./fixtures/gateway-pressure-baseline-v0970.json", import.meta.url);

async function storedMetas(): Promise<Record<string, Record<string, unknown>>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const c of CASES) {
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seed(t);
    const res = await post(t, { op: "gatewayPressure", chatId, messageId, ...c.body });
    expect(res.status).toBe(200);
    const [meta] = await metas(t);
    out[c.name] = meta!;
  }
  return out;
}

describe("chat.gateway_pressure — baseline", () => {
  test.runIf(RECORD !== undefined)("record the stored metas (run on the v0.97.0 tree)", async () => {
    writeFileSync(RECORD!, `${JSON.stringify(await storedMetas(), null, 2)}\n`);
  });
});

const baseline = (): Record<string, Record<string, unknown>> =>
  JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Record<string, Record<string, unknown>>;

const NULL_COUNTERS = ["totalTokens", "contextTokens", "fillPct", "fillSource"];

describe("chat.gateway_pressure — a complete reading is unchanged, a missing one says why", () => {
  test.runIf(RECORD === undefined)(
    "INVARIANCE: a complete reading stores 0.97.0's meta plus telemetryStatus only",
    async () => {
      const now = await storedMetas();
      const before = baseline();
      for (const c of CASES.filter((x) => x.present)) {
        expect(now[c.name], c.name).toStrictEqual({ ...before[c.name], telemetryStatus: "present" });
      }
    },
  );

  test.runIf(RECORD === undefined)(
    "an older bridge's null counters (0.97.0 bodies): left out, and the cause re-derived from its labels",
    async () => {
      const now = await storedMetas();
      const before = baseline();
      const gw = now["gateway-initiated delivery (the prod anomaly)"]!;
      const { totalTokens: _a, contextTokens: _b, fillPct: _c, ...restGw } =
        before["gateway-initiated delivery (the prod anomaly)"]!;
      expect(gw).toStrictEqual({
        ...restGw,
        telemetryStatus: "missing",
        telemetryMissing: ["totalTokens", "contextTokens", "fillPct"],
        telemetryCause: "gateway_initiated_run",
      });
      const partial = now["dispatch whose describe answered without counters"]!;
      const { totalTokens: _d, fillPct: _e, ...restP } =
        before["dispatch whose describe answered without counters"]!;
      expect(partial).toStrictEqual({
        ...restP,
        telemetryStatus: "partial",
        telemetryMissing: ["totalTokens", "fillPct"],
        telemetryCause: "describe_without_counters",
      });
      for (const meta of [gw, partial]) {
        for (const k of NULL_COUNTERS) expect(meta[k], k).not.toBeNull();
      }
    },
  );

  test("complete and missing readings ALTERNATING in one conversation: each trace judged on its own", async () => {
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seed(t);
    const complete = CASES[0]!.body;
    const delivery = {
      ...CASES[2]!.body,
      totalTokens: undefined,
      contextTokens: undefined,
      telemetryStatus: "missing",
      telemetryMissing: ["totalTokens", "contextTokens", "fillPct"],
      telemetryCause: "gateway_initiated_run",
      agentId: "denis",
      gatewayVersion: "2026.9.8",
      runModel: "gpt-5.5",
      runOutputTokens: 217,
    };
    for (const body of [complete, delivery, complete, delivery]) {
      const res = await post(t, { op: "gatewayPressure", chatId, messageId, ...body });
      expect(res.status).toBe(200);
    }
    const stored = await metas(t);
    expect(stored.map((m) => m.telemetryStatus)).toEqual(["present", "missing", "present", "missing"]);
    for (const m of [stored[1]!, stored[3]!]) {
      expect(m).toMatchObject({
        telemetryCause: "gateway_initiated_run",
        gatewayVersion: "2026.9.8",
        runOutputTokens: 217,
      });
      // No gateway-supplied free string (codex phase 6 pass 3): no run model, no agent.
      for (const k of ["model", "modelSource", "agentKey", "agentId", "runModel"]) expect(k in m, k).toBe(false);
      for (const k of NULL_COUNTERS) expect((k in m), k).toBe(false);
      expect(JSON.stringify(m)).not.toContain("denis");
    }
    // The complete ones carry their counters and nothing of the missing-reading block.
    for (const m of [stored[0]!, stored[2]!]) {
      expect(m).toMatchObject({ totalTokens: 41_000, contextTokens: 272_000, fillPct: 15 });
      for (const k of ["telemetryMissing", "telemetryCause", "agentKey", "gatewayVersion", "runOutputTokens", "modelSource"]) {
        expect((k in m), k).toBe(false);
      }
    }
  });

  test("the boundary decides: a divergent cause, version or model is dropped; a 'present' claim over null counters is overruled", async () => {
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seed(t);
    await post(t, {
      op: "gatewayPressure",
      chatId,
      messageId,
      totalTokens: null,
      contextTokens: null,
      compaction: null,
      pressureSource: "absent",
      turnOrigin: "gateway_initiated",
      telemetryStatus: "present",
      telemetryCause: "the user Jean asked about 4000 EUR",
      gatewayVersion: "2026.9.8 (patched by Jean)",
      runModel: "gpt 5.5 for Jean",
      agentId: "nobody-registered",
    });
    const [m] = await metas(t);
    expect(m).toMatchObject({ telemetryStatus: "missing", telemetryCause: "gateway_initiated_run" });
    for (const k of ["gatewayVersion", "model", "agentKey", "totalTokens"]) {
      expect((k in m!), k).toBe(false);
    }
    expect(JSON.stringify(m)).not.toMatch(/Jean|EUR|nobody/);
  });

  test("a fill the bridge LEFT OUT and said it could not determine is never re-derived as a ratio", async () => {
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seed(t);
    await post(t, {
      op: "gatewayPressure",
      chatId,
      messageId,
      totalTokens: 19_698,
      contextTokens: 272_000,
      compaction: null,
      pressureSource: "presend_describe",
      turnOrigin: "dispatch",
      telemetryStatus: "partial",
      telemetryMissing: ["fillPct"],
      telemetryCause: "fill_undetermined",
    });
    const [m] = await metas(t);
    expect(m).toMatchObject({
      totalTokens: 19_698,
      contextTokens: 272_000,
      telemetryStatus: "partial",
      telemetryMissing: ["fillPct"],
      telemetryCause: "fill_undetermined",
    });
    expect("fillPct" in m!, "a ratio of our own answered a fill the send path declined").toBe(false);
  });

  test.each([
    ["an e-mail address", "alice@example.invalid"],
    ["a free-form slug", "projet-confidentiel-jean-dupont"],
    ["a model the gateway never declared", "gpt-9-secret"],
    // codex phase 6 pass 3: a roster entry is a free string too (models.list only requires
    // a non-empty one) — even a DECLARED model is never stored for a run.
    ["a model the gateway DECLARED", "gpt-5.6-luna"],
  ])("the run's announced model is NEVER stored, even %s (codex phase 6 passes 2-3)", async (_n, announced) => {
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seed(t);
    await post(t, {
      op: "gatewayPressure",
      chatId,
      messageId,
      totalTokens: undefined,
      contextTokens: undefined,
      compaction: null,
      pressureSource: "absent",
      turnOrigin: "gateway_initiated",
      telemetryStatus: "missing",
      telemetryCause: "gateway_initiated_run",
      agentId: "denis",
      runModel: announced,
    });
    const [m] = await metas(t);
    expect(m).toMatchObject({ telemetryStatus: "missing" });
    expect("model" in m!).toBe(false);
    expect("modelSource" in m!).toBe(false);
    expect(JSON.stringify(m)).not.toContain(announced);
  });

  test.each(["2026.9.8 (patched)", "2026.9.8-r5", "v2026.9.8", "2026.9.8/../x", "alice@2026.9.8"])(
    "a gateway version that is not strictly a release number (%s) is dropped",
    async (version) => {
      const t = convexTest(schema, modules);
      const { chatId, messageId } = await seed(t);
      await post(t, { op: "gatewayPressure", chatId, messageId, compaction: null, pressureSource: "absent", turnOrigin: "gateway_initiated", gatewayVersion: version });
      const [m] = await metas(t);
      expect("gatewayVersion" in m!).toBe(false);
    },
  );

  test.each(["2026.9.8", "2026.7.2-beta.5"])("a release number (%s) is kept", async (version) => {
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seed(t);
    await post(t, { op: "gatewayPressure", chatId, messageId, compaction: null, pressureSource: "absent", turnOrigin: "gateway_initiated", gatewayVersion: version });
    const [m] = await metas(t);
    expect(m?.gatewayVersion).toBe(version);
  });

  test("a bridge with no labels at all: missing, cause unknown — never a silent null", async () => {
    const t = convexTest(schema, modules);
    const { chatId, messageId } = await seed(t);
    await post(t, { op: "gatewayPressure", chatId, messageId, totalTokens: null, contextTokens: null, compaction: null });
    const [m] = await metas(t);
    expect(m).toMatchObject({ telemetryStatus: "missing", telemetryCause: "unknown" });
    expect(Object.values(m!).includes(null as never) && Object.keys(m!).some((k) => k !== "compaction" && m![k] === null)).toBe(false);
  });
});

describe("chat.gateway_pressure — one vocabulary on both sides of the wire", () => {
  test("every cause the bridge can send is one this boundary keeps (plus `unknown` for a bridge that sends none)", () => {
    expect([...PRESSURE_TELEMETRY_CAUSES].sort()).toEqual(
      [...BRIDGE_CAUSES, "unknown"].sort(),
    );
  });
});
