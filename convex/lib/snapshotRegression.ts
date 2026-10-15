// The anti-regression guard's DIAGNOSTICS (G-14) — which producer wrote a refused
// snapshot, and how often one stream was refused. Observation only: nothing here
// takes part in the guard's accept/refuse decision (stream.setSnapshot).
//
// Prod 2026-10-13: one turn had 25 snapshots refused in nine seconds, each traced on its
// own, and none said which frame produced it. Two producers were feeding one message (the
// whole turn, and only the post-tool segment); the bridge's stdout that could have named
// them was lost on redeploy. Now the FIRST refusal of a stream is traced with the
// producer's path, later ones only count on the live row, and the stream's end emits ONE
// summary when there was more than one.
//
// Pure (validators + state arithmetic): imported by the schema, so no ctx, no I/O.

import { v, type Infer } from "convex/values";

/** Mirrors the bridge's SNAPSHOT_SOURCES (bridge/src/core/snapshot-source.ts), plus
 *  `other` for a value this Convex does not know (a newer bridge). A lockstep test
 *  holds the two lists together. */
export const SNAPSHOT_SOURCES = [
  "chat_delta",
  "chat_final",
  "chat_final_truncated",
  "chat_delta_replace",
  "agent_assistant_text",
  "agent_assistant_replace",
  "message_tool",
  "history_recovery",
  "compaction_reset",
  "early_text_media",
  "hermes_assistant_completed",
  "delta_stream",
  "other",
] as const;
export type SnapshotSourceValue = (typeof SNAPSHOT_SOURCES)[number];

export const snapshotSourceValidator = v.union(
  ...SNAPSHOT_SOURCES.map((s) => v.literal(s)),
);

const KNOWN: ReadonlySet<string> = new Set(SNAPSHOT_SOURCES);

/**
 * The bridge's claim, reduced to the closed vocabulary. Absent stays absent (a bridge
 * older than the field said nothing — it must not read as a producer); anything else
 * outside the list becomes `other`. Never a free string.
 */
export function normalizeSnapshotSource(
  value: unknown,
): SnapshotSourceValue | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" && KNOWN.has(value)
    ? (value as SnapshotSourceValue)
    : "other";
}

/** The counters a live row carries once its stream had a refusal. Bounded: the source
 *  sets can never exceed the vocabulary. Transient — the row dies with the turn. */
export const snapshotRegressionValidator = v.object({
  count: v.number(),
  /** max(oldLen - newLen) over the refusals. */
  maxGap: v.number(),
  /** Producers of the REFUSED snapshots seen on this stream. */
  sources: v.array(snapshotSourceValidator),
  /** Producers of the text that was KEPT at each refusal, as the bridge reported them. */
  keptSources: v.array(snapshotSourceValidator),
  firstAt: v.number(),
  lastAt: v.number(),
  lastOldLen: v.number(),
  lastNewLen: v.number(),
});
export type SnapshotRegressionState = Infer<typeof snapshotRegressionValidator>;

function withSource(
  set: SnapshotSourceValue[],
  source: SnapshotSourceValue | undefined,
): SnapshotSourceValue[] {
  if (source === undefined || set.includes(source)) return set;
  if (set.length >= SNAPSHOT_SOURCES.length) return set;
  return [...set, source];
}

/** The row's counters after one more refusal. `first` = no refusal before on this row:
 *  the caller traces that one in full, and only counts the others. */
export function nextRegressionState(
  prev: SnapshotRegressionState | undefined,
  refusal: {
    oldLen: number;
    newLen: number;
    source: SnapshotSourceValue | undefined;
    kept: SnapshotSourceValue | undefined;
    now: number;
  },
): { state: SnapshotRegressionState; first: boolean } {
  const gap = Math.max(0, refusal.oldLen - refusal.newLen);
  if (prev === undefined) {
    return {
      first: true,
      state: {
        count: 1,
        maxGap: gap,
        sources: withSource([], refusal.source),
        keptSources: withSource([], refusal.kept),
        firstAt: refusal.now,
        lastAt: refusal.now,
        lastOldLen: refusal.oldLen,
        lastNewLen: refusal.newLen,
      },
    };
  }
  return {
    first: false,
    state: {
      count: prev.count + 1,
      maxGap: Math.max(prev.maxGap, gap),
      sources: withSource(prev.sources, refusal.source),
      keptSources: withSource(prev.keptSources, refusal.kept),
      firstAt: prev.firstAt,
      lastAt: refusal.now,
      lastOldLen: refusal.oldLen,
      lastNewLen: refusal.newLen,
    },
  };
}

/** What the end-of-stream summary trace carries (lengths, counts, enum values only). */
export type RegressionSummary = {
  regressionCount: number;
  maxGap: number;
  sources: SnapshotSourceValue[];
  keptSources: SnapshotSourceValue[];
  lastOldLen: number;
  lastNewLen: number;
  spanMs: number;
};

/** The summary for a stream ending with these counters — null unless there was MORE
 *  than one refusal (a single one is already fully described by its own trace). */
export function regressionSummary(
  state: SnapshotRegressionState | undefined,
): RegressionSummary | null {
  if (state === undefined || state.count <= 1) return null;
  return {
    regressionCount: state.count,
    maxGap: state.maxGap,
    sources: state.sources,
    keptSources: state.keptSources,
    lastOldLen: state.lastOldLen,
    lastNewLen: state.lastNewLen,
    spanMs: Math.max(0, state.lastAt - state.firstAt),
  };
}
