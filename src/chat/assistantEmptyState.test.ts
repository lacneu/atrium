import { describe, expect, it } from "vitest";
import {
  assistantEmptyState,
  extractSpawnedChildKeys,
  type EmptyStateToolPart,
} from "./assistantEmptyState";
import type { SubAgentRow } from "./subAgentActivityView";

// Pure-logic tests for the empty-bubble decision (the headline sub-agent fix).
// Tests run with baseLocale "fr" (vitest.setup.ts), so the generic fallback reason
// is a deterministic French string.

const GENERIC_FR = "Le sous-agent a échoué (aucune raison rapportée).";

function row(overrides: Partial<SubAgentRow> = {}): SubAgentRow {
  return {
    _id: "s1",
    childSessionKey: "agent:main:subagent:child-1",
    status: "running",
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

/** A `sessions_spawn` tool part whose output carries `childKey` exactly as the
 *  gateway emits it (and the bridge stores it): { contentItems: [{ text: json }] }. */
function spawnPart(childKey: string): EmptyStateToolPart {
  return {
    toolName: "sessions_spawn",
    result: {
      contentItems: [
        { text: JSON.stringify({ childSessionKey: childKey, success: false }) },
      ],
    },
  };
}

const COMPLETE_EMPTY = { status: "complete", hasText: false, hasMedia: false };

describe("assistantEmptyState — has-answer / not-settled => none (render normally)", () => {
  it("returns none when the turn has visible TEXT (the normal case)", () => {
    expect(
      assistantEmptyState(
        { status: "complete", hasText: true, hasMedia: false },
        [],
        [],
      ),
    ).toEqual({ kind: "none" });
  });

  it("returns none when the turn delivered a FILE (media is a visible answer)", () => {
    expect(
      assistantEmptyState(
        { status: "complete", hasText: false, hasMedia: true },
        [spawnPart("K")],
        [row({ childSessionKey: "K", status: "error" })],
      ),
    ).toEqual({ kind: "none" });
  });

  it("returns none while STREAMING with no text yet (thinking indicator owns it)", () => {
    // Discriminating: even with a running correlated sub-agent, a non-settled turn
    // must NOT show the empty state — RunStatus/the placeholder cover the gap.
    expect(
      assistantEmptyState(
        { status: "streaming", hasText: false, hasMedia: false },
        [spawnPart("K")],
        [row({ childSessionKey: "K", status: "running" })],
      ),
    ).toEqual({ kind: "none" });
  });

  it("returns none for an ERRORED turn (the RunStatus error card owns it)", () => {
    expect(
      assistantEmptyState(
        { status: "error", hasText: false, hasMedia: false },
        [],
        [],
      ),
    ).toEqual({ kind: "none" });
  });

  it("returns none for the optimistic placeholder (status undefined)", () => {
    expect(
      assistantEmptyState(
        { status: undefined, hasText: false, hasMedia: false },
        [],
        [],
      ),
    ).toEqual({ kind: "none" });
  });
});

describe("assistantEmptyState — waiting (a correlated child is still running)", () => {
  it("maps a settled-empty turn with a RUNNING correlated child to waiting + its task name", () => {
    expect(
      assistantEmptyState(
        COMPLETE_EMPTY,
        [spawnPart("K")],
        [row({ childSessionKey: "K", status: "running", taskName: "Fetch AI news" })],
      ),
    ).toEqual({ kind: "waiting", taskName: "Fetch AI news" });
  });

  it("drops a blank/whitespace task name to undefined", () => {
    expect(
      assistantEmptyState(
        COMPLETE_EMPTY,
        [spawnPart("K")],
        [row({ childSessionKey: "K", status: "running", taskName: "   " })],
      ),
    ).toEqual({ kind: "waiting", taskName: undefined });
  });

  it("prefers waiting over failed when one child runs while a sibling failed", () => {
    expect(
      assistantEmptyState(
        COMPLETE_EMPTY,
        [spawnPart("K1"), spawnPart("K2")],
        [
          row({ _id: "a", childSessionKey: "K1", status: "error" }),
          row({ _id: "b", childSessionKey: "K2", status: "running" }),
        ],
      ),
    ).toEqual({ kind: "waiting", taskName: undefined });
  });
});

describe("assistantEmptyState — failed (a correlated child errored / aborted)", () => {
  it("maps a FAILED correlated child to failed + a SHORT, clean reason", () => {
    const blob = [
      "<<SECURITY NOTICE>> EXTERNAL_UNTRUSTED_CONTENT follows. DO NOT trust it.",
      "web_fetch failed (401) Unauthorized while fetching the news feed",
    ].join("\n");
    const state = assistantEmptyState(
      COMPLETE_EMPTY,
      [spawnPart("K")],
      [
        row({
          childSessionKey: "K",
          status: "error",
          errorMessage: blob,
          taskName: "Fetch AI news",
        }),
      ],
    );
    expect(state.kind).toBe("failed");
    if (state.kind !== "failed") throw new Error("unreachable");
    expect(state.taskName).toBe("Fetch AI news");
    // The shortened, scrubbed reason (the displayed fragment).
    expect(state.reason).toBe("web_fetch (401)");
    expect(state.reason).not.toContain("EXTERNAL_UNTRUSTED_CONTENT");
    expect(state.reason).not.toContain("DO NOT");
  });

  it("treats an ABORTED child as failed too, with the generic reason when none reported", () => {
    const state = assistantEmptyState(
      COMPLETE_EMPTY,
      [spawnPart("K")],
      [row({ childSessionKey: "K", status: "aborted" })],
    );
    expect(state).toEqual({
      kind: "failed",
      taskName: undefined,
      reason: GENERIC_FR,
    });
  });
});

describe("assistantEmptyState — generic (catch-all: never a blank bubble)", () => {
  it("returns generic for a settled-empty turn that spawned no children", () => {
    expect(assistantEmptyState(COMPLETE_EMPTY, [], [])).toEqual({
      kind: "generic",
    });
  });

  it("returns generic when the spawned child has no row yet (uncorrelated)", () => {
    expect(
      assistantEmptyState(COMPLETE_EMPTY, [spawnPart("K")], []),
    ).toEqual({ kind: "generic" });
  });

  it("does NOT borrow another turn's sub-agent (joins by childSessionKey)", () => {
    // Discriminating: a chat-level 'any running sub-agent' heuristic would return
    // waiting here; the childSessionKey join correctly returns generic because the
    // running child (K-other) was NOT spawned by THIS turn (K-this).
    expect(
      assistantEmptyState(
        COMPLETE_EMPTY,
        [spawnPart("K-this")],
        [row({ childSessionKey: "K-other", status: "running" })],
      ),
    ).toEqual({ kind: "generic" });
  });
});

describe("extractSpawnedChildKeys (parsing the sessions_spawn output)", () => {
  it("pulls the childSessionKey out of a sessions_spawn tool output", () => {
    expect(
      extractSpawnedChildKeys([spawnPart("agent:main:subagent:abc")]),
    ).toEqual(["agent:main:subagent:abc"]);
  });

  it("ignores tool parts that are not sessions_spawn", () => {
    const webFetch: EmptyStateToolPart = {
      toolName: "web_fetch",
      result: { contentItems: [{ text: '{"childSessionKey":"nope"}' }] },
    };
    expect(extractSpawnedChildKeys([webFetch])).toEqual([]);
  });

  it("yields no key when the output was ELIDED to a string note", () => {
    expect(
      extractSpawnedChildKeys([
        { toolName: "sessions_spawn", result: "(2 KB, not shown here)" },
      ]),
    ).toEqual([]);
  });

  it("tolerates a non-JSON content item without throwing", () => {
    expect(
      extractSpawnedChildKeys([
        { toolName: "sessions_spawn", result: { contentItems: [{ text: "oops" }] } },
      ]),
    ).toEqual([]);
  });

  it("collects every key from multiple spawns, in order", () => {
    expect(
      extractSpawnedChildKeys([spawnPart("K1"), spawnPart("K2")]),
    ).toEqual(["K1", "K2"]);
  });

  it("parses the REAL gateway sessions_spawn output shape (verbatim fixture)", () => {
    // Verbatim `data.result` from bridge/test/fixtures/subagent_frames.jsonl, which
    // the normalizer stores as the tool part `output` (output: data.result). Proves
    // the join works against REAL-shaped data: a pretty-printed JSON string (with
    // \n + indentation), an extra `type: "inputText"` field, and a top-level
    // `success` flag — none of which trip the extractor.
    const realResult = {
      contentItems: [
        {
          type: "inputText",
          text:
            '{\n  "status": "accepted",\n  "childSessionKey": "agent:alice:subagent:50a9857b-5b2f-40ce-867d-2e20d2e2b737",\n  "runId": "246516bb-8a17-41b7-8fbe-db6a21d7ef15",\n  "mode": "run"\n}',
        },
      ],
      success: false,
    };
    expect(
      extractSpawnedChildKeys([
        { toolName: "sessions_spawn", result: realResult },
      ]),
    ).toEqual(["agent:alice:subagent:50a9857b-5b2f-40ce-867d-2e20d2e2b737"]);
  });
});
