import { describe, expect, it } from "vitest";
import {
  buildSubAgentActivityView,
  shortSessionKey,
  statusTone,
  subAgentActivityVisible,
  subAgentCardsToShow,
  subAgentCountLabel,
  subAgentFailedLabel,
  subAgentLabel,
  type SubAgentRow,
} from "./subAgentActivityView";

// Pure-logic tests for the chat-level sub-agent monitor block. Tests run with
// the baseLocale ("fr" — see vitest.setup.ts), so label assertions are
// deterministic French strings (GC-P5: every i18n branch exercised explicitly).

function row(overrides: Partial<SubAgentRow> = {}): SubAgentRow {
  return {
    _id: "s1",
    childSessionKey: "agent:main:subagent:11111111-2222-3333",
    status: "running",
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

describe("shortSessionKey", () => {
  it("takes the segment after the last colon (the child uuid)", () => {
    // A long uuid tail is truncated to its head + ellipsis.
    expect(shortSessionKey("agent:main:subagent:11111111-2222-3333")).toBe(
      "11111111…",
    );
  });

  it("keeps a short tail verbatim", () => {
    expect(shortSessionKey("agent:main:subagent:abc123")).toBe("abc123");
  });

  it("falls back to the whole string when there is no colon", () => {
    expect(shortSessionKey("solo")).toBe("solo");
  });

  it("returns empty for an empty/whitespace key", () => {
    expect(shortSessionKey("   ")).toBe("");
  });
});

describe("subAgentLabel", () => {
  it("prefers a non-blank taskName", () => {
    expect(subAgentLabel(row({ taskName: "Research prices" }))).toBe(
      "Research prices",
    );
  });

  it("falls back to a short session key when taskName is blank", () => {
    expect(subAgentLabel(row({ taskName: "   " }))).toBe("11111111…");
  });

  it("falls back to the untitled label when nothing identifies the child", () => {
    expect(subAgentLabel(row({ taskName: undefined, childSessionKey: "   " }))).toBe(
      "Sous-agent",
    );
  });
});

describe("statusTone", () => {
  it("maps running -> running, done -> done", () => {
    expect(statusTone("running")).toBe("running");
    expect(statusTone("done")).toBe("done");
  });

  it("maps BOTH error and aborted to the visible-failure tone", () => {
    expect(statusTone("error")).toBe("failed");
    expect(statusTone("aborted")).toBe("failed");
  });
});

describe("buildSubAgentActivityView", () => {
  it("orders cards newest-spawn FIRST and counts running/failed", () => {
    const view = buildSubAgentActivityView([
      row({ _id: "old", childSessionKey: "k:old", status: "done", createdAt: 1 }),
      row({ _id: "new", childSessionKey: "k:new", status: "running", createdAt: 9 }),
      row({ _id: "mid", childSessionKey: "k:mid", status: "error", createdAt: 5 }),
    ]);
    expect(view.cards.map((c) => c.id)).toEqual(["new", "mid", "old"]);
    expect(view.total).toBe(3);
    expect(view.running).toBe(1);
    expect(view.failed).toBe(1);
  });

  it("drops the phase on a settled card but keeps it while running", () => {
    const running = buildSubAgentActivityView([
      row({ status: "running", phase: "startup" }),
    ]).cards[0];
    expect(running.phase).toBe("startup");
    const done = buildSubAgentActivityView([
      row({ status: "done", phase: "result", resultText: "ok" }),
    ]).cards[0];
    expect(done.phase).toBeUndefined();
    expect(done.resultText).toBe("ok");
  });

  // The headline requirement: a timed-out / errored child becomes a card that
  // surfaces failure=true AND preserves the reason for prominent display.
  it("maps a TIMED-OUT (status error) child to a visible failure with its reason", () => {
    const msg =
      "Sub-agent timed out: no activity for 120s and the gateway never reported it finishing.";
    const card = buildSubAgentActivityView([
      row({ status: "error", errorMessage: msg }),
    ]).cards[0];
    expect(card.tone).toBe("failed");
    expect(card.failure).toBe(true);
    expect(card.errorMessage).toBe(msg);
  });

  it("treats an ABORTED child as a failure too", () => {
    const card = buildSubAgentActivityView([row({ status: "aborted" })]).cards[0];
    expect(card.tone).toBe("failed");
    expect(card.failure).toBe(true);
  });

  it("does NOT flag a running or done child as a failure", () => {
    const view = buildSubAgentActivityView([
      row({ _id: "r", status: "running", createdAt: 2 }),
      row({ _id: "d", status: "done", createdAt: 1 }),
    ]);
    expect(view.cards.every((c) => c.failure === false)).toBe(true);
    expect(view.failed).toBe(0);
  });
});

describe("subAgentActivityVisible (the show/hide gate)", () => {
  it("renders NOTHING when the gateway capability is absent (even with a failure)", () => {
    expect(subAgentActivityVisible(true, false, 3, 1)).toBe(false);
    expect(subAgentActivityVisible(false, false, 3, 1)).toBe(false);
  });

  it("renders nothing with no sub-agents at all", () => {
    expect(subAgentActivityVisible(true, true, 0, 0)).toBe(false);
  });

  it("ANALYSIS view (show on) is visible whenever there are rows", () => {
    expect(subAgentActivityVisible(true, true, 1, 0)).toBe(true);
    expect(subAgentActivityVisible(true, true, 2, 1)).toBe(true);
  });

  it("CLEAN view (show off) is visible ONLY when a sub-agent failed", () => {
    // Bug C: a failed/hung child must surface even with the tools toggle off.
    expect(subAgentActivityVisible(false, true, 3, 1)).toBe(true);
    // No failure in the clean view -> stay hidden (running/done is meta).
    expect(subAgentActivityVisible(false, true, 3, 0)).toBe(false);
  });
});

describe("subAgentCardsToShow (which cards render per view mode)", () => {
  const view = buildSubAgentActivityView([
    row({ _id: "r", status: "running", createdAt: 3 }),
    row({ _id: "f", status: "error", createdAt: 2 }),
    row({ _id: "d", status: "done", createdAt: 1 }),
  ]);

  it("ANALYSIS view (show on) renders ALL cards", () => {
    expect(subAgentCardsToShow(view.cards, true).map((c) => c.id)).toEqual([
      "r",
      "f",
      "d",
    ]);
  });

  it("CLEAN view (show off) renders ONLY the failed cards", () => {
    expect(subAgentCardsToShow(view.cards, false).map((c) => c.id)).toEqual([
      "f",
    ]);
  });
});

describe("subAgentFailedLabel (i18n singular/plural branches)", () => {
  it("uses the SINGULAR message for one failed sub-agent", () => {
    expect(subAgentFailedLabel(1)).toBe("1 sous-agent en échec");
  });

  it("uses the PLURAL message for several failed sub-agents", () => {
    expect(subAgentFailedLabel(2)).toBe("2 sous-agents en échec");
  });
});

describe("subAgentCountLabel (i18n singular/plural branches)", () => {
  it("uses the SINGULAR message for exactly one sub-agent", () => {
    expect(subAgentCountLabel(1)).toBe("1 sous-agent");
  });

  it("uses the PLURAL message for several sub-agents", () => {
    expect(subAgentCountLabel(3)).toBe("3 sous-agents");
  });
});
