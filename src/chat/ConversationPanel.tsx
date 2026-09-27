// THE CONVERSATION PANEL — who and what is in this conversation, and what each
// person may do in it.
//
// ONE RULE FOR THE LAYOUT: the panel shows only who IS in the conversation. What
// could be added (agents the reader holds, people of the deployment) never shares
// the page with it — it lives in a picker dialog opened by the "add" buttons, so
// the two lists can never be confused.
//
// TWO TABS, because they are two different questions: "which agents answer here"
// and "who takes part". The composer's agent control opens the panel on the right
// tab, or straight into a picker (see ComposerAgentSelect).
//
// WHO MAY DO WHAT mirrors the server exactly (convex/chatAgents.ts,
// convex/chatParticipants.ts, convex/lib/chatAccess.ts) through the pure helpers of
// conversationRoles.ts — a control the server would refuse is never shown.

import { useMutation, useQuery } from "convex/react";
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Crown,
  LogOut,
  MoreHorizontal,
  Plus,
  Server,
  ShieldCheck,
  UserPlus,
  Users,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { m } from "@/paraglide/messages.js";

import type { Id } from "../../convex/_generated/dataModel";
import { Avatar } from "./ChatParticipants";
import { GatewayMark } from "./GatewayMark";
import {
  assignableRoles,
  arrivalRoleFor,
  invitableRoles,
  managesRoom,
  mayRemoveMember,
  type MemberRole,
  type RoomRole,
} from "./conversationRoles";
import { api } from "./convexApi";
import { SessionKnobsGroup } from "./KnobRow";
import { agentRefEquals, presenceRoster } from "./perTurnAgent";
import { dockFocus, dockOffsets, dockScales } from "./presenceDock";
import type { SessionMetaView, SessionSettingsView } from "./sessionKnobs";
import type { ChatRouting } from "./useConvexChatRuntime";

import "./chatParticipants.css";

export type ConversationTab = "agents" | "people";
/** Open the panel straight into a picker (from the composer's agent control). */
export type ConversationIntent = "add-agent" | "invite" | "primary" | null;

type AgentLike = {
  instanceName: string;
  agentId: string;
  displayName: string | null;
  emoji: string | null;
  description?: string | null;
  model?: string | null;
};

const roleLabel = (r: RoomRole): string =>
  r === "owner"
    ? m.conversation_role_owner()
    : r === "manager"
      ? m.conversation_role_manager()
      : r === "member"
        ? m.conversation_role_member()
        : m.conversation_role_viewer();

/** The same label standing alone (a select, a line of its own): capitalized. */
export const roleTitle = (r: RoomRole): string => {
  const l = roleLabel(r);
  return l.charAt(0).toUpperCase() + l.slice(1);
};

const roleHelp = (r: MemberRole): string =>
  r === "manager"
    ? m.conversation_role_manager_help()
    : r === "member"
      ? m.conversation_role_member_help()
      : m.conversation_role_viewer_help();

function AgentFace({ agent }: { agent: { emoji: string | null } }) {
  return (
    <span className="oc-convpanel__face" aria-hidden>
      {agent.emoji ? agent.emoji : <Bot size={14} />}
    </span>
  );
}

const agentName = (a: { displayName: string | null; agentId: string }) =>
  a.displayName ?? a.agentId;

/** Case-insensitive match on any of the given fields. */
function matches(q: string, fields: Array<string | null | undefined>): boolean {
  const needle = q.trim().toLowerCase();
  if (needle === "") return true;
  return fields.some((f) => (f ?? "").toLowerCase().includes(needle));
}

/**
 * The picker: a dialog over the panel, listing what can be ADDED — never mixed
 * with what is already there. Stays open to add several; each row turns into a
 * check once added.
 */
function PickerDialog<T>({
  open,
  onOpenChange,
  title,
  description,
  items,
  keyOf,
  searchFields,
  render,
  actionLabel,
  onPick,
  closeOnPick = false,
  empty,
  header,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  items: T[] | undefined;
  keyOf: (item: T) => string;
  searchFields: (item: T) => Array<string | null | undefined>;
  render: (item: T) => React.ReactNode;
  actionLabel: string;
  onPick: (item: T) => Promise<unknown>;
  closeOnPick?: boolean;
  empty: string;
  header?: React.ReactNode;
}) {
  const [q, setQ] = useState("");
  const [done, setDone] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) {
      setQ("");
      setDone(new Set());
    }
  }, [open]);
  const shown = (items ?? []).filter((it) => matches(q, searchFields(it)));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="oc-convpicker"
        // Focus the SEARCH, synchronously with the open: the dialog opens over the
        // panel's own focus trap, and letting them negotiate delayed the focus —
        // the first keystrokes typed after opening landed nowhere, then late.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          searchRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {/* Search FIRST: the dialog focuses its first control, and typing must
            land in the search, not in the role select below it. */}
        <Input
          ref={searchRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={m.conversation_search()}
          aria-label={m.conversation_search()}
        />
        {header}
        <ul className="oc-convpicker__list">
          {items === undefined ? (
            <li className="oc-convpicker__empty">{m.participants_loading()}</li>
          ) : shown.length === 0 ? (
            <li className="oc-convpicker__empty">{empty}</li>
          ) : (
            shown.map((it) => {
              const key = keyOf(it);
              const added = done.has(key);
              return (
                <li key={key} className="oc-convpicker__row">
                  {render(it)}
                  <Button
                    variant={added ? "ghost" : "outline"}
                    size="sm"
                    disabled={added || busy !== null}
                    onClick={() => {
                      setBusy(key);
                      void onPick(it)
                        .then(() => {
                          setDone((d) => new Set(d).add(key));
                          if (closeOnPick) onOpenChange(false);
                        })
                        .catch(() => {
                          /* the caller already told the reader */
                        })
                        .finally(() => setBusy(null));
                    }}
                  >
                    {added ? <Check size={14} aria-hidden /> : null}
                    {added ? m.conversation_added() : actionLabel}
                  </Button>
                </li>
              );
            })
          )}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

/** How many faces the composer's presence strip shows before "+N". */
const PRESENCE_MAX = 6;

/**
 * WHO IS IN THE ROOM, at a glance — shown in the composer of a group conversation.
 *
 * A strip of small faces, not a sentence: people as round initials, agents as
 * square tiles bearing their gateway's glyph (OpenClaw's claw, Hermes' feather),
 * so the two read apart without a word. Everyone is counted and shown — the reader
 * included, marked as themselves — so the strip says the same number as the room
 * control; whoever does not fit shows as "+N". Each face names itself on hover; a
 * click opens the people.
 */
export function RoomPresence({
  chatId,
  onOpen,
}: {
  chatId: Id<"chats">;
  onOpen: () => void;
}) {
  const members = useQuery(api.chatParticipants.listMembers, { chatId });
  const room = useQuery(api.chatAgents.listChatAgents, { chatId: chatId as string });
  // THE DOCK: faces magnify around the pointer (presenceDock.ts). Centres are taken at
  // REST when the pointer enters — measuring while magnified would chase the spread.
  const faceRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const restCenters = useRef<number[]>([]);
  const restWidth = useRef(20);
  const [pointerX, setPointerX] = useState<number | null>(null);
  const stripLeft = useRef(0);
  const roster = presenceRoster(
    members ?? [],
    room ? [room.primary, ...room.agents].filter((a) => a !== null) : [],
  );
  if (roster === null) return null;
  const { people, agents } = roster;
  type Face =
    | { kind: "person"; key: string; name: string; userId: string; role: string; self: boolean }
    | { kind: "agent"; key: string; name: string; gateway: "openclaw" | "hermes"; primary: boolean };
  const faces: Face[] = [
    ...people.map(
      (p): Face => ({
        kind: "person",
        key: `p/${String(p.userId)}`,
        name: p.isSelf ? `${p.name} (${m.conversation_you()})` : p.name,
        userId: String(p.userId),
        role: roleLabel(p.roomRole),
        self: p.isSelf,
      }),
    ),
    ...agents.map(
      (a): Face => ({
        kind: "agent",
        key: `a/${a!.instanceName}/${a!.agentId}`,
        name: a!.displayName ?? a!.agentId,
        gateway: a!.kind,
        primary: a!.role === "primary",
      }),
    ),
  ];
  const shown = faces.slice(0, PRESENCE_MAX);
  const hidden = faces.slice(PRESENCE_MAX);
  const reducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  const scales = reducedMotion
    ? shown.map(() => 1)
    : dockScales(restCenters.current.slice(0, shown.length), pointerX);
  const focus = dockFocus(scales);
  const offsets = dockOffsets(restCenters.current.slice(0, shown.length), scales, restWidth.current);
  return (
    <button
      type="button"
      className="oc-presence"
      onClick={onOpen}
      onMouseEnter={(e) => {
        const strip = e.currentTarget.getBoundingClientRect();
        stripLeft.current = strip.left;
        restCenters.current = faceRefs.current.slice(0, shown.length).map((el) => {
          const r = el?.getBoundingClientRect();
          return r ? r.left + r.width / 2 - strip.left : Number.NaN;
        });
        restWidth.current = faceRefs.current[0]?.getBoundingClientRect().width || 20;
        setPointerX(e.clientX - strip.left);
      }}
      onMouseMove={(e) => setPointerX(e.clientX - stripLeft.current)}
      onMouseLeave={() => setPointerX(null)}
      aria-label={m.conversation_presence_aria({
        people: people.length,
        agents: agents.length,
      })}
    >
      {shown.map((f, i) =>
        f.kind === "person" ? (
          <span
            key={f.key}
            ref={(el) => {
              faceRefs.current[i] = el;
            }}
            className={`oc-presence__face${f.self ? " is-self" : ""}${focus === i ? " is-focus" : ""}`}
            style={{ "--dock-s": scales[i] ?? 1, "--dock-x": `${offsets[i] ?? 0}px` } as CSSProperties}
            data-name={`${f.name} · ${f.role}`}
          >
            <Avatar userId={f.userId} name={f.name} showTitle={false} />
          </span>
        ) : (
          <span
            key={f.key}
            ref={(el) => {
              faceRefs.current[i] = el;
            }}
            className={`oc-presence__face oc-presence__agent${f.primary ? " is-primary" : ""}${focus === i ? " is-focus" : ""}`}
            style={{ "--dock-s": scales[i] ?? 1, "--dock-x": `${offsets[i] ?? 0}px` } as CSSProperties}
            data-name={f.name}
          >
            <GatewayMark kind={f.gateway} size={12} />
            {f.primary ? (
              <Crown size={8} className="oc-presence__crown" aria-hidden />
            ) : null}
          </span>
        ),
      )}
      {hidden.length > 0 ? (
        <span className="oc-presence__more" title={hidden.map((f) => f.name).join("\n")}>
          +{hidden.length}
        </span>
      ) : null}
    </button>
  );
}

export function ConversationPanel({
  chatId,
  routing,
  open,
  onOpenChange,
  tab,
  onTabChange,
  intent,
  onIntentDone,
}: {
  chatId: Id<"chats">;
  routing: ChatRouting | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tab: ConversationTab;
  onTabChange: (tab: ConversationTab) => void;
  intent: ConversationIntent;
  onIntentDone: () => void;
}) {
  const room = useQuery(api.chatAgents.listChatAgents, open ? { chatId } : "skip");
  const members = useQuery(
    api.chatParticipants.listMembers,
    open ? { chatId } : "skip",
  );
  const viewer = room?.viewerRoomRole;
  const agentCount = room ? room.agents.length + (room.primary ? 1 : 0) : 0;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="oc-spanel oc-convpanel">
        <SheetHeader>
          <SheetTitle>{m.conversation_title()}</SheetTitle>
          <SheetDescription>
            {viewer === undefined
              ? ""
              : managesRoom(viewer)
                ? m.conversation_desc_owner()
                : m.conversation_desc_guest({ role: roleLabel(viewer) })}
          </SheetDescription>
        </SheetHeader>
        <div className="oc-spanel__body">
          {room === undefined ? (
            <p className="oc-spanel__loading">{m.common_loading()}</p>
          ) : room === null ? null : (
            <Tabs
              value={tab}
              onValueChange={(v) => onTabChange(v as ConversationTab)}
            >
              <TabsList className="oc-convpanel__tabs">
                <TabsTrigger value="agents">
                  <Bot size={14} aria-hidden /> {m.conversation_tab_agents()}
                  <span className="oc-convpanel__count">{agentCount}</span>
                </TabsTrigger>
                <TabsTrigger value="people">
                  <Users size={14} aria-hidden /> {m.conversation_tab_people()}
                  <span className="oc-convpanel__count">
                    {members?.length ?? ""}
                  </span>
                </TabsTrigger>
              </TabsList>
              <TabsContent value="agents">
                <AgentsTab
                  chatId={chatId}
                  routing={routing}
                  room={room}
                  intent={intent}
                  onIntentDone={onIntentDone}
                />
              </TabsContent>
              <TabsContent value="people">
                <PeopleTab
                  chatId={chatId}
                  viewer={room.viewerRoomRole}
                  authMode={room.authMode}
                  participantIdentity={room.participantIdentity}
                  intent={intent}
                  onIntentDone={onIntentDone}
                  onLeft={() => onOpenChange(false)}
                />
              </TabsContent>
            </Tabs>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

type RoomData = NonNullable<
  ReturnType<typeof useQuery<typeof api.chatAgents.listChatAgents>>
>;

function AgentsTab({
  chatId,
  routing,
  room,
  intent,
  onIntentDone,
}: {
  chatId: Id<"chats">;
  routing: ChatRouting | null;
  room: RoomData;
  intent: ConversationIntent;
  onIntentDone: () => void;
}) {
  const toast = useToast();
  const manages = managesRoom(room.viewerRoomRole);
  const isOwner = room.viewerRoomRole === "owner";
  const [adding, setAdding] = useState(false);
  const [changingPrimary, setChangingPrimary] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => {
    if (intent === "add-agent") {
      setAdding(true);
      onIntentDone();
    } else if (intent === "primary") {
      setChangingPrimary(true);
      onIntentDone();
    }
  }, [intent, onIntentDone]);

  const addable = useQuery(
    api.chatAgents.listAddableAgents,
    adding && manages ? { chatId } : "skip",
  );
  const addAgent = useMutation(api.chatAgents.addChatAgent);
  const removeAgent = useMutation(api.chatAgents.removeChatAgent);
  const rebind = useMutation(api.chats.rebindChatAgent);
  // THE ONE PLACE the primary changes once the conversation has started: the
  // composer only ever picks the next message's agent.
  const setPrimary = useMutation(api.chatAgents.setPrimaryAgent);
  const makePrimary = (a: RoomData["agents"][number]) =>
    void setPrimary({
      chatId,
      instanceName: a.instanceName,
      agentId: a.agentId,
    })
      .then((r) => {
        if (!r.changed && r.reason === "busy") toast.error(m.conversation_primary_busy());
        // A long history is being pinned to the agents that wrote it first (a few
        // scheduled batches); the change is made when asked again.
        if (!r.changed && r.reason === "preparing") toast.error(m.conversation_primary_preparing());
      })
      .catch((err: unknown) => {
        const raw = err instanceof Error ? err.message : String(err);
        toast.error(
          raw.includes("TALK_CALL_ACTIVE")
            ? m.chat_agent_select_call_hint()
            : m.conversation_failed(),
        );
      });
  const meta = useQuery(
    api.messages.getSessionMeta,
    isOwner ? { chatId } : "skip",
  );
  const sm = (meta?.sessionMeta ?? null) as SessionMetaView | null;
  const settings = (meta?.sessionSettings ?? null) as SessionSettingsView;
  const emptyThread = routing?.emptyThread === true;
  const primaryCandidates = useMemo(
    () =>
      (routing?.pool ?? []).filter(
        (a) => a.state !== "deleted" && !agentRefEquals(a, room.primary),
      ),
    [routing?.pool, room.primary],
  );

  const failed = (err: unknown): never => {
    const raw = err instanceof Error ? err.message : String(err);
    const limit = /chat_agents_limit:(\d+)/.exec(raw);
    toast.error(
      limit !== null
        ? m.conversation_agents_limit({ count: Number(limit[1]) })
        : m.conversation_failed(),
    );
    throw err;
  };

  const row = (a: RoomData["agents"][number], primary: boolean) => (
    <li
      key={`${a.instanceName}/${a.agentId}`}
      className={`oc-convpanel__member${a.gone ? " is-gone" : ""}`}
    >
      <AgentFace agent={a} />
      <span className="oc-convpanel__who">
        <span className="oc-convpanel__name">
          {agentName(a)}
          {primary ? (
            <Crown
              size={12}
              className="oc-convpanel__crown"
              aria-label={m.conversation_primary_title()}
            >
              <title>{m.conversation_primary_title()}</title>
            </Crown>
          ) : null}
          {a.gone ? (
            <span className="oc-convpanel__badge is-warn">
              {m.conversation_agent_gone()}
            </span>
          ) : !a.usable ? (
            <span className="oc-convpanel__badge is-muted">
              {m.conversation_agent_not_usable()}
            </span>
          ) : null}
        </span>
        <span className="oc-convpanel__sub">
          <Server size={10} aria-hidden /> {a.instanceName}
          {a.model ? ` · ${a.model}` : ""}
        </span>
      </span>
      {!primary && manages ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={m.conversation_actions()}
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {isOwner && a.usable && !a.gone ? (
              <DropdownMenuItem onSelect={() => makePrimary(a)}>
                <Crown aria-hidden />
                {m.conversation_primary_make()}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              variant="destructive"
              onSelect={() =>
                void removeAgent({
                  chatId,
                  instanceName: a.instanceName,
                  agentId: a.agentId,
                }).catch(() => toast.error(m.conversation_failed()))
              }
            >
              {m.conversation_agent_remove()}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </li>
  );

  return (
    <div className="oc-convpanel__tab">
      <ul className="oc-convpanel__members">
        {room.primary ? row(room.primary, true) : null}
        {room.agents.map((a) => row(a, false))}
      </ul>

      {isOwner && room.primary ? (
        emptyThread ? (
          primaryCandidates.length > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              className="oc-convpanel__link"
              onClick={() => setChangingPrimary(true)}
            >
              {m.conversation_primary_change()}
            </Button>
          ) : null
        ) : (
          <p className="oc-convpanel__hint">{m.conversation_primary_how()}</p>
        )
      ) : null}

      {isOwner && sm ? (
        <div className="oc-convpanel__settings">
          <button
            type="button"
            className="oc-convpanel__disclosure"
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen((o) => !o)}
          >
            {settingsOpen ? (
              <ChevronDown size={14} aria-hidden />
            ) : (
              <ChevronRight size={14} aria-hidden />
            )}
            {m.conversation_primary_settings()}
          </button>
          {settingsOpen ? (
            <div className="oc-convpanel__knobs">
              <SessionKnobsGroup chatId={chatId} sm={sm} settings={settings} />
            </div>
          ) : null}
        </div>
      ) : null}

      {manages ? (
        <Button
          variant="outline"
          size="sm"
          className="oc-convpanel__add"
          disabled={room.agents.length >= room.limit}
          onClick={() => setAdding(true)}
        >
          <Plus size={14} aria-hidden />
          {m.conversation_agent_add()}
          <span className="oc-convpanel__count">
            {room.agents.length}/{room.limit}
          </span>
        </Button>
      ) : null}

      <p className="oc-convpanel__hint">{m.conversation_agents_note()}</p>

      <PickerDialog<AgentLike>
        open={adding}
        onOpenChange={setAdding}
        title={m.conversation_agent_add()}
        description={m.conversation_agent_add_desc()}
        items={manages ? addable : []}
        keyOf={(a) => `${a.instanceName}/${a.agentId}`}
        searchFields={(a) => [
          a.displayName,
          a.agentId,
          a.instanceName,
          a.description,
        ]}
        render={(a) => (
          <>
            <AgentFace agent={a} />
            <span className="oc-convpanel__who">
              <span className="oc-convpanel__name">{agentName(a)}</span>
              <span className="oc-convpanel__sub">
                <Server size={10} aria-hidden /> {a.instanceName}
                {a.description ? ` · ${a.description}` : ""}
              </span>
            </span>
          </>
        )}
        actionLabel={m.conversation_add()}
        onPick={(a) =>
          addAgent({
            chatId,
            instanceName: a.instanceName,
            agentId: a.agentId,
          }).catch(failed)
        }
        empty={m.conversation_agent_none_to_add()}
      />

      <PickerDialog<AgentLike>
        open={changingPrimary}
        onOpenChange={setChangingPrimary}
        title={m.conversation_primary_change()}
        description={m.conversation_primary_change_desc()}
        items={primaryCandidates}
        keyOf={(a) => `${a.instanceName}/${a.agentId}`}
        searchFields={(a) => [a.displayName, a.agentId, a.instanceName]}
        render={(a) => (
          <>
            <AgentFace agent={a} />
            <span className="oc-convpanel__who">
              <span className="oc-convpanel__name">{agentName(a)}</span>
              <span className="oc-convpanel__sub">
                <Server size={10} aria-hidden /> {a.instanceName}
              </span>
            </span>
          </>
        )}
        actionLabel={m.conversation_choose()}
        closeOnPick
        onPick={(a) =>
          rebind({
            chatId,
            instanceName: a.instanceName,
            agentId: a.agentId,
          }).catch((err: unknown) => {
            toast.error(m.chat_agent_rebind_failed());
            throw err;
          })
        }
        empty={m.conversation_agent_none_to_add()}
      />
    </div>
  );
}

function PeopleTab({
  chatId,
  viewer,
  authMode,
  participantIdentity,
  intent,
  onIntentDone,
  onLeft,
}: {
  chatId: Id<"chats">;
  viewer: RoomRole;
  authMode: "token" | "trusted-proxy" | "mixed" | null;
  participantIdentity: "owner" | "self";
  intent: ConversationIntent;
  onIntentDone: () => void;
  onLeft: () => void;
}) {
  const toast = useToast();
  const manages = managesRoom(viewer);
  const [inviting, setInviting] = useState(false);
  const [inviteRole, setInviteRole] = useState<MemberRole>("member");
  // Bounded by the reader's standing in THIS room (arrivalRoleFor), and reset when
  // the panel is reused for another conversation.
  const arrivalRole = arrivalRoleFor(inviteRole, viewer);
  useEffect(() => {
    setInviteRole("member");
  }, [chatId]);
  useEffect(() => {
    if (intent === "invite") {
      setInviting(true);
      onIntentDone();
    }
  }, [intent, onIntentDone]);
  const members = useQuery(api.chatParticipants.listMembers, { chatId });
  const invitable = useQuery(
    api.chatParticipants.listInvitable,
    inviting && manages ? { chatId } : "skip",
  );
  const addMember = useMutation(api.chatParticipants.addMember);
  const removeMember = useMutation(api.chatParticipants.removeMember);
  const setRole = useMutation(api.chatParticipants.setMemberRole);
  const leave = useMutation(api.chatParticipants.leaveChat);

  const failed = (err: unknown): never => {
    const raw = err instanceof Error ? err.message : String(err);
    const limit = /participants_limit:(\d+)/.exec(raw);
    toast.error(
      limit !== null
        ? m.participants_limit({ count: Number(limit[1]) })
        : m.participants_failed(),
    );
    throw err;
  };

  return (
    <div className="oc-convpanel__tab">
      <ul className="oc-convpanel__members">
        {(members ?? []).map((p) => {
          const target =
            p.roomRole === "owner" ? null : (p.roomRole as MemberRole);
          const options =
            target === null ? [] : assignableRoles(viewer, target, p.isSelf);
          const removable = mayRemoveMember(viewer, p);
          return (
            <li key={String(p.userId)} className="oc-convpanel__member">
              <Avatar userId={String(p.userId)} name={p.name} />
              <span className="oc-convpanel__who">
                <span className="oc-convpanel__name">
                  {p.name}
                  {p.isSelf ? (
                    <span className="oc-convpanel__you">
                      {m.conversation_you()}
                    </span>
                  ) : null}
                </span>
                {options.length === 0 ? (
                  <span className="oc-convpanel__sub">
                    {roleTitle(p.roomRole)}
                  </span>
                ) : null}
              </span>
              {target !== null && options.length > 0 ? (
                <Select
                  value={target}
                  onValueChange={(v) =>
                    void setRole({
                      chatId,
                      memberId: p.userId,
                      role: v as MemberRole,
                    }).catch(() => toast.error(m.participants_failed()))
                  }
                >
                  <SelectTrigger size="sm" className="oc-convpanel__role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="end">
                    {options.map((r) => (
                      <SelectItem key={r} value={r}>
                        {roleTitle(r)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
              {removable ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={m.conversation_actions()}
                    >
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() =>
                        void removeMember({ chatId, memberId: p.userId }).catch(
                          () => toast.error(m.participants_failed()),
                        )
                      }
                    >
                      {m.participants_remove()}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </li>
          );
        })}
      </ul>

      {manages ? (
        <Button
          variant="outline"
          size="sm"
          className="oc-convpanel__add"
          onClick={() => setInviting(true)}
        >
          <UserPlus size={14} aria-hidden />
          {m.conversation_invite()}
        </Button>
      ) : null}

      <div className="oc-convpanel__callout">
        <ShieldCheck size={14} aria-hidden />
        <div>
          <p className="oc-convpanel__callout-title">
            {authMode === "mixed"
              ? m.conversation_mode_mixed_title()
              : authMode === "trusted-proxy"
                ? m.conversation_mode_proxy_title()
                : m.conversation_mode_token_title()}
          </p>
          <p>
            {authMode === "mixed"
              ? m.conversation_mode_mixed_body()
              : authMode !== "trusted-proxy"
                ? m.conversation_mode_token_body()
                : participantIdentity === "self"
                  ? m.conversation_mode_proxy_self_body()
                  : m.conversation_mode_proxy_body()}
          </p>
          <dl className="oc-convpanel__roles">
            {(["viewer", "member", "manager"] as const).map((r) => (
              <div key={r}>
                <dt>{roleTitle(r)}</dt>
                <dd>{roleHelp(r)}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>

      {viewer !== "owner" ? (
        <Button
          variant="ghost"
          size="sm"
          className="oc-convpanel__leave"
          onClick={() =>
            void leave({ chatId })
              .then(onLeft)
              .catch(() => toast.error(m.participants_failed()))
          }
        >
          <LogOut size={14} aria-hidden />
          {m.participants_leave()}
        </Button>
      ) : null}

      <PickerDialog<{ userId: Id<"users">; name: string }>
        open={inviting}
        onOpenChange={setInviting}
        title={m.conversation_invite()}
        description={m.conversation_invite_desc()}
        items={manages ? invitable : []}
        keyOf={(p) => String(p.userId)}
        searchFields={(p) => [p.name]}
        header={
          <label className="oc-convpicker__role">
            <span>{m.conversation_invite_as()}</span>
            <Select
              value={arrivalRole}
              onValueChange={(v) => setInviteRole(v as MemberRole)}
            >
              <SelectTrigger size="sm" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {invitableRoles(viewer).map((r) => (
                  <SelectItem key={r} value={r}>
                    {roleTitle(r)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        }
        render={(p) => (
          <>
            <Avatar userId={String(p.userId)} name={p.name} />
            <span className="oc-convpanel__who">
              <span className="oc-convpanel__name">{p.name}</span>
            </span>
          </>
        )}
        actionLabel={m.conversation_invite_action()}
        onPick={(p) =>
          addMember({ chatId, memberId: p.userId, role: arrivalRole }).catch(
            failed,
          )
        }
        empty={m.participants_nobody()}
      />
    </div>
  );
}
