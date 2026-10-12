// Where a deletion of a delegation's answer starts (transcript redesign phase 5, codex pass 1
// #4). On a projected instance a delegation reads as ONE answer across consecutive bubbles
// sharing `displayGroupId` (the id of the group's first bubble). Deleting / regenerating
// that answer starts at its FIRST bubble, whichever bubble the request named — the client
// and the server apply this same pure rule, so the optimistic truncation and the real one
// agree. Fail closed: the head is used only when every message between it and the target
// is a bubble of the same group; otherwise the target itself.

export type HeadCandidate = {
  _id: string;
  role: string;
  displayGroupId?: string;
  _creationTime?: number;
  orderTime?: number;
};

/** `ordered`: the conversation's messages in display order (listByChat / compareOrder).
 *  `coveredFrom`: the list holds EVERY message created since this time (codex phase 5 pass
 *  8 #3) — the server passes its whole conversation (no bound), the client its window's
 *  oldest creation time. A head displayed before it is not proven: the target stays. */
export function deletionStart<M extends HeadCandidate>(
  ordered: readonly M[],
  target: M,
  coveredFrom = Number.NEGATIVE_INFINITY,
): M {
  const group = target.displayGroupId;
  if (target.role !== "assistant" || group === undefined || group === target._id) return target;
  const at = ordered.findIndex((m) => m._id === target._id);
  const head = ordered.findIndex((m) => m._id === group);
  if (at < 0 || head < 0 || head >= at) return target;
  const h = ordered[head]!;
  if (h._creationTime !== undefined && Math.min(h._creationTime, h.orderTime ?? h._creationTime) < coveredFrom) {
    return target;
  }
  for (let i = head; i < at; i++) {
    const m = ordered[i]!;
    if (m.role !== "assistant" || m.displayGroupId !== group) return target;
  }
  return ordered[head]!;
}

/** The bubbles of the display group `target` belongs to, in display order — the
 *  consecutive assistant messages sharing its `displayGroupId`, head included (the same
 *  members the reader sees as one answer, src/chat/displayGroups.ts). Just `[target]` for a
 *  bubble shown alone. */
export function groupMembers<M extends HeadCandidate>(ordered: readonly M[], target: M): M[] {
  const group = target.displayGroupId;
  const at = ordered.findIndex((m) => m._id === target._id);
  if (target.role !== "assistant" || group === undefined || at < 0) return [target];
  const same = (m: M | undefined) => m !== undefined && m.role === "assistant" && m.displayGroupId === group;
  let lo = at;
  let hi = at;
  while (same(ordered[lo - 1])) lo--;
  while (same(ordered[hi + 1])) hi++;
  return ordered.slice(lo, hi + 1);
}

/** The text a display group shows as one answer: every member's text, trimmed, in order,
 *  separated by a blank line — the client's `groupText` (src/chat/displayGroups.ts). */
export function groupTextOf(members: ReadonlyArray<{ text: string }>): string {
  return members
    .map((m) => m.text.trim())
    .filter((t) => t !== "")
    .join("\n\n");
}
