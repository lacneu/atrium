// THE SEND PATH, projection `on` vs off (phase 3): the real performSend against a
// scripted gateway, reading what `chat.send` carried and whether a turn began.

import { afterEach, describe, expect, it, vi } from "vitest";
import { performSend, planProjectedStop, sendProjectedStop } from "../src/server.js";
import { projectedAbortTarget, projectedStopRun } from "../src/core/rpc-params.js";
import { SessionRegistry } from "../src/session.js";
import type { BridgeConfig } from "../src/config.js";
import type { ConvexWriter } from "../src/convex-writer.js";
import { GatewayAnsweredError, OpenClawConnection } from "../src/providers/openclaw/openclaw-client.js";
import { fakeGateway, type FakeGateway, type FakeRpcAnswer } from "./helpers/fake-gateway.js";
import { servedMap } from "./helpers/served.js";
import { sleep } from "./helpers/sleep.js";

const config = {
  openclawGatewayUrl: "ws://127.0.0.1:1",
  openclawToken: "t",
  deviceIdentity: { id: "i", publicKey: "p", privateKey: "k" },
  instanceName: "primary",
} as unknown as BridgeConfig;

const ROUTING = {
  chatId: "c1",
  openclawChatId: "turn:x",
  agentId: "alice",
  canonical: "olivier",
  instanceName: "primary",
};

function body(projection: "on" | "shadow" | "off", extra: Record<string, unknown> = {}) {
  return {
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
    config: { transcriptProjection: projection },
    ...extra,
  } as unknown as Parameters<typeof performSend>[1];
}

async function harness(
  answers: Record<string, FakeRpcAnswer>,
  extra: Partial<Parameters<typeof fakeGateway>[0]> = {},
) {
  const gw = fakeGateway({ describe: [{ sessionId: "s-1", systemSent: true }], answers, ...extra });
  vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => gw as never);
  const started: Array<string | null> = [];
  const writer = {
    startAssistant: async (_c: string, runId: string | null) => {
      started.push(runId);
      return `msg-${started.length}`;
    },
    appendDelta: async () => {},
    setSnapshot: async () => true,
    addToolPart: async () => {},
    addMedia: async () => {},
    finalize: async () => {},
    reportSessionMeta: async () => {},
    recordGatewayPressure: async () => {},
    clearSessionState: async () => {},
    applyTranscript: async () => {},
    getRehydrationContext: async () => ({ history: null, turnCount: 0 }),
    emitRehydrateTrace: () => {},
  } as unknown as ConvexWriter;
  const reg = new SessionRegistry(servedMap(config, writer), () => 1000);
  const session = await reg.acquire(ROUTING);
  await sleep(5);
  (session.connection as unknown as { gatewayVersion: string }).gatewayVersion = "2026.9.8";
  return { gw: session.connection as unknown as FakeGateway, session, writer, started };
}

/** Phase 4: on a projected session a turn begins on the ACK but its BUBBLE is born from
 *  the run — nothing is created until the run's first visible content. */
async function expectTurnBornFromRun(h: Awaited<ReturnType<typeof harness>>, runId: string) {
  expect(h.session.runManager.turnActive).toBe(true);
  expect(h.session.runManager.activeRunIds).toContain(runId);
  const before = h.started.length;
  expect(h.started.slice(before)).toEqual([]);
  await h.session.runManager.feed(
    {
      type: "event",
      event: "chat",
      payload: {
        sessionKey: h.session.sessionKey,
        runId,
        state: "delta",
        message: { role: "assistant", content: [{ type: "text", text: "bonjour" }] },
      },
    },
    1001,
  );
  expect(h.started.slice(before)).toEqual([runId]);
}

const sends = (gw: FakeGateway) =>
  gw.calls.filter(([m]) => m === "chat.send").map(([, p]) => p as Record<string, unknown>);

const ACTIVE = {
  "chat.history": {
    payload: {
      sessionInfo: { hasActiveRun: true, activeRunIds: ["runA"], effectiveQueueMode: "steer" },
      inFlightRun: { runId: "runA" },
    },
  },
  "chat.send": { payload: { status: "started", runId: "ack-1" } },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("off / shadow: the legacy send, unchanged", () => {
  for (const mode of ["off", "shadow"] as const) {
    it(`${mode}: no queueMode even with a run active, and the turn begins on the ACK`, async () => {
      const h = await harness(ACTIVE);
      await performSend(h.session, body(mode), h.writer, null, null);
      expect(sends(h.gw)[0]).not.toHaveProperty("queueMode");
      expect(h.started).toEqual(["ack-1"]);
    });
  }
});

describe("on: the Control UI's send", () => {
  it("idle gateway: no queueMode (no run policy), a turn begins", async () => {
    const h = await harness({
      "chat.history": { payload: { sessionInfo: { hasActiveRun: false, effectiveQueueMode: "steer" } } },
      "chat.send": { payload: { status: "started", runId: "ack-1" } },
    });
    await performSend(h.session, body("on"), h.writer, null, null);
    expect(sends(h.gw)[0]).not.toHaveProperty("queueMode");
    expect(h.started).toEqual([]);
    await expectTurnBornFromRun(h, "ack-1");
  });

  it("phase 4: an ACK that names no run never opens the turn to ANY run — the send's identity is its run", async () => {
    const idle = { "chat.history": { payload: { sessionInfo: { hasActiveRun: false } } } };
    const on = await harness({ ...idle, "chat.send": { payload: { status: "started" } } });
    await performSend(on.session, body("on"), on.writer, null, null);
    const key = sends(on.gw)[0]!.idempotencyKey as string;
    expect(key).toBeTruthy();
    expect(on.session.runManager.activeRunIds).toEqual([key]);
    const off = await harness({ ...idle, "chat.send": { payload: { status: "started" } } });
    await performSend(off.session, body("shadow"), off.writer, null, null);
    expect(off.session.runManager.activeRunIds).toEqual([]);
  });

  it("a run active at the gateway, none here: explicit queueMode, the send is a held input — that run is never its bubble", async () => {
    const h = await harness({
      ...ACTIVE,
      "chat.history": {
        payload: { sessionInfo: { hasActiveRun: true, activeRunIds: ["runA"], effectiveQueueMode: "followup" } },
      },
    });
    await performSend(h.session, body("on"), h.writer, null, null);
    expect(sends(h.gw)[0]).toMatchObject({ queueMode: "followup" });
    // No turn, no bubble on the ACK, nothing adopted: the input waits for its answer.
    expect(h.started).toEqual([]);
    expect(h.session.runManager.activeRunIds).toEqual([]);
    expect(h.session.runManager.outstandingInputs).toHaveLength(1);
  });

  it("interrupt with a run active at the gateway, none here: a turn on the ACK, that run not adopted", async () => {
    const h = await harness({
      ...ACTIVE,
      "chat.history": {
        payload: { sessionInfo: { hasActiveRun: true, activeRunIds: ["runA"], effectiveQueueMode: "steer" } },
      },
    });
    await performSend(h.session, body("on", { followUpMode: "interrupt" }), h.writer, null, null);
    expect(sends(h.gw)[0]).toMatchObject({ queueMode: "interrupt" });
    expect(h.session.runManager.activeRunIds).toEqual(["ack-1"]);
    await expectTurnBornFromRun(h, "ack-1");
  });

  it("a turn in the foreground HERE: the send is custody only — steer, no new bubble", async () => {
    const h = await harness(ACTIVE);
    await h.session.runManager.beginTurn(1000, "runA", { expectedSessionId: null });
    h.session.runManager.setProjection(true);
    const before = h.started.length;
    await performSend(h.session, body("on"), h.writer, null, null);
    expect(sends(h.gw)[0]).toMatchObject({ queueMode: "steer" });
    expect(h.started.length).toBe(before);
    expect(h.session.runManager.outstandingInputs).toHaveLength(1);
  });

  it("the person's `queue` choice never rides the wire (client mode)", async () => {
    const h = await harness(ACTIVE);
    await h.session.runManager.beginTurn(1000, "runA", { expectedSessionId: null });
    await performSend(h.session, body("on", { followUpMode: "queue" }), h.writer, null, null);
    expect(sends(h.gw)[0]).not.toHaveProperty("queueMode");
  });

  it("interrupt replaces the foreground turn: a new bubble on its ACK", async () => {
    const h = await harness(ACTIVE);
    await h.session.runManager.beginTurn(1000, "runA", { expectedSessionId: null });
    await performSend(h.session, body("on", { followUpMode: "interrupt" }), h.writer, null, null);
    expect(sends(h.gw)[0]).toMatchObject({ queueMode: "interrupt" });
    await expectTurnBornFromRun(h, "ack-1");
  });

  it("CU-22: the bubble Convex shows streaming is resumed when the gateway still runs it", async () => {
    const h = await harness(ACTIVE);
    await performSend(
      h.session,
      body("on", { liveBubble: { messageId: "bubbleA", runId: "runA" } }),
      h.writer,
      null,
      null,
    );
    // Resumed (no new bubble for A), and the send became an input of that run.
    expect(h.started).toEqual([]);
    expect(sends(h.gw)[0]).toMatchObject({ queueMode: "steer" });
    expect(h.session.runManager.outstandingInputs).toHaveLength(1);
  });

  it("CU-22 after a restart: the inputs held while the bubble streamed are known again (codex pass 2)", async () => {
    const h = await harness(ACTIVE);
    await performSend(
      h.session,
      body("on", {
        liveBubble: {
          messageId: "bubbleA",
          runId: "runA",
          heldInputs: [{ sendId: "send-held", messageId: "userHeld" }],
        },
      }),
      h.writer,
      null,
      null,
    );
    expect(h.session.runManager.outstandingInputs).toContain("send-held");
    expect(h.session.runManager.outstandingInputs).toHaveLength(2);
  });

  it("CU-22 after a restart, a LATER segment: the earlier segments' text is restored (codex pass 2)", async () => {
    const h = await harness(ACTIVE);
    await performSend(
      h.session,
      body("on", { liveBubble: { messageId: "seg2", runId: "runA", segmentPrefix: "First." } }),
      h.writer,
      null,
      null,
    );
    const n = (h.session.runManager as unknown as { normalizer: { segmentPrefixText: string | null } })
      .normalizer;
    expect(n.segmentPrefixText).toBe("First.");
  });

  it("CU-22: a bubble whose run the gateway no longer runs is NOT resumed", async () => {
    const h = await harness({
      ...ACTIVE,
      "chat.history": { payload: { sessionInfo: { hasActiveRun: false } } },
    });
    await performSend(
      h.session,
      body("on", { liveBubble: { messageId: "bubbleA", runId: "runA" } }),
      h.writer,
      null,
      null,
    );
    // Not resumed: a fresh turn of the send's own run (its bubble born from the run).
    await expectTurnBornFromRun(h, "ack-1");
  });
});

describe("the projected stop names a run only in the session that owns it (codex pass 1)", () => {
  const PARENT = "agent:alice:atrium:chat:u:c1";
  const CHILD = "agent:files:subagent:abc";

  it("a sub-agent's stop while the parent works: never the parent's run — the child is stopped by key", () => {
    const stop = projectedStopRun({
      targetSessionKey: CHILD,
      live: { sessionKey: PARENT, foregroundRunId: "parent-run" },
      bodyRunId: null,
      discardPendingInput: false,
    });
    expect(stop).toEqual({ ownsLive: false, runId: null });
    expect(projectedAbortTarget({ runId: stop.runId })).toEqual({ kind: "session" });
  });

  it("a sub-agent's stop that names the child's own run keeps it", () => {
    expect(
      projectedStopRun({
        targetSessionKey: CHILD,
        live: { sessionKey: PARENT, foregroundRunId: "parent-run" },
        bodyRunId: "child-run",
        discardPendingInput: false,
      }),
    ).toEqual({ ownsLive: false, runId: "child-run" });
  });

  it("the parent's stop: the run in the foreground here wins over the body's", () => {
    expect(
      projectedStopRun({
        targetSessionKey: PARENT,
        live: { sessionKey: PARENT, foregroundRunId: "adopted-run" },
        bodyRunId: "body-run",
        discardPendingInput: false,
      }),
    ).toEqual({ ownsLive: true, runId: "adopted-run" });
  });

  it("discarding a queued input names that input's run, whatever runs here", () => {
    expect(
      projectedStopRun({
        targetSessionKey: PARENT,
        live: { sessionKey: PARENT, foregroundRunId: "fg" },
        bodyRunId: "send-1",
        discardPendingInput: true,
      }),
    ).toEqual({ ownsLive: true, runId: "send-1" });
  });
});

describe("/abort, projected: the stop of a sub-agent while the parent works (codex pass 1, P1)", () => {
  const PARENT = "agent:alice:atrium:chat:u:c1";
  const CHILD = "agent:files:subagent:abc";
  const parentLive = () => {
    const flags: string[] = [];
    return {
      flags,
      live: {
        sessionKey: PARENT,
        runManager: {
          projectionOn: true,
          foregroundRunId: "parent-run",
          noteUserAbort: () => flags.push("abort"),
        },
      },
    };
  };
  const wire = () => {
    const calls: Array<[string, unknown]> = [];
    return {
      calls,
      conn: {
        gatewayVersion: "2026.9.8",
        request: async (method: string, params: unknown) => {
          calls.push([method, params]);
          return {};
        },
      } as unknown as Parameters<typeof sendProjectedStop>[0],
    };
  };

  it("the child is stopped by key (its queue cleared); the parent's run and flag are untouched", async () => {
    const { flags, live } = parentLive();
    const aim = planProjectedStop(live, CHILD, null, false);
    const w = wire();
    await sendProjectedStop(w.conn, CHILD, aim!);
    expect(w.calls).toEqual([["sessions.abort", { key: CHILD, clearQueued: true }]]);
    expect(flags).toEqual([]);
  });

  it("the parent's own stop: chat.abort of the run in the foreground, flag set", async () => {
    const { flags, live } = parentLive();
    const aim = planProjectedStop(live, PARENT, null, false);
    const w = wire();
    await sendProjectedStop(w.conn, PARENT, aim!);
    expect(w.calls).toEqual([["chat.abort", { sessionKey: PARENT, runId: "parent-run" }]]);
    expect(flags).toEqual(["abort"]);
  });
});

describe("codex pass 2 — the steered row can beat the ACK (P1)", () => {
  it("a steer row read while chat.send is still in flight cuts the bubble", async () => {
    const h = await harness({ ...ACTIVE, "chat.send": { payload: { status: "started", runId: "ack-1" }, delayMs: 40 } });
    const splits: Array<[string, string | null]> = [];
    (h.writer as unknown as { splitSegment: unknown }).splitSegment = async (m: string, after: string | null) => {
      splits.push([m, after]);
      return "seg-2";
    };
    await h.session.runManager.beginTurn(1000, "runA", { expectedSessionId: null });
    h.session.runManager.setProjection(true);
    const sending = performSend(h.session, body("on"), h.writer, null, null);
    await sleep(15);
    // The input is already known while its send is in flight…
    const [sendId] = h.session.runManager.outstandingInputs;
    expect(sendId).toBeDefined();
    // …so the transcript's steer row, arriving before the ACK, cuts the bubble.
    await h.session.runManager.onUserRow({ sendId, steerTargetRunId: "runA" });
    await sending;
    expect(splits).toEqual([["msg-1", "um-1"]]);
  });

  it("a send the gateway REFUSED forgets the input registered before it", async () => {
    const h = await harness({
      ...ACTIVE,
      "chat.send": { throws: new GatewayAnsweredError("INVALID_REQUEST: refused") },
    });
    await h.session.runManager.beginTurn(1000, "runA", { expectedSessionId: null });
    h.session.runManager.setProjection(true);
    await expect(performSend(h.session, body("on"), h.writer, null, null)).rejects.toThrow();
    expect(h.session.runManager.outstandingInputs).toEqual([]);
  });

  it("a send that got NO answer keeps the input — the gateway may hold it (codex pass 6)", async () => {
    const h = await harness({
      ...ACTIVE,
      "chat.send": { throws: new Error("request chat.send timed out after 30000ms") },
    });
    await h.session.runManager.beginTurn(1000, "runA", { expectedSessionId: null });
    h.session.runManager.setProjection(true);
    await expect(performSend(h.session, body("on"), h.writer, null, null)).rejects.toThrow();
    expect(h.session.runManager.outstandingInputs).toHaveLength(1);
  });
});

describe("codex pass 2 — never compact under a run the gateway still runs (P1)", () => {
  const full = {
    sessionId: "s-1",
    systemSent: true,
    contextTokens: 200_000,
    promptBudgetBeforeReserve: 100_000,
    estimatedPromptTokens: 97_000,
    totalTokensFresh: true,
  };
  it("on: a run active at the gateway (none here, e.g. after a restart) — no sessions.compact", async () => {
    const h = await harness(ACTIVE, { describe: [full], compact: { payload: { ok: true, compacted: true } } });
    await performSend(h.session, body("on"), h.writer, null, null);
    expect(h.gw.countOf("sessions.compact")).toBe(0);
    expect(h.gw.countOf("chat.send")).toBe(1);
  });
  it("on, idle gateway: the guard compacts as before", async () => {
    const h = await harness(
      {
        "chat.history": { payload: { sessionInfo: { hasActiveRun: false } } },
        "chat.send": { payload: { status: "started", runId: "ack-1" } },
      },
      { describe: [full, { ...full, estimatedPromptTokens: 30_000 }], compact: { payload: { ok: true, compacted: true } } },
    );
    await performSend(h.session, body("on"), h.writer, null, null);
    expect(h.gw.countOf("sessions.compact")).toBe(1);
  });
});
