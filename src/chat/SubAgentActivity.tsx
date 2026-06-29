import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { useMessage } from "@assistant-ui/react";
import { Check, CircleAlert, Flag, LoaderCircle } from "lucide-react";
import { m } from "@/paraglide/messages.js";
import { api } from "./convexApi";
import type { Id } from "./convexApi";
import type { ConvexId } from "./convexTypes";
import { useInstanceCapabilities } from "./useInstanceCapabilities";
import {
  extractSpawnedChildKeys,
  type EmptyStateToolPart,
} from "./assistantEmptyState";
import {
  SubAgentReportDialog,
  type SubAgentReportTarget,
} from "./SubAgentReportDialog";
import {
  buildSubAgentActivityView,
  failedSubAgentBeacon,
  isReportableSubAgent,
  subAgentCardsToShow,
  subAgentFailedLabel,
  subAgentRowsForMessage,
  shortenSubAgentError,
  type SubAgentCardView,
  type SubAgentRow,
} from "./subAgentActivityView";

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

// One sub-agent card: label + a LIVE status badge, the error message shown
// prominently on a failed/timed-out child, and the child's final answer
// (collapsible) on done. Presentational — the caller supplies the report wiring.
function SubAgentCard({
  card,
  reported,
  onReport,
}: {
  card: SubAgentCardView;
  reported: boolean;
  onReport: (card: SubAgentCardView) => void;
}) {
  const StatusIcon =
    card.tone === "running"
      ? LoaderCircle
      : card.tone === "failed"
        ? CircleAlert
        : Check;
  const statusText =
    card.tone === "running"
      ? card.phase
        ? m.subagents_status_running_phase({ phase: card.phase })
        : m.subagents_status_running()
      : card.tone === "failed"
        ? m.subagents_status_failed()
        : m.subagents_status_done();
  return (
    <div className={`oc-subagent oc-subagent--${card.tone}`}>
      <div className="oc-subagent__head">
        <StatusIcon
          size={14}
          className={`oc-subagent__status-icon${
            card.tone === "running" ? " oc-subagent__spin" : ""
          }`}
          aria-hidden
        />
        <span className="oc-subagent__label" title={card.label}>
          {card.label}
        </span>
        <span className="oc-subagent__status">{statusText}</span>
        {/* Flag a TERMINAL sub-agent → freezes a report (content) + emits a
            content-free anomaly. Shown on done AND failed/aborted cards: a
            `done`-but-wrong child is the `wrong_result` case, a failed one the
            error case. A still-running child has nothing to report yet. */}
        {isReportableSubAgent(card.status) ? (
          reported ? (
            // ALREADY reported: createSubAgentReport is idempotent (it returns
            // the existing report WITHOUT updating category/comment), so re-
            // opening the editable form would SILENTLY DROP any new input. Show a
            // locked "reported" indicator instead — never the re-submit form.
            // (Adding to an existing report belongs to the deferred exchange
            // thread, not a silent re-submit.)
            <button
              type="button"
              className="oc-iconbtn oc-subagent__flag is-on"
              disabled
              title={m.subagentreport_btn_reported()}
              aria-label={m.subagentreport_btn_reported()}
            >
              <Flag size={13} aria-hidden />
            </button>
          ) : (
            <button
              type="button"
              className="oc-iconbtn oc-subagent__flag"
              title={m.subagentreport_btn_report()}
              aria-label={m.subagentreport_btn_aria()}
              onClick={() => onReport(card)}
            >
              <Flag size={13} aria-hidden />
            </button>
          )
        ) : null}
      </div>
      {/* Visible-FAILURE: a failed/aborted/timed-out child surfaces its reason
          inline (never hidden behind a click) — this is the whole point. */}
      {card.failure ? (
        <p className="oc-subagent__error" role="status">
          {shortenSubAgentError(card.errorMessage)}
        </p>
      ) : null}
      {/* The child's final answer on done (server-path-sanitized + capped by the
          bridge), collapsed like a tool output. */}
      {card.tone === "done" && card.resultText ? (
        <details className="oc-subagent__result">
          <summary>{m.subagents_result()}</summary>
          <pre className="oc-subagent__result-pre">{card.resultText}</pre>
        </details>
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
 * GATING mirrors the old block: requires the `subagents` capability; in the
 * ANALYSIS view (`show` = showTools) it renders ALL of this turn's cards, in the
 * CLEAN view it renders ONLY the failed ones (a failed/hung child stays
 * un-missable even with the tools toggle off). A turn that spawned nothing — or
 * whose spawn output was elided — anchors no card and does not even subscribe.
 *
 * Each card carries `data-subagent-id` (+ `data-subagent-failed` on a failure)
 * so the chat-level failure beacon can scroll a scrolled-away failure into view.
 */
export function MessageSubAgents({ show }: { show: boolean }) {
  const chatId = useMessage(
    (msg) => (msg.metadata?.custom as { chatId?: string } | undefined)?.chatId,
  );
  const toolParts = useMessage(
    (msg) =>
      (msg.metadata?.custom as { toolParts?: EmptyStateToolPart[] } | undefined)
        ?.toolParts ?? EMPTY_TOOL_PARTS,
  );
  // The childSessionKeys this turn spawned (pure). Empty for the vast majority of
  // turns — gate the subscriptions on it so an ordinary turn costs nothing.
  const keys = useMemo(() => extractSpawnedChildKeys(toolParts), [toolParts]);
  const hasSpawn = keys.length > 0;
  const cid: ConvexId<"chats"> | null =
    hasSpawn && chatId ? (chatId as ConvexId<"chats">) : null;

  const { can } = useInstanceCapabilities(cid);
  const rows = useQuery(
    api.subAgents.listSubAgents,
    cid ? { chatId: cid as Id<"chats"> } : "skip",
  ) as SubAgentRow[] | undefined;
  const reportedIds = useQuery(
    api.subAgentReports.myReportedSubAgentIds,
    cid ? { chatId: cid as Id<"chats"> } : "skip",
  ) as string[] | undefined;
  const [reportTarget, setReportTarget] = useState<SubAgentReportTarget | null>(
    null,
  );

  if (!hasSpawn || !can("subagents")) return null;
  const owned = subAgentRowsForMessage(rows ?? [], keys);
  const view = buildSubAgentActivityView(owned);
  const cards = subAgentCardsToShow(view.cards, show);
  if (cards.length === 0) return null;
  const reportedSet = new Set(reportedIds ?? []);

  return (
    <div className="oc-msg-subagents">
      {cards.map((card) => (
        <div
          key={card.id}
          className="oc-msg-subagents__anchor"
          data-subagent-id={card.id}
          data-subagent-failed={card.failure ? "" : undefined}
        >
          <SubAgentCard
            card={card}
            reported={reportedSet.has(card.id)}
            onReport={(c) =>
              setReportTarget({ subAgentId: c.id, label: c.label })
            }
          />
        </div>
      ))}
      <SubAgentReportDialog
        target={reportTarget}
        onClose={() => setReportTarget(null)}
      />
    </div>
  );
}

/** Scroll an anchored sub-agent card into view and flash it (reuses the
 *  useFocusMessage pattern: remove → reflow → re-add so the keyframes restart). */
function flashAnchor(el: HTMLElement): void {
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.classList.remove("oc-subagent--flash");
  void el.offsetWidth;
  el.classList.add("oc-subagent--flash");
  window.setTimeout(() => el.classList.remove("oc-subagent--flash"), 2400);
}

/**
 * Persistent, chat-level FAILURE beacon (Bug C): a compact chip near the composer
 * that appears ONLY when a sub-agent is in a FAILED/timed-out state, regardless
 * of the tools toggle, showing an "N sub-agent(s) failed" count. Running/done
 * children do NOT get this signal — only failures must be un-missable.
 *
 * Clicking it reaches the failure even when the spawning turn is scrolled far
 * away: if every failure is anchored in the loaded thread it SCROLLS to (and
 * flashes) the topmost one; otherwise — a failure whose spawning turn is outside
 * the 200-message window, or whose spawn output was elided, so no card is
 * anchored — it reveals a failure-only fallback list so the failure is never
 * unreachable (which would silently re-open Bug C).
 */
export function SubAgentFailureBeacon({
  chatId,
}: {
  chatId: ConvexId<"chats">;
}) {
  const [expanded, setExpanded] = useState(false);
  const { can } = useInstanceCapabilities(chatId);
  const rows = useQuery(api.subAgents.listSubAgents, {
    chatId: chatId as Id<"chats">,
  }) as SubAgentRow[] | undefined;
  const reportedIds = useQuery(api.subAgentReports.myReportedSubAgentIds, {
    chatId: chatId as Id<"chats">,
  }) as string[] | undefined;
  const [reportTarget, setReportTarget] = useState<SubAgentReportTarget | null>(
    null,
  );

  const beacon = failedSubAgentBeacon(rows ?? [], can("subagents"));
  if (!beacon.visible) return null;

  const onActivate = () => {
    // Count the failed cards actually anchored in the loaded thread. Only when
    // EVERY failure is anchored do we scroll straight to the topmost one — a
    // strictly safe direction: any shortfall (out-of-window / elided / not yet
    // loaded) reveals the fallback list instead, so a failure is never missed.
    const anchored = document.querySelectorAll("[data-subagent-failed]");
    if (anchored.length > 0 && anchored.length >= beacon.count) {
      for (const id of beacon.jumpIds) {
        const el = document.querySelector<HTMLElement>(
          `[data-subagent-id="${CSS.escape(id)}"]`,
        );
        if (el) {
          flashAnchor(el);
          setExpanded(false);
          return;
        }
      }
    }
    setExpanded((v) => !v);
  };

  // The fallback failure-only list (shown only when expanded): the same cards the
  // old clean-view block rendered, so a failure with no in-thread anchor is still
  // fully visible + flaggable here.
  const failedCards = subAgentCardsToShow(
    buildSubAgentActivityView(rows ?? []).cards,
    false,
  );
  const reportedSet = new Set(reportedIds ?? []);

  return (
    <div className="oc-subagent-beacon">
      <button
        type="button"
        className={`oc-chip oc-chip--btn oc-subagent-beacon__chip${
          expanded ? " is-open" : ""
        }`}
        title={m.subagents_beacon_jump()}
        aria-label={m.subagents_beacon_jump()}
        aria-expanded={expanded}
        onClick={onActivate}
      >
        <CircleAlert size={14} className="oc-chip__icon" aria-hidden />
        <span className="oc-subagent-beacon__label">
          {subAgentFailedLabel(beacon.count)}
        </span>
      </button>
      {expanded ? (
        <div className="oc-subagent-beacon__list">
          {failedCards.map((card) => (
            <SubAgentCard
              key={card.id}
              card={card}
              reported={reportedSet.has(card.id)}
              onReport={(c) =>
                setReportTarget({ subAgentId: c.id, label: c.label })
              }
            />
          ))}
        </div>
      ) : null}
      <SubAgentReportDialog
        target={reportTarget}
        onClose={() => setReportTarget(null)}
      />
    </div>
  );
}
