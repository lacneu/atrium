import { useMemo, useState } from "react";
import { useMessage } from "@assistant-ui/react";
import {
  BookOpen,
  Check,
  CircleDot,
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
import { useWorkZone } from "./WorkZone";
import type { WorkZoneMark } from "./workZoneView";
import type { ToolActivityPart } from "./toolActivityView";
import { activityBlock, type ActivityNode } from "./activityBlock";
import { blockInterrupted, interruptedCalls, type TurnInterruption } from "./turnInterruptionView";
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
// ActivityRow, as ONE light line on the turn's work rail (`oc-work`, convexChat.css):
// its family icon sits on the rail; expand = the existing ToolCards.
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
  interruption?: TurnInterruption;
}

/** A rows block's cards, nested under their parent (activityBlock.ts): a node's children
 *  are shown inside its card, once it is open. */
function NodeCard({ node, settled, cut }: { node: ActivityNode; settled: boolean; cut: ReadonlySet<string> }) {
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
      turnInterrupted={p.toolCallId !== undefined && cut.has(p.toolCallId)}
      nested={
        node.children.length > 0
          ? node.children.map((c) => <NodeCard key={c.part.toolCallId} node={c} settled={settled} cut={cut} />)
          : undefined
      }
    />
  );
}

export function InlineTurnActivity(props: {
  args?: { parts?: ToolActivityPart[]; rows?: boolean; zone?: WorkZoneMark };
}) {
  const status = useMessage(
    (msg) => (msg.metadata?.custom as FlowMeta | undefined)?.status,
  );
  // The gateway cut this turn: the calls it is PROVEN to have left without a result were
  // interrupted, never "completed" (turnInterruptionView.ts). Selected as one string: a
  // selector must return a stable value.
  const cutKey = useMessage((msg) => {
    const meta = msg.metadata?.custom as FlowMeta | undefined;
    return [...interruptedCalls(meta?.interruption, meta?.status)].join("\u0000");
  });
  const cut = useMemo(() => new Set(cutKey === "" ? [] : cutKey.split("\u0000")), [cutKey]);
  const [expanded, setExpanded] = useState(false);
  // Tools OFF = the CLEAN view (user decision, revising the earlier
  // always-visible plan): no activity rows at all — the working label under
  // the bubble keeps carrying the in-progress signal.
  const { showTools } = useUiPrefs();
  const zone = useWorkZone(props.args?.zone);
  const parts = props.args?.parts ?? [];
  if (!showTools || parts.length === 0) return null;
  // The reader folded the zone this group belongs to: its header stands for it.
  if (zone.folded) return zone.header;
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
      {blockInterrupted(parts, cut) ? (
        // One call of the block was cut by the gateway: the header is not a clean "done".
        // Same quiet glyph and word as the interrupted card (ToolCard).
        <span className="inline-flex items-center" title={m.tools_status_interrupted()}>
          <CircleDot size={13} className="oc-actrow__status-icon" aria-hidden />
          <span className="sr-only">{m.tools_status_interrupted()}</span>
        </span>
      ) : (
        <Check size={13} className="oc-actrow__status-icon" aria-hidden />
      )}
    </>
  );
  return (
    <>
    {zone.header}
    <div
      className="oc-msg__meta oc-work oc-flowact"
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
            <NodeCard key={node.part.toolCallId} node={node} settled={settled} cut={cut} />
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
              turnInterrupted={p.toolCallId !== undefined && cut.has(p.toolCallId)}
            />
          ))}
        </div>
      ) : null}
    </div>
    </>
  );
}
