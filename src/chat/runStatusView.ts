import { m } from "@/paraglide/messages.js";
import {
  runStatusKind,
  messageHasText as sharedMessageHasText,
  type RunStatusKind,
} from "../../convex/lib/chatRenderState";

// Thin localization wrapper over the SHARED pure derivation
// (convex/lib/chatRenderState). The status->kind mapping lives in that one
// module so the key-authed /api/v1/chat-state diagnostic reproduces the client's
// derived render-state from the IDENTICAL logic (no projection drift — the bug
// the API is meant to expose can't hide behind a second implementation). Here we
// only attach the FR/EN labels:
//   thinking   = streaming, no text yet              -> typing indicator
//   generating = streaming, with text                -> "still writing"
//   error      = the run failed                       -> error card
//   aborted    = the user stopped it                  -> "Interrompu"
//   (complete or unknown)                             -> null (no chip)

export type { RunStatusKind };

export interface RunStatusView {
  kind: RunStatusKind;
  /** French/EN, user-facing. */
  label: string;
  /** TRUE when the label is a PHASE-specific detail (Tools ON): callers must
   *  not replace it with the generic long-wait reassurance. */
  phased?: boolean;
}

const LABEL: Record<RunStatusKind, () => string> = {
  thinking: m.runstatus_thinking,
  generating: m.runstatus_generating,
  error: m.runstatus_error,
  aborted: m.runstatus_aborted,
};

// Live processing-phase labels: what the turn is ACTUALLY doing while silent,
// instead of the generic "thinking". Unknown wire values fall back to the
// generic label (forward-compat with newer bridges). Since the ChatGPT-style
// run representation, these are ALWAYS shown (no Tools gate) — the working
// label is conversation-level info, not tool telemetry.
const PHASE_LABEL: Record<string, () => string> = {
  processing_history: m.runstatus_phase_processing_history,
  compacting: m.runstatus_phase_compacting,
  querying_gateway: m.runstatus_phase_querying_gateway,
  awaiting_subagents: m.runstatus_phase_awaiting_subagents,
  // The gateway finished producing and is closing the turn out (deferred
  // terminal): the reader sees progress instead of an unexplained silence.
  post_processing: m.runstatus_phase_post_processing,
  // A tool is waiting on a human approval this app cannot grant (G-21).
  awaiting_approval: m.runstatus_phase_awaiting_approval,
};

/** Coarse tool families for the working label (and the lot-C flow summaries):
 *  a stable, provider-agnostic bucketing of tool NAMES. */
export type ToolFamily = "read" | "exec" | "search" | "fetch" | "write" | "other";

const FAMILY_RE: Array<[ToolFamily, RegExp]> = [
  ["read", /^(read|read_file|cat|open|view|notebook_read)$/i],
  ["exec", /^(exec|bash|shell|run|command|terminal)$/i],
  ["search", /^(web_search|search|grep|find|glob|rg)$/i],
  ["fetch", /^(web_fetch|fetch|browser|http_get)$/i],
  ["write", /^(write|write_file|apply_patch|edit|str_replace|notebook_edit)$/i],
];

export function toolFamily(toolName: string): ToolFamily {
  for (const [family, re] of FAMILY_RE) if (re.test(toolName)) return family;
  return "other";
}

const TOOL_FAMILY_LABEL: Record<ToolFamily, (name: string) => string> = {
  read: () => m.runstatus_tool_read(),
  exec: () => m.runstatus_tool_exec(),
  search: () => m.runstatus_tool_search(),
  fetch: () => m.runstatus_tool_fetch(),
  write: () => m.runstatus_tool_write(),
  other: (name) => m.runstatus_tool_other({ tool: name }),
};

export interface ActiveTool {
  name: string;
  family: ToolFamily;
}

/** The tool currently RUNNING in this turn, from the message's tool parts —
 *  or null when none is live. Today's wire appends start and completed as
 *  SEPARATE parts (no upsert yet), so a "started" part is live only while no
 *  LATER terminal part of the same tool name exists. Providers that never emit
 *  starts (OpenClaw pre-lot-B) simply yield null — honest degradation. */
export function activeToolFromParts(
  parts:
    | ReadonlyArray<{ toolName: string; phase?: string; toolCallId?: string }>
    | undefined,
): ActiveTool | null {
  if (!parts || parts.length === 0) return null;
  // Terminal matching keys on the CALL id when present (two concurrent calls
  // of the same tool: the second finishing must not mask the first, still-live
  // one — codex P2); parts without an id (legacy wire) fall back to the name.
  const key = (p: { toolName: string; toolCallId?: string }) =>
    p.toolCallId ?? p.toolName;
  const terminalSeen = new Set<string>();
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]!;
    const ph = p.phase ?? "completed";
    if (ph === "completed" || ph === "error") {
      terminalSeen.add(key(p));
      continue;
    }
    // The wire writes "start" (OpenClaw + Hermes normalizers); "started"/
    // "running" are the client-side ToolPhase aliases — accept all three.
    if (
      (ph === "start" || ph === "started" || ph === "running") &&
      !terminalSeen.has(key(p))
    ) {
      return { name: p.toolName, family: toolFamily(p.toolName) };
    }
  }
  return null;
}

export function runStatusView(
  status: string | undefined,
  hasText: boolean,
  /** Live phase of the in-flight turn (always honored — no Tools gate). */
  phase?: string | null,
  /** The tool currently running, if any — beats the phase (it is the more
   *  specific "what is happening now"), on thinking AND generating. */
  activeTool?: ActiveTool | null,
  /** The user stopped the conversation while this block's delegated work ran.
   *  A settled block then reads as interrupted (see runStatusKind). */
  interrupted?: boolean,
): RunStatusView | null {
  const kind = runStatusKind(status, hasText, interrupted ?? false);
  if (kind === null) return null;
  if (kind === "thinking" || kind === "generating") {
    if (activeTool) {
      return {
        kind,
        label: TOOL_FAMILY_LABEL[activeTool.family](activeTool.name),
        phased: true,
      };
    }
    if (phase && PHASE_LABEL[phase]) {
      return { kind, label: PHASE_LABEL[phase](), phased: true };
    }
  }
  return { kind, label: LABEL[kind]() };
}

/**
 * The HONEST in-flight label when the chat's gateway is unreachable (the routed
 * instance's target is in error while the bridge itself is up): an active turn is
 * not "processing" — it is waiting on a dead gateway and will most likely time
 * out. Returns the outage label ONLY for the in-flight kinds (thinking/generating)
 * while degraded; null otherwise (the caller keeps the normal label). Pure.
 */
export function runStatusOutageLabel(
  kind: RunStatusKind,
  gatewayDegraded: boolean,
): string | null {
  if (!gatewayDegraded) return null;
  if (kind !== "thinking" && kind !== "generating") return null;
  return m.runstatus_gateway_unreachable();
}

/**
 * Actionable error presentation: maps the message's STABLE failure class
 * (gateway ChatErrorEventSchema.errorKind, or a curated dispatch/watchdog code)
 * to a localized, user-actionable headline; the raw gateway error text stays as
 * the technical detail underneath (never shown as the primary line when a
 * classification exists). Pure — testable without React.
 *
 *   context_length -> the HARD un-recovered overflow (the context-overflow
 *                     initiative's user-facing end): explain + suggest recovery
 *   rate_limit / timeout / refusal -> honest, specific one-liners
 *   stream_orphaned -> the stuck-stream watchdog's code (kept from RunStatus)
 */
export interface ErrorDetailView {
  /** Localized headline (actionable) — null when the code is unknown. */
  headline: string | null;
  /** Raw technical detail (gateway text) — null when empty or redundant. */
  detail: string | null;
  /** The class this view RESOLVED to, including the text-phrasing fallback. The
   *  card keys its wired actions on THIS, not on the raw `errorCode`: an overflow
   *  recognized only by its phrasing used to get the right headline and no way out
   *  — a dead end on the one failure the app can act on itself. */
  code: string | null;
}

/** The overflow FAMILY: every class whose remedy is the same two actions (compact
 *  the session, or branch a fresh one). Exported so the card and the view stay in
 *  agreement — a new member added to one and forgotten in the other would show the
 *  right headline with no way to act on it. */
export const CONTEXT_OVERFLOW_CODES: ReadonlySet<string> = new Set([
  // The gateway's own hard overflow, mid-turn.
  "context_length",
  // The same, on a turn whose session had just been compacted (retried once).
  "context_length_compacted",
  // The bridge WITHHELD the send: measured not to fit, compaction did not shrink it.
  "context_length_presend",
]);

export const ERROR_CODE_LABEL: Record<string, () => string> = {
  context_length: m.runstatus_error_context_length,
  context_length_compacted: m.runstatus_error_context_length_compacted,
  context_length_presend: m.runstatus_error_context_length_presend,
  rate_limit: m.runstatus_error_rate_limit,
  timeout: m.runstatus_error_timeout,
  refusal: m.runstatus_error_refusal,
  stream_orphaned: m.runstatus_error_orphaned,
  connection_lost: m.runstatus_error_connection_lost,
  // A named connection end: the gateway said it was restarting, or it hung up on
  // us for being too slow to read. Both used to arrive as `connection_lost`.
  gateway_restarting: m.runstatus_error_gateway_restarting,
  connection_saturated: m.runstatus_error_connection_saturated,
  // The same two ends can also kill a send BEFORE the turn streams (failDispatch
  // stores the CURATED uppercase code then). SAME text, deliberately: the delivery
  // state is UNKNOWN at both moments, so no reader-facing wording may separate
  // them. Pre-ack does not prove nothing ran — a response frame can race ahead of
  // the `chat.send` ack (performSend handles exactly that) — and post-ack recovery
  // is not guaranteed either, since an announced absence longer than the recovery
  // budget closes the turn with no poll left (codex P1 ×2). Telling the user
  // "nothing ran, resend" would duplicate accepted agent work.
  GATEWAY_RESTARTING: m.runstatus_error_gateway_restarting,
  CONNECTION_SATURATED: m.runstatus_error_connection_saturated,
  // The agent kept working past the recovery budget (recv-silence self-heal
  // exhausted) — the turn is closed but the agent may still finish gateway-side.
  response_timeout: m.runstatus_error_response_timeout,
  compaction_timeout: m.runstatus_error_compaction_timeout,
  // The turn finished but delivered nothing usable (no text, failed file).
  empty_response: m.runstatus_error_empty_response,
  // The reply went out through a message-tool call whose arguments we could not
  // read. A NAMED cause: the fault is ours, and the label says so rather than
  // implying the agent had nothing to say.
  msgtool_args_unreadable: m.runstatus_error_msgtool_unreadable,
  // Blocked on a command approval: the missing feature is named, and the label
  // tells the reader what they CAN do — never a workaround for a defect.
  awaiting_approval: m.runstatus_error_awaiting_approval,
  // Zero-work clean close (silent NO_REPLY / end-of-run grace): auto-retried
  // by the backend; this label shows when the bounded retries also came back
  // empty.
  empty_response_silent: m.runstatus_error_empty_silent,
  // Transient upstream failure (provider 5xx / overload / network cut) —
  // auto-retried (turnRetry); the card shows the countdown while scheduled.
  provider_internal: m.runstatus_error_provider_internal,
  // The gateway's transient session-init OCC conflict — Convex auto-retries the
  // turn (turnRetry.ts); this card shows during the short backoff window and, if
  // the bounded retries exhaust, stays as the honest final state.
  session_init_conflict: m.runstatus_error_session_init_conflict,
  // Dispatch-failure codes (failDispatch stores the CODE; localized here in the
  // reader's language — formerly pre-rendered French sentences).
  not_configured: m.runstatus_error_not_configured,
  no_agent: m.runstatus_error_no_agent,
  agent_restricted: m.runstatus_error_agent_restricted,
  send_failed: m.runstatus_error_send_failed,
  // The dispatch never reported back and was reconciled. The generic "send failed"
  // headline would tell the reader to just retry — but delivery is UNKNOWN here,
  // and a blind retry can duplicate a turn the agent already accepted.
  DISPATCH_STALLED: m.runstatus_error_dispatch_unknown,
  ATTACHMENT_TOO_LARGE: m.runstatus_error_attachment_too_large,
  ATTACHMENT_REJECTED: m.runstatus_error_attachment_rejected,
};

// Defense-in-depth: overflow phrasings the UI recognizes CLIENT-side, so a bare
// overflow error string with no errorCode still gets the actionable card even if
// the bridge classifier ever misses a novel provider phrasing (the bridge is the
// primary classifier; this is the backstop).
const OVERFLOW_TEXT_RE =
  /context overflow|prompt too large|maximum context length|context[- ]length exceeded|request_too_large|request too large|input (?:token count )?exceeds the maximum number of (?:input )?tokens|input is too long for the model|too many tokens/i;

// Error-STRING codes (a stable code stored in `error` rather than `errorCode`):
// the bridge finalizes some infrastructure ends with the code as the error text
// (stream_orphaned watchdog, connection_lost socket drop). Recognized here so a
// message carrying only the string still gets its actionable headline.
const ERROR_STRING_CODES = new Set([
  "stream_orphaned",
  "connection_lost",
  "gateway_restarting",
  "connection_saturated",
  "response_timeout",
  // failDispatch stores the code string in `error` too (raw === code -> the
  // detail line is suppressed, only the localized headline shows).
  "not_configured",
  "no_agent",
  "agent_restricted",
  "send_failed",
  "ATTACHMENT_TOO_LARGE",
  "ATTACHMENT_REJECTED",
]);

export function errorDetailView(
  error: string | null | undefined,
  errorCode: string | null | undefined,
): ErrorDetailView {
  const raw0 = (error ?? "").trim();
  // Prefer a MAPPED errorCode; a curated-but-unmapped one (e.g.
  // BRIDGE_UNREACHABLE, kept for diagnostics) falls through to the error
  // STRING code (the localizable reason failDispatch stores), then the
  // overflow phrasing fallback, then the raw errorCode (headline null).
  const code =
    errorCode && ERROR_CODE_LABEL[errorCode]
      ? errorCode
      : ERROR_STRING_CODES.has(raw0)
        ? raw0
        : OVERFLOW_TEXT_RE.test(raw0)
          ? "context_length"
          : (errorCode ?? null);
  const headline = code !== null ? (ERROR_CODE_LABEL[code]?.() ?? null) : null;
  const raw = (error ?? "").trim();
  // A code string in `error` (orphaned/dispatch pattern) is not a useful detail.
  const detail =
    raw && raw !== code && !ERROR_STRING_CODES.has(raw) ? raw : null;
  return { headline, detail, code };
}

/** Re-exported from the shared module so existing importers (RunStatus) are
 *  unchanged while the implementation stays single-source. */
export const messageHasText = sharedMessageHasText;
