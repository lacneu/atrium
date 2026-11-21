/**
 * LIVE TEXT — which frame holds the whole bubble, and which one may shorten it.
 *
 * The gateway publishes a run's visible text twice (v2026.9.36, unchanged since 2026.9.1):
 *
 *  - on `agent` / `assistant`, cumulative PER ITEM — one item per assistant message, a new
 *    `itemId` restarts the text (src/agents/embedded-agent-subscribe.reply-delivery.ts
 *    `emitAssistantStreamData`, src/gateway/server-chat-live-text.ts
 *    `prepareAgentWirePayload`);
 *  - on `chat` deltas, as the WHOLE live text of the run: the items joined by the gateway
 *    itself (src/gateway/agent-event-assistant-text.ts `mergeAssistantText`), carried in
 *    `message`. The Control UI never receives the first form (it declares
 *    `chat-only-assistant-text`, ui/src/api/gateway-connect-plan.ts) and assigns the second
 *    one as is (ui/src/pages/chat/chat-gateway.ts, `state.chatStream = next`).
 *
 * So a later item's `assistant` text is not the bubble (F1), and a `chat` delta the
 * gateway marks `replace` is a rewrite that may be shorter than what it replaces (N4).
 * Each scenario replays frames captured on the bench — the golden corpus, or
 * fixtures/live-text-frames.json — against a writer that enforces Convex's
 * anti-regression guard (convex/stream.ts `setSnapshot`): a shrink is refused unless the
 * write declares it. The frames built by hand say so.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { SnapshotSource } from "../src/core/snapshot-source.js";
import {
  LiveTextBaselines,
  mergeChatStreamMessage,
} from "../src/providers/openclaw/live-text-baseline.js";
import { Normalizer, type BridgeEvent } from "../src/providers/openclaw/normalizer.js";
import { liveStableLength, sanitizeText } from "../src/providers/openclaw/sanitize.js";
import type { GatewayFrame } from "../src/providers/openclaw/openclaw-client.js";
import {
  loadCorpus,
  replay,
  RecordingWriter,
  type Fixture,
} from "./helpers/golden-corpus.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface CapturedTurn {
  gatewayVersion: string;
  sessionKey: string;
  runId: string;
  frames: GatewayFrame[];
}
const CAPTURED = JSON.parse(
  readFileSync(resolve(__dirname, "./fixtures/live-text-frames.json"), "utf-8"),
) as Record<
  "chatReplace" | "commandThenAnswer" | "replaceableRestart" | "undeclaredRewrite" | "pathCompletes",
  CapturedTurn
>;

/** A captured turn in the shape the golden replay driver takes (no ack frame: the turn
 *  opens on its run before the first frame, on a synthetic 10 ms clock). */
function asFixture(name: string, turn: CapturedTurn): Fixture {
  return {
    version: turn.gatewayVersion,
    file: `${name}.json`,
    header: {
      corpus: "bench-capture",
      promoter: 0,
      scenario: name,
      gatewayVersion: turn.gatewayVersion,
      bodySha256: "",
      frames: turn.frames.length,
      sessionKey: turn.sessionKey,
      ackRunIds: [turn.runId],
    },
    entries: turn.frames.map((frame) => ({ receivedAt: null, frame })),
  };
}

function golden(version: string, scenario: string): Fixture {
  const fx = loadCorpus().find(
    (f) => f.version === version && f.header.scenario === scenario,
  );
  if (fx === undefined) throw new Error(`no golden fixture ${version}/${scenario}`);
  return fx;
}

interface Refusal {
  oldLen: number;
  newLen: number;
  source: SnapshotSource | undefined;
}

/** The writer, with Convex's guard: the text each bubble holds, and every write the
 *  guard would have refused (`replace !== true && text.length < held.length`). */
class GuardedWriter extends RecordingWriter {
  readonly text = new Map<string, string>();
  readonly refused: Refusal[] = [];
  readonly declaredShrinks: Refusal[] = [];
  /** Every text a bubble was given, in order. */
  readonly history: string[] = [];
  /** The bubble opened last — the one the run in flight writes to. */
  current: string | null = null;

  override async startAssistant(chatId: string, runId: string | null): Promise<string> {
    const id = await super.startAssistant(chatId, runId);
    this.text.set(id, "");
    this.current = id;
    return id;
  }
  override async appendDelta(messageId: string, text: string): Promise<void> {
    await super.appendDelta(messageId, text);
    this.text.set(messageId, (this.text.get(messageId) ?? "") + text);
  }
  override async setSnapshot(
    messageId: string,
    text: string,
    replace?: boolean,
    source?: SnapshotSource,
  ): Promise<boolean> {
    const held = this.text.get(messageId) ?? "";
    if (text.length < held.length) {
      const shrink = { oldLen: held.length, newLen: text.length, source };
      if (replace !== true) {
        this.refused.push(shrink);
        return false;
      }
      this.declaredShrinks.push(shrink);
    }
    this.text.set(messageId, text);
    this.history.push(text);
    return super.setSnapshot(messageId, text);
  }
  get shown(): string {
    return this.current === null ? "" : (this.text.get(this.current) ?? "");
  }
}

function messageText(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content
    .filter((b): b is { type: "text"; text?: string } => b?.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

/** Replay a turn and, after each `chat` delta of the conversation's own session, compare
 *  the bubble with the Control UI's live text for the same frames: the delta's `message`,
 *  rebuilt per run when the wire dropped it (packages/gateway-client/src/
 *  chat-stream-projection.ts `GatewayChatStreamProjection`). */
async function replayAgainstControlUi(
  fx: Fixture,
): Promise<{ writer: GuardedWriter; compared: number; differing: string[] }> {
  const writer = new GuardedWriter();
  const baselines = new Map<string, unknown>();
  const differing: string[] = [];
  let compared = 0;
  await replay(fx, writer, (frame, index) => {
    if (frame.type !== "event" || frame.event !== "chat") return;
    const payload = frame.payload as Record<string, unknown>;
    if (payload.sessionKey !== fx.header.sessionKey || payload.state !== "delta") return;
    const runId = String(payload.runId);
    const message = mergeChatStreamMessage(baselines.get(runId), payload);
    if (message === undefined) return;
    baselines.set(runId, message);
    const controlUi = messageText(message);
    if (controlUi === undefined) return;
    compared++;
    if (writer.shown !== controlUi) {
      differing.push(
        `frame ${index}: Control UI ${controlUi.length} chars, Atrium ${writer.shown.length}`,
      );
    }
  });
  return { writer, compared, differing };
}

describe("F1 — a later item's assistant text is not the bubble", () => {
  // Golden 2026.9.36 spawn-chain-merge: the announce run writes a 55-character item, calls
  // a tool, then a second item `CHAIN_DONE`; the chat delta that follows carries
  // `\n\nCHAIN_DONE` appended to the first.
  it("captured: the second item is never written as a shorter bubble", async () => {
    const { writer, compared, differing } = await replayAgainstControlUi(
      golden("2026.9.36", "spawn-chain-merge"),
    );
    expect(writer.refused).toEqual([]);
    expect(writer.declaredShrinks).toEqual([]);
    expect(compared).toBeGreaterThan(0);
    expect(differing).toEqual([]);
  });

  it("captured: the same reading holds on every validated version of that scenario", async () => {
    const versions = loadCorpus().filter((f) => f.header.scenario === "spawn-chain-merge");
    expect(versions.length).toBeGreaterThan(1);
    for (const fx of versions) {
      const { writer, differing } = await replayAgainstControlUi(fx);
      expect(writer.refused, fx.version).toEqual([]);
      expect(differing, fx.version).toEqual([]);
    }
  });

  const SK = "agent:main:atrium:chat:u-1:c-1";
  const RUN = "webchat-run-1";
  function turn(): { n: Normalizer; at: () => number } {
    const n = new Normalizer(SK, null);
    let now = 1000;
    n.beginTurn(now);
    n.noteRunStarted(RUN, now);
    return { n, at: () => (now += 0.01) };
  }
  // Hand-built, in the captured shape (`text` + `delta` + `phase` + `itemId`).
  const assistant = (data: Record<string, unknown>, runId = RUN) => ({
    event: "agent",
    payload: { sessionKey: SK, runId, stream: "assistant", data: { phase: "final_answer", ...data } },
  });
  const chatDelta = (text: string, extra: Record<string, unknown> = {}, runId = RUN) => ({
    event: "chat",
    payload: {
      sessionKey: SK,
      runId,
      state: "delta",
      deltaText: text,
      message: { role: "assistant", content: [{ type: "text", text }] },
      ...extra,
    },
  });
  const snapshots = (events: BridgeEvent[]) =>
    events
      .filter((e) => e.type === "message.snapshot")
      .map((e) => ({
        text: e.text,
        ...(e.replace === true ? { replace: true } : {}),
        source: e.snapshotSource,
      }));

  it("hand-built: no assistant frame writes the bubble — first item, later item, replace, no item", () => {
    const { n, at } = turn();
    const ev = [
      ...n.feed(assistant({ text: "Ok.", delta: "Ok.", itemId: "s:1" }), at()),
      ...n.feed(assistant({ text: "Here is the full answer.", delta: "Here is the full answer.", itemId: "s:2" }), at()),
      ...n.feed(assistant({ text: "X", delta: "", replace: true, itemId: "s:2" }), at()),
      ...n.feed(assistant({ text: "Hi", replace: true, replaceable: true, itemId: "s:assistant" }), at()),
      ...n.feed(assistant({ text: "Hello again" }), at()),
      ...n.feed(assistant({ delta: " and a legacy delta" }), at()),
    ];
    expect(snapshots(ev)).toEqual([]);
    expect(ev.filter((e) => e.type === "message.delta")).toEqual([]);
    expect(n.text).toBe("");
    const whole = n.feed(chatDelta("Ok.\n\nHere is the full answer."), at());
    expect(snapshots(whole)).toEqual([
      { text: "Ok.\n\nHere is the full answer.", source: "chat_delta" },
    ]);
  });

  // The `chat` text is PROJECTED for display: the gateway removes its internal runtime
  // context from it (src/gateway/live-chat-projector.ts `stripInternalRuntimeContext`;
  // upstream's own test: server-chat.agent-events.test.ts). The assistant stream is raw.
  // Hand-built in the reviewer's sequence; at 42593d9e the third frame was written as is.
  it("hand-built: text the gateway keeps out of the chat stream never reaches the bubble", () => {
    const { n, at } = turn();
    const secret = "Visible\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nprivate runtime detail";
    const ev = [
      ...n.feed(assistant({ text: "Visible", itemId: "s:1" }), at()),
      ...n.feed(chatDelta("Visible"), at()),
      ...n.feed(assistant({ text: secret, itemId: "s:1" }), at()),
      ...n.feed(assistant({ text: secret + ", extended", itemId: "s:1" }), at()),
      ...n.feed({ event: "chat", payload: { sessionKey: SK, runId: RUN, state: "final" } }, at()),
    ];
    expect(JSON.stringify(ev.filter((e) => e.type !== "openclaw.frame"))).not.toContain("INTERNAL_CONTEXT");
    expect(ev.find((e) => e.type === "message.final")?.text).toBe("Visible");
  });

  it("hand-built: with one producer, no assistant frame can be erased, displayed over another, or lost at the final", () => {
    // The reviewer's sequences: an assistant extension (seq 25) then a stale `replace` copy
    // (chat seq 20); an older cumulative copy (seq 20) after a newer one (seq 25).
    const { n, at } = turn();
    const A = (text: string, seq: number) => ({
      event: "agent",
      payload: { sessionKey: SK, runId: RUN, seq, stream: "assistant", data: { phase: "final_answer", text, itemId: "s:1" } },
    });
    const C = (text: string, seq: number, extra: Record<string, unknown> = {}) =>
      chatDelta(text, { seq, ...extra });
    n.feed(C("The answer so far", 22), at());
    n.feed(A("The answer so far, and more", 25), at());
    n.feed(A("The answer", 20), at());
    expect(n.text).toBe("The answer so far");
    const stale = n.feed(C("The", 20, { replace: true }), at());
    expect(snapshots(stale)).toEqual([]); // behind the text shown: not even written
    const staleOther = n.feed(C("Else", 20, { replace: true }), at());
    expect(snapshots(staleOther)).toEqual([{ text: "Else", source: "chat_delta_replace" }]); // undeclared
    expect(n.text).toBe("The answer so far");
    const final = n.feed({ event: "chat", payload: { sessionKey: SK, runId: RUN, seq: 30, state: "final" } }, at());
    expect(final.find((e) => e.type === "message.final")?.text).toBe("The answer so far");
  });


  // Captured on the codex harness (2026.9.33): the turn's last assistant frame is such a
  // replacement, after the chat stream wrote the same text.
  it("captured: a turn ending on a `replaceable` replacement", async () => {
    const { writer } = await replayAgainstControlUi(
      asFixture("replaceableRestart", CAPTURED.replaceableRestart),
    );
    // The reply ends on a `MEDIA:` directive: held back while it streams, dropped at the
    // final, and the line break before it goes with it — the final's one-character shrink.
    expect(writer.refused).toEqual([{ oldLen: 104, newLen: 103, source: "chat_final" }]);
    expect(writer.history.filter((t) => t.includes("MEDIA:"))).toEqual([]);
  });
});

describe("N4 — a `chat` delta marked `replace` may shorten the bubble", () => {
  // 2026.9.36, settle-chain-no-synthesis: six `replace: true` deltas, each carrying
  // `message`; the fifth goes from 950 characters to 8.
  it("captured: every rewrite is written, and the bubble follows the Control UI", async () => {
    const { writer, compared, differing } = await replayAgainstControlUi(
      asFixture("chatReplace", CAPTURED.chatReplace),
    );
    expect(writer.refused).toEqual([]);
    expect(writer.declaredShrinks).toEqual([
      { oldLen: 950, newLen: 8, source: "chat_delta_replace" },
    ]);
    expect(compared).toBe(6);
    expect(differing).toEqual([]);
  });

  it("captured: each of those frames carries BOTH `replace` and `message`", () => {
    const rewrites = CAPTURED.chatReplace.frames
      .filter((f) => f.event === "chat")
      .map((f) => f.payload as Record<string, unknown>)
      .filter((p) => p.state === "delta");
    expect(rewrites).toHaveLength(6);
    for (const p of rewrites) {
      expect(p.replace).toBe(true);
      expect(messageText(p.message)).toBe(p.deltaText);
    }
  });

  const SK = "agent:main:atrium:chat:u-1:c-1";
  const RUN = "webchat-run-1";
  // Hand-built, in the captured shape (`deltaText` + `replace` + `message`).
  const chat = (state: "delta" | "final", text: string, extra: Record<string, unknown> = {}, runId = RUN) => ({
    event: "chat",
    payload: {
      sessionKey: SK,
      runId,
      state,
      ...(state === "delta" ? { deltaText: text } : {}),
      message: { role: "assistant", content: [{ type: "text", text }] },
      ...extra,
    },
  });
  function turn(): { n: Normalizer; at: () => number } {
    const n = new Normalizer(SK, null);
    let now = 1000;
    n.beginTurn(now);
    n.noteRunStarted(RUN, now);
    return { n, at: () => (now += 0.01) };
  }
  const snapshot = (events: BridgeEvent[]) => events.find((e) => e.type === "message.snapshot");

  it("hand-built: the permission rides the snapshot, under the replace producer's name", () => {
    const { n, at } = turn();
    n.feed(chat("delta", "a long first draft", { seq: 1 }), at());
    const ev = n.feed(chat("delta", "short", { seq: 2, replace: true }), at());
    expect(snapshot(ev)).toMatchObject({
      text: "short",
      replace: true,
      snapshotSource: "chat_delta_replace",
    });
  });

  it("hand-built: the stream goes on after a rewrite", () => {
    const { n, at } = turn();
    n.feed(chat("delta", "a long first draft", { seq: 1 }), at());
    n.feed(chat("delta", "short", { seq: 2, replace: true }), at());
    const ev = n.feed(chat("delta", "short and more", { seq: 3 }), at());
    expect(snapshot(ev)).toMatchObject({ text: "short and more", snapshotSource: "chat_delta" });
    expect(snapshot(ev)).not.toHaveProperty("replace");
  });

  it("hand-built: the final is not a rewrite — it never carries the permission", () => {
    const { n, at } = turn();
    n.feed(chat("delta", "a long first draft", { seq: 1 }), at());
    const ev = n.feed(chat("final", "short", { seq: 2, replace: true }), at());
    expect(snapshot(ev)).toMatchObject({ text: "short", snapshotSource: "chat_final" });
    expect(snapshot(ev)).not.toHaveProperty("replace");
  });

  it("hand-built: a run adopted into the turn cannot shorten what another run wrote", () => {
    const { n, at } = turn();
    n.feed(chat("delta", "the answer the reader has", { seq: 1 }), at());
    n.feed(
      {
        event: "agent",
        payload: {
          runId: RUN,
          sessionKey: SK,
          stream: "lifecycle",
          data: { phase: "end", livenessState: "abandoned", replayInvalid: true },
        },
      },
      at(),
    );
    n.feed(chat("delta", "replayed text, first draft", { seq: 1 }, "webchat-replay"), at());
    const ev = n.feed(chat("delta", "rewritten", { seq: 2, replace: true }, "webchat-replay"), at());
    expect(n.ownRunIds.has("webchat-replay")).toBe(true);
    expect(snapshot(ev)).toMatchObject({ text: "rewritten", snapshotSource: "chat_delta_replace" });
    expect(snapshot(ev)).not.toHaveProperty("replace");
  });
});

describe("an in-order chat rewrite the gateway does not mark", () => {
  // After a command snapshot the answer is published as the buffer's FIRST delta
  // (src/gateway/server-chat-state.ts `takeBufferDelta`, `previous === undefined ? text`):
  // a shorter `message`, no `replace`. The Control UI shows it. 2026.9.36, spawn-chain-merge:
  // `replace` deltas up to 1008 characters (envelope seq 207, run seq 18), then the answer,
  // 4 characters (envelope seq 220, run seq 19).
  it("captured 2026.9.36: the answer replaces the command snapshot, and the bubble follows the Control UI", async () => {
    const { writer, compared, differing } = await replayAgainstControlUi(
      asFixture("undeclaredRewrite", CAPTURED.undeclaredRewrite),
    );
    expect(writer.refused).toEqual([]);
    expect(writer.declaredShrinks).toEqual([{ oldLen: 1008, newLen: 4, source: "chat_delta" }]);
    expect(compared).toBe(6);
    expect(differing).toEqual([]);
  });

  it("captured 2026.9.33: the same shape (943 → 2)", async () => {
    const { writer, differing } = await replayAgainstControlUi(
      asFixture("commandThenAnswer", CAPTURED.commandThenAnswer),
    );
    expect(writer.refused).toEqual([]);
    expect(writer.declaredShrinks).toEqual([{ oldLen: 943, newLen: 2, source: "chat_delta" }]);
    expect(differing).toEqual([]);
  });

  // THE GUARD, on the captured frames: the permission exists only for a frame PROVEN to
  // follow the one that wrote the bubble. Each case below replays the 2026.9.36 turn up to
  // the command snapshot, then feeds the captured answer frame with ONE thing changed.
  const turnFrames = CAPTURED.undeclaredRewrite;
  const answerIndex = turnFrames.frames.findIndex((f) => {
    const p = f.payload as Record<string, unknown>;
    return f.event === "chat" && p.state === "delta" && p.replace !== true;
  });
  const answer = turnFrames.frames[answerIndex]! as GatewayFrame & { seq: number };
  const answerPayload = answer.payload as Record<string, unknown> & { seq: number };
  function untilCommandSnapshot(): { n: Normalizer; at: () => number } {
    const n = new Normalizer(turnFrames.sessionKey, null);
    let now = 1000;
    n.beginTurn(now);
    n.noteRunStarted(turnFrames.runId, now);
    const at = () => (now += 0.01);
    for (const f of turnFrames.frames.slice(0, answerIndex)) n.feed(f, at());
    expect(n.text.length).toBe(1008);
    return { n, at };
  }
  const shrinkOf = (events: BridgeEvent[]) => {
    const s = events.find((e) => e.type === "message.snapshot");
    return s === undefined ? "not written" : s.replace === true ? "declared" : "undeclared";
  };

  it("captured: as received, the shrink is declared", () => {
    const { n, at } = untilCommandSnapshot();
    expect(shrinkOf(n.feed(answer, at()))).toBe("declared");
  });

  it("the envelope seq proves nothing: a run can reach the normalizer from two sockets", () => {
    // After a hand-back (speaker-pool.ts) the owner's socket delivers its own copies, on
    // its own envelope counter. A HIGHER envelope seq with an older run seq is such a copy.
    const { n, at } = untilCommandSnapshot();
    const copy = { ...answer, seq: 100_000, payload: { ...answerPayload, seq: 18 } };
    expect(shrinkOf(n.feed(copy, at()))).toBe("undeclared");
    expect(n.text.length).toBe(1008);
  });

  it("an EARLIER place in the run (payload seq not above the writer's) proves nothing", () => {
    const { n, at } = untilCommandSnapshot();
    const stale = { ...answer, payload: { ...answerPayload, seq: 18 } };
    expect(shrinkOf(n.feed(stale, at()))).toBe("undeclared");
  });

  it("the in-flight text re-read after a gap carries no order: undeclared", () => {
    // The shape openclaw-client.ts builds from `chat.history` → `inFlightRun`.
    const { n, at } = untilCommandSnapshot();
    const reread = {
      type: "event",
      event: "chat",
      payload: {
        runId: turnFrames.runId,
        sessionKey: turnFrames.sessionKey,
        state: "delta",
        deltaText: "",
        message: answerPayload.message,
      },
    };
    expect(shrinkOf(n.feed(reread, at()))).toBe("undeclared");
  });

  it("another run's frame is not the writer's sequel: undeclared", () => {
    const { n, at } = untilCommandSnapshot();
    n.noteRunStarted("webchat-other", at());
    const other = { ...answer, payload: { ...answerPayload, runId: "webchat-other" } };
    expect(shrinkOf(n.feed(other, at()))).toBe("undeclared");
  });

  it("the assistant stream never gains the right: after the chat wrote, it does not write", () => {
    const { n, at } = untilCommandSnapshot();
    const item = turnFrames.frames[answerIndex - 1]!;
    expect((item.payload as { stream?: unknown }).stream).toBe("assistant");
    expect(shrinkOf(n.feed({ ...item, seq: answer.seq + 1 }, at()))).toBe("not written");
  });
});

describe("a retraction clears the bubble", () => {
  // Hand-built, in the shape `broadcastChatDelta` gives an emptied buffer
  // (`{deltaText: "", replace: true, message: {content: [{type: "text", text: ""}]}}`):
  // no capture holds one. The Control UI assigns it (`next = extractText(message) ?? ""`).
  const SK = "agent:main:atrium:chat:u-1:c-1";
  const RUN = "webchat-run-1";
  const chat = (text: string, seq: number, extra: Record<string, unknown> = {}, runId = RUN) => ({
    event: "chat",
    seq: 100 + seq,
    payload: {
      sessionKey: SK,
      runId,
      seq,
      state: "delta",
      deltaText: text,
      message: { role: "assistant", content: [{ type: "text", text }] },
      ...extra,
    },
  });
  function turn(): { n: Normalizer; at: () => number } {
    const n = new Normalizer(SK, null);
    let now = 1000;
    n.beginTurn(now);
    n.noteRunStarted(RUN, now);
    return { n, at: () => (now += 0.01) };
  }
  const snaps = (events: BridgeEvent[]) => events.filter((e) => e.type === "message.snapshot");

  it("hand-built: the empty rewrite is written, declared, and the stream goes on", () => {
    const { n, at } = turn();
    n.feed(chat("NO", 1), at());
    expect(snaps(n.feed(chat("", 2, { replace: true }), at()))).toMatchObject([
      { type: "message.snapshot", text: "", replace: true, snapshotSource: "chat_delta_replace" },
    ]);
    expect(n.text).toBe("");
    expect(snaps(n.feed(chat("The answer", 3), at())).map((e) => e.text)).toEqual(["The answer"]);
  });

  it("hand-built: nothing to clear, or no `replace`: nothing is written", () => {
    const { n, at } = turn();
    expect(snaps(n.feed(chat("", 1, { replace: true }), at()))).toEqual([]);
    n.feed(chat("Kept", 2), at());
    expect(snaps(n.feed(chat("", 3), at()))).toEqual([]);
    expect(n.text).toBe("Kept");
  });
});

describe("the bridge's own rewrites never take text back", () => {
  // 2026.9.36, settle-message-tool-codemode: the answer names files under the outbound
  // media directory. Shown as it grew, the directory was printed (text 5555 long), then
  // replaced by the file's name when its first letter arrived (5526): refused twice.
  it("captured: a path that completes is never shown, and no write shortens the bubble", async () => {
    const writer = await replay(asFixture("pathCompletes", CAPTURED.pathCompletes), new GuardedWriter());
    expect(writer.refused).toEqual([]);
    expect(writer.declaredShrinks).toEqual([]);
    expect(writer.history.length).toBeGreaterThan(100);
    // …and the directory of a file is never printed ahead of the file's name.
    expect(writer.history.filter((t) => /\/media\/outbound\/?$/.test(t))).toEqual([]);
    expect(writer.shown.length).toBeGreaterThan(5000);
  });

  it("hand-built: a FINAL text is never cut — its last word is a complete path", () => {
    const SK = "agent:main:atrium:chat:u-1:c-1";
    const n = new Normalizer(SK, null);
    n.beginTurn(1000);
    n.noteRunStarted("webchat-run-1", 1000);
    const text = "Saved to /home/node/.openclaw/media/outbound/a.txt";
    const frame = (state: string) => ({
      event: "chat",
      payload: {
        sessionKey: SK,
        runId: "webchat-run-1",
        state,
        message: { role: "assistant", content: [{ type: "text", text }] },
      },
    });
    const texts = (events: BridgeEvent[]) =>
      events.filter((e) => e.type === "message.snapshot").map((e) => e.text);
    expect(texts(n.feed(frame("delta"), 1000.01))).toEqual(["Saved to "]);
    expect(texts(n.feed(frame("final"), 1000.02))).toEqual(["Saved to a.txt"]);
  });

  it("the stable part of a growing text stops before a path or a directive in progress", () => {
    const grow = (text: string) =>
      Array.from({ length: text.length }, (_, i) => text.slice(0, i + 1)).map((t) =>
        sanitizeText(t.slice(0, liveStableLength(t))),
      );
    for (const text of [
      "Saved to `/home/node/.openclaw/media/outbound/report.pdf` as asked.",
      "Voici :\nMEDIA:/home/node/.openclaw/media/outbound/a.png\nFin.",
      "See (/srv/state/media/outbound/x/y.txt) and https://example.com/a/b for more.",
    ]) {
      const shown = grow(text);
      for (let i = 1; i < shown.length; i++) {
        // At most the line break that preceded a dropped directive is taken back.
        expect(shown[i]!.length, `${text} @${i}`).toBeGreaterThanOrEqual(shown[i - 1]!.length - 1);
        expect(shown[i]).not.toContain("/media/outbound");
      }
      expect(shown.at(-1)).toBe(sanitizeText(text));
    }
    // A URL is not held back: only a word that OPENS with a slash is.
    expect(liveStableLength("see https://example.com/a")).toBe("see https://example.com/a".length);
    expect(liveStableLength("see /tmp/a")).toBe(4);
    expect(liveStableLength("line\nMED")).toBe(5);
  });
});

describe("freshness: nothing at or below the run's applied chat seq shortens the bubble", () => {
  // 2026.9.36 capture `chatReplace`: the command snapshots carry run seq 11, 13, 15, 18
  // (44, 107, 799, 950 characters), all marked `replace`.
  const turnFrames = CAPTURED.chatReplace;
  const replaces = turnFrames.frames.filter((f) => {
    const p = f.payload as Record<string, unknown>;
    return f.event === "chat" && p.state === "delta" && p.replace === true;
  });
  function start(): { n: Normalizer; at: () => number } {
    const n = new Normalizer(turnFrames.sessionKey, null);
    let now = 1000;
    n.beginTurn(now);
    n.noteRunStarted(turnFrames.runId, now);
    return { n, at: () => (now += 0.01) };
  }
  const snap = (events: BridgeEvent[]) => events.find((e) => e.type === "message.snapshot");
  const declared = (events: BridgeEvent[]) => snap(events)?.replace === true;

  it("captured, after a hand-back: the EARLIER `replace` copy from the other socket shortens nothing", () => {
    const { n, at } = start();
    const [first, , , fourth] = replaces as [GatewayFrame, GatewayFrame, GatewayFrame, GatewayFrame];
    expect((first.payload as { seq: number }).seq).toBe(11);
    expect((fourth.payload as { seq: number }).seq).toBe(18);
    n.feed({ ...fourth, seq: 100 }, at());
    expect(n.text.length).toBe(950);
    // Run seq 11, on the other socket's counter (envelope 1001), still marked `replace`.
    // (It is also the START of the text shown: behind, so not even written.)
    expect(snap(n.feed({ ...first, seq: 1001 }, at()))).toBeUndefined();
    expect(n.text.length).toBe(950);
    const second = { ...replaces[1]!, seq: 1002 } as GatewayFrame;
    expect((second.payload as { seq: number }).seq).toBe(13);
    expect(snap(n.feed(second, at()))).toBeDefined();
    expect(declared(n.feed({ ...replaces[1]!, seq: 1003, payload: { ...(replaces[1]!.payload as object), seq: 14 } }, at()))).toBe(false);
    expect(n.text.length).toBe(950);
    // The copy of the frame that wrote the bubble (same run seq) is no fresher.
    const same = { ...fourth, seq: 1004, payload: { ...(fourth.payload as object), deltaText: "x", message: { role: "assistant", content: [{ type: "text", text: "x" }] } } };
    expect(declared(n.feed(same, at()))).toBe(false);
    // …and the next one is: run seq 19.
    const next = { ...same, payload: { ...(same as { payload: object }).payload, seq: 19 } };
    expect(declared(n.feed(next, at()))).toBe(true);
  });

  it("captured: a refused frame moves no reference — seq 18, then 11 (refused), then 13", () => {
    const { n, at } = start();
    const [first, second, , fourth] = replaces as [GatewayFrame, GatewayFrame, GatewayFrame, GatewayFrame];
    const unmarked = (f: GatewayFrame) => {
      const { replace: _replace, ...payload } = f.payload as Record<string, unknown>;
      return { ...f, payload };
    };
    const third = replaces[2]!;
    n.feed(fourth, at());
    // Run seq 13 (107 characters, not the start of the text shown): written, undeclared.
    expect(snap(n.feed(unmarked(second), at()))).toBeDefined();
    expect(declared(n.feed(unmarked(second), at()))).toBe(false);
    // Without the fix that refused frame became the writer, and run seq 15 its sequel.
    expect(declared(n.feed(unmarked(third), at()))).toBe(false);
    expect(n.text.length).toBe(950);
    void first;
  });

  it("hand-built: a `replace` frame that carries no run seq is never fresh", () => {
    const { n, at } = start();
    const SK = turnFrames.sessionKey;
    const message = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
    const noSeq = (text: string, extra: Record<string, unknown> = {}) => ({
      event: "chat",
      payload: { sessionKey: SK, runId: turnFrames.runId, state: "delta", deltaText: text, message: message(text), ...extra },
    });
    n.feed(noSeq("A long first answer"), at());
    expect(declared(n.feed(noSeq("x", { replace: true }), at()))).toBe(false);
    expect(n.text).toBe("A long first answer");
  });

  it("hand-built: a refused frame is not the writer — the next one is not its sequel", () => {
    const { n, at } = start();
    const SK = turnFrames.sessionKey;
    const chat = (runId: string, text: string, seq: number) => ({
      event: "chat",
      payload: { sessionKey: SK, runId, seq, state: "delta", deltaText: text, message: { role: "assistant", content: [{ type: "text", text }] } },
    });
    n.feed(chat(turnFrames.runId, "a".repeat(100), 5), at());
    n.noteRunStarted("webchat-second", at());
    // Another run's text is on screen: this run's shorter one is undeclared (refused)…
    expect(declared(n.feed(chat("webchat-second", "b".repeat(50), 1), at()))).toBe(false);
    // …and does not become the writer its next frame could claim to follow.
    expect(declared(n.feed(chat("webchat-second", "c".repeat(40), 2), at()))).toBe(false);
    expect(n.text.length).toBe(100);
  });

  it("hand-built: the gateway's own `replace` mark needs no writer to follow — only freshness", () => {
    const { n, at } = start();
    const SK = turnFrames.sessionKey;
    const message = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
    // The bubble was written by a frame that carries no order (a re-read).
    n.feed(
      { event: "chat", payload: { sessionKey: SK, runId: turnFrames.runId, state: "delta", deltaText: "", message: message("a long text read back") } },
      at(),
    );
    const marked = {
      event: "chat",
      payload: { sessionKey: SK, runId: turnFrames.runId, seq: 4, state: "delta", deltaText: "short", replace: true, message: message("short") },
    };
    expect(declared(n.feed(marked, at()))).toBe(true);
  });

  it("hand-built: the mark belongs to the turn — a new turn starts from nothing", () => {
    const { n, at } = start();
    const SK = turnFrames.sessionKey;
    const chat = (text: string, seq: number, extra: Record<string, unknown> = {}) => ({
      event: "chat",
      payload: { sessionKey: SK, runId: turnFrames.runId, seq, state: "delta", deltaText: text, message: { role: "assistant", content: [{ type: "text", text }] }, ...extra },
    });
    n.feed(chat("first turn", 50), at());
    n.beginTurn(at());
    n.noteRunStarted(turnFrames.runId, at());
    n.feed(chat("a long text of the new turn", 1), at());
    expect(declared(n.feed(chat("short", 2, { replace: true }), at()))).toBe(true);
  });

  it("hand-built: an empty retraction below the mark clears nothing", () => {
    const { n, at } = start();
    n.feed(replaces[3]!, at());
    const p = replaces[0]!.payload as Record<string, unknown>;
    const stale = {
      ...replaces[0]!,
      payload: { ...p, deltaText: "", message: { role: "assistant", content: [{ type: "text", text: "" }] } },
    };
    expect(snap(n.feed(stale, at()))).toBeUndefined();
    expect(n.text.length).toBe(950);
  });
});

describe("the terminal's own text", () => {
  // Hand-built in the shapes of `emitChatTerminal` (error: `message` beside `errorMessage`
  // when the buffer held text) and `broadcastChatFrame` (aborted: `message`). No capture
  // holds a chat error or an aborted run with text.
  const SK = "agent:main:atrium:chat:u-1:c-1";
  const RUN = "webchat-run-1";
  const message = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
  const delta = (text: string, seq: number, extra: Record<string, unknown> = {}) => ({
    event: "chat",
    payload: { sessionKey: SK, runId: RUN, seq, state: "delta", deltaText: text, message: message(text), ...extra },
  });
  const terminal = (state: "error" | "aborted", text: string | null, seq: number) => ({
    event: "chat",
    payload: {
      sessionKey: SK,
      runId: RUN,
      seq,
      state,
      ...(state === "error" ? { errorMessage: "provider failed" } : {}),
      ...(text === null ? {} : { message: message(text) }),
    },
  });
  function turn(): { n: Normalizer; feed: (f: unknown) => BridgeEvent[] } {
    const n = new Normalizer(SK, null);
    let now = 1000;
    n.beginTurn(now);
    n.noteRunStarted(RUN, now);
    return { n, feed: (f) => n.feed(f, (now += 0.01)) };
  }
  const finalOf = (events: BridgeEvent[]) => events.find((e) => e.type === "message.final")?.text;

  it("an error terminal's text is the bubble's; without one, the bubble keeps what chat last wrote", () => {
    const a = turn();
    a.feed(delta("Half", 1));
    expect(finalOf(a.feed(terminal("error", "Half of the answer", 2)))).toBe("Half of the answer");
    const b = turn();
    b.feed(delta("Half", 1));
    expect(finalOf(b.feed(terminal("error", null, 2)))).toBe("Half");
  });

  it("a `message` that only restates the error is not the answer", () => {
    const { feed } = turn();
    feed(delta("Half", 1));
    expect(finalOf(feed(terminal("error", "⚠️ Error: provider   failed", 2)))).toBe("Half");
  });

  it("an aborted terminal's text is read too", () => {
    const { feed } = turn();
    feed(delta("Half", 1));
    expect(finalOf(feed(terminal("aborted", "Half of the answer", 2)))).toBe("Half of the answer");
  });

  it("a provider-logout abort (`stopReason: auth-revoked`) carries the buffered answer: it is read", () => {
    // `abortChatRunsForProvider` cancels the pending chat flush and puts the buffer on the
    // abort. Hand-built in that shape.
    const { feed } = turn();
    feed(delta("Half", 1));
    const abort = terminal("aborted", "Half of the answer", 3);
    const events = feed({ ...abort, payload: { ...abort.payload, stopReason: "auth-revoked" } });
    expect(finalOf(events)).toBe("Half of the answer");
  });

  it("after a steer split, the terminal's text completes the CURRENT segment", () => {
    // The reviewer's sequence: "First." settled at a cut, the delta for the rest is lost.
    const { n, feed } = turn();
    feed(delta("First.", 1));
    n.splitSegment();
    expect(finalOf(feed(terminal("error", "First.\n\nSecond.", 3)))).toBe("Second.");
  });

  it("after a retraction, the terminal's text still lands", () => {
    const { n, feed } = turn();
    feed(delta("NO", 1));
    feed(delta("", 2, { replace: true }));
    expect(n.text).toBe("");
    expect(finalOf(feed(terminal("error", "The full answer", 3)))).toBe("The full answer");
  });
});

describe("a lost chat delta is recovered the way the Control UI recovers it", () => {
  // `chat` deltas are droppable under back-pressure (`dropIfSlow`). The frame still takes
  // its envelope seq: the connection sees the hole, retires its baselines, and the next
  // append-only delta — which has nothing to append to — makes it re-read the in-flight
  // text (`chat.history` → `inFlightRun`), queued as a `chat` delta with no seq. Here the
  // re-read answers at once with what the gateway held at that point; the real one is one
  // request at a time, at least 2 s apart, at most 8 per run.
  const isChatDelta = (f: GatewayFrame) =>
    f.event === "chat" && (f.payload as { state?: unknown }).state === "delta";
  function chatTextAt(fx: Fixture): Map<string, string>[] {
    const baselines = new Map<string, unknown>();
    const held = new Map<string, string>();
    return fx.entries.map((e) => {
      const f = e.frame as GatewayFrame;
      if (isChatDelta(f)) {
        const p = f.payload as Record<string, unknown>;
        const merged = mergeChatStreamMessage(baselines.get(String(p.runId)), p);
        if (merged !== undefined) {
          baselines.set(String(p.runId), merged);
          held.set(String(p.runId), messageText(merged) ?? "");
        }
      }
      return new Map(held);
    });
  }
  async function eachLoss(
    fx: Fixture,
    sample: number,
    known: (r: Refusal) => boolean,
  ): Promise<number> {
    const intact = await replay(fx, new GuardedWriter());
    expect(intact.refused.filter((r) => !known(r)), fx.header.scenario).toEqual([]);
    const texts = chatTextAt(fx);
    const positions = fx.entries
      .map((e, i) => (isChatDelta(e.frame as GatewayFrame) ? i : -1))
      .filter((i) => i >= 0);
    const step = Math.max(1, Math.floor(positions.length / sample));
    let tried = 0;
    for (let k = 0; k < positions.length; k += step) {
      tried++;
      const w = await replay(fx, new GuardedWriter(), undefined, positions[k], (gap, index) => {
        const text = texts[index]!.get(gap.runId);
        return text === undefined || text === ""
          ? null
          : ({
              type: "event",
              event: "chat",
              payload: {
                runId: gap.runId,
                sessionKey: gap.sessionKey,
                state: "delta",
                deltaText: "",
                message: { role: "assistant", content: [{ type: "text", text }] },
              },
            } as GatewayFrame);
      });
      const where = `${fx.version}/${fx.header.scenario}, chat delta #${k} lost`;
      expect(w.refused.filter((r) => !known(r)), where).toEqual([]);
      // (Up to the one line break before a dropped directive: see `known`.)
      expect(w.shown.trimEnd(), where).toBe(intact.shown.trimEnd());
    }
    return tried;
  }

  it("captured: every turn, one chat delta lost at each position — no refused write, same final bubble", async () => {
    const known: Record<string, (r: Refusal) => boolean> = {
      // The reply ends on a `MEDIA:` directive (see the `replaceable` turn above).
      replaceableRestart: (r) => r.source === "chat_final" && r.oldLen - r.newLen === 1,
      // THE STATED WORST CASE. When the frame lost is itself the rewrite — the answer that
      // replaces a command snapshot — the text read back is shorter than the snapshot
      // still shown, and a re-read carries no order: it is refused, and the bubble keeps
      // the command snapshot until the final.
      commandThenAnswer: (r) => r.source === "chat_delta",
      undeclaredRewrite: (r) => r.source === "chat_delta",
    };
    let tried = 0;
    for (const [name, turn] of Object.entries(CAPTURED)) {
      if (typeof turn !== "object" || !Array.isArray((turn as CapturedTurn).frames)) continue;
      tried += await eachLoss(asFixture(name, turn as CapturedTurn), 24, known[name] ?? (() => false));
    }
    expect(tried).toBeGreaterThan(40);
  });

  it("captured: the golden corpus of every version, one chat delta lost — no refused write, same final bubble", async () => {
    let tried = 0;
    for (const fx of loadCorpus()) tried += await eachLoss(fx, 3, () => false);
    expect(tried).toBeGreaterThan(300);
  });
});

describe("several `message`-tool sends in one turn", () => {
  // Each send is an outbound message of its own: the gateway appends one assistant
  // message per send to the session transcript (src/gateway/
  // internal-source-reply-persistence.ts `persistInternalSourceReply`), and its
  // delivery mirror lists them one after the other. Captured on 2026.9.36 (bench run
  // 2026-11-21T02-31-59-361Z): 52 characters, then 50, then the run's own text. Shown as
  // a replacement, the second send was a shrink Convex refused — at 42593d9e as well.
  const TWO_SENDS = JSON.parse(
    readFileSync(resolve(__dirname, "./fixtures/message-tool-two-sends-frames.json"), "utf-8"),
  ) as CapturedTurn;
  const FIRST = "CODEMODE_SEND_DONE Voici les deux fichiers demandés.";
  const SECOND = "CODEMODE_RESEND Voici de nouveau le fichier texte.";

  it("captured: the second, shorter send is added to the first — nothing is refused", async () => {
    const writer = await replay(asFixture("twoSends", TWO_SENDS), new GuardedWriter());
    expect(writer.refused).toEqual([]);
    const first = writer.history.indexOf(FIRST);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(writer.history[first + 1]).toBe(`${FIRST}\n\n${SECOND}`);
    // The run's own text then takes the bubble, as the chat stream's whole view of it:
    // declared, since it is shorter than the two sends.
    expect(writer.declaredShrinks).toEqual([{ oldLen: 104, newLen: 4, source: "chat_delta" }]);
    expect(writer.shown).toBe(
      "CODEMODE_SUMMARY Les deux fichiers ont été envoyés, puis le fichier texte renvoyé.",
    );
  });

  it("captured: no write that comes from a `message`-tool send is refused, on any capture", async () => {
    const turns: Fixture[] = [...loadCorpus(), asFixture("twoSends", TWO_SENDS)];
    for (const [name, turn] of Object.entries(CAPTURED)) {
      if (typeof turn !== "object" || !Array.isArray((turn as CapturedTurn).frames)) continue;
      turns.push(asFixture(name, turn as CapturedTurn));
    }
    expect(turns.length).toBeGreaterThan(150);
    let sends = 0;
    for (const fx of turns) {
      const writer = new GuardedWriter();
      const sources: (SnapshotSource | undefined)[] = [];
      const setSnapshot = writer.setSnapshot.bind(writer);
      writer.setSnapshot = async (id, text, replace, source) => {
        sources.push(source);
        return setSnapshot(id, text, replace, source);
      };
      await replay(fx, writer);
      sends += sources.filter((s) => s === "message_tool").length;
      expect(
        writer.refused.filter((r) => r.source === "message_tool"),
        `${fx.version}/${fx.header.scenario}`,
      ).toEqual([]);
    }
    // The check reads something. (Today only the capture above writes from a send: on
    // the golden fixtures the sends belong to runs whose text the turn does not show.)
    expect(sends).toBeGreaterThanOrEqual(2);
  });

  const SK = "agent:main:atrium:chat:u-1:c-1";
  const RUN = "webchat-run-1";
  function turn(): { n: Normalizer; at: () => number } {
    const n = new Normalizer(SK, null);
    let now = 1000;
    n.beginTurn(now);
    n.noteRunStarted(RUN, now);
    return { n, at: () => (now += 0.01) };
  }
  const send = (text: string, toolCallId: string, seq: number) => ({
    event: "agent",
    payload: {
      sessionKey: SK,
      runId: RUN,
      seq,
      stream: "tool",
      data: { phase: "start", name: "message", toolCallId, args: { action: "send", message: text } },
    },
  });
  const chat = (text: string, seq: number, extra: Record<string, unknown> = {}) => ({
    event: "chat",
    payload: {
      sessionKey: SK,
      runId: RUN,
      seq,
      state: "delta",
      deltaText: text,
      message: { role: "assistant", content: [{ type: "text", text }] },
      ...extra,
    },
  });
  const snaps = (events: BridgeEvent[]) =>
    events
      .filter((e) => e.type === "message.snapshot")
      .map((e) => ({
        text: e.text,
        ...(e.replace === true ? { replace: true } : {}),
        source: e.snapshotSource,
      }));

  it("hand-built: a send is added to the text shown, whoever wrote it, and never declared", () => {
    const { n, at } = turn();
    n.feed(chat("I am sending the two files now.", 1), at());
    expect(snaps(n.feed(send("Here.", "call-1", 2), at()))).toEqual([
      { text: "I am sending the two files now.\n\nHere.", source: "message_tool" },
    ]);
    expect(snaps(n.feed(send("Again.", "call-2", 3), at()))).toEqual([
      { text: "I am sending the two files now.\n\nHere.\n\nAgain.", source: "message_tool" },
    ]);
  });

  it("hand-built: the same tool call seen twice is one send", () => {
    const { n, at } = turn();
    n.feed(send("Here is the long first message.", "call-1", 1), at());
    expect(snaps(n.feed(send("Here is the long first message.", "call-1", 1), at()))).toEqual([]);
    expect(n.text).toBe("Here is the long first message.");
  });

  it("hand-built: a new turn starts from no earlier send", () => {
    const { n, at } = turn();
    n.feed(send("First turn.", "call-1", 1), at());
    n.feed({ event: "chat", payload: { sessionKey: SK, runId: RUN, seq: 2, state: "final" } }, at());
    n.beginTurn(at());
    n.noteRunStarted("webchat-run-2", at());
    const again = { ...send("Second turn.", "call-1", 1) };
    again.payload = { ...again.payload, runId: "webchat-run-2" };
    expect(snaps(n.feed(again, at()))).toEqual([{ text: "Second turn.", source: "message_tool" }]);
  });

  it("hand-built: a run abandoned for a replay takes its sends with it", () => {
    const { n, at } = turn();
    n.feed(send("Before the replay.", "call-1", 1), at());
    const abandoned = n.feed(
      {
        event: "agent",
        payload: {
          sessionKey: SK,
          runId: RUN,
          seq: 2,
          stream: "lifecycle",
          data: { phase: "end", livenessState: "abandoned" },
        },
      },
      at(),
    );
    expect(snaps(abandoned)).toEqual([{ text: "", replace: true, source: "compaction_reset" }]);
    expect(snaps(n.feed(send("Before the replay.", "call-1", 3), at()))).toEqual([
      { text: "Before the replay.", source: "message_tool" },
    ]);
  });

  // AFTER A STEER SPLIT the text held is the current segment's: the earlier segments'
  // text is taken off the gateway's cumulative text once, where it is read. Text that is
  // already the segment's own is never read against that prefix again — the answer may
  // open with the very words the earlier segment showed.
  const lifecycleEnd = (seq: number, data: Record<string, unknown>) => ({
    event: "agent",
    payload: { sessionKey: SK, runId: RUN, seq, stream: "lifecycle", data },
  });
  const terminalFrame = (state: "final" | "error" | "aborted", seq: number, text?: string) => ({
    event: "chat",
    payload: {
      sessionKey: SK,
      runId: RUN,
      seq,
      state,
      ...(state === "error" ? { errorMessage: "provider failed" } : {}),
      ...(text === undefined ? {} : { message: { role: "assistant", content: [{ type: "text", text }] } }),
    },
  });
  /** "First." shown; with `split`, settled at a steer cut — and the next segment opens
   *  with the same words: "First. Again." */
  function repeated(split: boolean): { n: Normalizer; at: () => number; whole: (local: string) => string } {
    const { n, at } = turn();
    n.feed(chat("First.", 1), at());
    if (split) n.splitSegment();
    const whole = (local: string) => (split ? `First.\n\n${local}` : local);
    n.feed(chat(whole("First. Again."), 2), at());
    expect(n.text).toBe("First. Again.");
    return { n, at, whole };
  }

  it("the reviewer's sequence: split, a segment that repeats the prefix, a send, a final without text", () => {
    const { n, at } = repeated(true);
    expect(snaps(n.feed(send("Done.", "call-1", 3), at()))).toEqual([
      { text: "First. Again.\n\nDone.", source: "message_tool" },
    ]);
    expect(n.text).toBe("First. Again.\n\nDone.");
    const end = n.feed(terminalFrame("final", 4), at());
    expect(end.find((e) => e.type === "message.final")?.text).toBe("First. Again.\n\nDone.");
  });

  for (const split of [false, true]) {
    const label = split ? "after a split" : "without a split";
    it(`${label}: a send keeps every word of the segment's text`, () => {
      const { n, at } = repeated(split);
      n.feed(send("Done.", "call-1", 3), at());
      n.feed(send("Really.", "call-2", 4), at());
      expect(n.text).toBe("First. Again.\n\nDone.\n\nReally.");
    });

    it(`${label}: a terminal's message loses the earlier segments once, and nothing more`, () => {
      const { n, at, whole } = repeated(split);
      const end = n.feed(terminalFrame("aborted", 3, whole("First. Again. And more.")), at());
      expect(end.find((e) => e.type === "message.final")?.text).toBe("First. Again. And more.");
    });

    it(`${label}: a settled bubble's completion loses the earlier segments once, and nothing more`, () => {
      const { n, at, whole } = repeated(split);
      n.feed(lifecycleEnd(3, { phase: "error", error: "provider failed", executionSettled: true }), at());
      expect(n.settledCompletion(terminalFrame("error", 4, whole("First. Again. And more.")))).toMatchObject({
        text: "First. Again. And more.",
      });
    });
  }

  // What the freshness guard protects is untouched by a send: only a `chat` frame ABOVE
  // the run's applied chat seq may shorten the bubble.
  it("hand-built: after a send, a stale chat frame still shortens nothing", () => {
    const { n, at } = turn();
    n.feed(chat("A first long view of the answer.", 5), at());
    n.feed(send("Here.", "call-1", 6), at());
    const held = "A first long view of the answer.\n\nHere.";
    expect(n.text).toBe(held);
    // Run seq 4, below the chat seq applied (5): an older view, even marked `replace`.
    expect(snaps(n.feed(chat("A fir", 4, { replace: true }), at()))).toEqual([]);
    expect(n.text).toBe(held);
    const stale = snaps(n.feed(chat("Something else", 4, { replace: true }), at()));
    expect(stale.map((s) => s.replace)).toEqual([undefined]);
    expect(n.text).toBe(held);
    // …and the frame that follows the send in the run's order does: it is the whole view.
    expect(snaps(n.feed(chat("The answer.", 7), at()))).toEqual([
      { text: "The answer.", replace: true, source: "chat_delta" },
    ]);
  });
});
