import { m } from "@/paraglide/messages.js";
import type { ToolActivityPart } from "./toolActivityView";
import { toolFamily, type ToolFamily } from "./runStatusView";

// Pure logic for the INTERLEAVED run representation (ChatGPT/Codex-style):
// tool parts anchored by their textOffset are folded into the narrative as
// collapsed activity rows at their true position between paragraphs.
//
// Invariants (each pinned by turnFlowView.test.ts):
//   - cuts are STABLE: the exact anchor offset (fence-protected) — during a
//     stream the sequence is APPEND-ONLY, never reordered (the useClientLookup
//     crash class), and bookmark/quote-reply block indexes stay stable;
//   - cuts are MONOTONE non-decreasing in part order (an out-of-order offset
//     clamps to the previous cut — cards never reorder);
//   - consecutive anchors with no visible text between their cuts merge into
//     ONE activity group;
//   - whitespace-only text segments are dropped (no empty bubbles).

export interface AnchoredActivity {
  offset: number;
  activity: ToolActivityPart;
}

export type FlowSegment =
  | { kind: "text"; text: string }
  | {
      kind: "activity";
      parts: ToolActivityPart[];
      /** The group's FIXED cut position — a STABLE identity for the rendered
       *  tool-call part (an index-based id changed when segments shifted,
       *  breaking assistant-ui's per-part bookkeeping). */
      cut: number;
    };

/** Ranges of FENCED code blocks (```/~~~ per CommonMark: closer same char, at
 *  least as long, no info string, ≤3 spaces indent; an unterminated fence runs
 *  to the end — streaming). Used to keep a cut from landing INSIDE a fence.
 *  KNOWN LIMIT (accepted): a fence nested ≥4 raw spaces deep (two list levels)
 *  is not recognized — list-context parsing would be required, and 4+ spaces
 *  OUTSIDE a list is an indented code block where a ``` line is literal. */
function fenceRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const re = /^ {0,3}(`{3,}|~{3,})(.*)$/gm;
  let open = -1;
  let openChar = "";
  let openLen = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const ch = m[1]![0]!;
    if (open === -1) {
      open = m.index;
      openChar = ch;
      openLen = m[1]!.length;
    } else if (
      ch === openChar &&
      m[1]!.length >= openLen &&
      /^[ \t]*$/.test(m[2]!)
    ) {
      ranges.push([open, m.index + m[1]!.length]);
      open = -1;
    }
  }
  if (open !== -1) ranges.push([open, text.length]);
  return ranges;
}

/** STABLE cut for an anchor: the exact offset (clamped), pulled back to the
 *  START of the enclosing fence when it would land inside one.
 *
 *  STABILITY IS THE LOAD-BEARING INVARIANT (the useClientLookup crash): during
 *  a stream the text only GROWS at the end and offsets are FIXED, so an exact
 *  cut NEVER moves between conversions — the content-part sequence is
 *  append-only and assistant-ui's per-part bookkeeping stays valid. (The
 *  earlier snap-to-"\n\n" moved cuts as boundaries appeared, reordering parts
 *  mid-stream and crashing the renderer.) A fence's START is fixed the moment
 *  its opener is written — before any offset inside it — so the pull-back is
 *  stable too. Cutting at the exact offset is also the true Codex model: the
 *  tool INTERRUPTS the flow where the model actually called it. */
export function stableCut(text: string, offset: number): number {
  const o = Math.max(0, offset);
  if (o === 0) return 0;
  // An offset BEYOND the current text (the part reached the client before its
  // text did — parts and streamed text are two reactive sources) keeps its
  // REQUESTED identity and simply renders at the end until the text catches
  // up: min(cut, length) at slice time, so the sequence stays append-only.
  if (o >= text.length) return o;
  // Content BEFORE the offset is frozen (text only grows at the end), so the
  // fence pull-back is stable from the first evaluation.
  for (const [a, b] of fenceRanges(text)) {
    if (o > a && o < b) return a;
  }
  return o;
}

export function buildTurnFlow(
  text: string,
  anchored: AnchoredActivity[],
  opts?: {
    /** FALSE while the message still streams: a group whose cut lies BEYOND
     *  the current text (its deltas have not arrived — two reactive sources)
     *  is DEFERRED, not rendered, because materializing it early and letting
     *  text appear between two early-merged groups later would INSERT parts
     *  mid-sequence (the tearing class). On a settled message the text is
     *  final, so beyond-text cuts clamp and everything renders. */
    settled?: boolean;
  },
): FlowSegment[] {
  const settled = opts?.settled ?? true;
  if (!settled) {
    anchored = anchored.filter((a) => a.offset <= text.length);
  }
  // NOTE — the OTHER race (text already past a late-landing anchor) is safe
  // WITHOUT deferral: the new cut is ≥ every existing cut (parts arrive in
  // order + monotone clamp), so the last text segment SHORTENS in place (same
  // index, same kind — a content change streaming already exercises) and the
  // new activity + tail APPEND at the end. Part count never decreases and no
  // existing index changes identity — pinned by the late-anchor layout test.
  if (anchored.length === 0) {
    return text.length > 0 ? [{ kind: "text", text }] : [];
  }
  // STABLE cuts, made monotone in PART order (arrival order is the truth;
  // a smaller late offset must not reorder cards above earlier ones).
  const groups: Array<{ cut: number; parts: ToolActivityPart[] }> = [];
  let prevCut = 0;
  for (const a of anchored) {
    const cut = Math.max(prevCut, stableCut(text, a.offset));
    prevCut = cut;
    const last = groups[groups.length - 1];
    if (last !== undefined && last.cut === cut) {
      last.parts.push(a.activity);
    } else {
      groups.push({ cut, parts: [a.activity] });
    }
  }
  // Merge adjacent groups separated by whitespace-only text (visually one
  // block of activity — two rows with an invisible gap read as a bug).
  const merged: typeof groups = [];
  for (const g of groups) {
    const last = merged[merged.length - 1];
    if (
      last !== undefined &&
      text
        .slice(Math.min(last.cut, text.length), Math.min(g.cut, text.length))
        .trim() === ""
    ) {
      last.parts.push(...g.parts);
    } else {
      merged.push(g);
    }
  }
  const out: FlowSegment[] = [];
  let pos = 0;
  for (const g of merged) {
    // Render position clamps to the available text; the IDENTITY (g.cut)
    // stays the requested offset (stable ids under out-of-order arrival).
    const at = Math.min(g.cut, text.length);
    const seg = text.slice(pos, at);
    if (seg.trim() !== "") out.push({ kind: "text", text: seg });
    out.push({ kind: "activity", parts: g.parts, cut: g.cut });
    pos = Math.max(pos, at);
  }
  const tail = text.slice(pos);
  if (tail.trim() !== "") out.push({ kind: "text", text: tail });
  return out;
}

// ── Group label ──────────────────────────────────────────────────────────────

const FAMILY_ORDER: ToolFamily[] = [
  "read",
  "exec",
  "search",
  "fetch",
  "write",
  "other",
];

const FRAGMENT: Record<
  ToolFamily,
  { one: (tool: string) => string; many: (count: number) => string }
> = {
  read: {
    one: () => m.turnflow_read_one(),
    many: (count) => m.turnflow_read_many({ count: String(count) }),
  },
  exec: {
    one: () => m.turnflow_exec_one(),
    many: (count) => m.turnflow_exec_many({ count: String(count) }),
  },
  search: {
    one: () => m.turnflow_search_one(),
    many: (count) => m.turnflow_search_many({ count: String(count) }),
  },
  fetch: {
    one: () => m.turnflow_fetch_one(),
    many: (count) => m.turnflow_fetch_many({ count: String(count) }),
  },
  write: {
    one: () => m.turnflow_write_one(),
    many: (count) => m.turnflow_write_many({ count: String(count) }),
  },
  other: {
    one: (tool) => m.turnflow_other_one({ tool }),
    many: (count) => m.turnflow_other_many({ count: String(count) }),
  },
};

export function isLivePhase(phase: string | undefined): boolean {
  return phase === "started" || phase === "running" || phase === "start";
}

/** The dominant family of a group (most members; ties break by FAMILY_ORDER) —
 *  drives the row icon. */
export function dominantFamily(parts: ToolActivityPart[]): ToolFamily {
  const counts = new Map<ToolFamily, number>();
  for (const p of parts) {
    const f = toolFamily(p.toolName);
    counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  let best: ToolFamily = "other";
  let bestCount = -1;
  for (const f of FAMILY_ORDER) {
    const c = counts.get(f) ?? 0;
    if (c > bestCount) {
      best = f;
      bestCount = c;
    }
  }
  return best;
}

/** Natural-language summary of an activity group.
 *  Live group (a tool still running) -> the PRESENT-tense working label of the
 *  running tool (same voice as the RunStatus chip). Settled group -> a composed
 *  past-tense phrase listing the family fragments joined by the localized
 *  separators (e.g. read-one, exec-many and search-one -> one sentence). */
export function activityLabel(
  parts: ToolActivityPart[],
  opts?: {
    /** FALSE forces the settled phrasing even when a part is stuck on `start`
     *  (lost completion frame on a terminal message — codex P2: the row
     *  showed a check next to a present-tense label). Default: derive. */
    live?: boolean;
  },
): string {
  const live =
    opts?.live === false
      ? undefined
      : [...parts].reverse().find((p) => isLivePhase(p.phase));
  if (live !== undefined) {
    const f = toolFamily(live.toolName);
    switch (f) {
      case "read":
        return m.runstatus_tool_read();
      case "exec":
        return m.runstatus_tool_exec();
      case "search":
        return m.runstatus_tool_search();
      case "fetch":
        return m.runstatus_tool_fetch();
      case "write":
        return m.runstatus_tool_write();
      default:
        return m.runstatus_tool_other({ tool: live.toolName });
    }
  }
  const byFamily = new Map<ToolFamily, ToolActivityPart[]>();
  for (const p of parts) {
    const f = toolFamily(p.toolName);
    const arr = byFamily.get(f) ?? [];
    arr.push(p);
    byFamily.set(f, arr);
  }
  const frags: string[] = [];
  for (const f of FAMILY_ORDER) {
    const members = byFamily.get(f);
    if (members === undefined) continue;
    frags.push(
      members.length === 1
        ? FRAGMENT[f].one(members[0]!.toolName)
        : FRAGMENT[f].many(members.length),
    );
  }
  const list =
    frags.length === 1
      ? frags[0]!
      : frags.slice(0, -1).join(m.turnflow_join()) +
        m.turnflow_join_last() +
        frags[frags.length - 1]!;
  const label = m.turnflow_prefix() + list;
  return label.charAt(0).toUpperCase() + label.slice(1);
}
