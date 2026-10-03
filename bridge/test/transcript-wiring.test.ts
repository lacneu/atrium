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

async function harness(version: string | null) {
  const script = () => ({
    describe: [{ sessionId: "s-1", systemSent: true }],
    answers: {
      "chat.send": { payload: { runId: "webchat-x", status: "started" } },
      "chat.history": { payload: PAGE },
    },
  });
  const gw = fakeGateway(script());
  (gw as unknown as { gatewayVersion: string | null }).gatewayVersion = version;
  // The FIRST connection is the conversation's socket (the one whose frames the
  // reconciler watches); any later one (the system socket a send may open and close)
  // gets its own fake, so closing it does not end the conversation's frame stream.
  vi.spyOn(OpenClawConnection, "connect")
    .mockImplementationOnce(async () => gw as never)
    .mockImplementation(async () => {
      const other = fakeGateway(script());
      (other as unknown as { gatewayVersion: string | null }).gatewayVersion = version;
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
  return { gw: session.connection as unknown as FakeGateway, session, writer, applies, written };
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

describe("the instance switch reaches the reconciler — and only where the facts exist", () => {
  it("shadow on 2026.9.6: one tail page read with the page budget, posted as identities", async () => {
    const h = await harness("2026.9.6");
    await performSend(h.session, body({ config: { transcriptProjection: "shadow" } }), h.writer, null, null);
    await settle(h.session);
    const reads = h.gw.calls.filter(([m]) => m === "chat.history");
    expect(reads).toHaveLength(1);
    expect(reads[0]![1]).toEqual({ sessionKey: SESSION_KEY, limit: 80, maxBytes: 262144 });
    expect(h.applies).toHaveLength(1);
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
    expect(reads).toHaveLength(2);
    expect(reads[1]![1]).toMatchObject({ cursor: "c:3" });
    expect(h.applies.at(-1)!.terminals).toEqual([
      expect.objectContaining({ runId: "announce:v1:x:y", status: "completed" }),
    ]);
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
