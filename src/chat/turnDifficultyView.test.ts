// The reader side of the live-turn difficulty: ONE sentence for the sidebar bar and
// the bubble's status line, judged at the reader's clock from the server's facts.

import { describe, expect, it } from "vitest";
import {
  busyBarView,
  difficultyMaps,
  nextDifficultyTick,
  turnDifficultyLabel,
  type LiveDifficultyRow,
} from "./turnDifficultyView";

const NOW = 1_789_134_000_000;

const rows: LiveDifficultyRow[] = [
  {
    chatId: "chat-a",
    messageId: "msg-a",
    facts: { kind: "repeated_failures", tool: "view_image", failures: 4, sameTool: true },
  },
  {
    chatId: "chat-b",
    messageId: "msg-b",
    // Quiet for 3 minutes: past the 2-minute threshold.
    facts: { kind: "failed_then_quiet", tool: "ask_user", quietSince: NOW - 180_000 },
  },
  {
    chatId: "chat-c",
    messageId: "msg-c",
    // Quiet for 30 s: a candidate, not yet a difficulty.
    facts: { kind: "failed_then_quiet", tool: "exec", quietSince: NOW - 30_000 },
  },
];

describe("turnDifficultyLabel", () => {
  it("names the tool and the count (the wording asked for in the report)", () => {
    expect(
      turnDifficultyLabel({ kind: "repeated_failures", tool: "view_image", failures: 4, sameTool: true }),
    ).toBe("L'agent réessaie : 4 échecs de view_image");
    expect(
      turnDifficultyLabel({ kind: "repeated_failures", tool: "browser", failures: 3, sameTool: false }),
    ).toBe("L'agent bute : 3 échecs d'outils d'affilée (dernier : browser)");
    expect(
      turnDifficultyLabel({ kind: "quiet_after_failure", tool: "view_image", quietMs: 185_000 }),
    ).toBe("Aucune activité depuis 3 min, après l'échec de view_image");
  });
});

describe("difficultyMaps", () => {
  it("judges each row at the reader's clock, by chat and by message", () => {
    const { byChat, byMessage } = difficultyMaps(rows, NOW);
    expect([...byChat.keys()]).toEqual(["chat-a", "chat-b"]);
    expect(byMessage.get("msg-b")).toEqual({
      kind: "quiet_after_failure",
      tool: "ask_user",
      quietMs: 180_000,
    });
    expect(byMessage.has("msg-c")).toBe(false);
  });

  it("nothing known: empty maps", () => {
    expect(difficultyMaps(undefined, NOW).byChat.size).toBe(0);
  });
});

describe("nextDifficultyTick", () => {
  it("wakes the reader when a quiet turn crosses the threshold", () => {
    // chat-c crosses at quietSince + 2 min = NOW + 90 s; chat-b is past it and
    // refreshes its minute count every 30 s — the earliest wins.
    expect(nextDifficultyTick(rows, NOW)).toBe(NOW + 30_000);
    expect(nextDifficultyTick([rows[2]!], NOW)).toBe(NOW + 90_000);
  });

  it("repeated failures need no clock", () => {
    expect(nextDifficultyTick([rows[0]!], NOW)).toBeNull();
    expect(nextDifficultyTick(undefined, NOW)).toBeNull();
  });
});

describe("busyBarView — one indicator, two states", () => {
  it("the ordinary bar keeps its class and its label", () => {
    expect(busyBarView(null, "Réponse en cours…")).toEqual({
      className: "oc-chatitem__busy",
      label: "Réponse en cours…",
      struggling: false,
    });
  });

  it("the struggling bar is the SAME element with a modifier and the difficulty's sentence", () => {
    expect(
      busyBarView(
        { kind: "repeated_failures", tool: "view_image", failures: 4, sameTool: true },
        "Réponse en cours…",
      ),
    ).toEqual({
      className: "oc-chatitem__busy oc-chatitem__busy--struggling",
      label: "L'agent réessaie : 4 échecs de view_image",
      struggling: true,
    });
  });
});
