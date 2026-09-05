// A DELIVERY run (sub-agent announce / task delivery) carries no `tool` stream:
// the item's terminal frame is the only tool telemetry. On <= 2026.7.x the plan
// CONTENT never reached the wire there, so `update_plan` completing on such a
// run emits a bare "plan moved" signal. On 2026.8.x the gateway emits the native
// `plan` stream on delivery runs too (measured live, 2026-09-02), and its tool
// `progress_card` also accepts markdown-only / clearing calls an item frame
// cannot tell apart — so NO advance is inferred for it: the plan stream is the
// source (codex P2, two passes).
import { describe, expect, it } from "vitest";
import { EVENT_PLAN, EVENT_PLAN_ADVANCE, EVENT_TOOL_STATUS } from "../src/core/events.js";
import { Normalizer } from "../src/providers/openclaw/normalizer.js";

const SESSION_KEY = "agent:alice:atrium:chat:u-test";
const ANNOUNCE_RUN = "announce:v1:agent:files:subagent:aaaaaaaa:bbbbbbbb";

function lifecycle(runId: string, phase: string): unknown {
  return {
    type: "event",
    event: "agent",
    payload: { runId, stream: "lifecycle", sessionKey: SESSION_KEY, data: { phase } },
  };
}
function itemEnd(runId: string, name: string, status = "completed"): unknown {
  return {
    type: "event",
    event: "agent",
    payload: {
      runId,
      stream: "item",
      sessionKey: SESSION_KEY,
      data: {
        itemId: `tool:call_1`,
        phase: "end",
        kind: "tool",
        title: `${name} step`,
        status,
        name,
        meta: "step",
        toolCallId: "call_1",
      },
    },
  };
}
function advancesFor(toolName: string): number {
  const n = new Normalizer(SESSION_KEY);
  let now = 1000;
  n.feed(lifecycle(ANNOUNCE_RUN, "start") as never, (now += 1));
  const events = n.feed(itemEnd(ANNOUNCE_RUN, toolName) as never, (now += 1));
  return events.filter((e) => e.type === EVENT_PLAN_ADVANCE).length;
}

describe("every produced event carries the instant its frame arrived", () => {
  // The stamp that orders plan writes by CAUSE (convex/lib/planOrder.ts) is taken
  // here, from the normalizer's own `now` — NOT where the sink applies the event.
  // An announce frame can be stashed while another run holds the pipeline and
  // re-fed later with its ORIGINAL `now` (run-manager `pendingAnnounce`), so a
  // stamp taken at application time would date a frame by its replay.
  it("recvAt is the frame's now, on every event of the batch", () => {
    const n = new Normalizer(SESSION_KEY);
    n.feed(lifecycle(ANNOUNCE_RUN, "start") as never, 1_000);
    const events = n.feed(itemEnd(ANNOUNCE_RUN, "update_plan") as never, 7_777);
    expect(events.length).toBeGreaterThan(0);
    expect(events.map((e) => e.recvAt)).toEqual(events.map(() => 7_777));
  });

  it("endTurn's events are stamped too — every producer, not just feed/tick", () => {
    const n = new Normalizer(SESSION_KEY);
    n.beginTurn(1_000);
    n.noteRunStarted("webchat-endturn", 1_000);
    const events = n.endTurn(4_242, "error", "gateway closed");
    expect(events.length).toBeGreaterThan(0);
    expect(events.map((e) => e.recvAt)).toEqual(events.map(() => 4_242));
  });

  it("a frame re-fed with an older now keeps that older instant", () => {
    // Exactly what the announce stash replays: the frame arrives late at the
    // normalizer but is dated by when it REACHED the bridge.
    const n = new Normalizer(SESSION_KEY);
    n.feed(lifecycle(ANNOUNCE_RUN, "start") as never, 9_000);
    const events = n.feed(itemEnd(ANNOUNCE_RUN, "update_plan") as never, 2_000);
    expect(events.map((e) => e.recvAt)).toEqual(events.map(() => 2_000));
  });
});

describe("plan advance on a delivery run, across gateway generations", () => {
  it("`progress_card` (2026.8.1+) is NEVER inferred — its item cannot prove a checklist changed", () => {
    expect(advancesFor("progress_card")).toBe(0);
  });
  it("on 2026.8.x the native `plan` stream carries the content on a delivery run", () => {
    const n = new Normalizer(SESSION_KEY);
    let now = 1000;
    n.feed(lifecycle(ANNOUNCE_RUN, "start") as never, (now += 1));
    const events = n.feed(
      {
        type: "event",
        event: "agent",
        payload: {
          runId: ANNOUNCE_RUN,
          stream: "plan",
          sessionKey: SESSION_KEY,
          // Captured live on 2026.8.2 (bench 2026-09-02, announce run).
          data: {
            phase: "update",
            title: "Plan updated",
            source: "openclaw",
            steps: [
              { step: "Étape A", status: "completed" },
              { step: "Étape B", status: "in_progress" },
              { step: "Étape C", status: "pending" },
            ],
          },
        },
      } as never,
      (now += 1),
    );
    const plans = events.filter((e) => e.type === EVENT_PLAN);
    expect(plans).toHaveLength(1);
    expect((plans[0] as unknown as { plan: { steps: unknown[] } }).plan.steps).toHaveLength(3);
  });
  it("`update_plan` (<= 2026.7.x) still moves it", () => {
    expect(advancesFor("update_plan")).toBe(1);
  });
  it("an EMPTY native plan on a delivery run materializes the cleared checklist", () => {
    const n = new Normalizer(SESSION_KEY);
    let now = 1000;
    n.feed(lifecycle(ANNOUNCE_RUN, "start") as never, (now += 1));
    const events = n.feed(
      {
        type: "event",
        event: "agent",
        payload: {
          runId: ANNOUNCE_RUN,
          stream: "plan",
          sessionKey: SESSION_KEY,
          data: { phase: "update", title: "Plan updated", source: "openclaw", steps: [] },
        },
      } as never,
      (now += 1),
    );
    const plans = events.filter((e) => e.type === EVENT_PLAN);
    expect(plans).toHaveLength(1);
    expect((plans[0] as unknown as { plan: { steps: unknown[] } }).plan.steps).toEqual([]);
  });
  it("`progress_card` emits no tool card on a delivery run (the plan stream is the trace); `update_plan` keeps its card", () => {
    const cards = (toolName: string) => {
      const n = new Normalizer(SESSION_KEY);
      let now = 1000;
      n.feed(lifecycle(ANNOUNCE_RUN, "start") as never, (now += 1));
      return n
        .feed(itemEnd(ANNOUNCE_RUN, toolName) as never, (now += 1))
        .filter((e) => e.type === EVENT_TOOL_STATUS).length;
    };
    expect(cards("progress_card")).toBe(0);
    expect(cards("update_plan")).toBe(1);
    expect(cards("exec")).toBe(1);
  });
  it("a FAILED `progress_card` keeps its error card — no plan stream is emitted on failure (codex P2)", () => {
    const n = new Normalizer(SESSION_KEY);
    let now = 1000;
    n.feed(lifecycle(ANNOUNCE_RUN, "start") as never, (now += 1));
    const cards = n
      .feed(itemEnd(ANNOUNCE_RUN, "progress_card", "error") as never, (now += 1))
      .filter((e) => e.type === EVENT_TOOL_STATUS);
    expect(cards).toHaveLength(1);
    expect((cards[0] as unknown as { phase: string }).phase).toBe("error");
  });
  it("an ordinary tool does not", () => {
    expect(advancesFor("exec")).toBe(0);
  });
});
