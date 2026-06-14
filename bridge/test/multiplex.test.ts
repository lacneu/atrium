/**
 * Offline tests for the SessionMultiplexer — the Model A risk core: many
 * conversations multiplexed over ONE operator connection, routed by
 * payload.sessionKey. These prove the load-bearing property WITHOUT a live
 * gateway: a frame tagged for one session NEVER produces events for another
 * chat (the per-user isolation boundary, since the Gateway gates by scope, not
 * user — see docs/OPENCLAW_CONNECTION_MODEL.md §Q4).
 *
 * A second session's frames are derived by RE-TAGGING the canonical fixtures
 * (rewriting the sessionKey + runId), so both sessions replay identical, proven
 * scenarios under distinct identities.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { SessionMultiplexer } from "../src/providers/openclaw/multiplex.js";
import { BASE_RECV_TIMEOUT } from "../src/providers/openclaw/normalizer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_PATH = resolve(
  __dirname,
  "./fixtures/openclaw_frames.json",
);
const FIXTURES = JSON.parse(readFileSync(FIXTURES_PATH, "utf-8")) as {
  session_key: string;
  run_id: string;
  scenarios: Record<string, { description: string; frames: unknown[] }>;
};

const SK_A = FIXTURES.session_key;
const RUN_A = FIXTURES.run_id;
const SK_B = "agent:main:webchat:chat:bob:chat_B";
const RUN_B = "run-B-0001";

function frames(scenario: string): unknown[] {
  const s = FIXTURES.scenarios[scenario];
  if (!s) throw new Error(`unknown scenario: ${scenario}`);
  return s.frames;
}

/** Deep-clone a frame, rewriting the canonical sessionKey/runId to a 2nd identity. */
function reTag(value: unknown): unknown {
  if (typeof value === "string") {
    if (value === SK_A) return SK_B;
    if (value === RUN_A) return RUN_B;
    return value;
  }
  if (Array.isArray(value)) return value.map(reTag);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = reTag(v);
    }
    return out;
  }
  return value;
}

/** Collect every event a sequence of emits produced for a given chat. */
function eventsFor(
  emits: { chatId: string; events: Array<Record<string, unknown>> }[],
  chatId: string,
): Array<Record<string, unknown>> {
  return emits.filter((e) => e.chatId === chatId).flatMap((e) => e.events);
}

describe("SessionMultiplexer — Model A isolation", () => {
  it("two interleaved sessions on one mux never cross-talk", () => {
    const mux = new SessionMultiplexer();
    let now = 1000;
    mux.beginSession(SK_A, "chatA", RUN_A, now);
    mux.beginSession(SK_B, "chatB", RUN_B, now);

    const aFrames = frames("chat-final-content");
    const bFrames = aFrames.map(reTag);
    const allEmits: { chatId: string; events: Array<Record<string, unknown>> }[] = [];

    const maxLen = Math.max(aFrames.length, bFrames.length);
    for (let i = 0; i < maxLen; i++) {
      if (i < aFrames.length) {
        const emits = mux.feedFrame(aFrames[i], (now += 0.01));
        // EVERY emit from an A-frame must belong to chatA — never chatB.
        for (const e of emits) expect(e.chatId).toBe("chatA");
        allEmits.push(...(emits as typeof allEmits));
      }
      if (i < bFrames.length) {
        const emits = mux.feedFrame(bFrames[i], (now += 0.01));
        for (const e of emits) expect(e.chatId).toBe("chatB");
        allEmits.push(...(emits as typeof allEmits));
      }
    }

    // Each chat independently reached its own authoritative final.
    const aFinal = eventsFor(allEmits, "chatA").find((e) => e.type === "message.final");
    const bFinal = eventsFor(allEmits, "chatB").find((e) => e.type === "message.final");
    expect(aFinal?.text).toBe("Bonjour !");
    expect(bFinal?.text).toBe("Bonjour !");
    // Both finalized and were reaped.
    expect(mux.activeCount).toBe(0);
  });

  it("a frame for an UNREGISTERED session is dropped (no events)", () => {
    const mux = new SessionMultiplexer();
    mux.beginSession(SK_A, "chatA", RUN_A, 1000);
    const strayFrame = reTag(frames("chat-final-content")[0]); // tagged SK_B, not registered
    expect(mux.feedFrame(strayFrame, 1001)).toEqual([]);
    // chatA's normalizer never saw it.
    expect(mux.activeCount).toBe(1);
  });

  it("min-deadline tick finalizes ONLY the expired session", () => {
    const mux = new SessionMultiplexer();
    // A: delta turn fed around t=1000 -> deadline ~1180.
    mux.beginSession(SK_A, "chatA", RUN_A, 1000);
    for (const f of frames("agent-assistant-delta-legacy")) {
      mux.feedFrame(f, 1000.01);
    }
    // B: delta turn fed around t=2000 -> deadline ~2180.
    mux.beginSession(SK_B, "chatB", RUN_B, 2000);
    for (const f of frames("agent-assistant-delta-legacy").map(reTag)) {
      mux.feedFrame(f, 2000.01);
    }
    expect(mux.activeCount).toBe(2);

    // At t just past A's deadline (but well before B's), only A expires.
    const now = 1000 + BASE_RECV_TIMEOUT + 1;
    const emits = mux.tickExpired(now);
    expect(emits.length).toBe(1);
    const first = emits[0]!;
    expect(first.chatId).toBe("chatA");
    expect(first.events.some((e) => e.type === "message.final")).toBe(true);
    // A reaped, B still streaming.
    expect(mux.activeCount).toBe(1);
  });

  it("verbose guard is PER sessionKey (fix #7), not per connection", () => {
    const mux = new SessionMultiplexer();
    expect(mux.needsVerbose(SK_A)).toBe(true);
    mux.markVerbose(SK_A);
    expect(mux.needsVerbose(SK_A)).toBe(false);
    // A different session still needs its own patch — A's patch must not suppress B.
    expect(mux.needsVerbose(SK_B)).toBe(true);
  });

  it("endAll force-finalizes every active session (socket close)", () => {
    const mux = new SessionMultiplexer();
    mux.beginSession(SK_A, "chatA", RUN_A, 1000);
    mux.beginSession(SK_B, "chatB", RUN_B, 1000);
    const emits = mux.endAll(1001, "aborted");
    const chats = emits.map((e) => e.chatId).sort();
    expect(chats).toEqual(["chatA", "chatB"]);
    expect(mux.activeCount).toBe(0);
  });
});
