/**
 * CONFINEMENT tests for the pre-send guard (W2 / G-04, G-06) — driven through the
 * REAL send path, not the pure decision function.
 *
 * The pure ladder is proven in presend-guard.test.ts. What THAT cannot prove is the
 * only thing that can hurt a user here: a guard meant to save a wasted turn ending
 * up costing a good one. Those three facts all live in the wiring —
 *
 *   1. a session at 97 % is compacted and the send GOES OUT;
 *   2. a compaction that refuses withholds the send, ONCE, with a named cause;
 *   3. a compaction RPC that throws lets the send through (P6).
 *
 * They are expressible for the first time because `fake-gateway.ts` can answer
 * `sessions.describe` / `sessions.compact` with a script.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { sleep } from "./helpers/sleep.js";

import { performSend, setGatewayReleaseBudgetForTests } from "../src/server.js";
import { PRE_SEND_DEADLINE_MS } from "../src/core/dispatch-deadline.js";
import { SessionRegistry } from "../src/session.js";
import type { BridgeConfig } from "../src/config.js";
import type { ConvexWriter } from "../src/convex-writer.js";
import { OpenClawConnection } from "../src/providers/openclaw/openclaw-client.js";
import {
  fakeGateway,
  type FakeGateway,
  type FakeSessionDescribe,
} from "./helpers/fake-gateway.js";
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

function recordingWriter() {
  const traces: Record<string, unknown>[] = [];
  const writer = {
    startAssistant: async () => "msg-1",
    appendDelta: async () => {},
    setSnapshot: async () => true,
    addToolPart: async () => {},
    addMedia: async () => {},
    finalize: async () => {},
    reportSessionMeta: async () => {},
    recordGatewayPressure: async () => {},
    clearSessionState: async () => {},
    getRehydrationContext: async () => ({ history: null, turnCount: 0 }),
    emitRehydrateTrace: (t: Record<string, unknown>) => {
      traces.push(t);
    },
  } as unknown as ConvexWriter;
  return { writer, traces };
}

/** A session whose gateway answers from `script`. Returns the live pieces a test
 *  asserts on: the fake (its `calls`), the session, and the recorded traces. */
async function harness(
  script: Parameters<typeof fakeGateway>[0],
  clock: () => number = () => 1000,
) {
  const gw = fakeGateway(script);
  vi.spyOn(OpenClawConnection, "connect").mockImplementation(
    async () => gw as never,
  );
  const { writer, traces } = recordingWriter();
  const reg = new SessionRegistry(servedMap(config, writer), clock);
  const session = await reg.acquire(ROUTING);
  await sleep(5);
  return {
    gw: session.connection as unknown as FakeGateway,
    session,
    traces,
    writer,
  };
}

const body = {
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
} as unknown as Parameters<typeof performSend>[1];

/** A session at `pct`% of its usable budget, as the gateway itself reports it. */
const at = (pct: number) => ({
  sessionId: "s-1",
  systemSent: true,
  contextTokens: 200_000,
  promptBudgetBeforeReserve: 100_000,
  estimatedPromptTokens: Math.round(1_000 * pct),
  totalTokensFresh: true,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pre-send guard on the real send path", () => {
  it("at 97%: compacts, then the send GOES OUT", async () => {
    const { gw, session, writer } = await harness({
      // The compaction shrinks it; the re-describe must be what everything
      // downstream reads.
      describe: [at(97), at(30)],
      compact: { payload: { ok: true, compacted: true } },
    });
    await performSend(session, body, writer, null, null);

    expect(gw.countOf("sessions.compact")).toBe(1);
    // The point of the whole lot: the turn still happens.
    expect(gw.countOf("chat.send")).toBe(1);
    // And it re-read the session after shrinking it.
    expect(gw.countOf("sessions.describe")).toBe(2);
  });

  it("at 97% with a REFUSED compaction: the send is WITHHELD and named", async () => {
    const { gw, session, writer } = await harness({
      describe: [at(97)],
      compact: {
        payload: { ok: true, compacted: false, reason: "no transcript" },
      },
    });
    await expect(
      performSend(session, body, writer, null, null),
    ).rejects.toThrow(/send withheld/);

    expect(gw.countOf("sessions.compact")).toBe(1);
    // Nothing was spent: the gateway never saw the message.
    expect(gw.countOf("chat.send")).toBe(0);
  });

  it("a compaction RPC that THROWS lets the send through (P6)", async () => {
    const { gw, session, writer } = await harness({
      describe: [at(97)],
      compact: { throws: new Error("UNAVAILABLE: session is still active") },
    });
    await performSend(session, body, writer, null, null);

    expect(gw.countOf("sessions.compact")).toBe(1);
    expect(gw.countOf("chat.send")).toBe(1);
  });

  it("a STRUCTURAL refusal is remembered: the next turn does not wait on it again", async () => {
    // The program's requirement: two turns at 97% must not cost two 60-second
    // compactions. `no transcript` will still be true next turn, so the second send
    // goes straight to the verdict — blocked, named, immediate.
    const { gw, session, writer } = await harness({
      describe: [at(97)],
      compact: {
        payload: {
          ok: true,
          compacted: false,
          reason: "unsupported_harness_compaction",
        },
      },
    });
    await expect(
      performSend(session, body, writer, null, null),
    ).rejects.toThrow(/send withheld/);
    await expect(
      performSend(session, body, writer, null, null),
    ).rejects.toThrow(/send withheld/);

    expect(gw.countOf("sessions.compact")).toBe(1); // ONE attempt, two turns
    expect(gw.countOf("chat.send")).toBe(0);
  });

  it("an ABSENT `compacted` field is UNKNOWN, never a refusal", async () => {
    // A truncated answer, or an older gateway that does not report the field. It
    // does NOT say the session failed to shrink — and a guard that reads silence
    // as a refusal blocks turns that would have worked.
    const { gw, session, writer } = await harness({
      describe: [at(97)],
      compact: { payload: { ok: true } },
    });
    await performSend(session, body, writer, null, null);

    expect(gw.countOf("sessions.compact")).toBe(1);
    expect(gw.countOf("chat.send")).toBe(1);
  });

  it("only `compacted:false` withholds — the observed refusal", async () => {
    const { gw, session, writer } = await harness({
      describe: [at(97)],
      compact: { payload: { ok: true, compacted: false } },
    });
    await expect(
      performSend(session, body, writer, null, null),
    ).rejects.toThrow(/send withheld/);
    expect(gw.countOf("chat.send")).toBe(0);
  });

  it("`no transcript` is NOT remembered: an ordinary send creates one", async () => {
    // The dead end this avoids: a session with no transcript yet is refused once,
    // and a memory would then block every later turn on evidence that had expired
    // the moment any send wrote a transcript.
    const { gw, session, writer } = await harness({
      describe: [at(97)],
      compact: {
        payload: { ok: true, compacted: false, reason: "no transcript" },
      },
    });
    await expect(
      performSend(session, body, writer, null, null),
    ).rejects.toThrow(/send withheld/);
    await expect(
      performSend(session, body, writer, null, null),
    ).rejects.toThrow(/send withheld/);
    expect(gw.countOf("sessions.compact")).toBe(2);
  });

  it("a TRANSIENT refusal SENDS, and is retried on the next turn", async () => {
    // "already active" says something was RUNNING on this session — possibly a
    // compaction about to shrink it, possibly a delivery run the busy-check missed
    // by a microsecond (it is a snapshot taken before an await). Withholding on
    // evidence about to expire is the failure this guard must not commit. And it is
    // not remembered: one unlucky moment must not leave a conversation permanently
    // unable to compact.
    const { gw, session, writer } = await harness({
      describe: [at(97)],
      compact: {
        payload: { ok: true, compacted: false, reason: "already_active" },
      },
    });
    await performSend(session, body, writer, null, null);

    expect(gw.countOf("sessions.compact")).toBe(1);
    expect(gw.countOf("chat.send")).toBe(1);
    // Not remembered: the next turn asks again.
    expect(session.presendCompactRefusedFor).toBeNull();
  });

  it("a remembered refusal is forgotten when the session is a NEW one", async () => {
    // A reset/rollover mints a fresh sessionId — it deserves its own attempt, or a
    // single bad session would poison every later one on the same key.
    const { gw, session, writer } = await harness({
      describe: [
        { ...at(97), sessionId: "s-old" },
        { ...at(97), sessionId: "s-new" },
      ],
      compact: {
        payload: { ok: true, compacted: false, reason: "no transcript" },
      },
    });
    await expect(
      performSend(session, body, writer, null, null),
    ).rejects.toThrow(/send withheld/);
    await expect(
      performSend(session, body, writer, null, null),
    ).rejects.toThrow(/send withheld/);

    expect(gw.countOf("sessions.compact")).toBe(2);
  });

  it("between 85% and 95%: compacts pre-emptively, and a refusal does NOT block", async () => {
    const { gw, session, writer } = await harness({
      describe: [at(90)],
      compact: {
        payload: { ok: true, compacted: false, reason: "no transcript" },
      },
    });
    await performSend(session, body, writer, null, null);

    expect(gw.countOf("sessions.compact")).toBe(1);
    expect(gw.countOf("chat.send")).toBe(1);
  });

  it("a comfortable session is left completely alone", async () => {
    const { gw, session, writer } = await harness({ describe: [at(40)] });
    await performSend(session, body, writer, null, null);

    expect(gw.countOf("sessions.compact")).toBe(0);
    expect(gw.countOf("sessions.describe")).toBe(1);
    expect(gw.countOf("chat.send")).toBe(1);
  });

  it("an UNKNOWN fill never compacts and never blocks", async () => {
    // No budget, no counter: the gateway's pre-prompt check did not run (a context
    // engine owns compaction). Arming a guard on a measure we do not have is the
    // failure mode P6 exists to forbid.
    const { gw, session, writer } = await harness({
      describe: [{ sessionId: "s-1", systemSent: true }],
    });
    await performSend(session, body, writer, null, null);

    expect(gw.countOf("sessions.compact")).toBe(0);
    expect(gw.countOf("chat.send")).toBe(1);
  });

  it("a run ACTIVE on the session is never compacted under", async () => {
    // The gateway's own compact handler interrupts an active run. A delivery or
    // announce run can be live while Convex considers the chat idle — compacting
    // there would destroy a reply the user is owed.
    const { gw, session, writer } = await harness({
      describe: [at(97)],
      compact: { payload: { ok: true, compacted: true } },
    });
    await session.runManager.beginTurn(1000, "run-live");
    await performSend(session, body, writer, null, null);

    expect(gw.countOf("sessions.compact")).toBe(0);
    expect(gw.countOf("chat.send")).toBe(1);
  });

  it("the decision rides the content-free trace", async () => {
    const { session, traces, writer } = await harness({
      describe: [at(97)],
      compact: {
        payload: { ok: true, compacted: false, reason: "no transcript" },
      },
    });
    await expect(
      performSend(session, body, writer, null, null),
    ).rejects.toThrow(/send withheld/);

    const t = traces.at(-1)!;
    expect(t.presendAction).toBe("compact_or_block");
    expect(t.presendBlocked).toBe(true);
    expect(t.presendCompaction).toBe("refused");
    expect(t.presendCompactReasonClass).toBe("no transcript");
    expect(t.presendFillSource).toBe("gateway_estimate");
    expect(t.presendFillPct).toBe(97);
    // Content-free: no field carries a gateway string beyond the bucketed class.
    expect(JSON.stringify(t)).not.toContain("bonjour");
  });
});

// ── The overflow class a compacted turn deserves (W2 point 3) ───────────────
//
// A `context_length` that lands AFTER a successful pre-send compaction is not the
// same failure as one that lands on an untouched session: the prompt was assembled
// around a shrink, so composing the same send again is genuinely a different
// attempt. Convex retries that class exactly once; the plain class it must not.

class SinkWriter {
  readonly finals: (string | null)[] = [];
  async startAssistant(): Promise<string> {
    return "msg-x";
  }
  async appendDelta(): Promise<void> {}
  async setSnapshot(): Promise<boolean> {
    return true;
  }
  async addToolPart(): Promise<void> {}
  async addMedia(): Promise<boolean> {
    return true;
  }
  async noteMediaUndelivered(): Promise<void> {}
  async addProvenancePart(): Promise<void> {}
  async recordGatewayPressure(): Promise<void> {}
  async finalize(
    _messageId: string,
    _status: string,
    _text?: string,
    _error?: string | null,
    errorKind?: string | null,
  ): Promise<void> {
    this.finals.push(errorKind ?? null);
  }
  async getRehydrationContext() {
    return { history: null, turnCount: 0 };
  }
  async reportSessionMeta(): Promise<void> {}
}

async function overflowTurn(compactedBeforeSend: boolean) {
  const { TurnSink } = await import("../src/core/turn-sink.js");
  const w = new SinkWriter();
  const sink = new TurnSink("chat_ov", w as unknown as ConvexWriter);
  await sink.beginTurn("run-ov", undefined, false, false, null, {
    compactedBeforeSend,
  });
  await sink.apply([
    { type: "message.final", text: "", error: "context overflow", errorKind: "context_length" },
    { type: "run.status", status: "final" },
  ] as never);
  await new Promise((r) => setTimeout(r, 0));
  return w.finals;
}

describe("a context overflow right after a compaction is a DISTINCT class", () => {
  it("compacted before the send ⇒ context_length_compacted (retryable once)", async () => {
    expect(await overflowTurn(true)).toContain("context_length_compacted");
  });

  it("NOT compacted ⇒ plain context_length (a retry would fail identically)", async () => {
    const finals = await overflowTurn(false);
    expect(finals).toContain("context_length");
    expect(finals).not.toContain("context_length_compacted");
  });
});

// ── The guard must not cost the turn it protects (the dispatch deadline) ────
//
// `assertBeforeSendDeadline` refuses to submit a prompt Convex has already
// reconciled. The guard sits UPSTREAM of it and can spend a minute summarizing —
// so on a dispatch that arrived old, the guard could consume the last of the
// budget and have the send it was protecting refused. That is a turn lost to the
// guard, on the tier (85–95 %) that by design never withholds anything.

const oldBody = (ageMs: number) =>
  ({ ...(body as object), dispatchAgeMs: ageMs }) as typeof body;

describe("the dispatch deadline bounds the guard, not the other way round", () => {
  it("a dispatch with almost no budget left is SENT, uncompacted", async () => {
    const { gw, session, writer } = await harness({
      describe: [at(97)],
      compact: { payload: { ok: true, compacted: true } },
    });
    // 7 min 50 s already pending against an 8-minute deadline.
    await performSend(session, oldBody(7 * 60_000 + 50_000), writer, null, null);

    expect(gw.countOf("sessions.compact")).toBe(0);
    // The send is what matters: refusing it here would lose a turn the gateway
    // would have answered.
    expect(gw.countOf("chat.send")).toBe(1);
  });

  it("a session that CANNOT compact still blocks, budget or no budget", async () => {
    // Reviewed and kept: the remedy is unavailable rather than unattempted (the
    // harness cannot compact), so the deadline is irrelevant to the verdict — and a
    // named card with two working exits beats letting the send run out the clock
    // into a generic deadline error.
    const { gw, session, writer } = await harness({
      describe: [at(97)],
      compact: {
        payload: {
          ok: true,
          compacted: false,
          reason: "unsupported_harness_compaction",
        },
      },
    });
    await expect(
      performSend(session, body, writer, null, null),
    ).rejects.toThrow(/send withheld/);
    // A LATER, nearly-expired dispatch on the same session: still blocked, and
    // without re-asking.
    await expect(
      performSend(session, oldBody(7 * 60_000 + 50_000), writer, null, null),
    ).rejects.toThrow(/send withheld/);
    expect(gw.countOf("sessions.compact")).toBe(1);
  });

  it("a dispatch with almost no budget left is never BLOCKED either", async () => {
    // A remedy we chose not to attempt is not evidence the prompt does not fit.
    const { gw, session, writer } = await harness({
      describe: [at(97)],
      compact: {
        payload: { ok: true, compacted: false, reason: "no transcript" },
      },
    });
    await performSend(session, oldBody(7 * 60_000 + 50_000), writer, null, null);
    expect(gw.countOf("chat.send")).toBe(1);
  });

  it("the compaction's timeout is CLAMPED to the remaining budget", async () => {
    const { gw, session, writer } = await harness({
      describe: [at(97)],
      compact: { payload: { ok: true, compacted: true } },
    });
    // 6 min 20 s pending leaves ~100 s; minus the reserve that covers the
    // re-describe, the rehydration/staging work and the send, the compaction gets
    // well under its nominal 60 s.
    await performSend(session, oldBody(6 * 60_000 + 20_000), writer, null, null);

    const i = gw.calls.findIndex(([m]) => m === "sessions.compact");
    expect(i).toBeGreaterThan(-1);
    const given = gw.timeouts[i]!;
    expect(given).toBeGreaterThanOrEqual(10_000);
    expect(given).toBeLessThan(60_000);
    expect(gw.countOf("chat.send")).toBe(1);
  });

  it("a fresh dispatch gets the full gateway-sized budget", async () => {
    const { gw, session, writer } = await harness({
      describe: [at(97)],
      compact: { payload: { ok: true, compacted: true } },
    });
    await performSend(session, body, writer, null, null);
    const i = gw.calls.findIndex(([m]) => m === "sessions.compact");
    expect(gw.timeouts[i]).toBe(60_000);
  });
});

describe("a DEFERRED (announce) turn also forbids the compaction", () => {
  it("an invisible announce run is never compacted under", async () => {
    // The run type the last lot's bisect caught: a spontaneous turn creates NO
    // assistant message until content proves visible, so it is busy while being
    // invisible. Compacting there interrupts it — three announce runs on the wire,
    // one merged. The send now waits the run out (defect 18): the compaction may
    // only happen AFTER the announce turn ended.
    const { gw, session, writer } = await harness({
      describe: [at(97), at(30)],
      compact: { payload: { ok: true, compacted: true } },
    });
    await session.runManager.beginTurn(1000, "announce-run-1", {
      expectedSessionId: null,
      spontaneous: true,
    });
    const sending = performSend(session, body, writer, null, null);
    await sleep(150);
    expect(gw.countOf("sessions.compact")).toBe(0);

    await session.runManager.endTurn(session.clock(), "final");
    await sending;
    expect(gw.countOf("sessions.compact")).toBe(1);
    expect(gw.countOf("chat.send")).toBe(1);
  });
});

// ── Defect 18: holding a send behind a delivery run the bridge can see ────────
// Narrows the followup-queue case, not a guarantee: the release check fails open
// (field absent, call failed, budget spent), and a delivery run whose first frame
// has not reached the bridge is invisible to the hold.
//
// Measured on 2026.9.4 (live 2026-09-14): a `chat.send` landing while an
// `announce:v1:` run is live is queued as a followup — ack `started`, a bare
// `chat final` for the client run, the reply later under a fresh UUID nothing
// links back. Atrium closed the turn empty and retried it: the model answered twice.

describe("a send waits out a live delivery run", () => {
  const ANNOUNCE_RUN = "announce:v1:agent:alice:subagent:child-1:run-1";
  const lifecycle = (sessionKey: string, phase: string, runId = ANNOUNCE_RUN) => ({
    type: "event",
    event: "agent",
    payload: {
      runId,
      sessionKey,
      stream: "lifecycle",
      data: { phase, ...(phase === "end" ? { stopReason: "stop" } : {}) },
    },
  });
  const chatFinal = (sessionKey: string, runId = ANNOUNCE_RUN) => ({
    type: "event",
    event: "chat",
    payload: {
      runId,
      sessionKey,
      seq: 1,
      state: "final",
      stopReason: "stop",
      message: { role: "assistant", content: [{ type: "text", text: "report" }] },
    },
  });

  it("holds chat.send while the announce streams, releases it at the run's end", async () => {
    const { gw, session, writer } = await harness({ describe: [at(10)] });
    // The live shape: the announce's lifecycle start, then minutes of tool work
    // with nothing visible — Convex sees an idle chat and dispatches.
    gw.emit(lifecycle(session.sessionKey, "start"));
    await vi.waitFor(() =>
      expect(session.runManager.deliveryInProgress).toBe(true),
    );

    const sending = performSend(session, body, writer, null, null);
    await sleep(200);
    expect(gw.countOf("chat.send")).toBe(0);

    gw.emit(lifecycle(session.sessionKey, "end"));
    gw.emit(chatFinal(session.sessionKey));
    await sending;
    expect(gw.countOf("chat.send")).toBe(1);
    expect(session.runManager.deliveryInProgress).toBe(false);
  });

  it("a delivery run that STARTS during the pre-send work holds the send too", async () => {
    // The pre-send steps can take seconds (a 97 % session is compacted first): an
    // announce opening meanwhile must be caught by the last check before the arm.
    const { gw, session, writer } = await harness({
      describe: [at(97), at(30)],
      compact: { delayMs: 300, payload: { ok: true, compacted: true } },
    });
    const sending = performSend(session, body, writer, null, null);
    await vi.waitFor(() => expect(gw.countOf("sessions.compact")).toBe(1));
    gw.emit(lifecycle(session.sessionKey, "start"));
    await vi.waitFor(() =>
      expect(session.runManager.deliveryInProgress).toBe(true),
    );
    await sleep(500); // the compaction has answered by now
    expect(gw.countOf("chat.send")).toBe(0);

    gw.emit(lifecycle(session.sessionKey, "end"));
    gw.emit(chatFinal(session.sessionKey));
    await sending;
    expect(gw.countOf("chat.send")).toBe(1);
  });

  it("after a delivery ENDED, the send waits until the gateway released its run", async () => {
    // 2026.9.4 broadcasts the run's end, THEN clears the embedded run behind an
    // awaited trajectory flush: `hasActiveRun` stays true across that window.
    const { gw, session, writer } = await harness({
      describe: [at(10)],
      sequences: {
        "chat.history": [
          { payload: { sessionInfo: { hasActiveRun: true } } },
          { payload: { sessionInfo: { hasActiveRun: true } } },
          { payload: { sessionInfo: { hasActiveRun: false } } },
        ],
      },
    });
    gw.emit(lifecycle(session.sessionKey, "start"));
    gw.emit(lifecycle(session.sessionKey, "end"));
    gw.emit(chatFinal(session.sessionKey));
    await vi.waitFor(() => {
      expect(session.runManager.lastTurnWasDelivery).toBe(true);
      expect(session.runManager.deliveryInProgress).toBe(false);
    });

    await performSend(session, body, writer, null, null);
    const methods = gw.calls.map(([m]) => m);
    const sendAt = methods.indexOf("chat.send");
    expect(sendAt).toBeGreaterThan(-1);
    // Every release check answered BEFORE the send, and the last one said released.
    const releaseChecks = methods
      .map((m, i) => (m === "chat.history" ? i : -1))
      .filter((i) => i >= 0);
    expect(releaseChecks.filter((i) => i < sendAt).length).toBeGreaterThanOrEqual(3);
    expect(releaseChecks.every((i) => i < sendAt)).toBe(true);
    const params = gw.calls.find(([m]) => m === "chat.history")?.[1];
    expect(params).toMatchObject({ sessionKey: session.sessionKey, limit: 1 });
  });

  it("no delivery before the send: the gateway is not asked", async () => {
    const { gw, session, writer } = await harness({ describe: [at(10)] });
    await performSend(session, body, writer, null, null);
    expect(gw.countOf("chat.send")).toBe(1);
    expect(gw.countOf("chat.history")).toBe(0);
  });

  it("a failing or field-less release check lets the send go (older gateways)", async () => {
    for (const answer of [
      { throws: new Error("unknown method: chat.history") },
      { payload: { sessionInfo: {} } },
    ]) {
      const { gw, session, writer } = await harness({
        describe: [at(10)],
        answers: { "chat.history": answer },
      });
      await session.runManager.beginTurn(session.clock(), ANNOUNCE_RUN, {
        expectedSessionId: null,
        spontaneous: true,
      });
      await session.runManager.endTurn(session.clock(), "final");
      await performSend(session, body, writer, null, null);
      expect(gw.countOf("chat.send")).toBe(1);
      vi.restoreAllMocks();
    }
  });

  it("a delivery still FINALIZING locally holds the send until its finalize lands", async () => {
    // flushFinal drops `active` before its tail settles; a real beginTurn would reset
    // the sink fields that tail still reads (codex P1).
    const { gw, session, writer } = await harness({ describe: [at(10)] });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    (writer as unknown as { finalize: () => Promise<void> }).finalize = async () => {
      await gate;
    };
    gw.emit(lifecycle(session.sessionKey, "start"));
    gw.emit(lifecycle(session.sessionKey, "end"));
    gw.emit(chatFinal(session.sessionKey));
    await vi.waitFor(() => {
      expect(session.runManager.turnActive).toBe(false);
      expect(session.runManager.deliveryInProgress).toBe(true);
    });

    const sending = performSend(session, body, writer, null, null);
    await sleep(250);
    expect(gw.countOf("chat.send")).toBe(0);

    release();
    await sending;
    expect(gw.countOf("chat.send")).toBe(1);
  });

  it("a delivery that opens AND ends during the release check sends the loop round again", async () => {
    const OTHER_RUN = "announce:v1:agent:alice:subagent:child-2:run-2";
    const { gw, session, writer } = await harness({
      describe: [at(10)],
      sequences: {
        "chat.history": [
          { payload: { sessionInfo: { hasActiveRun: false } } }, // top of performSend
          { delayMs: 400, payload: { sessionInfo: { hasActiveRun: false } } }, // before the arm
          { payload: { sessionInfo: { hasActiveRun: false } } },
        ],
      },
    });
    gw.emit(lifecycle(session.sessionKey, "start"));
    gw.emit(lifecycle(session.sessionKey, "end"));
    gw.emit(chatFinal(session.sessionKey));
    await vi.waitFor(() => {
      expect(session.runManager.lastTurnWasDelivery).toBe(true);
      expect(session.runManager.deliveryInProgress).toBe(false);
    });

    const sending = performSend(session, body, writer, null, null);
    await vi.waitFor(() => expect(gw.countOf("chat.history")).toBe(2));
    // While the second check is in flight, a whole other delivery runs: the answer
    // that comes back predates it.
    gw.emit(lifecycle(session.sessionKey, "start", OTHER_RUN));
    gw.emit(lifecycle(session.sessionKey, "end", OTHER_RUN));
    gw.emit(chatFinal(session.sessionKey, OTHER_RUN));
    await sending;

    const methods = gw.calls.map(([m]) => m);
    const sendAt = methods.indexOf("chat.send");
    const checksBeforeSend = methods.filter((m, i) => m === "chat.history" && i < sendAt).length;
    expect(checksBeforeSend).toBeGreaterThanOrEqual(3);
  });

  it("a run the gateway counts for good does not hold the send past the release budget", async () => {
    // `hasActiveRun` over-approximates admission: a true that never clears is not the
    // release window, and the send goes as before — boundedly, without a refusal.
    setGatewayReleaseBudgetForTests(300);
    try {
      const { gw, session, writer } = await harness({
        describe: [at(10)],
        answers: { "chat.history": { payload: { sessionInfo: { hasActiveRun: true } } } },
      });
      await session.runManager.beginTurn(session.clock(), ANNOUNCE_RUN, {
        expectedSessionId: null,
        spontaneous: true,
      });
      await session.runManager.endTurn(session.clock(), "final");
      await performSend(session, body, writer, null, null);
      expect(gw.countOf("chat.send")).toBe(1);
      // Two bounded waits (top + before the arm), paced — not a 100 ms hammer.
      expect(gw.countOf("chat.history")).toBeLessThanOrEqual(8);
    } finally {
      setGatewayReleaseBudgetForTests(30_000);
    }
  });

  it("a hold over a SILENT live delivery does not keep waking the consume loop", async () => {
    // Every wake restarts the loop's frame race and leaves a timer behind (codex).
    const { gw, session, writer } = await harness({ describe: [at(10)] });
    await session.runManager.beginTurn(session.clock(), ANNOUNCE_RUN, {
      expectedSessionId: null,
      spontaneous: true,
    });
    const wake = vi.spyOn(session, "wake");
    const sending = performSend(session, body, writer, null, null);
    await sleep(400);
    expect(wake.mock.calls.length).toBeLessThanOrEqual(1);
    await session.runManager.endTurn(session.clock(), "final");
    await sending;
    expect(gw.countOf("chat.send")).toBe(1);
  });

  it("a release check that ANSWERS past the deadline refuses before anything else runs", async () => {
    const { gw, session, writer } = await harness({
      describe: [at(10)],
      answers: {
        "chat.history": { delayMs: 500, payload: { sessionInfo: { hasActiveRun: false } } },
      },
    });
    await session.runManager.beginTurn(session.clock(), ANNOUNCE_RUN, {
      expectedSessionId: null,
      spontaneous: true,
    });
    await session.runManager.endTurn(session.clock(), "final");
    const late = { ...body, dispatchAgeMs: PRE_SEND_DEADLINE_MS - 200 };
    await expect(performSend(session, late, writer, null, null)).rejects.toThrow(
      /dispatch deadline exceeded/,
    );
    expect(gw.countOf("sessions.describe")).toBe(0);
    expect(gw.countOf("chat.send")).toBe(0);
  });

  it("the release budget is ONE per send: once the top check spends it, the check before the arm asks nothing", async () => {
    setGatewayReleaseBudgetForTests(300);
    try {
      const { gw, session, writer } = await harness({
        describe: [at(10)],
        answers: { "chat.history": { payload: { sessionInfo: { hasActiveRun: true } } } },
      });
      await session.runManager.beginTurn(session.clock(), ANNOUNCE_RUN, {
        expectedSessionId: null,
        spontaneous: true,
      });
      await session.runManager.endTurn(session.clock(), "final");
      await performSend(session, body, writer, null, null);
      expect(gw.countOf("chat.send")).toBe(1);
      const methods = gw.calls.map(([m]) => m);
      const describedAt = methods.indexOf("sessions.describe");
      // The check at the top spent the budget: the one before the arm asks nothing.
      expect(methods.filter((m, i) => m === "chat.history" && i > describedAt)).toHaveLength(0);
      for (const [i, m] of methods.entries()) {
        if (m === "chat.history") expect(gw.timeouts[i]).toBeLessThanOrEqual(300);
      }
    } finally {
      setGatewayReleaseBudgetForTests(30_000);
    }
  });

  it("each release RPC is given only the budget still LEFT, not the whole of it", async () => {
    // A slow answer spends budget: the next check's own timeout must shrink with it.
    setGatewayReleaseBudgetForTests(1_000);
    try {
      const { gw, session, writer } = await harness({
        describe: [at(10)],
        answers: {
          "chat.history": { delayMs: 200, payload: { sessionInfo: { hasActiveRun: true } } },
        },
      });
      await session.runManager.beginTurn(session.clock(), ANNOUNCE_RUN, {
        expectedSessionId: null,
        spontaneous: true,
      });
      await session.runManager.endTurn(session.clock(), "final");
      await performSend(session, body, writer, null, null);
      const timeouts = gw.calls
        .map(([m], i) => (m === "chat.history" ? gw.timeouts[i] : undefined))
        .filter((t): t is number => t !== undefined);
      expect(timeouts.length).toBeGreaterThanOrEqual(2);
      expect(timeouts[0]).toBeLessThanOrEqual(1_000);
      // The first answer took 200 ms and the pacing slept 250 ms before the second.
      expect(timeouts[1]).toBeLessThanOrEqual(1_000 - 200);
      for (let i = 1; i < timeouts.length; i++) {
        expect(timeouts[i]!).toBeLessThan(timeouts[i - 1]!);
      }
      expect(gw.countOf("chat.send")).toBe(1);
    } finally {
      setGatewayReleaseBudgetForTests(30_000);
    }
  });

  it("a long hold BEFORE THE ARM does not eat into the new turn's silence budget", async () => {
    // The session clock ADVANCES (the default harness clock is frozen, which is why no
    // earlier test could see this). The delivery opens during the pre-send work, so the
    // wait happens in the LAST hold, right before the arm — where a clock read taken
    // before that hold would hand the turn a silence deadline already spent.
    let t = 1000;
    const { gw, session, writer } = await harness(
      {
        describe: [at(97), at(30)],
        compact: { delayMs: 300, payload: { ok: true, compacted: true } },
      },
      () => t,
    );
    const sending = performSend(session, body, writer, null, null);
    await vi.waitFor(() => expect(gw.countOf("sessions.compact")).toBe(1));
    gw.emit(lifecycle(session.sessionKey, "start"));
    await vi.waitFor(() =>
      expect(session.runManager.deliveryInProgress).toBe(true),
    );
    await sleep(500); // the compaction has answered: the send now waits in the last hold
    expect(gw.countOf("chat.send")).toBe(0);
    t += 300; // five minutes of hold, on the session clock
    gw.emit(lifecycle(session.sessionKey, "end"));
    gw.emit(chatFinal(session.sessionKey));
    await sending;
    expect(gw.countOf("chat.send")).toBe(1);
    expect(session.runManager.nextTimeout(t)).toBeGreaterThan(200);
  });

  it("the hold ITSELF refuses at the deadline, with no release check behind it", async () => {
    // A real turn holds the sink while an announce waits in the stash: the hold waits,
    // and no delivery turn was the last one, so no release check runs after it. The
    // hold's own exit is then the only thing standing between the deadline and the
    // claim/patch/describe that follow.
    const { gw, session, writer } = await harness({ describe: [at(10)] });
    const rm = session.runManager;
    await rm.beginTurn(session.clock(), "own-run", { expectedSessionId: null });
    await rm.feed(lifecycle(session.sessionKey, "start"), session.clock());
    expect(rm.lastTurnWasDelivery).toBe(false);
    expect(rm.deliveryInProgress).toBe(true);

    const late = { ...body, dispatchAgeMs: PRE_SEND_DEADLINE_MS - 300 };
    await expect(performSend(session, late, writer, null, null)).rejects.toThrow(
      /dispatch deadline exceeded/,
    );
    expect(gw.countOf("sessions.describe")).toBe(0);
    expect(gw.countOf("chat.history")).toBe(0);
    expect(gw.countOf("chat.send")).toBe(0);
  });

  it("a delivery run still live at the pre-send deadline refuses the send", async () => {
    const { gw, session, writer } = await harness({ describe: [at(10)] });
    await session.runManager.beginTurn(session.clock(), ANNOUNCE_RUN, {
      expectedSessionId: null,
      spontaneous: true,
    });
    // Almost the whole budget already spent in Convex: the hold must give up, not
    // run a turn the reconciler is about to settle.
    const late = { ...body, dispatchAgeMs: PRE_SEND_DEADLINE_MS - 300 };
    await expect(
      performSend(session, late, writer, null, null),
    ).rejects.toThrow(/dispatch deadline exceeded/);
    expect(gw.countOf("chat.send")).toBe(0);
    // The hold at the TOP threw: nothing else ran for a send that will never go out.
    expect(gw.countOf("sessions.describe")).toBe(0);
  });

  it("a stash holding a FINISHED delivery releases the send without a gateway tick", async () => {
    const { gw, session, writer } = await harness({ describe: [at(10)] });
    const rm = session.runManager;
    // A UNIT test of the flush seam, on a state built directly: stashed announce
    // frames with no turn holding the sink and no flush scheduled. Production reaches
    // that state when frames are stashed while a finalize is still writing
    // (run-manager feed(), `sink.finalizing`) and nothing flushes until the next frame
    // or deadline; this test does NOT drive that path — it plants the stash through the
    // armed-send branch and drops the private armed flag without the disarm's flush.
    rm.armReplayBuffer();
    await rm.feed(lifecycle(session.sessionKey, "start"), session.clock());
    await rm.feed(lifecycle(session.sessionKey, "end"), session.clock());
    await rm.feed(chatFinal(session.sessionKey), session.clock());
    (rm as unknown as { replayArmed: boolean }).replayArmed = false;
    expect(rm.turnActive).toBe(false);
    expect(rm.deliveryInProgress).toBe(true);

    // Two seconds of budget left: without the flush the hold would sit on the stash
    // until the deadline and refuse — a failure, not a slow pass.
    const tight = { ...body, dispatchAgeMs: PRE_SEND_DEADLINE_MS - 2_000 };
    await performSend(session, tight, writer, null, null);
    expect(gw.countOf("chat.send")).toBe(1);
  });
});

// ── The cause of OUR OWN compaction (W2 / G-09, honestly scoped) ────────────
//
// `session.operation` carries the gateway's own reason and is unreachable from the
// turn socket (subscribing there cost conversation frames — see session.ts). But
// when the pre-send guard compacts, we ARE the cause: we asked, pre-emptively,
// before assembling the prompt. Without this the marker's cause sentence and the
// pressure trace's `compactionReason` — both shipped in this lot — would carry
// nothing for ever.

describe("a guard-initiated compaction names its own cause", () => {
  it("the rotation that follows carries `pre_compaction`", async () => {
    const { Normalizer } = await import(
      "../src/providers/openclaw/normalizer.js"
    );
    const KEY = "agent:alice:atrium:chat:u:c1";
    const n = new Normalizer(KEY);
    n.beginTurn(0);
    n.noteExpectedSessionId("session-before");
    n.noteRunStarted("run-1", 0);
    n.notePresendCompactionCause("pre_compaction");

    // The first own frame arrives on a ROTATED session id — the footprint of the
    // compaction the guard just performed.
    const events = n.feed(
      {
        type: "event",
        event: "agent",
        payload: {
          runId: "run-1",
          sessionKey: KEY,
          sessionId: "session-after",
          stream: "assistant",
          data: { text: "hi", delta: "hi" },
        },
      },
      1,
    );
    const cause = events.find((e) => e.type === "compaction.cause") as
      | { reason?: string; completed?: boolean; refusal?: boolean }
      | undefined;
    expect(cause?.reason).toBe("pre_compaction");
    expect(cause?.completed).toBe(true);
    expect(cause?.refusal).toBe(false);
  });

  it("is consumed ONCE: a later rotation we did not cause stays cause-less", async () => {
    const { Normalizer } = await import(
      "../src/providers/openclaw/normalizer.js"
    );
    const KEY = "agent:alice:atrium:chat:u:c2";
    const frame = (sid: string) => ({
      type: "event",
      event: "agent",
      payload: {
        runId: "run-1",
        sessionKey: KEY,
        sessionId: sid,
        stream: "assistant",
        data: { text: "x", delta: "x" },
      },
    });
    const n = new Normalizer(KEY);
    n.beginTurn(0);
    n.noteExpectedSessionId("s0");
    n.noteRunStarted("run-1", 0);
    n.notePresendCompactionCause("pre_compaction");
    const first = n.feed(frame("s1"), 1);
    expect(
      first.some((e) => e.type === "compaction.cause"),
    ).toBe(true);

    // A NEW turn, no guard compaction: the gateway rotated on its own, and
    // inheriting our label would attribute its compaction to us.
    n.beginTurn(10);
    n.noteExpectedSessionId("s1");
    n.noteRunStarted("run-2", 10);
    const second = n.feed(
      { ...frame("s2"), payload: { ...frame("s2").payload, runId: "run-2" } },
      2,
    );
    expect(second.some((e) => e.type === "compaction.cause")).toBe(false);
    // The compaction itself is still detected — only its cause is unknown.
    expect(second.some((e) => e.type === "context.compaction")).toBe(true);
  });

  it("the guard tells the normalizer, on the real send path", async () => {
    const { gw, session, writer } = await harness({
      describe: [at(97), at(30)],
      compact: { payload: { ok: true, compacted: true } },
    });
    const seen: string[] = [];
    const rm = session.runManager as unknown as {
      notePresendCompactionCause: (r: string) => void;
    };
    const original = rm.notePresendCompactionCause.bind(rm);
    rm.notePresendCompactionCause = (r: string) => {
      seen.push(r);
      original(r);
    };
    await performSend(session, body, writer, null, null);

    expect(gw.countOf("chat.send")).toBe(1);
    expect(seen).toEqual(["pre_compaction"]);
  });

  it("a compaction that did NOT happen names nothing", async () => {
    const { session, writer } = await harness({
      describe: [at(90)],
      compact: {
        payload: { ok: true, compacted: false, reason: "no transcript" },
      },
    });
    const seen: string[] = [];
    const rm = session.runManager as unknown as {
      notePresendCompactionCause: (r: string) => void;
    };
    rm.notePresendCompactionCause = (r: string) => seen.push(r);
    await performSend(session, body, writer, null, null);

    expect(seen).toEqual([]);
  });
});

/**
 * WHICH FIGURE THE GUARD ACTUALLY DECIDED ON — and it must travel.
 *
 * Every test above hands the guard an `at(pct)` describe carrying
 * `promptBudgetBeforeReserve` + `estimatedPromptTokens`. OpenClaw 2026.7.1
 * declares NEITHER (they appear in zero files of the vendored contract, all
 * three pinned versions) and live prod confirms it: 200 consecutive pre-send
 * decisions over five days, `fillSource` = "counter" every time, never
 * "gateway_estimate". So the suite has been proving a shape production never
 * produces — which is why nobody noticed the strong branch was dead.
 *
 * These two pin BOTH shapes and, above all, make the guard state which figure it
 * used, so the answer survives into the trace instead of being re-derived blind.
 */
describe("the fill reading carries the figure it came from", () => {
  /** The REAL 2026.7.1 session describe: counters and a window, nothing more. */
  const realGatewayShape = {
    sessionId: "s-1",
    systemSent: true,
    totalTokens: 190_100,
    contextTokens: 372_000,
    totalTokensFresh: true,
  };

  async function pressureOf(describeScript: FakeSessionDescribe[]) {
    const { session, writer } = await harness({ describe: describeScript });
    const seen: Array<Record<string, unknown> | undefined> = [];
    vi.spyOn(
      session.runManager as unknown as {
        beginTurn: (...a: unknown[]) => Promise<void>;
      },
      "beginTurn",
    ).mockImplementation(async (..._args: unknown[]) => {
      const ctx = _args[2] as { pressure?: Record<string, unknown> } | undefined;
      seen.push(ctx?.pressure);
    });
    await performSend(session, body, writer, null, null);
    return seen[seen.length - 1];
  }

  it("on the REAL gateway shape it says so: counter, not a measured estimate", async () => {
    const p = await pressureOf([realGatewayShape]);
    expect(
      p?.fillSource,
      "the reading is stored with no way to tell it from a gateway-measured one",
    ).toBe("counter");
    // 190100/372000 — a figure that ignores tool schemas and injected context,
    // i.e. exactly what fills a window. The thresholds were calibrated against
    // `promptBudgetBeforeReserve`; this is a different quantity entirely.
    expect(p?.fillPct).toBe(51);
  });

  // THE TWO SHAPES, neither of them contractual. `parseSessionMeta` (the on-screen
  // gauge) reads the budget figures NESTED under `contextBudgetStatus`;
  // `captureDescribe` (the guard) read the same names FLAT on the row. Which one
  // this gateway build emits is an OPEN question — what is measured is only that
  // the flat read finds nothing in prod. This pins the nested branch so the guard
  // is not blind to it; the flat fallback is pinned by the test after it.
  it("the guard sees the budget when it is NESTED, not only when it is flat", async () => {
    const p = await pressureOf([
      {
        sessionId: "s-1",
        systemSent: true,
        totalTokens: 190_100,
        contextTokens: 372_000,
        totalTokensFresh: true,
        contextBudgetStatus: {
          estimatedPromptTokens: 358_960,
          promptBudgetBeforeReserve: 308_000,
        },
      },
    ]);
    // 358960/308000 = 117 %: the prompt does NOT fit, and the guard must see it.
    // Reading the flat names only, it sees 51 % of a window instead and sends.
    expect(
      p?.fillSource,
      "the guard reads the budget from a place the gateway does not use",
    ).toBe("gateway_estimate");
    expect(p?.fillPct).toBe(117);
  });

  it("a PARTIAL nested budget never borrows the other shape's denominator", async () => {
    // `contextBudgetStatus` is contractual in no pinned version, so a partial one
    // is plausible. Here it carries the estimate and NO budget, while the flat
    // shape carries a budget of its own. Dividing 358960 by the flat 100000 would
    // read 359 % and force a compaction nothing asked for; dividing by the window
    // (372000) is what the chosen shape actually supports.
    const p = await pressureOf([
      {
        sessionId: "s-1",
        systemSent: true,
        totalTokens: 190_100,
        contextTokens: 372_000,
        totalTokensFresh: true,
        promptBudgetBeforeReserve: 100_000,
        contextBudgetStatus: { estimatedPromptTokens: 358_960 },
      },
    ]);
    expect(p?.fillSource).toBe("gateway_estimate");
    expect(
      p?.fillPct,
      "the estimate was divided by a budget its own shape never provided",
    ).toBe(96);
  });

  it("a positive overflow is not cancelled by a ZERO in the other shape", async () => {
    // `??` keeps a nested 0 over a flat 50000 — and 0 is not "no verdict", it is a
    // verdict of "it fits". The gateway having said outright that the prompt does
    // NOT fit is the strongest signal the guard has; losing it to the other
    // shape's zero sends a turn already known to be doomed.
    const { gw, session, writer } = await harness({
      describe: [
        {
          sessionId: "s-1",
          systemSent: true,
          totalTokens: 10_000,
          contextTokens: 372_000,
          totalTokensFresh: true,
          overflowTokens: 50_000,
          contextBudgetStatus: { overflowTokens: 0 },
        },
        { sessionId: "s-2", systemSent: true, totalTokens: 10, contextTokens: 372_000 },
      ],
      compact: { payload: { ok: true, compacted: true } },
    });
    await performSend(session, body, writer, null, null);
    // A comfortable-looking counter (3 %) must NOT be what decides here.
    expect(
      gw.countOf("sessions.compact"),
      "the gateway's own 'this does not fit' was cancelled by the other shape's zero",
    ).toBe(1);
  });

  it("a ZERO estimate in one shape cannot silence a positive one in the other", async () => {
    // The mirror of the overflow case. A fixed preference for the nested shape
    // would read 0 % here and send a prompt standing at 117 % of its budget.
    const { gw, session, writer } = await harness({
      describe: [
        {
          sessionId: "s-1",
          systemSent: true,
          totalTokens: 10_000,
          contextTokens: 372_000,
          totalTokensFresh: true,
          estimatedPromptTokens: 358_960,
          promptBudgetBeforeReserve: 308_000,
          contextBudgetStatus: { estimatedPromptTokens: 0 },
        },
        { sessionId: "s-2", systemSent: true, totalTokens: 10, contextTokens: 372_000 },
      ],
      compact: { payload: { ok: true, compacted: true } },
    });
    await performSend(session, body, writer, null, null);
    expect(
      gw.countOf("sessions.compact"),
      "a zero in one shape made the guard more optimistic than the figure it had",
    ).toBe(1);
  });

  it("the HEADER GAUGE is told the same thing the guard decided on", async () => {
    // The lot's own thesis, applied to the third consumer. Nested says 0, flat says
    // 240000/308000 = 78 % — high enough that the reader must be told, low enough
    // that no compaction fires (so the meter reports THIS describe, not a
    // post-compaction one). The header must not claim an empty session while the
    // guard is warning about a nearly full one.
    const gw = fakeGateway({
      describe: [
        {
          sessionId: "s-1",
          systemSent: true,
          totalTokens: 10_000,
          contextTokens: 372_000,
          totalTokensFresh: true,
          estimatedPromptTokens: 240_000,
          promptBudgetBeforeReserve: 308_000,
          contextBudgetStatus: { estimatedPromptTokens: 0 },
        },
      ],
    });
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(
      async () => gw as never,
    );
    const metas: Array<Record<string, unknown>> = [];
    const { writer } = recordingWriter();
    (writer as unknown as { reportSessionMeta: unknown }).reportSessionMeta =
      async (_chatId: string, meta: Record<string, unknown>) => {
        metas.push(meta);
      };
    const reg = new SessionRegistry(servedMap(config, writer), () => 1000);
    const session = await reg.acquire(ROUTING);
    await sleep(5);
    await performSend(session, body, writer, null, null);

    const seen = metas.find((m) => m.estimatedPromptTokens !== undefined);
    expect(
      seen?.estimatedPromptTokens,
      "the header reports one shape while the guard decided on the other",
    ).toBe(240_000);
  });

  it("with NO estimate, the SMALLER budget is the denominator", async () => {
    // Completing the same rule for the third figure. A counter of 90000 is 29 % of
    // a nested 308000 but 90 % of a flat 100000. Preferring either shape by
    // position makes the guard optimistic by luck; the alarming reading must win.
    const { gw, session, writer } = await harness({
      describe: [
        {
          sessionId: "s-1",
          systemSent: true,
          totalTokens: 90_000,
          contextTokens: 372_000,
          totalTokensFresh: true,
          promptBudgetBeforeReserve: 100_000,
          contextBudgetStatus: { promptBudgetBeforeReserve: 308_000 },
        },
        { sessionId: "s-2", systemSent: true, totalTokens: 10, contextTokens: 372_000 },
      ],
      compact: { payload: { ok: true, compacted: true } },
    });
    await performSend(session, body, writer, null, null);
    expect(
      gw.countOf("sessions.compact"),
      "the larger budget was picked by position and hid a 90 % session",
    ).toBe(1);
  });

  it("an UNUSABLE estimate does not select its shape's denominator", async () => {
    // A non-contractual field can carry a sentinel. A nested -1 must not count as
    // "an estimate was found", or it selects its own 308000 budget and the counter
    // reads 29 % instead of 90 % against the flat 100000.
    const { gw, session, writer } = await harness({
      describe: [
        {
          sessionId: "s-1",
          systemSent: true,
          totalTokens: 90_000,
          contextTokens: 372_000,
          totalTokensFresh: true,
          promptBudgetBeforeReserve: 100_000,
          contextBudgetStatus: {
            estimatedPromptTokens: -1,
            promptBudgetBeforeReserve: 308_000,
          },
        },
        { sessionId: "s-2", systemSent: true, totalTokens: 10, contextTokens: 372_000 },
      ],
      compact: { payload: { ok: true, compacted: true } },
    });
    await performSend(session, body, writer, null, null);
    expect(
      gw.countOf("sessions.compact"),
      "a sentinel estimate selected its shape and hid a 90 % session",
    ).toBe(1);
  });

  it("when the gateway DOES measure the prompt, that is what travels", async () => {
    const p = await pressureOf([at(97)]);
    expect(p?.fillSource).toBe("gateway_estimate");
    expect(p?.fillPct).toBe(97);
  });
});

describe("the outbound delivery instruction is WITHHELD on a poisoning gateway", () => {
  // Proving the FUNCTION returns a reason proves nothing about the send path: the
  // question is whether the message actually loses the instruction. Asserted on the
  // `chat.send` body the fake gateway received.
  const sentMessage = (gw: FakeGateway): string =>
    String(
      (gw.calls.find(([m]) => m === "chat.send")?.[1] as { message?: unknown })
        ?.message ?? "",
    );
  const DIR = "/srv/media/outbound";

  it("a healthy version still gets it", async () => {
    const { gw, session, writer } = await harness({ describe: [at(10)] });
    (session.connection as unknown as { gatewayVersion: string }).gatewayVersion =
      "2026.9.1";
    await performSend(session, body, writer, null, DIR);
    expect(sentMessage(gw)).toContain(DIR);
  });

  it("2026.8.1 does NOT: a delivered file would poison the session", async () => {
    const { gw, session, writer } = await harness({ describe: [at(10)] });
    (session.connection as unknown as { gatewayVersion: string }).gatewayVersion =
      "2026.8.1";
    await performSend(session, body, writer, null, DIR);
    expect(gw.countOf("chat.send"), "the turn still goes through").toBe(1);
    expect(sentMessage(gw), "the agent is not asked to deliver a file").not.toContain(DIR);
  });

  it("…unless THIS instance's image is attested to carry the fix", async () => {
    const { gw, session, writer } = await harness({ describe: [at(10)] });
    (session.connection as unknown as { gatewayVersion: string }).gatewayVersion =
      "2026.8.1";
    await performSend(session, body, writer, null, DIR, {
      attachmentFixAttested: true,
    });
    expect(sentMessage(gw)).toContain(DIR);
  });

  it("a hello with NO version still quarantines when the config names the version", async () => {
    // A degraded handshake leaves `gatewayVersion` null. Reading only the live field
    // disarmed the quarantine on a gateway the operator had configured as 2026.8.x.
    const { gw, session, writer } = await harness({ describe: [at(10)] });
    (session.connection as unknown as { gatewayVersion: string | null }).gatewayVersion =
      null;
    await performSend(session, body, writer, null, DIR, {
      gatewayVersionFallback: "2026.8.2",
    });
    expect(sentMessage(gw)).not.toContain(DIR);
  });

  it("a MALFORMED live version does not outrank the configured one", async () => {
    // A hello announcing `dev` is not evidence: it parses to nothing, so the operator's
    // configured version decides (codex).
    const { gw, session, writer } = await harness({ describe: [at(10)] });
    (session.connection as unknown as { gatewayVersion: string }).gatewayVersion = "dev";
    await performSend(session, body, writer, null, DIR, {
      gatewayVersionFallback: "2026.8.2",
    });
    expect(sentMessage(gw)).not.toContain(DIR);
  });

  it("NO version at all fails CLOSED: unidentified is not the same as safe", async () => {
    const { gw, session, writer } = await harness({ describe: [at(10)] });
    (session.connection as unknown as { gatewayVersion: string | null }).gatewayVersion =
      null;
    await performSend(session, body, writer, null, DIR, null);
    expect(gw.countOf("chat.send"), "the turn still goes through").toBe(1);
    expect(sentMessage(gw)).not.toContain(DIR);
  });

  it("a HEALTHY-looking fallback cannot lift the quarantine on a mute hello (codex)", async () => {
    // After a rollback to 2026.8.x with a degraded handshake, the configured version may
    // still read 2026.9.1. Treating it as proof answered "safe" for a gateway that
    // poisons. The fallback may CONFIRM a quarantine, never lift one.
    const { gw, session, writer } = await harness({ describe: [at(10)] });
    (session.connection as unknown as { gatewayVersion: string | null }).gatewayVersion =
      null;
    await performSend(session, body, writer, null, DIR, {
      gatewayVersionFallback: "2026.9.1",
    });
    expect(gw.countOf("chat.send"), "the turn still goes through").toBe(1);
    expect(sentMessage(gw)).not.toContain(DIR);
  });

  it("an instance attested elsewhere does NOT re-arm this one", async () => {
    // One bridge serves several gateways. The attestation is per instance, so a
    // patched image next door cannot speak for a stock one.
    const { gw, session, writer } = await harness({ describe: [at(10)] });
    (session.connection as unknown as { gatewayVersion: string }).gatewayVersion =
      "2026.8.1";
    await performSend(session, body, writer, null, DIR, {
      attachmentFixAttested: false,
    });
    expect(sentMessage(gw)).not.toContain(DIR);
  });
});
