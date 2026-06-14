// The webchat sink: recovery of gateway-delivered message-tool replies.
// Pure-extractor tests + normalizer wiring (flag → wantsHistoryRecovery →
// recoverVisibleText), pinned against the bench-captured 2026.6.5 shapes.
import { describe, expect, it } from "vitest";
import { extractMessageToolReplies } from "../src/providers/openclaw/history-recovery.js";
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

const KEY = "agent:agent-a:webchat:chat:u-x:chat1";

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
