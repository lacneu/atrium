// WHICH PRODUCER wrote a `message.snapshot` — a closed vocabulary, mirrored in
// convex/lib/snapshotRegression.ts (a convex test holds the two in lockstep).
//
// Why it exists (prod 2026-10-13): one turn had 25 snapshots refused by Convex's
// anti-regression guard (G-14) in nine seconds — two producers were feeding the same
// message, one with the whole turn, one with only the post-tool segment — and nothing
// recorded which frame produced which write. Each value names ONE code path that emits a
// snapshot; the guard's trace carries it, so the next occurrence names the second
// producer instead of leaving it to inference.
//
// Structural only: an enum value, never text. Adding a producer path means adding a value
// here AND in the Convex mirror (unknown values degrade to "other" server-side).

export const SNAPSHOT_SOURCES = [
  /** OpenClaw `chat` delta carrying the message so far (`message` content, not `delta`). */
  "chat_delta",
  /** OpenClaw `chat` final carrying the message. */
  "chat_final",
  /** OpenClaw `chat` delta with `replace: true` (ChatDeltaEventSchema.replace refresh). */
  "chat_delta_replace",
  /** OpenClaw `agent` stream `assistant`, full `text`. */
  "agent_assistant_text",
  /** OpenClaw `agent` stream `assistant` with `replace: true` (text or delta refresh). */
  "agent_assistant_replace",
  /** OpenClaw `message` tool start: the visible reply read from its args. */
  "message_tool",
  /** The empty snapshot clearing an invalidated prefix on a mid-turn compaction. */
  "compaction_reset",
  /** Turn-sink text-first write of the final text before awaiting media uploads. */
  "early_text_media",
  /** Hermes REST `assistant.completed` authoritative text. */
  "hermes_assistant_completed",
  /** Plain `message.delta` stream (never a snapshot: only names what the kept text came
   *  from, `keptSource`). */
  "delta_stream",
] as const;

export type SnapshotSource = (typeof SNAPSHOT_SOURCES)[number];

const KNOWN: ReadonlySet<string> = new Set(SNAPSHOT_SOURCES);

/** Narrow an event field to the vocabulary; anything else is dropped (never sent). */
export function asSnapshotSource(v: unknown): SnapshotSource | undefined {
  return typeof v === "string" && KNOWN.has(v) ? (v as SnapshotSource) : undefined;
}
