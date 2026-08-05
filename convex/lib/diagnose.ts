// Self-diagnosis: turn the SOC2-safe chat-state + bridge availability into ONE
// actionable assessment an AI agent can reason over and act on (the #7
// self-correction loop). PURE over its inputs -> unit-testable, no PHI: it reads
// only structural lifecycle (status / stuckStreaming / errorCode / role) and the
// non-secret availability projection, and emits a stable class + a suggested
// action (and, when a safe corrective tool exists, the tool to call).

import { isDeliveryRun } from "./deliveryRuns";

export type DiagnoseClass =
  | "unknown_chat"
  | "stuck_stream"
  | "attachment_problem"
  | "dispatch_error"
  | "subagent_stuck"
  | "subagent_failure"
  | "bridge_unavailable"
  | "bridge_degraded"
  | "healthy";

export type DiagnoseSeverity = "critical" | "high" | "warn" | "ok";

export interface ChatAssessment {
  class: DiagnoseClass;
  severity: DiagnoseSeverity;
  /** The curated non-PHI error code when a turn failed (else null). */
  errorCode: string | null;
  /** Non-secret reason string (e.g. the availability reason) when relevant. */
  reason: string | null;
  /** A one-line, non-PHI summary for the agent/operator. */
  summary: string;
  /** What to do — the recommended remediation. */
  suggestedAction: string;
  /** A safe Atrium MCP tool the agent may call to self-correct, or null. */
  suggestedTool: string | null;
}

/** Is this message the delivery of a post-turn RESULT rather than the user's own
 *  turn? BOTH gateway delivery families count (see lib/deliveryRuns): a spawned
 *  sub-agent's `announce:v1:<childSessionKey>:<childRunId>` report, and a
 *  background task's `<tool>:<taskId>:<ok|error>` result. Recognising only the
 *  first left every failed image/video generation reading as "this
 *  conversation's reply failed" — the same defect, second family.
 *
 *  Fails CLOSED — an absent or unrecognised run reads as a turn, so nothing is
 *  quietly excluded from the diagnosis. */
export function isDeliveryBubbleRun(
  runId: string | null | undefined,
): boolean {
  return isDeliveryRun(runId);
}

/** Does this bubble's STATUS speak for the user's own turn?
 *
 *  A `runId` alone cannot answer it. A merged report ROTATES the parent turn's
 *  runId to the announce run and never restores it (stream.ts, the reopen), so
 *  reading the prefix would exclude the very turn the user is reading. Two
 *  durable marks settle it:
 *
 *   - `hasMergedRuns` — the reopen history. Present only on a bubble that
 *     ALREADY existed when a report merged into it; a standalone delivery
 *     bubble never carries it.
 *   - `hasAnnouncePrefix` — the pre-merge reply, PARKED for the duration of the
 *     merge and preserved when it fails (consumed on success/abort). Its
 *     presence says the turn's own answer is intact and what is in flight — or
 *     what just failed — is the REPORT.
 *
 *  Fails CLOSED: an unknown or absent run reads as a turn, so nothing is
 *  quietly excluded from the diagnosis. */
export function isTurnBubble(m: DiagMessage): boolean {
  return (
    !isDeliveryBubbleRun(m.runId) ||
    (m.mergedIntoTurn ?? m.hasMergedRuns) === true
  );
}

/** Does this bubble's TERMINAL STATUS belong to the report rather than to the
 *  turn? A merge parks the pre-merge reply and KEEPS it when the merge fails —
 *  so a merged bubble sitting in `error` with its prefix still parked is a turn
 *  that answered and a report that did not.
 *
 *  Deliberately NOT folded into isTurnBubble: skipping such a bubble outright
 *  would hide the reply the user is reading, and hand the verdict either to
 *  "nothing can be concluded" or to some older failed turn (codex P3). The
 *  bubble IS the turn; only its ending belongs to something else. */
export function reportOwnsStatus(m: DiagMessage): boolean {
  return (
    isDeliveryBubbleRun(m.runId) &&
    (m.mergedIntoTurn ?? m.hasMergedRuns) === true &&
    m.hasAnnouncePrefix === true
  );
}

// Minimal structural inputs (a subset of chatStateInternal + computeAvailability).
export interface DiagMessage {
  role: string;
  status: string;
  stuckStreaming: boolean;
  errorCode: string | null;
  /** The run that produced this message. An `announce:` run is a sub-agent
   *  REPORT, not the user's own turn — the distinction below depends on it.
   *  Optional: a message written before it was carried simply reads as a turn,
   *  which is the conservative side. */
  runId?: string | null;
  /** TRUE when a report actually MERGED into this bubble — i.e. it existed
   *  before the announce did. Distinguishes a reopened turn from a standalone
   *  delivery bubble once `runId` has been rotated. */
  hasMergedRuns?: boolean;
  /** TRUE while the pre-merge reply is PARKED on this bubble (presence only —
   *  never the text). Set for the duration of a merge and kept when the merge
   *  fails: the turn answered, the report did not. */
  hasAnnouncePrefix?: boolean;
  /** Was this bubble a user TURN before a delivery merged into it and took its
   *  runId? The durable answer. Absent on rows written before the stamp existed
   *  — `hasMergedRuns` is then the fallback, which errs toward "a turn". */
  mergedIntoTurn?: boolean;
  /** Seconds since this message last changed. Optional: a projection that omits
   *  it makes the recency checks below fail OPEN (the message is considered
   *  recent), which surfaces rather than hides. */
  ageSeconds?: number;
}
/** A content-free sub-agent row in the chat-state summary (subset of the
 *  loadSubAgentSummary entry — only the fields the assessment reasons over). */
export interface DiagSubAgentEntry {
  status: string;
  errorCategory: string;
  ageSeconds: number;
}
export interface DiagChatState {
  ok: boolean;
  messages?: DiagMessage[];
  /** L2: an in-flight document fetch on this (hidden documentary) chat. A large
   *  `ageSeconds` = a STUCK fetch the owner is locked out behind. */
  pendingDocFetch?: { ageSeconds: number } | null;
  /** G3: the CONTENT-FREE sub-agent summary (counts + capped failed/running
   *  samples). Absent on a chat with no sub-agents (or a pre-this-feature read). */
  subAgents?: {
    byStatus: { running: number; done: number; error: number; aborted: number };
    failedSample: DiagSubAgentEntry[];
    runningSample: DiagSubAgentEntry[];
  } | null;
}

/** A document fetch in flight longer than this (s) is treated as STUCK — mirrors
 *  the stream watchdog's tolerance (a slow documentary agent gets the same grace). */
export const STUCK_DOC_FETCH_SECONDS = 12 * 60;

/** A delegated sub-agent left `running` longer than this (s) is treated as STUCK:
 *  its observer was likely lost, and a main turn awaiting it can hang (the observed
 *  bug-C). Aligns with the reaper's terminalization horizon (SUBAGENT_STALE_TTL_MS
 *  = 20 min) so diagnose flags exactly what the reaper is about to clean up. */
export const STUCK_SUBAGENT_SECONDS = 20 * 60;

/** Only a RECENTLY failed sub-agent flags the chat — an old failure the
 *  conversation has moved past is not a current dysfunction (avoids lighting up
 *  every chat that ever had a sub-agent fail). */
export const RECENT_SUBAGENT_FAILURE_SECONDS = 15 * 60;
export interface DiagAvailability {
  known: boolean;
  available: boolean;
  degraded: boolean;
  reason: string | null;
}

/** Map a curated dispatch error code to a concrete, non-PHI remediation. */
export function actionForErrorCode(code: string | null): string {
  switch (code) {
    case "ATTACHMENT_TOO_LARGE":
      return "The attachment exceeds what this agent accepts. Resend a smaller file, or send the message without the attachment.";
    case "ATTACHMENT_REJECTED":
      return "The gateway could not process the attachment (a known gateway base64-validator overflow on large files). Use a smaller file or text-only; the durable fix is gateway-side (isValidBase64).";
    case "AGENT_NOT_FOUND":
      return "The configured agent no longer exists on the gateway. Fix OPENCLAW_AGENT_ID in the bridge env to a real gateway agent.";
    case "AUTH_TOKEN_MISMATCH":
      return "The operator token / device pairing was rejected. Re-pair a dedicated bridge device on the gateway and update its token + identity.";
    case "DEVICE_SIGNING_FAILED":
      return "The device identity key cannot sign. Check OPENCLAW_DEVICE_IDENTITY (JSON, single \\n).";
    case "SESSION_SCOPE_DENIED":
      return "The device pairing scope is insufficient. Elevate the device scope (operator.admin) on the gateway.";
    case "GATEWAY_TIMEOUT":
      return "The gateway did not respond in time. Verify it is up and reachable (OPENCLAW_GATEWAY_URL); retry the turn.";
    case "GATEWAY_DISCONNECTED":
      return "The gateway connection dropped. Check the OpenClaw container; the next send reconnects automatically.";
    // The SAME connection end, but the two spellings mark two different MOMENTS,
    // and the delivery state differs between them — so the remediation must too.
    // Uppercase = the DISPATCH path (classifyGatewayError): the close beat the
    // `chat.send` ack, so nothing reached the agent. Lowercase = the STREAMING path
    // (Session.closeCauseCode): the send was already ACKed and the run had begun.
    case "GATEWAY_RESTARTING":
      return "The gateway ANNOUNCED a shutdown and closed the connection before acknowledging this send. Delivery is UNPROVEN, not refused: a response can race ahead of the ack, so the agent may have taken the turn. Nothing to fix if the restart was intended — check the session transcript for a reply before re-running the work; if the gateway does not come back, check the OpenClaw service.";
    case "gateway_restarting":
      return "The gateway ANNOUNCED a shutdown and closed the connection while this turn was RUNNING: the agent had accepted it and may resume it after the restart. The bridge polls the session transcript to recover the reply — EXCEPT when the announced absence exceeded the recovery budget (9 min), where the turn is closed immediately and no poll remains. Check the transcript before re-running the work.";
    case "CONNECTION_SATURATED":
      return "The gateway closed the connection for slow consumption (its 50 MiB send buffer filled) before acknowledging this send; delivery is UNPROVEN rather than refused. Look at bridge CPU/event-loop pressure and at turns producing very large outputs; this is not a gateway fault.";
    case "connection_saturated":
      return "The gateway closed the connection for slow consumption (its 50 MiB send buffer filled) while this turn was streaming: frames had already been DROPPED, so the visible reply is incomplete even though the agent may have finished. Look at bridge CPU/event-loop pressure and at turns producing very large outputs; this is not a gateway fault.";
    case "DISPATCH_STALLED":
      return "This dispatch stayed `pending` far longer than any live dispatch could, so the reconciler settled it to unlock the conversation (its action died before marking the row, its POST to the bridge exceeded the cap, or a preempt re-dispatch never fired). Delivery is UNPROVEN. Look for a crashed/evicted Convex action, or a `/send exceeded` line, around that time.";
    case "BRIDGE_UNREACHABLE":
      return "Convex could not reach the bridge. Check the bridge container and BRIDGE_URL.";
    default:
      return "Inspect the bridge logs for the raw detail; retry the turn. If it recurs, escalate to an admin with the error code.";
  }
}

const ATTACHMENT_CODES = new Set(["ATTACHMENT_TOO_LARGE", "ATTACHMENT_REJECTED"]);

/**
 * Assess a chat from its SOC2-safe state + the bridge availability. Priority
 * order: a stuck stream (the UI is hung, and we have a safe fix) > a failed last
 * turn > the bridge globally down > a degraded target > healthy.
 */
export function assessChat(
  state: DiagChatState,
  availability: DiagAvailability,
): ChatAssessment {
  if (!state.ok) {
    return {
      class: "unknown_chat",
      severity: "ok",
      errorCode: null,
      reason: null,
      summary: "No such chat (or a bad chat id).",
      suggestedAction: "Verify the chatId.",
      suggestedTool: null,
    };
  }
  const messages = state.messages ?? [];

  // 1) A stuck 'streaming' message — the UI is hung AND we have a safe corrective.
  if (messages.some((m) => m.stuckStreaming)) {
    return {
      class: "stuck_stream",
      severity: "high",
      errorCode: null,
      reason: "a streaming message never finalized",
      summary: "An assistant message is stuck 'streaming' — the bridge never relayed its finalize frame.",
      suggestedAction:
        "Reconcile the chat to release the stuck stream (flips it to error, preserving text), then the user can retry.",
      suggestedTool: "reconcile_chat",
    };
  }

  // 1.5) A document fetch stuck in flight — the owner is locked out of all future
  // fetches (the fetch_in_flight guard) until released. Safe corrective exists
  // (reconcile_chat releases a stale documentary pendingFetch, like a stuck stream).
  if (
    state.pendingDocFetch &&
    state.pendingDocFetch.ageSeconds > STUCK_DOC_FETCH_SECONDS
  ) {
    return {
      class: "attachment_problem",
      severity: "high",
      errorCode: null,
      reason: "a document fetch never settled",
      summary:
        "A 'Joindre les documents' fetch is stuck in flight — its turn never relayed a settle, so the owner is locked out of further fetches.",
      suggestedAction:
        "Reconcile this hidden documentary chat to release the stuck fetch (marks its rows failed + clears the lock); the user can then retry the attach.",
      suggestedTool: "reconcile_chat",
    };
  }

  // 1.7) A delegated sub-agent stuck 'running' far longer than expected — its
  // observer was likely lost, and a main turn awaiting it can HANG (bug-C). No safe
  // MCP corrective exists (reconcile_chat releases stuck STREAMS, not sub-agents);
  // the stale-sub-agent reaper terminalizes it after its TTL and releases any held
  // follow-up. Surfaced HIGH so a diagnostician sees the cause behind a hung chat
  // that is not itself a stuck stream (which would have won at priority 1).
  const stuckChild = (state.subAgents?.runningSample ?? []).find(
    (s) => s.ageSeconds > STUCK_SUBAGENT_SECONDS,
  );
  if (stuckChild) {
    return {
      class: "subagent_stuck",
      severity: "high",
      errorCode: null,
      reason: "a delegated sub-agent has been running far longer than expected",
      summary:
        "A delegated sub-agent is stuck 'running' (its observer was likely lost) — a main turn awaiting it can hang.",
      suggestedAction:
        "The stale-sub-agent reaper terminalizes it after its TTL and releases any held follow-up. If the visible turn is itself hung, reconcile the chat to release the stream.",
      suggestedTool: null,
    };
  }

  // 2) The most recent assistant TURN ended in error (a failed dispatch).
  //
  // Post-turn DELIVERIES are skipped when looking for it (see isTurnBubble):
  // a report or a background task's result failing to land is a real problem,
  // but it is not this chat's reply failing — the turn answered. Taking the newest assistant row
  // blindly made a burst of failed reports classify a perfectly healthy
  // conversation as `dispatch_error`, pointing whoever read it at a turn that
  // was fine (live prod 2026-08-04). The reports still surface: their own
  // anomaly class says so, and the sub-agent rows below carry them.
  const lastAssistant = [...messages]
    .reverse()
    .find((m) => m.role === "assistant" && isTurnBubble(m));
  // NO TURN IN VIEW = NO VERDICT. The window is bounded, so a chat whose recent
  // rows are all announces — or whose parent turn has scrolled past it — offers
  // no evidence either way. Falling through to `healthy` would state something
  // this function cannot see: a genuinely failed turn just outside the window
  // would be reported as a chat in good health.
  // A DELIVERY BUBBLE THAT ENDED IN ERROR. No sub-agent row need exist for it:
  // the merge falls back to a standalone bubble precisely WHEN the engagement
  // row is missing, so the sub-agent summary below can be empty while an error
  // bubble sits in the conversation for the user to see. Skipping such a bubble
  // out of the turn search is right; letting the verdict then read `healthy`
  // off an older successful turn is not — the result was still lost.
  const failedDelivery = [...messages]
    .reverse()
    .find(
      (m) =>
        m.role === "assistant" &&
        m.status === "error" &&
        // Either shape: a standalone delivery bubble, or a bubble whose turn
        // answered and whose ERROR belongs to the report merged into it. The
        // second was invisible here — isTurnBubble is true for it — so a failed
        // merge with no engagement row still read as a healthy chat.
        (!isTurnBubble(m) || reportOwnsStatus(m)) &&
        // RECENT, on the same horizon as the sub-agent branch below. The message
        // window is 200 rows deep: without this, one lost delivery pinned every
        // later verdict on a chat that had long since recovered — and buried the
        // degraded-bridge note behind evidence that was no longer current.
        (m.ageSeconds ?? 0) <= RECENT_SUBAGENT_FAILURE_SECONDS,
    );

  if (
    lastAssistant &&
    lastAssistant.status === "error" &&
    !reportOwnsStatus(lastAssistant)
  ) {
    const code = lastAssistant.errorCode;
    const isAttachment = code !== null && ATTACHMENT_CODES.has(code);
    return {
      class: isAttachment ? "attachment_problem" : "dispatch_error",
      severity: "high",
      errorCode: code,
      reason: `the last turn failed${code ? ` (${code})` : ""}`,
      summary: `The last assistant turn ended in error${code ? ` (${code})` : ""}.`,
      suggestedAction: actionForErrorCode(code),
      suggestedTool: null,
    };
  }

  // 3) The bridge process is globally down -> blocks EVERY chat.
  if (availability.known && !availability.available) {
    return {
      class: "bridge_unavailable",
      severity: "critical",
      errorCode: null,
      reason: availability.reason,
      summary: `The bridge is unavailable (${availability.reason ?? "unknown"}) — this blocks ALL chats.`,
      suggestedAction:
        "Check the bridge container and BRIDGE_URL. The composer is correctly disabled until /health recovers.",
      suggestedTool: null,
    };
  }

  // 3.5) A RECENTLY failed sub-agent on an otherwise-OK chat — informational: the
  // main turn likely answered WITHOUT the delegation's result. (A failed last MAIN
  // turn is already dispatch_error above; a down bridge is above too.) Chat-specific,
  // so it precedes the global bridge_degraded note.
  const recentFailedChild = (state.subAgents?.failedSample ?? []).find(
    (s) => s.ageSeconds < RECENT_SUBAGENT_FAILURE_SECONDS,
  );
  if (recentFailedChild) {
    return {
      class: "subagent_failure",
      severity: "warn",
      errorCode: null,
      reason: `a delegated sub-agent ${recentFailedChild.status} recently (${recentFailedChild.errorCategory})`,
      summary:
        "A delegated sub-agent failed recently — the main turn may have answered without its result.",
      suggestedAction:
        "Inspect the sub-agent's failure category; if the answer looks incomplete, ask the user to retry the delegation. The failure detail is owner-scoped (the chat's sub-agent monitor).",
      suggestedTool: null,
    };
  }

  // 3.6) A delivery that FAILED — either family, standalone or merged — when the
  // sub-agent summary above said nothing about it. Ranked ABOVE the generic
  // "a target is degraded" note for the same reason 3.5 is: this is direct,
  // chat-specific evidence of a lost result, and a reader sent to the bridge's
  // targets instead would never find it. The merge falls back to a
  // standalone bubble precisely WHEN the engagement row is missing, so the only
  // evidence can be the error bubble itself. Skipping it out of the turn search
  // is right; letting the verdict then read `healthy` off an older successful
  // turn is not — the result the user asked for was still lost.
  if (failedDelivery !== undefined) {
    return {
      class: "subagent_failure",
      severity: "warn",
      errorCode: failedDelivery.errorCode,
      reason: "a delegated result failed to land",
      summary:
        "A sub-agent report or background-task result ended in error — the turn itself answered, but the result the user asked for was lost.",
      suggestedAction:
        "Inspect the delivery run in the traces (the lost-report anomaly class carries a sample correlation). The turn's own reply is unaffected.",
      suggestedTool: null,
    };
  }

  // 4) A target/agent is erroring while the bridge is up — informational only.
  if (availability.degraded) {
    return {
      class: "bridge_degraded",
      severity: "warn",
      errorCode: null,
      reason: "target_error",
      summary: "An agent target is erroring while the bridge is up — other chats are unaffected.",
      suggestedAction:
        "Inspect the Bridge tab for the failing target's error code; this chat may still work for other agents.",
      suggestedTool: null,
    };
  }

  // 3.7) NO TURN IN VIEW = NO VERDICT — and deliberately LAST among the
  // conclusive checks. Ranked earlier, this `ok` answer preempted a KNOWN global
  // bridge outage, which applies to every chat whatever its window holds.
  if (messages.length > 0 && lastAssistant === undefined) {
    return {
      class: "unknown_chat",
      severity: "ok",
      errorCode: null,
      reason: "no assistant turn in the observed window",
      summary:
        "No assistant turn is visible in the observed window (only sub-agent report deliveries) — nothing can be concluded about this chat's health.",
      suggestedAction:
        "Widen the window or inspect the chat directly; the sub-agent report deliveries have their own anomaly class.",
      suggestedTool: null,
    };
  }
  return {
    class: "healthy",
    severity: "ok",
    errorCode: null,
    reason: null,
    summary: "No anomaly detected for this chat.",
    suggestedAction: "No action needed.",
    suggestedTool: null,
  };
}
