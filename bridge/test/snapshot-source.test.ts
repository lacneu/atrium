// WHICH PRODUCER wrote a `message.snapshot` (src/core/snapshot-source.ts).
//
// Prod 2026-10-13: Convex's anti-regression guard refused 25 snapshots of one turn in
// nine seconds — two producers fed one message — and no record said which frame wrote
// which. Every producing path now tags its snapshot with ONE closed-vocabulary value,
// the turn-sink hands it to the writer, and the writer puts it on the `setSnapshot` op
// (plus the producer of the text it last confirmed, `keptSource`). Each path is driven
// here through its real entry point; the last test proves the list has no dead value.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  Normalizer,
  TRUNCATED_FINAL_MARKER,
  TRUNCATED_FINAL_MIN_BODY,
  type BridgeEvent,
} from "../src/providers/openclaw/normalizer.js";
import { HermesNormalizer } from "../src/providers/hermes/normalizer.js";
import { SseParser } from "../src/providers/hermes/sse.js";
import { TurnSink } from "../src/core/turn-sink.js";
import { HttpConvexWriter } from "../src/convex-writer.js";
import type { ConvexWriter, FinalizeStatus } from "../src/convex-writer.js";
import {
  SNAPSHOT_SOURCES,
  asSnapshotSource,
  type SnapshotSource,
} from "../src/core/snapshot-source.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = JSON.parse(
  readFileSync(resolve(__dirname, "./fixtures/openclaw_frames.json"), "utf-8"),
) as { session_key: string; run_id: string; scenarios: Record<string, { frames: unknown[] }> };
const SK = FIXTURES.session_key;
const RUN = FIXTURES.run_id;

/** Every source a run of the tests below observed — checked against the list last. */
const observed = new Set<string>();

function turn(): { n: Normalizer; at: () => number } {
  const n = new Normalizer(SK, null);
  let now = 1000;
  n.beginTurn(now);
  n.noteRunStarted(RUN, now);
  return { n, at: () => (now += 0.01) };
}

/** The `snapshotSource` of every snapshot event, in order (and noted as observed). */
function sources(events: BridgeEvent[]): unknown[] {
  const out = events
    .filter((e) => e.type === "message.snapshot")
    .map((e) => (e as { snapshotSource?: unknown }).snapshotSource);
  for (const s of out) if (typeof s === "string") observed.add(s);
  return out;
}

const chat = (state: "delta" | "final", extra: Record<string, unknown>, seq = 1) => ({
  event: "chat",
  payload: { sessionKey: SK, runId: RUN, seq, state, ...extra },
});
const message = (text: string) => ({
  message: { role: "assistant", content: [{ type: "text", text }] },
});
const assistant = (data: Record<string, unknown>) => ({
  event: "agent",
  payload: { sessionKey: SK, runId: RUN, stream: "assistant", data },
});

describe("OpenClaw normalizer: each snapshot path names itself", () => {
  it("chat delta carrying the message → chat_delta; chat final → chat_final", () => {
    const { n, at } = turn();
    const ev = [
      ...n.feed(chat("delta", message("Bon"), 1), at()),
      ...n.feed(chat("final", message("Bonjour !"), 2), at()),
    ];
    expect(sources(ev)).toEqual(["chat_delta", "chat_final"]);
  });

  it("chat final cut by the display projection → chat_final_truncated", () => {
    const { n, at } = turn();
    const body = "a".repeat(TRUNCATED_FINAL_MIN_BODY);
    const ev = n.feed(chat("final", message(body + TRUNCATED_FINAL_MARKER)), at());
    expect(sources(ev)).toEqual(["chat_final_truncated"]);
  });

  it("chat delta with replace:true → chat_delta_replace (and plain deltas carry none)", () => {
    const { n, at } = turn();
    const ev = [
      ...n.feed(chat("delta", { deltaText: "first draft" }, 1), at()),
      ...n.feed(chat("delta", { deltaText: "rewritten", replace: true }, 2), at()),
    ];
    expect(sources(ev)).toEqual(["chat_delta_replace"]);
    const delta = ev.find((e) => e.type === "message.delta");
    expect(delta).toBeDefined();
    expect(delta).not.toHaveProperty("snapshotSource");
  });

  it("agent assistant text → agent_assistant_text; its replace refreshes → agent_assistant_replace", () => {
    const { n, at } = turn();
    const ev = [
      ...n.feed(assistant({ text: "Hello" }), at()),
      ...n.feed(assistant({ text: "Hi", replace: true }), at()),
      ...n.feed(assistant({ delta: "Hey", replace: true }), at()),
    ];
    expect(sources(ev)).toEqual([
      "agent_assistant_text",
      "agent_assistant_replace",
      "agent_assistant_replace",
    ]);
  });

  it("the message tool's visible reply → message_tool", () => {
    const { n, at } = turn();
    const ev: BridgeEvent[] = [];
    for (const f of FIXTURES.scenarios["tool-message-visible"]!.frames) ev.push(...n.feed(f, at()));
    expect(sources(ev)[0]).toBe("message_tool");
  });

  it("a transcript recovery applied as the answer → history_recovery", () => {
    const { n, at } = turn();
    const token = n.noteRecoveryDispatched();
    const ev = n.recoverVisibleText("La réponse complète.", at(), token);
    expect(sources(ev)).toEqual(["history_recovery"]);
  });

  it("the empty snapshot of a mid-turn compaction reset → compaction_reset", () => {
    const { n, at } = turn();
    const ev: BridgeEvent[] = [];
    for (const f of FIXTURES.scenarios["compaction-abandoned-replay"]!.frames) ev.push(...n.feed(f, at()));
    const reset = ev.find((e) => e.type === "message.snapshot" && e.text === "");
    expect(reset).toMatchObject({ replace: true, snapshotSource: "compaction_reset" });
    sources([reset!]);
  });
});

describe("Hermes normalizer", () => {
  it("assistant.completed → hermes_assistant_completed", () => {
    const sse = readFileSync(join(__dirname, "fixtures/hermes/chat-stream-success.sse"), "utf8");
    const p = new SseParser();
    const n = new HermesNormalizer();
    const ev: BridgeEvent[] = [];
    for (const f of [...p.push(sse), ...p.end()]) ev.push(...n.feed(f));
    expect(sources(ev)).toEqual(["hermes_assistant_completed"]);
  });
});

/** The writer calls the sink makes (the 4th argument is the producer). */
class RecordingWriter implements ConvexWriter {
  readonly snapshots: Array<{ text: string; replace?: boolean; source?: SnapshotSource }> = [];
  releaseUpload = Promise.resolve();
  async startAssistant(): Promise<string> {
    return "msg_1";
  }
  async appendDelta(): Promise<void> {}
  async setSnapshot(
    _messageId: string,
    text: string,
    replace?: boolean,
    source?: SnapshotSource,
  ): Promise<boolean> {
    this.snapshots.push({ text, replace, source });
    if (source !== undefined) observed.add(source);
    return true;
  }
  async addToolPart(): Promise<void> {}
  async addCompactionPart(): Promise<void> {}
  async recordGatewayPressure(): Promise<void> {}
  async addProvenancePart(): Promise<void> {}
  async addMedia(): Promise<boolean> {
    return true;
  }
  async noteMediaUndelivered(): Promise<void> {}
  async finalize(
    _messageId: string,
    _status: FinalizeStatus,
    _text: string,
    _error: string | null,
    _errorKind: string | null,
  ): Promise<void> {}
  async getRehydrationContext(): Promise<{ history: string | null; turnCount: number }> {
    return { history: null, turnCount: 0 };
  }
  async reportSessionRoster(): Promise<void> {}
  async reportSessionMeta(): Promise<void> {}
  async upsertSubAgent(): Promise<void> {}
  async upsertSubAgentToolPart(): Promise<void> {}
  async recordSubAgentInteractionReply(): Promise<void> {}
  async recordInteractionReply(): Promise<void> {}
  emitRehydrateTrace(): void {}
}

describe("turn-sink: the producer reaches the writer", () => {
  it("forwards a known source, drops an unknown one", async () => {
    const writer = new RecordingWriter();
    const sink = new TurnSink("chat_1", writer);
    await sink.beginTurn("run-1");
    await sink.apply([
      { type: "message.snapshot", text: "Bonjour", snapshotSource: "chat_delta" },
      { type: "message.snapshot", text: "Bonjour à", snapshotSource: "not_a_source" },
      { type: "message.snapshot", text: "", replace: true, snapshotSource: "compaction_reset" },
    ]);
    expect(writer.snapshots).toEqual([
      { text: "Bonjour", replace: false, source: "chat_delta" },
      { text: "Bonjour à", replace: false, source: undefined },
      { text: "", replace: true, source: "compaction_reset" },
    ]);
  });

  it("the text-first write before a media upload → early_text_media", async () => {
    const writer = new RecordingWriter();
    const sink = new TurnSink("chat_2", writer);
    await sink.beginTurn("run-2");
    await sink.apply([
      { type: "media", items: [{ filename: "v.mp4", path: "/out/v.mp4", explicit: true }] },
      { type: "message.final", text: "Voici le fichier." },
      { type: "run.status", status: "final" },
    ]);
    expect(writer.snapshots).toEqual([
      { text: "Voici le fichier.", replace: undefined, source: "early_text_media" },
    ]);
  });
});

type Sent = Record<string, unknown> & { op: string };

function writerAcking(applied: (op: Sent) => boolean) {
  const sent: Sent[] = [];
  const fetchImpl = (async (_url: unknown, init: { body: string }) => {
    const op = JSON.parse(init.body) as Sent;
    sent.push(op);
    const ok = op.op !== "setSnapshot" || applied(op);
    return { ok: true, json: async () => ({ ok: true, applied: ok }) } as unknown as Response;
  }) as unknown as typeof fetch;
  const w = new HttpConvexWriter({
    convexHttpActionsUrl: "http://test.invalid",
    ingestSecret: "s",
    deltaFlushMs: 5,
    fetchImpl,
  });
  return { w, sent };
}

describe("convex-writer: the op names both sides of a refused snapshot", () => {
  it("the prod shape: a whole-turn producer grows the text, a segment producer is refused with both sources on the op", async () => {
    const { w, sent } = writerAcking((op) => op.text !== "post-tool");
    expect(await w.setSnapshot("m1", "the head of the turn", undefined, "chat_delta")).toBe(true);
    // Extends what Convex holds → a suffix appendDelta, no source needed there.
    expect(await w.setSnapshot("m1", "the head of the turn, grown", undefined, "chat_delta")).toBe(true);
    expect(sent.at(-1)).toMatchObject({ op: "appendDelta", text: ", grown" });
    // Does not extend it → a full setSnapshot, refused by the guard.
    expect(await w.setSnapshot("m1", "post-tool", undefined, "agent_assistant_text")).toBe(false);
    expect(sent.at(-1)).toEqual({
      op: "setSnapshot",
      messageId: "m1",
      text: "post-tool",
      snapshotSource: "agent_assistant_text",
      keptSource: "chat_delta",
    });
    // A refusal does not move the kept producer.
    await w.setSnapshot("m1", "post-tool", undefined, "agent_assistant_text");
    expect(sent.at(-1)).toMatchObject({ keptSource: "chat_delta" });
  });

  it("no source given → the 0.100.0 op shape exactly (no new field on the wire)", async () => {
    const { w, sent } = writerAcking(() => true);
    await w.setSnapshot("m1", "abc");
    await w.setSnapshot("m1", "xyz");
    expect(sent.at(-1)).toEqual({ op: "setSnapshot", messageId: "m1", text: "xyz" });
  });

  it("flushed deltas make the kept text the delta stream's", async () => {
    const { w, sent } = writerAcking(() => false);
    await w.appendDelta("m1", "streamed by deltas");
    await w.setSnapshot("m1", "other", undefined, "message_tool");
    expect(sent.at(-1)).toMatchObject({
      op: "setSnapshot",
      snapshotSource: "message_tool",
      keptSource: "delta_stream",
    });
    observed.add("delta_stream");
  });
});

describe("the vocabulary", () => {
  it("narrows to the list and nothing else", () => {
    expect(asSnapshotSource("chat_final")).toBe("chat_final");
    expect(asSnapshotSource("Chat_Final")).toBeUndefined();
    expect(asSnapshotSource(3)).toBeUndefined();
  });

  it("has no dead value: every source was produced by a path above", () => {
    expect([...observed].sort()).toEqual([...SNAPSHOT_SOURCES].sort());
  });
});
