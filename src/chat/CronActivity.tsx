// Per-message "Crons" section: the scheduled jobs this turn CREATED / UPDATED
// / REMOVED (bridge-parsed `cron` tool mutations, messagePart kind:"cron").
// Deliberately its OWN section next to Sub-agents / Tools / Sources — the user
// must see at a glance that their prompt produced or changed scheduled jobs,
// without digging through raw tool cards. Each row opens the cron DETAIL in
// the integrated right column (same pattern as Sources / the sub-agent
// monitor / the Document Viewer); the detail panel offers the actions and the
// jump to Settings > Scheduled for full management.

import { createContext, useContext, useState } from "react";
import { useMessage } from "@assistant-ui/react";
import { CalendarClock, Pencil, Plus, Trash2 } from "lucide-react";
import { m } from "@/paraglide/messages.js";
import { ActivityRow } from "./ActivityRow";
import type { CronPartView } from "./convexTypes";

/** Row → right-column wiring. `instanceName` is resolved by the opener (the
 *  message's routed instance, falling back to the chat's primary). */
export interface CronDetailApi {
  active: { instanceName: string; jobId: string | null; part: CronPartView } | null;
  openFor: (part: CronPartView, routedInstanceName: string | null) => void;
  close: () => void;
}
export const CronDetailContext = createContext<CronDetailApi | null>(null);

const NO_PARTS: CronPartView[] = [];

function opIcon(op: CronPartView["op"]) {
  if (op === "created") return <Plus size={12} aria-hidden />;
  if (op === "removed") return <Trash2 size={12} aria-hidden />;
  return <Pencil size={12} aria-hidden />;
}

export function opLabel(op: CronPartView["op"]): string {
  if (op === "created") return m.cron_op_created();
  if (op === "removed") return m.cron_op_removed();
  return m.cron_op_updated();
}

export function CronActivity() {
  const cronParts = useMessage(
    (msg) =>
      (msg.metadata?.custom as { cronParts?: CronPartView[] } | undefined)
        ?.cronParts ?? NO_PARTS,
  );
  const routedInstanceName = useMessage(
    (msg) =>
      (msg.metadata?.custom as { routedInstanceName?: string | null } | undefined)
        ?.routedInstanceName ?? null,
  );
  const panel = useContext(CronDetailContext);
  // Expanded by DEFAULT — the whole point is that the user notices the jobs
  // their prompt produced; a fold is still offered for long threads.
  const [expanded, setExpanded] = useState(true);
  if (cronParts.length === 0) return null;

  return (
    <div className="oc-cronact">
      <ActivityRow
        icon={<CalendarClock size={14} />}
        label={m.cron_activity_label({ count: cronParts.length })}
        open={expanded}
        ariaExpanded={expanded}
        title={m.cron_activity_title()}
        onClick={() => setExpanded(!expanded)}
      />
      {expanded ? (
      <div className="oc-cronact__list">
        {cronParts.map((p, i) => {
          const isActive =
            panel?.active !== null &&
            panel?.active !== undefined &&
            panel.active.jobId === (p.jobId ?? null) &&
            panel.active.part === p;
          return (
            <button
              key={`${p.jobId ?? "job"}-${i}`}
              type="button"
              className={`oc-cronact__item${isActive ? " oc-cronact__item--active" : ""}`}
              onClick={() => panel?.openFor(p, routedInstanceName)}
              title={m.cron_item_open()}
            >
              <span className={`oc-cronact__op oc-cronact__op--${p.op}`}>
                {opIcon(p.op)}
                {opLabel(p.op)}
              </span>
              <span className="oc-cronact__name">
                {p.name ?? p.jobId ?? m.cron_unnamed()}
              </span>
              {p.schedule !== undefined ? (
                <span className="oc-cronact__sched">{p.schedule}</span>
              ) : null}
            </button>
          );
        })}
      </div>
      ) : null}
    </div>
  );
}
