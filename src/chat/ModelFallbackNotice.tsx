// Model-fallback marker — "this reply came from another model than the one selected".
//
// Always visible, like the compaction marker it sits beside (and whose divider styling
// it shares): which model answered is conversation-level information, not tool
// telemetry. The gateway states it after the run's work, so the marker appears on the
// bubble once the reply is there — it is kept, not flashed for a few seconds.

import { useMessage } from "@assistant-ui/react";
import { Check, Shuffle } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { modelFallbackView, type ModelFallbackMeta } from "./modelFallbackView";

export function ModelFallbackNotice() {
  const meta = useMessage(
    (msg) =>
      (msg.metadata?.custom as { modelFallback?: ModelFallbackMeta | null } | undefined)
        ?.modelFallback ?? null,
  );
  const view = modelFallbackView(meta);
  if (view === null) return null;
  const line = (
    <div
      className="oc-compaction oc-model-fallback"
      role="note"
      aria-label={view.detail === null ? view.label : `${view.label} — ${view.detail}`}
    >
      <span className="oc-compaction__rule" aria-hidden />
      <span className="oc-compaction__label">
        {view.cleared ? <Check size={12} aria-hidden /> : <Shuffle size={12} aria-hidden />}
        {view.label}
      </span>
      <span className="oc-compaction__rule" aria-hidden />
    </div>
  );
  if (view.detail === null) return line;
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>{line}</TooltipTrigger>
        <TooltipContent className="oc-compaction__tip">{view.detail}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
