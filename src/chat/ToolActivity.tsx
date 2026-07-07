import { useState } from "react";
import { useMessage } from "@assistant-ui/react";
import { Check, LoaderCircle, Wrench } from "lucide-react";
import { m } from "@/paraglide/messages.js";
import { ActivityRow } from "./ActivityRow";
import { ToolCard } from "./ToolCard";
import { toolActivitySummary, type ToolActivityPart } from "./toolActivityView";

// Grouped "agent activity" block, rendered at the TOP of an assistant message
// (before the body) by the custom AssistantMessage in ConvexChat.tsx.
//
// Why a group instead of inline ToolCards: (1) during a long tool-heavy turn
// the stacked cards used to bury the final text above the fold (auto-scroll
// follows the bottom, the text inserted above the cards); (2) with the
// showTools pref OFF the cards vanished entirely, leaving ZERO feedback while
// 15 web_searches ran. The summary line below is ALWAYS visible — the pref now
// means "detail collapsed by default", not "invisible".
//
// Data path: convertMessage extracts the Convex `kind:"tool"` parts into
// ThreadMessageLike `metadata.custom.toolParts`; we read them with the same
// useMessage(metadata.custom) selector pattern RunStatus/MessageSource use.
// Reactivity is free: the bridge appends/patches tool parts, listByChat
// re-runs, the runtime reconverts, and the count/state here update live.

interface ToolActivityMeta {
  toolParts?: ToolActivityPart[];
  status?: string;
}

// Rendered ONLY when the "Outils" (analysis) view is on — the caller gates it,
// so this component no longer decides visibility. The summary is collapsed by
// default; the user clicks it to drill into the per-call detail. Auto-expanding
// is avoided on purpose: on a long tool-heavy turn it would push the final text
// below the fold.
export function ToolActivity() {
  const toolParts = useMessage(
    (msg) => (msg.metadata?.custom as ToolActivityMeta | undefined)?.toolParts,
  );
  const status = useMessage(
    (msg) => (msg.metadata?.custom as ToolActivityMeta | undefined)?.status,
  );
  // Collapsed until the user expands THIS message's detail.
  const [expanded, setExpanded] = useState(false);
  if (!toolParts || toolParts.length === 0) return null;

  const isExpanded = expanded;
  const summary = toolActivitySummary(toolParts, status);
  const trailing = summary.running ? (
    <>
      <LoaderCircle
        size={13}
        className="oc-actrow__status-icon oc-actrow__spin"
        aria-hidden
      />
      {m.tools_activity_running()}
    </>
  ) : (
    <>
      <Check size={13} className="oc-actrow__status-icon" aria-hidden />
      <span className="oc-sr-only">{m.tools_activity_done()}</span>
    </>
  );

  return (
    <div className="oc-toolact">
      <ActivityRow
        icon={<Wrench size={14} />}
        label={summary.label}
        trailing={trailing}
        open={isExpanded}
        ariaExpanded={isExpanded}
        title={
          isExpanded ? m.tools_activity_collapse() : m.tools_activity_expand()
        }
        onClick={() => setExpanded(!isExpanded)}
      />
      {isExpanded ? (
        <div className="oc-toolact__detail">
          {toolParts.map((p) => (
            <ToolCard
              key={p.toolCallId}
              toolName={p.toolName}
              args={p.args}
              argsText={p.argsText}
              result={p.result}
              // ToolCard's phaseClass understands the bridge phases directly
              // ("started"/"running"/"completed"/"error") via status.type.
              status={p.phase ? { type: p.phase } : undefined}
              turnSettled={
                status !== undefined && status !== "streaming"
              }
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
