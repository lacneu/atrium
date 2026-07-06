// Gateway context-compaction marker — the user-facing "context was optimized"
// note on an assistant turn (Inc 1 of the gateway-observability initiative).
//
// WHY always visible (never behind the tools toggle): the marker explains two
// things a user otherwise wonders about — (a) why THIS reply took long (the
// gateway spent seconds summarizing before answering: 10s observed live), and
// (b) why the agent may have lost detail from much older exchanges (they were
// summarized). That is conversation-level information, not tool telemetry.
//
// Rendered as a thin divider-styled event line above the reply body: it reads
// as "something happened to the conversation here", matching what compaction
// IS. Content-free by construction (the part carries phase + timestamp only).

import { useMessage } from "@assistant-ui/react";
import { FoldVertical } from "lucide-react";
import { m } from "@/paraglide/messages.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface CompactionMeta {
  phase: string;
  at: number;
}

/** The per-turn marker written by the bridge sink (null = no compaction). */
function useCompaction(): CompactionMeta | null {
  return useMessage(
    (msg) =>
      (msg.metadata?.custom as { compaction?: CompactionMeta | null } | undefined)
        ?.compaction ?? null,
  );
}

export function CompactionNotice() {
  const compaction = useCompaction();
  if (!compaction) return null;
  // "midturn" = the gateway had to pause THIS reply to compact; "preflight"
  // (default) = it compacted before starting. The user-facing sentence differs
  // only in tense — both explain the same event honestly.
  const detail =
    compaction.phase === "midturn"
      ? m.compaction_detail_midturn()
      : m.compaction_detail_preflight();
  // An INSTANT tooltip (shadcn, 150ms — matching BridgeStatusBadge), replacing
  // the native `title` whose OS-imposed ~1-2s delay made the explanation feel
  // absent (user feedback 2026-07-05: several hover attempts to find it).
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="oc-compaction" role="note" aria-label={detail}>
            <span className="oc-compaction__rule" aria-hidden />
            <span className="oc-compaction__label">
              <FoldVertical size={12} aria-hidden />
              {m.compaction_label()}
            </span>
            <span className="oc-compaction__rule" aria-hidden />
          </div>
        </TooltipTrigger>
        <TooltipContent className="oc-compaction__tip">{detail}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
