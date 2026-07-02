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

/** Re-exported from the shared module so existing importers (RunStatus) are
 *  unchanged while the implementation stays single-source. */
export const messageHasText = sharedMessageHasText;
