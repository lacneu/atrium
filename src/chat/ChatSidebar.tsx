import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { APP_HOST } from "@/lib/appHost";
import { clearSidebarFlash, useSidebarFlash } from "./sidebarFlash";
import { formatDateTime } from "@/lib/format";
import { useMutation, useQuery } from "convex/react";
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  KeyboardSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  restrictToVerticalAxis,
  restrictToFirstScrollableAncestor,
} from "@dnd-kit/modifiers";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ChevronDown,
  ChevronRight,
  GripVertical,
  MoreVertical,
  Pin,
  PinOff,
  Pencil,
  Trash2,
  FolderPlus,
  Lock,
  Plus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EntitySheet } from "./admin/EntitySheet";
import { Input } from "@/components/ui/input";
import { useConfirm, usePrompt } from "@/components/ConfirmDialog";
import { api } from "./convexApi";
import type { Id } from "./convexApi";
import { relativeAge } from "./relativeAge";
import { m } from "@/paraglide/messages.js";

// Preset chat colors (token-driven, list display only). Value matches the
// backend `chatColorValidator`. The dot uses oklch hues that read in both modes.
const CHAT_COLORS: { value: string; hue: string }[] = [
  // Each preset reads its charte variable (declared in convexChat.css, per
  // mode) with the historical oklch as fallback — a charte can re-theme the
  // whole sidebar palette without touching code.
  { value: "red", hue: "var(--oc-accent-red, oklch(0.63 0.21 25))" },
  { value: "orange", hue: "var(--oc-accent-orange, oklch(0.7 0.17 50))" },
  { value: "amber", hue: "var(--oc-accent-amber, oklch(0.8 0.15 85))" },
  { value: "green", hue: "var(--oc-accent-green, oklch(0.7 0.16 150))" },
  { value: "teal", hue: "var(--oc-accent-teal, oklch(0.7 0.12 190))" },
  { value: "blue", hue: "var(--oc-accent-blue, oklch(0.62 0.19 250))" },
  { value: "violet", hue: "var(--oc-accent-violet, oklch(0.6 0.2 300))" },
  { value: "pink", hue: "var(--oc-accent-pink, oklch(0.7 0.2 350))" },
];
const colorHue = (c: string | null | undefined) =>
  CHAT_COLORS.find((x) => x.value === c)?.hue ?? null;

// Stable AUTO hue for a project without a chosen color: hash its id into the
// preset palette so every folder is distinguishable at a glance without any
// setup, and keeps ITS hue across sessions. Exported for tests.
export function autoProjectHue(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return CHAT_COLORS[h % CHAT_COLORS.length]!.hue;
}
const projectHue = (p: { _id: string; color?: string | null }): string =>
  colorHue(p.color) ?? autoProjectHue(p._id);

// Droppable id scheme: a chat may be dropped onto a project section
// ("project:<id>") or the no-project section ("project:none"). Reorder within a
// section is detected when `over` is another chat id.
const NO_PROJECT = "project:none";
const projDropId = (pid: string) => `project:${pid}`;
// Sortable id of a project HEADER (folder reorder) — distinct from the
// section's droppable id so a dragged chat and a dragged folder never collide.
const PROJ_HEAD = "projhead:";
const projHeadId = (pid: string) => `${PROJ_HEAD}${pid}`;
const COLLAPSE_KEY = "oc.noproject.collapsed";

export type ChatRow = {
  _id: Id<"chats">;
  title?: string;
  projectId: Id<"projects"> | null;
  sortKey: number;
  pinned: boolean;
  color: string | null;
  updatedAt: number; // for the compact relative-age label (gated by showChatAge)
  // When the last COMPLETED assistant reply landed (stream.finalize stamp).
  // Crossed with chatReads.lastSeenAt for the unread dot + arrival flash/sound.
  lastAssistantAt: number | null;
  // The bridge this chat routes to (bound instance, else the user's default).
  // Drives the self-hiding provider badge (shown only when chats span >1 kind).
  providerKind: "openclaw" | "hermes" | null;
  // The chat is bound to an agent the user is no longer entitled to (admin
  // narrowed their set) -> READ-ONLY. Marks the row with a lock so the user
  // understands why that chat can't be sent to.
  readOnly: boolean;
};
type Project = {
  _id: Id<"projects">;
  name: string;
  collapsed: boolean;
  color: string | null;
  sortKey: number;
};

// Skeleton rows shown in place of the chat list while it first loads, so the
// sidebar takes shape immediately instead of flashing an empty pane. Exported so
// the boot app-shell (AppShellSkeleton) reuses the exact same rows.
export function ChatListSkeleton() {
  return (
    <div className="oc-sidebar__skeleton" aria-hidden="true">
      {Array.from({ length: 7 }).map((_, i) => (
        <div key={i} className="oc-skel oc-skel--row" />
      ))}
    </div>
  );
}

export function ChatSidebar({
  activeChatId,
  onSelect,
  onNewChat,
  newChatShortcut,
}: {
  activeChatId: Id<"chats"> | null;
  onSelect: (id: Id<"chats">) => void;
  // New-chat orchestration lives in the persistent chrome (so the global
  // shortcut works everywhere); the sidebar button just triggers it and shows
  // the platform-aware shortcut badge.
  onNewChat: () => void;
  newChatShortcut: string;
}) {
  const chats = useQuery(api.messages.listChats, {}) as ChatRow[] | undefined;
  const projects = useQuery(api.projects.listProjects, {}) as
    | Project[]
    | undefined;
  const effectivePrefs = useQuery(api.me.getMe, { host: APP_HOST })?.ui?.effective as
    | Record<string, boolean>
    | undefined;
  const showAgePref = effectivePrefs?.showChatAge ?? true;

  // --- Multi-chat unread dots (DISPLAY only) ---------------------------------
  // chatReads = the user's per-chat "last seen" map (its OWN light query so the
  // hot listChats gains no reads). Unread = lastAssistantAt beyond lastSeenAt;
  // a chat with NO read row shows no dot (quiet adoption — no wall of stale
  // dots on first deploy). The ACTIVE chat never dots. The arrival DETECTION
  // (flash / sound / mark-seen) lives in ChatArrivalWatcher, mounted in the
  // persistent chrome — this sidebar unmounts when collapsed or in Settings.
  const reads = useQuery(api.chatReads.myChatReads, {}) as
    | { chatId: Id<"chats">; lastSeenAt: number }[]
    | undefined;
  const readsMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of reads ?? []) map.set(r.chatId, r.lastSeenAt);
    return map;
  }, [reads]);
  // Chats with a turn IN FLIGHT right now (streamingText-backed, reactive from
  // "thinking" to the last token) — powers the per-row pulse and the folded-
  // folder aggregate.
  const busyList = useQuery(api.chatReads.myBusyChats, {}) as
    | Id<"chats">[]
    | undefined;
  const busyIds = useMemo(() => new Set(busyList ?? []), [busyList]);
  const unreadIds = useMemo(() => {
    const set = new Set<string>();
    for (const c of chats ?? []) {
      if (c._id === activeChatId) continue;
      const seen = readsMap.get(c._id);
      if (seen !== undefined && c.lastAssistantAt !== null && c.lastAssistantAt > seen) {
        set.add(c._id);
      }
    }
    return set;
  }, [chats, readsMap, activeChatId]);

  // The relative-age labels read `Date.now()` at render — without a tick an idle
  // session would freeze a chat at "maintenant". Re-render on a minute cadence so
  // the ages advance. Only armed when the age labels are actually shown.
  const [minuteTick, setMinuteTick] = useState(0);
  useEffect(() => {
    if (!showAgePref) return;
    const id = window.setInterval(() => setMinuteTick((t) => t + 1), 60_000);
    return () => window.clearInterval(id);
  }, [showAgePref]);
  const createProject = useMutation(api.projects.createProject);
  const setProjectCollapsed = useMutation(api.projects.setProjectCollapsed);
  const reorderChat = useMutation(api.chats.reorderChat);
  const reorderProject = useMutation(api.projects.reorderProject);
  const moveToProject = useMutation(api.chats.moveChatToProject);
  const prompt = usePrompt();

  // Responsive new-chat toolbar. The sidebar width is user-resizable AND the
  // button text is localized, so a fixed px breakpoint would clip a long locale
  // (German "Neue Unterhaltung") or collapse a short one too early. Instead we
  // MEASURE: two hidden, absolutely-positioned ghosts render the row at its
  // natural width (with badge / without badge); a ResizeObserver on the toolbar
  // compares the available width to those measured requirements and degrades
  // gracefully — drop the decorative shortcut badge first, then collapse the
  // label to an icon. This keeps the "Nouveau projet" button from ever being
  // pushed off-screen, in any language. (The CSS backstop below guarantees that
  // even before the observer runs.)
  const newChatLabel = m.sidebar_new_chat();
  const topRef = useRef<HTMLDivElement>(null);
  const ghostFullRef = useRef<HTMLDivElement>(null);
  const ghostLabelRef = useRef<HTMLDivElement>(null);
  const [topMode, setTopMode] = useState<"full" | "label" | "icon">("full");
  useLayoutEffect(() => {
    const top = topRef.current;
    if (!top) return;
    const measure = () => {
      const avail = top.clientWidth;
      const reqFull = ghostFullRef.current?.offsetWidth ?? 0;
      const reqLabel = ghostLabelRef.current?.offsetWidth ?? 0;
      // Ghosts not laid out yet → stay full (avoids a spurious collapse at 0).
      const next =
        reqFull === 0 || avail >= reqFull
          ? "full"
          : avail >= reqLabel
            ? "label"
            : "icon";
      setTopMode((prev) => (prev === next ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(top);
    return () => ro.disconnect();
    // Re-measure when the localized label or platform badge changes width.
  }, [newChatLabel, newChatShortcut]);

  // Transient local buffer: Convex is the source of truth; during a drag (and
  // until the write confirms) we render the local arrangement so the item does
  // not snap back. Re-sync from the query whenever no write is pending.
  const [buffer, setBuffer] = useState<ChatRow[] | null>(null);
  const pendingRef = useRef(false);
  useEffect(() => {
    if (!pendingRef.current && chats) setBuffer(chats);
  }, [chats]);
  const rows = buffer ?? chats ?? [];
  // First load: the query hasn't resolved AND nothing is buffered yet -> show a
  // skeleton list instead of an empty pane, so the sidebar takes shape immediately.
  const isLoading = chats === undefined && buffer === null;

  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [noProjectCollapsed, setNoProjectCollapsed] = useState(
    () => localStorage.getItem(COLLAPSE_KEY) === "1",
  );
  function toggleNoProject() {
    setNoProjectCollapsed((c) => {
      localStorage.setItem(COLLAPSE_KEY, c ? "0" : "1");
      return !c;
    });
  }

  // A BRANCH landing flash (chatFork) must be visible even when its section is
  // FOLDED: the row only mounts — and pulses/scrolls — once its group renders,
  // so expand the section holding the flashed chat first (the flash is now the
  // primary way the user locates the new conversation).
  const flash = useSidebarFlash();
  useEffect(() => {
    // Only "locate me" flashes (a branch landed) may unfold — an ARRIVAL flash
    // in a folder the user folded must leave it folded (the aggregate dot and
    // pulse on the folder header carry the signal there).
    if (!flash?.expand) return;
    const target = rows.find((c) => c._id === flash.chatId);
    if (!target) return; // not delivered by the live list yet — retriggers then
    const pid = target.projectId ?? null;
    if (pid === null) {
      if (noProjectCollapsed) {
        localStorage.setItem(COLLAPSE_KEY, "0");
        setNoProjectCollapsed(false);
      }
      return;
    }
    const proj = (projects ?? []).find((p) => p._id === pid);
    if (proj?.collapsed) {
      void setProjectCollapsed({ projectId: pid, collapsed: false });
    }
  }, [flash, rows, projects, noProjectCollapsed, setProjectCollapsed]);

  // GRAB-ANYWHERE rows/headers (no visible grip): the whole surface drags.
  // Mouse needs 4px of travel before a drag starts (a plain click stays a
  // click); touch needs a LONG-PRESS (250ms) so vertical swipes keep
  // scrolling the list instead of picking rows up.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 250, tolerance: 8 },
    }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // After a REAL drag (activated → ended/cancelled), the browser still fires a
  // click on whatever sits under the pointer — without this guard, dropping a
  // row would also OPEN it (or toggle the folder). Armed on drag end, cleared
  // on the next macrotask (the synthetic click fires before that); keyboard
  // drags simply see the flag expire unused.
  const suppressClickRef = useRef(false);
  const armClickSuppression = () => {
    suppressClickRef.current = true;
    setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
  };

  // A dragged FOLDER only measures against the other folder headers: the
  // sections then slide apart to preview the drop slot (the same live preview
  // chat rows get), and chats/sections never become the "over" target — which
  // also keeps every chat row transform-free (no per-move row re-renders).
  const collisionDetection = useCallback<CollisionDetection>((args) => {
    if (String(args.active.id).startsWith(PROJ_HEAD)) {
      return closestCorners({
        ...args,
        droppableContainers: args.droppableContainers.filter((c) =>
          String(c.id).startsWith(PROJ_HEAD),
        ),
      });
    }
    return closestCorners(args);
  }, []);

  const pinned = rows.filter((c) => c.pinned);
  const unpinned = rows.filter((c) => !c.pinned);
  const byProject = (pid: string | null) =>
    unpinned.filter((c) => (c.projectId ?? null) === pid);

  function findChat(id: string) {
    return rows.find((c) => c._id === id);
  }

  async function handleDragEnd(e: DragEndEvent) {
    setActiveDragId(null);
    armClickSuppression();
    const { active, over } = e;
    if (!over) return;
    const activeId = String(active.id);
    const overId = String(over.id);

    // Case 0: a FOLDER header is being reordered. The drop target resolves to
    // a project whichever element it lands on (another header, a project
    // section, or a chat inside one); outside any project it is a no-op.
    if (activeId.startsWith(PROJ_HEAD)) {
      const movedId = activeId.slice(PROJ_HEAD.length) as Id<"projects">;
      const list = projects ?? [];
      let targetId: string | null = null;
      if (overId.startsWith(PROJ_HEAD)) targetId = overId.slice(PROJ_HEAD.length);
      else if (overId.startsWith("project:") && overId !== NO_PROJECT)
        targetId = overId.slice("project:".length);
      else {
        // A PINNED chat renders outside any project section but silently keeps
        // its projectId — using it here would reorder toward an invisible
        // target. Only unpinned rows (visually inside their folder) resolve.
        const overChat = findChat(overId);
        targetId =
          overChat && !overChat.pinned ? (overChat.projectId ?? null) : null;
      }
      if (targetId === null || targetId === movedId) return;
      const from = list.findIndex((p) => p._id === movedId);
      const to = list.findIndex((p) => p._id === targetId);
      if (from < 0 || to < 0) return;
      const reordered = [...list];
      const [movedProj] = reordered.splice(from, 1);
      reordered.splice(to, 0, movedProj);
      const prev = reordered[to - 1] ?? null;
      const next = reordered[to + 1] ?? null;
      await reorderProject({
        projectId: movedId,
        prevKey: prev ? prev.sortKey : null,
        nextKey: next ? next.sortKey : null,
      });
      return;
    }

    const moved = findChat(activeId);
    if (!moved) return;

    // Case 1: dropped onto a section container (assign to project). A drop on
    // a folder HEADER counts as dropping into that folder.
    if (overId.startsWith(PROJ_HEAD)) {
      const destProject = overId.slice(PROJ_HEAD.length) as Id<"projects">;
      if ((moved.projectId ?? null) === destProject) return;
      pendingRef.current = true;
      setBuffer((b) =>
        (b ?? rows).map((c) =>
          c._id === moved._id ? { ...c, projectId: destProject } : c,
        ),
      );
      try {
        await moveToProject({ chatId: moved._id, projectId: destProject });
      } finally {
        pendingRef.current = false;
      }
      return;
    }
    if (overId.startsWith("project:")) {
      const destProject =
        overId === NO_PROJECT
          ? null
          : (overId.slice("project:".length) as Id<"projects">);
      if ((moved.projectId ?? null) === destProject) return;
      pendingRef.current = true;
      setBuffer((b) =>
        (b ?? rows).map((c) =>
          c._id === moved._id ? { ...c, projectId: destProject } : c,
        ),
      );
      try {
        await moveToProject({ chatId: moved._id, projectId: destProject });
      } finally {
        pendingRef.current = false;
      }
      return;
    }

    // Case 2: dropped onto another chat = reorder within that chat's section.
    const target = findChat(overId);
    if (!target || active.id === over.id) return;
    // If the target is in a different project, treat as an assign (drop-at-top).
    if ((target.projectId ?? null) !== (moved.projectId ?? null) ||
        target.pinned !== moved.pinned) {
      if (moved.pinned || target.pinned) return; // don't cross the pinned boundary
      pendingRef.current = true;
      setBuffer((b) =>
        (b ?? rows).map((c) =>
          c._id === moved._id
            ? { ...c, projectId: target.projectId ?? null }
            : c,
        ),
      );
      try {
        await moveToProject({
          chatId: moved._id,
          projectId: target.projectId ?? null,
        });
      } finally {
        pendingRef.current = false;
      }
      return;
    }
    // Same section reorder: fractional key between neighbours of the drop slot.
    const scope = target.pinned
      ? pinned
      : byProject(target.projectId ?? null);
    const ids = scope.map((c) => c._id);
    const from = ids.indexOf(moved._id);
    const to = ids.indexOf(target._id);
    if (from < 0 || to < 0) return;
    const reordered = [...scope];
    reordered.splice(from, 1);
    reordered.splice(to, 0, moved);
    const prev = reordered[to - 1] ?? null;
    const next = reordered[to + 1] ?? null;
    pendingRef.current = true;
    setBuffer((b) => {
      const base = b ?? rows;
      const rest = base.filter((c) => !scope.some((s) => s._id === c._id));
      return [...rest, ...reordered];
    });
    try {
      await reorderChat({
        chatId: moved._id,
        prevKey: prev ? prev.sortKey : null,
        nextKey: next ? next.sortKey : null,
      });
    } finally {
      pendingRef.current = false;
    }
  }

  const activeChat = activeDragId ? findChat(activeDragId) : null;

  return (
    <aside className="oc-sidebar">
      <div className="oc-sidebar__top" ref={topRef}>
        <Button
          className={
            topMode === "icon"
              ? "oc-newchat flex-1 justify-center"
              : "oc-newchat flex-1 justify-start"
          }
          onClick={onNewChat}
          title={`${newChatLabel} (${newChatShortcut})`}
          aria-label={newChatLabel}
        >
          <Plus />
          {topMode !== "icon" ? (
            <span className="oc-newchat__label">{newChatLabel}</span>
          ) : null}
          {topMode === "full" ? (
            <kbd className="oc-newchat__kbd" aria-hidden>
              {newChatShortcut}
            </kbd>
          ) : null}
        </Button>
        {/* Hidden measurers: the row at natural width, with and without the
            badge. The wrapper is clipped (height 0, overflow hidden) so it adds
            no scrollable area; the inner row keeps `width: max-content` so its
            offsetWidth is the true required width — always full, so the numbers
            stay accurate regardless of the current compact state (no
            hysteresis). */}
        <div className="oc-newchat-ghost" aria-hidden>
          <div className="oc-newchat-ghost__row" ref={ghostFullRef}>
            <Button className="oc-newchat justify-start" tabIndex={-1}>
              <Plus />
              <span className="oc-newchat__label">{newChatLabel}</span>
              <kbd className="oc-newchat__kbd">{newChatShortcut}</kbd>
            </Button>
            <Button variant="outline" size="icon" tabIndex={-1}>
              <FolderPlus />
            </Button>
          </div>
        </div>
        <div className="oc-newchat-ghost" aria-hidden>
          <div className="oc-newchat-ghost__row" ref={ghostLabelRef}>
            <Button className="oc-newchat justify-start" tabIndex={-1}>
              <Plus />
              <span className="oc-newchat__label">{newChatLabel}</span>
            </Button>
            <Button variant="outline" size="icon" tabIndex={-1}>
              <FolderPlus />
            </Button>
          </div>
        </div>
        <Button
          className="oc-newproject"
          variant="outline"
          size="icon"
          aria-label={m.sidebar_new_project()}
          title={m.sidebar_new_project()}
          onClick={async () => {
            const name = await prompt({
              title: m.sidebar_new_project(),
              label: m.sidebar_project_name_label(),
              placeholder: m.sidebar_project_name_placeholder(),
              confirmLabel: m.sidebar_create(),
            });
            if (name) await createProject({ name });
          }}
        >
          <FolderPlus />
        </Button>
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
        onDragStart={(e: DragStartEvent) => setActiveDragId(String(e.active.id))}
        onDragCancel={() => {
          setActiveDragId(null);
          armClickSuppression();
        }}
        onDragEnd={handleDragEnd}
      >
        <div className="oc-sidebar__scroll">
          {isLoading ? (
            <ChatListSkeleton />
          ) : (
          <>
          {pinned.length > 0 ? (
            <Section label={m.sidebar_pinned()} chats={pinned}>
              {pinned.map((c) => (
                <ChatItem
                  key={c._id}
                  chat={c}
                  active={c._id === activeChatId}
                  unread={unreadIds.has(c._id)}
                  busy={busyIds.has(c._id)}
                  ageTick={minuteTick}
                  suppressClick={suppressClickRef}
                  onSelect={onSelect}
                />
              ))}
            </Section>
          ) : null}

          <SortableContext
            items={(projects ?? []).map((p) => projHeadId(p._id))}
            strategy={verticalListSortingStrategy}
          >
          {(projects ?? []).map((p) => {
            const ch = byProject(p._id);
            return (
              <Section
                key={p._id}
                label={p.name}
                dropId={projDropId(p._id)}
                sortId={projHeadId(p._id)}
                suppressClick={suppressClickRef}
                projectId={p._id}
                project={p}
                chats={ch}
                collapsible
                collapsed={p.collapsed}
                busy={ch.some((c) => busyIds.has(c._id))}
                unread={ch.some((c) => unreadIds.has(c._id))}
                onToggle={() =>
                  void setProjectCollapsed({
                    projectId: p._id,
                    collapsed: !p.collapsed,
                  })
                }
              >
                {p.collapsed ? null : ch.length === 0 ? (
                  <div className="oc-sidebar__empty">{m.sidebar_drop_chat_here()}</div>
                ) : (
                  ch.map((c) => (
                    <ChatItem
                      key={c._id}
                      chat={c}
                      active={c._id === activeChatId}
                      unread={unreadIds.has(c._id)}
                      busy={busyIds.has(c._id)}
                      ageTick={minuteTick}
                      suppressClick={suppressClickRef}
                      onSelect={onSelect}
                    />
                  ))
                )}
              </Section>
            );
          })}
          </SortableContext>

          <Section
            label={m.sidebar_chats()}
            dropId={NO_PROJECT}
            chats={byProject(null)}
            collapsible
            collapsed={noProjectCollapsed}
            busy={byProject(null).some((c) => busyIds.has(c._id))}
            unread={byProject(null).some((c) => unreadIds.has(c._id))}
            onToggle={toggleNoProject}
          >
            {!noProjectCollapsed
              ? byProject(null).map((c) => (
                  <ChatItem
                    key={c._id}
                    chat={c}
                    active={c._id === activeChatId}
                    unread={unreadIds.has(c._id)}
                    busy={busyIds.has(c._id)}
                    ageTick={minuteTick}
                    suppressClick={suppressClickRef}
                    onSelect={onSelect}
                  />
                ))
              : null}
          </Section>
          </>
          )}
        </div>

        <DragOverlay>
          {activeDragId?.startsWith(PROJ_HEAD)
            ? (() => {
                const p = (projects ?? []).find(
                  (x) => projHeadId(x._id) === activeDragId,
                );
                if (!p) return null;
                return (
                  <div
                    className="oc-sidebar__group-head oc-chatitem--overlay"
                    style={{ "--proj-hue": projectHue(p) } as React.CSSProperties}
                  >
                    <ChevronDown className="size-3.5 shrink-0 oc-sidebar__group-chev" />
                    <span className="oc-sidebar__group-label">{p.name}</span>
                  </div>
                );
              })()
            : null}
          {activeChat ? (
            <div className="oc-chatitem oc-chatitem--overlay">
              {colorHue(activeChat.color) ? (
                <span
                  className="oc-chatitem__dot"
                  style={{ background: colorHue(activeChat.color)! }}
                />
              ) : (
                <span className="oc-chatitem__dot oc-chatitem__dot--empty" />
              )}
              <span className="oc-chatitem__label">
                {activeChat.title || m.sidebar_untitled()}
              </span>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </aside>
  );
}

// A sidebar section. When `dropId` is set it is a droppable assignment target
// (project sections + the no-project "Chats" section), so a chat can be dragged
// in even when the section is empty. The pinned section has no dropId.
function Section({
  label,
  dropId,
  sortId,
  suppressClick,
  projectId,
  project,
  chats,
  collapsible,
  collapsed,
  busy,
  unread,
  onToggle,
  children,
}: {
  label: string;
  dropId?: string;
  // Sortable id of the folder header (projects only) — enables folder reorder.
  sortId?: string;
  // Post-drag click guard from the DndContext owner (see armClickSuppression).
  suppressClick?: React.MutableRefObject<boolean>;
  projectId?: Id<"projects">;
  project?: Project;
  chats: ChatRow[];
  collapsible?: boolean;
  collapsed?: boolean;
  // Aggregates over the section's chats — surfaced on the HEADER when the
  // section is folded, so an in-flight turn / unseen reply is never hidden.
  busy?: boolean;
  unread?: boolean;
  onToggle?: () => void;
  children: React.ReactNode;
}) {
  const deleteProject = useMutation(api.projects.deleteProject);
  const renameProject = useMutation(api.projects.renameProject);
  const setProjectColor = useMutation(api.projects.setProjectColor);
  const confirm = useConfirm();
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState(label);
  const count = useQuery(
    api.projects.projectChatCount,
    projectId ? { projectId } : "skip",
  ) as number | undefined;
  const { setNodeRef, isOver } = useDroppable({ id: dropId ?? `static:${label}` });
  // Folder reorder: the WHOLE section is the sortable node (so dragging the
  // header moves the folder with its rows), but only the header grip carries
  // the listeners — rows keep their own drag behaviour.
  const sortable = useSortable({
    id: sortId ?? `static-sort:${label}`,
    disabled: !sortId,
  });
  // GRAB-ANYWHERE: pointer listeners go on the whole HEADER; the keyboard
  // activator stays on a visually-hidden focusable button (drag stays
  // reachable by Tab + Space/arrows without a visible grip eating width).
  const { onKeyDown: sortKeyDown, ...sortPointer } = (sortable.listeners ??
    {}) as { onKeyDown?: React.KeyboardEventHandler } & Record<string, unknown>;

  // The toggle area is a clickable div (role=button) — NOT a <button> — so the
  // project-actions <button> can live inside it without nesting buttons
  // (invalid HTML / hydration error).
  const onKeyToggle = (e: React.KeyboardEvent) => {
    // Only when the HEADER itself is focused: Space/Enter on a nested control
    // (the reorder grip, the actions menu) bubbles here and must not also
    // fold/unfold the folder mid-interaction.
    if (e.target !== e.currentTarget) return;
    if (collapsible && onToggle && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      onToggle();
    }
  };
  // The folder's tint: chosen preset, else a stable auto hue. Applied as a CSS
  // variable so the rail/dot/pulse all derive from ONE value the charte can
  // re-theme (the presets themselves read --oc-accent-* variables).
  const hue = project ? projectHue(project) : null;

  return (
    <div
      ref={(el) => {
        if (dropId) setNodeRef(el);
        if (sortId) sortable.setNodeRef(el);
      }}
      className={
        "oc-sidebar__group" +
        (isOver ? " oc-sidebar__group--over" : "") +
        (project ? " oc-sidebar__group--project" : "")
      }
      style={{
        ...(hue ? ({ "--proj-hue": hue } as React.CSSProperties) : {}),
        ...(sortId
          ? {
              transform: CSS.Transform.toString(sortable.transform),
              transition: sortable.transition,
              opacity: sortable.isDragging ? 0.35 : 1,
            }
          : {}),
      }}
    >
      <div
        className={
          "oc-sidebar__group-head group/head" +
          (collapsible ? " oc-sidebar__group-head--btn" : "")
        }
        {...(collapsible
          ? {
              role: "button",
              tabIndex: 0,
              // Post-drag guard: dropping the folder must not also toggle it.
              onClick: () => {
                if (suppressClick?.current) return;
                onToggle?.();
              },
              onKeyDown: onKeyToggle,
            }
          : {})}
        {...(sortId ? sortPointer : {})}
      >
        {collapsible ? (
          // The chevron doubles as the folder's color carrier (tinted via
          // --proj-hue) — one glyph instead of chevron + swatch, so the NAME
          // starts right after it and keeps the row's width.
          collapsed ? (
            <ChevronRight
              className={
                "size-3.5 shrink-0" + (project ? " oc-sidebar__group-chev" : "")
              }
            />
          ) : (
            <ChevronDown
              className={
                "size-3.5 shrink-0" + (project ? " oc-sidebar__group-chev" : "")
              }
            />
          )
        ) : null}
        <span className="oc-sidebar__group-label">{label}</span>
        {sortId ? (
          <button
            className="oc-drag-a11y"
            aria-label={m.sidebar_reorder()}
            onClick={(e) => e.stopPropagation()}
            {...sortable.attributes}
            onKeyDown={sortKeyDown}
          >
            <GripVertical className="size-3.5" />
          </button>
        ) : null}
        {/* Folded-state signals: an in-flight turn (pulse) and/or an unseen
            reply (dot) somewhere inside. Hidden when open — the rows show
            their own. Order: pulse first (transient), then the dot. */}
        {collapsed && busy ? (
          <span
            className="oc-chatitem__busy"
            title={m.sidebar_folder_busy()}
            aria-label={m.sidebar_folder_busy()}
          />
        ) : null}
        {collapsed && unread ? (
          <span
            className="oc-chatitem__unread"
            title={m.sidebar_unread_reply()}
            aria-label={m.sidebar_unread_reply()}
          />
        ) : null}
        {projectId ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={m.sidebar_project_actions()}
                className="oc-sidebar__group-menu opacity-0 group-hover/head:opacity-100 group-focus-within/head:opacity-100 aria-expanded:opacity-100"
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
                onTouchStart={(e) => e.stopPropagation()}
              >
                <MoreVertical />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="w-48"
              onClick={(e) => e.stopPropagation()}
            >
              <DropdownMenuItem
                onSelect={() => {
                  setRenameValue(label);
                  setRenameOpen(true);
                }}
              >
                <Pencil /> {m.sidebar_rename()}
              </DropdownMenuItem>
              <DropdownMenuLabel>{m.sidebar_color()}</DropdownMenuLabel>
              <div className="oc-colorgrid" onClick={(e) => e.stopPropagation()}>
                <button
                  className="oc-colorgrid__none"
                  onClick={() => void setProjectColor({ projectId, color: null })}
                  aria-label={m.sidebar_no_color()}
                >
                  ✕
                </button>
                {CHAT_COLORS.map((c) => (
                  <button
                    key={c.value}
                    className={
                      "oc-colorgrid__dot" +
                      (project?.color === c.value ? " is-selected" : "")
                    }
                    style={{ background: c.hue }}
                    aria-label={c.value}
                    onClick={() =>
                      void setProjectColor({
                        projectId,
                        color: c.value as never,
                      })
                    }
                  />
                ))}
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => {
                  requestAnimationFrame(async () => {
                    const n = count ?? 0;
                    const ok = await confirm({
                      title: m.sidebar_delete_project_confirm_title({ name: label }),
                      description:
                        n > 0
                          ? m.sidebar_delete_project_confirm_desc({ count: n })
                          : m.sidebar_action_irreversible(),
                      confirmWord: m.sidebar_delete(),
                      confirmLabel: m.sidebar_delete_project(),
                      destructive: true,
                    });
                    if (ok) await deleteProject({ projectId });
                  });
                }}
              >
                <Trash2 /> {m.sidebar_delete()}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      <div className={project && !collapsed ? "oc-sidebar__group-body" : undefined}>
        <SortableContext
          items={chats.map((c) => c._id)}
          strategy={verticalListSortingStrategy}
        >
          {children}
        </SortableContext>
      </div>
      {projectId ? (
        <EntitySheet
          open={renameOpen}
          onOpenChange={setRenameOpen}
          title={m.sidebar_rename_project_title()}
          canSubmit={renameValue.trim().length > 0}
          onSubmit={async () => {
            await renameProject({ projectId, name: renameValue.trim() });
            setRenameOpen(false);
          }}
        >
          <div className="oc-form">
            <label className="oc-field">
              <span className="oc-field__label">{m.sidebar_title_field()}</span>
              <Input
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                autoFocus
              />
            </label>
          </div>
        </EntitySheet>
      ) : null}
    </div>
  );
}


// Memoized: during a folder drag / sidebar resize the rows' props don't
// change, so the row tree skips re-rendering entirely (onSelect is a stable
// useCallback in the chrome; chat objects keep identity between live pushes).
const ChatItem = memo(function ChatItem({
  chat,
  active,
  unread,
  busy,
  suppressClick,
  onSelect,
}: {
  chat: ChatRow;
  active: boolean;
  // A completed reply landed since the user's last visit — subtle dot on the
  // row until the chat is opened (multi-chat switching UX).
  unread: boolean;
  // A turn is in flight on this chat RIGHT NOW — subtle pulse.
  busy: boolean;
  // Minute cadence from the parent: memo would otherwise freeze the relative
  // age label (identical props skip the render, Date.now() never re-reads).
  // Not destructured — its only job is to defeat the memo once a minute.
  ageTick: number;
  // Post-drag click guard from the DndContext owner (see armClickSuppression).
  suppressClick: React.MutableRefObject<boolean>;
  onSelect: (id: Id<"chats">) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: chat._id });
  // GRAB-ANYWHERE: pointer listeners cover the whole row; the keyboard
  // activator lives on a visually-hidden focusable button (see Section).
  const { onKeyDown: dragKeyDown, ...dragPointer } = (listeners ?? {}) as {
    onKeyDown?: React.KeyboardEventHandler;
  } & Record<string, unknown>;
  const renameChat = useMutation(api.chats.renameChat);
  const deleteChat = useMutation(api.chats.deleteChat);
  const pinChat = useMutation(api.chats.pinChat);
  const setColor = useMutation(api.chats.setChatColor);
  // Compact relative age (OpenWebUI-style), gated by the `showChatAge` UI pref.
  // getMe is deduped by Convex across every item — one shared subscription.
  const showAge =
    (
      useQuery(api.me.getMe, { host: APP_HOST })?.ui?.effective as
        | Record<string, boolean>
        | undefined
    )?.showChatAge ?? true;
  const confirm = useConfirm();
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState(chat.title ?? "");
  // One-shot BRANCH flash (chatFork keeps the user in the source chat — this
  // row pulse is how the eye finds where the new conversation landed). Scroll
  // it into view, run the CSS animation once, then clear; the timer fallback
  // covers environments where the animation never runs (reduced motion).
  const flashing = useSidebarFlash()?.chatId === chat._id;
  const rowRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!flashing) return;
    // Instant (not smooth) scroll under prefers-reduced-motion: the CSS pulse
    // is already static there, and a programmatic smooth scroll is exactly the
    // kind of motion the preference asks to avoid.
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    rowRef.current?.scrollIntoView({
      block: "nearest",
      behavior: reduced ? "auto" : "smooth",
    });
    const t = setTimeout(() => clearSidebarFlash(chat._id), 2600);
    return () => clearTimeout(t);
  }, [flashing, chat._id]);

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    // Hide the source row while its DragOverlay clone is shown.
    opacity: isDragging ? 0 : 1,
  };
  const hue = colorHue(chat.color);

  return (
    <>
      <div
        ref={(el) => {
          setNodeRef(el);
          rowRef.current = el;
        }}
        style={style}
        className={
          "oc-chatitem group/row" +
          (active ? " oc-chatitem--active" : "") +
          (flashing ? " oc-chatitem--flash" : "")
        }
        // MAXIMUM click surface: the WHOLE row (age label and badges included)
        // opens the chat; the same surface DRAGS after 4px of travel (mouse) or
        // a long-press (touch). Only the actions menu opts out. Keyboard access
        // stays on the inner label <button>.
        onClick={() => {
          if (suppressClick.current) return; // a drag just ended here
          onSelect(chat._id);
        }}
        {...dragPointer}
        onAnimationEnd={(e) => {
          if (flashing && e.animationName === "oc-chatitem-flash") {
            clearSidebarFlash(chat._id);
          }
        }}
      >
        <button
          className="oc-drag-a11y"
          aria-label={m.sidebar_reorder()}
          onClick={(e) => e.stopPropagation()}
          {...attributes}
          onKeyDown={dragKeyDown}
        >
          <GripVertical className="size-3.5" />
        </button>
        {hue ? (
          <span className="oc-chatitem__dot" style={{ background: hue }} />
        ) : (
          <span className="oc-chatitem__dot oc-chatitem__dot--empty" />
        )}
        <button
          className="oc-chatitem__label"
          onClick={(e) => {
            e.stopPropagation();
            if (suppressClick.current) return; // a drag just ended here
            onSelect(chat._id);
          }}
        >
          {chat.title || m.sidebar_untitled()}
        </button>
        {busy ? (
          <span
            className="oc-chatitem__busy"
            title={m.sidebar_row_busy()}
            aria-label={m.sidebar_row_busy()}
          />
        ) : null}
        {unread ? (
          <span
            className="oc-chatitem__unread"
            title={m.sidebar_unread_reply()}
            aria-label={m.sidebar_unread_reply()}
          />
        ) : null}
        {chat.readOnly ? (
          <span
            className="oc-chatitem__readonly"
            title={m.sidebar_readonly_label()}
          >
            <Lock size={12} aria-label={m.sidebar_readonly_label()} />
          </span>
        ) : null}
        {showAge ? (
          // Visible at rest; fades out on row hover/focus so it never collides
          // with the grip + kebab that fade in (same swap as OpenWebUI).
          <span
            className="oc-chatitem__age group-hover/row:opacity-0 group-focus-within/row:opacity-0"
            title={formatDateTime(chat.updatedAt)}
          >
            {relativeAge(chat.updatedAt, Date.now())}
          </span>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={m.sidebar_actions()}
              className="opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 aria-expanded:opacity-100"
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
            >
              <MoreVertical />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-48"
            onClick={(e) => e.stopPropagation()}
          >
            <DropdownMenuItem
              onSelect={() => {
                setRenameValue(chat.title ?? "");
                setRenameOpen(true);
              }}
            >
              <Pencil /> {m.sidebar_rename()}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => void pinChat({ chatId: chat._id, pinned: !chat.pinned })}
            >
              {chat.pinned ? <PinOff /> : <Pin />}
              {chat.pinned ? m.sidebar_unpin() : m.sidebar_pin()}
            </DropdownMenuItem>

            <DropdownMenuLabel>{m.sidebar_color()}</DropdownMenuLabel>
            <div className="oc-colorgrid" onClick={(e) => e.stopPropagation()}>
              <button
                className="oc-colorgrid__none"
                onClick={() => void setColor({ chatId: chat._id, color: null })}
                aria-label={m.sidebar_no_color()}
              >
                ✕
              </button>
              {CHAT_COLORS.map((c) => (
                <button
                  key={c.value}
                  className={
                    "oc-colorgrid__dot" +
                    (chat.color === c.value ? " is-selected" : "")
                  }
                  style={{ background: c.hue }}
                  aria-label={c.value}
                  onClick={() =>
                    void setColor({ chatId: chat._id, color: c.value as never })
                  }
                />
              ))}
            </div>

            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => {
                // Defer past the menu's close/focus-restore so the dialog's
                // focus scope wins the race (avoids a menu↔dialog focus glitch).
                requestAnimationFrame(async () => {
                  const ok = await confirm({
                    title: m.sidebar_delete_chat_confirm_title(),
                    description: m.sidebar_delete_chat_confirm_desc(),
                    confirmLabel: m.sidebar_delete(),
                    destructive: true,
                  });
                  if (ok) await deleteChat({ chatId: chat._id });
                });
              }}
            >
              <Trash2 /> {m.sidebar_delete()}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <EntitySheet
        open={renameOpen}
        onOpenChange={setRenameOpen}
        title={m.sidebar_rename_chat_title()}
        canSubmit={renameValue.trim().length > 0}
        onSubmit={async () => {
          await renameChat({ chatId: chat._id, title: renameValue.trim() });
          setRenameOpen(false);
        }}
      >
        <div className="oc-form">
          <label className="oc-field">
            <span className="oc-field__label">{m.sidebar_title_field()}</span>
            <Input
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              autoFocus
            />
          </label>
        </div>
      </EntitySheet>
    </>
  );
});
