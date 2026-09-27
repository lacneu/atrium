/**
 * A gateway DELIVERY run whose answer went through the MESSAGE TOOL must not arrive empty.
 *
 * Bench, OpenClaw 2026.9.6, 2026-09-26 (chat m971j0qw…): alice spawned `files`, yielded,
 * and the gateway woke her with a PRIVATE requester-settle turn ("Your final reply stays
 * internal… send it through an available, permitted messaging tool… Reply ONLY:
 * NO_REPLY"). She answered through `message send final:true` called from code mode —
 * nested inside `exec` — then replied NO_REPLY. The merged bubble settled
 * `empty_response`, cause `lifecycle_end_timeout`.
 *
 * On a delivery run the bridge receives no `tool` frames (so no message-tool args), and
 * the silent final carries no message (upstream server-chat.ts:1182-1199). The answer
 * exists only as the gateway's delivery MIRROR in the transcript. The recovery was
 * requested and read nothing: both readers stop at the settle wake (an inter-session
 * `user` entry) and the nested call left no top-level `message` result. These tests
 * replay that exact case: its real transcript, and the real 2026.9.6 frame shapes in
 * run 1's order.
 */

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  extractLatestAssistantReply,
  extractMessageToolReplies,
  extractRunDeliveryMirrors,
} from "../src/providers/openclaw/history-recovery.js";
import { SessionRegistry } from "../src/session.js";
import type { BridgeConfig } from "../src/config.js";
import type { ConvexWriter } from "../src/convex-writer.js";
import { OpenClawConnection } from "../src/providers/openclaw/openclaw-client.js";
import { servedMap } from "./helpers/served.js";
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

const SETTLE_RUN =
  "announce:requester-settle:alice:agent:alice:atrium:chat:u-repro:turn-nx7bmraedceyqdp45j32evh5ds8f4vvx:8416c106-8b00-4f09-98ff-adf96089427e:yield-1";
const PARENT_RUN =
  "webchat-78de397259d063cda6808ca1dc857865372aa04e3f65bf8e005d252a4f999b89";
const ANSWER =
  "SYNTHESE: L’agent files a terminé et indique que la racine de son workspace contient 5 fichiers.";

describe("the transcript of a message-tool answer on a settle run", () => {
  it("the two positional readers find NOTHING — the defect, pinned", () => {
    // Both stop at the settle wake: `role:"user"`, provenance inter_session /
    // subagent_settle — and the message call was nested in exec anyway.
    expect(extractMessageToolReplies(TRANSCRIPT)).toBe("");
    expect(extractLatestAssistantReply(TRANSCRIPT)).toBe("");
  });

  it("the run-exact mirror reader returns the delivered answer", () => {
    expect(extractRunDeliveryMirrors(TRANSCRIPT, [SETTLE_RUN])).toBe(ANSWER);
  });

  it("it answers only for the runs it is given", () => {
    expect(extractRunDeliveryMirrors(TRANSCRIPT, [PARENT_RUN])).toBe("");
    expect(extractRunDeliveryMirrors(TRANSCRIPT, [])).toBe("");
    expect(extractRunDeliveryMirrors(TRANSCRIPT, ["webchat-other"])).toBe("");
  });

  it("ownership needs BOTH the gateway's run stamp and that run's message-tool key", () => {
    const mirror = TRANSCRIPT.messages.find((m) => m.model === "delivery-mirror")!;
    const only = (entry: Json) => ({ messages: [entry] });
    expect(extractRunDeliveryMirrors(only(mirror), [SETTLE_RUN])).toBe(ANSWER);
    // A key naming another run's delivery, on an entry stamped with ours.
    expect(
      extractRunDeliveryMirrors(
        only({ ...mirror, idempotencyKey: `${PARENT_RUN}:message-tool:x:1`, __openclaw: { ...mirror.__openclaw, idempotencyKey: undefined } }),
        [SETTLE_RUN],
      ),
    ).toBe("");
    // Our key, on an entry the gateway stamped with ANOTHER run.
    expect(
      extractRunDeliveryMirrors(
        only({ ...mirror, __openclaw: { ...mirror.__openclaw, runId: PARENT_RUN } }),
        [SETTLE_RUN],
      ),
    ).toBe("");
    // Not a mirror: the model's own reply with the same stamps.
    expect(
      extractRunDeliveryMirrors(only({ ...mirror, provider: "openai", model: "gpt-5.5" }), [SETTLE_RUN]),
    ).toBe("");
    // A failed entry is never an answer.
    expect(extractRunDeliveryMirrors(only({ ...mirror, stopReason: "error" }), [SETTLE_RUN])).toBe("");
  });
});

// --- the whole path, through the Session's own consume loop ---------------------------

function fakeConn(reply: unknown) {
  let closed = false;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const requests: string[] = [];
  return {
    requests,
    get isClosed() {
      return closed;
    },
    close() {
      closed = true;
      release();
    },
    onConfigChanged: () => () => {},
    onSessionSharing: () => () => {},
    onClosed: () => () => {},
    async *frames() {
      await gate;
    },
    async request(method: string) {
      requests.push(method);
      return method === "sessions.get" ? { payload: reply } : { payload: {} };
    },
  };
}

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

const config = {
  openclawGatewayUrl: "ws://127.0.0.1:1",
  openclawToken: "t",
  deviceIdentity: { id: "i", publicKey: "p", privateKey: "k" },
} as unknown as BridgeConfig;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("run 1, replayed: exec -> nested message -> NO_REPLY on a requester-settle run", () => {
  it("the merged continuation settles WITH the delivered answer", async () => {
    let now = 1_000;
    const conn = fakeConn(TRANSCRIPT);
    vi.spyOn(OpenClawConnection, "connect").mockImplementation(async () => conn as never);
    const { writer, calls } = recordingWriter();
    const reg = new SessionRegistry(servedMap(config, writer), () => now);
    const s = await reg.acquire({
      chatId: "m971j0qwb9zm3vf8c38zkhf6898f4krs",
      openclawChatId: "turn-nx7bmraedceyqdp45j32evh5ds8f4vvx",
      agentId: "alice",
      canonical: "u-repro",
    });
    await new Promise((r) => setTimeout(r, 10));

    // Between turns: the settle run opens a SPONTANEOUS turn, exactly as on the bench.
    for (const frame of FRAMES) {
      await s.runManager.feed(frame, (now += 5));
    }
    s.wake();
    // The loop's top asks for the recovery; the fake sessions.get answers at once.
    for (let i = 0; i < 20 && !calls.some((c) => c[0] === "finalize"); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(conn.requests).toContain("sessions.get");
    const starts = calls.filter((c) => c[0] === "startAssistant");
    expect(starts).toHaveLength(1);
    expect(starts[0]?.[2]).toBe(SETTLE_RUN);
    const finals = calls.filter((c) => c[0] === "finalize");
    expect(finals).toHaveLength(1);
    expect(finals[0]?.[2]).toBe("complete");
    // The answer the user was really sent — not an empty close for Convex to name.
    expect(finals[0]?.[3]).toBe(ANSWER);
    reg.closeAll();
  });
});

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
