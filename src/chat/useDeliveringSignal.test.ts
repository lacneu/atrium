// THE THREAD'S ACTIVITY INDICATOR, RENDERED (Codex review 1 of 0.101.1 [medium]): in
// projection `on` the single indicator kept the 45 s delivery window — a finished child with
// no resume lost its signal at 46 s, and a new user message did not end it. The gate
// ChatThread renders by is `useDeliveringSignal`; the probe below renders the indicator
// exactly when ChatThread does.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  armsDeliveryTimer,
  lastUserTurnAt,
  projectedDeliveryOpen,
  useDeliveringSignal,
} from "./useDeliveringSignal";

type Args = Parameters<typeof useDeliveringSignal>[0];
const base: Args = {
  chatId: "chat-1",
  projected: true,
  anyStreaming: false,
  runningLive: false,
  deliveringSince: 10_000,
  deliveringTtlRemainingMs: 0,
  lastUserAt: 5_000,
  // The gateway says the parent session works (a run active at the last read).
  gatewayWorkingUntil: 1_000_000,
  now: 500_000,
};

function render(args: Partial<Args>): string {
  function Probe() {
    const { showTurnActivity } = useDeliveringSignal({ ...base, ...args });
    return createElement("div", null, showTurnActivity ? createElement("span", { role: "status" }, "indicator") : null);
  }
  return renderToStaticMarkup(createElement(Probe));
}

const shown = (html: string) => html.includes('role="status"');

describe("the thread's activity indicator in projection `on`", () => {
  it("stays up past the 45 s window while no fact ended it (server TTL elapsed)", () => {
    expect(shown(render({ deliveringTtlRemainingMs: 0 }))).toBe(true);
    expect(shown(render({ deliveringTtlRemainingMs: null }))).toBe(true);
  });
  it("a newer user message ends it", () => {
    expect(shown(render({ lastUserAt: 10_001 }))).toBe(false);
    expect(shown(render({ lastUserAt: 10_000 }))).toBe(true);
  });
  it("the resume naming the child ends it (turnActivity stops reporting the delivery)", () => {
    expect(shown(render({ deliveringSince: null }))).toBe(false);
  });
  it("a streaming bubble stands it down; running work raises it", () => {
    expect(shown(render({ anyStreaming: true }))).toBe(false);
    expect(shown(render({ deliveringSince: null, runningLive: true }))).toBe(true);
  });
  // Adversarial review (0.101.1): a child whose resume the agent keeps silent
  // (`ANNOUNCE_SKIP`, upstream src/agents/subagents/announce/subagent-announce.format.e2e.test.ts:1122 at v2026.9.33) leaves no resume
  // bubble and no parent finalized after it — turnActivity keeps reporting the delivery.
  // With no run active on the parent session, nothing is being composed: the indicator is
  // down, without any fixed delay (ui/src/pages/chat/chat-thread-build.ts:562-570).
  it("a silent resume (ANNOUNCE_SKIP): no active gateway run, no indicator", () => {
    expect(shown(render({ gatewayWorkingUntil: null }))).toBe(false);
    expect(shown(render({ gatewayWorkingUntil: 499_999 }))).toBe(false);
    expect(shown(render({ gatewayWorkingUntil: 500_001 }))).toBe(true);
  });
  it("a child still running keeps it up whatever the gateway's parent session says", () => {
    expect(shown(render({ runningLive: true, deliveringSince: null, gatewayWorkingUntil: null }))).toBe(true);
  });
  it("arms no window timer", () => {
    expect(armsDeliveryTimer(true, 10_000, 30_000)).toBe(false);
    expect(armsDeliveryTimer(false, 10_000, 30_000)).toBe(true);
  });
});

describe("outside `on`, the window still bounds a delivery", () => {
  it("an elapsed window hides it; an open one shows it", () => {
    expect(shown(render({ projected: false, deliveringTtlRemainingMs: 0 }))).toBe(false);
    expect(shown(render({ projected: false, deliveringTtlRemainingMs: 30_000 }))).toBe(true);
  });
});

describe("lastUserTurnAt / projectedDeliveryOpen", () => {
  it("reads the latest user turn by orderTime, then _creationTime", () => {
    expect(lastUserTurnAt(undefined)).toBeNull();
    expect(
      lastUserTurnAt([
        { role: "user", _creationTime: 3 },
        { role: "assistant", _creationTime: 9 },
        { role: "user", _creationTime: 4, orderTime: 7 },
      ]),
    ).toBe(7);
  });
  it("is open while the gateway works, until a later user turn", () => {
    expect(projectedDeliveryOpen(null, null, 100, 0)).toBe(false);
    expect(projectedDeliveryOpen(5, null, 100, 0)).toBe(true);
    expect(projectedDeliveryOpen(5, 6, 100, 0)).toBe(false);
    expect(projectedDeliveryOpen(5, null, 100, 100)).toBe(false);
  });
});

// THE ORDER PROPERTY, for the indicator: the child finishes (turnActivity reports the
// delivery), then the resume naming it lands (the delivery is no longer reported) and/or a
// new user message is sent — in every order, at any time past the 45 s window. The indicator
// is up exactly from the child's end until the FIRST ending fact, and stays down after it.
describe("PROPERTY — the indicator against the resume and new-message facts, in every order", () => {
  type Fact = "resume" | "user";
  const ORDERS: Fact[][] = [["resume"], ["user"], ["resume", "user"], ["user", "resume"]];
  it.each(ORDERS.map((o) => [o.join(" → ")] as const))("%s", (label) => {
    const order = label.split(" → ") as Fact[];
    const doneAt = 10_000;
    let since: number | null = doneAt;
    let lastUserAt: number | null = 5_000;
    let at = doneAt;
    expect(shown(render({ deliveringSince: since, lastUserAt, deliveringTtlRemainingMs: 0 }))).toBe(true);
    for (const fact of order) {
      at += 60_000;
      if (fact === "resume") since = null;
      else lastUserAt = at;
      expect(shown(render({ deliveringSince: since, lastUserAt, deliveringTtlRemainingMs: 0 }))).toBe(false);
    }
  });
});
