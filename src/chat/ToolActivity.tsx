import { useState } from "react";
import { useMessage } from "@assistant-ui/react";
import { Check, ChevronRight, LoaderCircle, Wrench } from "lucide-react";
import { m } from "@/paraglide/messages.js";
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

export function ToolActivity({ defaultExpanded }: { defaultExpanded: boolean }) {
  const toolParts = useMessage(
    (msg) => (msg.metadata?.custom as ToolActivityMeta | undefined)?.toolParts,
  );
  const status = useMessage(
    (msg) => (msg.metadata?.custom as ToolActivityMeta | undefined)?.status,
  );
  // null = follow the pref default (showTools ON -> expanded). A manual toggle
  // pins THIS message; other messages keep following the pref.
  const [expanded, setExpanded] = useState<boolean | null>(null);
  if (!toolParts || toolParts.length === 0) return null;

  const isExpanded = expanded ?? defaultExpanded;
  const summary = toolActivitySummary(toolParts, status);

  return (
    <div className={`oc-toolact${isExpanded ? " is-open" : ""}`}>
      <button
        type="button"
        className="oc-toolact__summary"
        aria-expanded={isExpanded}
        title={
          isExpanded ? m.tools_activity_collapse() : m.tools_activity_expand()
        }
        onClick={() => setExpanded(!isExpanded)}
      >
        <Wrench size={13} className="oc-toolact__icon" aria-hidden />
        <span className="oc-toolact__label">{summary.label}</span>
        {summary.running ? (
          <span className="oc-toolact__state">
            <LoaderCircle size={12} className="oc-toolact__spin" aria-hidden />
            {m.tools_activity_running()}
          </span>
        ) : (
          <span className="oc-toolact__state oc-toolact__state--done">
            <Check size={12} aria-hidden />
            <span className="oc-sr-only">{m.tools_activity_done()}</span>
          </span>
        )}
        <ChevronRight size={14} className="oc-toolact__chevron" aria-hidden />
      </button>
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
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
