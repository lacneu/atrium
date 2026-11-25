/**
 * Upstream-derived frame contracts (OpenClaw tag v2026.10.33, the fixture's `upstream_tag`).
 *
 * A scenario carrying `only_at` holds a shape an OLDER supported gateway sends and the
 * reference tag no longer pins (v2026.9.36 stays supported beside v2026.10.33): it is
 * replayed like the others, and the marking itself is checked below.
 *
 * Each scenario in fixtures/openclaw_upstream_frames.json is built from the
 * upstream sources its description cites: copied from upstream's own unit tests,
 * or COMPOSED — the fixture's `_about` lists every composed part, and only the
 * three scenarios composed throughout say so in their own description. A composed
 * frame is our reading of cited production code, not a shape an upstream test
 * guarantees. The citations are checked by upstream-citations.test.ts. Replaying
 * the frames here pins the bridge's interpretation contracts documented in
 * docs/UPSTREAM_INTERPRETATION.md:
 *  - `state` alone decides the terminal class (stopReason is consumed by the
 *    gateway before emission; the Control UI reads neither stopReason nor
 *    errorKind),
 *  - allowlisted wire errorKind survives as the stable errorCode,
 *  - the transcript writer-claim rebound stays an error after streamed content,
 *    in its own non-retryable class (session_write_conflict), and is retryable
 *    only when nothing but the preparation prelude streamed,
 *  - the init OCC conflict classifies to session_init_conflict,
 *  - explicit {stream:"compaction"} events are the PRIMARY mid-turn compaction
 *    signal: one persisted "midturn" marker, accumulated text never reset (the
 *    overflow replay continues on the same runId with no lifecycle end).
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { COMPAT_MANIFEST } from "../src/compat.js";
import { chatSendAckHoldsInput } from "../src/providers/openclaw/chat-send-ack.js";
import { Normalizer, type BridgeEvent } from "../src/providers/openclaw/normalizer.js";
import {
  LiveTextBaselines,
  type LiveTextGap,
} from "../src/providers/openclaw/live-text-baseline.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const FIXTURES = JSON.parse(
  readFileSync(resolve(__dirname, "./fixtures/openclaw_upstream_frames.json"), "utf-8"),
) as {
  upstream_tag: string;
  session_key: string;
  run_id: string;
  scenarios: Record<
    string,
    {
      description: string;
      frames: unknown[];
      /** The tag whose shape this is, when the reference tag does not pin it. */
      only_at?: string;
      only_at_why?: string;
      /** A `chat.send` answer (an RPC result, not an event frame). */
      ack?: { runId: string; status: string };
    }
  >;
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

describe("shapes kept for an older supported gateway are marked, and only those", () => {
  const entries = Object.entries(FIXTURES.scenarios);
  const validated = COMPAT_MANIFEST.providers.openclaw!.validatedVersions;

  it("an `only_at` names a validated version other than the reference tag, with its reason", () => {
    const marked = entries.filter(([, s]) => s.only_at !== undefined);
    // Vacuity guard: 2026.9.36 is supported and six of its shapes differ at the reference tag.
    expect(marked.map(([name]) => name).sort()).toEqual([
      "aborted-then-save-warning-error-9.36",
      "error-errorkind-rate-limit",
      "error-state-contention-dispatch-9.36",
      "error-state-contention-schema",
      "error-timeout-with-message-9.36",
      "init-conflict-zero-content-9.36",
    ]);
    for (const [name, s] of marked) {
      expect(s.only_at, name).toMatch(/^v\d{4}\.\d+\.\d+$/);
      expect(s.only_at, `${name}: a shape of the reference tag carries no only_at`).not.toBe(
        FIXTURES.upstream_tag,
      );
      // Kept BECAUSE the version is still supported: a shape of a retired gateway goes.
      expect(validated, `${name}: ${s.only_at} is not a validated version`).toContain(
        s.only_at!.slice(1),
      );
      expect((s.only_at_why ?? "").length, `${name}: says what replaced it`).toBeGreaterThan(20);
    }
  });

  it("a scenario without `only_at` carries no reason for one", () => {
    for (const [name, s] of entries) {
      if (s.only_at === undefined) expect(s.only_at_why, name).toBeUndefined();
    }
  });
});

describe("upstream frame contracts: chat terminals and failure classes", () => {
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
    // v2026.10.33's pinned form has no error text: the class is all the frame says.
    const { events, normalizer } = drive("error-timeout-stopreason-precedence");
    expect(statusOf(events)?.status).toBe("error");
    expect(normalizer.finalized).toBe(true);
    // The gateway badges the class it recorded (2026.8.x on).
    expect(finalOf(events)?.errorKind).toBe("timeout");
  });

  it("v2026.9.36: the same timed-out abort with its error text keeps the text and the class", () => {
    const { events, normalizer } = drive("error-timeout-with-message-9.36");
    expect(statusOf(events)?.status).toBe("error");
    expect(normalizer.finalized).toBe(true);
    expect(finalOf(events)?.error).toContain("agent provider timeout");
    expect(finalOf(events)?.errorKind).toBe("timeout");
  });

  it("v2026.9.36: allowlisted wire errorKind (rate_limit) survives as the message errorKind", () => {
    const { events } = drive("error-errorkind-rate-limit");
    expect(statusOf(events)?.status).toBe("error");
    expect(finalOf(events)?.errorKind).toBe("rate_limit");
  });

  it("a provider observation beside the kind outranks it: rate_limit + overloaded is provider_internal", () => {
    // The gateway folds `overloaded` into the `rate_limit` kind; the observation is the more
    // precise fact, and it is the one the reader is told (core/failure-classifier.ts).
    const { events } = drive("error-rate-limit-kind-with-overloaded-detail");
    expect(statusOf(events)?.status).toBe("error");
    expect(finalOf(events)?.errorKind).toBe("provider_internal");
    expect(finalOf(events)?.error).toContain("Selected model is at capacity");
  });

  it("writer-claim rebound AFTER streamed content stays an ERROR, in its own non-retryable class", () => {
    // The 7.1 embedded prompt-lock flavour downgraded to complete because upstream
    // refused any retry once content had streamed. Its 2026.8.1+ successor does NOT
    // carry that guarantee — upstream treats the rebound as transient on the announce
    // path when nothing was sent (subagent-announce-delivery-retry.ts
    // isTransientAnnounceDeliveryError) — so the honest error card stands.
    const { events, normalizer } = drive("writer-claim-rebound-after-content");
    expect(statusOf(events)?.status).toBe("error");
    expect(normalizer.finalized).toBe(true);
    const final = finalOf(events);
    expect(final?.error).toContain("session writer claim changed");
    // Its OWN class, not the retryable init one: upstream throws this text after the
    // model ran as well as before, so an automatic re-dispatch could repeat work the
    // zero-content gate cannot see (codex).
    expect(final?.errorKind).toBe("session_write_conflict");
    expect(final?.text).toContain("rapport complet");
  });

  it("writer-claim rebound after only the PREPARATION prelude is retryable (proven pre-generation)", () => {
    const { events } = drive("writer-claim-rebound-before-generation");
    expect(statusOf(events)?.status).toBe("error");
    const final = finalOf(events) as { errorKind?: string; diagnosticErrorKind?: string } | undefined;
    expect(final?.errorKind).toBe("session_init_conflict");
    expect(final?.diagnosticErrorKind).toBe("session_write_conflict");
  });

  it("writer-claim rebound with ZERO content after lifecycle start stays non-retryable", () => {
    const { events } = drive("writer-claim-rebound-after-start-zero-content");
    // The lifecycle start emits an intermediate `running` status: read the TERMINAL one.
    const statuses = events.filter((e) => e.type === "run.status");
    expect(statuses[statuses.length - 1]?.status).toBe("error");
    expect(finalOf(events)?.errorKind).toBe("session_write_conflict");
  });

  for (const scenario of ["init-conflict-zero-content", "init-conflict-zero-content-9.36"]) {
    // v2026.10.33 appends "; please retry your message." — both wordings are the same fact.
    it(`${scenario}: pre-generation init OCC conflict classifies to session_init_conflict (auto-retry key)`, () => {
      const { events } = drive(scenario);
      expect(statusOf(events)?.status).toBe("error");
      expect(finalOf(events)?.errorKind).toBe("session_init_conflict");
    });
  }

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

/** Drive a scenario through the connection's live-text projection first, as production
 *  does (openclaw-client.ts `onMessage`): the 2026.9.7 wire is append-only. */
function driveWire(scenario: string): {
  events: BridgeEvent[];
  normalizer: Normalizer;
  gaps: LiveTextGap[];
} {
  const s = FIXTURES.scenarios[scenario];
  if (!s) throw new Error(`unknown scenario: ${scenario}`);
  const baselines = new LiveTextBaselines();
  const normalizer = new Normalizer(SESSION_KEY);
  const clock = new Clock();
  const events: BridgeEvent[] = [];
  const gaps: LiveTextGap[] = [];
  normalizer.beginTurn(clock.now);
  normalizer.noteRunStarted(OWN_RUN, clock.now);
  for (const frame of s.frames) {
    const projected = baselines.project({ type: "event", ...(frame as object) });
    if (projected.gap !== null) gaps.push(projected.gap);
    events.push(...normalizer.feed(projected.frame, clock.tick()));
  }
  return { events, normalizer, gaps };
}

const shownTexts = (events: BridgeEvent[]): string[] =>
  events
    .filter((e) => e.type === "message.snapshot" || e.type === "message.delta")
    .map((e) => (e as { text?: string }).text ?? "");

describe("upstream frame contracts: live text, contention, retries (2026.9.7 on)", () => {
  it("append-only chat deltas: projected, the live text grows and follows the replace", () => {
    const { events, gaps } = driveWire("chat-append-only-deltas");
    expect(gaps).toEqual([]);
    const shown = shownTexts(events);
    expect(shown).toContain("Hello world\n ");
    expect(shown.at(-1)).toBe("New answer");
  });

  it("append-only chat deltas: RAW, the live text freezes on its first fragment", () => {
    // The defect the projection exists for, kept visible: without it the normalizer locks
    // on the first snapshot and drops every append (normalizer.ts applyVisible).
    const { events } = drive("chat-append-only-deltas");
    expect(shownTexts(events).at(-1)).toBe("Hello");
  });

  it("a delta after the run's terminal has no baseline: reported, fragment withheld", () => {
    const { gaps } = driveWire("chat-delta-after-terminal-no-baseline");
    expect(gaps).toEqual([{ stream: "chat", runId: OWN_RUN, sessionKey: SESSION_KEY }]);
  });

  it("append-only agent assistant deltas: the reply is the whole text", () => {
    const { events, gaps } = driveWire("agent-assistant-append-only");
    expect(gaps).toEqual([]);
    expect(shownTexts(events)).toContain("one two");
    const statuses = events.filter((e) => e.type === "run.status");
    expect(statuses.at(-1)?.status).toBe("final");
    expect(finalOf(events)?.text).toBe("one two");
  });

  for (const scenario of [
    "error-state-contention-control-ui",
    "error-state-contention-schema",
    "error-state-contention-dispatch",
    "error-state-contention-dispatch-9.36",
  ]) {
    // A status to check, not a failure to resend (state-contention-projected.test.ts).
    it(`${scenario}: state_contention is gateway_state_contention, a terminal error`, () => {
      const { events } = drive(scenario);
      expect(statusOf(events)?.status).toBe("error");
      expect(finalOf(events)?.errorKind).toBe("gateway_state_contention");
    });
  }

  it("waiting_for_state is a quiet wait: no event, no terminal, the turn resumes", () => {
    const { events, normalizer } = drive("status-waiting-for-state-then-resume");
    const statuses = events.filter((e) => e.type === "run.status");
    expect(statuses.map((e) => e.status)).toEqual(["final"]);
    expect(normalizer.finalized).toBe(true);
    expect(finalOf(events)?.text).toBe("Resumed");
  });

  for (const scenario of ["aborted-then-save-warning-error", "aborted-then-save-warning-error-9.36"]) {
    // v2026.10.33 names the warning (stopReason aborted-partial-persistence-failed); 9.36 does not.
    it(`${scenario}: the partial-save warning after an abort changes nothing: one terminal, aborted`, () => {
      const { events } = drive(scenario);
      const statuses = events.filter((e) => e.type === "run.status");
      expect(statuses.map((e) => e.status)).toEqual(["aborted"]);
      expect(events.filter((e) => e.type === "message.final")).toHaveLength(1);
    });
  }
});

describe("upstream v2026.10.33 frame contracts", () => {
  it("a replace with an empty message takes the shown text back; the turn ends final", () => {
    const { events, normalizer, gaps } = driveWire("chat-delta-replace-retracts-text");
    expect(gaps).toEqual([]);
    const shown = shownTexts(events);
    expect(shown[0]).toBe("Provisional answer");
    // The retired text is not what the reader is left looking at.
    expect(shown.at(-1)).toBe("");
    const statuses = events.filter((e) => e.type === "run.status");
    expect(statuses.at(-1)?.status).toBe("final");
    expect(normalizer.finalized).toBe(true);
    expect(finalOf(events)?.text ?? "").toBe("");
  });

  it("a back-off says why and until when, does not end the turn, and the turn then completes", () => {
    const { events, normalizer } = drive("run-status-retrying-reason-retry-at");
    const retrying = events.filter(
      (e) => e.type === "turn.phase" && (e as { phase?: string }).phase === "retrying",
    ) as Array<{ retry?: unknown }>;
    expect(retrying.length).toBeGreaterThan(0);
    for (const e of retrying) {
      expect(e.retry).toEqual({
        attempt: 2,
        maxAttempts: 10,
        reason: "timeout",
        retryAt: 1800000060000,
      });
    }
    const statuses = events.filter((e) => e.type === "run.status");
    expect(statuses.map((e) => e.status)).toEqual(["final"]);
    expect(normalizer.finalized).toBe(true);
    expect(finalOf(events)?.text).toBe("I agree");
  });

  it("a queued send's `accepted` answer means the gateway holds the input", () => {
    const s = FIXTURES.scenarios["chat-send-ack-accepted-queued"]!;
    expect(s.frames).toEqual([]);
    expect(s.ack).toEqual({ runId: OWN_RUN, status: "accepted" });
    expect(chatSendAckHoldsInput(s.ack!.status)).toBe(true);
    // The line the answer sits on the right side of: a settled or failed send is not held.
    for (const status of ["ok", "timeout", "error"]) expect(chatSendAckHoldsInput(status)).toBe(false);
  });
});
