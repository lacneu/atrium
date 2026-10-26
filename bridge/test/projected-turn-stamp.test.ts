// 0.102.1 (Codex pass 2): a projected (OpenClaw) turn's bubble is stamped by its OWN bridge
// at the opening — the stuck-stream watchdog reads that stamp (convex/stuckStreams.ts
// `projectedOpenClawBubble`), so a new conversation whose transcript reads all failed is
// covered from its first frame. Any other turn (Hermes) opens exactly as before.

import { describe, expect, it } from "vitest";
import { TurnSink } from "../src/core/turn-sink.js";
import type { ConvexWriter } from "../src/convex-writer.js";

function recordingWriter() {
  const opened: unknown[][] = [];
  const writer = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === "startAssistant") {
          return async (...args: unknown[]) => {
            opened.push(args);
            return "msg-1";
          };
        }
        if (prop === "then") return undefined;
        return async () => undefined;
      },
    },
  ) as unknown as ConvexWriter;
  return { opened, writer };
}

describe("the projected turn says so at the opening", () => {
  it("a projected turn: startAssistant carries { projected: true }", async () => {
    const { opened, writer } = recordingWriter();
    const sink = new TurnSink("chat-1", writer, undefined, "agent:alice:atrium:chat:u:c1");
    await sink.beginTurn("run-1", undefined, false, false, "outbox-1", { projection: true });
    expect(opened).toEqual([["chat-1", "run-1", "agent:alice:atrium:chat:u:c1", "outbox-1", undefined, { projected: true }]]);
  });

  it("any other turn opens with the historical arguments, unchanged", async () => {
    const { opened, writer } = recordingWriter();
    const sink = new TurnSink("chat-1", writer, undefined, "hermes-session");
    await sink.beginTurn("run-1", undefined, false, false, "outbox-1");
    expect(opened).toEqual([["chat-1", "run-1", "hermes-session", "outbox-1"]]);
  });
});
