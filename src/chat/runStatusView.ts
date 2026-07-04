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
}

const LABEL: Record<RunStatusKind, () => string> = {
  thinking: m.runstatus_thinking,
  generating: m.runstatus_generating,
  error: m.runstatus_error,
  aborted: m.runstatus_aborted,
};

export function runStatusView(
  status: string | undefined,
  hasText: boolean,
): RunStatusView | null {
  const kind = runStatusKind(status, hasText);
  if (kind === null) return null;
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
}

const ERROR_CODE_LABEL: Record<string, () => string> = {
  context_length: m.runstatus_error_context_length,
  rate_limit: m.runstatus_error_rate_limit,
  timeout: m.runstatus_error_timeout,
  refusal: m.runstatus_error_refusal,
  stream_orphaned: m.runstatus_error_orphaned,
};

export function errorDetailView(
  error: string | null | undefined,
  errorCode: string | null | undefined,
): ErrorDetailView {
  const code = errorCode ?? (error === "stream_orphaned" ? error : null);
  const headline = code !== null ? (ERROR_CODE_LABEL[code]?.() ?? null) : null;
  const raw = (error ?? "").trim();
  // The orphaned code's `error` IS the code string — showing it twice is noise.
  const detail = raw && raw !== code ? raw : null;
  return { headline, detail };
}

/** Re-exported from the shared module so existing importers (RunStatus) are
 *  unchanged while the implementation stays single-source. */
export const messageHasText = sharedMessageHasText;
