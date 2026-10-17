// THE ORDER THE CONTROL UI SHOWS TRANSCRIPT ROWS IN (final design §3.3, step 3).
//
// Port of upstream `composeTranscriptDisplay` (src/chat/transcript-display-position.ts:37-145
// at v2026.9.33): rows arrive in their physical order (`seq`); runs of one transcript
// `source` whose stable rows are monotonic are recomposed so that each nested activity row
// (`activity: {afterRawSeq, scopeId, startOrder}`, a code-mode tool call) is shown right
// after the stable row it follows, its scope's cohort ordered by `startOrder`. A row
// without a position is a causal barrier. Pure; the same input always gives the same
// output, and an input that needs no recomposition is returned as is.

import type { TranscriptPosition } from "./transcriptContent";

export function composeTranscriptDisplay<T>(values: readonly T[], positionOf: (value: T) => TranscriptPosition | undefined): T[] {
  const output: T[] = [];
  let start = 0;
  let positions: TranscriptPosition[] = [];
  let activities: number[] = [];
  let previousStableSeq: number | undefined;
  let monotonic = true;
  const flush = (): void => {
    if (positions.length === 0) return;
    const current = positions;
    const activityIndexes = activities;
    const recompose = monotonic && activityIndexes.length > 0;
    positions = [];
    activities = [];
    previousStableSeq = undefined;
    monotonic = true;
    if (!recompose) return;
    const selected = output.splice(start);
    const ordered = [...activityIndexes].sort((left, right) => {
      const a = current[left]!.activity!.afterRawSeq;
      const b = current[right]!.activity!.afterRawSeq;
      if (a === b) return current[left]!.rawSeq - current[right]!.rawSeq;
      if (a === null) return -1;
      return b === null ? 1 : a - b;
    });
    let next = 0;
    const emitGap = (beforeRawSeq?: number): void => {
      let cohorts: Map<string, { firstSeq: number; rows: number[] }> | undefined;
      while (next < ordered.length) {
        const index = ordered[next]!;
        const position = current[index]!;
        const activity = position.activity!;
        if (beforeRawSeq !== undefined && activity.afterRawSeq !== null && activity.afterRawSeq >= beforeRawSeq) {
          break;
        }
        cohorts ??= new Map();
        let cohort = cohorts.get(activity.scopeId);
        if (!cohort) {
          cohort = { firstSeq: position.rawSeq, rows: [] };
          cohorts.set(activity.scopeId, cohort);
        }
        cohort.firstSeq = Math.min(cohort.firstSeq, position.rawSeq);
        cohort.rows.push(index);
        next += 1;
      }
      if (!cohorts) return;
      for (const cohort of [...cohorts.values()].sort((a, b) => a.firstSeq - b.firstSeq)) {
        const sorted = [...cohort.rows].sort(
          (a, b) =>
            current[a]!.activity!.startOrder - current[b]!.activity!.startOrder || current[a]!.rawSeq - current[b]!.rawSeq,
        );
        for (const index of sorted) output.push(selected[index]!);
      }
    };
    for (let index = 0; index < current.length; index += 1) {
      const position = current[index]!;
      if (!position.activity) {
        emitGap(position.rawSeq);
        output.push(selected[index]!);
      }
    }
    emitGap();
  };
  for (const value of values) {
    const position = positionOf(value);
    if (!position) {
      flush();
      output.push(value);
      start = output.length;
      continue;
    }
    if (positions[positions.length - 1]?.source !== position.source) {
      flush();
      start = output.length;
    }
    if (position.activity) {
      activities.push(positions.length);
    } else {
      monotonic &&= previousStableSeq === undefined || previousStableSeq <= position.rawSeq;
      previousStableSeq = position.rawSeq;
    }
    positions.push(position);
    output.push(value);
  }
  flush();
  return output;
}
