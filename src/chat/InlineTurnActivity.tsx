import { useState } from "react";
import { useMessage } from "@assistant-ui/react";
import {
  BookOpen,
  Check,
  Globe,
  LoaderCircle,
  Pencil,
  Search,
  Terminal,
  Wrench,
} from "lucide-react";
import { m } from "@/paraglide/messages.js";
import { useUiPrefs } from "./ConvexChat";
import { ActivityRow } from "./ActivityRow";
import { ToolCard } from "./ToolCard";
import type { ToolActivityPart } from "./toolActivityView";
import {
  activityLabel,
  dominantFamily,
  isLivePhase,
} from "./turnFlowView";
import type { ToolFamily } from "./runStatusView";

// INLINE activity group (ChatGPT/Codex-style interleaved flow): rendered by
// MessagePrimitive.Parts via the `__turn_flow__` tools mapping, at the group's
// TRUE position between the narrative paragraphs (convertMessage builds the
// sequence from the parts' textOffset anchors). Chrome = the shared
// ActivityRow; expand = the existing ToolCards.
//
// The wrapper carries `oc-msg__meta` so collectAnchorBlocks (bookmarks /
// quote-reply) never counts the cards' internal markdown as body blocks.

const FAMILY_ICON: Record<ToolFamily, typeof Wrench> = {
  read: BookOpen,
  exec: Terminal,
  search: Search,
  fetch: Globe,
  write: Pencil,
  other: Wrench,
};

interface FlowMeta {
  status?: string;
}

export function InlineTurnActivity(props: {
  args?: { parts?: ToolActivityPart[] };
}) {
  const status = useMessage(
    (msg) => (msg.metadata?.custom as FlowMeta | undefined)?.status,
  );
  const [expanded, setExpanded] = useState(false);
  // Tools OFF = the CLEAN view (user decision, revising the earlier
  // always-visible plan): no activity rows at all — the working label under
  // the bubble keeps carrying the in-progress signal.
  const { showTools } = useUiPrefs();
  const parts = props.args?.parts ?? [];
  if (!showTools || parts.length === 0) return null;
  // A part can be left on `start` forever (lost completion frame): on a
  // TERMINAL message the row must read settled, never spin (codex P2).
  const live =
    status === "streaming" && parts.some((p) => isLivePhase(p.phase));
  const Icon = FAMILY_ICON[dominantFamily(parts)];
  const trailing = live ? (
    <LoaderCircle
      size={13}
      className="oc-actrow__status-icon oc-actrow__spin"
      aria-hidden
    />
  ) : (
    <>
      {parts.length > 1 ? (
        <span className="oc-flowact__count">{parts.length}</span>
      ) : null}
      <Check size={13} className="oc-actrow__status-icon" aria-hidden />
    </>
  );
  return (
    <div
      className="oc-msg__meta oc-flowact"
      role="group"
      aria-label={m.turnflow_activity_aria()}
    >
      <ActivityRow
        icon={<Icon size={14} />}
        label={activityLabel(parts, { live })}
        trailing={trailing}
        open={expanded}
        ariaExpanded={expanded}
        title={
          expanded ? m.tools_activity_collapse() : m.tools_activity_expand()
        }
        onClick={() => setExpanded(!expanded)}
      />
      {expanded ? (
        <div className="oc-toolact__detail">
          {parts.map((p) => (
            <ToolCard
              key={p.toolCallId}
              toolName={p.toolName}
              args={p.args}
              argsText={p.argsText}
              result={p.result}
              status={p.phase ? { type: p.phase } : undefined}
              turnSettled={status !== undefined && status !== "streaming"}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
