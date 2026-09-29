import { createContext, useEffect, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { m } from "@/paraglide/messages.js";
import { api } from "./convexApi";
import type { Id } from "./convexApi";
import {
  turnDifficultyRecheckAt,
  turnDifficultyVerdict,
  type TurnDifficulty,
  type TurnDifficultyFacts,
} from "../../convex/lib/turnDifficulty";

// The READER side of the live-turn difficulty: the facts come from ONE server query
// (chatReads.liveTurnDifficulty) and the verdict from ONE shared rule
// (convex/lib/turnDifficulty), for the sidebar's activity bar and the bubble's status
// line alike — the same sentence in both places, never a second derivation.

export type { TurnDifficulty };

export type LiveDifficultyRow = {
  chatId: string;
  messageId: string;
  facts: TurnDifficultyFacts;
};

/** The sentence a reader sees — the bubble's status line AND the sidebar tooltip. */
export function turnDifficultyLabel(d: TurnDifficulty): string {
  if (d.kind === "quiet_after_failure") {
    return m.runstatus_difficulty_quiet({
      tool: d.tool,
      minutes: String(Math.floor(d.quietMs / 60_000)),
    });
  }
  return d.sameTool
    ? m.runstatus_difficulty_repeated_same({ tool: d.tool, count: String(d.failures) })
    : m.runstatus_difficulty_repeated_mixed({ tool: d.tool, count: String(d.failures) });
}

/** Verdicts at `now`, keyed by chat (the first struggling message of a chat — the
 *  sidebar shows one bar per chat) and by message (the bubble). Pure. */
export function difficultyMaps(
  rows: readonly LiveDifficultyRow[] | undefined,
  now: number,
): {
  byChat: Map<string, TurnDifficulty>;
  byMessage: Map<string, TurnDifficulty>;
} {
  const byChat = new Map<string, TurnDifficulty>();
  const byMessage = new Map<string, TurnDifficulty>();
  for (const row of rows ?? []) {
    const verdict = turnDifficultyVerdict(row.facts, now);
    if (verdict === null) continue;
    byMessage.set(row.messageId, verdict);
    if (!byChat.has(row.chatId)) byChat.set(row.chatId, verdict);
  }
  return { byChat, byMessage };
}

/** When the reader must look again without new facts: the earliest moment a quiet
 *  turn crosses the threshold, or — once one has — every half minute, so its minute
 *  count stays true. Null = only new facts can change anything. Pure. */
export function nextDifficultyTick(
  rows: readonly LiveDifficultyRow[] | undefined,
  now: number,
): number | null {
  let next: number | null = null;
  for (const row of rows ?? []) {
    const at = turnDifficultyRecheckAt(row.facts);
    if (at === null) continue;
    const due = at > now ? at : now + 30_000;
    next = next === null ? due : Math.min(next, due);
  }
  return next;
}

/** The struggling live turns by chat, for the rows that draw the activity bar (the
 *  sidebar, the folder page). Rows are memoized and rendered from many places, so a
 *  context rather than a prop threaded through each of them. */
export const TurnDifficultyContext = createContext<ReadonlyMap<string, TurnDifficulty>>(
  new Map(),
);

/** The activity bar's class and sentence for a busy row: its ordinary state, or its
 *  STRUGGLING state. One helper so every bar says the same thing. Pure. */
export function busyBarView(
  difficulty: TurnDifficulty | null | undefined,
  idleLabel: string,
): { className: string; label: string; struggling: boolean } {
  return difficulty
    ? {
        className: "oc-chatitem__busy oc-chatitem__busy--struggling",
        label: turnDifficultyLabel(difficulty),
        struggling: true,
      }
    : { className: "oc-chatitem__busy", label: idleLabel, struggling: false };
}

const NO_CHATS: readonly string[] = [];

/**
 * Subscribe to the difficulty of the live turns of `chatIds` and judge it at the
 * reader's clock, re-rendering only when the verdict can change on its own. Skips
 * the query when there is nothing to watch (no busy chat, a settled bubble).
 */
export function useLiveTurnDifficulties(chatIds: readonly string[] | null): {
  byChat: Map<string, TurnDifficulty>;
  byMessage: Map<string, TurnDifficulty>;
} {
  // A STABLE argument: the busy list is a fresh array on every push, and a new
  // argument object would re-subscribe.
  const key = [...(chatIds ?? NO_CHATS)].sort().join(",");
  const args = useMemo(
    () => (key === "" ? null : { chatIds: key.split(",") as Id<"chats">[] }),
    [key],
  );
  const rows = useQuery(api.chatReads.liveTurnDifficulty, args ?? "skip") as
    | LiveDifficultyRow[]
    | undefined;
  const [now, setNow] = useState(() => Date.now());
  const tick = args === null ? null : nextDifficultyTick(rows, now);
  useEffect(() => {
    if (tick === null) return;
    const t = window.setTimeout(
      () => setNow(Date.now()),
      Math.max(tick - Date.now(), 0) + 250,
    );
    return () => window.clearTimeout(t);
  }, [tick]);
  // Rebuilt when the facts or the tick change; new facts are judged at the time
  // they arrive, not at the last tick.
  return useMemo(
    () =>
      difficultyMaps(args === null ? undefined : rows, Math.max(now, Date.now())),
    [rows, now, args],
  );
}
