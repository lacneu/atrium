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
  /** WHY the gateway compacted, from its own account (W2 / G-09). ABSENT means
   *  UNKNOWN — the event is broadcast `dropIfSlow`, so silence is not evidence
   *  of a pre-emptive compaction. */
  reason?: string | null;
}

/** The per-turn marker written by the bridge sink (null = no compaction). */
function useCompaction(): CompactionMeta | null {
  return useMessage(
    (msg) =>
      (msg.metadata?.custom as { compaction?: CompactionMeta | null } | undefined)
        ?.compaction ?? null,
  );
}

/** The one-sentence cause suffix, or "" when the gateway's account never
 *  arrived. Threshold-family reasons all read as "pre-emptive" — the distinction
 *  the reader needs is overflow vs precaution vs manual, not which internal
 *  threshold fired. */
export function causeSentence(reason: string | null | undefined): string {
  switch (reason) {
    case "overflow":
      return m.compaction_cause_overflow();
    case "manual":
      return m.compaction_cause_manual();
    case "heap_threshold":
    case "rss_threshold":
    case "pre_compaction":
    case "non_manual_trigger":
      return m.compaction_cause_threshold();
    case "already_active":
    case "already_in_flight":
    case "deferred_compaction_not_scheduled":
    case "unsupported_harness_compaction":
      return m.compaction_cause_refused();
    default:
      return ""; // unknown, "other", or a cause with no distinct meaning here
  }
}

export function CompactionNotice() {
  const compaction = useCompaction();
  if (!compaction) return null;
  // "midturn" = the gateway had to pause THIS reply to compact; "preflight"
  // (default) = it compacted before starting. The user-facing sentence differs
  // only in tense — both explain the same event honestly.
  // "failed" = the gateway TRIED and could not (its own `completed:false`
  // verdict). It must NOT fall through to the preflight copy, which would claim
  // the conversation was summarized when nothing was: the session is still at
  // full size, which is exactly why the next turn may hit the context wall.
  const failed = compaction.phase === "failed";
  const base = failed
    ? m.compaction_detail_failed()
    : compaction.phase === "midturn"
      ? m.compaction_detail_midturn()
      : m.compaction_detail_preflight();
  // WHY it happened, when the gateway told us (W2 / G-09). Until now the copy
  // implied a PRE-EMPTIVE compaction in every case — including the one where the
  // window had already overflowed, which is a materially different situation for
  // the reader. An ABSENT reason adds nothing: the event is broadcast
  // `dropIfSlow`, so silence means unknown, and inventing "pre-emptive" is
  // exactly the misstatement this fixes.
  const detail = `${base}${causeSentence(compaction.reason)}`;
  // An INSTANT tooltip (shadcn, 150ms — matching BridgeStatusBadge), replacing
  // the native `title` whose OS-imposed ~1-2s delay made the explanation feel
  // absent (user feedback 2026-07-05: several hover attempts to find it).
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={`oc-compaction${failed ? " oc-compaction--failed" : ""}`}
            role="note"
            aria-label={detail}
          >
            <span className="oc-compaction__rule" aria-hidden />
            <span className="oc-compaction__label">
              <FoldVertical size={12} aria-hidden />
              {failed ? m.compaction_label_failed() : m.compaction_label()}
            </span>
            <span className="oc-compaction__rule" aria-hidden />
          </div>
        </TooltipTrigger>
        <TooltipContent className="oc-compaction__tip">{detail}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
