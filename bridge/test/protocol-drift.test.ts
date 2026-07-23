// Protocol-drift detector (Inc 2): observe-only classification of inbound
// chat/agent frames against the vendored protocol surface. Two guarantees are
// pinned here:
//   1. behavior — unknown fields are counted (names only), known fields are
//      silent, nothing ever throws or gates a frame, the registry is bounded;
//   2. the CHAIN — the runtime known-field sets are a BIJECTION of the
//      coverage manifest's per-field entries (which the coverage ratchet in
//      turn pins against the vendored TypeBox schemas). One chain:
//        vendored schema <-> coverage.json <-> runtime sets.

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  COVERAGE_SUMMARY,
  KNOWN_AGENT_FIELDS,
  KNOWN_CHAT_FIELDS,
  protocolDrift,
} from "../src/providers/openclaw/protocol-drift.js";

afterEach(() => protocolDrift.resetForTests());

const SESSION_KEY = "agent:alice:atrium:chat:olivier:driftchat";

function chatFrame(extra: Record<string, unknown> = {}): unknown {
  return {
    type: "event",
    event: "chat",
    payload: {
      runId: "webchat-x",
      sessionKey: SESSION_KEY,
      seq: 1,
      state: "delta",
      deltaText: "bonjour",
      ...extra,
    },
  };
}

describe("protocol drift detector", () => {
  it("a fully-known frame reports zero drift", () => {
    protocolDrift.observe(chatFrame());
    expect(protocolDrift.report()).toEqual([]);
  });

  it("an unknown chat payload field is counted by NAME (never a value)", () => {
    protocolDrift.observe(chatFrame({ steerHint: "secret content" }));
    protocolDrift.observe(chatFrame({ steerHint: "other content" }));
    expect(protocolDrift.report()).toEqual([{ shape: "chat.steerHint", count: 2 }]);
  });

  it("agent frames are classified against their own surface", () => {
    protocolDrift.observe({
      type: "event",
      event: "agent",
      payload: {
        runId: "r",
        seq: 1,
        stream: "assistant",
        ts: 1,
        data: {},
        brandNewField: 42,
      },
    });
    expect(protocolDrift.report()).toEqual([
      { shape: "agent.brandNewField", count: 1 },
    ]);
  });

  it("the 2026.6.11 sub-agent metadata fields report ZERO drift (live ataraxis 2026-07-10)", () => {
    // The exact prod symptom: an agent frame carrying the child's role/scope, its
    // parent session key, runtime, and child-session list must be fully known now.
    protocolDrift.observe({
      type: "event",
      event: "agent",
      payload: {
        runId: "r",
        seq: 1,
        stream: "assistant",
        ts: 1,
        data: {},
        subagentRole: "worker",
        subagentControlScope: "session",
        parentSessionKey: "agent:x:webchat:chat:c:1",
        runtimeMs: 1234,
        childSessions: ["agent:x:subagent:uuid"],
      },
    });
    expect(protocolDrift.report()).toEqual([]);
  });

  it("non-chat/agent events and malformed frames are ignored, never thrown on", () => {
    protocolDrift.observe({ type: "event", event: "health", payload: { weird: 1 } });
    protocolDrift.observe(null);
    protocolDrift.observe("garbage");
    protocolDrift.observe({ type: "event", event: "chat", payload: null });
    expect(protocolDrift.report()).toEqual([]);
  });

  it("the tracked-shape registry is bounded", () => {
    for (let i = 0; i < 250; i++) {
      protocolDrift.observe(chatFrame({ [`field${i}`]: true }));
    }
    expect(protocolDrift.report().length).toBeLessThanOrEqual(100);
  });
});

describe("runtime sets <-> coverage manifest bijection (the anti-drift chain)", () => {
  interface Manifest {
    schemas: Record<
      string,
      { fields?: Record<string, unknown> } & Record<string, unknown>
    >;
  }
  const MANIFEST = JSON.parse(
    readFileSync(
      new URL("../protocol/openclaw/coverage.json", import.meta.url),
      "utf-8",
    ),
  ) as Manifest;

  it("KNOWN_CHAT_FIELDS == union of the four chat event schemas' manifest fields", () => {
    const union = new Set<string>();
    for (const name of [
      "ChatDeltaEvent",
      "ChatFinalEvent",
      "ChatAbortedEvent",
      "ChatErrorEvent",
    ]) {
      for (const f of Object.keys(MANIFEST.schemas[name]?.fields ?? {})) {
        union.add(f);
      }
    }
    expect([...KNOWN_CHAT_FIELDS].sort()).toEqual([...union].sort());
  });

  it("COVERAGE_SUMMARY == a recount of the manifest (counts + gap list)", () => {
    const counts = { handled: 0, ignored: 0, gap: 0 };
    const gaps: string[] = [];
    for (const [name, entry] of Object.entries(MANIFEST.schemas)) {
      if (entry.fields !== undefined) {
        for (const [f, fe] of Object.entries(entry.fields)) {
          const st = (fe as { status: keyof typeof counts }).status;
          counts[st]++;
          if (st === "gap") gaps.push(`${name}.${f}`);
        }
      } else {
        const st = (entry as { status: keyof typeof counts }).status;
        counts[st]++;
        if (st === "gap") gaps.push(name);
      }
    }
    expect(COVERAGE_SUMMARY.handled).toBe(counts.handled);
    expect(COVERAGE_SUMMARY.ignored).toBe(counts.ignored);
    expect(COVERAGE_SUMMARY.gaps).toBe(counts.gap);
    expect([...COVERAGE_SUMMARY.gapList].sort()).toEqual(gaps.sort());
  });

  it("KNOWN_AGENT_FIELDS == AgentEvent manifest fields + the documented wire envelope", () => {
    const manifest = new Set(
      Object.keys(MANIFEST.schemas.AgentEvent?.fields ?? {}),
    );
    // The wire envelope the gateway stamps beyond AgentEventSchema (documented
    // in protocol-drift.ts; pinned on the live capture):
    for (const f of [
      "sessionKey",
      "sessionId",
      "agentId",
      // session/run metadata envelope (see protocol-drift.ts, live dev 2026-07-04)
      "session",
      "updatedAt",
      "kind",
      "channel",
      "chatType",
      "origin",
      "deliveryContext",
      "verboseLevel",
      "systemSent",
      "lastChannel",
      "totalTokens",
      "totalTokensFresh",
      // config-dependent session metadata (emitted only when the gateway's chat
      // defaults define them — live ataraxis 2026-07-06) + spawn statics on
      // child frames (bench 2026.6.11): see protocol-drift.ts.
      "thinkingLevel",
      "fastMode",
      "spawnedWorkspaceDir",
      "spawnDepth",
      "goal",
      "estimatedCostUsd",
      "modelProvider",
      "model",
      "status",
      "startedAt",
      "abortedLastRun",
      "inputTokens",
      "outputTokens",
      "contextTokens",
      // sub-agent metadata flattened onto agent events (live ataraxis 2026-07-10)
      "subagentRole",
      "subagentControlScope",
      "parentSessionKey",
      "runtimeMs",
      "childSessions",
      // 2026.7.1 session-config metadata (bench capture 2026-07-11, beta.2)
      "effectiveResponseUsage",
      // spawn/agent-identity statics (live ataraxis 2026-07-19, prod badge)
      "spawnedCwd",
      "label",
      "displayName",
      // run-registry terminal timestamp (live ataraxis 2026-07-22, prod badge)
      "endedAt",
    ])
      manifest.add(f);
    expect([...KNOWN_AGENT_FIELDS].sort()).toEqual([...manifest].sort());
  });
});
