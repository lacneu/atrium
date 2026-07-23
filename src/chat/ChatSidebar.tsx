import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { APP_HOST } from "@/lib/appHost";
import { clearSidebarFlash, useSidebarFlash } from "./sidebarFlash";
import { formatDateTime } from "@/lib/format";
import { useMutation, useQuery } from "convex/react";
import { useNavigate } from "@tanstack/react-router";
import { useToast } from "@/components/ui/toast";
import { formatChatReference } from "../../convex/lib/envLabel";
import { rootAncestorOf, rootsOf } from "../../convex/lib/folderTree";
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
  Link2,
  Bookmark,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  FolderSearch,
  GripVertical,
  MoreVertical,
  PanelLeftClose,
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
import { FolderTreePicker } from "./FolderTreePicker";
import { Input } from "@/components/ui/input";
import { useConfirm, usePrompt } from "@/components/ConfirmDialog";
import { api } from "./convexApi";
import type { Id } from "./convexApi";
import { relativeAge } from "./relativeAge";
import { m } from "@/paraglide/messages.js";

// The sidebar tint palette + hue resolution moved to sidebarPalette.ts (shared
// with ProjectPage + FolderTreePicker without import cycles); re-exported here
// so existing imports (tests) keep working.
export { CHAT_COLORS, autoProjectHue, colorHue, projectHue } from "./sidebarPalette";
import { CHAT_COLORS, colorHue, projectHue } from "./sidebarPalette";

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
  // Folder nesting (null = root). The sidebar renders ROOT folders only —
  // sub-folders (and their chats) live on the folder PAGE (/project/$id).
  parentId: Id<"projects"> | null;
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
  // Chats where the agent is WORKING right now — a streaming turn, a running
  // sub-agent/background task, or an in-flight/queued send (the server unions
  // them; see chatReads.myBusyChats). Powers the per-row pulse and the folded-
  // folder aggregate, and matches what the chat page itself shows as activity.
  const busyList = useQuery(api.chatReads.myBusyChats, {}) as
    | Id<"chats">[]
    | undefined;
  const busyIds = useMemo(() => new Set(busyList ?? []), [busyList]);
  // Chats carrying at least one bookmark (own bounded query, same reasoning
  // as myBusyChats: never a listChats passenger).
  const bookmarkedList = useQuery(api.chatBookmarks.myBookmarkedChats, {}) as
    | Id<"chats">[]
    | undefined;
  // Prefetched once: the copy-reference clipboard write must run INSIDE the
  // click's transient user activation (Safari/Firefox) — no network hop.
  const referenceLabel = useQuery(api.chatExport.referenceLabel, {}) as
    | string
    | null
    | undefined;
  const bookmarkedIds = useMemo(
    () => new Set(bookmarkedList ?? []),
    [bookmarkedList],
  );
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
    // A chat inside a SUB-folder has no sidebar row to reveal (only root
    // folders render sections) — leave everything folded; the root header's
    // aggregate dot carries the signal and the fork navigation already opened
    // the chat itself.
    if (proj && proj.parentId !== null) return;
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

  // The sidebar stays FLAT: only ROOT folders render as sections; sub-folders
  // (and their chats) live on the folder page. Chats of sub-folders still ride
  // listChats, so the root header can aggregate their busy/unread signals.
  const navigate = useNavigate();
  const roots = useMemo(() => rootsOf(projects ?? []), [projects]);
  // folderId -> its root ancestor's id (identity for roots).
  const rootMap = useMemo(() => {
    const list = projects ?? [];
    return new Map(list.map((p) => [p._id, rootAncestorOf(list, p._id)]));
  }, [projects]);
  // folderId -> name, for the per-row "domain" label (deep rows name their
  // sub-folder inside the flattened root section).
  const projectNames = useMemo(
    () => new Map((projects ?? []).map((p) => [p._id, p.name])),
    [projects],
  );
  // Every visible-window chat of the ROOT's whole subtree (direct + nested) —
  // drives the folded-header aggregates. Window-bounded like everything else
  // here (a sub-folder chat outside listChats' window doesn't signal — same
  // acceptance as folded folders before nesting existed).
  const subtreeChats = (rootId: string) =>
    unpinned.filter(
      (c) =>
        c.projectId !== null &&
        (rootMap.get(c.projectId) ?? c.projectId) === rootId,
    );

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
      // Only ROOT folders render (and drag) in the sidebar — the reorder's
      // prev/next keys must come from the ROOT list, not the full forest
      // (fractional keys only compare between siblings).
      const list = roots;
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
                  bookmarked={bookmarkedIds.has(c._id)}
                  referenceLabel={referenceLabel}
                  ageTick={minuteTick}
                  suppressClick={suppressClickRef}
                  onSelect={onSelect}
                />
              ))}
            </Section>
          ) : null}

          <SortableContext
            items={roots.map((p) => projHeadId(p._id))}
            strategy={verticalListSortingStrategy}
          >
          {roots.map((p) => {
            // WORKING-SET view: the section lists its WHOLE subtree's chats
            // (flattened — the server already filtered out the chats the user
            // removed from the sidebar). Each deep row names its sub-folder
            // (the "domain") in a muted label. NOTE: manual reorder between
            // two same-folder rows separated by other sub-folders' rows can
            // land visually elsewhere (keys only compare between siblings) —
            // rare, and the folder page is the true organizing surface.
            const ch = subtreeChats(p._id);
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
                onOpen={() =>
                  void navigate({
                    to: "/project/$projectId",
                    params: { projectId: p._id },
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
                      bookmarked={bookmarkedIds.has(c._id)}
                      referenceLabel={referenceLabel}
                      domainLabel={
                        c.projectId !== null && c.projectId !== p._id
                          ? (projectNames.get(c.projectId) ?? null)
                          : null
                      }
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
                    bookmarked={bookmarkedIds.has(c._id)}
                  referenceLabel={referenceLabel}
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
  onOpen,
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
  // Folder sections only: navigate to the folder PAGE. When set, clicking the
  // header NAME opens the page and the chevron becomes the dedicated fold
  // toggle (the static sections keep click-to-fold).
  onOpen?: () => void;
  children: React.ReactNode;
}) {
  const deleteProject = useMutation(api.projects.deleteProject);
  const renameProject = useMutation(api.projects.renameProject);
  const setProjectColor = useMutation(api.projects.setProjectColor);
  const moveProject = useMutation(api.projects.moveProject);
  const confirm = useConfirm();
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState(label);
  // "Move folder to..." tree picker — nests this folder under another one
  // (the sidebar shows roots only, so nesting always goes through here).
  const [moveOpen, setMoveOpen] = useState(false);
  // Recursive counts (sub-folders + their chats) — the delete confirmation
  // must announce the WHOLE subtree it is about to remove.
  const treeCount = useQuery(
    api.projects.projectTreeCount,
    projectId ? { projectId } : "skip",
  ) as { folders: number; chats: number } | undefined;
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
  // With onOpen (folder sections), the header's primary action is OPENING the
  // folder page; folding moves to the chevron button. Enter/Space follow the
  // primary action.
  const headerAction = onOpen ?? onToggle;
  const onKeyToggle = (e: React.KeyboardEvent) => {
    // Only when the HEADER itself is focused: Space/Enter on a nested control
    // (the reorder grip, the actions menu) bubbles here and must not also
    // fold/unfold the folder mid-interaction.
    if (e.target !== e.currentTarget) return;
    if (collapsible && headerAction && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      headerAction();
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
              // Post-drag guard: dropping the folder must not also act.
              onClick: () => {
                if (suppressClick?.current) return;
                headerAction?.();
              },
              onKeyDown: onKeyToggle,
            }
          : {})}
        {...(sortId ? sortPointer : {})}
      >
        {collapsible ? (
          // The chevron doubles as the folder's color carrier (tinted via
          // --proj-hue). With onOpen it is ALSO the dedicated fold toggle (a
          // real button, so the header click can navigate to the folder page
          // while folding stays one click away).
          onOpen ? (
            <button
              type="button"
              className="oc-sidebar__group-chevbtn"
              aria-label={collapsed ? m.sidebar_expand() : m.sidebar_collapse()}
              aria-expanded={!collapsed}
              onClick={(e) => {
                e.stopPropagation();
                if (suppressClick?.current) return;
                onToggle?.();
              }}
              onMouseDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
            >
              {collapsed ? (
                <ChevronRight
                  className={
                    "size-3.5 shrink-0" +
                    (project ? " oc-sidebar__group-chev" : "")
                  }
                />
              ) : (
                <ChevronDown
                  className={
                    "size-3.5 shrink-0" +
                    (project ? " oc-sidebar__group-chev" : "")
                  }
                />
              )}
            </button>
          ) : collapsed ? (
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
              {onOpen ? (
                <DropdownMenuItem onSelect={() => onOpen()}>
                  <FolderOpen /> {m.sidebar_open_folder()}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem
                onSelect={() => {
                  setRenameValue(label);
                  setRenameOpen(true);
                }}
              >
                <Pencil /> {m.sidebar_rename()}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setMoveOpen(true)}>
                <FolderPlus /> {m.sidebar_move_folder_to()}
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
                    // Announce the WHOLE subtree: nested folders and every
                    // conversation inside them are deleted too.
                    const folders = treeCount?.folders ?? 0;
                    const nChats = treeCount?.chats ?? 0;
                    const ok = await confirm({
                      title: m.sidebar_delete_project_confirm_title({ name: label }),
                      description:
                        folders > 0
                          ? m.sidebar_delete_project_confirm_desc_tree({
                              folders,
                              chats: nChats,
                            })
                          : nChats > 0
                            ? m.sidebar_delete_project_confirm_desc({
                                count: nChats,
                              })
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
      {projectId && moveOpen ? (
        <FolderTreePicker
          open={moveOpen}
          onOpenChange={setMoveOpen}
          title={m.folder_picker_title_folder()}
          movingFolderId={projectId}
          currentId={project?.parentId ?? null}
          onPick={(parentId) => void moveProject({ projectId, parentId })}
        />
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
  bookmarked,
  referenceLabel,
  domainLabel,
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
  // The chat holds at least one of the user's bookmarks — quiet flag icon.
  bookmarked: boolean;
  // Deployment env label for the SYNCHRONOUS reference copy (null = bare id;
  // undefined = still loading, the copy item is disabled meanwhile).
  referenceLabel: string | null | undefined;
  // The chat's SUB-folder name when it sits deeper than the section's root
  // (the "domain" hint of the flattened working-set view). null = direct.
  domainLabel?: string | null;
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
  const refToast = useToast();
  // Copy this chat's cross-conversation REFERENCE (env-labeled id): pasted
  // into any composer, it attaches the exported conversation as a file.
  // SYNCHRONOUS clipboard write (the label was prefetched): Safari/Firefox
  // void the click's transient activation across an async hop (codex P1).
  const copyReference = () => {
    if (referenceLabel === undefined) return;
    const ref = formatChatReference(referenceLabel, chat._id);
    navigator.clipboard.writeText(ref).then(
      () => refToast.success(m.sidebar_reference_copied({ reference: ref })),
      () => refToast.error(m.sidebar_reference_copy_failed()),
    );
  };
  const deleteChat = useMutation(api.chats.deleteChat);
  const pinChat = useMutation(api.chats.pinChat);
  const setColor = useMutation(api.chats.setChatColor);
  const moveToProject = useMutation(api.chats.moveChatToProject);
  const setChatSidebar = useMutation(api.chats.setChatSidebar);
  const locateNavigate = useNavigate();
  // "Move to..." tree picker (menu item) — reaches SUB-folders, which the
  // drag&drop can't (only root sections render in the sidebar).
  const [moveOpen, setMoveOpen] = useState(false);
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
          <span className="oc-chatitem__title">
            {chat.title || m.sidebar_untitled()}
          </span>
          {domainLabel ? (
            // The chat's sub-folder ("domain") — the flattened working-set
            // section still situates deep conversations at a glance.
            <span className="oc-chatitem__domain">{domainLabel}</span>
          ) : null}
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
        {bookmarked ? (
          <span
            className="oc-chatitem__bookmark group-hover/row:opacity-0 group-focus-within/row:opacity-0"
            title={m.sidebar_has_bookmarks()}
          >
            <Bookmark size={12} aria-label={m.sidebar_has_bookmarks()} />
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
            <DropdownMenuItem
              onSelect={copyReference}
              disabled={referenceLabel === undefined}
            >
              <Link2 /> {m.sidebar_copy_reference()}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setMoveOpen(true)}>
              <FolderOpen /> {m.sidebar_move_to_folder()}
            </DropdownMenuItem>
            {chat.projectId !== null ? (
              // Locate this chat in the folder view: opens ITS folder's page
              // with the row highlighted (?c=) — the fast answer to "where
              // does this deeply-filed conversation live?".
              <DropdownMenuItem
                onSelect={() =>
                  void locateNavigate({
                    to: "/project/$projectId",
                    params: { projectId: chat.projectId as string },
                    search: { c: chat._id },
                  })
                }
              >
                <FolderSearch /> {m.sidebar_locate_in_folder()}
              </DropdownMenuItem>
            ) : null}
            {!chat.pinned ? (
              // WORKING-SET opt-out: the row vanishes from the sidebar but the
              // chat stays organized in its folder (page/search reach it, and
              // the folder page's toggle puts it back). Pinned rows always
              // show, so the item would be a no-op there — hidden.
              <DropdownMenuItem
                onSelect={() =>
                  void setChatSidebar({ chatId: chat._id, hidden: true })
                }
              >
                <PanelLeftClose /> {m.sidebar_remove_from_bar()}
              </DropdownMenuItem>
            ) : null}

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
      {moveOpen ? (
        <FolderTreePicker
          open={moveOpen}
          onOpenChange={setMoveOpen}
          title={m.folder_picker_title_chat()}
          currentId={chat.projectId}
          onPick={(folderId) =>
            void moveToProject({ chatId: chat._id, projectId: folderId })
          }
        />
      ) : null}
    </>
  );
});
