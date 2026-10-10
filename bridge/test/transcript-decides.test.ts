// THE TRANSCRIPT DECIDES (transcript redesign phase 4, projection `on`) — the bridge half.
//
//  - the normalizer on a projected session: no time-based wait ever closes a turn
//    (empty final, cut final, private ack, `finishing`, a lifecycle end's follow-on
//    window, the transcript-recovery window), and no prose rule is consulted; the
//    legacy behaviour is pinned next to each case (`transcriptDecides` off);
//  - the run manager ends a foreground turn on the transcript's own fact
//    (`settleFromTranscript`) — and only its own run's;
//  - the row reader sends what a row SAYS only when asked (projection `on`), extracted
//    and sanitized as the live text is, with the settled-finalization fallback row
//    attributed to its run (the 2026.9.8 golden capture);
//  - the reconciler relays Convex's settled runs.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  BASE_RECV_TIMEOUT,
  Normalizer,
  TRUNCATED_FINAL_MARKER,
  TRUNCATED_FINAL_MIN_BODY,
  type BridgeEvent,
} from "../src/providers/openclaw/normalizer.js";
import { RunManager } from "../src/providers/openclaw/run-manager.js";
import { parseHistoryReply, toTranscriptRow } from "../src/providers/openclaw/transcript-rows.js";
import { TranscriptShadow, type TranscriptApply } from "../src/providers/openclaw/transcript-shadow.js";
import type { ConvexWriter } from "../src/convex-writer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SK = "agent:main:atrium:chat:u:c1";
const RUN = "run-own";

const chat = (payload: Record<string, unknown>) => ({
  type: "event",
  event: "chat",
  payload: { sessionKey: SK, runId: RUN, ...payload },
});
const lifecycle = (phase: string, extra: Record<string, unknown> = {}) => ({
  type: "event",
  event: "agent",
  payload: { sessionKey: SK, runId: RUN, stream: "lifecycle", data: { phase, ...extra } },
});
const text = (t: string) => ({ role: "assistant", content: [{ type: "text", text: t }] });

function start(decides: boolean): { n: Normalizer; now: number } {
  const n = new Normalizer(SK, null);
  n.transcriptDecides = decides;
  const now = 1000;
  n.beginTurn(now);
  n.noteRunStarted(RUN, now);
  return { n, now };
}

const finalOf = (ev: BridgeEvent[]) =>
  ev.find((e) => e.type === "message.final") as
    | (BridgeEvent & { text?: string; diagnosticFinalizeCause?: string | null })
    | undefined;

describe("normalizer — a projected turn never ends on a timer", () => {
  it("an empty final ends the turn at once (CU-13: the rows will say what it was)", () => {
    const on = start(true);
    const ev = on.n.feed(chat({ state: "final" }), on.now + 1);
    expect(on.n.finalized).toBe(true);
    expect(finalOf(ev)?.diagnosticFinalizeCause).toBe("gateway_final");
    // Legacy: the 90 s empty-final wait.
    const off = start(false);
    off.n.feed(chat({ state: "final" }), off.now + 1);
    expect(off.n.finalized).toBe(false);
    expect(off.n.nextTimeout(off.now + 1)).toBeLessThan(BASE_RECV_TIMEOUT);
  });

  it("a final the gateway CUT ends the turn at once (the durable row is whole)", () => {
    const cut = "x".repeat(TRUNCATED_FINAL_MIN_BODY) + TRUNCATED_FINAL_MARKER;
    const on = start(true);
    on.n.feed(chat({ state: "final", message: text(cut) }), on.now + 1);
    expect(on.n.finalized).toBe(true);
    const off = start(false);
    off.n.feed(chat({ state: "final", message: text(cut) }), off.now + 1);
    expect(off.n.finalized).toBe(false);
  });

  it("a private acknowledgment is the run's text like any other — no prose rule, no 5 s wait", () => {
    const on = start(true);
    const ev = on.n.feed(chat({ state: "final", message: text("Envoyé dans le webchat.") }), on.now + 1);
    expect(on.n.finalized).toBe(true);
    expect(finalOf(ev)?.text).toBe("Envoyé dans le webchat.");
    const off = start(false);
    off.n.feed(chat({ state: "final", message: text("Envoyé dans le webchat.") }), off.now + 1);
    expect(off.n.finalized).toBe(false);
  });

  it("`finishing` and a lifecycle end arm no wait: only the silence net remains", () => {
    const on = start(true);
    on.n.feed(chat({ state: "delta", message: text("réponse") }), on.now + 1);
    on.n.feed(lifecycle("finishing"), on.now + 2);
    on.n.feed(lifecycle("end"), on.now + 3);
    expect(on.n.finalized).toBe(false);
    expect(on.n.nextTimeout(on.now + 3)).toBeCloseTo(BASE_RECV_TIMEOUT, 0);
    // Nothing closes it before the silence budget, and the silence asks (never ends).
    expect(on.n.tick(on.now + 3 + 120)).toEqual([]);
    const off = start(false);
    off.n.feed(chat({ state: "delta", message: text("réponse") }), off.now + 1);
    off.n.feed(lifecycle("end"), off.now + 3);
    expect(off.n.nextTimeout(off.now + 3)).toBeLessThan(BASE_RECV_TIMEOUT);
  });

  it("an unknown run is never adopted into the turn through a lifecycle-end window", () => {
    const on = start(true);
    on.n.feed(chat({ state: "delta", message: text("A") }), on.now + 1);
    on.n.feed(lifecycle("end"), on.now + 2);
    const ev = on.n.feed(
      { type: "event", event: "chat", payload: { sessionKey: SK, runId: "stranger", state: "final", message: text("B") } },
      on.now + 3,
    );
    expect(on.n.ownRunIds.has("stranger")).toBe(false);
    expect(finalOf(ev)).toBeUndefined();
    const off = start(false);
    off.n.feed(chat({ state: "delta", message: text("A") }), off.now + 1);
    off.n.feed(lifecycle("end"), off.now + 2);
    off.n.feed(
      { type: "event", event: "chat", payload: { sessionKey: SK, runId: "stranger", state: "final", message: text("B") } },
      off.now + 3,
    );
    expect(off.n.ownRunIds.has("stranger")).toBe(true);
  });

  it("a chat error AFTER the run's end is still a post-reply failure (the end is a fact)", () => {
    const statusOf = (ev: BridgeEvent[]) =>
      (ev.find((e) => e.type === "run.status" && (e as { status?: string }).status !== "working") as
        | { status?: string }
        | undefined)?.status;
    const on = start(true);
    on.n.feed(chat({ state: "delta", message: text("réponse livrée") }), on.now + 1);
    on.n.feed(lifecycle("end"), on.now + 2);
    const after = on.n.feed(chat({ state: "error", errorMessage: "compaction timed out" }), on.now + 3);
    // Settled complete: the delivered answer is never painted as a failed turn.
    expect(statusOf(after)).toBe("complete");
    // Without the end, the same error is the turn's failure.
    const mid = start(true);
    mid.n.feed(chat({ state: "delta", message: text("réponse") }), mid.now + 1);
    expect(statusOf(mid.n.feed(chat({ state: "error", errorMessage: "boom" }), mid.now + 3))).toBe("error");
  });

  it("the positional transcript recovery is never requested", () => {
    const on = start(true);
    on.n.feed(
      { type: "event", event: "agent", payload: { sessionKey: SK, runId: RUN, stream: "item", data: { kind: "tool", name: "message", phase: "start", toolCallId: "t1", args: { action: "send", message: "x" } } } },
      on.now + 1,
    );
    on.n.feed(chat({ state: "final" }), on.now + 2);
    expect(on.n.wantsHistoryRecovery).toBe(false);
  });

  it("a silence on a projected turn asks again a budget later, never ends it", () => {
    const on = start(true);
    on.n.feed(chat({ state: "delta", message: text("…") }), on.now + 1);
    const silentAt = on.now + 1 + BASE_RECV_TIMEOUT + 1;
    expect(on.n.tick(silentAt)).toEqual([]);
    expect(on.n.takeRecvSilence()).toBe(true);
    expect(on.n.nextTimeout(silentAt)).toBeNull();
    on.n.rearmSilence(silentAt);
    expect(on.n.nextTimeout(silentAt)).toBeCloseTo(BASE_RECV_TIMEOUT, 0);
    expect(on.n.finalized).toBe(false);
  });
});

function fakeWriter(): ConvexWriter & { finalizes: Array<Record<string, unknown>> } {
  const finalizes: Array<Record<string, unknown>> = [];
  const w = {
    finalizes,
    startAssistant: vi.fn(async () => "m1"),
    appendDelta: vi.fn(async () => {}),
    setSnapshot: vi.fn(async () => {}),
    finalize: vi.fn(async (...args: unknown[]) => {
      finalizes.push({ args });
    }),
    addPart: vi.fn(async () => {}),
    addCompactionPart: vi.fn(async () => {}),
    recordGatewayPressure: vi.fn(async () => {}),
    addToolPart: vi.fn(async () => {}),
  };
  return w as unknown as ConvexWriter & { finalizes: Array<Record<string, unknown>> };
}

describe("run manager — the transcript's fact ends the foreground turn", () => {
  async function turn(projection: boolean) {
    const writer = fakeWriter();
    const rm = new RunManager("chat1", SK, writer);
    rm.setProjection(projection);
    await rm.beginTurn(1000, RUN, { expectedSessionId: null });
    return { rm, writer };
  }

  it("its own run settled → the turn ends (`transcript_settled`)", async () => {
    const { rm } = await turn(true);
    expect(await rm.settleFromTranscript(["other", RUN], 1001)).toBe(true);
    expect(rm.turnActive).toBe(false);
  });

  it("another run settled → nothing (the turn's own run is still working)", async () => {
    const { rm } = await turn(true);
    expect(await rm.settleFromTranscript(["other"], 1001)).toBe(false);
    expect(rm.turnActive).toBe(true);
  });

  it("the switch reaches the normalizer: a bare final ends a projected turn at once", async () => {
    const on = await turn(true);
    await on.rm.feed(chat({ state: "final" }), 1001);
    expect(on.rm.turnActive).toBe(false);
    const off = await turn(false);
    await off.rm.feed(chat({ state: "final" }), 1001);
    expect(off.rm.turnActive).toBe(true);
  });

  it("pass 2: a run the turn no longer follows (compaction resumed on B) ending never closes it", async () => {
    const { rm } = await turn(true);
    await rm.feed(chat({ state: "delta", message: text("début") }), 1001);
    // The gateway abandons A to replay the turn on a new run B (compaction heuristic).
    await rm.feed(lifecycle("end", { livenessState: "abandoned" }), 1002);
    await rm.feed(
      { type: "event", event: "chat", payload: { sessionKey: SK, runId: "run-B", state: "delta", message: text("suite") } },
      1003,
    );
    expect(rm.foregroundRunId).toBe("run-B");
    expect(await rm.settleFromTranscript([RUN], 1004)).toBe(false);
    expect(rm.turnActive).toBe(true);
    expect(await rm.settleFromTranscript(["run-B"], 1005)).toBe(true);
    expect(rm.turnActive).toBe(false);
  });

  it("projection off → never (the legacy path keeps its own terminals)", async () => {
    const { rm } = await turn(false);
    expect(await rm.settleFromTranscript([RUN], 1001)).toBe(false);
    expect(rm.turnActive).toBe(true);
  });
});

// The 2026.9.8 capture (busy-send bs-message-tool): a message-tool delivery mirror and a
// settled-finalization fallback row, verbatim.
const CAPTURE = JSON.parse(
  readFileSync(resolve(__dirname, "./fixtures/transcript-delivery-rows-2026.9.8.json"), "utf-8"),
) as { messages: unknown[] };

describe("row reader — what a row says, only when the projection is on", () => {
  const mirror = CAPTURE.messages.find(
    (m) => (m as { idempotencyKey?: string }).idempotencyKey?.includes(":message-tool:"),
  )!;
  const fallback = CAPTURE.messages.find(
    (m) => (m as { idempotencyKey?: string }).idempotencyKey?.endsWith(":settled-finalization-fallback"),
  )!;

  it("on: the delivery mirror carries its text and its run", () => {
    const row = toTranscriptRow(mirror, undefined, { sessionKey: SK })!;
    expect(row.runId).toBe("webchat-c185b06eaff71ba449e7d78c9945ec22fa9357840b3a9c5f09080adfd4bbc800");
    expect(row.text).toBe("BS9B933_A_OK");
  });

  it("on: the settled-finalization fallback belongs to its run (its key names it)", () => {
    const row = toTranscriptRow(fallback, undefined, { sessionKey: SK })!;
    expect(row.runId).toBe("webchat-5aef4d9be91225d22a22f40109999428a49e72b21af562b5fa767dac7e9a343c");
    expect(row.text).toMatch(/^The tool run finished/);
  });

  it("off/shadow: identities only — no text, and the fallback keeps upstream's own run id", () => {
    const m = toTranscriptRow(mirror)!;
    expect(m.text).toBeUndefined();
    const f = toTranscriptRow(fallback)!;
    expect(f.runId).toBe(
      "webchat-5aef4d9be91225d22a22f40109999428a49e72b21af562b5fa767dac7e9a343c:settled-finalization-fallback",
    );
  });

  it("on: the text is sanitized like the live text (a server path never leaves the bridge)", () => {
    const row = toTranscriptRow(
      {
        role: "assistant",
        content: [{ type: "text", text: "Voici MEDIA:/home/node/.openclaw/media/outbound/x.png" }],
        __openclaw: { id: "e1", seq: 3, runId: "r" },
      },
      undefined,
      { sessionKey: SK },
    )!;
    expect(row.text).not.toContain("/home/node");
  });

  it("on: a sessions_yield acknowledgment rides the row; NO_REPLY never does", () => {
    const yieldRow = (ack: string) =>
      toTranscriptRow(
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "c1", name: "sessions_yield", arguments: { acknowledgment: ack } }],
          __openclaw: { id: "e2", seq: 4, runId: "p" },
        },
        undefined,
        { sessionKey: SK },
      )!;
    expect(yieldRow("Je reviens.").yieldAck).toBe("Je reviens.");
    expect(yieldRow("NO_REPLY").yieldAck).toBeUndefined();
  });

  it("parseHistoryReply passes the option through a delta read", () => {
    const read = parseHistoryReply(
      { kind: "delta", messages: [{ message: mirror }], deltaCursor: "c" },
      { sessionKey: SK },
    )!;
    expect(read.rows[0]?.text).toBe("BS9B933_A_OK");
  });
});

describe("reconciler — Convex's settled runs reach the run manager (on only)", () => {
  async function reconciler(mode: "on" | "shadow") {
    const settled: string[][] = [];
    const posted: TranscriptApply[] = [];
    const shadow = new TranscriptShadow({
      chatId: "chat1",
      sessionKey: SK,
      readHistory: async () => ({
        sessionKey: SK,
        sessionId: "s1",
        messages: [CAPTURE.messages.find((m) => (m as { role?: string }).role === "assistant")],
        sessionInfo: { hasActiveRun: false },
      }),
      apply: async (p) => {
        posted.push(p);
        return { settledRuns: ["run-x"] };
      },
      onRunsSettled: (ids) => settled.push([...ids]),
      sleep: async () => {},
      log: () => {},
    });
    shadow.configure({ mode });
    await shadow.idle();
    return { settled, posted };
  }

  it("on: rows carry text, settled runs are relayed", async () => {
    const { settled, posted } = await reconciler("on");
    expect(settled).toEqual([["run-x"]]);
    expect(posted[0]!.rows.some((r) => r.text !== undefined)).toBe(true);
  });

  it("shadow: identities only, nothing relayed", async () => {
    const { settled, posted } = await reconciler("shadow");
    expect(settled).toEqual([]);
    expect(posted[0]!.rows.every((r) => r.text === undefined)).toBe(true);
  });
});

describe("reconciler — pass 1: the foreground runs ride every apply; a failed read is asked again", () => {
  it("on: foregroundRunIds rides the apply (Convex names them again while over)", async () => {
    const posted: TranscriptApply[] = [];
    const shadow = new TranscriptShadow({
      chatId: "chat1",
      sessionKey: SK,
      readHistory: async () => ({ sessionKey: SK, sessionId: "s1", messages: [], sessionInfo: {} }),
      apply: async (p) => {
        posted.push(p);
      },
      foregroundRunIds: () => ["run-a", "run-b"],
      sleep: async () => {},
      log: () => {},
    });
    shadow.configure({ mode: "on" });
    await shadow.idle();
    expect(posted[0]!.foregroundRunIds).toEqual(["run-a", "run-b"]);
  });

  it("on: a read whose apply fails is asked again, a bounded number of times", async () => {
    let reads = 0;
    let fail = 2;
    const waits: number[] = [];
    const shadow = new TranscriptShadow({
      chatId: "chat1",
      sessionKey: SK,
      readHistory: async () => {
        reads++;
        return { sessionKey: SK, sessionId: "s1", messages: [], sessionInfo: {} };
      },
      apply: async () => {
        if (fail-- > 0) throw new Error("response lost");
        return { settledRuns: ["run-a"] };
      },
      sleep: async (ms) => {
        waits.push(ms);
      },
      log: () => {},
    });
    shadow.configure({ mode: "on" });
    for (let i = 0; i < 20 && reads < 3; i++) await new Promise((r) => setTimeout(r, 0));
    await shadow.idle();
    expect(reads).toBe(3);
    expect(waits.slice(0, 2)).toEqual([1_000, 5_000]);
  });

  it("on: the re-read stops after its bound", async () => {
    let reads = 0;
    const shadow = new TranscriptShadow({
      chatId: "chat1",
      sessionKey: SK,
      readHistory: async () => {
        reads++;
        throw new Error("gateway down");
      },
      apply: async () => {},
      // A real macrotask per wait: an unbounded re-read must not starve the test's clock.
      sleep: () => new Promise((r) => setTimeout(r, 0)),
      log: () => {},
    });
    shadow.configure({ mode: "on" });
    for (let i = 0; i < 60; i++) await new Promise((r) => setTimeout(r, 0));
    // Not awaiting idle: an unbounded re-read would never let it resolve.
    expect(reads).toBe(4);
    shadow.close();
  });

  it("shadow: a failed read is not retried (unchanged)", async () => {
    let reads = 0;
    const shadow = new TranscriptShadow({
      chatId: "chat1",
      sessionKey: SK,
      readHistory: async () => {
        reads++;
        throw new Error("gateway down");
      },
      apply: async () => {},
      foregroundRunIds: () => ["run-a"],
      sleep: async () => {},
      log: () => {},
    });
    shadow.configure({ mode: "shadow" });
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    await shadow.idle();
    expect(reads).toBe(1);
  });
});

describe("row reader — pass 2: a cut active-run list is unknown, never complete", () => {
  it("51 active runs: reported as unknown (null), 50 kept as is", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `r${i}`);
    const many = parseHistoryReply({ sessionKey: SK, messages: [], sessionInfo: { hasActiveRun: true, activeRunIds: ids(51) } })!;
    expect(many.activeRunIds).toBeNull();
    const fifty = parseHistoryReply({ sessionKey: SK, messages: [], sessionInfo: { hasActiveRun: true, activeRunIds: ids(50) } })!;
    expect(fifty.activeRunIds).toHaveLength(50);
  });
});
