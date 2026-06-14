import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Server, Star, Users } from "lucide-react";
import { m } from "@/paraglide/messages.js";
import { api } from "../convexApi";
import type { Id } from "../convexApi";
import { DataTableShell } from "./DataTableShell";
import { EntitySheet } from "./EntitySheet";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ConfirmDialog";
import { useToast } from "@/components/ui/toast";

// "Groupes" tab (P2). Admin-only surface to regroup users + share agents by
// group. Every Convex function this calls re-enforces requirePermission(
// GROUPS_MANAGE) against the REAL identity server-side — this UI is convenience,
// not the security boundary. See docs/GROUPS_CHARTS_P2_SPEC.md section 7.
//
// Layout:
//  - the list (DataTableShell): name, #members, #agents; add (dialog), rename
//    (sheet), delete (confirm guard), and a "Manage" action that opens the
//    detail dialog.
//  - the detail dialog: members (add/remove cross-referenced against listUsers)
//    + shared agents (assign/remove from the DISCOVERED agents of each instance).

type GroupRow = {
  _id: Id<"groups">;
  key: string;
  name: string;
  description: string | null;
  memberCount: number;
  agentCount: number;
  createdAt: number;
};

type GroupForm = { name: string; description: string };
const EMPTY_FORM: GroupForm = { name: "", description: "" };

export function GroupsTab() {
  const groups = useQuery(api.groups.listGroups, {}) as
    | GroupRow[]
    | undefined;
  const createGroup = useMutation(api.groups.createGroup);
  const updateGroup = useMutation(api.groups.updateGroup);
  const deleteGroup = useMutation(api.groups.deleteGroup);
  const confirm = useConfirm();
  const toast = useToast();

  // Create / rename share the same EntitySheet; `editing` is the group being
  // renamed (null = create mode).
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState<GroupRow | null>(null);
  const [form, setForm] = useState<GroupForm>(EMPTY_FORM);
  // The group whose member/agent management dialog is open.
  const [manageFor, setManageFor] = useState<{
    groupId: Id<"groups">;
    name: string;
  } | null>(null);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setSheetOpen(true);
  }
  function openRename(g: GroupRow) {
    setEditing(g);
    setForm({ name: g.name, description: g.description ?? "" });
    setSheetOpen(true);
  }

  async function submit() {
    try {
      if (editing) {
        await updateGroup({
          groupId: editing._id,
          name: form.name,
          // Send the RAW string (even "") in edit mode: an emptied field must
          // actually CLEAR the description (updateGroup maps "" -> remove). With
          // `|| undefined` an emptied field looked like "don't touch" and the old
          // description survived.
          description: form.description,
        });
      } else {
        await createGroup({
          name: form.name,
          description: form.description || undefined,
        });
      }
      setForm(EMPTY_FORM);
      setEditing(null);
      setSheetOpen(false);
    } catch (err) {
      toast.error(m.groups_toast_save_error(), err);
    }
  }

  async function remove(g: GroupRow) {
    // Type-to-confirm guard: deleting a group cascades its memberships + shared
    // agents (the server purges both), so make it deliberate.
    const ok = await confirm({
      title: m.groups_delete_confirm_title({ name: g.name }),
      description: m.groups_delete_confirm_desc(),
      confirmWord: g.name,
      confirmLabel: m.groups_delete_confirm_label(),
      cancelLabel: m.groups_cancel(),
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteGroup({ groupId: g._id });
    } catch (err) {
      toast.error(m.groups_toast_delete_error(), err);
    }
  }

  return (
    <>
      <p className="oc-admin__hint">{m.groups_hint()}</p>
      <DataTableShell
        title={m.groups_title()}
        rows={groups}
        addLabel={m.groups_add()}
        onAdd={openCreate}
        emptyHint={m.groups_empty()}
        columns={[
          { header: m.groups_col_name(), cell: (g) => g.name },
          {
            header: m.groups_col_members(),
            cell: (g) => (
              <Badge variant="outline" className="gap-1">
                <Users size={12} aria-hidden />
                {g.memberCount}
              </Badge>
            ),
          },
          {
            header: m.groups_col_agents(),
            cell: (g) => (
              <Badge variant="outline" className="gap-1">
                <Server size={12} aria-hidden />
                {g.agentCount}
              </Badge>
            ),
          },
          {
            header: m.groups_col_manage(),
            cell: (g) => (
              <Button
                variant="outline"
                size="sm"
                className="h-8 font-normal"
                onClick={() =>
                  setManageFor({ groupId: g._id, name: g.name })
                }
              >
                {m.groups_manage()}
              </Button>
            ),
          },
        ]}
        rowActions={(g) => [
          { label: m.groups_rename(), onSelect: () => openRename(g) },
          {
            label: m.groups_delete(),
            variant: "destructive",
            onSelect: () => void remove(g),
          },
        ]}
      />

      <EntitySheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        title={editing ? m.groups_sheet_rename_title() : m.groups_sheet_new_title()}
        description={m.groups_sheet_desc()}
        canSubmit={Boolean(form.name.trim())}
        onSubmit={submit}
        submitLabel={m.groups_save()}
      >
        <div className="oc-form">
          <label className="oc-field">
            <span className="oc-field__label">{m.groups_field_name()}</span>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label className="oc-field">
            <span className="oc-field__label">
              {m.groups_field_description()}
            </span>
            <Input
              value={form.description}
              onChange={(e) =>
                setForm({ ...form, description: e.target.value })
              }
            />
          </label>
        </div>
      </EntitySheet>

      <GroupManageDialog
        groupId={manageFor?.groupId ?? null}
        groupName={manageFor?.name ?? ""}
        open={manageFor !== null}
        onOpenChange={(o) => {
          if (!o) setManageFor(null);
        }}
      />
    </>
  );
}

// Member + shared-agent management for one group. Reactive: it re-reads
// api.groups.getGroup (the source of truth) so a toggle reflects immediately.
function GroupManageDialog({
  groupId,
  groupName,
  open,
  onOpenChange,
}: {
  groupId: Id<"groups"> | null;
  groupName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const detail = useQuery(
    api.groups.getGroup,
    open && groupId ? { groupId } : "skip",
  );
  const instances = useQuery(api.admin.listInstances, open ? {} : "skip");
  const users = useQuery(api.admin.listUsers, open ? {} : "skip");

  const addMember = useMutation(api.groups.addMember);
  const removeMember = useMutation(api.groups.removeMember);
  const toast = useToast();

  // userId -> in-group membership (for the cross-reference against the user
  // list); group agents keyed `${instanceName}/${agentId}` for assignment.
  const memberIds = useMemo(
    () => new Set((detail?.members ?? []).map((mm) => mm.userId)),
    [detail],
  );
  const groupAgentKeys = useMemo(
    () =>
      new Set(
        (detail?.agents ?? []).map((a) => `${a.instanceName}/${a.agentId}`),
      ),
    [detail],
  );

  async function toggleMember(userId: Id<"users">, isMember: boolean) {
    if (!groupId) return;
    try {
      if (isMember) await removeMember({ groupId, userId });
      else await addMember({ groupId, userId });
    } catch (err) {
      toast.error(m.groups_toast_member_error(), err);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="oc-access">
        <DialogHeader>
          <DialogTitle>{m.groups_manage_title({ name: groupName })}</DialogTitle>
          <DialogDescription>{m.groups_manage_desc()}</DialogDescription>
        </DialogHeader>

        {/* Members --------------------------------------------------------- */}
        <div className="oc-access__group">
          <div className="oc-access__instance">
            <Users size={13} aria-hidden />
            <span>{m.groups_members_section()}</span>
          </div>
          {users === undefined || detail === undefined ? (
            <p className="oc-access__hint">{m.groups_loading()}</p>
          ) : users.length === 0 ? (
            <p className="oc-access__hint">{m.groups_no_users()}</p>
          ) : (
            <div className="oc-access__list">
              {users.map((u) => {
                const isMember = memberIds.has(u.userId);
                const label =
                  u.email || u.name || u.canonical || u.userId.slice(0, 8);
                return (
                  <div key={u._id} className="oc-access__row">
                    <Checkbox
                      checked={isMember}
                      onCheckedChange={() =>
                        void toggleMember(u.userId, isMember)
                      }
                      aria-label={m.groups_member_toggle_aria({ user: label })}
                    />
                    <span className="oc-access__label">{label}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Shared agents --------------------------------------------------- */}
        <div className="oc-access__list">
          {instances === undefined ? (
            <p className="oc-access__hint">{m.groups_loading()}</p>
          ) : instances.length === 0 ? (
            <p className="oc-access__hint">{m.groups_no_instances()}</p>
          ) : (
            instances.map((inst) => (
              <GroupInstanceAgents
                key={inst._id}
                groupId={groupId}
                instanceName={inst.name}
                kind={inst.kind ?? "openclaw"}
                assigned={groupAgentKeys}
              />
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// The DISCOVERED, present agents of one instance, each toggling membership in
// the group's shared-agent set. Mirrors UserAccessSheet's InstanceAgents:
// assignAgentToGroup REJECTS a non-discovered / absent agent server-side, so we
// only ever offer discovered ones and surface the rejection via a toast. There
// is NO per-group "make default" action in P2 (no mutation exists) — the
// default star is shown read-only when the backend marks one.
function GroupInstanceAgents({
  groupId,
  instanceName,
  kind,
  assigned,
}: {
  groupId: Id<"groups"> | null;
  instanceName: string;
  kind: "openclaw" | "hermes";
  assigned: Set<string>;
}) {
  const data = useQuery(api.agents.listAgentsForInstance, { instanceName });
  const assign = useMutation(api.groups.assignAgentToGroup);
  const remove = useMutation(api.groups.removeAgentFromGroup);
  const toast = useToast();

  if (!groupId) return null;
  const agents = (data?.agents ?? []).filter((a) => a.source === "discovered");
  const stale = data?.discovery && !data.discovery.lastPollOk;

  async function toggle(agentId: string, isAssigned: boolean) {
    try {
      if (isAssigned) await remove({ groupId: groupId!, instanceName, agentId });
      else await assign({ groupId: groupId!, instanceName, agentId });
    } catch (err) {
      toast.error(m.groups_toast_agent_error(), err);
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
            {m.groups_badge_offline()}
          </Badge>
        ) : null}
      </div>
      {data === undefined ? (
        <p className="oc-access__hint">{m.groups_loading_agents()}</p>
      ) : agents.length === 0 ? (
        <p className="oc-access__hint">
          {stale ? m.groups_no_agents_offline() : m.groups_no_agents()}
        </p>
      ) : (
        agents.map((a) => {
          const key = `${instanceName}/${a.agentId}`;
          const isAssigned = assigned.has(key);
          const gone = a.presentInLastOk === false;
          return (
            <div key={a.agentId} className="oc-access__row">
              <Checkbox
                checked={isAssigned}
                disabled={gone && !isAssigned}
                onCheckedChange={() => void toggle(a.agentId, isAssigned)}
                aria-label={m.groups_agent_toggle_aria({
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
              {a.isDefaultOnInstance ? (
                <span
                  className="oc-access__fav"
                  role="img"
                  aria-label={m.groups_default_on_instance()}
                  title={m.groups_default_on_instance()}
                >
                  <Star size={14} fill="currentColor" />
                </span>
              ) : null}
              {gone ? (
                <Badge variant="outline" className="oc-access__gone">
                  {m.groups_badge_removed()}
                </Badge>
              ) : null}
            </div>
          );
        })
      )}
    </div>
  );
}
