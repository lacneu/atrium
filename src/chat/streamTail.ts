// WHAT THE LIVE STREAM STILL SAYS THAT NO ROW SAYS YET (codex reviews 7 and 9) — the Control
// UI's rule, ported AS IS from ui/src/pages/chat/stream-causal-boundary.ts:208-300 at
// v2026.9.33 (`resolveCumulativeAssistantTail`, `resolveAssistantTextTail`,
// `resolveAssistantTextCandidateTail`), over the message identity the upstream reads
// (`readSessionMessageIdentity`: role, runId; `readAssistantStreamSegmentIdentity`: a keyed
// stream segment — commentary; `extractTextCached`: its text), which Convex states per row.
//
// The gateway keeps ONE cumulative buffer per run (src/gateway/server-chat.ts
// `emitChatDelta` → `chatRunState.updateBuffer`): a `chat` delta carries the run's whole text
// so far, with no message identity. The rows' texts are consumed IN ORDER from its head (a
// separator between two allowed); only what is left is the message still being written.
//
// Atrium's case is the Control UI's FRESH ADOPTION of a run from history
// (ui/src/pages/chat/chat-history-stream.ts `applyHistoryRun`, :336-348): rows + cumulative
// text, and the commentary item events it REPLAYED (`replayedCommentaryItemIds`, :81-97).
// Atrium replays none (no event history reaches the view), so it passes the EMPTY set: a
// keyed commentary row is then prefix evidence, skipped on mismatch — "if replay eviction
// removed that event, the persisted mirror is the only prefix evidence left" (:240-241).

/** One message as the resolver reads it. */
export type StreamMessage = {
  role: string;
  /** `__openclaw.runId` (null: a row that names no run). */
  runId: string | null;
  /** A keyed stream segment (`openclawStreamFallback: {source:"segment", itemId}`). */
  commentaryItemId?: string;
  text: string | null;
};

/** stream-causal-boundary.ts:29 `lastUserMessageIndex`. */
function lastUserMessageIndex(messages: readonly StreamMessage[], beforeIndex = messages.length): number {
  for (let index = Math.min(beforeIndex, messages.length) - 1; index >= 0; index -= 1) {
    if (messages[index]!.role === "user") return index;
  }
  return -1;
}

/** stream-causal-boundary.ts:208 `resolveCumulativeAssistantTail`. */
export function resolveCumulativeAssistantTail(
  messages: readonly StreamMessage[],
  cumulativeText: string,
  runId: string,
  endIndex = messages.length,
  replayedCommentaryItemIds?: ReadonlySet<string>,
): string | null {
  let ownedPrefixIndex = -1;
  for (let index = 0; index < endIndex; index += 1) {
    const message = messages[index]!;
    const replayOwnsCommentary =
      message.commentaryItemId !== undefined &&
      (replayedCommentaryItemIds === undefined || replayedCommentaryItemIds.has(message.commentaryItemId));
    const persistedText = message.runId === runId && !replayOwnsCommentary ? message.text : null;
    if (
      message.role === "assistant" &&
      persistedText &&
      (cumulativeText.startsWith(persistedText) || persistedText.startsWith(cumulativeText))
    ) {
      ownedPrefixIndex = index;
      break;
    }
  }
  const turnStart = ownedPrefixIndex >= 0 ? ownedPrefixIndex : lastUserMessageIndex(messages, endIndex) + 1;
  const persistedTexts = messages.slice(turnStart, endIndex).map((message) => {
    const replayOwnsCommentary =
      message.commentaryItemId !== undefined &&
      (replayedCommentaryItemIds === undefined || replayedCommentaryItemIds.has(message.commentaryItemId));
    const text =
      message.role === "assistant" && (!message.runId || message.runId === runId) && !replayOwnsCommentary
        ? message.text
        : null;
    return { text, skipOnMismatch: message.commentaryItemId !== undefined };
  });
  return resolveAssistantTextCandidateTail(persistedTexts, cumulativeText);
}

/** stream-causal-boundary.ts:257 `resolveAssistantTextTail`. */
export function resolveAssistantTextTail(persistedTexts: readonly (string | null)[], cumulativeText: string): string | null {
  return resolveAssistantTextCandidateTail(
    persistedTexts.map((text) => ({ text, skipOnMismatch: false })),
    cumulativeText,
  );
}

/** stream-causal-boundary.ts:267 `resolveAssistantTextCandidateTail`. */
function resolveAssistantTextCandidateTail(
  persistedTexts: readonly { text: string | null; skipOnMismatch: boolean }[],
  cumulativeText: string,
): string | null {
  let persistedPrefixLength = 0;
  for (const { text: persistedText, skipOnMismatch } of persistedTexts) {
    if (!persistedText) continue;
    const remaining = cumulativeText.slice(persistedPrefixLength);
    if (remaining.startsWith(persistedText)) {
      persistedPrefixLength += persistedText.length;
      continue;
    }
    if (persistedText.startsWith(remaining)) return null;
    const whitespace = persistedPrefixLength > 0 ? /^\s+/u.exec(remaining)?.[0] : undefined;
    if (whitespace && remaining.slice(whitespace.length).startsWith(persistedText)) {
      persistedPrefixLength += whitespace.length + persistedText.length;
      continue;
    }
    if (whitespace && persistedText.startsWith(remaining.slice(whitespace.length))) return null;
    if (skipOnMismatch) continue;
    if (persistedPrefixLength > 0) break;
  }
  return cumulativeText.slice(persistedPrefixLength);
}

/** The tail of an Atrium active bubble: the fresh-adoption call (chat-history-stream.ts
 *  :342-348) with no replayed commentary event. */
export function activeBubbleTail(messages: readonly StreamMessage[], cumulativeText: string, runId: string): string | null {
  return resolveCumulativeAssistantTail(messages, cumulativeText, runId, messages.length, new Set());
}
