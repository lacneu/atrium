import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Star, Server, Bot } from "lucide-react";
import { m } from "@/paraglide/messages.js";

// One agent the current user may open a chat on (shape of api.agents.listMyAgents).
export interface PickableAgent {
  instanceName: string;
  agentId: string;
  isDefault: boolean;
  displayName: string | null;
  emoji: string | null;
  model: string | null;
  /** Admin-entered specialty blurb — the picker subtitle that tells a user
   *  what this agent is for. */
  description?: string | null;
  kind: "openclaw" | "hermes";
  state: "ok" | "deleted" | "stale" | "unknown";
}

export interface AgentGroup {
  instanceName: string;
  kind: "openclaw" | "hermes";
  agents: PickableAgent[];
}

// Group a user's agents by instance (then bridge kind is per-instance), default's
// instance first, agents within an instance with the default first then by label.
// Pure → unit-tested (the frontend has no DOM test runner).
export function groupByInstance(agents: PickableAgent[]): AgentGroup[] {
  const byInstance = new Map<string, AgentGroup>();
  for (const a of agents) {
    let g = byInstance.get(a.instanceName);
    if (!g) {
      g = { instanceName: a.instanceName, kind: a.kind, agents: [] };
      byInstance.set(a.instanceName, g);
    }
    g.agents.push(a);
  }
  const label = (a: PickableAgent) => (a.displayName ?? a.agentId).toLowerCase();
  for (const g of byInstance.values()) {
    g.agents.sort((x, y) =>
      x.isDefault !== y.isDefault
        ? x.isDefault
          ? -1
          : 1
        : label(x).localeCompare(label(y)),
    );
  }
  const groups = [...byInstance.values()];
  const hasDefault = (g: AgentGroup) => g.agents.some((a) => a.isDefault);
  groups.sort((x, y) =>
    hasDefault(x) !== hasDefault(y)
      ? hasDefault(x)
        ? -1
        : 1
      : x.instanceName.localeCompare(y.instanceName),
  );
  return groups;
}

// Case-insensitive filter over agent label / id / instance / model /
// description — so searching a NEED ("pptx", "convertir") finds the
// specialist even when its name doesn't contain the term.
export function filterAgents(
  agents: PickableAgent[],
  q: string,
): PickableAgent[] {
  const term = q.trim().toLowerCase();
  if (!term) return agents;
  return agents.filter((a) =>
    [a.displayName, a.agentId, a.instanceName, a.model, a.description]
      .filter(Boolean)
      .some((s) => s!.toLowerCase().includes(term)),
  );
}

/**
 * The intelligent agent picker for a NEW chat. Shown only when the user has >1
 * agent (1 → auto-bind upstream; 0 → the empty state here). Grouped by instance
 * with the bridge kind, the user's default highlighted; searchable; one click
 * binds + creates. Reads its agents from the parent (already loaded for the
 * auto-vs-pick decision) so there is no second query.
 */
export function AgentPickerDialog({
  open,
  onOpenChange,
  agents,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: PickableAgent[] | undefined;
  onPick: (instanceName: string, agentId: string) => void;
}) {
  const [q, setQ] = useState("");
  const groups = useMemo(
    () => groupByInstance(filterAgents(agents ?? [], q)),
    [agents, q],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="oc-agentpicker">
        <DialogHeader>
          <DialogTitle>{m.agentpicker_dialog_title()}</DialogTitle>
          <DialogDescription>
            {m.agentpicker_dialog_description()}
          </DialogDescription>
        </DialogHeader>

        {agents === undefined ? (
          <p className="oc-agentpicker__hint">{m.agentpicker_loading()}</p>
        ) : agents.length === 0 ? (
          <p className="oc-agentpicker__hint">
            {m.agentpicker_empty_state()}
          </p>
        ) : (
          <>
            <Input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={m.agentpicker_search_placeholder()}
              className="oc-agentpicker__search"
              aria-label={m.agentpicker_search_aria_label()}
            />
            <div className="oc-agentpicker__list" role="listbox">
              {groups.map((g) => (
                <div key={g.instanceName} className="oc-agentpicker__group">
                  <div className="oc-agentpicker__instance">
                    <Server size={13} aria-hidden />
                    <span>{g.instanceName}</span>
                    <Badge variant="outline" className="oc-agentpicker__kind">
                      {g.kind}
                    </Badge>
                  </div>
                  {g.agents.map((a) => (
                    <button
                      key={`${a.instanceName}/${a.agentId}`}
                      type="button"
                      role="option"
                      aria-selected={false}
                      className="oc-agentpicker__item"
                      onClick={() => onPick(a.instanceName, a.agentId)}
                      disabled={a.state === "deleted"}
                      title={
                        a.state === "deleted"
                          ? m.agentpicker_agent_deleted_title()
                          : undefined
                      }
                    >
                      <Bot size={15} aria-hidden className="oc-agentpicker__icon" />
                      <span className="oc-agentpicker__main">
                        <span className="oc-agentpicker__label">
                          {a.emoji ? `${a.emoji} ` : ""}
                          {a.displayName ?? a.agentId}
                        </span>
                        {a.description ? (
                          <span className="oc-agentpicker__desc">
                            {a.description}
                          </span>
                        ) : null}
                      </span>
                      {a.model ? (
                        <span className="oc-agentpicker__model">{a.model}</span>
                      ) : null}
                      {a.isDefault ? (
                        <Star
                          size={13}
                          aria-label={m.agentpicker_default_agent_aria_label()}
                          className="oc-agentpicker__default"
                        />
                      ) : null}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
