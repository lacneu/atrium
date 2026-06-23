import { useQuery, useMutation } from "convex/react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Star, Server } from "lucide-react";
import { useToast } from "@/components/ui/toast";
import { m } from "@/paraglide/messages.js";
import { api } from "../convexApi";
import type { Id } from "../convexApi";

// One pool agent (mirrors convex agents.listAgentPoolForUser).
type PoolAgent = {
  instanceName: string;
  agentId: string;
  displayName: string | null;
  emoji: string | null;
  model: string | null;
  kind: "openclaw" | "hermes";
  state: "ok" | "deleted" | "stale" | "unknown";
};

// Per-user Access editor. The selectable set is the user's POOL (the agents of
// their group(s), or — for a groupless user — every discovered agent), NOT a raw
// all-agents list: a direct selection RESTRICTS the member WITHIN that pool, and
// offering an out-of-pool agent would silently no-op (the cascade drops it). With
// NO selection the member gets the whole pool; with a selection, exactly it.
// Toggles apply immediately via the userAgents mutations (server re-validates).
export function UserAccessSheet({
  profileId,
  userLabel,
  open,
  onOpenChange,
}: {
  profileId: Id<"profiles"> | null;
  userLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const pool = useQuery(
    api.agents.listAgentPoolForUser,
    open && profileId ? { profileId } : "skip",
  );
  // RAW direct grants (the checked state + default star) — independent of the
  // cascade so the admin can manage a grant even if it falls outside the pool.
  const userAgents = useQuery(
    api.agents.listUserAgents,
    open && profileId ? { profileId } : "skip",
  );

  const assigned = new Set(
    (userAgents ?? []).map((u) => `${u.instanceName}/${u.agentId}`),
  );
  const defaultRow = (userAgents ?? []).find((u) => u.isDefault) ?? null;
  const defaultKey = defaultRow
    ? `${defaultRow.instanceName}/${defaultRow.agentId}`
    : null;

  // Displayed = the POOL, PLUS any direct grant that falls OUTSIDE the pool (a
  // stale grant from before the user joined their groups). Those don't drive the
  // member's effective set anymore, but the admin must still SEE them to remove or
  // fix them — they'd become effective again if the user left their groups. Marked
  // `outOfPool` so the row carries a clear badge.
  const poolKeys = new Set(
    (pool?.agents ?? []).map((a) => `${a.instanceName}/${a.agentId}`),
  );
  const displayed: (PoolAgent & { outOfPool: boolean })[] = [
    ...(pool?.agents ?? []).map((a) => ({ ...a, outOfPool: false })),
    ...(userAgents ?? [])
      .filter((u) => !poolKeys.has(`${u.instanceName}/${u.agentId}`))
      .map((u) => ({
        instanceName: u.instanceName,
        agentId: u.agentId,
        displayName: u.displayName,
        emoji: u.emoji,
        model: u.model,
        kind: u.kind,
        state: u.state,
        outOfPool: true,
      })),
  ];
  const byInstance = new Map<string, (PoolAgent & { outOfPool: boolean })[]>();
  for (const a of displayed) {
    const list = byInstance.get(a.instanceName) ?? [];
    list.push(a);
    byInstance.set(a.instanceName, list);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="oc-access">
        <DialogHeader>
          <DialogTitle>{m.useraccess_dialog_title({ user: userLabel })}</DialogTitle>
          <DialogDescription>
            {m.useraccess_dialog_description()}
          </DialogDescription>
        </DialogHeader>

        {pool ? (
          <p className="oc-access__hint">
            {pool.inGroup ? m.useraccess_pool_group() : m.useraccess_pool_all()}
          </p>
        ) : null}

        <div className="oc-access__list">
          {pool === undefined ? (
            <p className="oc-access__hint">{m.useraccess_loading()}</p>
          ) : displayed.length === 0 ? (
            <p className="oc-access__hint">{m.useraccess_no_agents()}</p>
          ) : (
            [...byInstance.entries()].map(([instanceName, agents]) => (
              <InstanceAgents
                key={instanceName}
                profileId={profileId}
                instanceName={instanceName}
                kind={agents[0]!.kind}
                agents={agents}
                assigned={assigned}
                defaultKey={defaultKey}
              />
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function InstanceAgents({
  profileId,
  instanceName,
  kind,
  agents,
  assigned,
  defaultKey,
}: {
  profileId: Id<"profiles"> | null;
  instanceName: string;
  kind: "openclaw" | "hermes";
  agents: (PoolAgent & { outOfPool: boolean })[];
  assigned: Set<string>;
  defaultKey: string | null;
}) {
  const assign = useMutation(api.agents.assignAgent);
  const remove = useMutation(api.agents.removeAgent);
  const setDefault = useMutation(api.agents.setDefaultAgent);
  const toast = useToast();

  if (!profileId) return null;

  async function toggle(agentId: string, isAssigned: boolean) {
    try {
      if (isAssigned) {
        await remove({ profileId: profileId!, instanceName, agentId });
      } else {
        await assign({ profileId: profileId!, instanceName, agentId });
      }
    } catch (err) {
      toast.error(m.useraccess_toast_access_update_denied(), err);
    }
  }
  async function makeDefault(agentId: string) {
    try {
      await setDefault({ profileId: profileId!, instanceName, agentId });
    } catch (err) {
      toast.error(m.useraccess_toast_set_default_denied(), err);
    }
  }

  return (
    <div className="oc-access__group">
      <div className="oc-access__instance">
        <Server size={13} aria-hidden />
        <span>{instanceName}</span>
        <Badge variant="outline" className="oc-access__kind">
          {kind}
        </Badge>
      </div>
      {agents.map((a) => {
        const key = `${instanceName}/${a.agentId}`;
        const isAssigned = assigned.has(key);
        const isDefault = defaultKey === key;
        const gone = a.state === "deleted";
        return (
          <div key={a.agentId} className="oc-access__row">
            <Checkbox
              checked={isAssigned}
              disabled={gone && !isAssigned}
              onCheckedChange={() => void toggle(a.agentId, isAssigned)}
              aria-label={m.useraccess_assign_aria({
                name: a.displayName ?? a.agentId,
              })}
            />
            <span className="oc-access__label">
              {a.emoji ? `${a.emoji} ` : ""}
              {a.displayName ?? a.agentId}
            </span>
            {a.model ? (
              <span className="oc-access__model">{a.model}</span>
            ) : null}
            {gone ? (
              <Badge variant="outline" className="oc-access__gone">
                {m.useraccess_badge_removed()}
              </Badge>
            ) : null}
            {a.outOfPool ? (
              <Badge variant="outline" className="oc-access__gone">
                {m.useraccess_badge_outofpool()}
              </Badge>
            ) : null}
            {isAssigned ? (
              isDefault ? (
                // The default agent is the ONLY one that shows a (filled, gold)
                // star — it reads as "this is the favorite".
                <span
                  className="oc-access__fav"
                  role="img"
                  aria-label={m.useraccess_default_agent()}
                  title={m.useraccess_default_agent()}
                >
                  <Star size={14} fill="currentColor" />
                </span>
              ) : (
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  className="oc-access__setdefault"
                  aria-label={m.useraccess_set_default()}
                  title={m.useraccess_set_default()}
                  onClick={() => void makeDefault(a.agentId)}
                >
                  <Star size={14} />
                </Button>
              )
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
