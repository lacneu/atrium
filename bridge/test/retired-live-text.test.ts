/**
 * THE LIVE STREAM EMPTIED — a text the gateway recorded is not a text it took back.
 *
 * From OpenClaw 2026.10.33 the gateway withdraws from a run's chat buffer the text it has
 * just recorded in the transcript (src/gateway/server-chat-transcript-publication.ts
 * `retireTranscript`, src/gateway/server-chat-buffer.ts `bufferVisibleText`): the `chat`
 * delta that follows is `replace: true` and carries the tail not recorded yet — nothing,
 * on every turn of the bench. The terminal still carries the complete text
 * (src/gateway/server-chat.ts `emitChatTerminal`). On the wire that delta is the one a
 * real retraction sends (src/gateway/server-chat.agent-events.test.ts, "retracts a visible
 * item replaced by NO_REPLY with a 0 ms flush").
 *
 * A live bubble has one carrier, its live text (convex/stream.ts `setSnapshot`,
 * src/chat/useConvexChatRuntime.ts): written as it arrived, the emptying blanked the
 * answer on screen from that delta to the terminal — 22 to 732 ms on the bench run
 * 2026-11-24T22-39-08-086Z, at the end of every turn.
 *
 * Each link has its test here: the reader of the transcript event (TranscriptShadow), the
 * run manager's hand-over, the normalizer's rules (hand-built frames, said so), and the
 * whole chain replayed on frames captured on that run in their arrival order across the
 * two sockets (fixtures/retired-live-text-frames.json) against a writer that holds the
 * live text as Convex does.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { SnapshotSource } from "../src/core/snapshot-source.js";
import type { FinalizeStatus } from "../src/convex-writer.js";
import { LiveTextBaselines } from "../src/providers/openclaw/live-text-baseline.js";
import { Normalizer, type BridgeEvent } from "../src/providers/openclaw/normalizer.js";
import type { GatewayFrame } from "../src/providers/openclaw/openclaw-client.js";
import { RunManager } from "../src/providers/openclaw/run-manager.js";
import {
  TranscriptShadow,
  type SessionEventListener,
} from "../src/providers/openclaw/transcript-shadow.js";
import {
  drainDeadlines,
  loadCorpus,
  replay,
  RecordingWriter,
} from "./helpers/golden-corpus.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- The live text, as Convex holds it ------------------------------------------------

interface Shown {
  messageId: string;
  text: string;
  /** What wrote it. */
  by: "appendDelta" | "setSnapshot" | "finalize";
  source?: SnapshotSource;
  /** The snapshot declared it may shorten the text (`replace`). */
  declared?: true;
}

/** One bubble's live text under Convex's rules (convex/stream.ts): a delta appends, a
 *  snapshot replaces unless it is shorter and undeclared (refused), a finalize sets the
 *  text. `states` is every text a reader could have seen, in order. */
class LiveBubbles extends RecordingWriter {
  readonly text = new Map<string, string>();
  readonly states: Shown[] = [];
  readonly refused: Array<{ oldLen: number; newLen: number; source?: SnapshotSource }> = [];
  readonly finals = new Map<string, { status: FinalizeStatus; text: string }>();

  override async startAssistant(chatId: string, runId: string | null): Promise<string> {
    const id = await super.startAssistant(chatId, runId);
    this.text.set(id, "");
    return id;
  }
  override async appendDelta(messageId: string, text: string): Promise<void> {
    await super.appendDelta(messageId, text);
    const next = (this.text.get(messageId) ?? "") + text;
    this.text.set(messageId, next);
    this.states.push({ messageId, text: next, by: "appendDelta" });
  }
  override async setSnapshot(
    messageId: string,
    text: string,
    replace?: boolean,
    source?: SnapshotSource,
  ): Promise<boolean> {
    const held = this.text.get(messageId) ?? "";
    if (replace !== true && text.length < held.length) {
      this.refused.push({ oldLen: held.length, newLen: text.length, source });
      return false;
    }
    this.text.set(messageId, text);
    this.states.push({
      messageId,
      text,
      by: "setSnapshot",
      source,
      ...(replace === true ? { declared: true as const } : {}),
    });
    return super.setSnapshot(messageId, text);
  }
  override async finalize(messageId: string, status: FinalizeStatus, text: string): Promise<void> {
    await super.finalize(messageId, status, text);
    this.finals.set(messageId, { status, text });
    this.states.push({ messageId, text, by: "finalize" });
  }

  /** The live states of one bubble, up to (not including) its finalize. */
  live(messageId: string): Shown[] {
    const own = this.states.filter((s) => s.messageId === messageId);
    const end = own.findIndex((s) => s.by === "finalize");
    return end === -1 ? own : own.slice(0, end);
  }

  /** Bubbles that showed a text and then nothing while still live: `[messageId, index]`.
   *  A compaction reset empties a bubble on purpose (the attempt is abandoned). */
  blanked(): Array<[string, number]> {
    const out: Array<[string, number]> = [];
    for (const id of this.text.keys()) {
      let seen = false;
      this.live(id).forEach((s, i) => {
        if (s.text.trim() !== "") seen = true;
        else if (seen && s.source !== "compaction_reset") out.push([id, i]);
      });
    }
    return out;
  }
}

// --- The captured turns ---------------------------------------------------------------

interface CapturedEntry {
  receivedAt: number;
  socket: "conversation" | "session-events";
  frame: GatewayFrame;
}
interface CapturedTurn {
  gatewayVersion: string;
  sessionKey: string;
  runId: string;
  entries: CapturedEntry[];
}
const CAPTURED = JSON.parse(
  readFileSync(resolve(__dirname, "./fixtures/retired-live-text-frames.json"), "utf-8"),
) as Record<"longReply" | "toolsThenReply" | "rowAfterEmptying" | "messageToolRows", CapturedTurn>;
const TURNS = ["longReply", "toolsThenReply", "rowAfterEmptying", "messageToolRows"] as const;
/** The turns a chat.send of this conversation opened: replayed through the whole chain.
 *  `messageToolRows` is a requester-settle run, which the run manager only opens in the
 *  wake of the turn that yielded (not captured here): it is replayed at the normalizer. */
const SENT = ["longReply", "toolsThenReply", "rowAfterEmptying"] as const;

const payloadOf = (e: CapturedEntry): Record<string, unknown> =>
  (e.frame as { payload: Record<string, unknown> }).payload;

function messageText(message: unknown): string {
  const content = (message as { content?: unknown } | null | undefined)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: "text"; text?: string } => b?.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

/** The reconciler of the turn's session, as session.ts wires it: its `session.message`
 *  listener and the hand-over of each recorded assistant row to the run manager. */
function shadowFor(sessionKey: string, manager: RunManager) {
  let listener: SessionEventListener | null = null;
  const noted: Promise<void>[] = [];
  const rows: Array<{ runId?: string; seq: number }> = [];
  const shadow = new TranscriptShadow({
    chatId: "c1",
    sessionKey,
    readHistory: async () => ({ kind: "delta", messages: [], deltaCursor: "c:1", sessionInfo: {} }),
    apply: async () => {},
    events: {
      attach: (_key, l) => {
        listener = l;
        return () => {
          listener = null;
        };
      },
    },
    onAssistantRow: (row) => {
      rows.push({ runId: row.runId, seq: row.seq });
      noted.push(manager.onAssistantRow(row));
    },
    sleep: async () => {},
    now: () => 1000,
    log: () => {},
  });
  shadow.configure({});
  return {
    rows,
    async message(payload: Record<string, unknown>): Promise<void> {
      listener!.onSessionMessage(payload);
      await Promise.all(noted.splice(0));
    },
    close: () => shadow.close(),
  };
}

/** Replay one captured turn through the connection's live-text baselines, the run
 *  manager, the normalizer and the sink, on the captured clock and in the captured order
 *  of the two sockets. `rows: false` is the bridge that never hears the transcript (the
 *  session-events subscription is down, or the projection is off). */
async function replayTurn(turn: CapturedTurn, opts: { rows: boolean }) {
  const writer = new LiveBubbles();
  const manager = new RunManager("chat-retired", turn.sessionKey, writer);
  const baselines = new LiveTextBaselines();
  const shadow = shadowFor(turn.sessionKey, manager);
  const base = turn.entries[0]!.receivedAt;
  const at = (e: CapturedEntry): number => 1000 + (e.receivedAt - base) / 1000;
  manager.armReplayBuffer();
  await manager.beginTurn(at(turn.entries[0]!), turn.runId);
  /** The text shown right after each captured frame was read. */
  const afterEntry: string[] = [];
  let now = at(turn.entries[0]!);
  for (const entry of turn.entries) {
    now = await drainDeadlines(manager, now, 64, at(entry));
    now = at(entry);
    if (entry.socket === "conversation") {
      await manager.feed(baselines.project(entry.frame).frame, now);
    } else if (opts.rows) {
      await shadow.message(payloadOf(entry));
    }
    afterEntry.push([...writer.text.values()].at(-1) ?? "");
  }
  await drainDeadlines(manager, now);
  await manager.completionsIdle();
  shadow.close();
  return { writer, afterEntry, rows: shadow.rows };
}

/** Index of the turn's emptying delta and of its final among the entries. */
function landmarks(turn: CapturedTurn): { emptying: number; final: number; complete: string } {
  const emptying = turn.entries.findIndex(
    (e) =>
      e.socket === "conversation" &&
      e.frame.event === "chat" &&
      payloadOf(e).state === "delta" &&
      payloadOf(e).replace === true &&
      messageText(payloadOf(e).message) === "",
  );
  const final = turn.entries.findIndex(
    (e) => e.socket === "conversation" && e.frame.event === "chat" && payloadOf(e).state === "final",
  );
  return { emptying, final, complete: messageText(payloadOf(turn.entries[final]!).message) };
}

describe("captured on 2026.10.33 — the turn replayed in its arrival order", () => {
  it("the capture holds what it is replayed for: an emptying delta, then a complete final", () => {
    for (const name of TURNS) {
      const turn = CAPTURED[name];
      const { emptying, final, complete } = landmarks(turn);
      expect(emptying, name).toBeGreaterThan(0);
      expect(final, name).toBeGreaterThan(emptying);
      expect(complete.trim(), name).not.toBe("");
      const delta = payloadOf(turn.entries[emptying]!);
      expect(delta.deltaText, name).toBe("");
      // 22 to 732 ms on the whole run; these four are 26 to 155 ms.
      const gap = turn.entries[final]!.receivedAt - turn.entries[emptying]!.receivedAt;
      expect(gap, name).toBeGreaterThanOrEqual(20);
      // The terminal says so itself: a complete `content`, and a display tail that holds
      // no text (a widget turn keeps its canvas block there).
      const display = (payloadOf(turn.entries[final]!).message as { openclawDisplayContent?: unknown })
        .openclawDisplayContent;
      expect(Array.isArray(display), name).toBe(true);
      expect(messageText({ content: display }), name).toBe("");
    }
  });

  it("the visible text row of the run arrives on the other socket, before the delta or just after", () => {
    const order = (name: (typeof TURNS)[number]): number => {
      const turn = CAPTURED[name];
      const { emptying } = landmarks(turn);
      const row = turn.entries.findLastIndex(
        (e) =>
          e.socket === "session-events" &&
          messageText((payloadOf(e).message as { content?: unknown }) ?? null).trim() !== "" &&
          (payloadOf(e).message as { role?: string }).role === "assistant",
      );
      return row - emptying;
    };
    expect(order("longReply")).toBeLessThan(0);
    expect(order("toolsThenReply")).toBeLessThan(0);
    expect(order("rowAfterEmptying")).toBeGreaterThan(0);
  });

  for (const rows of [true, false]) {
    const mode = rows ? "with the transcript's rows" : "without the transcript's rows";
    for (const name of SENT) {
      it(`${name}, ${mode}: at no observable instant is the bubble empty, shortened or doubled`, async () => {
        const turn = CAPTURED[name];
        const { emptying, final, complete } = landmarks(turn);
        const { writer, afterEntry } = await replayTurn(turn, { rows });
        expect(writer.text.size, "one bubble").toBe(1);
        const [id] = [...writer.text.keys()] as [string];
        const live = writer.live(id);
        expect(live.length).toBeGreaterThan(0);

        // Never empty once a text was shown.
        expect(writer.blanked()).toEqual([]);
        // Never shortened: each text a reader saw is the previous one, extended.
        for (let i = 1; i < live.length; i++) {
          expect(live[i]!.text.startsWith(live[i - 1]!.text), `state ${i} of ${name}`).toBe(true);
        }
        // Never doubled: every text a reader saw is the beginning of the complete answer.
        const end = writer.finals.get(id)!;
        expect(end.status).toBe("complete");
        for (const [i, s] of live.entries()) {
          expect(end.text.startsWith(s.text), `state ${i} of ${name}`).toBe(true);
        }
        expect(writer.refused).toEqual([]);
        // WHICH rule kept the text. With the row, the text changed carrier: nothing about
        // it is rewritten, and the final lands as on a gateway that never withdrew it.
        // Without it, the emptying is carried by the write that replaces the text shown.
        expect(live.filter((s) => s.declared).length, "declared rewrites").toBe(rows ? 0 : 1);

        // The window itself, frame by frame: from the emptying delta up to the final the
        // bubble shows what it showed just before the delta.
        const before = afterEntry[emptying - 1]!;
        expect(before.trim()).not.toBe("");
        for (let i = emptying; i < final; i++) {
          expect(afterEntry[i], `after frame ${i} of ${name}`).toBe(before);
        }
        // …and that text is the complete answer the terminal then states (a `MEDIA:` line
        // is held back while live and leaves at the final).
        expect(complete.startsWith(before.trimEnd())).toBe(true);
      });
    }
  }

  it("the row reaches the run manager through the reconciler, once per visible text row of the run", async () => {
    // toolsThenReply: two tool-call rows (not visible), tool results, then the text row.
    const { rows } = await replayTurn(CAPTURED.toolsThenReply, { rows: true });
    expect(rows).toEqual([{ runId: CAPTURED.toolsThenReply.runId, seq: 44 }]);
  });

  // Two `message`-tool sends are recorded mid-run as VISIBLE rows of the run (delivery
  // mirrors) and withdraw nothing from the stream; the run's own answer streams after
  // them, is recorded, and only then is the stream emptied.
  it("messageToolRows: mirror rows recorded mid-run change nothing, and the answer keeps its text once recorded", () => {
    const turn = CAPTURED.messageToolRows;
    const { emptying, final, complete } = landmarks(turn);
    const n = new Normalizer(turn.sessionKey, null);
    const baselines = new LiveTextBaselines();
    const base = turn.entries[0]!.receivedAt;
    n.beginTurn(1000);
    n.noteRunStarted(turn.runId, 1000);
    const noted: number[] = [];
    let listener: SessionEventListener | null = null;
    const shadow = new TranscriptShadow({
      chatId: "c1",
      sessionKey: turn.sessionKey,
      readHistory: async () => ({ kind: "delta", messages: [], deltaCursor: "c:1", sessionInfo: {} }),
      apply: async () => {},
      events: { attach: (_k, l) => ((listener = l), () => undefined) },
      onAssistantRow: (row) => {
        noted.push(row.seq);
        n.noteAssistantRowRecorded([row.runId!], row.seq);
      },
      sleep: async () => {},
      now: () => 1000,
      log: () => {},
    });
    shadow.configure({});
    const shownAfter: string[] = [];
    const empties: number[] = [];
    turn.entries.forEach((entry, i) => {
      if (entry.socket === "session-events") listener!.onSessionMessage(payloadOf(entry));
      else {
        const events = n.feed(baselines.project(entry.frame).frame, 1000 + (entry.receivedAt - base) / 1000);
        if (events.some((e) => e.type === "message.snapshot" && e.text === "")) empties.push(i);
      }
      shownAfter.push(n.text);
    });
    shadow.close();
    expect(noted).toEqual([150, 156, 158]);
    expect(empties).toEqual([]);
    const before = shownAfter[emptying - 1]!;
    expect(before).toBe(complete);
    for (let i = emptying; i <= final; i++) expect(shownAfter[i], `after frame ${i}`).toBe(before);
  });
});

describe("golden corpus 2026.10.33 — every scenario of the validated run", () => {
  const corpus = loadCorpus().filter((fx) => fx.version === "2026.10.33");

  it("holds the emptying delta in most scenarios (non-vacuity)", () => {
    const withEmptying = corpus.filter((fx) =>
      fx.entries.some((e) => {
        const f = e.frame as { event?: string; payload?: Record<string, unknown> };
        return (
          f.event === "chat" &&
          f.payload?.state === "delta" &&
          f.payload.replace === true &&
          messageText(f.payload.message) === ""
        );
      }),
    );
    expect(corpus.length).toBeGreaterThan(20);
    expect(withEmptying.length).toBeGreaterThan(20);
  });

  for (const fx of corpus) {
    it(`${fx.header.scenario}: no bubble goes empty after showing a text`, async () => {
      const writer = await replay(fx, new LiveBubbles());
      expect(writer.blanked()).toEqual([]);
    });
  }
});

// --- The normalizer's rules, on hand-built frames --------------------------------------
//
// Hand-built in the shapes captured above and in upstream's own wire tests
// (src/gateway/server-chat.wire.test.ts "replaces committed live text and preserves an
// indented tail": text, recording, `replace: true` tail, appends, complete final).

describe("normalizer — an emptied stream (hand-built frames)", () => {
  const SK = "agent:main:atrium:chat:u-1:c-1";
  const RUN = "webchat-run-1";

  function turn(): { n: Normalizer; at: () => number } {
    const n = new Normalizer(SK, null);
    let now = 1000;
    n.beginTurn(now);
    n.noteRunStarted(RUN, now);
    return { n, at: () => (now += 0.01) };
  }
  const delta = (text: string, seq: number, extra: Record<string, unknown> = {}) => ({
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
  const emptying = (seq: number) => delta("", seq, { replace: true });
  const final = (seq: number, text?: string) => ({
    event: "chat",
    payload: {
      sessionKey: SK,
      runId: RUN,
      seq,
      state: "final",
      ...(text === undefined
        ? {}
        : { message: { role: "assistant", content: [{ type: "text", text }], openclawDisplayContent: [] } }),
    },
  });
  /** What the sink would write, in order. */
  const writes = (events: BridgeEvent[]) =>
    events
      .filter((e) => e.type === "message.snapshot" || e.type === "message.delta" || e.type === "message.final")
      .map((e) => ({
        type: e.type,
        text: e.text,
        ...(e.replace === true ? { replace: true } : {}),
      }));

  it("recorded, the row first: nothing is written and the text stays the bubble's", () => {
    const { n, at } = turn();
    n.feed(delta("The answer.", 5), at());
    n.noteAssistantRowRecorded([RUN], 7);
    expect(writes(n.feed(emptying(6), at()))).toEqual([]);
    expect(n.text).toBe("The answer.");
    expect(writes(n.feed(final(8, "The answer."), at()))).toEqual([
      { type: "message.snapshot", text: "The answer." },
      { type: "message.final", text: "The answer." },
    ]);
  });

  it("recorded, the row just after: nothing is written either", () => {
    const { n, at } = turn();
    n.feed(delta("The answer.", 5), at());
    expect(writes(n.feed(emptying(6), at()))).toEqual([]);
    n.noteAssistantRowRecorded([RUN], 7);
    expect(n.text).toBe("The answer.");
    expect(writes(n.feed(final(8, "The answer."), at()))).toEqual([
      { type: "message.snapshot", text: "The answer." },
      { type: "message.final", text: "The answer." },
    ]);
  });

  it("no row at all: the emptying is not written alone — the complete final replaces the text", () => {
    const { n, at } = turn();
    n.feed(delta("The answer.", 5), at());
    expect(writes(n.feed(emptying(6), at()))).toEqual([]);
    expect(writes(n.feed(final(8, "The answer."), at()))).toEqual([
      { type: "message.snapshot", text: "The answer.", replace: true },
      { type: "message.final", text: "The answer." },
    ]);
  });

  // Upstream's retraction, frame for frame (server-chat.agent-events.test.ts): the visible
  // item, the emptying, a final with NO message.
  it("a REAL retraction stays one: taken back and never recorded, the bubble ends empty", () => {
    const { n, at } = turn();
    n.feed(delta("Provisional answer", 1), at());
    expect(writes(n.feed(emptying(2), at()))).toEqual([]);
    expect(n.text).toBe("");
    expect(writes(n.feed(final(3), at()))).toEqual([
      { type: "message.snapshot", text: "", replace: true },
      { type: "message.final", text: "" },
    ]);
  });

  it("a real retraction followed by another text: the new text replaces the old in ONE write", () => {
    const { n, at } = turn();
    n.feed(delta("A first attempt that is rather long.", 1), at());
    expect(writes(n.feed(emptying(2), at()))).toEqual([]);
    expect(writes(n.feed(delta("Retry.", 3, { replace: true }), at()))).toEqual([
      { type: "message.snapshot", text: "Retry.", replace: true },
    ]);
    // …also when the gateway does not mark that text `replace` (the buffer's first delta).
    const second = turn();
    second.n.feed(delta("A first attempt that is rather long.", 1), second.at());
    second.n.feed(emptying(2), second.at());
    expect(writes(second.n.feed(delta("Retry.", 3), second.at()))).toEqual([
      { type: "message.snapshot", text: "Retry.", replace: true },
    ]);
    expect(second.n.text).toBe("Retry.");
  });

  it("recorded MID-RUN: the text stays, and the stream's next text is shown after it", () => {
    const { n, at } = turn();
    n.feed(delta("Saved.", 1), at());
    n.noteAssistantRowRecorded([RUN], 2);
    expect(writes(n.feed(emptying(2), at()))).toEqual([]);
    // The stream restarts from nothing: `replace: true` with the tail, then appends
    // (rebuilt as cumulative by the connection, live-text-baseline.ts).
    expect(writes(n.feed(delta("More", 3, { replace: true }), at()))).toEqual([
      { type: "message.snapshot", text: "Saved.\n\nMore", replace: true },
    ]);
    expect(writes(n.feed(delta("More text.", 4), at()))).toEqual([
      { type: "message.snapshot", text: "Saved.\n\nMore text." },
    ]);
    // The second message is recorded in turn, then the terminal states the whole.
    n.noteAssistantRowRecorded([RUN], 4);
    expect(writes(n.feed(emptying(5), at()))).toEqual([]);
    expect(n.text).toBe("Saved.\n\nMore text.");
    expect(writes(n.feed(final(6, "Saved.\n\nMore text."), at()))).toEqual([
      { type: "message.snapshot", text: "Saved.\n\nMore text." },
      { type: "message.final", text: "Saved.\n\nMore text." },
    ]);
  });

  it("the boundary is the gateway's own: padded to a blank line, never more", () => {
    for (const [recorded, shown] of [
      ["One.", "One.\n\nTwo."],
      ["One.\n", "One.\n\nTwo."],
      ["One.\n\n", "One.\n\nTwo."],
    ] as const) {
      const { n, at } = turn();
      n.feed(delta(recorded, 1), at());
      n.noteAssistantRowRecorded([RUN], 2);
      n.feed(emptying(2), at());
      n.feed(delta("Two.", 3, { replace: true }), at());
      expect(n.text).toBe(shown);
    }
  });

  it("a row the stream outlived says nothing about a later emptying", () => {
    // A `message`-tool send is recorded as a visible row and withdraws nothing from the
    // stream (captured: messageToolRows); the run's own text then streams.
    const { n, at } = turn();
    n.noteAssistantRowRecorded([RUN], 2);
    n.feed(delta("The run's own answer.", 3), at());
    expect(writes(n.feed(emptying(4), at()))).toEqual([]);
    // Not known to be recorded: the text held is emptied, as before.
    expect(n.text).toBe("");
    expect(writes(n.feed(final(5), at()))).toEqual([
      { type: "message.snapshot", text: "", replace: true },
      { type: "message.final", text: "" },
    ]);
  });

  it("the same row read twice is one row", () => {
    const { n, at } = turn();
    n.feed(delta("One.", 1), at());
    n.noteAssistantRowRecorded([RUN], 2);
    n.feed(emptying(2), at());
    n.feed(delta("Two.", 3, { replace: true }), at());
    n.noteAssistantRowRecorded([RUN], 2); // the row again (a duplicate delivery)
    expect(writes(n.feed(emptying(4), at()))).toEqual([]);
    // Row 2 recorded "One." only: "Two." was emptied with no row of its own.
    expect(n.text).toBe("One.");
  });

  it("a row of another run is not this bubble's", () => {
    const { n, at } = turn();
    n.feed(delta("The answer.", 5), at());
    n.noteAssistantRowRecorded(["some-other-run"], 7);
    expect(writes(n.feed(emptying(6), at()))).toEqual([]);
    expect(n.text).toBe("");
  });

  it("a steer cut settles the bubble: what was recorded before it is not the next segment's", () => {
    const { n, at } = turn();
    n.feed(delta("Before the cut.", 1), at());
    n.noteAssistantRowRecorded([RUN], 2);
    n.feed(emptying(2), at());
    n.splitSegment();
    expect(writes(n.feed(delta("After.", 3, { replace: true }), at()))).toEqual([
      { type: "message.snapshot", text: "After.", replace: true },
    ]);
    // …and an emptying still unwritten at the cut is the settled bubble's, not this one's.
    const held = turn();
    held.n.feed(delta("Before the cut.", 1), held.at());
    held.n.feed(emptying(2), held.at());
    held.n.splitSegment();
    expect(writes(held.n.feed(delta("After.", 3), held.at()))).toEqual([
      { type: "message.snapshot", text: "After." },
    ]);
  });

  it("an emptying that is not fresh is still not read (a copy from another socket)", () => {
    const { n, at } = turn();
    n.feed(delta("The answer.", 5), at());
    expect(writes(n.feed(emptying(5), at()))).toEqual([]);
    expect(n.text).toBe("The answer.");
    expect(writes(n.feed(final(8), at()))).toEqual([{ type: "message.final", text: "The answer." }]);
  });
});

// --- The reader of the transcript event -------------------------------------------------

describe("TranscriptShadow — which rows are handed over as recorded", () => {
  const KEY = "agent:alice:atrium:chat:u:c1";

  function rig() {
    let listener: SessionEventListener | null = null;
    const rows: Array<{ runId?: string; seq: number }> = [];
    const shadow = new TranscriptShadow({
      chatId: "c1",
      sessionKey: KEY,
      readHistory: async () => ({
        kind: "delta",
        // A read brings a row back: never handed over as freshly recorded.
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "read back" }],
            __openclaw: { id: "a9", seq: 9, runId: "run-1" },
          },
        ],
        deltaCursor: "c:9",
        sessionInfo: {},
      }),
      apply: async () => {},
      events: {
        attach: (_k, l) => {
          listener = l;
          return () => {
            listener = null;
          };
        },
      },
      onAssistantRow: (row) => rows.push({ runId: row.runId, seq: row.seq }),
      sleep: async () => {},
      now: () => 1000,
      log: () => {},
    });
    const flush = async () => {
      for (let i = 0; i < 20; i++) {
        await shadow.idle();
        await new Promise((r) => setTimeout(r, 0));
      }
    };
    return { shadow, rows, flush, send: (message: unknown) => listener!.onSessionMessage({ sessionKey: KEY, sessionId: "s-1", message }) };
  }
  const row = (seq: number, content: unknown[], extra: Record<string, unknown> = {}) => ({
    role: "assistant",
    content,
    __openclaw: { id: `a${seq}`, seq, runId: "run-1" },
    ...extra,
  });

  it("a visible assistant row of a run is handed over; no other row is", async () => {
    const r = rig();
    r.shadow.configure({});
    await r.flush();
    r.send(row(2, [{ type: "toolCall", id: "t1", name: "exec", arguments: {} }]));
    r.send(row(3, [{ type: "text", text: "NO_REPLY" }]));
    r.send({ role: "user", content: "hello", __openclaw: { id: "u4", seq: 4, idempotencyKey: "s:user" } });
    r.send({ role: "assistant", content: [{ type: "text", text: "no run" }], __openclaw: { id: "a5", seq: 5 } });
    r.send(row(6, [{ type: "thinking", thinking: "…" }]));
    r.send(row(7, [{ type: "text", text: "The answer." }]));
    await r.flush();
    expect(r.rows).toEqual([{ runId: "run-1", seq: 7 }]);
  });
});

// --- The run manager's hand-over ---------------------------------------------------------

describe("RunManager.onAssistantRow — in the frames' order", () => {
  const SK = "agent:main:atrium:chat:u-1:c-1";
  const RUN = "webchat-run-1";
  const chat = (payload: Record<string, unknown>) => ({
    type: "event",
    event: "chat",
    payload: { sessionKey: SK, runId: RUN, ...payload },
  });
  const text = (t: string) => ({ role: "assistant", content: [{ type: "text", text: t }] });

  it("a row noted between two frames is read between them", async () => {
    const writer = new LiveBubbles();
    const manager = new RunManager("chat-1", SK, writer);
    await manager.beginTurn(1000, RUN);
    // Not awaited one by one: the three are queued together, as frames and a row that
    // arrive while a write is still in flight.
    const queued = [
      manager.feed(chat({ seq: 1, state: "delta", deltaText: "The answer.", message: text("The answer.") }), 1000.01),
      manager.onAssistantRow({ runId: RUN, seq: 12 }),
      manager.feed(chat({ seq: 2, state: "delta", deltaText: "", replace: true, message: text("") }), 1000.02),
    ];
    await Promise.all(queued);
    expect(writer.blanked()).toEqual([]);
    expect([...writer.text.values()]).toEqual(["The answer."]);
    await manager.feed(chat({ seq: 3, state: "final", message: text("The answer.") }), 1000.05);
    await manager.completionsIdle();
    expect(writer.refused).toEqual([]);
    // Read out of order, the row would precede the text it records and say nothing about
    // the emptying: the final would then carry the emptying's declaration.
    expect(writer.states.filter((s) => s.declared)).toEqual([]);
    expect([...writer.finals.values()]).toEqual([{ status: "complete", text: "The answer." }]);
  });

  it("a row with no run is nobody's", async () => {
    const manager = new RunManager("chat-1", SK, new LiveBubbles());
    await manager.beginTurn(1000, RUN);
    await expect(manager.onAssistantRow({ seq: 3 })).resolves.toBeUndefined();
  });
});
