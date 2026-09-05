/**
 * Upstream-extracted frame contracts (OpenClaw tag v2026.7.1).
 *
 * Each scenario in fixtures/openclaw_upstream_frames.json is a wire shape the
 * upstream gateway's OWN unit tests guarantee (source file:line cited in the
 * fixture). Replaying them here pins the bridge's interpretation contracts
 * documented in docs/UPSTREAM_INTERPRETATION.md:
 *  - `state` alone decides the terminal class (stopReason is consumed by the
 *    gateway before emission; the Control UI reads neither stopReason nor
 *    errorKind),
 *  - allowlisted wire errorKind survives as the stable errorCode,
 *  - the embedded-lock takeover with streamed content downgrades to complete
 *    (upstream refuses any retry once there is send evidence),
 *  - the init OCC conflict classifies to session_init_conflict,
 *  - explicit {stream:"compaction"} events are the PRIMARY mid-turn compaction
 *    signal: one persisted "midturn" marker, accumulated text never reset (the
 *    overflow replay continues on the same runId with no lifecycle end).
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { Normalizer, type BridgeEvent } from "../src/providers/openclaw/normalizer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const FIXTURES = JSON.parse(
  readFileSync(resolve(__dirname, "./fixtures/openclaw_upstream_frames.json"), "utf-8"),
) as {
  session_key: string;
  run_id: string;
  scenarios: Record<string, { description: string; frames: unknown[] }>;
};

const SESSION_KEY = FIXTURES.session_key;
const OWN_RUN = FIXTURES.run_id;

class Clock {
  now = 1000.0;
  tick(seconds = 0.01): number {
    this.now += seconds;
    return this.now;
  }
}

function drive(scenario: string): {
  events: BridgeEvent[];
  normalizer: Normalizer;
} {
  const s = FIXTURES.scenarios[scenario];
  if (!s) {
    throw new Error(`unknown scenario: ${scenario}`);
  }
  const normalizer = new Normalizer(SESSION_KEY);
  const clock = new Clock();
  const events: BridgeEvent[] = [];
  normalizer.beginTurn(clock.now);
  normalizer.noteRunStarted(OWN_RUN, clock.now);
  for (const frame of s.frames) {
    events.push(...normalizer.feed(frame, clock.tick()));
  }
  return { events, normalizer };
}

const statusOf = (events: BridgeEvent[]) =>
  events.find((e) => e.type === "run.status");
const finalOf = (events: BridgeEvent[]) =>
  events.find((e) => e.type === "message.final");

describe("upstream v2026.9.1 frame contracts", () => {
  it("aborted with free-form stopReason ('user') finalizes aborted on state alone, partial text kept", () => {
    const { events, normalizer } = drive("aborted-user-stop-partial-text");
    expect(statusOf(events)?.status).toBe("aborted");
    expect(normalizer.finalized).toBe(true);
    // The partial text streamed before the kill is the message body.
    expect(finalOf(events)?.text).toContain("Partial reply");
    // stopReason 'user' is outside our bucket allowlist — never reclassifies.
    expect(finalOf(events)?.error ?? null).toBeNull();
  });

  it("self-abort with tool-validation errorMessage finalizes aborted without persisting an error", () => {
    const { events, normalizer } = drive("aborted-tool-validation-errormessage");
    expect(statusOf(events)?.status).toBe("aborted");
    expect(normalizer.finalized).toBe(true);
    // Deliberate divergence pinned: the aborted frame's errorMessage (a
    // tool-validation summary) is not persisted as a message error.
    expect(finalOf(events)?.error ?? null).toBeNull();
  });

  it("timed-out abort arrives as state:error and stays an error (no stopReason re-derivation)", () => {
    const { events, normalizer } = drive("error-timeout-stopreason-precedence");
    expect(statusOf(events)?.status).toBe("error");
    expect(normalizer.finalized).toBe(true);
    expect(finalOf(events)?.error).toContain("agent provider timeout");
    // NEW at 2026.8.x: the gateway also badges the class it recorded.
    expect(finalOf(events)?.errorKind).toBe("timeout");
  });

  it("allowlisted wire errorKind (rate_limit) survives as the message errorKind", () => {
    const { events } = drive("error-errorkind-rate-limit");
    expect(statusOf(events)?.status).toBe("error");
    expect(finalOf(events)?.errorKind).toBe("rate_limit");
  });

  it("writer-claim rebound AFTER streamed content stays an ERROR, classified MID-TURN", () => {
    // The 7.1 embedded prompt-lock flavour downgraded to complete because upstream
    // refused any retry once content had streamed. Its 2026.8.1+ successor does NOT
    // carry that guarantee — upstream retries the rebound itself
    // (subagent-announce-delivery-retry.ts:70) — so the honest error card stands and
    // only the CLASS is transient (what the bounded auto-retry keys on).
    const { events, normalizer } = drive("writer-claim-rebound-after-content");
    expect(statusOf(events)?.status).toBe("error");
    expect(normalizer.finalized).toBe(true);
    const final = finalOf(events);
    expect(final?.error).toContain("session writer claim changed");
    // Its OWN class, not the retryable init one: this fires after the model ran, so an
    // automatic re-dispatch could repeat work the zero-content gate cannot see (codex).
    expect(final?.errorKind).toBe("session_write_conflict");
    expect(final?.text).toContain("rapport complet");
  });

  it("pre-generation init OCC conflict classifies to session_init_conflict (auto-retry key)", () => {
    const { events } = drive("init-conflict-zero-content");
    expect(statusOf(events)?.status).toBe("error");
    expect(finalOf(events)?.errorKind).toBe("session_init_conflict");
  });

  it("explicit compaction stream signals drive ONE midturn marker without resetting accumulated text", () => {
    const { events, normalizer } = drive("compaction-explicit-stream-signals");
    expect(normalizer.finalized).toBe(true);
    // The compaction start emits an intermediate "compacting" run.status; the
    // TERMINAL status (last run.status) is the one that closes the turn.
    const statuses = events.filter((e) => e.type === "run.status");
    expect(statuses[0]?.status).toBe("compacting");
    expect(statuses[statuses.length - 1]?.status).toBe("final");
    // If the compaction frames (wrongly) reset the buffer, "part1" is lost and
    // the empty final never completes the turn — both assertions fail.
    expect(finalOf(events)?.text).toBe("part1 part2");
    // The explicit signal IS consumed: exactly one persisted compaction marker,
    // phase "midturn" (the run paused mid-reply to compact).
    const markers = events.filter((e) => e.type === "context.compaction");
    expect(markers).toHaveLength(1);
    expect(markers[0]?.phase).toBe("midturn");
  });
});
