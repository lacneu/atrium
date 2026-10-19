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
import { activityBlock, type ActivityNode } from "./activityBlock";
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

/** A rows block's cards, nested under their parent (activityBlock.ts): a node's children
 *  are shown inside its card, once it is open. */
function NodeCard({ node, settled }: { node: ActivityNode; settled: boolean }) {
  const p = node.part;
  return (
    <ToolCard
      toolName={p.toolName}
      args={p.args}
      argsText={p.argsText}
      inputFromTranscript={p.inputFromTranscript}
      result={p.result}
      status={p.phase ? { type: p.phase } : undefined}
      turnSettled={settled}
      nested={
        node.children.length > 0
          ? node.children.map((c) => <NodeCard key={c.part.toolCallId} node={c} settled={settled} />)
          : undefined
      }
    />
  );
}

export function InlineTurnActivity(props: {
  args?: { parts?: ToolActivityPart[]; rows?: boolean };
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
  const settled = status !== undefined && status !== "streaming";
  // PROJECTION `on`: the block is the Control UI's activity group — wrappers out of the
  // count, the visible operations summarized by family, nested calls under their parent.
  const block = props.args?.rows === true ? activityBlock(parts, settled) : null;
  const shown = block?.visible ?? parts;
  const label =
    block === null || live || shown.length <= 1
      ? activityLabel(block === null || live ? parts : shown, { live })
      : block.summary;
  const Icon = FAMILY_ICON[dominantFamily(shown)];
  const trailing = live ? (
    <LoaderCircle
      size={13}
      className="oc-actrow__status-icon oc-actrow__spin"
      aria-hidden
    />
  ) : (
    <>
      {shown.length > 1 ? (
        <span className="oc-flowact__count">{shown.length}</span>
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
        label={label}
        trailing={trailing}
        open={expanded}
        ariaExpanded={expanded}
        title={
          expanded ? m.tools_activity_collapse() : m.tools_activity_expand()
        }
        onClick={() => setExpanded(!expanded)}
      />
      {expanded && block !== null ? (
        <div className="oc-toolact__detail">
          {block.roots.map((node) => (
            <NodeCard key={node.part.toolCallId} node={node} settled={settled} />
          ))}
        </div>
      ) : expanded ? (
        <div className="oc-toolact__detail">
          {parts.map((p) => (
            <ToolCard
              key={p.toolCallId}
              toolName={p.toolName}
              args={p.args}
              argsText={p.argsText}
              inputFromTranscript={p.inputFromTranscript}
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
