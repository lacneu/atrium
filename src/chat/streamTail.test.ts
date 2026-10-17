// The cumulative-tail resolver, ported AS IS (src/chat/streamTail.ts ←
// ui/src/pages/chat/stream-causal-boundary.ts:208-300 at v2026.9.33). The upstream cases of
// ui/src/pages/chat/stream-reconciliation.test.ts that call it (:83-124), inputs kept,
// messages mapped onto the identity the resolver reads (`__openclaw.idempotencyKey`
// "active-run" names the run; `openclawStreamFallback` with a non-blank item id is a keyed
// commentary segment), then Atrium's own call (`activeBubbleTail`: no replayed event).
import { describe, expect, it } from "vitest";
import { activeBubbleTail, resolveCumulativeAssistantTail, type StreamMessage } from "./streamTail";

const RUN = "active-run";
const assistant = (text: string, runId: string | null = RUN, commentaryItemId?: string): StreamMessage => ({
  role: "assistant",
  runId,
  text,
  ...(commentaryItemId !== undefined ? { commentaryItemId } : {}),
});

describe("stream-reconciliation.test.ts (v2026.9.33) — resolveCumulativeAssistantTail", () => {
  // :83-107
  it.each([
    { name: "commentary mirror", itemId: "commentary" as string | undefined, text: "Progress", tail: "C" },
    { name: "matching commentary mirror", itemId: "commentary", text: "BC", tail: "C" },
    { name: "ordinary assistant", itemId: undefined, text: "Other answer", tail: "BC" },
    { name: "unkeyed fallback", itemId: undefined, text: "Other answer", tail: "BC" },
    // A blank item id is no item id (readAssistantStreamSegmentIdentity).
    { name: "blank item id", itemId: undefined, text: "Other answer", tail: "BC" },
  ])("subtracts the cumulative prefix across an interleaved $name", ({ itemId, text, tail }) => {
    expect(resolveCumulativeAssistantTail([assistant("A"), assistant(text, RUN, itemId), assistant("B")], "ABC", RUN)).toBe(tail);
  });

  // :109-124
  it("does not anchor cumulative coverage on matching commentary before an older reply", () => {
    const messages: StreamMessage[] = [
      assistant("ABC", RUN, "commentary"),
      assistant("ABC", null),
      { role: "user", runId: null, text: "Current request" },
      assistant("A"),
      assistant("B"),
    ];
    expect(resolveCumulativeAssistantTail(messages, "ABC", RUN)).toBe("C");
  });
});

describe("Atrium's call: the fresh adoption with no replayed commentary event (chat-history-stream.ts:342-348)", () => {
  it("codex review 9: a persisted commentary segment is the stream's prefix evidence — only the rest stays live", () => {
    expect(activeBubbleTail([assistant("A", RUN, "item-a")], "A\n\nB", RUN)).toBe("\n\nB");
  });
  it("a replayed item event would own it instead (the upstream live pane)", () => {
    expect(resolveCumulativeAssistantTail([assistant("A", RUN, "item-a")], "A\n\nB", RUN, 1, new Set(["item-a"]))).toBe("A\n\nB");
  });
  it("no row owns a prefix: the whole stream is the message being written", () => {
    expect(activeBubbleTail([assistant("Synthetic audit complete.")], "Je continue le travail.", RUN)).toBe("Je continue le travail.");
  });
  it("the rows' texts, a separator between them, then the tail", () => {
    expect(activeBubbleTail([assistant("Premier."), assistant("Deuxième.")], "Premier.\n\nDeuxième.\n\nTroisi", RUN)).toBe("\n\nTroisi");
  });
  it("a row that extends past the stream: nothing left to show", () => {
    expect(activeBubbleTail([assistant("Premier message complet.")], "Premier mess", RUN)).toBeNull();
  });
  it("a mirror naming no run is evidence after the turn's start, as upstream reads it", () => {
    expect(activeBubbleTail([assistant("Avant."), assistant("Miroir.", null)], "Avant.\n\nMiroir.\n\nSuite", RUN)).toBe("\n\nSuite");
  });
});
