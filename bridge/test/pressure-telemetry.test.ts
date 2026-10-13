// `chat.gateway_pressure`: a missing reading is SAID, with its cause — never a silent null.
//
// Production, 2026-10-10: 53 of 58 traces in six hours carried `totalTokens`,
// `contextTokens` and `fillPct` all null, alternating with complete ones in the same
// conversation. Every null one was a gateway-initiated run (a sub-agent delivery): the
// gateway gives such a run no pre-send describe (Atrium never sent it) and attaches its
// session snapshot only to the tool events of the connection that issued `chat.send`
// (src/gateway/server-methods/chat-send-agent-dispatch.ts:429,449 registers the
// recipient; src/gateway/server-chat.ts:1548-1562 merges the snapshot, v2026.9.8). No chat
// terminal carries usage at all: `usage` is declared on the delta/final/side-result frames
// (packages/gateway-protocol/src/schema/logs-chat.ts:406,414,483) and nothing in the
// server-chat path fills it.
//
// Invariance first: the body of a turn whose counters ARE present is the one 0.97.0 sent
// (`fixtures/pressure-telemetry-baseline-v0970.json`, recorded on the v0.97.0 tree with
// PRESSURE_TELEMETRY_RECORD=<path> before any change).

import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { ConvexWriter, ToolPart } from "../src/convex-writer.js";
import {
  pressureTelemetry,
  withPressureTelemetry,
} from "../src/core/pressure-telemetry.js";
import { RunManager } from "../src/providers/openclaw/run-manager.js";

const SK = "agent:denis:atrium:chat:u-test:c-1";

class TraceWriter implements ConvexWriter {
  readonly pressures: Record<string, unknown>[] = [];
  private n = 0;
  async startAssistant(): Promise<string> {
    return `msg_${++this.n}`;
  }
  async appendDelta(): Promise<void> {}
  async setSnapshot(): Promise<boolean> {
    return true;
  }
  async addToolPart(_m: string, _p: ToolPart): Promise<void> {}
  async addCompactionPart(): Promise<void> {}
  async recordGatewayPressure(
    _chatId: string,
    _messageId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    this.pressures.push(JSON.parse(JSON.stringify(data)) as Record<string, unknown>);
  }
  async addProvenancePart(): Promise<void> {}
  async addMedia(): Promise<boolean> {
    return true;
  }
  async noteMediaUndelivered(): Promise<void> {}
  async noteFrameGap(): Promise<void> {}
  async finalize(): Promise<void> {}
  async getRehydrationContext(): Promise<{ history: string | null; turnCount: number }> {
    return { history: null, turnCount: 0 };
  }
  async reportSessionMeta(): Promise<void> {}
  async reportSessionRoster(): Promise<void> {}
  async upsertSubAgent(): Promise<void> {}
  async upsertSubAgentToolPart(): Promise<void> {}
  async recordInteractionReply(): Promise<void> {}
  async emitRehydrateTrace(): Promise<void> {}
}

const final = (runId: string, stopReason: string) => ({
  type: "event" as const,
  event: "chat",
  payload: {
    runId,
    sessionKey: SK,
    state: "final",
    stopReason,
    message: { role: "assistant", content: [{ type: "text", text: "Here is the report you asked for." }] },
  },
});
/** The run's executing model, as every run announces it (agent-events.ts lifecycle
 *  `phase:"model"`; captured on the 9.8 bench for dispatches AND deliveries). */
const modelFrame = (runId: string, model: string | null) => ({
  type: "event" as const,
  event: "agent",
  payload: {
    runId,
    sessionKey: SK,
    agentId: "denis",
    stream: "lifecycle",
    data: { phase: "model", provider: model === null ? null : "openai", model },
    isHeartbeat: false,
  },
});
/** The per-run output tokens every run reports (infra/agent-run-usage.ts:16-34). */
const usageFrame = (runId: string, outputTokens: number) => ({
  type: "event" as const,
  event: "agent",
  payload: { runId, sessionKey: SK, stream: "usage", data: { outputTokens }, isHeartbeat: false },
});

const DELIVERY_A = "announce:v1:agent:denis:subagent:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222";
const DELIVERY_B = "announce:v1:agent:denis:subagent:33333333-3333-4333-8333-333333333333:44444444-4444-4444-8444-444444444444";

async function settle(writer: TraceWriter, n: number): Promise<void> {
  for (let i = 0; i < 40 && writer.pressures.length < n; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** One conversation: dispatch (counters present) → delivery (none) → dispatch → delivery. */
async function alternatingChat(opts: {
  withRunFacts: boolean;
  /** Run facts on the FIRST delivery only (a later turn must not inherit them). */
  firstDeliveryOnly?: boolean;
}): Promise<Record<string, unknown>[]> {
  const writer = new TraceWriter();
  const manager = new RunManager("chat-alt", SK, writer);
  manager.setGatewayVersionSource(() => "2026.9.8");
  let t = 1000;
  for (let i = 0; i < 2; i++) {
    const own = `webchat-own-${i}`;
    await manager.beginTurn(t, own, {
      expectedSessionId: null,
      pressure: {
        totalTokens: 40_000 + i,
        contextTokens: 272_000,
        fillPct: 15,
        fillSource: "gateway_estimate",
        model: "gpt-5.5",
      },
      dispatchOutboxId: `ob-${i}`,
    });
    if (opts.withRunFacts) await manager.feed(modelFrame(own, "gpt-5.5"), t + 10);
    await manager.feed(final(own, "stop"), t + 100);
    await settle(writer, 2 * i + 1);
    const delivery = i === 0 ? DELIVERY_A : DELIVERY_B;
    if (opts.withRunFacts && (opts.firstDeliveryOnly !== true || i === 0)) {
      await manager.feed(modelFrame(delivery, "alice@example.invalid"), t + 1000);
      await manager.feed(usageFrame(delivery, 217 + i), t + 1010);
    }
    // The run's exit resets its model (`phase:"model"`, model null, before `end` — 9.8 bench).
    if (opts.withRunFacts) await manager.feed(modelFrame(delivery, null), t + 1090);
    await manager.feed(final(delivery, "end_turn"), t + 1100);
    await settle(writer, 2 * i + 2);
    t += 10_000;
  }
  return writer.pressures;
}

const RECORD = process.env.PRESSURE_TELEMETRY_RECORD;

describe("chat.gateway_pressure — baseline", () => {
  it.runIf(RECORD !== undefined)("record the posted bodies (run on the v0.97.0 tree)", async () => {
    writeFileSync(
      RECORD!,
      `${JSON.stringify(await alternatingChat({ withRunFacts: true }), null, 2)}\n`,
    );
  });
});

const baseline = (): Record<string, unknown>[] =>
  JSON.parse(
    readFileSync(new URL("./fixtures/pressure-telemetry-baseline-v0970.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>[];

describe("chat.gateway_pressure — a complete reading is unchanged, a missing one says why", () => {
  it("alternating complete / missing readings in ONE conversation: each trace is judged on its own", async () => {
    const posted = await alternatingChat({ withRunFacts: true });
    const before = baseline();
    expect(posted).toHaveLength(4);
    expect(before).toHaveLength(4);
    // INVARIANCE: the complete readings are 0.97.0's bodies, byte for byte.
    expect(posted[0]).toStrictEqual(before[0]);
    expect(posted[2]).toStrictEqual(before[2]);
    // The missing ones: 0.97.0's body WITHOUT the null counters, plus the explicit gap.
    for (const [i, outputTokens] of [
      [1, 217],
      [3, 218],
    ] as const) {
      const { totalTokens: _t, contextTokens: _c, ...rest } = before[i]!;
      expect(posted[i]).toStrictEqual({
        ...rest,
        telemetryStatus: "missing",
        telemetryMissing: ["totalTokens", "contextTokens", "fillPct"],
        telemetryCause: "gateway_initiated_run",
        gatewayVersion: "2026.9.8",
        runOutputTokens: outputTokens,
      });
      // The run's announced model is free gateway text: never carried (codex phase 6 pass 3),
      // even when it looks like a person's address.
      expect(JSON.stringify(posted[i])).not.toContain("alice@example.invalid");
      // Never a silent null where a counter belongs.
      for (const k of ["totalTokens", "contextTokens", "fillPct", "fillSource"]) {
        expect(Object.hasOwn(posted[i]!, k), k).toBe(false);
      }
    }
  });

  it("a delivery's run facts never ride the next turn's trace", async () => {
    const posted = await alternatingChat({ withRunFacts: true, firstDeliveryOnly: true });
    expect(posted[1]).toMatchObject({ runOutputTokens: 217 });
    expect(posted[3]?.telemetryStatus).toBe("missing");
    expect(Object.hasOwn(posted[3]!, "runOutputTokens")).toBe(false);
  });
});

describe("chat.gateway_pressure — a dispatch whose describe had no counters", () => {
  it("leaves out the missing counters AND the fill's source, keeps the window it had", async () => {
    const writer = new TraceWriter();
    const manager = new RunManager("chat-partial", SK, writer);
    manager.setGatewayVersionSource(() => "2026.9.8");
    await manager.beginTurn(1000, "webchat-own-p", {
      expectedSessionId: null,
      pressure: { totalTokens: null, contextTokens: 272_000, fillPct: null, fillSource: null, model: "gpt-5.5" },
      dispatchOutboxId: "ob-p",
    });
    await manager.feed(final("webchat-own-p", "stop"), 1100);
    await settle(writer, 1);
    expect(writer.pressures).toHaveLength(1);
    const p = writer.pressures[0]!;
    expect(p).toMatchObject({
      contextTokens: 272_000,
      model: "gpt-5.5",
      telemetryStatus: "partial",
      telemetryMissing: ["totalTokens", "fillPct"],
      telemetryCause: "describe_without_counters",
    });
    for (const k of ["totalTokens", "fillPct", "fillSource"]) {
      expect(Object.hasOwn(p, k), k).toBe(false);
    }
  });
});

describe("chat.gateway_pressure — the gateway version is strictly a release number (codex phase 6 pass 2)", () => {
  it.each([
    ["2026.9.8", true],
    ["2026.7.2-beta.5", true],
    ["2026.9.8 (patched by alice@example.invalid)", false],
    ["2026.9.8-r5", false],
    ["v2026.9.8", false],
  ] as const)("%s", async (version, kept) => {
    const writer = new TraceWriter();
    const manager = new RunManager("chat-v", SK, writer);
    manager.setGatewayVersionSource(() => version);
    await manager.feed(final(DELIVERY_A, "end_turn"), 2000);
    await settle(writer, 1);
    expect(writer.pressures[0]?.gatewayVersion).toBe(kept ? version : undefined);
  });
});

describe("pressureTelemetry — the verdict on one reading", () => {
  const full = { totalTokens: 10, contextTokens: 100, fillPct: 10 };
  it.each([
    ["complete reading", full, "dispatch", { status: "present" }],
    [
      "gateway-initiated run, no describe",
      null,
      "gateway_initiated",
      { status: "missing", missing: ["totalTokens", "contextTokens", "fillPct"], cause: "gateway_initiated_run" },
    ],
    [
      "dispatch whose describe did not happen",
      null,
      "dispatch",
      { status: "missing", missing: ["totalTokens", "contextTokens", "fillPct"], cause: "presend_describe_unavailable" },
    ],
    [
      "the describe FAILED: the send still carries a reading, all null (codex phase 6 pass 1)",
      { totalTokens: null, contextTokens: null, fillPct: null, describe: "failed" },
      "dispatch",
      { status: "missing", missing: ["totalTokens", "contextTokens", "fillPct"], cause: "presend_describe_unavailable" },
    ],
    [
      "describe without totals",
      { totalTokens: null, contextTokens: 272_000, fillPct: null },
      "dispatch",
      { status: "partial", missing: ["totalTokens", "fillPct"], cause: "describe_without_counters" },
    ],
    [
      "a zero context window is not a window",
      { totalTokens: 10, contextTokens: 0, fillPct: 3 },
      "dispatch",
      { status: "partial", missing: ["contextTokens"], cause: "describe_without_counters" },
    ],
    [
      "counters but no fill",
      { totalTokens: 10, contextTokens: 100, fillPct: null },
      "dispatch",
      { status: "partial", missing: ["fillPct"], cause: "fill_undetermined" },
    ],
    [
      "NaN and negatives are not readings",
      { totalTokens: Number.NaN, contextTokens: -1, fillPct: Number.POSITIVE_INFINITY },
      "dispatch",
      { status: "missing", missing: ["totalTokens", "contextTokens", "fillPct"], cause: "describe_without_counters" },
    ],
  ] as const)("%s", (_name, reading, origin, expected) => {
    expect(pressureTelemetry(reading, origin)).toStrictEqual(expected);
  });

  it("a complete reading returns the body object itself — not a copy, not a single key added", () => {
    const body = { totalTokens: 10, contextTokens: 100, fillPct: 10, toolCalls: 0 };
    const ctx = { gatewayVersion: "2026.9.8", runOutputTokens: 1 };
    expect(withPressureTelemetry(body, body, "dispatch", ctx)).toBe(body);
  });

});
