/**
 * WHY a frame of another run was refused as this turn's continuation.
 *
 * The bridge already counted these (`foreignRunsRefused`), but only the TOTAL
 * reached the trace — and the total cannot answer the question it raises. Two of
 * the four reasons are OPPOSITE facts:
 *
 *  - `gateway_initiated` and `heartbeat` are the guard working as designed. An
 *    announce chain, a task delivery, a talk consult or a heartbeat is its own
 *    turn and becomes its own message; refusing it is what stops it closing the
 *    user's turn with someone else's text. A session with twenty sub-agents
 *    produces these by the dozen, and they mean nothing is wrong.
 *  - `no_grace` and `compaction_no_replay_signal` are the guard REFUSING
 *    something it could not place. Each one is a frame the turn did not use. If
 *    the turn then finalizes empty, these are where the answer went.
 *
 * Collapsed into one number the two are indistinguishable, which is exactly the
 * state a 2026-09-20 production turn left us in: 21 refusals on a turn that ended
 * `empty_final_timeout`, and no way to tell a healthy announce storm from a lost
 * reply without reading the bridge's own log.
 *
 * ALLOWLISTED, like `compactionReason`: the bridge sends the raw map, this is the
 * only vocabulary that reaches storage. An unfamiliar reason is COUNTED under
 * `other` rather than dropped — losing the count would understate the refusals,
 * and keeping the unknown NAME would let a future bridge write an unreviewed
 * string into the trace.
 */

/** The reasons `normalizer.foreignRunRefusal` can return, verbatim. */
export const FOREIGN_RUN_REFUSAL_REASONS = [
  "heartbeat",
  "gateway_initiated",
  "compaction_no_replay_signal",
  "no_grace",
] as const;

export type ForeignRunRefusalReason =
  | (typeof FOREIGN_RUN_REFUSAL_REASONS)[number]
  | "other";

const KNOWN = new Set<string>(FOREIGN_RUN_REFUSAL_REASONS);

/** The reasons that mean a frame the turn COULD have used was refused. */
export const FOREIGN_RUN_REFUSAL_COSTLY: readonly ForeignRunRefusalReason[] = [
  "no_grace",
  "compaction_no_replay_signal",
  "other",
];

/**
 * A raw `{reason: count}` map, reduced to the allowlisted vocabulary.
 *
 * Returns null when nothing survives, so a caller spreads `{}` rather than an
 * empty object — the trace says "not measured" instead of "measured zero".
 */
export function classifyForeignRunRefusals(
  raw: unknown,
): Partial<Record<ForeignRunRefusalReason, number>> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const out: Partial<Record<ForeignRunRefusalReason, number>> = {};
  let any = false;
  for (const [reason, count] of Object.entries(raw as Record<string, unknown>)) {
    // A non-integer or negative count is not a count. Refused rather than
    // coerced: a NaN summed into a total makes the WHOLE trace unreadable.
    if (typeof count !== "number" || !Number.isInteger(count) || count <= 0) continue;
    const key: ForeignRunRefusalReason = KNOWN.has(reason)
      ? (reason as ForeignRunRefusalReason)
      : "other";
    out[key] = (out[key] ?? 0) + count;
    any = true;
  }
  return any ? out : null;
}

/** How many of the refusals cost the turn a frame it could have used. */
export function costlyForeignRunRefusals(
  classified: Partial<Record<ForeignRunRefusalReason, number>> | null,
): number {
  if (classified === null) return 0;
  let n = 0;
  for (const reason of FOREIGN_RUN_REFUSAL_COSTLY) n += classified[reason] ?? 0;
  return n;
}
