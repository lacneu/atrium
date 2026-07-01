import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";

// Shared "activity row" — the ONE charte-graphique chrome for every per-turn meta
// affordance that sits above an assistant answer: tool activity, sources, and the
// sub-agent card. They looked hand-rolled three different ways; this unifies the
// LEFT part (icon + label, optional sublabel) and the RIGHT part (a trailing
// status/count slot + a chevron) so same-function elements render identically.
//
// PRESENTATIONAL ONLY — it deliberately does NOT unify behavior: tool activity
// expands INLINE (caller passes `open`, the chevron rotates), while sources and the
// sub-agent card OPEN THE RIGHT PANEL (caller passes `active`, the row highlights).
// Each caller keeps its own onClick + aria semantics; this owns only the chrome.

export type ActivityTone = "default" | "running" | "done" | "failed";

export interface ActivityRowProps {
  /** Leading lucide icon (rendered in the neutral icon slot, tinted by tone). */
  icon: ReactNode;
  /** Primary label (single line, truncates). */
  label: ReactNode;
  /** Optional second line under the label (e.g. a sub-agent's task). */
  sublabel?: ReactNode;
  /** Right-aligned status / counts (before the chevron). */
  trailing?: ReactNode;
  /** Lifecycle tint of the leading icon; default = neutral (tools / sources). */
  tone?: ActivityTone;
  /** Panel-open highlight (this row is the one detailed in the right panel). */
  active?: boolean;
  /** Inline-expanded (rotates the chevron); for the tool-activity inline detail. */
  open?: boolean;
  onClick: () => void;
  title?: string;
  ariaLabel?: string;
  /** Mirrors the caller's disclosure state (inline-expanded or panel-open). */
  ariaExpanded?: boolean;
  /** Set on the panel-openers so AT announces "opens a dialog". */
  ariaHasPopup?: boolean;
}

export function ActivityRow({
  icon,
  label,
  sublabel,
  trailing,
  tone = "default",
  active,
  open,
  onClick,
  title,
  ariaLabel,
  ariaExpanded,
  ariaHasPopup,
}: ActivityRowProps) {
  return (
    <button
      type="button"
      className={`oc-actrow oc-actrow--${tone}${active ? " is-active" : ""}${
        open ? " is-open" : ""
      }`}
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
      aria-expanded={ariaExpanded}
      aria-haspopup={ariaHasPopup ? "dialog" : undefined}
    >
      {/* TOP row: icon + label + trailing + chevron, all vertically centered on one
          line. The optional sublabel renders BELOW it (full width) so the top-row
          controls always align — no fragile per-element vertical nudging. */}
      <span className="oc-actrow__top">
        <span className="oc-actrow__icon" aria-hidden>
          {icon}
        </span>
        <span className="oc-actrow__label">{label}</span>
        {trailing ? <span className="oc-actrow__trail">{trailing}</span> : null}
        <ChevronRight size={14} className="oc-actrow__chev" aria-hidden />
      </span>
      {sublabel ? <span className="oc-actrow__sub">{sublabel}</span> : null}
    </button>
  );
}
