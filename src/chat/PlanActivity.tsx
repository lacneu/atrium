// Per-message work-plan card (the model's `update_plan` tool, GPT-5-family
// runs). The bridge appends one kind:"plan" part per update; the NEWEST part
// is the plan's current state and arrives live while the turn streams — the
// user literally watches steps flip pending → in progress → completed and can
// judge the planned vs done work at a glance. Always visible (like the cron
// section): a plan is conversation-level information, not tool-call detail.

import { useState } from "react";
import { useMessage } from "@assistant-ui/react";
import { Check, Circle, ListTodo, LoaderCircle } from "lucide-react";
import { m } from "@/paraglide/messages.js";
import { ActivityRow } from "./ActivityRow";
import type { PlanPartView } from "./convexTypes";

const NO_PARTS: PlanPartView[] = [];

function StepIcon({
  status,
  settled,
}: {
  status: PlanPartView["steps"][number]["status"];
  /** TRUE once the turn is terminal: an in_progress step must not keep a
   *  spinner running on a dead turn (crashed run, user report 2026-07-19). */
  settled: boolean;
}) {
  if (status === "completed") {
    return <Check size={13} className="oc-planact__icon oc-planact__icon--done" aria-hidden />;
  }
  if (status === "in_progress" && !settled) {
    return (
      <LoaderCircle
        size={13}
        className="oc-planact__icon oc-planact__icon--current oc-actrow__spin"
        aria-hidden
      />
    );
  }
  return <Circle size={13} className="oc-planact__icon" aria-hidden />;
}

export function PlanActivity() {
  const planParts = useMessage(
    (msg) =>
      (msg.metadata?.custom as { planParts?: PlanPartView[] } | undefined)
        ?.planParts ?? NO_PARTS,
  );
  const settled = useMessage(
    (msg) =>
      (msg.metadata?.custom as { status?: string } | undefined)?.status !==
      "streaming",
  );
  // Expanded by default while work is in flight; the finished plan folds to
  // its one-line summary so a settled reply stays compact.
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  if (planParts.length === 0) return null;

  // The newest update is the plan's current truth.
  const plan = planParts[planParts.length - 1] as PlanPartView;
  const total = plan.steps.length;
  const done = plan.steps.filter((s) => s.status === "completed").length;
  const allDone = done === total;
  const expanded = userToggled ?? !allDone;
  const current = plan.steps.find((s) => s.status === "in_progress");

  return (
    <div className="oc-planact">
      <ActivityRow
        icon={<ListTodo size={14} />}
        label={
          plan.estimated
            ? `${m.plan_activity_label({ done, total })} \u00b7 ${m.plan_activity_estimated()}`
            : m.plan_activity_label({ done, total })
        }
        sublabel={
          !expanded && current !== undefined ? current.step : undefined
        }
        trailing={
          <span
            className="oc-planact__bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={done}
          >
            <span
              className="oc-planact__bar-fill"
              style={{ width: `${total > 0 ? (done / total) * 100 : 0}%` }}
            />
          </span>
        }
        open={expanded}
        ariaExpanded={expanded}
        title={expanded ? m.plan_activity_collapse() : m.plan_activity_expand()}
        onClick={() => setUserToggled(!expanded)}
      />
      {expanded ? (
        <ol className="oc-planact__steps">
          {plan.steps.map((s, i) => (
            <li
              key={i}
              className={`oc-planact__step oc-planact__step--${s.status}`}
            >
              <StepIcon status={s.status} settled={settled} />
              <span className="oc-planact__step-text">{s.step}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {expanded && plan.explanation !== undefined ? (
        <div className="oc-planact__note">{plan.explanation}</div>
      ) : null}
    </div>
  );
}
