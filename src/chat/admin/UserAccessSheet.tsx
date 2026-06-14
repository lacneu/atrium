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

// Per-user Access editor: assign DISCOVERED agents (per instance) + set the
// single default. Replaces the legacy free-text override/group columns (H4).
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
  const instances = useQuery(api.admin.listInstances, open ? {} : "skip");
  const userAgents = useQuery(
    api.agents.listUserAgents,
    open && profileId ? { profileId } : "skip",
  );

  const assigned = new Set(
    (userAgents ?? []).map((u) => `${u.instanceName}/${u.agentId}`),
  );
  const defaultKey =
    (userAgents ?? []).find((u) => u.isDefault) ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="oc-access">
        <DialogHeader>
          <DialogTitle>{m.useraccess_dialog_title({ user: userLabel })}</DialogTitle>
          <DialogDescription>
            {m.useraccess_dialog_description()}
          </DialogDescription>
        </DialogHeader>

        <div className="oc-access__list">
          {instances === undefined ? (
            <p className="oc-access__hint">{m.useraccess_loading()}</p>
          ) : instances.length === 0 ? (
            <p className="oc-access__hint">
              {m.useraccess_no_instances()}
            </p>
          ) : (
            instances.map((inst) => (
              <InstanceAgents
                key={inst._id}
                profileId={profileId}
                instanceName={inst.name}
                kind={inst.kind ?? "openclaw"}
                assigned={assigned}
                defaultKey={
                  defaultKey
                    ? `${defaultKey.instanceName}/${defaultKey.agentId}`
                    : null
                }
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
  assigned,
  defaultKey,
}: {
  profileId: Id<"profiles"> | null;
  instanceName: string;
  kind: "openclaw" | "hermes";
  assigned: Set<string>;
  defaultKey: string | null;
}) {
  const data = useQuery(api.agents.listAgentsForInstance, { instanceName });
  const assign = useMutation(api.agents.assignAgent);
  const remove = useMutation(api.agents.removeAgent);
  const setDefault = useMutation(api.agents.setDefaultAgent);
  const toast = useToast();

  if (!profileId) return null;
  const agents = (data?.agents ?? []).filter((a) => a.source === "discovered");
  const stale = data?.discovery && !data.discovery.lastPollOk;

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
        {stale ? (
          <Badge variant="outline" className="oc-access__stale">
            {m.useraccess_badge_offline()}
          </Badge>
        ) : null}
      </div>
      {data === undefined ? (
        <p className="oc-access__hint">{m.useraccess_loading_agents()}</p>
      ) : agents.length === 0 ? (
        <p className="oc-access__hint">
          {stale
            ? m.useraccess_no_agents_offline()
            : m.useraccess_no_agents()}
        </p>
      ) : (
        agents.map((a) => {
          const key = `${instanceName}/${a.agentId}`;
          const isAssigned = assigned.has(key);
          const isDefault = defaultKey === key;
          const gone = a.presentInLastOk === false;
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
              {isAssigned ? (
                isDefault ? (
                  // The default agent is the ONLY one that shows a (filled,
                  // gold) star — it reads as "this is the favorite". Decorative
                  // marker, sized to the icon-sm box so its glyph aligns with
                  // the hover star of the other rows.
                  <span
                    className="oc-access__fav"
                    role="img"
                    aria-label={m.useraccess_default_agent()}
                    title={m.useraccess_default_agent()}
                  >
                    <Star size={14} fill="currentColor" />
                  </span>
                ) : (
                  // Non-default agents have no star at rest; it is revealed on
                  // row hover / keyboard focus so it can be made the default.
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
        })
      )}
    </div>
  );
}
