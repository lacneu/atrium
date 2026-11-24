/**
 * A compaction that did not complete is not always a failure — upstream says which.
 *
 * `handleCompactionEnd` (src/agents/embedded-agent-subscribe.handlers.compaction.ts,
 * identical from v2026.8.2 to v2026.9.36) emits
 * `{phase:"end", completed, willRetry, outcome, reason?}` and classifies a non-completed end
 * itself: benign when `outcome` is `aborted`, or `skipped` with a reason
 * `classifyCompactionReason` (src/agents/embedded-agent-runner/compact-reasons.ts) puts in
 * `no_compactable_entries`, `below_threshold` or `already_compacted`; everything else is
 * logged as a warning. The Codex harness emits an end with no `outcome` at all
 * (extensions/codex/src/app-server/event-projector-events.ts `emitCompactionEnd`), whose
 * `completed:false` only means its projection closed while the item was open.
 *
 * Atrium read every `completed:false` as "failed for good" and marked the conversation
 * saturated for a session that was simply too small to compact.
 *
 * No live capture of this stream exists (0 `stream:"compaction"` frame in the bench
 * corpus): the frames below are built from the upstream writers named above, and the
 * reason strings are the ones those sources produce.
 */

import { describe, expect, it } from "vitest";

import type { ConvexWriter, ToolPart } from "../src/convex-writer.js";
import {
  compactionCompleted,
  compactionFailedForGood,
} from "../src/core/compaction-verdict.js";
import { Normalizer } from "../src/providers/openclaw/normalizer.js";
import { RunManager } from "../src/providers/openclaw/run-manager.js";

const SK = "agent:alice:atrium:chat:u-test:c-compaction";
const OWN_RUN = "webchat-0f0e0d0c0b0a09080706050403020100";

const end = (extra: Record<string, unknown>) => ({
  phase: "end",
  completed: false,
  willRetry: false,
  ...extra,
});

/** Skip reasons upstream produces, each in the class its classifier gives it. */
const BENIGN_SKIPS = [
  // agent-session-compaction.ts — the default engine's own no-op.
  "Nothing to compact (session too small)",
  "no real conversation messages to summarize",
  "Compaction skipped: below threshold",
  "context already under target",
  "session already compacted",
  "already_compacted",
];
const FAILING_SKIPS = [
  // The class is decided in upstream's order: authentication is tested FIRST.
  "No API key found for provider openai",
  "Authentication failed for openai: credentials may have expired (nothing to compact)",
  "deferred to background context-engine maintenance",
  "live context still exceeds target",
  "compaction summary request failed",
  "blocked by compaction guard",
  "request timed out",
  "HTTP 503 from provider",
  "something nobody classified",
];

describe("the rule, as upstream classifies a non-completed end", () => {
  it("`failed` is a failure for good", () => {
    expect(compactionFailedForGood(end({ outcome: "failed", reason: "Compaction failed: boom" }))).toBe(true);
    expect(compactionFailedForGood(end({ outcome: "failed" }))).toBe(true);
  });

  it("`aborted` gives no verdict", () => {
    expect(compactionFailedForGood(end({ outcome: "aborted" }))).toBe(false);
    expect(compactionCompleted(end({ outcome: "aborted" }))).toBe(false);
  });

  it.each(BENIGN_SKIPS)("a skip for a benign reason gives no verdict: %s", (reason) => {
    expect(compactionFailedForGood(end({ outcome: "skipped", reason }))).toBe(false);
    expect(compactionCompleted(end({ outcome: "skipped", reason }))).toBe(false);
  });

  it("…whatever its case or surrounding blanks (the classifier lower-cases and trims)", () => {
    expect(
      compactionFailedForGood(end({ outcome: "skipped", reason: "  NOTHING TO COMPACT  " })),
    ).toBe(false);
  });

  it.each(FAILING_SKIPS)("a skip for any other reason is a failure: %s", (reason) => {
    expect(compactionFailedForGood(end({ outcome: "skipped", reason }))).toBe(true);
  });

  it("a skip with no reason is a failure (upstream warns on it)", () => {
    expect(compactionFailedForGood(end({ outcome: "skipped" }))).toBe(true);
    expect(compactionFailedForGood(end({ outcome: "skipped", reason: "" }))).toBe(true);
    expect(compactionFailedForGood(end({ outcome: "skipped", reason: 42 }))).toBe(true);
  });

  it("an end with NO outcome gives no verdict (the Codex harness's interrupted observation)", () => {
    const codexEnd = {
      phase: "end",
      backend: "codex-app-server",
      completed: false,
      threadId: "thr_1",
      turnId: "turn_1",
      itemId: "item_1",
    };
    expect(compactionFailedForGood(codexEnd)).toBe(false);
    expect(compactionCompleted(codexEnd)).toBe(false);
  });

  it("an outcome this build does not know defaults to failure", () => {
    expect(compactionFailedForGood(end({ outcome: "exploded" }))).toBe(true);
  });

  it("a retry in flight is never a verdict, and a completion still clears", () => {
    expect(
      compactionFailedForGood({ phase: "end", completed: false, willRetry: true, outcome: "failed" }),
    ).toBe(false);
    expect(
      compactionCompleted({ phase: "end", completed: true, willRetry: false, outcome: "completed" }),
    ).toBe(true);
    // The Codex harness's completion carries no outcome either: `completed` decides.
    expect(compactionCompleted({ phase: "end", backend: "codex-app-server", completed: true })).toBe(true);
  });
});

const frame = (runId: string, data: Record<string, unknown>) => ({
  type: "event" as const,
  event: "agent",
  payload: { runId, sessionKey: SK, stream: "compaction", data },
});

describe("during a turn (normalizer)", () => {
  function during(data: Record<string, unknown>) {
    const n = new Normalizer(SK);
    n.beginTurn(1_000);
    n.noteRunStarted(OWN_RUN, 1_001);
    n.feed(frame(OWN_RUN, { phase: "start" }), 1_002);
    return n.feed(frame(OWN_RUN, data), 1_003);
  }
  const overfull = (events: { type: string }[]) =>
    events.filter((e) => e.type === "session.overfull") as unknown as { overfull: boolean }[];
  const failedMarker = (events: { type: string }[]) =>
    events.some(
      (e) => e.type === "context.compaction" && (e as { phase?: string }).phase === "failed",
    );

  it("a benign skip raises neither the saturated verdict nor a failed marker", () => {
    const events = during(end({ outcome: "skipped", reason: "Nothing to compact (session too small)" }));
    expect(overfull(events)).toHaveLength(0);
    expect(failedMarker(events)).toBe(false);
  });

  it("an aborted compaction raises neither", () => {
    const events = during(end({ outcome: "aborted" }));
    expect(overfull(events)).toHaveLength(0);
    expect(failedMarker(events)).toBe(false);
  });

  it("a failed one raises both", () => {
    const events = during(end({ outcome: "failed", reason: "Auto-compaction failed: boom" }));
    expect(overfull(events).map((e) => e.overfull)).toStrictEqual([true]);
    expect(failedMarker(events)).toBe(true);
  });

  it("a skip for an authentication reason raises both", () => {
    const events = during(end({ outcome: "skipped", reason: "No API key found for provider openai" }));
    expect(overfull(events).map((e) => e.overfull)).toStrictEqual([true]);
    expect(failedMarker(events)).toBe(true);
  });

  it("the compaction state machine still ends on a benign end", () => {
    // The verdict is withheld, not the frame: the widened silence budget must close.
    const n = new Normalizer(SK);
    n.beginTurn(1_000);
    n.noteRunStarted(OWN_RUN, 1_001);
    n.feed(frame(OWN_RUN, { phase: "start" }), 1_002);
    expect(n.compactionPending).toBe(true);
    n.feed(frame(OWN_RUN, end({ outcome: "aborted" })), 1_003);
    expect(n.compactionPending).toBe(false);
  });

  it("after the turn's terminal, same rule", () => {
    const n = new Normalizer(SK);
    n.beginTurn(1_000);
    n.noteRunStarted(OWN_RUN, 1_001);
    n.feed(
      {
        type: "event",
        event: "chat",
        payload: {
          runId: OWN_RUN,
          sessionKey: SK,
          state: "final",
          message: { role: "assistant", content: [{ type: "text", text: "done" }] },
        },
      },
      1_002,
    );
    expect(overfull(n.feed(frame(OWN_RUN, end({ outcome: "aborted" })), 1_003))).toHaveLength(0);
    expect(
      overfull(n.feed(frame(OWN_RUN, end({ outcome: "failed", reason: "x" })), 1_004)).map(
        (e) => e.overfull,
      ),
    ).toStrictEqual([true]);
  });
});

class VerdictWriter implements ConvexWriter {
  readonly verdicts: boolean[] = [];
  async startAssistant(): Promise<string> {
    return "msg_1";
  }
  async setSessionOverfull(_chatId: string, overfull: boolean): Promise<void> {
    this.verdicts.push(overfull);
  }
  async appendDelta(): Promise<void> {}
  async setSnapshot(): Promise<boolean> {
    return true;
  }
  async addToolPart(_m: string, _p: ToolPart): Promise<void> {}
  async addCompactionPart(): Promise<void> {}
  async recordGatewayPressure(): Promise<void> {}
  async addProvenancePart(): Promise<void> {}
  async addMedia(): Promise<boolean> {
    return true;
  }
  async noteMediaUndelivered(): Promise<void> {}
  async noteFrameGap(): Promise<void> {}
  async finalize(): Promise<void> {}
  async getRehydrationContext(): Promise<{ history: string | null; turnCount: number }> {
    return { history: null, turnCount: 0 };
  }
  async reportSessionMeta(): Promise<void> {}
  async reportSessionRoster(): Promise<void> {}
  async upsertSubAgent(): Promise<void> {}
  async upsertSubAgentToolPart(): Promise<void> {}
  async recordInteractionReply(): Promise<void> {}
  async emitRehydrateTrace(): Promise<void> {}
}

describe("between turns (run manager → sink → writer)", () => {
  async function idle(...datas: Record<string, unknown>[]): Promise<boolean[]> {
    const writer = new VerdictWriter();
    const manager = new RunManager("chat-f8", SK, writer);
    let now = 1_000;
    for (const data of datas) await manager.feed(frame("bg-run", data), (now += 10));
    return writer.verdicts;
  }

  it("a background compaction skipped below threshold marks nothing", async () => {
    expect(await idle(end({ outcome: "skipped", reason: "below threshold" }))).toStrictEqual([]);
  });

  it("an aborted one marks nothing", async () => {
    expect(await idle(end({ outcome: "aborted" }))).toStrictEqual([]);
  });

  it("a Codex-harness end without outcome marks nothing", async () => {
    expect(
      await idle({ phase: "end", backend: "codex-app-server", completed: false, itemId: "i" }),
    ).toStrictEqual([]);
  });

  it("a failed one marks the session saturated", async () => {
    expect(await idle(end({ outcome: "failed", reason: "Compaction failed: x" }))).toStrictEqual([true]);
  });

  it("a standing verdict is NOT cleared by a benign end — only a completion clears it", async () => {
    expect(
      await idle(
        end({ outcome: "failed", reason: "Compaction failed: x" }),
        end({ outcome: "skipped", reason: "already compacted" }),
        end({ outcome: "aborted" }),
      ),
    ).toStrictEqual([true]);
    expect(
      await idle(
        end({ outcome: "failed", reason: "Compaction failed: x" }),
        { phase: "end", completed: true, willRetry: false, outcome: "completed" },
      ),
    ).toStrictEqual([true, false]);
  });
});
