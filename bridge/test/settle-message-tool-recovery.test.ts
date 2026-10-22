/**
 * A gateway DELIVERY run whose answer went through the MESSAGE TOOL.
 *
 * Bench, OpenClaw 2026.9.6, 2026-09-26 (chat m971j0qw…): alice spawned `files`, yielded,
 * and the gateway woke her with a PRIVATE requester-settle turn. She answered through
 * `message send final:true` called from code mode — nested inside `exec` — then replied
 * NO_REPLY. On a delivery run the bridge receives no `tool` frames, and the silent final
 * carries no message: the answer exists only as the gateway's delivery MIRROR row in the
 * transcript, which the reconciler reads by identity (transcript-rows.ts) — no positional
 * reader of the transcript is involved. What stays pinned here: the `/lossless` reply
 * reader still stops at the settle wake, and an ORDINARY turn reads the same answer off
 * the message tool's args.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { extractLatestAssistantReply } from "../src/providers/openclaw/history-recovery.js";
import type { ConvexWriter } from "../src/convex-writer.js";
import { RunManager } from "../src/providers/openclaw/run-manager.js";

type Json = Record<string, any>;

const TRANSCRIPT = JSON.parse(
  readFileSync(
    new URL("./fixtures/settle-message-tool-transcript.json", import.meta.url),
    "utf-8",
  ),
) as { messages: Json[] };
const FRAMES: Json[] = readFileSync(
  new URL("./fixtures/settle-message-tool-frames.jsonl", import.meta.url),
  "utf-8",
)
  .split("\n")
  .filter((l) => l.trim() !== "" && !l.startsWith("#"))
  .map((l) => JSON.parse(l) as Json);

const ANSWER =
  "SYNTHESE: L’agent files a terminé et indique que la racine de son workspace contient 5 fichiers.";

describe("the transcript of a message-tool answer on a settle run", () => {
  it("the /lossless reply reader stops at the settle wake (an inter-session entry)", () => {
    expect(extractLatestAssistantReply(TRANSCRIPT)).toBe("");
  });
});

function recordingWriter() {
  const calls: unknown[][] = [];
  const writer = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === "then") return undefined;
        return async (...args: unknown[]) => {
          calls.push([String(prop), ...args]);
          if (prop === "startAssistant") return "msgA";
          if (prop === "setSnapshot" || prop === "addMedia") return true;
          if (prop === "getRehydrationContext") return { history: null, turnCount: 0 };
          return undefined;
        };
      },
    },
  ) as unknown as ConvexWriter;
  return { writer, calls };
}

describe("the same sequence on an ORDINARY turn never needed the transcript", () => {
  // Contrast, so the difference between the lanes stays explicit. A turn started by our
  // own chat.send receives `tool` frames, nested calls included (live 2026.9.6 capture:
  // `agents_list` called inside `exec` on a webchat run has its own tool start/result),
  // and the message tool's ARGS are the reply (normalizer `messageToolText`).
  it("exec -> nested message -> silent final: the reply is read off the tool args", async () => {
    const RUN = "webchat-ordinary-turn";
    const SK = FRAMES[0]!.payload.sessionKey as string;
    const retarget = (f: Json): Json => {
      const g = structuredClone(f);
      g.payload.runId = RUN;
      return g;
    };
    const tool = (phase: "start" | "result", name: string, toolCallId: string, args?: Json): Json => ({
      type: "event",
      event: "agent",
      payload: {
        runId: RUN,
        sessionKey: SK,
        stream: "tool",
        data: { phase, name, toolCallId, ...(args ? { args } : {}) },
      },
    });
    const nested = "tool_search_code:call_x_fc_y:message:1";
    const frames: Json[] = [];
    for (const f of FRAMES) {
      if (f.payload.stream === "item") continue; // the ordinary lane's tool frames replace them
      frames.push(retarget(f));
      if (f.payload.stream === "lifecycle" && f.payload.data?.phase === "model" && frames.length < 6) {
        frames.push(
          tool("start", "exec", "call_x|fc_y"),
          tool("start", "message", nested, { action: "send", message: ANSWER, final: true }),
          tool("result", "message", nested),
          tool("result", "exec", "call_x|fc_y"),
        );
      }
    }
    const { writer, calls } = recordingWriter();
    const m = new RunManager("chat-ordinary", SK, writer);
    let now = 1_000;
    await m.beginTurn(now, RUN);
    for (const f of frames) await m.feed(f, (now += 5));
    for (let i = 0; i < 40 && !calls.some((c) => c[0] === "finalize"); i++) {
      await m.tick((now += 1_000));
    }
    const finals = calls.filter((c) => c[0] === "finalize");
    expect(finals).toHaveLength(1);
    expect(finals[0]?.[3]).toBe(ANSWER);
  });
});
