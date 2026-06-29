// Pure helpers for the `openclaw.rehydrate` decision trace + the
// `routing.rehydrate_missed` anomaly. Extracted from bridge_ingest so the
// content-free contract AND the anomaly fire-condition are unit-testable without
// the httpAction / Convex runtime (the bug surface is the SHAPE + the predicate,
// not the ingest plumbing).
//
// CONTRACT (mcp-enrich): the trace is keyed `chatId:outboxId` (the master join key
// matching chat.send + openclaw.dispatch), content-free — enums / scalars / routed
// agent NAMES only, NEVER prompt or history text.

/** The content-free fields the bridge ships for each dispatch's rehydration decision. */
export interface RehydrateTraceInput {
  decision: string;
  freshSession: boolean;
  routedSwitch: boolean;
  prependedTurns: number;
  routedAgentId: string;
  routedInstanceName: string | null;
  switchedFromAgentId: string | null;
  switchedFromInstanceName: string | null;
}

/** Build the `openclaw.rehydrate` trace meta — content-free by construction. The
 *  switchedFrom* names are included only when present (an actual agent switch). NO
 *  field here is free text; the type forbids it and this function never reads a body
 *  message/history. */
export function rehydrateTraceMeta(
  b: RehydrateTraceInput,
): Record<string, unknown> {
  return {
    op: "rehydrateTrace",
    decision: b.decision,
    freshSession: b.freshSession,
    routedSwitch: b.routedSwitch,
    prependedTurns: b.prependedTurns,
    routedAgentId: b.routedAgentId,
    routedInstanceName: b.routedInstanceName,
    ...(b.switchedFromAgentId !== null
      ? { switchedFromAgentId: b.switchedFromAgentId }
      : {}),
    ...(b.switchedFromInstanceName !== null
      ? { switchedFromInstanceName: b.switchedFromInstanceName }
      : {}),
  };
}

/** The `routing.rehydrate_missed` anomaly fire condition: a per-turn ROUTED switch
 *  whose session was FRESH but that still did NOT re-inject history — i.e. the
 *  switched agent got no conversation context (the bug this fix closes). After the
 *  fix it should not fire on a normal switch; it remains a regression/gap detector
 *  (e.g. an attachment-on-switch turn, where history can't be prepended). */
export function shouldReportRehydrateMissed(b: {
  routedSwitch: boolean;
  freshSession: boolean;
  decision: string;
}): boolean {
  return b.routedSwitch && b.freshSession && b.decision !== "rehydrate";
}
