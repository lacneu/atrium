import { useState } from "react";
import { useQuery } from "convex/react";
import {
  Bot,
  Check,
  ChevronRight,
  CircleAlert,
  LoaderCircle,
} from "lucide-react";
import { m } from "@/paraglide/messages.js";
import { api } from "./convexApi";
import type { Id } from "./convexApi";
import type { ConvexId } from "./convexTypes";
import { useInstanceCapabilities } from "./useInstanceCapabilities";
import {
  buildSubAgentActivityView,
  subAgentActivityVisible,
  subAgentCardsToShow,
  subAgentCountLabel,
  subAgentFailedLabel,
  type SubAgentCardView,
  type SubAgentRow,
} from "./subAgentActivityView";

// Chat-level "Sous-agents" block — shows the sub-agents (child runs) a main agent
// spawned in THIS chat plus their LIVE status, with errors/hangs surfaced
// prominently (the headline pain: a sub-agent fails and the main agent hangs with
// no way to SEE it). READ-ONLY consumer of the `subAgents` store written by the
// bridge observer; it never changes what Atrium sends.
//
// Data path: useQuery(listSubAgents) is owner-scoped + reactive — the bridge
// upserts a row per child as frames arrive, the query re-runs, and the card
// status/result/error update live with no per-turn HTTP request. All derivation
// (sort, status -> tone, label, the failure mapping, the gate) is pure in
// subAgentActivityView.ts and unit tested.
//
// GATING (pure subAgentActivityVisible / subAgentCardsToShow): requires the
// `subagents` capability AND ≥1 sub-agent — an old gateway / a chat without
// sub-agents is visually unchanged. In the ANALYSIS view (`show` = showTools) it
// shows ALL cards; in the CLEAN view it shows ONLY when a sub-agent FAILED, and
// then ONLY the failed cards — a failed/hung child (Bug C) is un-missable even
// with the tools toggle off, while running/done detail stays out of the clean
// view.

// One sub-agent card: label + a LIVE status badge, the error message shown
// prominently on a failed/timed-out child, and the child's final answer
// (collapsible) on done.
function SubAgentCard({ card }: { card: SubAgentCardView }) {
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
      </div>
      {/* Visible-FAILURE: a failed/aborted/timed-out child surfaces its reason
          inline (never hidden behind a click) — this is the whole point. */}
      {card.failure ? (
        <p className="oc-subagent__error" role="status">
          {card.errorMessage ?? m.subagents_error_generic()}
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

export function SubAgentActivity({
  chatId,
  show,
}: {
  chatId: ConvexId<"chats">;
  show: boolean;
}) {
  // Default OPEN: the user opened the analysis view to SEE the sub-agents, so the
  // cards (and any failure) are visible without a click. Collapsing is opt-in; the
  // summary line keeps the running/failed counts visible even when collapsed.
  const [open, setOpen] = useState(true);
  // Both subscriptions stay ACTIVE even in the clean view (show=false): the whole
  // point of Bug C is that a FAILED/hung sub-agent surfaces WITHOUT the analysis
  // toggle, so the component must know about failures regardless of `show` (the gate
  // below is `show || failed > 0`). Gating these on `show` would make the clean-view
  // failure surface dead. The cost is bounded — listSubAgents returns [] for a chat
  // with no sub-agents (the common case), so an ordinary chat just reads an empty set.
  const { can } = useInstanceCapabilities(chatId);
  const rows = useQuery(api.subAgents.listSubAgents, {
    chatId: chatId as Id<"chats">,
  }) as SubAgentRow[] | undefined;

  const view = buildSubAgentActivityView(rows ?? []);
  if (!subAgentActivityVisible(show, can("subagents"), view.total, view.failed))
    return null;

  // CLEAN view reaches here ONLY because a sub-agent failed (the gate above) —
  // render a tight, failure-only surface. ANALYSIS view renders the full picture.
  const cards = subAgentCardsToShow(view.cards, show);
  const failureOnly = !show;

  return (
    <div
      className={`oc-subagents${open ? " is-open" : ""}${
        failureOnly ? " oc-subagents--alert" : ""
      }`}
    >
      <button
        type="button"
        className="oc-subagents__summary"
        aria-expanded={open}
        title={open ? m.subagents_collapse() : m.subagents_expand()}
        onClick={() => setOpen(!open)}
      >
        {failureOnly ? (
          <CircleAlert size={14} className="oc-subagents__icon" aria-hidden />
        ) : (
          <Bot size={14} className="oc-subagents__icon" aria-hidden />
        )}
        <span className="oc-subagents__title">
          {failureOnly
            ? subAgentFailedLabel(view.failed)
            : subAgentCountLabel(view.total)}
        </span>
        {/* The count pills are an ANALYSIS-view affordance: the clean view's
            title already states the failure count and every card below is a
            failure, so the pills would be redundant there. */}
        {!failureOnly && view.running > 0 ? (
          <span
            className="oc-subagents__badge oc-subagents__badge--running"
            title={m.subagents_running_count({ count: view.running })}
          >
            <LoaderCircle
              size={11}
              className="oc-subagents__spin"
              aria-hidden
            />
            {view.running}
          </span>
        ) : null}
        {!failureOnly && view.failed > 0 ? (
          <span
            className="oc-subagents__badge oc-subagents__badge--failed"
            title={m.subagents_failed_count({ count: view.failed })}
          >
            <CircleAlert size={11} aria-hidden />
            {view.failed}
          </span>
        ) : null}
        <ChevronRight size={15} className="oc-subagents__chevron" aria-hidden />
      </button>
      {open ? (
        <div className="oc-subagents__list">
          {cards.map((card) => (
            <SubAgentCard key={card.id} card={card} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
