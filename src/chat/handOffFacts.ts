// THE FACTS THAT END A HAND-OFF NOTE, IN PROJECTION `on` (assistantEmptyState `projected`).
//
// A bubble composed from its transcript rows (`rowLayout`) that delegated and yielded does not
// receive its delegation's answer: the gateway's resume (`announce:requester-settle:…`, or an
// announce of the child) is a bubble of its own, in the same display group. So the note on the
// hand-off bubble ends when a bubble of the chat NAMES the child — the resume's run id carries
// the child run ids it settles (convex/lib/deliveryRuns.ts `parseRequesterSettleRun`), an
// announce the child session key (`deliveryChildKey`) — or when the reader writes again. The
// Control UI shows no note at all once no run is active
// (ui/src/pages/chat/chat-thread-build.ts:562-570, `showWorkingIndicator`); these facts are
// what tells Atrium the same thing. Pure.

import { deliveryChildKey, parseRequesterSettleRun } from "../../convex/lib/deliveryRuns";
import type { ConvexMessageView } from "./convexTypes";

export type HandOffFacts = {
  projected: boolean;
  resumedChildRunIds: string[];
  resumedChildKeys: string[];
  laterUserTurn: boolean;
};

/** `projected`: the chat runs in projection `on` (convex/followUp.ts `followUpState`). */
export type ResumeIndex = { childRunIds: string[]; childKeys: string[]; lastUserAt: number | null; projected?: boolean };

const EMPTY: ResumeIndex = { childRunIds: [], childKeys: [], lastUserAt: null };

/** What the chat's messages say about resumes, once for the whole list. */
export function resumeIndexOf(list: readonly ConvexMessageView[], projected = false): ResumeIndex {
  const runIds = new Set<string>();
  const keys = new Set<string>();
  let lastUserAt: number | null = null;
  for (const msg of list) {
    if (msg.role === "user") {
      const at = msg.orderTime ?? msg._creationTime;
      if (lastUserAt === null || at > lastUserAt) lastUserAt = at;
      continue;
    }
    if (msg.role !== "assistant" || typeof msg.runId !== "string") continue;
    const settle = parseRequesterSettleRun(msg.runId);
    if (settle !== null) {
      for (const id of settle.childRunIds) runIds.add(id);
      continue;
    }
    const key = deliveryChildKey(msg.runId);
    if (key !== null) keys.add(key);
  }
  if (runIds.size === 0 && keys.size === 0 && lastUserAt === null && !projected) return EMPTY;
  return { childRunIds: [...runIds].sort(), childKeys: [...keys].sort(), lastUserAt, ...(projected ? { projected: true } : {}) };
}

/** The facts of one assistant bubble; undefined for a bubble not composed from its rows. */
export function handOffFactsOf(message: ConvexMessageView, index: ResumeIndex): HandOffFacts | undefined {
  if (message.role !== "assistant" || message.rowLayout === undefined) return undefined;
  const at = message.orderTime ?? message._creationTime;
  return {
    projected: true,
    resumedChildRunIds: index.childRunIds,
    resumedChildKeys: index.childKeys,
    laterUserTurn: index.lastUserAt !== null && index.lastUserAt > at,
  };
}
