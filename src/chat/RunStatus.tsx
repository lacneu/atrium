import { useEffect, useState } from "react";
import { useMessage } from "@assistant-ui/react";
import { CircleAlert, Square } from "lucide-react";
import type { MessageStatus } from "./convexTypes";
import { runStatusView, messageHasText } from "./runStatusView";
import { useAssistantIdentity, runWaitingLabel } from "./assistantIdentity";
import { m } from "@/paraglide/messages.js";

// Map a stored, stable error CODE to a localized, actionable message; any other
// (gateway-provided) error text is shown verbatim. Keep the code in sync with
// convex/stuckStreams.STUCK_STREAM_ERROR_CODE.
function errorMessageFor(error: string): string {
  return error === "stream_orphaned" ? m.runstatus_error_orphaned() : error;
}

// Renders the run lifecycle for an assistant message, driven by the normalizer's
// `run.status {status, runId}` events which the bridge materialises into the
// Convex message's `status` / `runId` fields. Reactive: when the bridge patches
// status from "streaming" -> "complete" | "error" | "aborted", useQuery re-runs
// and this re-renders without any HTTP turn.
//
// a11y: the chip carries `role="status"` (an implicit aria-live="polite" region)
// so a screen reader announces the STATE change ("Réflexion…", "Erreur"). We do
// NOT wrap the streaming message BODY in a live region — that would re-announce
// the answer on every token delta (spam). The body is read once it settles.

interface RunMeta {
  status?: MessageStatus;
  runId?: string | null;
  error?: string | null;
}

export function RunStatus() {
  const identity = useAssistantIdentity();
  const status = useMessage((m) => (m.metadata?.custom as RunMeta | undefined)?.status);
  const runId = useMessage((m) => (m.metadata?.custom as RunMeta | undefined)?.runId);
  const error = useMessage((m) => (m.metadata?.custom as RunMeta | undefined)?.error);
  // Boolean selector -> this only re-renders on the empty<->non-empty crossing,
  // not on every streamed token. Drives the thinking (no text) vs generating
  // (has text) distinction.
  const hasText = useMessage((m) =>
    messageHasText(m.content as ReadonlyArray<{ type?: string; text?: unknown }>),
  );

  const view = runStatusView(status, hasText);
  // After a while waiting for the first token (slow / overloaded / reconnecting
  // backend — the client can't tell which), swap the thinking label for a
  // cause-NEUTRAL reassurance so the user knows the turn is registered and waits.
  // Purely cosmetic: a local timer scoped to the thinking state; touches NOTHING
  // in the gate / clear / safety-timeout logic.
  const isThinking = view?.kind === "thinking";
  const [longWait, setLongWait] = useState(false);
  useEffect(() => {
    if (!isThinking) {
      setLongWait(false);
      return;
    }
    const t = window.setTimeout(() => setLongWait(true), 6000);
    return () => window.clearTimeout(t);
  }, [isThinking]);
  if (!view) return null;

  // Error is rendered as a STANDARDIZED alert card (icon + title + message in a
  // bordered, tinted block) rather than an inline red chip — a real, recognizable
  // error presentation. The transient states (thinking/generating/aborted) stay
  // as the lightweight inline chip.
  if (view.kind === "error") {
    return (
      <div className="oc-error-card" role="alert" title={runId ? `run ${runId}` : undefined}>
        <CircleAlert size={18} className="oc-error-card__icon" aria-hidden />
        <div className="oc-error-card__body">
          <span className="oc-error-card__title">{view.label}</span>
          {error ? (
            <span className="oc-error-card__msg">{errorMessageFor(error)}</span>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`oc-run-status oc-run-status--${view.kind}`}
      role="status"
      title={runId ? `run ${runId}` : undefined}
    >
      {view.kind === "thinking" ? (
        <span className="oc-dots" aria-hidden>
          <span />
          <span />
          <span />
        </span>
      ) : view.kind === "generating" ? (
        <span className="oc-run-status__pulse" aria-hidden />
      ) : (
        <Square size={13} aria-hidden />
      )}
      <span className="oc-run-status__label">
        {view.kind === "thinking" && longWait
          ? runWaitingLabel(identity)
          : view.label}
      </span>
    </div>
  );
}
