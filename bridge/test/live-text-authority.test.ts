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

  it("hand-built: a LONGER second item does not replace the first either", () => {
    // The guard cannot see this one: the write grows, and the first item is gone.
    const { n, at } = turn();
    n.feed(assistant({ text: "Ok.", delta: "Ok.", itemId: "s:1" }), at());
    const second = n.feed(
      assistant({ text: "Here is the full answer.", delta: "Here is the full answer.", itemId: "s:2" }),
      at(),
    );
    expect(snapshots(second)).toEqual([]);
    expect(n.text).toBe("Ok.");
    const whole = n.feed(chatDelta("Ok.\n\nHere is the full answer."), at());
    expect(snapshots(whole)).toEqual([
      { text: "Ok.\n\nHere is the full answer.", source: "chat_delta" },
    ]);
  });

  it("hand-built: the first item keeps writing, and its own `replace` keeps its permission", () => {
    const { n, at } = turn();
    const ev = [
      ...n.feed(assistant({ text: "Hello", delta: "Hello", itemId: "s:1" }), at()),
      ...n.feed(assistant({ text: "Hello world", delta: " world", itemId: "s:1" }), at()),
      ...n.feed(assistant({ text: "Hi", delta: "", replace: true, itemId: "s:1" }), at()),
    ];
    expect(snapshots(ev)).toEqual([
      { text: "Hello", source: "agent_assistant_text" },
      { text: "Hello world", source: "agent_assistant_text" },
      { text: "Hi", replace: true, source: "agent_assistant_replace" },
    ]);
  });

  it("hand-built: a later item's `replace` rewrites that item only — not written", () => {
    const { n, at } = turn();
    n.feed(assistant({ text: "First.", delta: "First.", itemId: "s:1" }), at());
    const ev = n.feed(assistant({ text: "X", delta: "", replace: true, itemId: "s:2" }), at());
    expect(snapshots(ev)).toEqual([]);
    expect(n.text).toBe("First.");
  });

  it("hand-built: a frame without `itemId` is the run's whole text, as before", () => {
    const { n, at } = turn();
    const ev = [
      ...n.feed(assistant({ text: "Hello", itemId: "s:1" }), at()),
      ...n.feed(assistant({ text: "Hello again" }), at()),
    ];
    expect(snapshots(ev).map((s) => s.text)).toEqual(["Hello", "Hello again"]);
  });

  it("hand-built: each run has its own first item, and a new turn starts over", () => {
    const { n, at } = turn();
    n.feed(assistant({ text: "One", itemId: "a:1" }), at());
    n.noteRunStarted("webchat-run-2", at());
    const other = n.feed(assistant({ text: "Two", itemId: "b:1" }, "webchat-run-2"), at());
    expect(snapshots(other).map((s) => s.text)).toEqual(["Two"]);
    n.beginTurn(at());
    n.noteRunStarted(RUN, at());
    const next = n.feed(assistant({ text: "Three", itemId: "a:7" }), at());
    expect(snapshots(next).map((s) => s.text)).toEqual(["Three"]);
  });

  it("hand-built: a steer split does not hand the bubble to the next item", () => {
    // After a cut the run's cumulative text is stripped of the settled segment; an
    // item-only text has no such prefix and would be taken whole.
    const { n, at } = turn();
    n.feed(assistant({ text: "First part.", delta: "First part.", itemId: "s:1" }), at());
    n.splitSegment();
    const second = n.feed(assistant({ text: "Second", delta: "Second", itemId: "s:2" }), at());
    expect(snapshots(second)).toEqual([]);
    const whole = n.feed(chatDelta("First part.\n\nSecond"), at());
    expect(snapshots(whole)).toEqual([{ text: "Second", source: "chat_delta" }]);
  });

  it("hand-built: the per-run memory is bounded — a run it forgot reads as it always did", () => {
    const { n, at } = turn();
    n.feed(assistant({ text: "One", itemId: "a:1" }), at());
    for (let i = 0; i < 64; i++) {
      n.noteRunStarted(`webchat-other-${i}`, at());
      n.feed(assistant({ text: "x", itemId: `o${i}:1` }, `webchat-other-${i}`), at());
    }
    const ev = n.feed(assistant({ text: "Another item", itemId: "a:2" }), at());
    expect(snapshots(ev).map((s) => s.text)).toEqual(["Another item"]);
  });

  it("hand-built: after a compaction reset the replay's first item owns the emptied bubble", () => {
    const { n, at } = turn();
    n.feed(assistant({ text: "Before", itemId: "s:1" }), at());
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
    const replayed = n.feed(assistant({ text: "After", itemId: "s:4" }), at());
    expect(snapshots(replayed).map((s) => s.text)).toEqual(["After"]);
  });

  // `mergeAssistantText`: "Only provisional stream replacements discard earlier items" —
  // a NEW item marked `replace` and `replaceable` restarts the run's text.
  it("hand-built: before the chat stream speaks, a `replaceable` replacement on a new item IS the whole text", () => {
    const { n, at } = turn();
    n.feed(assistant({ text: "Draft", delta: "Draft", itemId: "s:1" }), at());
    const ev = n.feed(
      assistant({ text: "Hi", replace: true, replaceable: true, itemId: "s:assistant" }),
      at(),
    );
    expect(snapshots(ev)).toEqual([
      { text: "Hi", replace: true, source: "agent_assistant_replace" },
    ]);
  });

  // Captured on the codex harness (2026.9.33): the turn's last assistant frame is such a
  // replacement, after the chat stream wrote the same text: it is not written again.
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

describe("the chat stream is the bubble's authority once it has written it", () => {
  const SK = "agent:main:atrium:chat:u-1:c-1";
  const RUN = "webchat-run-1";
  function turn(): { n: Normalizer; at: () => number } {
    const n = new Normalizer(SK, null);
    let now = 1000;
    n.beginTurn(now);
    n.noteRunStarted(RUN, now);
    return { n, at: () => (now += 0.01) };
  }
  const written = (events: BridgeEvent[]) =>
    events.filter((e) => e.type === "message.snapshot").map((e) => e.text);
  const assistant = (text: string, seq: number, runId = RUN) => ({
    event: "agent",
    seq: 100 + seq * 2,
    payload: {
      sessionKey: SK,
      runId,
      seq,
      stream: "assistant",
      data: { phase: "final_answer", text, delta: text, itemId: "s:1" },
    },
  });
  const chat = (text: string, seq: number, runId = RUN) => ({
    event: "chat",
    seq: 101 + seq * 2,
    payload: {
      sessionKey: SK,
      runId,
      seq,
      state: "delta",
      deltaText: text,
      message: { role: "assistant", content: [{ type: "text", text }] },
    },
  });

  it("hand-built: the assistant text writes until the chat stream does, never after", () => {
    const { n, at } = turn();
    expect(written(n.feed(assistant("He", 1), at()))).toEqual(["He"]);
    expect(written(n.feed(chat("He", 1), at()))).toEqual(["He"]);
    expect(written(n.feed(assistant("Hello, a longer view", 2), at()))).toEqual([]);
    expect(written(n.feed(chat("Hello", 2), at()))).toEqual(["Hello"]);
  });

  it("hand-built: per run, and a new turn starts over", () => {
    const { n, at } = turn();
    n.feed(chat("One", 1), at());
    n.noteRunStarted("webchat-run-2", at());
    expect(written(n.feed(assistant("Two", 1, "webchat-run-2"), at()))).toEqual(["Two"]);
    n.beginTurn(at());
    n.noteRunStarted(RUN, at());
    expect(written(n.feed(assistant("Three", 1), at()))).toEqual(["Three"]);
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
    n.feed(
      { event: "agent", payload: { sessionKey: SK, runId: turnFrames.runId, seq: 3, stream: "assistant", data: { text: "A long first answer", itemId: "s:1" } } },
      at(),
    );
    const noSeq = {
      event: "chat",
      payload: { sessionKey: SK, runId: turnFrames.runId, state: "delta", deltaText: "x", replace: true, message: { role: "assistant", content: [{ type: "text", text: "x" }] } },
    };
    expect(declared(n.feed(noSeq, at()))).toBe(false);
  });

  it("hand-built: a refused frame is not the writer — the next one is not its sequel", () => {
    const { n, at } = start();
    const SK = turnFrames.sessionKey;
    const chat = (text: string, seq: number, extra: Record<string, unknown> = {}) => ({
      event: "chat",
      payload: { sessionKey: SK, runId: turnFrames.runId, seq, state: "delta", deltaText: text, message: { role: "assistant", content: [{ type: "text", text }] }, ...extra },
    });
    n.feed(
      { event: "agent", payload: { sessionKey: SK, runId: turnFrames.runId, seq: 25, stream: "assistant", data: { text: "a".repeat(100), itemId: "s:1" } } },
      at(),
    );
    // Earlier in the run than the writer: undeclared, and Convex will refuse it.
    expect(declared(n.feed(chat("b".repeat(50), 20), at()))).toBe(false);
    expect(declared(n.feed(chat("c".repeat(70), 22), at()))).toBe(false);
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

describe("a dropped chat delta never stalls the bubble nor loses received text", () => {
  // `chat` deltas are droppable under back-pressure (`dropIfSlow`), `assistant` frames
  // are not. 2026.9.36 capture `pathCompletes`: one item, 5 000+ characters.
  const turnFrames = CAPTURED.pathCompletes;
  const isChatDelta = (f: GatewayFrame) =>
    f.event === "chat" && (f.payload as { state?: unknown }).state === "delta";
  const firstChat = turnFrames.frames.findIndex(isChatDelta);
  function feedAll(frames: GatewayFrame[]): { n: Normalizer; events: BridgeEvent[]; at: () => number } {
    const n = new Normalizer(turnFrames.sessionKey, null);
    const baselines = new LiveTextBaselines();
    let now = 1000;
    n.beginTurn(now);
    n.noteRunStarted(turnFrames.runId, now);
    const at = () => (now += 0.01);
    const events: BridgeEvent[] = [];
    for (const f of frames) events.push(...n.feed(baselines.project(f).frame, at()));
    return { n, events, at };
  }
  // Every chat delta after the first is lost, and so is the final.
  const starved = turnFrames.frames.filter(
    (f, i) => !(f.event === "chat" && i > firstChat),
  );
  const lastAssistantText = (() => {
    const b = new LiveTextBaselines();
    let text = "";
    for (const f of turnFrames.frames) {
      const projected = b.project(f).frame.payload as { stream?: unknown; data?: { text?: unknown } };
      if (projected.stream === "assistant" && typeof projected.data?.text === "string") {
        text = projected.data.text;
      }
    }
    return text;
  })();

  it("captured: with the chat stream gone quiet, the assistant text keeps the bubble advancing", () => {
    const { n, events } = feedAll(starved);
    expect(lastAssistantText.length).toBeGreaterThan(5000);
    expect(n.text).toBe(lastAssistantText);
    const lengths = events
      .filter((e) => e.type === "message.snapshot")
      .map((e) => String(e.text).length);
    expect(lengths.length).toBeGreaterThan(50);
    expect(lengths.every((len, i) => i === 0 || len >= lengths[i - 1]!)).toBe(true);
  });

  it("captured: assistant, chat, assistant, a dropped delta, then `chat:error` — the text received is kept", () => {
    // The reviewer's sequence: the second assistant frame is NOT written (the chat stream
    // was keeping up), the delta that would have carried it is lost, the run errors.
    const secondAssistant = turnFrames.frames.findIndex(
      (f, i) => i > firstChat && (f.payload as { stream?: unknown }).stream === "assistant",
    );
    const { n, at } = feedAll(turnFrames.frames.slice(0, secondAssistant + 1));
    const held = n.text.length;
    const error = {
      type: "event",
      event: "chat",
      payload: {
        runId: turnFrames.runId,
        sessionKey: turnFrames.sessionKey,
        state: "error",
        errorMessage: "provider failed",
      },
    };
    const final = n.feed(error, at()).find((e) => e.type === "message.final");
    expect(final).toBeDefined();
    expect(String(final!.text).length).toBeGreaterThan(held);
  });

  it("hand-built: a LATER item advances too, once a chat frame has shown where it starts", () => {
    const SK = "agent:main:atrium:chat:u-1:c-1";
    const RUN = "webchat-run-1";
    const mk = () => {
      const n = new Normalizer(SK, null);
      n.beginTurn(1000);
      n.noteRunStarted(RUN, 1000);
      return n;
    };
    const A = (itemId: string, text: string, seq: number) => ({
      event: "agent",
      payload: { sessionKey: SK, runId: RUN, seq, stream: "assistant", data: { phase: "final_answer", text, itemId } },
    });
    const C = (text: string, seq: number) => ({
      event: "chat",
      payload: { sessionKey: SK, runId: RUN, seq, state: "delta", deltaText: text, message: { role: "assistant", content: [{ type: "text", text }] } },
    });
    const run = (chatSeqOfSecondItem: number) => {
      const n = mk();
      let now = 1000;
      const feed = (f: unknown) => n.feed(f, (now += 0.01));
      feed(A("s:1", "First.", 1));
      feed(C("First.", 1));
      feed(A("s:2", "Sec", 5));
      // The chat frame built from the same event (run seq 5) shows the item's place.
      feed(C("First.\n\nSec", chatSeqOfSecondItem));
      feed(A("s:2", "Second part", 6));
      feed(A("s:2", "Second part, done.", 7)); // …and the chat deltas for 6 and 7 are lost
      return n.text;
    };
    expect(run(5)).toBe("First.\n\nSecond part, done.");
    // Not the same event: nothing says where the item starts, so nothing is joined.
    expect(run(4)).toBe("First.\n\nSec");
  });

  it("hand-built: an error terminal's `message` completes the bubble; it never replaces it", () => {
    // Shape of `emitChatTerminal` (src/gateway/server-chat.ts): `message` beside
    // `errorMessage` when the buffer held text. No capture holds a chat error.
    const SK = "agent:main:atrium:chat:u-1:c-1";
    const mk = () => {
      const n = new Normalizer(SK, null);
      n.beginTurn(1000);
      n.noteRunStarted("webchat-run-1", 1000);
      n.feed(
        { event: "chat", payload: { sessionKey: SK, runId: "webchat-run-1", seq: 1, state: "delta", deltaText: "Half", message: { role: "assistant", content: [{ type: "text", text: "Half" }] } } },
        1000.01,
      );
      return n;
    };
    const error = (text: string) => ({
      event: "chat",
      payload: {
        sessionKey: SK,
        runId: "webchat-run-1",
        seq: 2,
        state: "error",
        errorMessage: "provider failed",
        message: { role: "assistant", content: [{ type: "text", text }] },
      },
    });
    const finalOf = (events: BridgeEvent[]) => events.find((e) => e.type === "message.final")?.text;
    expect(finalOf(mk().feed(error("Half of the answer"), 1000.02))).toBe("Half of the answer");
    expect(finalOf(mk().feed(error("provider failed"), 1000.02))).toBe("Half");
  });

  it("captured: every turn, intact and with ONE chat delta dropped at each position — no refused write, same final bubble", async () => {
    const known: Record<string, Refusal[]> = {
      // The reply ends on a `MEDIA:` directive (see the `replaceable` turn above).
      replaceableRestart: [{ oldLen: 104, newLen: 103, source: "chat_final" }],
    };
    for (const [name, turn] of Object.entries(CAPTURED)) {
      if (typeof turn !== "object" || !Array.isArray((turn as CapturedTurn).frames)) continue;
      const fx = asFixture(name, turn as CapturedTurn);
      const intact = await replay(fx, new GuardedWriter());
      expect(intact.refused, name).toEqual(known[name] ?? []);
      const positions = fx.entries
        .map((e, i) => (isChatDelta(e.frame as GatewayFrame) ? i : -1))
        .filter((i) => i >= 0);
      // Every position on a short turn, a spread of them on the long one.
      const step = Math.max(1, Math.floor(positions.length / 24));
      for (let k = 0; k < positions.length; k += step) {
        const w = await replay(fx, new GuardedWriter(), undefined, positions[k]);
        expect(known[name] ?? [], `${name}, chat delta #${k} dropped`).toEqual(
          expect.arrayContaining(w.refused),
        );
        // (Up to the one line break before a dropped directive: see `known`.)
        expect(w.shown.trimEnd(), `${name}, chat delta #${k} dropped`).toBe(intact.shown.trimEnd());
      }
    }
  });

  it("captured: the golden corpus at 2026.9.36, intact and with one chat delta dropped — no refused write", async () => {
    const corpus = loadCorpus().filter((f) => f.version === "2026.9.36");
    expect(corpus.length).toBeGreaterThan(10);
    for (const fx of corpus) {
      const intact = await replay(fx, new GuardedWriter());
      expect(intact.refused, fx.header.scenario).toEqual([]);
      const positions = fx.entries
        .map((e, i) => (isChatDelta(e.frame as GatewayFrame) ? i : -1))
        .filter((i) => i >= 0);
      const step = Math.max(1, Math.floor(positions.length / 6));
      for (let k = 0; k < positions.length; k += step) {
        const w = await replay(fx, new GuardedWriter(), undefined, positions[k]);
        expect(w.refused, `${fx.header.scenario}, chat delta #${k} dropped`).toEqual([]);
      }
    }
  });
});
