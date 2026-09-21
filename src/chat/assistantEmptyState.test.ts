import { describe, expect, it } from "vitest";
import {
  ANNOUNCE_COMPOSE_GRACE_MS,
  assistantEmptyState,
  extractSpawnedChildKeys,
  toolPartsHaveSpawn,
  UNBACKED_DELEGATION_GRACE_MS,
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
 *  gateway emits it (and the bridge stores it).
 *
 *  The array key CHANGED upstream: `contentItems` up to 2026.6.5, `content` from
 *  2026.6.10 on. This fixture pinned the OLD one alone, which is why nothing here
 *  ever noticed that the reader had stopped matching production. Both shapes are
 *  exercised now, and `content` is the default because it is what every supported
 *  gateway actually sends. */
function spawnPart(
  childKey: string,
  key: "content" | "contentItems" = "content",
): EmptyStateToolPart {
  return {
    toolName: "sessions_spawn",
    result: {
      [key]: [
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

describe("assistantEmptyState — parentMessageId correlation (robust) + done case", () => {
  it("correlates by parentMessageId even when the spawn output carried NO key", () => {
    // The live gateway omits the spawn result -> extractSpawnedChildKeys is empty;
    // the message-id join must STILL find the child (the whole point of the fix).
    const state = assistantEmptyState(
      COMPLETE_EMPTY,
      [{ toolName: "sessions_spawn" }], // a spawn tool part with NO result
      [row({ parentMessageId: "msg-1", status: "running", taskName: "Recherche" })],
      "msg-1",
    );
    expect(state).toEqual({ kind: "waiting", taskName: "Recherche" });
  });

  it("a DONE correlated child surfaces its result (never the blank generic bubble)", () => {
    const state = assistantEmptyState(
      COMPLETE_EMPTY,
      [{ toolName: "sessions_spawn" }],
      [
        row({
          parentMessageId: "msg-1",
          status: "done",
          resultText: "10 news IA…",
          taskName: "News",
        }),
      ],
      "msg-1",
    );
    expect(state).toEqual({
      kind: "done",
      taskName: "News",
      resultText: "10 news IA…",
      // WHO answered: the delegated agent, read off its session key.
      agentId: "main",
    });
  });

  // Prod 2026-09-09 (report prod-ms7bybmm…): the gateway ran the `files`
  // delegation on the `dashboard` face. The answer must still be attributed —
  // a reader who is not told otherwise credits it to the agent they are talking
  // to, which is the one thing it is not.
  it("names the delegated agent whatever FACE the gateway spawned it on", () => {
    const state = assistantEmptyState(
      COMPLETE_EMPTY,
      [spawnPart("agent:files:dashboard:6fd050d2-3c17-4361-8bbf-13fbda97840f")],
      [
        row({
          childSessionKey: "agent:files:dashboard:6fd050d2-3c17-4361-8bbf-13fbda97840f",
          status: "done",
          resultText: "2026 09 10 - VADE-MECUM.docx\n2026 09 10 - VADE-MECUM.pdf",
          updatedAt: 0,
        }),
      ],
      undefined,
      9_999_999,
    );
    expect(state).toMatchObject({ kind: "done", agentId: "files" });
  });

  it("a running sibling takes precedence over a done one (still waiting)", () => {
    const state = assistantEmptyState(
      COMPLETE_EMPTY,
      [{ toolName: "sessions_spawn" }],
      [
        row({ _id: "a", parentMessageId: "msg-1", status: "done", resultText: "x" }),
        row({ _id: "b", parentMessageId: "msg-1", status: "running" }),
      ],
      "msg-1",
    );
    expect(state.kind).toBe("waiting");
  });

  it("does NOT correlate a child of ANOTHER message (mismatch + no key) -> generic", () => {
    const state = assistantEmptyState(
      COMPLETE_EMPTY,
      [{ toolName: "sessions_spawn" }],
      [row({ parentMessageId: "OTHER", status: "running" })],
      "msg-1",
    );
    expect(state).toEqual({ kind: "generic" });
  });

  it("falls back to the childSessionKey join when no messageId is given", () => {
    const state = assistantEmptyState(
      COMPLETE_EMPTY,
      [spawnPart("agent:main:subagent:child-1")],
      [row({ childSessionKey: "agent:main:subagent:child-1", status: "running" })],
    );
    expect(state.kind).toBe("waiting");
  });
});

describe("toolPartsHaveSpawn (gate on the spawn tool NAME, not its result)", () => {
  it("true when a sessions_spawn tool part is present even with NO result", () => {
    expect(toolPartsHaveSpawn([{ toolName: "sessions_spawn" }])).toBe(true);
  });
  it("false for an ordinary tool part and for none", () => {
    expect(toolPartsHaveSpawn([{ toolName: "exec", result: {} }])).toBe(false);
    expect(toolPartsHaveSpawn([])).toBe(false);
  });
});

describe("composing grace (announce merge expected)", () => {
  it("a FRESH done child holds a composing note — the merge will rewrite the bubble", () => {
    const doneAt = 5_000_000;
    const state = assistantEmptyState(
      COMPLETE_EMPTY,
      [{ toolName: "sessions_spawn" }],
      [
        row({
          parentMessageId: "msg-1",
          status: "done",
          resultText: "résultat brut du child",
          taskName: "News",
          updatedAt: doneAt,
        }),
      ],
      "msg-1",
      doneAt + 10_000,
    );
    expect(state).toEqual({
      kind: "composing",
      taskName: "News",
      recheckAt: doneAt + ANNOUNCE_COMPOSE_GRACE_MS,
    });
  });

  it("past the grace window the child's raw result becomes the answer (fallback)", () => {
    const doneAt = 5_000_000;
    const state = assistantEmptyState(
      COMPLETE_EMPTY,
      [{ toolName: "sessions_spawn" }],
      [
        row({
          parentMessageId: "msg-1",
          status: "done",
          resultText: "résultat brut du child",
          updatedAt: doneAt,
        }),
      ],
      "msg-1",
      doneAt + ANNOUNCE_COMPOSE_GRACE_MS,
    );
    expect(state).toEqual({
      kind: "done",
      taskName: undefined,
      resultText: "résultat brut du child",
      agentId: "main",
    });
  });

  it("a failed sibling still wins over composing (failure is never masked)", () => {
    const doneAt = 5_000_000;
    const state = assistantEmptyState(
      COMPLETE_EMPTY,
      [{ toolName: "sessions_spawn" }],
      [
        row({ _id: "a", parentMessageId: "msg-1", status: "done", resultText: "x", updatedAt: doneAt }),
        row({ _id: "b", parentMessageId: "msg-1", status: "error", errorMessage: "boom", updatedAt: doneAt }),
      ],
      "msg-1",
      doneAt + 10_000,
    );
    expect(state.kind).toBe("failed");
  });
});

// A BUBBLE THAT SPEAKS CAN STILL BE WAITING — AND CAN STILL HAVE FAILED.
//
// Surfacing the hand-off's acknowledgment gave a yielded turn text for the first
// time, and text switched this decision off entirely. The bubble then said "je le
// prépare et je te le livre ici" and said it forever: the child could run, finish
// or die without the conversation ever mentioning it again. That is precisely the
// complaint left open by a user whose delegated document never arrived — the
// silence became a sentence, which is worse than the silence.
describe("a hand-off keeps its delegation state even once it speaks", () => {
  // A real part always carries its phase (the Convex schema requires it) AND the
  // gateway's payload: a refusal comes back as a SUCCESSFUL call whose result says
  // `status:"error"`, so both are what decides a hand-off.
  const YIELD: EmptyStateToolPart = {
    toolName: "sessions_yield",
    phase: "completed",
    result: { details: { status: "yielded" } },
  };
  const SPOKE = { status: "complete", hasText: true, hasMedia: false };

  it("a RUNNING child is still announced under the waiting reply", () => {
    expect(
      assistantEmptyState(
        SPOKE,
        [spawnPart("K"), YIELD],
        [row({ childSessionKey: "K", status: "running", taskName: "vademecum" })],
      ),
    ).toEqual({ kind: "waiting", taskName: "vademecum" });
  });

  it("a FAILED child is named — the case the user is still waiting on", () => {
    const s = assistantEmptyState(
      SPOKE,
      [spawnPart("K"), YIELD],
      [
        row({
          childSessionKey: "K",
          status: "error",
          taskName: "vademecum",
          errorMessage: "run timed out",
        }),
      ],
    );
    expect(s.kind).toBe("failed");
  });

  it("nothing else is: a bubble with an answer is not given another one", () => {
    // `composing`, `done` and `generic` all exist to SUPPLY the answer a blank
    // bubble lacks. This bubble has one.
    const done = row({
      childSessionKey: "K",
      status: "done",
      resultText: "voici le document",
      updatedAt: 1000,
    });
    expect(
      assistantEmptyState(SPOKE, [spawnPart("K"), YIELD], [done], undefined, 1_000_000),
    ).toEqual({ kind: "none" });
    // …and a hand-off with no child at all stays quiet rather than claiming the
    // agent returned nothing.
    expect(assistantEmptyState(SPOKE, [YIELD], [])).toEqual({ kind: "none" });
  });

  it("a turn that did NOT hand off is unchanged — text still means render normally", () => {
    expect(
      assistantEmptyState(
        SPOKE,
        [spawnPart("K")],
        [row({ childSessionKey: "K", status: "error" })],
      ),
    ).toEqual({ kind: "none" });
  });

  it("a BLANK hand-off is unchanged too — this adds a case, it removes none", () => {
    expect(
      assistantEmptyState(
        COMPLETE_EMPTY,
        [spawnPart("K"), YIELD],
        [row({ childSessionKey: "K", status: "running", taskName: "vademecum" })],
      ),
    ).toEqual({ kind: "waiting", taskName: "vademecum" });
  });
});


// THE FIVE-SECOND ACCUSATION (production report, 2026-09-21).
//
// A turn delegated its work and settled with no text. For about five seconds the
// bubble read "the agent performed some actions but did not return a response",
// then replaced it with the waiting note. Nothing was ever wrong server-side: the
// message was `complete`, `errorCode: null`, zero tool errors. The whole thing was
// this decision, run on data it did not have.
//
// Root cause: `extractSpawnedChildKeys` read only `result.contentItems`. Upstream
// renamed that array to `content` at gateway 2026.6.10 — the bridge's own twin was
// corrected for it and says so (sub-agent-observer.ts:1655-1657) — so on every
// gateway in production this reader returned NO keys and the documented fallback
// correlation was dead. Correlation fell back to `parentMessageId` alone, which the
// bridge stamps a moment AFTER the bubble settles.
describe("a delegation is never mistaken for a turn that returned nothing", () => {
  // A real part always carries its phase (the Convex schema requires it) AND the
  // gateway's payload: a refusal comes back as a SUCCESSFUL call whose result says
  // `status:"error"`, so both are what decides a hand-off.
  const YIELD: EmptyStateToolPart = {
    toolName: "sessions_yield",
    phase: "completed",
    result: { details: { status: "yielded" } },
  };
  const KEY = "agent:files:subagent:615b0b0e-1a1a-48dc-8e3c-28b53e95b8a4";

  it("correlates a child through the CURRENT gateway shape (`content`)", () => {
    // The exact shape production stores, verified on 2026.9.5.
    expect(
      assistantEmptyState(
        COMPLETE_EMPTY,
        [spawnPart(KEY, "content"), YIELD],
        [row({ childSessionKey: KEY, status: "running", taskName: "r003" })],
      ),
    ).toEqual({ kind: "waiting", taskName: "r003" });
  });

  it("still correlates the OLD shape (`contentItems`) — this adds a key, drops none", () => {
    expect(
      assistantEmptyState(
        COMPLETE_EMPTY,
        [spawnPart(KEY, "contentItems"), YIELD],
        [row({ childSessionKey: KEY, status: "running", taskName: "r003" })],
      ),
    ).toEqual({ kind: "waiting", taskName: "r003" });
  });

  it("says NOTHING while the sub-agent list has not answered", () => {
    // `useQuery` returns undefined until it resolves, and both call sites turned
    // that into `[]` — "no sub-agents" — which is a verdict on data we do not have.
    expect(
      assistantEmptyState(COMPLETE_EMPTY, [spawnPart(KEY), YIELD], undefined),
    ).toEqual({ kind: "none" });
  });

  it("a hand-off whose row has not arrived yet WAITS instead of accusing", () => {
    // Written first as `[YIELD]` alone with no settle stamp — which described a
    // scenario it did not set up (an adversarial review caught it), and encoded a
    // rule too loose to keep: a bare `sessions_yield` is not proof that anything
    // was delegated. The real scenario: the turn spawned AND yielded, a foreign
    // row exists but correlates to neither this message nor this turn's child key.
    const foreign = row({
      childSessionKey: "agent:files:subagent:someone-else",
      parentMessageId: undefined,
      status: "running",
    });
    const s = assistantEmptyState(
      { ...COMPLETE_EMPTY, settledAt: 1_000 },
      [spawnPart("agent:files:subagent:mine"), { toolName: "sessions_yield", phase: "completed" }],
      [foreign],
      "msg-1",
      1_100,
    );
    expect(s.kind).toBe("waiting");
    expect(s.kind === "waiting" && s.recheckAt).toBe(
      1_000 + UNBACKED_DELEGATION_GRACE_MS,
    );
  });

  it("an ordinary turn that produced nothing is STILL named", () => {
    // The generic verdict is not weakened — only turns that handed off are exempt.
    expect(
      assistantEmptyState(
        COMPLETE_EMPTY,
        [{ toolName: "exec", result: {} }],
        [],
        "msg-1",
      ),
    ).toEqual({ kind: "generic" });
  });
});


// WHAT THE FIRST REPAIR GOT WRONG (adversarial review, 2026-09-21).
//
// Making every `sessions_yield` mean "waiting" replaced a false accusation with a
// false reassurance. Upstream refuses a yield through FIVE paths that all return a
// SUCCESSFUL tool result carrying `status:"error"` (sessions-yield-tool.ts:52-76),
// so a turn that delegated nothing was read as a hand-off — and the note it got had
// no expiry, so it span under a settled bubble forever.
describe("only a yield that succeeded, on a turn that really delegated", () => {
  const SPAWN = spawnPart("agent:files:subagent:k1");
  const OK_YIELD: EmptyStateToolPart = {
    toolName: "sessions_yield",
    phase: "completed",
  };
  const SETTLED = { ...COMPLETE_EMPTY, settledAt: 1_000 };

  it("a REFUSED yield is not a hand-off — the turn returned nothing and says so", () => {
    const refused: EmptyStateToolPart = {
      toolName: "sessions_yield",
      phase: "error",
      result: { details: { status: "error", error: "No pending child completion" } },
    };
    expect(
      assistantEmptyState(SETTLED, [refused], [], "m1", 1_100),
    ).toEqual({ kind: "generic" });
  });

  it("a yield with NO spawn and NO async task is not a hand-off either", () => {
    expect(
      assistantEmptyState(SETTLED, [OK_YIELD], [], "m1", 1_100),
    ).toEqual({ kind: "generic" });
  });

  it("a real delegation whose row has not arrived waits — and EXPIRES", () => {
    const within = assistantEmptyState(
      SETTLED,
      [SPAWN, OK_YIELD],
      [],
      "m1",
      1_000 + UNBACKED_DELEGATION_GRACE_MS - 1,
    );
    expect(within.kind).toBe("waiting");
    expect(
      within.kind === "waiting" && within.recheckAt,
      "an unbacked note must carry its own deadline",
    ).toBe(1_000 + UNBACKED_DELEGATION_GRACE_MS);

    // Past it, the terminal verdict stands: a note no event can close is a lie
    // with no end date.
    expect(
      assistantEmptyState(
        SETTLED,
        [SPAWN, OK_YIELD],
        [],
        "m1",
        1_000 + UNBACKED_DELEGATION_GRACE_MS + 1,
      ),
    ).toEqual({ kind: "generic" });
  });

  it("a BACKED waiting carries no deadline — the row's own transition ends it", () => {
    const s = assistantEmptyState(
      SETTLED,
      [SPAWN, OK_YIELD],
      [row({ childSessionKey: "agent:files:subagent:k1", status: "running" })],
      "m1",
      1_000,
    );
    expect(s.kind).toBe("waiting");
    expect(s.kind === "waiting" && s.recheckAt).toBeUndefined();
  });

  it("a correlated row that already SETTLED does not reopen a waiting", () => {
    // The module's own rule: a task settled silently carries no resultText, and
    // "the generic state is honest". The grace must not overrule it — it only
    // covers the case where NOTHING correlated.
    expect(
      assistantEmptyState(
        SETTLED,
        [SPAWN, OK_YIELD],
        [row({ childSessionKey: "agent:files:subagent:k1", kind: "task", status: "done" })],
        "m1",
        1_100,
      ),
    ).toEqual({ kind: "generic" });
  });

  it("with no settle stamp there is no grace — nothing is invented", () => {
    expect(
      assistantEmptyState(COMPLETE_EMPTY, [SPAWN, OK_YIELD], [], "m1", 1_100),
    ).toEqual({ kind: "generic" });
  });
});


// THE CANONICAL SOURCE, AND THE ONE THAT SURVIVES ELISION.
//
// A spawn result carries the same object twice: destructured under `details`, and
// re-serialized inside `content[0].text`. Upstream's own normalizer reads only the
// first; this reader parsed the echo, which is how it spent months not noticing
// that the array key had been renamed. And when the window read elides an oversized
// output, the echo is the part that goes — a `sessions_spawn` repeats its whole
// brief there — so on exactly the turns that delegate the most work, the key
// vanished with it.
describe("a spawned child is recognised from the structured copy", () => {
  const KEY = "agent:files:subagent:615b0b0e";

  it("reads `details` even when the text echo says something else", () => {
    // If the two ever disagree, the destructured copy is the one upstream trusts.
    expect(
      extractSpawnedChildKeys([
        {
          toolName: "sessions_spawn",
          result: {
            details: { status: "accepted", childSessionKey: KEY },
            content: [{ type: "text", text: '{"childSessionKey":"agent:files:subagent:stale"}' }],
          },
        },
      ]),
    ).toEqual([KEY]);
  });

  it("falls back to the text echo for a gateway that sends no `details`", () => {
    expect(
      extractSpawnedChildKeys([
        {
          toolName: "sessions_spawn",
          result: { content: [{ text: JSON.stringify({ childSessionKey: KEY }) }] },
        },
      ]),
    ).toEqual([KEY]);
  });

  it("an ELIDED output still yields its key, from the remnant", () => {
    // The window read drops an oversized `output` entirely — it is ABSENT, not "a
    // string note" as an earlier comment claimed — and keeps `details` beside the
    // size note. This is the shape a big delegated brief produces.
    expect(
      extractSpawnedChildKeys([
        {
          toolName: "sessions_spawn",
          result: "output elided (11.2 kB)",
          resultDetails: { status: "accepted", childSessionKey: KEY },
        },
      ]),
    ).toEqual([KEY]);
  });

  it("an elided output with NO remnant yields nothing, and never throws", () => {
    expect(
      extractSpawnedChildKeys([
        { toolName: "sessions_spawn", result: "output elided (11.2 kB)" },
      ]),
    ).toEqual([]);
  });

  it("the correlation actually WORKS on an elided spawn — the point of all this", () => {
    const s = assistantEmptyState(
      { ...COMPLETE_EMPTY, settledAt: 1_000 },
      [
        {
          toolName: "sessions_spawn",
          result: "output elided (11.2 kB)",
          resultDetails: { childSessionKey: KEY },
        },
        { toolName: "sessions_yield", phase: "completed" },
      ],
      [row({ childSessionKey: KEY, status: "running", taskName: "r003" })],
      undefined,
      1_100,
    );
    // Correlated by KEY alone (no parentMessageId passed): a BACKED waiting, with
    // the task name and no expiry — not the bounded guess.
    expect(s).toEqual({ kind: "waiting", taskName: "r003" });
  });
});
