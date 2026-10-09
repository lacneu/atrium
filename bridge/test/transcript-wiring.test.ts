// The transcript projection on the REAL send path (redesign phase 1): the instance
// switch reaches the session's reconciler only on a gateway carrying the transcript
// identities; reads go out through the version-gated builder; what is read is posted to
// Convex and NOTHING else is written for it; and the send identity Convex computed is
// the gateway key exactly when the bridge's own derivation agrees.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { sleep } from "./helpers/sleep.js";
import { performSend, resolveSendIdentity, type SendReport } from "../src/server.js";
import { SessionRegistry } from "../src/session.js";
import type { BridgeConfig } from "../src/config.js";
import type { ConvexWriter, TranscriptApplyReport } from "../src/convex-writer.js";
import { OpenClawConnection } from "../src/providers/openclaw/openclaw-client.js";
import { fakeGateway, type FakeGateway } from "./helpers/fake-gateway.js";
import { servedMap } from "./helpers/served.js";

const config = {
  openclawGatewayUrl: "ws://127.0.0.1:1",
  openclawToken: "t",
  deviceIdentity: { id: "i", publicKey: "p", privateKey: "k" },
  instanceName: "primary",
} as unknown as BridgeConfig;

const ROUTING = {
  chatId: "c1",
  openclawChatId: "oc1",
  agentId: "alice",
  canonical: "olivier",
  instanceName: "primary",
};
const SESSION_KEY = "agent:alice:atrium:chat:olivier:oc1";

const body = (extra: Record<string, unknown> = {}) =>
  ({
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
    ...extra,
  }) as unknown as Parameters<typeof performSend>[1];

const PAGE = {
  sessionKey: SESSION_KEY,
  sessionId: "s-1",
  deltaCursor: "c:3",
  sessionInfo: { sessionId: "s-1", hasActiveRun: false },
  messages: [
    {
      role: "user",
      content: "bonjour",
      __openclaw: { id: "u1", seq: 1, idempotencyKey: "webchat-x:user" },
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "salut" }],
      __openclaw: { id: "a1", seq: 2, runId: "webchat-x" },
    },
  ],
};

async function harness(version: string | null, tweak?: (gw: FakeGateway) => void) {
  const script = () => ({
    describe: [{ sessionId: "s-1", systemSent: true }],
    answers: {
      "chat.send": { payload: { runId: "webchat-x", status: "started" } },
      "chat.history": { payload: PAGE },
    },
  });
  const gw = fakeGateway(script());
  (gw as unknown as { gatewayVersion: string | null }).gatewayVersion = version;
  tweak?.(gw);
  // The FIRST connection is the conversation's socket (the one whose frames the
  // reconciler watches); any later one (the system socket a send may open and close,
  // the instance's session-events connection) gets its own fake, so closing it does not
  // end the conversation's frame stream. Each is kept with the capabilities it declared.
  const others: Array<{ gw: FakeGateway; caps: readonly string[] }> = [];
  vi.spyOn(OpenClawConnection, "connect")
    .mockImplementationOnce(async () => gw as never)
    .mockImplementation(async (...args: unknown[]) => {
      const other = fakeGateway(script());
      (other as unknown as { gatewayVersion: string | null }).gatewayVersion = version;
      others.push({ gw: other, caps: (args[7] as readonly string[] | undefined) ?? [] });
      return other as never;
    });
  const applies: TranscriptApplyReport[] = [];
  const written: string[] = [];
  // Every writer method the send path may call, each RECORDED: what the turn writes
  // is the assertion surface of the "shadow writes nothing else" test.
  const rec =
    <T,>(name: string, answer: T) =>
    async (..._args: unknown[]): Promise<T> => {
      written.push(name);
      return answer;
    };
  const writer = {
    startAssistant: rec("startAssistant", "msg-1"),
    appendDelta: rec("appendDelta", undefined),
    setSnapshot: rec("setSnapshot", true),
    addToolPart: rec("addToolPart", undefined),
    addMedia: rec("addMedia", undefined),
    finalize: rec("finalize", undefined),
    reportSessionMeta: rec("reportSessionMeta", undefined),
    reportSessionRoster: rec("reportSessionRoster", undefined),
    recordGatewayPressure: rec("recordGatewayPressure", undefined),
    clearSessionState: rec("clearSessionState", undefined),
    getRehydrationContext: rec("getRehydrationContext", { history: null, turnCount: 0 }),
    emitRehydrateTrace: () => {
      written.push("emitRehydrateTrace");
    },
    applyTranscript: async (r: TranscriptApplyReport) => {
      written.push("applyTranscript");
      applies.push(r);
    },
  } as unknown as ConvexWriter;
  const reg = new SessionRegistry(servedMap(config, writer), () => 1000);
  const session = await reg.acquire(ROUTING);
  await sleep(5);
  /** The session-events connection(s): the ones that declared the scoped capability. */
  const eventSockets = () => others.filter((o) => o.caps.includes("session-scoped-events"));
  return {
    gw: session.connection as unknown as FakeGateway,
    session,
    writer,
    applies,
    written,
    reg,
    eventSockets,
  };
}

const settle = async (s: { transcriptShadow?: { idle(): Promise<void> } }) => {
  for (let i = 0; i < 10; i++) {
    await s.transcriptShadow?.idle();
    await sleep(1);
  }
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Convex's answer reaches the turn (codex phase 4 pass 6 review)", () => {
  it("on: a run Convex reports over is handed to the run manager — the answer is not dropped", async () => {
    const h = await harness("2026.9.6");
    (h.writer as unknown as { applyTranscript: (r: TranscriptApplyReport) => Promise<unknown> }).applyTranscript =
      async (r) => {
        h.applies.push(r);
        return { ok: true, settledRuns: ["webchat-x"] };
      };
    const spy = vi.spyOn(h.session.runManager, "settleFromTranscript");
    await performSend(h.session, body({ config: { transcriptProjection: "on" } }), h.writer, null, null);
    await settle(h.session);
    expect(h.applies.length).toBeGreaterThan(0);
    expect(spy.mock.calls.some(([ids]) => (ids as readonly string[]).includes("webchat-x"))).toBe(true);
  });
});

describe("the instance switch reaches the reconciler — and only where the facts exist", () => {
  it("shadow on 2026.9.6: one tail page read with the page budget, posted as identities", async () => {
    const h = await harness("2026.9.6");
    await performSend(h.session, body({ config: { transcriptProjection: "shadow" } }), h.writer, null, null);
    await settle(h.session);
    const reads = h.gw.calls.filter(([m]) => m === "chat.history");
    // The switch-on read (a tail page), then the one the session-events subscription
    // asks for once it is established (phase 2) — a delta from the page's cursor.
    expect(reads).toHaveLength(2);
    expect(reads[0]![1]).toEqual({ sessionKey: SESSION_KEY, limit: 80, maxBytes: 262144 });
    expect(reads[1]![1]).toMatchObject({ cursor: "c:3" });
    expect(h.applies).toHaveLength(2);
    expect(h.applies[0]).toMatchObject({
      chatId: "c1",
      sessionKey: SESSION_KEY,
      sessionId: "s-1",
      kind: "page",
      deltaCursor: "c:3",
    });
    expect(h.applies[0]!.rows.map((r) => [r.entryId, r.seq, r.role, r.runId ?? null, r.sendId ?? null])).toEqual([
      ["u1", 1, "user", "webchat-x", "webchat-x"],
      ["a1", 2, "assistant", "webchat-x", null],
    ]);
  });

  it("2026.9.1 reads WITHOUT `maxBytes` (its closed params schema predates it)", async () => {
    const h = await harness("2026.9.1");
    await performSend(h.session, body({ config: { transcriptProjection: "shadow" } }), h.writer, null, null);
    await settle(h.session);
    const read = h.gw.calls.find(([m]) => m === "chat.history");
    expect(read?.[1]).toEqual({ sessionKey: SESSION_KEY, limit: 80 });
  });

  it("a Convex cursor makes the first read a DELTA", async () => {
    const h = await harness("2026.9.6");
    await performSend(
      h.session,
      body({
        config: { transcriptProjection: "shadow" },
        transcriptCursor: { sessionId: "s-1", deltaCursor: "c:41" },
      }),
      h.writer,
      null,
      null,
    );
    await settle(h.session);
    expect(h.gw.calls.find(([m]) => m === "chat.history")?.[1]).toMatchObject({ cursor: "c:41" });
  });

  it.each([
    ["switch off", "2026.9.6", { transcriptProjection: "off" }],
    ["no switch at all", "2026.9.6", null],
    ["an UNKNOWN gateway version", null, { transcriptProjection: "shadow" }],
  ] as const)("%s: no transcript read, nothing posted", async (_label, version, cfg) => {
    const h = await harness(version);
    await performSend(h.session, body({ config: cfg }), h.writer, null, null);
    await settle(h.session);
    expect(h.gw.countOf("chat.history")).toBe(0);
    expect(h.applies).toEqual([]);
  });

  it("SHADOW: the projection writes nothing but `applyTranscript` — the turn writes exactly what it wrote before", async () => {
    const off = await harness("2026.9.6");
    await performSend(off.session, body({ config: { transcriptProjection: "off" } }), off.writer, null, null);
    await settle(off.session);
    vi.restoreAllMocks();
    const on = await harness("2026.9.6");
    await performSend(on.session, body({ config: { transcriptProjection: "shadow" } }), on.writer, null, null);
    await settle(on.session);
    expect(on.written.filter((w) => w !== "applyTranscript")).toEqual(off.written);
    expect(on.written).toContain("applyTranscript");
  });

  it("a terminal chat frame of the session reads again with the cursor it was given", async () => {
    const h = await harness("2026.9.6");
    await performSend(h.session, body({ config: { transcriptProjection: "shadow" } }), h.writer, null, null);
    await settle(h.session);
    h.gw.emit({
      type: "event",
      event: "chat",
      payload: { sessionKey: SESSION_KEY, runId: "announce:v1:x:y", state: "final", message: { role: "assistant" } },
    });
    await sleep(20);
    await settle(h.session);
    const reads = h.gw.calls.filter(([m]) => m === "chat.history");
    expect(reads).toHaveLength(3); // switch-on page, subscription delta, terminal delta
    expect(reads[2]![1]).toMatchObject({ cursor: "c:3" });
    expect(h.applies.at(-1)!.terminals).toEqual([
      expect.objectContaining({ runId: "announce:v1:x:y", status: "completed" }),
    ]);
  });
});

describe("phase 2: the session-events connection (design §6.2)", () => {
  const sessionMessage = (row: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    type: "event",
    event: "session.message",
    payload: { sessionKey: SESSION_KEY, sessionId: "s-1", message: row, ...extra },
  });

  it("subscribes on its OWN socket — scoped, never the conversation's — and only while a session is projected", async () => {
    const off = await harness("2026.9.6");
    await performSend(off.session, body({ config: { transcriptProjection: "off" } }), off.writer, null, null);
    await settle(off.session);
    expect(off.eventSockets()).toHaveLength(0);
    vi.restoreAllMocks();
    const h = await harness("2026.9.6");
    await performSend(h.session, body({ config: { transcriptProjection: "shadow" } }), h.writer, null, null);
    await settle(h.session);
    const events = h.eventSockets();
    expect(events).toHaveLength(1);
    // The lesson of 2026-07-26: the CONVERSATION socket never subscribes.
    expect(h.gw.countOf("sessions.subscribe")).toBe(0);
    expect(h.gw.countOf("sessions.messages.subscribe")).toBe(0);
    expect(events[0]!.gw.calls.map(([m]) => m)).toEqual(["sessions.subscribe"]);
    expect(events[0]!.gw.calls[0]![1]).toEqual({});
  });

  it("a `session.message` on the events socket reads the transcript back — on the CONVERSATION socket", async () => {
    const h = await harness("2026.9.6");
    await performSend(h.session, body({ config: { transcriptProjection: "shadow" } }), h.writer, null, null);
    await settle(h.session);
    const before = h.gw.countOf("chat.history");
    const ev = h.eventSockets()[0]!.gw;
    ev.emit(
      sessionMessage({
        role: "user",
        content: "suite",
        __openclaw: { id: "u9", seq: 9, idempotencyKey: "webchat-y:user" },
      }),
    );
    await sleep(20);
    await settle(h.session);
    expect(h.gw.countOf("chat.history")).toBe(before + 1);
    // Never a read on the events socket: it carries events, the conversation reads.
    expect(ev.countOf("chat.history")).toBe(0);
    // The admitted user row was posted directly (kind `live`) besides the read.
    expect(h.applies.some((a) => a.kind === "live" && a.rows.some((r) => r.entryId === "u9"))).toBe(true);
  });

  it("NO duplicate delivery: a turn frame arriving on the events socket reaches no RunManager and writes nothing", async () => {
    const h = await harness("2026.9.6");
    await performSend(h.session, body({ config: { transcriptProjection: "shadow" } }), h.writer, null, null);
    await settle(h.session);
    const feed = vi.spyOn(h.session.runManager, "feed");
    const writtenBefore = [...h.written];
    const readsBefore = h.gw.countOf("chat.history");
    const ev = h.eventSockets()[0]!.gw;
    // What the gateway would fan out to an UNSCOPED operator socket — the shape that
    // broke spawn-parallel-merge when it shared the turn's consumer.
    for (const state of ["delta", "final"]) {
      ev.emit({
        type: "event",
        event: "chat",
        payload: { sessionKey: SESSION_KEY, runId: "webchat-x", state, message: { role: "assistant", content: "x" } },
      });
    }
    ev.emit({ type: "event", event: "agent", payload: { sessionKey: SESSION_KEY, runId: "webchat-x", stream: "assistant" } });
    await sleep(20);
    await settle(h.session);
    expect(feed).not.toHaveBeenCalled();
    expect(h.written).toEqual(writtenBefore);
    expect(h.gw.countOf("chat.history")).toBe(readsBefore);
    const hub = h.reg.sessionEventsFor("primary", config);
    expect(hub.stats.strayTurnFrames).toBe(3);
    expect(hub.stats.routed).toBe(0);
  });

  it("the send's identity rides the next read as `inputRunIds` (the input guard)", async () => {
    const h = await harness("2026.9.6");
    const report: SendReport = {};
    await performSend(
      h.session,
      body({ config: { transcriptProjection: "shadow" } }),
      h.writer,
      null,
      null,
      null,
      Date.now(),
      undefined,
      undefined,
      report,
    );
    await settle(h.session);
    // A later trigger (a terminal of the session) reads again.
    h.gw.emit({
      type: "event",
      event: "chat",
      payload: { sessionKey: SESSION_KEY, runId: "other-run", state: "final", message: { role: "assistant" } },
    });
    await sleep(20);
    await settle(h.session);
    const reads = h.gw.calls.filter(([m]) => m === "chat.history");
    // The switch-on read happened BEFORE the send: it asked nothing.
    expect(reads[0]![1].inputRunIds).toBeUndefined();
    expect(reads.at(-1)![1].inputRunIds).toEqual([report.sendId]);
    expect(h.applies.at(-1)!.inputRunIds).toEqual([report.sendId]);
  });

  it("closing the conversation detaches it; the events socket closes once no session is attached", async () => {
    const h = await harness("2026.9.6");
    await performSend(h.session, body({ config: { transcriptProjection: "shadow" } }), h.writer, null, null);
    await settle(h.session);
    const hub = h.reg.sessionEventsFor("primary", config);
    expect(hub.attachedKeys).toEqual([SESSION_KEY]);
    (h.session as unknown as { close(): void }).close();
    await sleep(20);
    expect(hub.attachedKeys).toEqual([]);
    h.reg.closeAll();
    expect(hub.ready).toBe(false);
  });
});

describe("phase 2 — the reconciler dies with its socket, whichever path closes it (review pass 2)", () => {
  it("after a consume-loop CRASH: no subscription remains and no read is attempted", async () => {
    // The conversation socket's frame reader THROWS on demand — the loop-machinery
    // failure recoverFromConsumeCrash exists for (not an orderly end of frames).
    let crash: (err: Error) => void = () => {};
    const crashed = new Promise<never>((_, reject) => {
      crash = reject;
    });
    crashed.catch(() => {});
    const h = await harness("2026.9.6", (gw) => {
      (gw as unknown as { frames: () => AsyncGenerator<unknown> }).frames = async function* () {
        await crashed;
      };
    });
    await performSend(h.session, body({ config: { transcriptProjection: "shadow" } }), h.writer, null, null);
    await settle(h.session);
    const hub = h.reg.sessionEventsFor("primary", config);
    expect(hub.attachedKeys).toEqual([SESSION_KEY]);
    crash(new Error("iterator exploded"));
    await sleep(30);
    expect(h.session.connection.isClosed).toBe(true);
    expect(hub.attachedKeys).toEqual([]);
    const reads = h.gw.countOf("chat.history");
    h.eventSockets()[0]!.gw.emit({
      type: "event",
      event: "session.message",
      payload: { sessionKey: SESSION_KEY, message: { role: "user", content: "x", __openclaw: { id: "u9", seq: 9, idempotencyKey: "webchat-z:user" } } },
    });
    await sleep(20);
    expect(h.gw.countOf("chat.history")).toBe(reads);
  });
});

describe("the send identity", () => {
  const derived = (sessionKey: string, cmid: string) =>
    `webchat-${createHash("sha256").update(`${sessionKey}|${cmid}`).digest("hex")}`;

  it("Convex's key IS the gateway key when the two derivations agree", async () => {
    const h = await harness("2026.9.6");
    const sendId = derived(SESSION_KEY, "cm-1");
    const report: SendReport = {};
    await performSend(h.session, body({ sendId }), h.writer, null, null, null, Date.now(), undefined, undefined, report);
    const sent = h.gw.calls.find(([m]) => m === "chat.send")?.[1];
    expect(sent?.idempotencyKey).toBe(sendId);
    expect(report.sendId).toBe(sendId);
  });

  it("a DISAGREEING Convex key is not sent: the session's own derivation is, and reported", async () => {
    const h = await harness("2026.9.6");
    const report: SendReport = {};
    await performSend(
      h.session,
      body({ sendId: derived("agent:alice:atrium:chat:olivier:ANOTHER", "cm-1") }),
      h.writer,
      null,
      null,
      null,
      Date.now(),
      undefined,
      undefined,
      report,
    );
    const sent = h.gw.calls.find(([m]) => m === "chat.send")?.[1];
    expect(sent?.idempotencyKey).toBe(derived(SESSION_KEY, "cm-1"));
    expect(report.sendId).toBe(derived(SESSION_KEY, "cm-1"));
  });

  it("an older Convex (no key) gets the very same derivation as always", async () => {
    expect(await resolveSendIdentity(SESSION_KEY, "cm-1", undefined, "c1")).toBe(
      derived(SESSION_KEY, "cm-1"),
    );
  });
});
