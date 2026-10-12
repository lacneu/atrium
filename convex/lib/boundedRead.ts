// ONE BOUNDED READER for the index ranges phase 5 walks (transcript redesign, codex phase 5
// passes 5, 6 and 10). Every read is PAID BEFORE it happens: each step asks for as many
// documents as the budget left can pay at their largest possible size (a Convex document
// is at most 1 MiB), counts the UTF-8 bytes of every document actually returned, and
// continues after the last one. So a range never pushes its transaction past what the
// caller allotted, whatever the documents weigh.

import { utf8Bytes } from "./bubbleProjection";

/** The largest document Convex stores: what a read that has not happened yet may cost. */
export const MAX_DOC_BYTES = 1024 * 1024;

/** Bytes read so far, against a limit the caller set. */
export type ReadBudget = { bytes: number; limit: number };

/**
 * Read an index range in key order under `budget`. Stops at `max` documents, at the budget,
 * or at the end; `cut` = it stopped before the end. Documents sharing the restart key are
 * not lost: the next step starts AT that key and skips the ids already read (paid again).
 */
export async function readBounded<D extends { _id: string; _creationTime: number }>(
  budget: ReadBudget,
  max: number,
  step: (from: number | null, n: number) => Promise<D[]>,
  /** The key the index orders the range by after its equality prefix (creation time unless
   *  the index names another field): where a next step restarts. */
  keyOf: (d: D) => number = (d) => d._creationTime,
): Promise<{ docs: D[]; cut: boolean }> {
  const docs: D[] = [];
  const seen = new Set<string>();
  let from: number | null = null;
  for (;;) {
    const affordable = Math.floor((budget.limit - budget.bytes) / MAX_DOC_BYTES);
    const tail = from === null ? 0 : docs.filter((d) => keyOf(d) === from).length;
    const want = Math.min(max - docs.length, affordable - tail);
    if (want <= 0) return { docs, cut: true };
    const ask = want + tail;
    const batch = await step(from, ask);
    let fresh = 0;
    for (const d of batch) {
      budget.bytes += utf8Bytes(JSON.stringify(d));
      if (seen.has(d._id)) continue;
      seen.add(d._id);
      docs.push(d);
      fresh++;
    }
    if (batch.length < ask) return { docs, cut: false };
    if (fresh === 0) return { docs, cut: true };
    from = keyOf(docs[docs.length - 1]!);
  }
}
