/**
 * A fork's (or a routed switch's) first turn that carries an inline attachment must
 * still carry the conversation — on a gateway that can take both.
 *
 * Production (agent fabien, two `routing.rehydrate_missed`): the bridge shipped every
 * inline-attachment turn bare, because up to 2026.6.11 the gateway's regex base64
 * check overflowed the stack on history + file. Convex then consumed the fork's
 * one-shot flag at the ACK, so the fork never got its history. From 2026.7.1 the
 * check is a linear scan, and the combination is proven live on 2026.9.6 (bench run
 * probe-rehydrate-attachment-20261001T031258Z: history up to 62.6K chars beside a
 * 4.18 MB PDF, the agent quoting a canary planted in the history).
 *
 * The history then shares the frame with the base64: it is sized in the bytes it
 * takes ON the frame, never past `maxPayload`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { performSend } from "../src/server.js";
import { SessionRegistry } from "../src/session.js";
import type { BridgeConfig } from "../src/config.js";
import type {
  ConvexWriter,
  RehydrateTraceArgs,
  RehydrationRequest,
} from "../src/convex-writer.js";
import { FRAME_ENVELOPE_OVERHEAD_BYTES } from "../src/core/attachment-limits.js";
import { historyCharsThatFit } from "../src/core/context-budget.js";
import { FrameTooLargeError } from "../src/core/frame-size.js";
import { chatSendFrameBytes } from "../src/providers/openclaw/chat-send.js";
import { classifyGatewayError, faultDomain } from "../src/core/dispatch-errors.js";
import { OpenClawConnection } from "../src/providers/openclaw/openclaw-client.js";
import { fakeGateway } from "./helpers/fake-gateway.js";
import { servedMap } from "./helpers/served.js";
import { sleep } from "./helpers/sleep.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const MAX_PAYLOAD = 25 * 1024 * 1024; // the gateway's announced policy.maxPayload
const config = {
  openclawGatewayUrl: "ws://127.0.0.1:1",
  openclawToken: "t",
  deviceIdentity: { id: "i", publicKey: "p", privateKey: "k" },
  instanceName: "a",
} as unknown as BridgeConfig;
const ROUTING = {
  chatId: "fork-1",
  openclawChatId: null,
  agentId: "fabien",
  canonical: "olivier",
  instanceName: "a",
};
// A fork's first dispatch: no `rehydration` force, only the re-key signal Convex
// emits while `forkPendingRehydration` is set (getChatRouting).
const forkBody = (attachments: unknown[], text = "résume ce fichier") =>
  ({
    ...ROUTING,
    text,
    clientMessageId: "cm-1",
    messageId: "um-1",
    providerResetCount: null,
    outboxId: "ob-1",
    dispatchAgeMs: 0,
    switchedFromAgentId: null,
    switchedFromInstanceName: null,
    sessionSettings: null,
    attachments,
    referenceAttachments: [],
    config: { routedSwitch: true },
  }) as unknown as Parameters<typeof performSend>[1];

const PDF = {
  // 4.18 MB raw, as in the bench probe → ~5.6 MB of base64.
  content: "A".repeat(4 * Math.ceil(4_180_000 / 3)),
  mimeType: "application/pdf",
  fileName: "rapport.pdf",
};

/** The composer as Convex runs it (stream.ts getRehydrationContext): a `maxChars`
 *  ceiling cuts the history, and below MIN_REHYDRATION_CHARS (500) it sends nothing. */
const MIN_REHYDRATION_CHARS = 500;
const composer =
  (full: string, turns: number, cut = 5) =>
  (req: RehydrationRequest) =>
    req.maxChars === undefined
      ? { history: full, turnCount: turns }
      : req.maxChars < MIN_REHYDRATION_CHARS
        ? { history: null, turnCount: 0 }
        : { history: full.slice(0, req.maxChars), turnCount: cut };

function harness(opts: {
  gatewayVersion: string | null;
  maxPayload: number | null;
  answer: (req: RehydrationRequest) => { history: string | null; turnCount: number };
  contextTokens?: number;
}) {
  // The fork's session: the gateway auto-created its row (systemSent truthy) in the
  // pre-describe patch — fresh only through firstSendPending + routedSwitch.
  const gw = fakeGateway({
    describe: [{ sessionId: "s", systemSent: true, contextTokens: opts.contextTokens ?? 400_000 }],
  });
  (gw as { maxPayload: number | null }).maxPayload = opts.maxPayload;
  (gw as unknown as { gatewayVersion: string | null }).gatewayVersion =
    opts.gatewayVersion;
  vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => gw as never);
  const asked: RehydrationRequest[] = [];
  const traces: RehydrateTraceArgs[] = [];
  const w = {
    startAssistant: async () => "msg-1",
    appendDelta: async () => {},
    setSnapshot: async () => true,
    addToolPart: async () => {},
    addMedia: async () => {},
    finalize: async () => {},
    reportSessionMeta: async () => {},
    recordGatewayPressure: async () => {},
    clearSessionState: async () => {},
    getRehydrationContext: async (
      _c: string,
      _m: string | null,
      req: RehydrationRequest = {},
    ) => {
      asked.push(req);
      return opts.answer(req);
    },
    emitRehydrateTrace: (t: RehydrateTraceArgs) => {
      traces.push(t);
    },
  } as unknown as ConvexWriter;
  return { gw, w, asked, traces };
}

async function send(
  h: ReturnType<typeof harness>,
  body: Parameters<typeof performSend>[1],
) {
  const reg = new SessionRegistry(servedMap(config, h.w), () => 1000);
  const session = await reg.acquire(ROUTING);
  await sleep(5);
  await performSend(session, body, h.w, null, null, null, Date.now(), config).catch(
    () => {},
  );
  return h.gw.calls.find(([m]) => m === "chat.send")?.[1] as
    | { message?: string; attachments?: unknown }
    | undefined;
}

const frameBytes = (params: Record<string, unknown>) =>
  Buffer.byteLength(JSON.stringify({ type: "req", id: "x", method: "chat.send", params }), "utf8");

describe("fork first turn with an inline attachment", () => {
  const HISTORY = "[Olivier] le code est PELICAN-7342\n[fabien] noté";

  it("on 2026.9.6: the history rides WITH the file, the file intact, trace rehydrate>0", async () => {
    const h = harness({
      gatewayVersion: "2026.9.6",
      maxPayload: MAX_PAYLOAD,
      answer: () => ({ history: HISTORY, turnCount: 2 }),
    });
    const sent = await send(h, forkBody([PDF]));
    expect(sent?.message).toBe(`${HISTORY}\n\nrésume ce fichier`);
    expect(sent?.attachments).toEqual([PDF]);
    expect(h.traces).toHaveLength(1);
    expect(h.traces[0]).toMatchObject({
      decision: "rehydrate",
      freshSession: true,
      routedSwitch: true,
      prependedTurns: 2,
    });
    expect(h.traces[0]?.historyWithheld).toBeUndefined();
  });

  it("on 2026.7.1 (the first linear-scan generation): history rides", async () => {
    const h = harness({
      gatewayVersion: "2026.7.1",
      maxPayload: MAX_PAYLOAD,
      answer: () => ({ history: HISTORY, turnCount: 2 }),
    });
    const sent = await send(h, forkBody([PDF]));
    expect(sent?.message).toBe(`${HISTORY}\n\nrésume ce fichier`);
  });

  it("on 2026.6.11 (regex base64 check): bare text, history never asked, skip_attachment", async () => {
    const h = harness({
      gatewayVersion: "2026.6.11",
      maxPayload: MAX_PAYLOAD,
      answer: () => ({ history: HISTORY, turnCount: 2 }),
    });
    const sent = await send(h, forkBody([PDF]));
    expect(sent?.message).toBe("résume ce fichier");
    expect(sent?.attachments).toEqual([PDF]);
    expect(h.asked).toEqual([]);
    expect(h.traces[0]).toMatchObject({ decision: "skip_attachment", prependedTurns: 0 });
  });

  it("on an UNIDENTIFIED gateway (no version): fail closed, bare text", async () => {
    const h = harness({
      gatewayVersion: null,
      maxPayload: MAX_PAYLOAD,
      answer: () => ({ history: HISTORY, turnCount: 2 }),
    });
    const sent = await send(h, forkBody([PDF]));
    expect(sent?.message).toBe("résume ce fichier");
    expect(h.traces[0]?.decision).toBe("skip_attachment");
  });
});

describe("the frame guard with history beside the base64", () => {
  // A file near the advertised cap: only ~40 KB of room left beyond the envelope.
  const NEAR_CAP_ROOM = 40_000;
  const nearCap = {
    content: "B".repeat(
      Math.floor((MAX_PAYLOAD - FRAME_ENVELOPE_OVERHEAD_BYTES - NEAR_CAP_ROOM) / 4) * 4,
    ),
    mimeType: "image/png",
    fileName: "scan.png",
  };
  // 30K characters that each cost 3 UTF-8 bytes, plus quotes and newlines that the
  // JSON escaping doubles: ~100 KB on the frame, far over the room in characters.
  const MULTIBYTE = `${"é€\"\n".repeat(7_500)}`;

  it("re-asks within what the frame leaves; the frame never exceeds maxPayload", async () => {
    const h = harness({
      gatewayVersion: "2026.9.6",
      maxPayload: MAX_PAYLOAD,
      answer: composer(MULTIBYTE, 40),
    });
    const text = "lis ce scan";
    const sent = await send(h, forkBody([nearCap], text));
    expect(h.asked).toHaveLength(2);
    expect(h.asked[1]?.maxChars).toBeGreaterThan(0);
    expect(h.asked[1]?.maxChars).toBeLessThanOrEqual(Math.floor(NEAR_CAP_ROOM / 6));
    expect(sent?.message?.endsWith(`\n\n${text}`)).toBe(true);
    expect(sent!.message!.length).toBeGreaterThan(text.length + 2); // history rode
    expect(frameBytes(sent as Record<string, unknown>)).toBeLessThanOrEqual(MAX_PAYLOAD);
    expect(h.traces[0]).toMatchObject({ decision: "rehydrate", prependedTurns: 5 });
  });

  it("the re-ask within the frame comes back EMPTY (below the composer's floor): bare, withheld=frame", async () => {
    // Only ~2 KB beyond the envelope: the ceiling (~330 characters) is under the
    // composer's 500-character floor, so the honest composer answers nothing.
    const tight = {
      ...nearCap,
      content: "B".repeat(
        Math.floor((MAX_PAYLOAD - FRAME_ENVELOPE_OVERHEAD_BYTES - 2_000) / 4) * 4,
      ),
    };
    const h = harness({
      gatewayVersion: "2026.9.6",
      maxPayload: MAX_PAYLOAD,
      answer: composer(MULTIBYTE, 40),
    });
    const sent = await send(h, forkBody([tight], "lis ce scan"));
    expect(h.asked).toHaveLength(2);
    expect(h.asked[1]?.maxChars).toBeLessThan(MIN_REHYDRATION_CHARS);
    expect(sent?.message).toBe("lis ce scan");
    expect(h.traces).toHaveLength(1);
    expect(h.traces[0]).toMatchObject({
      decision: "rehydrate",
      prependedTurns: 0,
      historyWithheld: "frame",
    });
  });

  it("a composer that does NOT honour the ceiling still never puts the frame over: bare, withheld=frame", async () => {
    const h = harness({
      gatewayVersion: "2026.9.6",
      maxPayload: MAX_PAYLOAD,
      // The second measure, not the ceiling, is the proof.
      answer: () => ({ history: MULTIBYTE, turnCount: 40 }),
    });
    const sent = await send(h, forkBody([nearCap], "lis ce scan"));
    expect(sent?.message).toBe("lis ce scan");
    expect(sent?.attachments).toEqual([nearCap]);
    expect(frameBytes(sent as Record<string, unknown>)).toBeLessThanOrEqual(MAX_PAYLOAD);
    expect(h.traces[0]).toMatchObject({
      decision: "rehydrate",
      prependedTurns: 0,
      historyWithheld: "frame",
    });
  });

  it("an UNKNOWN maxPayload proves no room: bare, withheld=frame", async () => {
    const h = harness({
      gatewayVersion: "2026.9.6",
      maxPayload: null,
      answer: () => ({ history: "court", turnCount: 1 }),
    });
    const sent = await send(h, forkBody([PDF]));
    expect(sent?.message).toBe("résume ce fichier");
    expect(h.traces[0]?.historyWithheld).toBe("frame");
  });

  it("a text-only fork turn is NOT sized against the frame (no attachment, no constraint)", async () => {
    const h = harness({
      gatewayVersion: "2026.9.6",
      maxPayload: null,
      answer: () => ({ history: "court", turnCount: 1 }),
    });
    const sent = await send(h, forkBody([]));
    expect(sent?.message).toBe("court\n\nrésume ce fichier");
  });
});

describe("the FINAL frame: what is appended after the history was sized", () => {
  // A file leaving 40 KB beyond the 128 KiB envelope, and a pasted text LONGER than
  // the envelope assumes (~150 KB of UTF-8): bare, the frame fits; with ~30 KB of
  // history it would not. The room check alone lets the history through.
  const ROOM = 40_000;
  const file = {
    content: "C".repeat(Math.floor((MAX_PAYLOAD - FRAME_ENVELOPE_OVERHEAD_BYTES - ROOM) / 4) * 4),
    mimeType: "image/png",
    fileName: "scan.png",
  };
  const LONG_TEXT = "é€".repeat(30_000); // 60 000 characters, 150 000 bytes
  const HISTORY = "h".repeat(30_000);

  it("the history is WITHDRAWN, the user's text and the file go out intact, frame <= maxPayload", async () => {
    const h = harness({
      gatewayVersion: "2026.9.6",
      maxPayload: MAX_PAYLOAD,
      answer: composer(HISTORY, 12),
    });
    const sent = await send(h, forkBody([file], LONG_TEXT));
    expect(sent?.message).toBe(LONG_TEXT);
    expect(sent?.attachments).toEqual([file]);
    expect(frameBytes(sent as Record<string, unknown>)).toBeLessThanOrEqual(MAX_PAYLOAD);
    expect(h.traces).toHaveLength(1);
    expect(h.traces[0]).toMatchObject({
      decision: "rehydrate",
      prependedTurns: 0,
      historyWithheld: "frame",
    });
  });

  it("the same history beside a SHORT text still rides (the check only bites on overflow)", async () => {
    const h = harness({
      gatewayVersion: "2026.9.6",
      maxPayload: MAX_PAYLOAD,
      answer: composer(HISTORY, 12),
    });
    const sent = await send(h, forkBody([file], "lis ce scan"));
    expect(sent?.message).toBe(`${HISTORY}\n\nlis ce scan`);
    expect(frameBytes(sent as Record<string, unknown>)).toBeLessThanOrEqual(MAX_PAYLOAD);
    expect(h.traces).toHaveLength(1);
    expect(h.traces[0]).toMatchObject({ prependedTurns: 12 });
    expect(h.traces[0]?.historyWithheld).toBeUndefined();
  });
});

describe("the WINDOW re-ask that comes back empty", () => {
  it("history the first answer had, gone after the window re-ask: withheld=window", async () => {
    // A window so narrow that the room left for history is under the composer's floor.
    let windowTokens = 0;
    for (let w = 100; w < 5_000; w += 10) {
      const room = historyCharsThatFit({ userChars: "et toi ?".length, separatorChars: 2, windowTokens: w });
      if (room !== null && room > 0 && room < MIN_REHYDRATION_CHARS) {
        windowTokens = w;
        break;
      }
    }
    expect(windowTokens).toBeGreaterThan(0);
    const h = harness({
      gatewayVersion: "2026.9.6",
      maxPayload: MAX_PAYLOAD,
      contextTokens: windowTokens,
      answer: composer("H".repeat(5_000), 9),
    });
    const sent = await send(h, forkBody([], "et toi ?"));
    expect(h.asked).toHaveLength(2);
    expect(sent?.message).toBe("et toi ?");
    expect(h.traces[0]).toMatchObject({
      decision: "rehydrate",
      prependedTurns: 0,
      historyWithheld: "window",
    });
  });
});

describe("EVERY send's frame is measured as it goes on the wire", () => {
  const ROOM = 40_000;
  const file = {
    content: "D".repeat(Math.floor((MAX_PAYLOAD - FRAME_ENVELOPE_OVERHEAD_BYTES - ROOM) / 4) * 4),
    mimeType: "image/png",
    fileName: "scan.png",
  };
  // ~200 KiB of pasted text: the composer and Convex bound the FILE, nothing bounds this.
  const PASTED = "é€ ".repeat(36_000); // 216 000 bytes of UTF-8

  async function sendRaw(h: ReturnType<typeof harness>, body: Parameters<typeof performSend>[1]) {
    const reg = new SessionRegistry(servedMap(config, h.w), () => 1000);
    const session = await reg.acquire(ROUTING);
    await sleep(5);
    return performSend(session, body, h.w, null, null, null, Date.now(), config).then(
      () => null,
      (e: unknown) => e,
    );
  }

  it("a file at the cap plus a long pasted text overflows EVEN BARE: refused by name, nothing sent", async () => {
    const h = harness({
      gatewayVersion: "2026.9.6",
      maxPayload: MAX_PAYLOAD,
      answer: () => ({ history: null, turnCount: 0 }),
    });
    const err = await sendRaw(h, forkBody([file], PASTED));
    expect(err).toBeInstanceOf(FrameTooLargeError);
    expect(classifyGatewayError(err)).toBe("message_too_large");
    expect(faultDomain("message_too_large")).toBe("local");
    expect(h.gw.countOf("chat.send")).toBe(0);
  });

  it("a text-only send over the frame is refused too (the check is not tied to attachments)", async () => {
    const h = harness({
      gatewayVersion: "2026.9.6",
      maxPayload: 64 * 1024,
      answer: () => ({ history: null, turnCount: 0 }),
    });
    const err = await sendRaw(h, forkBody([], PASTED));
    expect(err).toBeInstanceOf(FrameTooLargeError);
    expect(h.gw.countOf("chat.send")).toBe(0);
  });

  it("the same file with a normal text goes out unchanged", async () => {
    const h = harness({
      gatewayVersion: "2026.9.6",
      maxPayload: MAX_PAYLOAD,
      answer: () => ({ history: null, turnCount: 0 }),
    });
    const err = await sendRaw(h, forkBody([file], "lis ce scan"));
    expect(err).toBeNull();
    const sent = h.gw.calls.find(([m]) => m === "chat.send")?.[1] as Record<string, unknown>;
    expect(sent.message).toBe("lis ce scan");
    expect(sent.attachments).toEqual([file]);
    expect(frameBytes(sent)).toBeLessThanOrEqual(MAX_PAYLOAD);
  });

  it("the measure is EXACT: the bytes the client serializes, escaping and multibyte included", () => {
    const params = {
      sessionKey: "agent:a:x",
      message: `${PASTED}"\n\\`,
      idempotencyKey: "webchat-1",
      attachments: [
        { type: "file", mimeType: "image/png", fileName: "é.png", content: "QUJD" },
        { type: "file", mimeType: "text/plain", fileName: "t.txt", content: "not base64 — é\"\n" },
      ],
    };
    const wire = JSON.stringify({
      type: "req",
      id: "a1b2c3d4-0000-4000-8000-000000000000",
      method: "chat.send",
      params,
    });
    expect(chatSendFrameBytes(params)).toBe(Buffer.byteLength(wire, "utf8"));
  });
});
