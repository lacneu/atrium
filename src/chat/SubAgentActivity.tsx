import { useContext, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { useMessage } from "@assistant-ui/react";
import { Bot, Check, CircleAlert, LoaderCircle } from "lucide-react";
import { ActivityRow } from "./ActivityRow";
import { SubAgentPanelContext } from "./SubAgentPanel";
import { m } from "@/paraglide/messages.js";
import { api } from "./convexApi";
import type { Id } from "./convexApi";
import type { ConvexId } from "./convexTypes";
import { useInstanceCapabilities } from "./useInstanceCapabilities";
import {
  extractSpawnedChildKeys,
  toolPartsHaveSpawn,
  type EmptyStateToolPart,
} from "./assistantEmptyState";
import {
  buildSubAgentActivityView,
  subAgentCountLabel,
  subAgentProgressBadges,
  subAgentRowsForMessage,
  shortenSubAgentError,
  type SubAgentCardView,
  type SubAgentRow,
  type SubAgentTone,
} from "./subAgentActivityView";

/** The status label reused for a progress-badge title/aria (same wording as a
 *  card's status line). */
function progressBadgeTitle(tone: SubAgentTone, count: number): string {
  return tone === "done"
    ? m.subagents_badge_done({ count })
    : tone === "running"
      ? m.subagents_badge_running({ count })
      : m.subagents_badge_failed({ count });
}

// Sub-agent monitor UI — READ-ONLY consumer of the `subAgents` store the bridge
// observer writes (one row per child run); it never changes what Atrium sends.
//
// PLACEMENT (the redesign): instead of one chat-level pile pinned above the
// composer that accumulates EVERY child of the chat, each sub-agent is anchored
// IN CONTEXT under the assistant turn that spawned it (MessageSubAgents), and a
// single persistent chip near the composer (SubAgentFailureBeacon) keeps any
// FAILED child reachable even when its spawning turn is scrolled far away (Bug C).
//
// All derivation (sort, status -> tone, label, the failure mapping, the
// per-message ownership join, the beacon visibility/order) is pure in
// subAgentActivityView.ts and unit tested. Data flows over reactive owner-scoped
// queries (listSubAgents / myReportedSubAgentIds / compat.forChat) that Convex
// dedupes across every consumer, so the many per-message anchors share ONE
// network subscription each and return [] for the common no-sub-agent chat.

// (The child's TOOL detail + RESULT now live in the secondary-conversation panel
//  — SubAgentPanel.tsx — opened from the succinct in-thread card below.)

// One sub-agent card: the shared ActivityRow (Bot + "Sous-agent" + task + status +
// chevron AT THE EDGE, exactly like the Tools row) opening the secondary-conversation
// panel, plus the error message shown prominently on a failed/timed-out child. The
// "signaler une anomalie" action lives in the PANEL now (uniform target for the
// report + the jump-to-spawn), so the row's chevron sits flush right like Tools.
function SubAgentCard({ card }: { card: SubAgentCardView }) {
  const StatusIcon =
    card.tone === "running"
      ? LoaderCircle
      : card.tone === "failed"
        ? CircleAlert
        : Check;
  const panel = useContext(SubAgentPanelContext);
  const toolCount = card.tools?.length ?? 0;
  // The "currently detailed in the panel" highlight — the visual breadcrumb tying
  // this row to the open secondary conversation on the right.
  const isActive = panel?.activeChildKey === card.childSessionKey;
  // RIGHT part: the tool count then a bare STATUS ICON (check / spinner / alert) at
  // the far right before the chevron -- same shape as the tool-activity row, with NO
  // status WORD (done / running): the icon alone conveys the state, like tools.
  const trailing = (
    <>
      {toolCount > 0 ? (
        <span className="oc-actrow__toolcount">
          {toolCount === 1
            ? m.tools_activity_count({ count: toolCount })
            : m.tools_activity_count_plural({ count: toolCount })}
        </span>
      ) : null}
      <StatusIcon
        size={13}
        className={`oc-actrow__status-icon${
          card.tone === "running" ? " oc-actrow__spin" : ""
        }`}
        aria-hidden
      />
    </>
  );
  return (
    <div className={`oc-subagent oc-subagent--${card.tone}`}>
      <ActivityRow
        tone={card.tone}
        icon={<Bot size={15} />}
        label={m.subagent_panel_kind()}
        sublabel={card.taskName}
        trailing={trailing}
        active={isActive}
        ariaExpanded={isActive}
        ariaHasPopup
        title={m.subagent_panel_open()}
        ariaLabel={m.subagent_panel_open()}
        onClick={() => panel?.openFor(card.childSessionKey)}
      />
      {/* Visible-FAILURE inline (un-missable). The full detail (tools + result,
          rendered markdown) + the "signaler une anomalie" action live in the
          secondary-conversation panel the row opens. */}
      {card.failure ? (
        <p className="oc-subagent__error" role="status">
          {shortenSubAgentError(card.errorMessage)}
        </p>
      ) : null}
    </div>
  );
}

// A stable empty array so the toolParts selector never returns a fresh reference
// (which would defeat useMessage's memoization and churn re-renders).
const EMPTY_TOOL_PARTS: readonly EmptyStateToolPart[] = [];

/**
 * Per-message anchor: the sub-agent(s) THIS assistant turn spawned, rendered
 * right under that turn so a child shows WHERE it was delegated — not in a
 * chat-level pile. Correlates the turn's `sessions_spawn` output keys
 * (extractSpawnedChildKeys) with the chat's sub-agent rows (subAgentRowsForMessage).
 *
 * GATING: requires the `subagents` capability. VISIBILITY is owned by the caller —
 * this lives inside the `.oc-msg__meta` group, which ConvexChat renders only in the
 * ANALYSIS ("Outils") view (UNIFORM with Tools/Sources). A failed/hung child stays
 * un-missable even with the toggle off via the persistent SubAgentFailureBeacon near
 * the composer, so hiding the in-thread card here loses no failure signal. A turn
 * that spawned nothing — or whose spawn output was elided — anchors no card and does
 * not even subscribe.
 *
 * Each card carries `data-subagent-id` (+ `data-subagent-failed` on a failure)
 * so the chat-level failure beacon can scroll a scrolled-away failure into view.
 */
export function MessageSubAgents() {
  const chatId = useMessage(
    (msg) => (msg.metadata?.custom as { chatId?: string } | undefined)?.chatId,
  );
  const toolParts = useMessage(
    (msg) =>
      (msg.metadata?.custom as { toolParts?: EmptyStateToolPart[] } | undefined)
        ?.toolParts ?? EMPTY_TOOL_PARTS,
  );
  // The childSessionKeys the spawn output carried — a FALLBACK correlation key
  // (the gateway usually omits it, so this is often empty).
  const keys = useMemo(() => extractSpawnedChildKeys(toolParts), [toolParts]);
  // Gate on whether the turn CALLED sessions_spawn (its tool part NAME, always
  // present) — not on a parseable key set — so the subscriptions run for every
  // delegating turn and the rows correlate by parentMessageId below.
  const hasSpawn = useMemo(() => toolPartsHaveSpawn(toolParts), [toolParts]);
  // The Convex message _id (convertMessage surfaces it as custom.messageId) = the
  // bridge's parentMessageId (robust correlation key).
  const messageId = useMessage(
    (msg) =>
      (msg.metadata?.custom as { messageId?: string } | undefined)?.messageId,
  );
  const cid: ConvexId<"chats"> | null =
    hasSpawn && chatId ? (chatId as ConvexId<"chats">) : null;

  const { can } = useInstanceCapabilities(cid);
  const rows = useQuery(
    api.subAgents.listSubAgents,
    cid ? { chatId: cid as Id<"chats"> } : "skip",
  ) as SubAgentRow[] | undefined;
  // Multi-sub-agent: the card list collapses behind the summary header (default
  // open) — "open like a tools list" when a turn spawned several delegations.
  const [listOpen, setListOpen] = useState(true);

  // Visibility is the caller's (.oc-msg__meta, analysis view only); here we only
  // gate on the capability + a real spawn. The turn's ANSWER is never hidden — when
  // the parent delegated and returned nothing, the sub-agent's result still renders
  // in AssistantEmptyState (markdown) regardless of this toggle.
  if (!hasSpawn || !can("subagents")) return null;
  const owned = subAgentRowsForMessage(rows ?? [], keys, messageId);
  const view = buildSubAgentActivityView(owned);
  const cards = [...view.cards];
  if (cards.length === 0) return null;
  // Progress summary header (several sub-agents): how many have already returned vs
  // are still running vs failed — at a glance, above the cards. Empty for a single
  // sub-agent (its own card carries the status).
  const badges = subAgentProgressBadges(view);

  return (
    <div className="oc-msg-subagents">
      {badges.length > 0 ? (
        <ActivityRow
          icon={<Bot size={15} />}
          label={subAgentCountLabel(view.total)}
          trailing={badges.map((b) => (
            <span
              key={b.tone}
              className={`oc-subagent-badge oc-subagent-badge--${b.tone}`}
              title={progressBadgeTitle(b.tone, b.count)}
              aria-label={progressBadgeTitle(b.tone, b.count)}
            >
              {b.tone === "done" ? (
                <Check size={12} aria-hidden />
              ) : b.tone === "running" ? (
                <LoaderCircle
                  size={12}
                  className="oc-actrow__spin"
                  aria-hidden
                />
              ) : (
                <CircleAlert size={12} aria-hidden />
              )}
              <span className="oc-subagent-badge__count">{b.count}</span>
            </span>
          ))}
          open={listOpen}
          ariaExpanded={listOpen}
          title={
            listOpen ? m.tools_activity_collapse() : m.tools_activity_expand()
          }
          onClick={() => setListOpen(!listOpen)}
        />
      ) : null}
      {(badges.length === 0 || listOpen) &&
        cards.map((card) => (
        <div
          key={card.id}
          className="oc-msg-subagents__anchor"
          data-subagent-id={card.id}
          data-subagent-failed={card.failure ? "" : undefined}
        >
          <SubAgentCard card={card} />
        </div>
      ))}
    </div>
  );
}

