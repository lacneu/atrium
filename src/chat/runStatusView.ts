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

/** Re-exported from the shared module so existing importers (RunStatus) are
 *  unchanged while the implementation stays single-source. */
export const messageHasText = sharedMessageHasText;
