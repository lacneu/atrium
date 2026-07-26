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

import { performSend } from "../src/server.js";
import { SessionRegistry } from "../src/session.js";
import type { BridgeConfig } from "../src/config.js";
import type { ConvexWriter } from "../src/convex-writer.js";
import { OpenClawConnection } from "../src/providers/openclaw/openclaw-client.js";
import { fakeGateway, type FakeGateway } from "./helpers/fake-gateway.js";
import { servedMap } from "./helpers/served.js";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

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
async function harness(script: Parameters<typeof fakeGateway>[0]) {
  const gw = fakeGateway(script);
  vi.spyOn(OpenClawConnection, "connect").mockImplementation(
    async () => gw as never,
  );
  const { writer, traces } = recordingWriter();
  const reg = new SessionRegistry(servedMap(config, writer), () => 1000);
  const session = await reg.acquire(ROUTING);
  await tick();
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
    // one merged.
    const { gw, session, writer } = await harness({
      describe: [at(97)],
      compact: { payload: { ok: true, compacted: true } },
    });
    await session.runManager.beginTurn(1000, "announce-run-1", {
      expectedSessionId: null,
      spontaneous: true,
    });
    await performSend(session, body, writer, null, null);

    expect(gw.countOf("sessions.compact")).toBe(0);
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
