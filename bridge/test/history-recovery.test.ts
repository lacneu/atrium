// The webchat sink: recovery of gateway-delivered message-tool replies.
// Pure-extractor tests + normalizer wiring (flag → wantsHistoryRecovery →
// recoverVisibleText), pinned against the bench-captured 2026.6.5 shapes.
import { describe, expect, it } from "vitest";
import {
  extractLatestAssistantReply, extractMessageToolReplies } from "../src/providers/openclaw/history-recovery.js";
import { Normalizer } from "../src/providers/openclaw/normalizer.js";

const deliveryResult = (text: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    status: "ok",
    deliveryStatus: "sent",
    channel: "webchat",
    target: "current-run",
    sourceReplyDeliveryMode: "message_tool_only",
    sourceReplySink: "internal-ui",
    sourceReply: { text },
    ...extra,
  });

const toolResultEntry = (resultJson: string) => ({
  role: "toolResult",
  toolName: "message",
  content: [{ type: "toolResult", text: resultJson }],
});

describe("extractMessageToolReplies (pure)", () => {
  it("extracts the delivered text from a bench-shaped transcript", () => {
    const payload = {
      messages: [
        { role: "user", content: "Cherche les actualités…" },
        toolResultEntry(deliveryResult("Voici les 10 faits IA…")),
        { role: "assistant", content: [{ type: "text", text: "Envoyé dans le webchat." }] },
      ],
    };
    expect(extractMessageToolReplies(payload)).toBe("Voici les 10 faits IA…");
  });

  it("joins multiple deliveries of the SAME turn in chronological order", () => {
    const payload = {
      messages: [
        { role: "user", content: "long ask" },
        toolResultEntry(deliveryResult("part one")),
        toolResultEntry(deliveryResult("part two")),
      ],
    };
    expect(extractMessageToolReplies(payload)).toBe("part one\n\npart two");
  });

  it("stops at the current-turn boundary (earlier turns never leak)", () => {
    const payload = {
      messages: [
        toolResultEntry(deliveryResult("PREVIOUS turn delivery")),
        { role: "user", content: "new ask" },
        toolResultEntry(deliveryResult("current delivery")),
      ],
    };
    expect(extractMessageToolReplies(payload)).toBe("current delivery");
  });

  it("ignores real external deliveries (telegram channel / explicit target)", () => {
    const payload = {
      messages: [
        { role: "user", content: "ask" },
        toolResultEntry(deliveryResult("to telegram", { channel: "telegram" })),
        toolResultEntry(deliveryResult("to a peer", { target: "telegram:12345" })),
      ],
    };
    expect(extractMessageToolReplies(payload)).toBe("");
  });

  it("ignores non-sent deliveries, malformed JSON and foreign tools", () => {
    const payload = {
      messages: [
        { role: "user", content: "ask" },
        toolResultEntry(deliveryResult("failed one", { deliveryStatus: "error" })),
        toolResultEntry("{not json"),
        { role: "toolResult", toolName: "web_search", content: [{ text: deliveryResult("x") }] },
      ],
    };
    expect(extractMessageToolReplies(payload)).toBe("");
  });

  it("returns empty on hostile/empty payload shapes", () => {
    expect(extractMessageToolReplies(null)).toBe("");
    expect(extractMessageToolReplies({})).toBe("");
    expect(extractMessageToolReplies({ messages: "nope" })).toBe("");
  });
});

// -- normalizer wiring --------------------------------------------------------

const KEY = "agent:agent-a:atrium:chat:u-x:chat1";

const itemFrame = () => ({
  type: "event",
  event: "agent",
  payload: {
    sessionKey: KEY,
    stream: "item",
    data: {
      itemId: "i1",
      phase: "start",
      kind: "tool",
      name: "message",
      title: "message",
      status: "running",
      suppressChannelProgress: true,
    },
  },
});

const ackFinalFrame = (runId: string) => ({
  type: "event",
  event: "chat",
  payload: {
    runId,
    sessionKey: KEY,
    seq: 9,
    state: "final",
    message: { role: "assistant", content: [{ type: "text", text: "Envoyé dans le webchat." }] },
  },
});

describe("normalizer history-recovery wiring", () => {
  it("flags the 6.5 message-tool item and requests recovery on an ack-only final", () => {
    const n = new Normalizer(KEY);
    n.beginTurn(0);
    n.noteRunStarted("r1", 0);
    n.feed(itemFrame(), 1);
    expect(n.wantsHistoryRecovery).toBe(false); // no grace armed yet
    n.feed(ackFinalFrame("r1"), 2);
    expect(n.finalized).toBe(false); // ack is grace-held, not finalized
    expect(n.wantsHistoryRecovery).toBe(true);
    n.markRecoveryAttempted();
    expect(n.wantsHistoryRecovery).toBe(false); // one-shot
  });

  it("recoverVisibleText applies the snapshot and finalizes the turn", () => {
    const n = new Normalizer(KEY);
    n.beginTurn(0);
    n.noteRunStarted("r1", 0);
    n.feed(itemFrame(), 1);
    n.feed(ackFinalFrame("r1"), 2);
    const events = n.recoverVisibleText("Voici les 10 faits IA…", 3);
    const types = events.map((e) => (e as { type: string }).type);
    expect(types).toContain("message.snapshot");
    expect(types).toContain("message.final");
    expect(n.finalized).toBe(true);
    const final = events.find((e) => (e as { type: string }).type === "message.final") as {
      text?: string;
    };
    expect(final?.text).toContain("Voici les 10 faits IA…");
  });

  it("never requests recovery without a message-tool item (plain ack turns keep today's behavior)", () => {
    const n = new Normalizer(KEY);
    n.beginTurn(0);
    n.noteRunStarted("r1", 0);
    n.feed(ackFinalFrame("r1"), 2);
    expect(n.wantsHistoryRecovery).toBe(false);
    // grace expiry still degrades to the ack (unchanged fallback)
    const events = n.tick(100);
    expect(n.finalized).toBe(true);
    const final = events.find((e) => (e as { type: string }).type === "message.final") as {
      text?: string;
    };
    expect(final?.text).toBe("Envoyé dans le webchat.");
  });

  it("recoverVisibleText is a no-op after the grace already flushed", () => {
    const n = new Normalizer(KEY);
    n.beginTurn(0);
    n.noteRunStarted("r1", 0);
    n.feed(itemFrame(), 1);
    n.feed(ackFinalFrame("r1"), 2);
    n.tick(100); // grace expired → finalized with ack
    expect(n.finalized).toBe(true);
    expect(n.recoverVisibleText("late text", 101)).toEqual([]);
  });
});

describe("extractLatestAssistantReply (restart-recovery transcript scan)", () => {
  it("returns the assistant reply AFTER the last user entry", () => {
    const payload = {
      messages: [
        { role: "user", content: "vieille question" },
        { role: "assistant", content: "vieille réponse" },
        { role: "user", content: "question du tour" },
        { role: "toolResult", toolName: "exec", content: "sortie outil" },
        { role: "assistant", content: [{ text: "réponse du run repris" }] },
      ],
    };
    expect(extractLatestAssistantReply(payload)).toBe("réponse du run repris");
  });

  it("returns empty while the resumed run has not answered yet (no assistant after user)", () => {
    const payload = {
      messages: [
        { role: "assistant", content: "réponse du tour PRÉCÉDENT" },
        { role: "user", content: "question du tour" },
        { role: "toolResult", toolName: "exec", content: "en cours" },
      ],
    };
    expect(extractLatestAssistantReply(payload)).toBe("");
  });

  it("never leaks a PREVIOUS turn's reply (user boundary respected)", () => {
    const payload = {
      messages: [
        { role: "assistant", content: "ancienne réponse" },
        { role: "user", content: "nouvelle question" },
      ],
    };
    expect(extractLatestAssistantReply(payload)).toBe("");
  });

  it("joins multiple assistant entries chronologically; tolerates malformed payloads", () => {
    expect(
      extractLatestAssistantReply({
        messages: [
          { role: "user", content: "q" },
          { role: "assistant", content: "partie 1" },
          { role: "assistant", content: "partie 2" },
        ],
      }),
    ).toBe("partie 1\n\npartie 2");
    expect(extractLatestAssistantReply(null)).toBe("");
    expect(extractLatestAssistantReply({ messages: "garbage" })).toBe("");
  });
});

// --- G-16: an unreadable message-tool call is never silent -------------------
// The message tool IS the visible-reply mechanism. When its `args` cannot be
// read, the reply text may exist only in the transcript — the same situation as
// a gateway-run message tool, so it must arm the same recovery, and it must NAME
// itself if the turn still ends with nothing.
const toolStartFrame = (args: unknown) => ({
  type: "event",
  event: "agent",
  payload: {
    sessionKey: KEY,
    stream: "tool",
    data: { name: "message", phase: "start", args },
  },
});

describe("G-16: message-tool args we cannot read", () => {
  it("UNREADABLE args (malformed JSON) arm the transcript recovery instead of a blank turn", () => {
    const n = new Normalizer(KEY);
    n.beginTurn(0);
    n.noteRunStarted("r1", 0);
    n.feed(toolStartFrame('{"message": "half a paylo'), 1);
    n.feed(ackFinalFrame("r1"), 2);
    expect(n.wantsHistoryRecovery).toBe(true);
  });

  it("a DELIBERATE non-reply (explicit external channel) does NOT arm recovery", () => {
    const n = new Normalizer(KEY);
    n.beginTurn(0);
    n.noteRunStarted("r1", 0);
    n.feed(
      toolStartFrame({ action: "send", channel: "telegram", message: "for someone else" }),
      1,
    );
    n.feed(ackFinalFrame("r1"), 2);
    // Readable args that simply are not this conversation's reply: nothing was
    // lost, so claiming a recovery is needed would be a false alarm.
    expect(n.wantsHistoryRecovery).toBe(false);
  });

  it("the final event carries the unreadable count so the empty verdict can NAME its cause", () => {
    const n = new Normalizer(KEY);
    n.beginTurn(0);
    n.noteRunStarted("r1", 0);
    n.feed(toolStartFrame("]not json at all["), 1);
    const ev = n.endTurn(3, "final", null, "recv_timeout");
    const final = ev.find((e) => e.type === "message.final");
    expect(final).toMatchObject({ msgtoolArgsUnreadable: 1 });
  });

  it("a new turn clears the count (turn N must not label turn N+1)", () => {
    const n = new Normalizer(KEY);
    n.beginTurn(0);
    n.noteRunStarted("r1", 0);
    n.feed(toolStartFrame("]not json at all["), 1);
    n.beginTurn(4);
    n.noteRunStarted("r2", 4);
    const final = n.endTurn(5, "final", null, "recv_timeout").find(
      (e) => e.type === "message.final",
    );
    expect(final).toMatchObject({ msgtoolArgsUnreadable: 0 });
  });
});

// --- G-13: a final the gateway already CUT ----------------------------------
// `broadcastChatFinal` runs the reply through the DISPLAY projection, whose cap
// is 8 000 chars + the marker below (verified in the deployed 2026.7.1 build).
// Nothing detected it: the cut text was persisted as the answer, marker and all.
const MARKER = "\n...(truncated)...";

const truncatedFinalFrame = (runId: string, body: string) => ({
  type: "event",
  event: "chat",
  payload: {
    runId,
    sessionKey: KEY,
    seq: 9,
    state: "final",
    message: {
      role: "assistant",
      content: [{ type: "text", text: body + MARKER }],
    },
  },
});

describe("G-13: a gateway-truncated chat final", () => {
  it("does NOT close the turn, and stays eligible for transcript recovery even though it holds text", () => {
    const n = new Normalizer(KEY);
    n.beginTurn(0);
    n.noteRunStarted("r1", 0);
    const ev = n.feed(truncatedFinalFrame("r1", "a".repeat(8000)), 1);
    // The cut text IS shown (better than a blank bubble)...
    const snap = ev.find((e) => e.type === "message.snapshot");
    expect(String(snap?.text ?? "").length).toBeGreaterThan(8000);
    // ...but the turn is NOT finalized on it, and the recovery is armed — the one
    // case where already having an answer must not stop us looking for it.
    expect(n.finalized).toBe(false);
    expect(n.wantsHistoryRecovery).toBe(true);
  });

  it("the recovered FULL text replaces the cut one and closes the turn", () => {
    const n = new Normalizer(KEY);
    n.beginTurn(0);
    n.noteRunStarted("r1", 0);
    n.feed(truncatedFinalFrame("r1", "a".repeat(8000)), 1);
    n.markRecoveryAttempted();
    const ev = n.recoverVisibleText("a".repeat(8000) + "THE REST OF THE ANSWER", 2);
    const snap = ev.find((e) => e.type === "message.snapshot");
    expect(String(snap?.text)).toContain("THE REST OF THE ANSWER");
    expect(String(snap?.text)).not.toContain("(truncated)");
    expect(n.finalized).toBe(true);
  });

  it("when the recovery brings nothing back, the grace finalizes with the cut text (never an open turn)", () => {
    const n = new Normalizer(KEY);
    n.beginTurn(0);
    n.noteRunStarted("r1", 0);
    n.feed(truncatedFinalFrame("r1", "a".repeat(8000)), 1);
    n.markRecoveryAttempted();
    const ev = n.tick(1 + 21); // past TRUNCATED_FINAL_GRACE
    const final = ev.find((e) => e.type === "message.final");
    expect(n.finalized).toBe(true);
    expect(final).toMatchObject({
      diagnosticFinalizeCause: "truncated_final_grace",
      truncatedFinals: 1,
    });
  });

  it("a compaction reset CANCELS the truncated-final wait (codex P2)", () => {
    const n = new Normalizer(KEY);
    n.beginTurn(0);
    n.noteRunStarted("r1", 0);
    n.feed(truncatedFinalFrame("r1", "a".repeat(8000)), 1);
    // The gateway then abandons the run to compact: the cut final is invalidated
    // and the replay is in flight…
    n.feed(
      {
        type: "event",
        event: "agent",
        payload: {
          sessionKey: KEY,
          runId: "r1",
          stream: "lifecycle",
          data: { phase: "end", livenessState: "abandoned", replayInvalid: true },
        },
      },
      2,
    );
    // …so the 20 s wait armed by that final must not close the turn under it.
    n.tick(2 + 21);
    expect(n.finalized).toBe(false);
  });

  it("codex P1: an already-armed lifecycle grace does not finalize the cut text first", () => {
    const n = new Normalizer(KEY);
    n.beginTurn(0);
    n.noteRunStarted("r1", 0);
    // The gateway ends the run (10 s follow-on grace armed) and THEN sends the
    // truncated final — a frame order this normalizer handles explicitly.
    n.feed(
      {
        type: "event",
        event: "agent",
        payload: {
          sessionKey: KEY,
          runId: "r1",
          stream: "lifecycle",
          data: { phase: "end", stopReason: "stop", livenessState: "working" },
        },
      },
      1,
    );
    n.feed(truncatedFinalFrame("r1", "a".repeat(8000)), 2);
    // The recovery RPC alone may take 10 s: the 10 s lifecycle grace must not
    // close the turn on the cut text before it can answer.
    n.tick(2 + 11);
    expect(n.finalized).toBe(false);
    expect(n.wantsHistoryRecovery).toBe(true);
  });

  it("codex P2: a SHORT reply that merely ends with the marker is not a truncation", () => {
    const n = new Normalizer(KEY);
    n.beginTurn(0);
    n.noteRunStarted("r1", 0);
    // An agent quoting a log excerpt, or told to end that way: the body is
    // nowhere near the projection cap, so nothing was cut.
    n.feed(truncatedFinalFrame("r1", "tail of the log"), 1);
    expect(n.finalized).toBe(true);
    expect(n.wantsHistoryRecovery).toBe(false);
  });

  it("an UNtruncated final is untouched: it finalizes immediately as before", () => {
    const n = new Normalizer(KEY);
    n.beginTurn(0);
    n.noteRunStarted("r1", 0);
    n.feed(
      {
        type: "event",
        event: "chat",
        payload: {
          runId: "r1",
          sessionKey: KEY,
          seq: 9,
          state: "final",
          message: { role: "assistant", content: [{ type: "text", text: "short answer" }] },
        },
      },
      1,
    );
    expect(n.finalized).toBe(true);
    expect(n.wantsHistoryRecovery).toBe(false);
  });
});
