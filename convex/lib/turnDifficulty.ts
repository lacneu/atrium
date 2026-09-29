// LIVE-TURN DIFFICULTY: "is the agent struggling right now?" — a verdict, on the
// turn that is still running, and on nothing else.
//
// It exists because an agent that progresses and an agent that loops on a failure
// looked identical everywhere a reader looks while a turn runs: the sidebar's
// activity bar pulsed, the bubble said "working" (production reports
// prod-ms7ce20bmdhasm78gxhs19tvds8bpb48 and prod-ms732zdwn4c7xfc0kg14hntn258e6c31,
// ataraxis). The settled turn keeps its content-free SHAPE in the diagnostic
// chat-state (`summarizeToolActivity`, deliberately verdict-free); this module is the
// other half: a small, conservative verdict for the turn in flight.
//
// PURE and shared: the server computes the FACTS once (chatReads.liveTurnDifficulty,
// chat-state) and every surface — the sidebar's activity bar, the bubble's status
// line, diagnose — reads the SAME facts through the SAME verdict. Two derivations of
// one fact is how the work indicators diverged before; there is one here.
//
// THE RULES, AND THE PRODUCTION SHAPES BEHIND THEM (103 turns with tools, three
// ataraxis conversations, read 2026-09-28):
//
//  1. REPEATED FAILURES — the last DIFFICULTY_MIN_FAILURES (3) settled tool calls all
//     failed, with no success between them. Turns that finished fine carry isolated
//     failures (a 25-call turn with 3 errors, never more than 2 in a row; a 45-call
//     turn with 1) and long healthy runs (63, 60 and 41 calls, zero errors): none
//     has 3 failures in a row. Every turn that did was a real struggle: six
//     `sessions_history` refusals back to back, four `web_fetch`, four
//     `sessions_spawn`, three `browser` — two of them ended in a context overflow.
//     Clears when a tool call succeeds.
//
//  2. THE SAME TOOL KEEPS FAILING — the latest settled call is a failure of tool T,
//     and T failed DIFFICULTY_MIN_FAILURES times among the last SAME_TOOL_WINDOW (8)
//     settled calls without succeeding once in between. The agent retrying one tool
//     while interleaving other, successful calls (a read between two failed
//     view_image) escapes rule 1 and not this one. Clears when T succeeds or the
//     latest settled call is anything but a failure of T (the agent moved on).
//
//  3. QUIET AFTER A FAILURE — the latest tool call failed, nothing runs, and the turn
//     has produced nothing observable (no part, no text, no phase) for
//     STALL_AFTER_FAILURE_MS (2 min). This is the 2026-09-11 turn as it actually is
//     in the store: ONE failed `view_image` ("Local media path is not under an allowed
//     directory"), then 676 s of silence until response_timeout — the same shape as a
//     failed `ask_user` followed by 682 s of silence. Rules 1 and 2 cannot see it: it
//     is not a loop in the stored parts, it is a stall after a failure. Healthy turns
//     average 8-16 s per tool call (93 calls in 738 s, 11 in 165 s, 13 in 205 s), so
//     2 min of silence right after a failure is 8-15x the usual gap, and it still
//     leaves the reader ~9 minutes before the gateway's own timeout. Clears on ANY
//     activity. Suppressed while the turn declares a legitimate wait (a person must
//     answer, compaction, provider back-off, delegated work).
//
// Nothing here reads content: tool NAMES and PHASES only — what the chat-state
// projection already carries.

/** Consecutive (rule 1) or same-tool (rule 2) failures that make a difficulty. */
export const DIFFICULTY_MIN_FAILURES = 3;

/** How many of the latest SETTLED tool calls rule 2 looks back over. */
export const SAME_TOOL_WINDOW = 8;

/** Silence after a failed tool call that makes a difficulty (rule 3). */
export const STALL_AFTER_FAILURE_MS = 2 * 60 * 1000;

/** How many of a live turn's most recent parts the server reads. The rules only ever
 *  look at the tail (3 in a row, 8 settled calls), so the read stays bounded however
 *  long the turn gets. */
export const LIVE_PART_WINDOW = 24;

/** Stream phases that name a LEGITIMATE wait: silence under them is not a stall. */
export const WAITING_PHASES: ReadonlySet<string> = new Set([
  "awaiting_approval",
  "awaiting_input",
  "awaiting_subagents",
  "compacting",
  "retrying",
]);

/** A tool part as the rules see it — the same {name, phase} the chat-state
 *  projection exposes. */
export type DifficultyToolPart = { name: string; phase?: string | null };

/** What the server knows about a live turn, independent of the reader's clock. */
export type TurnDifficultyFacts =
  | {
      kind: "repeated_failures";
      /** The tool that failed LAST. */
      tool: string;
      /** Rule 1: the failures in a row. Rule 2: that tool's failures. */
      failures: number;
      /** Every counted failure is `tool` (rule 2 always; rule 1 when unmixed). */
      sameTool: boolean;
    }
  | {
      kind: "failed_then_quiet";
      tool: string;
      /** From when the turn has been silent (epoch ms): its last observable
       *  activity, as the server knows it at a bounded cadence — never earlier than
       *  the truth (lib/liveTurnDifficulty). A MOMENT, not a duration: the query
       *  that returns it reads no clock; the reader's clock makes the verdict. */
      quietSince: number;
    };

/** The verdict a surface shows. */
export type TurnDifficulty =
  | {
      kind: "repeated_failures";
      tool: string;
      failures: number;
      sameTool: boolean;
    }
  /** `quietMs` = how long the turn has been silent, counted from its LAST activity
   *  — which may come after the failure (text written after it). The wording says
   *  "no activity for N min, after X failed", never "since X failed". */
  | { kind: "quiet_after_failure"; tool: string; quietMs: number };

const LIVE_TOOL_PHASES: ReadonlySet<string> = new Set(["start", "started", "running"]);

function isLive(p: DifficultyToolPart): boolean {
  return typeof p.phase === "string" && LIVE_TOOL_PHASES.has(p.phase);
}

function isFailure(p: DifficultyToolPart): boolean {
  return p.phase === "error";
}

/** Rules 1 and 2 over a live turn's tool parts, in part order. */
export function repeatedFailureFacts(
  parts: readonly DifficultyToolPart[],
): Extract<TurnDifficultyFacts, { kind: "repeated_failures" }> | null {
  // A call still RUNNING is neither a success nor a failure yet: it neither
  // extends nor breaks a streak (a fourth retry in flight does not clear three
  // failures — only its success will).
  const settled = parts.filter((p) => !isLive(p));
  const last = settled[settled.length - 1];
  if (last === undefined || !isFailure(last)) return null;

  // Rule 1: the trailing run of failures, whatever the tools.
  let streak = 0;
  const names = new Set<string>();
  for (let i = settled.length - 1; i >= 0 && isFailure(settled[i]!); i--) {
    streak += 1;
    names.add(settled[i]!.name);
  }
  if (streak >= DIFFICULTY_MIN_FAILURES) {
    return {
      kind: "repeated_failures",
      tool: last.name,
      failures: streak,
      sameTool: names.size === 1,
    };
  }

  // Rule 2: the latest failed tool's own failures, back to its last success, within
  // the window.
  let sameToolFailures = 0;
  const window = settled.slice(-SAME_TOOL_WINDOW);
  for (let i = window.length - 1; i >= 0; i--) {
    const p = window[i]!;
    if (p.name !== last.name) continue;
    if (!isFailure(p)) break;
    sameToolFailures += 1;
  }
  if (sameToolFailures >= DIFFICULTY_MIN_FAILURES) {
    return {
      kind: "repeated_failures",
      tool: last.name,
      failures: sameToolFailures,
      sameTool: true,
    };
  }
  return null;
}

/** Rule 3's precondition: the latest tool call failed and nothing runs. Returns the
 *  failed tool's name, or null. The CLOCK part (how long it has been quiet) needs the
 *  turn's last activity, which only the caller has. */
export function failedThenQuietTool(
  parts: readonly DifficultyToolPart[],
): string | null {
  if (parts.some(isLive)) return null;
  const last = parts[parts.length - 1];
  return last !== undefined && isFailure(last) ? last.name : null;
}

/** The verdict a reader sees at `now`. Null = no difficulty. Rule 3 becomes true
 *  WITHOUT any new write: the facts carry the moment the silence began, and the
 *  reader re-evaluates at `turnDifficultyRecheckAt` (a client timer). */
export function turnDifficultyVerdict(
  facts: TurnDifficultyFacts | null | undefined,
  now: number,
): TurnDifficulty | null {
  if (!facts) return null;
  if (facts.kind === "repeated_failures") {
    return {
      kind: "repeated_failures",
      tool: facts.tool,
      failures: facts.failures,
      sameTool: facts.sameTool,
    };
  }
  const quietMs = now - facts.quietSince;
  return quietMs >= STALL_AFTER_FAILURE_MS
    ? { kind: "quiet_after_failure", tool: facts.tool, quietMs }
    : null;
}

/** When a reader's verdict can next CHANGE on its own (the clock crossing rule 3's
 *  threshold), or null when only new facts can change it. */
export function turnDifficultyRecheckAt(
  facts: TurnDifficultyFacts | null | undefined,
): number | null {
  return facts?.kind === "failed_then_quiet"
    ? facts.quietSince + STALL_AFTER_FAILURE_MS
    : null;
}
