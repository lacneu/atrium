import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { ChevronLeft, ChevronRight, Server, Star, Users } from "lucide-react";
import { m } from "@/paraglide/messages.js";
import { api } from "../convexApi";
import type { Id } from "../convexApi";
import { DataTableShell } from "./DataTableShell";
import { EntitySheet } from "./EntitySheet";
import {
  filterInstanceAgents,
  filterSortMembers,
  paginate,
  roleLabel,
  selectionState,
  userDisplayParts,
} from "./groupManageView";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
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
          { header: m.groups_col_name(), cell: (g) => g.name, sort: (g) => g.name },
          {
            header: m.groups_col_members(),
            cell: (g) => (
              <Badge variant="outline" className="gap-1">
                <Users size={12} aria-hidden />
                {g.memberCount}
              </Badge>
            ),
            sort: (g) => g.memberCount,
          },
          {
            header: m.groups_col_agents(),
            cell: (g) => (
              <Badge variant="outline" className="gap-1">
                <Server size={12} aria-hidden />
                {g.agentCount}
              </Badge>
            ),
            sort: (g) => g.agentCount,
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

// Rows per page in the member / agent lists. Sized so a full page stays under
// the .oc-access__list cap (no page that both paginates AND inner-scrolls).
const PAGE_SIZE = 8;

// Prev / page-indicator / next footer. Renders nothing for a single page.
function Pager({
  page,
  pageCount,
  onPage,
}: {
  page: number;
  pageCount: number;
  onPage: (page: number) => void;
}) {
  if (pageCount <= 1) return null;
  return (
    <div className="oc-access__pager">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
      >
        <ChevronLeft size={14} aria-hidden />
        {m.pagination_prev()}
      </Button>
      <span
        className="oc-access__pageinfo"
        aria-label={m.pagination_page({ page, pages: pageCount })}
      >
        {page} / {pageCount}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={page >= pageCount}
        onClick={() => onPage(page + 1)}
      >
        {m.pagination_next()}
        <ChevronRight size={14} aria-hidden />
      </Button>
    </div>
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
  const bulkSetMembers = useMutation(api.groups.bulkSetMembers);
  const toast = useToast();

  // Search filters + active tab, scoped to the open session. The parent keeps
  // this dialog MOUNTED (open is a prop), so these survive a close — reset them
  // when the dialog opens or switches groups, else they leak across groups.
  const [memberQuery, setMemberQuery] = useState("");
  const [agentQuery, setAgentQuery] = useState("");
  const [tab, setTab] = useState("members");
  const [memberPage, setMemberPage] = useState(1);
  // A FROZEN snapshot of the member set used only for "members first" ordering.
  // We sort against this, not the live (reactively-updated) membership, so a
  // row does not jump to the top a few hundred ms after a toggle commits — the
  // checkbox `checked` stays live, only the visual order is stable.
  const [orderSnapshot, setOrderSnapshot] = useState<Set<string>>(new Set());
  const seededFor = useRef<Id<"groups"> | null>(null);

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

  // Reset per-session filters + tab + page + clear the ordering seed on open /
  // group change.
  useEffect(() => {
    setMemberQuery("");
    setAgentQuery("");
    setTab("members");
    setMemberPage(1);
    seededFor.current = null;
  }, [open, groupId]);

  // A new search must restart paging (page 3 of the old results is meaningless
  // against the new, shorter filtered set).
  useEffect(() => {
    setMemberPage(1);
  }, [memberQuery]);

  // Seed the ordering snapshot ONCE per session, after detail has loaded. The
  // seed guard keeps later toggles (which mutate `detail`) from re-freezing it.
  useEffect(() => {
    if (open && detail && groupId && seededFor.current !== groupId) {
      seededFor.current = groupId;
      setOrderSnapshot(new Set((detail.members ?? []).map((mm) => mm.userId)));
    }
  }, [open, detail, groupId]);

  // Filter by email / name / canonical, then list snapshot-members first (pure
  // helper, unit-tested in groupManageView.test.ts).
  const filteredUsers = useMemo(
    () => (users ? filterSortMembers(users, memberQuery, orderSnapshot) : []),
    [users, memberQuery, orderSnapshot],
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

  // "Select all" acts on the CURRENTLY FILTERED set (the standard picker
  // behavior): if every filtered user is already a member, the box clears them;
  // otherwise it adds the rest. One bulk round-trip, not N.
  const memberSel = selectionState(filteredUsers, (u) => memberIds.has(u.userId));
  // The select-all row's badge MUST report the filtered scope (what the box
  // acts on), not the global total — otherwise "all of 1 match" reads next to
  // "8 / 213" and looks like everyone is selected.
  const filteredMemberCount = filteredUsers.filter((u) =>
    memberIds.has(u.userId),
  ).length;
  // Pagination is a pure rendering slice: select-all + counts above still act on
  // the whole filtered set, only these rows are shown.
  const memberPaged = paginate(filteredUsers, memberPage, PAGE_SIZE);
  async function toggleAllMembers() {
    if (!groupId || filteredUsers.length === 0) return;
    const userIds = filteredUsers.map((u) => u.userId);
    try {
      await bulkSetMembers({ groupId, userIds, member: memberSel !== "all" });
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

        {/* Members and agents are split into tabs: only one list is visible at a
            time, so each gets the full height and the dialog never overflows. */}
        <Tabs value={tab} onValueChange={setTab} className="oc-access__tabs">
          <TabsList className="w-full">
            <TabsTrigger value="members" className="flex-1 gap-1.5">
              <Users size={13} aria-hidden />
              {m.groups_members_section()}
              {detail ? (
                <Badge variant="secondary" className="oc-access__tabcount">
                  {memberIds.size}
                </Badge>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="agents" className="flex-1 gap-1.5">
              <Server size={13} aria-hidden />
              {m.groups_agents_section()}
              {detail ? (
                <Badge variant="secondary" className="oc-access__tabcount">
                  {groupAgentKeys.size}
                </Badge>
              ) : null}
            </TabsTrigger>
          </TabsList>

          {/* Members ------------------------------------------------------- */}
          <TabsContent value="members">
            {users === undefined || detail === undefined ? (
              <p className="oc-access__hint">{m.groups_loading()}</p>
            ) : users.length === 0 ? (
              <p className="oc-access__hint">{m.groups_no_users()}</p>
            ) : (
              <>
                <Input
                  value={memberQuery}
                  onChange={(e) => setMemberQuery(e.target.value)}
                  placeholder={m.groups_members_search()}
                  className="oc-access__search"
                />
                {filteredUsers.length === 0 ? (
                  <p className="oc-access__hint">{m.groups_search_none()}</p>
                ) : (
                  <>
                    {filteredUsers.length > 1 ? (
                      <div className="oc-access__row oc-access__selectall">
                        <Checkbox
                          checked={
                            memberSel === "all"
                              ? true
                              : memberSel === "some"
                                ? "indeterminate"
                                : false
                          }
                          onCheckedChange={() => void toggleAllMembers()}
                          aria-label={m.groups_select_all()}
                        />
                        <span className="oc-access__label">
                          {m.groups_select_all()}
                        </span>
                        <Badge variant="outline" className="oc-access__count">
                          {filteredMemberCount} / {filteredUsers.length}
                        </Badge>
                      </div>
                    ) : null}
                    <div className="oc-access__list">
                      {memberPaged.pageItems.map((u) => {
                        const isMember = memberIds.has(u.userId);
                        const parts = userDisplayParts(u);
                        return (
                          <div key={u._id} className="oc-access__row">
                            <Checkbox
                              checked={isMember}
                              onCheckedChange={() =>
                                void toggleMember(u.userId, isMember)
                              }
                              aria-label={m.groups_member_toggle_aria({
                                user: parts.primary,
                              })}
                            />
                            <span className="oc-access__who">
                              <span className="oc-access__label">
                                {parts.primary}
                              </span>
                              {parts.secondary ? (
                                <span className="oc-access__sub">
                                  {parts.secondary}
                                </span>
                              ) : null}
                            </span>
                            <Badge
                              variant="outline"
                              className="oc-access__role"
                            >
                              {roleLabel(u.role)}
                            </Badge>
                          </div>
                        );
                      })}
                    </div>
                    <Pager
                      page={memberPaged.page}
                      pageCount={memberPaged.pageCount}
                      onPage={setMemberPage}
                    />
                  </>
                )}
              </>
            )}
          </TabsContent>

          {/* Shared agents ------------------------------------------------- */}
          <TabsContent value="agents">
            {instances === undefined ? (
              <p className="oc-access__hint">{m.groups_loading()}</p>
            ) : instances.length === 0 ? (
              <p className="oc-access__hint">{m.groups_no_instances()}</p>
            ) : (
              <>
                <Input
                  value={agentQuery}
                  onChange={(e) => setAgentQuery(e.target.value)}
                  placeholder={m.groups_agents_search()}
                  className="oc-access__search"
                />
                <div className="oc-access__list">
                  {instances.map((inst) => (
                    // Key includes groupId so switching groups REMOUNTS the
                    // block — its internal page state resets to 1 (the parent's
                    // agentQuery reset alone wouldn't fire if it was already "").
                    <GroupInstanceAgents
                      key={`${groupId}-${inst._id}`}
                      groupId={groupId}
                      instanceName={inst.name}
                      kind={inst.kind ?? "openclaw"}
                      assigned={groupAgentKeys}
                      query={agentQuery}
                    />
                  ))}
                </div>
              </>
            )}
          </TabsContent>
        </Tabs>
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
  query,
}: {
  groupId: Id<"groups"> | null;
  instanceName: string;
  kind: "openclaw" | "hermes";
  assigned: Set<string>;
  query: string;
}) {
  const data = useQuery(api.agents.listAgentsForInstance, { instanceName });
  const assign = useMutation(api.groups.assignAgentToGroup);
  const remove = useMutation(api.groups.removeAgentFromGroup);
  const bulkSetGroupAgents = useMutation(api.groups.bulkSetGroupAgents);
  const toast = useToast();
  // Page state lives ABOVE the early returns so the hook count is constant even
  // when this instance is hidden (search miss) or groupId is null.
  const [page, setPage] = useState(1);
  useEffect(() => {
    setPage(1);
  }, [query]);

  if (!groupId) return null;
  const agents = filterInstanceAgents(data?.agents ?? [], query);
  const stale = data?.discovery && !data.discovery.lastPollOk;

  // Hide the whole instance block when a search is active and nothing matches,
  // so the agents list collapses to just the instances that have a hit.
  if (query.trim() && agents.length === 0) return null;

  // "Select all" only ever targets ASSIGNABLE (present) agents — a gone agent
  // can't be shared, so it must not be force-assigned by the bulk toggle.
  const selectable = agents.filter((a) => a.presentInLastOk !== false);
  const agentSel = selectionState(selectable, (a) =>
    assigned.has(`${instanceName}/${a.agentId}`),
  );
  // Pagination is a pure rendering slice; select-all still acts on all present.
  const agentPaged = paginate(agents, page, PAGE_SIZE);

  async function toggle(agentId: string, isAssigned: boolean) {
    try {
      if (isAssigned) await remove({ groupId: groupId!, instanceName, agentId });
      else await assign({ groupId: groupId!, instanceName, agentId });
    } catch (err) {
      toast.error(m.groups_toast_agent_error(), err);
    }
  }

  async function toggleAllAgents() {
    if (selectable.length === 0) return;
    const agentIds = selectable.map((a) => a.agentId);
    try {
      await bulkSetGroupAgents({
        groupId: groupId!,
        instanceName,
        agentIds,
        assigned: agentSel !== "all",
      });
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
        <>
          {selectable.length > 1 ? (
            <div className="oc-access__row oc-access__selectall">
              <Checkbox
                checked={
                  agentSel === "all"
                    ? true
                    : agentSel === "some"
                      ? "indeterminate"
                      : false
                }
                onCheckedChange={() => void toggleAllAgents()}
                aria-label={m.groups_select_all()}
              />
              <span className="oc-access__label">{m.groups_select_all()}</span>
            </div>
          ) : null}
          {agentPaged.pageItems.map((a) => {
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
          })}
          <Pager
            page={agentPaged.page}
            pageCount={agentPaged.pageCount}
            onPage={setPage}
          />
        </>
      )}
    </div>
  );
}
