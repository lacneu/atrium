// Self-diagnosis: turn the SOC2-safe chat-state + bridge availability into ONE
// actionable assessment an AI agent can reason over and act on (the #7
// self-correction loop). PURE over its inputs -> unit-testable, no PHI: it reads
// only structural lifecycle (status / stuckStreaming / errorCode / role) and the
// non-secret availability projection, and emits a stable class + a suggested
// action (and, when a safe corrective tool exists, the tool to call).

export type DiagnoseClass =
  | "unknown_chat"
  | "stuck_stream"
  | "attachment_problem"
  | "dispatch_error"
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

// Minimal structural inputs (a subset of chatStateInternal + computeAvailability).
export interface DiagMessage {
  role: string;
  status: string;
  stuckStreaming: boolean;
  errorCode: string | null;
}
export interface DiagChatState {
  ok: boolean;
  messages?: DiagMessage[];
  /** L2: an in-flight document fetch on this (hidden documentary) chat. A large
   *  `ageSeconds` = a STUCK fetch the owner is locked out behind. */
  pendingDocFetch?: { ageSeconds: number } | null;
}

/** A document fetch in flight longer than this (s) is treated as STUCK — mirrors
 *  the stream watchdog's tolerance (a slow documentary agent gets the same grace). */
export const STUCK_DOC_FETCH_SECONDS = 12 * 60;
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

  // 2) The most recent assistant turn ended in error (a failed dispatch).
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  if (lastAssistant && lastAssistant.status === "error") {
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
