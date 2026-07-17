// The folder page — the main-area home of a project folder. The sidebar stays
// FLAT (a working set of chats); the hierarchy's depth lives here: breadcrumb,
// sub-folder cards (recursive counts + last activity) and the folder's direct
// conversations — plus a Finder-style COLUMN view (toggle, persisted) and
// drag & drop between folders (cards, column entries, breadcrumb segments).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  closestCorners,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS as DndCSS } from "@dnd-kit/utilities";
import {
  ChevronDown,
  ChevronRight,
  Columns3,
  Folder,
  FolderInput,
  FolderPlus,
  LayoutGrid,
  List,
  MessageSquare,
  MessageSquarePlus,
  MoreVertical,
  PanelLeft,
  PanelLeftClose,
  Pencil,
  Pin,
  PinOff,
  Trash2,
} from "lucide-react";
import { m } from "@/paraglide/messages.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/components/ui/toast";
import { useConfirm, usePrompt } from "@/components/ConfirmDialog";
import { api } from "./convexApi";
import type { Id } from "./convexApi";
import { EntitySheet } from "./admin/EntitySheet";
import { FolderTreePicker } from "./FolderTreePicker";
import { ChatEntryMenu, FolderEntryMenu } from "./projectMenus";
import { CHAT_COLORS, colorHue, projectHue } from "./sidebarPalette";
import { relativeAge } from "./relativeAge";
import { setPendingFocusTerms } from "./pendingFocusTerms";
import { useStartNewChat } from "./useStartNewChat";
import { canNest, childrenOf, type FolderNode } from "../../convex/lib/folderTree";
import { filterChatsByTitle, reorderSlot, unreadChatIds } from "./projectPageView";
import "./projectPage.css";

type PageChat = {
  _id: Id<"chats">;
  title: string | null;
  color: string | null;
  pinned: boolean;
  sortKey: number;
  updatedAt: number;
  lastAssistantAt: number | null;
  inSidebar: boolean;
};

type PageData = {
  project: {
    _id: Id<"projects">;
    name: string;
    color: string | null;
    parentId: Id<"projects"> | null;
  };
  breadcrumb: { _id: Id<"projects">; name: string }[];
  children: {
    _id: Id<"projects">;
    name: string;
    color: string | null;
    sortKey: number;
    folderCount: number;
    chatCount: number;
    recursiveChatCount: number;
    lastActivityAt: number | null;
  }[];
  chats: PageChat[];
} | null;

type ColumnsData = {
  columns: {
    folderId: Id<"projects"> | null;
    folders: {
      _id: Id<"projects">;
      name: string;
      color: string | null;
      sortKey: number;
      selected: boolean;
    }[];
    chats: PageChat[];
  }[];
};

type TreeListData = {
  rootId: Id<"projects">;
  folders: {
    _id: Id<"projects">;
    name: string;
    color: string | null;
    parentId: Id<"projects"> | null;
    sortKey: number;
  }[];
  chats: (PageChat & { folderId: Id<"projects"> })[];
} | null;

// View mode persisted per browser (a display preference, like the sidebar's
// no-project fold state). COLUMNS is the default — the Finder-style general
// view is the primary organizing surface; cards/list remain one click away.
const VIEW_KEY = "oc.projpage.view";
type ViewMode = "cards" | "columns" | "list";
function loadView(): ViewMode {
  const v = localStorage.getItem(VIEW_KEY);
  return v === "cards" || v === "list" ? v : "columns";
}

// Drag ids: "chat:<id>" / "folder:<id>" (sortable items — dropping BETWEEN
// them reorders). "Into" drop ids are DISTINCT per surface so the collision
// logic can rank them: "into:<id>" = a folder entry/card body (nest inside),
// "col:<id|null>" = a column's background (drop into that level), "crumb:<id>"
// = a breadcrumb segment (move up).
const intoId = (folderId: string) => `into:${folderId}`;
const colDropId = (folderId: string | null) => `col:${folderId ?? "null"}`;
const crumbId = (folderId: string) => `crumb:${folderId}`;
/** The target folder of ANY into-style droppable id (null = root/unfiled). */
function intoTargetOf(overId: string): Id<"projects"> | null | undefined {
  if (overId.startsWith("into:")) return overId.slice(5) as Id<"projects">;
  if (overId.startsWith("crumb:")) return overId.slice(6) as Id<"projects">;
  if (overId.startsWith("col:")) {
    const raw = overId.slice(4);
    return raw === "null" ? null : (raw as Id<"projects">);
  }
  return undefined;
}

export function ProjectPage() {
  const { projectId } = useParams({ from: "/project/$projectId" });
  const navigate = useNavigate();
  const page = useQuery(api.projects.projectPage, { projectId }) as
    | PageData
    | undefined;
  return (
    <div className="oc-projpage">
      {page === undefined ? (
        <p className="oc-projpage__hint">{m.common_loading()}</p>
      ) : page === null ? (
        <div className="oc-projpage__notfound">
          <h2>{m.project_page_not_found_title()}</h2>
          <p className="oc-projpage__hint">{m.project_page_not_found_body()}</p>
          <Button variant="outline" onClick={() => void navigate({ to: "/" })}>
            {m.project_page_back_home()}
          </Button>
        </div>
      ) : (
        <ProjectPageBody page={page} />
      )}
    </div>
  );
}

function ProjectPageBody({ page }: { page: NonNullable<PageData> }) {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const toast = useToast();
  const renameProject = useMutation(api.projects.renameProject);
  const setProjectColor = useMutation(api.projects.setProjectColor);
  const deleteProject = useMutation(api.projects.deleteProject);
  const createProject = useMutation(api.projects.createProject);
  const moveProject = useMutation(api.projects.moveProject);
  const moveChatToProject = useMutation(api.chats.moveChatToProject);
  const reorderChat = useMutation(api.chats.reorderChat);
  const reorderProject = useMutation(api.projects.reorderProject);
  const treeCount = useQuery(api.projects.projectTreeCount, {
    projectId: page.project._id,
  }) as { folders: number; chats: number } | undefined;

  // View toggle (cards / Finder-style columns / indented list), persisted.
  const [view, setView] = useState<ViewMode>(loadView);
  const switchView = (v: ViewMode) => {
    localStorage.setItem(VIEW_KEY, v);
    setView(v);
  };
  const columnsData = useQuery(
    api.projects.folderColumns,
    view === "columns" ? { projectId: page.project._id } : "skip",
  ) as ColumnsData | undefined;
  const treeData = useQuery(
    api.projects.projectTreeList,
    view === "list" ? { projectId: page.project._id } : "skip",
  ) as TreeListData | undefined;

  // "Locate in folder view" (?c=<chatId> from the sidebar): the row flashes
  // and scrolls into view so a deeply-filed chat is spotted instantly.
  const { c: locateChatId } = useSearch({ from: "/project/$projectId" });

  // The full forest — client-side canNest gating for folder drags (the server
  // re-validates; this only avoids a doomed round-trip + gives instant
  // feedback). Deduped with the sidebar's subscription.
  const forest = useQuery(api.projects.listProjects, {}) as
    | (FolderNode & { _id: Id<"projects"> })[]
    | undefined;

  // Live indicators, same sources as the sidebar (busy pulse / unread dot).
  const busyList = useQuery(api.chatReads.myBusyChats, {}) as
    | Id<"chats">[]
    | undefined;
  const busyIds = useMemo(() => new Set(busyList ?? []), [busyList]);
  const reads = useQuery(api.chatReads.myChatReads, {}) as
    | { chatId: Id<"chats">; lastSeenAt: number }[]
    | undefined;
  const unreadIds = useMemo(
    () => unreadChatIds(page.chats, reads ?? []),
    [page.chats, reads],
  );

  const { startNewChat, picker } = useStartNewChat((id) =>
    void navigate({ to: "/chat/$chatId", params: { chatId: id } }),
  );

  const [term, setTerm] = useState("");
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState(page.project.name);
  const [moveOpen, setMoveOpen] = useState(false);

  // Folder-scoped DEEP search (titles + message bodies over the whole
  // subtree). Debounced so each keystroke doesn't open a new subscription —
  // same cadence as the ⌘K palette. The instant title filter above stays
  // independent (zero-latency on the visible list).
  const [debouncedTerm, setDebouncedTerm] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setDebouncedTerm(term.trim()), 180);
    return () => clearTimeout(id);
  }, [term]);
  const deepHits = useQuery(
    api.search.searchConversations,
    debouncedTerm.length >= 2
      ? { query: debouncedTerm, projectId: page.project._id }
      : "skip",
  );

  // ---- Drag & drop (both views) -------------------------------------------
  // Same feel as the sidebar: 4px of mouse travel before a drag starts (plain
  // clicks stay clicks), long-press on touch. After a real drag, the browser
  // still fires a click on whatever is under the pointer — the guard swallows
  // it so a drop never ALSO navigates.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 250, tolerance: 8 },
    }),
  );
  const suppressClickRef = useRef(false);
  const armClickSuppression = () => {
    suppressClickRef.current = true;
    setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
  };
  const [activeDrag, setActiveDrag] = useState<{
    kind: "chat" | "folder";
    label: string;
  } | null>(null);

  const labelOf = (id: string): { kind: "chat" | "folder"; label: string } | null => {
    if (id.startsWith("chat:")) {
      const cid = id.slice(5);
      const inPage = page.chats.find((c) => c._id === cid);
      const inCols = columnsData?.columns
        .flatMap((col) => col.chats)
        .find((c) => c._id === cid);
      const chat = inPage ?? inCols;
      return {
        kind: "chat",
        label: chat?.title || m.sidebar_untitled(),
      };
    }
    if (id.startsWith("folder:")) {
      const fid = id.slice(7);
      const f = (forest ?? []).find((x) => x._id === fid);
      return { kind: "folder", label: f?.name ?? "" };
    }
    return null;
  };

  const onDragStart = (e: DragStartEvent) =>
    setActiveDrag(labelOf(String(e.active.id)));

  // Finder-style collision ranking:
  //   chat drag:   over a folder entry = INTO it; over another chat = the
  //                between-items SLOT; breadcrumb = up; column background =
  //                into that level; else nearest chat slot.
  //   folder drag: the CENTER band (40%) of a folder entry = INTO it, its
  //                edges = the reorder SLOT; then crumb/column/nearest slot.
  const collisionDetection = useCallback<CollisionDetection>((args) => {
    const activeId = String(args.active.id);
    const isFolder = activeId.startsWith("folder:");
    const subset = (prefix: string) => ({
      ...args,
      droppableContainers: args.droppableContainers.filter((c) =>
        String(c.id).startsWith(prefix),
      ),
    });
    const into = pointerWithin(subset("into:"));
    if (into.length > 0) {
      if (!isFolder) return into;
      const hit = into[0]!;
      const rect = args.droppableRects.get(hit.id);
      const y = args.pointerCoordinates?.y;
      if (rect && y !== undefined && y !== null) {
        const band = rect.height * 0.3;
        if (y > rect.top + band && y < rect.top + rect.height - band) {
          return into; // center band -> nest inside
        }
      }
      // edges fall through to the reorder slots below
    }
    const slots = pointerWithin(subset(isFolder ? "folder:" : "chat:"));
    if (slots.length > 0) return slots;
    const crumb = pointerWithin(subset("crumb:"));
    if (crumb.length > 0) return crumb;
    const col = pointerWithin(subset("col:"));
    if (col.length > 0) return col;
    return closestCorners(subset(isFolder ? "folder:" : "chat:"));
  }, []);

  // The ordered sibling list of a SLOT target, per active view — feeds the
  // fractional-key computation (reorderSlot). Chats: (list, containing folder);
  // folders: (list, their parent).
  const chatSlotContext = (
    targetId: string,
  ): { list: PageChat[]; folderId: Id<"projects"> | null } | null => {
    if (view === "columns") {
      for (const col of columnsData?.columns ?? []) {
        if (col.chats.some((c) => c._id === targetId)) {
          return { list: col.chats, folderId: col.folderId };
        }
      }
      return null;
    }
    if (view === "list") {
      const target = treeData?.chats.find((c) => c._id === targetId);
      if (!target) return null;
      return {
        list: treeData!.chats.filter((c) => c.folderId === target.folderId),
        folderId: target.folderId,
      };
    }
    if (page.chats.some((c) => c._id === targetId)) {
      return { list: page.chats, folderId: page.project._id };
    }
    return null;
  };
  const folderSlotContext = (
    targetId: string,
  ): {
    list: { _id: Id<"projects">; sortKey: number }[];
    parentId: Id<"projects"> | null;
  } | null => {
    if (view === "columns") {
      for (const col of columnsData?.columns ?? []) {
        if (col.folders.some((f) => f._id === targetId)) {
          return { list: col.folders, parentId: col.folderId };
        }
      }
      return null;
    }
    if (view === "list") {
      const target = treeData?.folders.find((f) => f._id === targetId);
      if (!target || !treeData) return null;
      const parentId = target.parentId ?? treeData.rootId;
      return {
        list: childrenOf(treeData.folders, target.parentId),
        parentId,
      };
    }
    if (page.children.some((f) => f._id === targetId)) {
      return { list: page.children, parentId: page.project._id };
    }
    return null;
  };

  const onDragEnd = async (e: DragEndEvent) => {
    setActiveDrag(null);
    armClickSuppression();
    const { active, over } = e;
    if (!over) return;
    const overId = String(over.id);
    const activeId = String(active.id);
    const isChat = activeId.startsWith("chat:");
    try {
      // 1) Into-style targets (folder entry / column background / breadcrumb).
      const intoTarget = intoTargetOf(overId);
      if (intoTarget !== undefined) {
        if (isChat) {
          const chatId = activeId.slice(5) as Id<"chats">;
          await moveChatToProject({ chatId, projectId: intoTarget });
        } else {
          const folderId = activeId.slice(7) as Id<"projects">;
          if (folderId === intoTarget) return;
          if (!canNest(forest ?? [], folderId, intoTarget)) {
            toast.error(m.project_page_move_refused());
            return;
          }
          await moveProject({ projectId: folderId, parentId: intoTarget });
        }
        return;
      }
      // 2) Between-items SLOT (dropped onto a sibling): position there —
      // re-parenting first when the item comes from another container.
      if (isChat && overId.startsWith("chat:")) {
        const chatId = activeId.slice(5) as Id<"chats">;
        const targetId = overId.slice(5);
        if (chatId === targetId) return;
        const ctx = chatSlotContext(targetId);
        if (!ctx) return;
        const inList = ctx.list.some((c) => c._id === chatId);
        if (!inList) {
          await moveChatToProject({ chatId, projectId: ctx.folderId });
        }
        const keys = reorderSlot(
          ctx.list,
          (c) => c._id,
          (c) => c.sortKey,
          chatId,
          targetId,
        );
        if (keys) await reorderChat({ chatId, ...keys });
        return;
      }
      if (!isChat && overId.startsWith("folder:")) {
        const folderId = activeId.slice(7) as Id<"projects">;
        const targetId = overId.slice(7);
        if (folderId === targetId) return;
        const ctx = folderSlotContext(targetId);
        if (!ctx) return;
        const inList = ctx.list.some((f) => f._id === folderId);
        if (!inList) {
          if (!canNest(forest ?? [], folderId, ctx.parentId)) {
            toast.error(m.project_page_move_refused());
            return;
          }
          await moveProject({ projectId: folderId, parentId: ctx.parentId });
        }
        const keys = reorderSlot(
          ctx.list,
          (f) => f._id,
          (f) => f.sortKey,
          folderId,
          targetId,
        );
        if (keys) await reorderProject({ projectId: folderId, ...keys });
        return;
      }
    } catch {
      toast.error(m.project_page_move_refused());
    }
  };

  // Relative ages advance on a minute cadence (same rationale as the sidebar:
  // Date.now() is read at render, an idle page would freeze at "now").
  const [, setMinuteTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setMinuteTick((t) => t + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);
  const now = Date.now();

  const hue = projectHue(page.project);
  const shownChats = filterChatsByTitle(page.chats, term);
  const parentCrumbs = page.breadcrumb.slice(0, -1);
  const navGuarded = (fn: () => void) => () => {
    if (suppressClickRef.current) return; // a drag just ended here
    fn();
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
    <div
      className="oc-projpage__body"
      style={{ "--proj-hue": hue } as React.CSSProperties}
    >
      {/* Breadcrumb: parents are links AND drop targets ("move up one level"
          = drop onto the parent segment). Current folder is plain text. */}
      <nav className="oc-projpage__crumbs" aria-label={m.chat_breadcrumb_aria()}>
        {parentCrumbs.map((c) => (
          <span key={c._id} className="oc-projpage__crumb">
            <CrumbDrop folderId={c._id}>
              <button
                type="button"
                className="oc-projpage__crumblink"
                onClick={navGuarded(() =>
                  void navigate({
                    to: "/project/$projectId",
                    params: { projectId: c._id },
                  }),
                )}
              >
                {c.name}
              </button>
            </CrumbDrop>
            <span className="oc-projpage__crumbsep" aria-hidden>
              ›
            </span>
          </span>
        ))}
        <span className="oc-projpage__crumbcur">{page.project.name}</span>
      </nav>

      <header className="oc-projpage__head">
        <span className="oc-projpage__dot" aria-hidden />
        <h1 className="oc-projpage__title">{page.project.name}</h1>
        <div className="oc-projpage__actions">
          <div
            className="oc-projpage__viewtoggle"
            role="group"
            aria-label={m.project_page_view_cards()}
          >
            <Button
              variant={view === "cards" ? "secondary" : "ghost"}
              size="icon-sm"
              aria-label={m.project_page_view_cards()}
              title={m.project_page_view_cards()}
              aria-pressed={view === "cards"}
              onClick={() => switchView("cards")}
            >
              <LayoutGrid />
            </Button>
            <Button
              variant={view === "columns" ? "secondary" : "ghost"}
              size="icon-sm"
              aria-label={m.project_page_view_columns()}
              title={m.project_page_view_columns()}
              aria-pressed={view === "columns"}
              onClick={() => switchView("columns")}
            >
              <Columns3 />
            </Button>
            <Button
              variant={view === "list" ? "secondary" : "ghost"}
              size="icon-sm"
              aria-label={m.project_page_view_list()}
              title={m.project_page_view_list()}
              aria-pressed={view === "list"}
              onClick={() => switchView("list")}
            >
              <List />
            </Button>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void startNewChat({ projectId: page.project._id })}
          >
            <MessageSquarePlus />
            {m.project_page_new_chat_here()}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              const name = await prompt({
                title: m.sidebar_new_subfolder(),
                label: m.sidebar_project_name_label(),
                placeholder: m.sidebar_project_name_placeholder(),
                confirmLabel: m.sidebar_create(),
              });
              if (name) {
                await createProject({ name, parentId: page.project._id });
              }
            }}
          >
            <FolderPlus />
            {m.sidebar_new_subfolder()}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={m.sidebar_project_actions()}
              >
                <MoreVertical />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem
                onSelect={() => {
                  setRenameValue(page.project.name);
                  setRenameOpen(true);
                }}
              >
                <Pencil /> {m.sidebar_rename()}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setMoveOpen(true)}>
                <FolderInput /> {m.sidebar_move_folder_to()}
              </DropdownMenuItem>
              <DropdownMenuLabel>{m.sidebar_color()}</DropdownMenuLabel>
              <div className="oc-colorgrid">
                <button
                  className="oc-colorgrid__none"
                  onClick={() =>
                    void setProjectColor({
                      projectId: page.project._id,
                      color: null,
                    })
                  }
                  aria-label={m.sidebar_no_color()}
                >
                  ✕
                </button>
                {CHAT_COLORS.map((c) => (
                  <button
                    key={c.value}
                    className={
                      "oc-colorgrid__dot" +
                      (page.project.color === c.value ? " is-selected" : "")
                    }
                    style={{ background: c.hue }}
                    aria-label={c.value}
                    onClick={() =>
                      void setProjectColor({
                        projectId: page.project._id,
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
                  const parent = page.project.parentId;
                  requestAnimationFrame(async () => {
                    const folders = treeCount?.folders ?? 0;
                    const chats = treeCount?.chats ?? 0;
                    const ok = await confirm({
                      title: m.sidebar_delete_project_confirm_title({
                        name: page.project.name,
                      }),
                      description:
                        folders > 0
                          ? m.sidebar_delete_project_confirm_desc_tree({
                              folders,
                              chats,
                            })
                          : chats > 0
                            ? m.sidebar_delete_project_confirm_desc({
                                count: chats,
                              })
                            : m.sidebar_action_irreversible(),
                      confirmWord: m.sidebar_delete(),
                      confirmLabel: m.sidebar_delete_project(),
                      destructive: true,
                    });
                    if (!ok) return;
                    await deleteProject({ projectId: page.project._id });
                    // Land on the parent's page (or home for a root folder).
                    if (parent !== null) {
                      void navigate({
                        to: "/project/$projectId",
                        params: { projectId: parent },
                      });
                    } else {
                      void navigate({ to: "/" });
                    }
                  });
                }}
              >
                <Trash2 /> {m.sidebar_delete()}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {view === "columns" ? (
        <ColumnView
          data={columnsData}
          currentId={page.project._id}
          busyIds={busyIds}
          suppressClick={suppressClickRef}
          locateChatId={locateChatId ?? null}
        />
      ) : view === "list" ? (
        <TreeListView
          data={treeData}
          busyIds={busyIds}
          suppressClick={suppressClickRef}
          locateChatId={locateChatId ?? null}
        />
      ) : (
        <>
          {page.children.length > 0 ? (
            <section className="oc-projpage__section">
              <h2 className="oc-projpage__subtitle">
                {m.project_page_subfolders()}
              </h2>
              <div className="oc-projpage__cards">
                <SortableContext
                  items={page.children.map((c) => `folder:${c._id}`)}
                  strategy={rectSortingStrategy}
                >
                  {page.children.map((child) => (
                    <FolderCard
                      key={child._id}
                      child={child}
                      parentId={page.project._id}
                      now={now}
                      suppressClick={suppressClickRef}
                    />
                  ))}
                </SortableContext>
              </div>
            </section>
          ) : null}

          <section className="oc-projpage__section">
            <div className="oc-projpage__convhead">
              <h2 className="oc-projpage__subtitle">
                {m.project_page_conversations()}
              </h2>
              {page.chats.length > 0 ? (
                <Input
                  value={term}
                  onChange={(e) => setTerm(e.target.value)}
                  placeholder={m.project_page_search_placeholder()}
                  className="oc-projpage__filter"
                />
              ) : null}
            </div>
            {page.chats.length === 0 ? (
              <p className="oc-projpage__hint">
                {page.children.length === 0
                  ? m.project_page_empty()
                  : m.project_page_empty_chats()}
              </p>
            ) : shownChats.length === 0 && (deepHits ?? []).length === 0 ? (
              <p className="oc-projpage__hint">
                {m.project_page_search_no_results({ term: term.trim() })}
              </p>
            ) : (
              <ul className="oc-projpage__chats">
                <SortableContext
                  items={shownChats.map((c) => `chat:${c._id}`)}
                  strategy={verticalListSortingStrategy}
                >
                  {shownChats.map((c) => (
                    <ChatRow
                      key={c._id}
                      chat={c}
                      currentFolderId={page.project._id}
                      now={now}
                      busy={busyIds.has(c._id)}
                      unread={unreadIds.has(c._id)}
                      locate={c._id === locateChatId}
                      suppressClick={suppressClickRef}
                    />
                  ))}
                </SortableContext>
              </ul>
            )}
          </section>

          {/* DEEP results: titles + message bodies over the WHOLE subtree (the
              instant list above only filters this folder's direct titles). A
              message hit lands the thread on the matched message (?m deep-link,
              highlight terms via the ephemeral store — never the URL). */}
          {debouncedTerm.length >= 2 && deepHits !== undefined ? (
            <section className="oc-projpage__section">
              <h2 className="oc-projpage__subtitle">
                {m.project_page_deep_results()}
              </h2>
              {deepHits.length === 0 ? (
                <p className="oc-projpage__hint">
                  {m.project_page_search_no_results({ term: debouncedTerm })}
                </p>
              ) : (
                <ul className="oc-projpage__chats">
                  {deepHits.map((hit) => (
                    <li
                      key={`${hit.chatId}:${hit.messageId ?? "t"}`}
                      className="oc-projpage__chatrow"
                    >
                      <button
                        type="button"
                        className="oc-projpage__chatbtn"
                        onClick={() => {
                          if (hit.messageId && debouncedTerm) {
                            setPendingFocusTerms(hit.messageId, debouncedTerm);
                          }
                          void navigate({
                            to: "/chat/$chatId",
                            params: { chatId: hit.chatId },
                            ...(hit.messageId
                              ? { search: { m: hit.messageId } }
                              : {}),
                          });
                        }}
                      >
                        <MessageSquare
                          size={13}
                          aria-hidden
                          className="oc-projpage__hitico"
                        />
                        <span className="oc-projpage__hitbody">
                          <span className="oc-projpage__chattitle">
                            {hit.title || m.search_untitled_chat()}
                          </span>
                          {hit.projectPath && hit.projectPath.length > 1 ? (
                            <span className="oc-projpage__hitpath">
                              {hit.projectPath.join(" › ")}
                            </span>
                          ) : null}
                          {hit.snippet ? (
                            <span className="oc-projpage__hitsnippet">
                              {hit.snippet}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}
        </>
      )}

      <EntitySheet
        open={renameOpen}
        onOpenChange={setRenameOpen}
        title={m.sidebar_rename_project_title()}
        canSubmit={renameValue.trim().length > 0}
        onSubmit={async () => {
          await renameProject({
            projectId: page.project._id,
            name: renameValue.trim(),
          });
          setRenameOpen(false);
        }}
        submitLabel={m.sidebar_rename()}
      >
        <Input
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          autoFocus
        />
      </EntitySheet>
      {moveOpen ? (
        <FolderTreePicker
          open={moveOpen}
          onOpenChange={setMoveOpen}
          title={m.folder_picker_title_folder()}
          movingFolderId={page.project._id}
          currentId={page.project.parentId}
          onPick={(parentId) =>
            void moveProject({ projectId: page.project._id, parentId })
          }
        />
      ) : null}
      {picker}
    </div>
    <DragOverlay>
      {activeDrag ? (
        <div className="oc-projpage__dragghost">
          {activeDrag.kind === "folder" ? (
            <Folder size={13} aria-hidden />
          ) : (
            <MessageSquare size={13} aria-hidden />
          )}
          <span>{activeDrag.label}</span>
        </div>
      ) : null}
    </DragOverlay>
    </DndContext>
  );
}

// ---- Drag & drop building blocks -------------------------------------------

/** Breadcrumb segment as a drop target ("move up one level"). */
function CrumbDrop({
  folderId,
  children,
}: {
  folderId: Id<"projects">;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: crumbId(folderId) });
  return (
    <span
      ref={setNodeRef}
      className={isOver ? "oc-projpage__cdrop is-over" : "oc-projpage__cdrop"}
    >
      {children}
    </span>
  );
}

/** Sub-folder card: navigates on click, draggable (re-parent), drop target. */
function FolderCard({
  child,
  parentId,
  now,
  suppressClick,
}: {
  child: NonNullable<PageData>["children"][number];
  /** The page's folder (the card's current parent — for the move picker). */
  parentId: Id<"projects">;
  now: number;
  suppressClick: React.MutableRefObject<boolean>;
}) {
  const navigate = useNavigate();
  const drag = useSortable({ id: `folder:${child._id}` });
  const drop = useDroppable({ id: intoId(child._id) });
  return (
    <div
      ref={(el) => {
        drag.setNodeRef(el);
        drop.setNodeRef(el);
      }}
      className={
        "oc-projpage__card" +
        (drop.isOver ? " is-over" : "") +
        (drag.isDragging ? " is-dragging" : "")
      }
      style={
        {
          "--proj-hue": projectHue(child),
          transform: DndCSS.Transform.toString(drag.transform),
          transition: drag.transition,
        } as React.CSSProperties
      }
      onClick={() => {
        if (suppressClick.current) return;
        void navigate({
          to: "/project/$projectId",
          params: { projectId: child._id },
        });
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          void navigate({
            to: "/project/$projectId",
            params: { projectId: child._id },
          });
        }
      }}
      {...drag.listeners}
      {...drag.attributes}
      // After the dnd spread: the card ACTS as a link (dnd's role="button"
      // would announce the wrong affordance to screen readers).
      role="link"
      tabIndex={0}
    >
      <span className="oc-projpage__cardhead">
        <Folder size={15} aria-hidden className="oc-projpage__cardico" />
        <span className="oc-projpage__cardname">{child.name}</span>
        <FolderEntryMenu
          folderId={child._id}
          name={child.name}
          color={child.color}
          currentParentId={parentId}
          className="oc-projpage__cardmenu"
          onOpen={() =>
            void navigate({
              to: "/project/$projectId",
              params: { projectId: child._id },
            })
          }
        />
      </span>
      <span className="oc-projpage__cardmeta">
        {child.folderCount > 0
          ? m.project_page_folder_count({ count: child.folderCount }) + " · "
          : ""}
        {m.project_page_chat_count({ count: child.recursiveChatCount })}
      </span>
      {child.lastActivityAt !== null ? (
        <span className="oc-projpage__cardage">
          {relativeAge(child.lastActivityAt, now)}
        </span>
      ) : null}
    </div>
  );
}

/** Working-set toggle: shows/removes the chat from the left sidebar. */
function SidebarToggle({ chat }: { chat: PageChat }) {
  const setChatSidebar = useMutation(api.chats.setChatSidebar);
  const label = chat.inSidebar
    ? m.project_page_hide_from_bar()
    : m.project_page_show_in_bar();
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      title={label}
      className={
        "oc-projpage__barbtn" + (chat.inSidebar ? " is-on" : "")
      }
      disabled={chat.pinned && chat.inSidebar} // pinned rows always show
      onClick={(e) => {
        e.stopPropagation();
        void setChatSidebar({ chatId: chat._id, hidden: chat.inSidebar });
      }}
    >
      {chat.inSidebar ? <PanelLeftClose /> : <PanelLeft />}
    </Button>
  );
}

function ChatRow({
  chat,
  currentFolderId,
  now,
  busy,
  unread,
  locate,
  suppressClick,
}: {
  chat: PageChat;
  /** The page's folder (the chat's current location — the rows are direct). */
  currentFolderId: Id<"projects">;
  now: number;
  busy: boolean;
  unread: boolean;
  locate: boolean;
  suppressClick: React.MutableRefObject<boolean>;
}) {
  const navigate = useNavigate();
  const hue = colorHue(chat.color);
  const drag = useSortable({ id: `chat:${chat._id}` });
  const locateRef = useLocateRef<HTMLLIElement>(locate);

  return (
    <li
      ref={(el) => {
        drag.setNodeRef(el);
        locateRef.current = el;
      }}
      className={
        "oc-projpage__chatrow" +
        (drag.isDragging ? " is-dragging" : "") +
        (locate ? " is-locate" : "")
      }
      style={{
        transform: DndCSS.Transform.toString(drag.transform),
        transition: drag.transition,
      }}
    >
      <button
        type="button"
        className="oc-projpage__chatbtn"
        onClick={() => {
          if (suppressClick.current) return;
          void navigate({ to: "/chat/$chatId", params: { chatId: chat._id } });
        }}
        {...drag.listeners}
        {...drag.attributes}
      >
        {hue ? (
          <span className="oc-chatitem__dot" style={{ background: hue }} />
        ) : (
          <span className="oc-chatitem__dot oc-chatitem__dot--empty" />
        )}
        <span className="oc-projpage__chattitle">
          {chat.title || m.sidebar_untitled()}
        </span>
        {chat.pinned ? (
          <Pin size={12} aria-hidden className="oc-projpage__chatpin" />
        ) : null}
        <span className="oc-projpage__chatage">
          {relativeAge(chat.updatedAt, now)}
        </span>
        {busy ? (
          <span
            className="oc-chatitem__busy"
            title={m.sidebar_folder_busy()}
            aria-label={m.sidebar_folder_busy()}
          />
        ) : null}
        {unread && !busy ? (
          <span
            className="oc-chatitem__unread"
            title={m.sidebar_unread_reply()}
            aria-label={m.sidebar_unread_reply()}
          />
        ) : null}
      </button>
      <SidebarToggle chat={chat} />
      <ChatEntryMenu
        chat={chat}
        currentFolderId={currentFolderId}
        className="oc-projpage__chatmenu"
      />
    </li>
  );
}

// ---- Finder-style LIST view (indented, collapsible tree) --------------------

/** Scrolls the row into view once when it is the "?c=" locate target. */
function useLocateRef<T extends HTMLElement>(active: boolean) {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    if (active && ref.current) {
      ref.current.scrollIntoView({ block: "center" });
    }
  }, [active]);
  return ref;
}

function TreeListView({
  data,
  busyIds,
  suppressClick,
  locateChatId,
}: {
  data: TreeListData | undefined;
  busyIds: Set<Id<"chats">>;
  suppressClick: React.MutableRefObject<boolean>;
  locateChatId: string | null;
}) {
  // Folded sub-folders (everything starts EXPANDED: the list view's job is to
  // show the whole subtree at a glance).
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const chatsByFolder = useMemo(() => {
    const map = new Map<string, (PageChat & { folderId: Id<"projects"> })[]>();
    for (const c of data?.chats ?? []) {
      const list = map.get(c.folderId);
      if (list === undefined) map.set(c.folderId, [c]);
      else list.push(c);
    }
    return map;
  }, [data]);

  if (data === undefined) {
    return <p className="oc-projpage__hint">{m.common_loading()}</p>;
  }
  if (data === null) return null;

  const toggleFold = (id: string) =>
    setFolded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Depth-first render from the current folder (depth 0 = its direct content).
  // The server ships parentId RELATIVE to the subtree: direct children carry
  // null — so the top level queries childrenOf(…, null); chats stay keyed by
  // their REAL folder id (the root's own chats under rootId).
  const renderLevel = (
    parentId: Id<"projects"> | null,
    depth: number,
  ): React.ReactNode => {
    const levelChats = chatsByFolder.get(parentId ?? data!.rootId) ?? [];
    const levelFolders = childrenOf(data!.folders, parentId);
    return (
      <>
        <SortableContext
          items={levelChats.map((c) => `chat:${c._id}`)}
          strategy={verticalListSortingStrategy}
        >
          {levelChats.map((c) => (
            <TreeChatRow
              key={c._id}
              chat={c}
              depth={depth}
              busy={busyIds.has(c._id)}
              locate={c._id === locateChatId}
              suppressClick={suppressClick}
            />
          ))}
        </SortableContext>
        <SortableContext
          items={levelFolders.map((f) => `folder:${f._id}`)}
          strategy={verticalListSortingStrategy}
        >
          {levelFolders.map((f) => (
            <TreeFolderRow
              key={f._id}
              folder={f}
              // Relative-parent contract: null = direct child of the page's folder.
              parentId={parentId ?? data!.rootId}
              depth={depth}
              folded={folded.has(f._id)}
              onToggle={() => toggleFold(f._id)}
              suppressClick={suppressClick}
            >
              {folded.has(f._id) ? null : renderLevel(f._id, depth + 1)}
            </TreeFolderRow>
          ))}
        </SortableContext>
      </>
    );
  };

  const empty =
    (chatsByFolder.get(data.rootId) ?? []).length === 0 &&
    childrenOf(data.folders, null).length === 0;
  return (
    <div className="oc-projpage__tree">
      {empty ? (
        <p className="oc-projpage__hint">{m.project_page_empty()}</p>
      ) : (
        renderLevel(null, 0)
      )}
    </div>
  );
}

function TreeFolderRow({
  folder,
  parentId,
  depth,
  folded,
  onToggle,
  suppressClick,
  children,
}: {
  folder: NonNullable<TreeListData>["folders"][number];
  /** The folder's REAL current parent (for the move picker). */
  parentId: Id<"projects">;
  depth: number;
  folded: boolean;
  onToggle: () => void;
  suppressClick: React.MutableRefObject<boolean>;
  children: React.ReactNode;
}) {
  const navigate = useNavigate();
  const drag = useSortable({ id: `folder:${folder._id}` });
  const drop = useDroppable({ id: intoId(folder._id) });
  return (
    <div className="oc-projpage__treegroup">
      <div
        ref={(el) => {
          drag.setNodeRef(el);
          drop.setNodeRef(el);
        }}
        className={
          "oc-projpage__treerow oc-projpage__treerow--folder" +
          (drop.isOver ? " is-over" : "") +
          (drag.isDragging ? " is-dragging" : "")
        }
        style={
          {
            "--tree-depth": depth,
            "--proj-hue": projectHue(folder),
            transform: DndCSS.Transform.toString(drag.transform),
            transition: drag.transition,
          } as React.CSSProperties
        }
        {...drag.listeners}
        {...drag.attributes}
        role="button"
        tabIndex={0}
        onClick={() => {
          if (suppressClick.current) return;
          void navigate({
            to: "/project/$projectId",
            params: { projectId: folder._id },
          });
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            void navigate({
              to: "/project/$projectId",
              params: { projectId: folder._id },
            });
          }
        }}
      >
        <button
          type="button"
          className="oc-projpage__treechev"
          aria-label={folded ? m.sidebar_expand() : m.sidebar_collapse()}
          aria-expanded={!folded}
          onClick={(e) => {
            e.stopPropagation();
            if (suppressClick.current) return;
            onToggle();
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
        >
          {folded ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        </button>
        <Folder size={13} aria-hidden className="oc-projpage__colico" />
        <span className="oc-projpage__colname">{folder.name}</span>
        <FolderEntryMenu
          folderId={folder._id}
          name={folder.name}
          color={folder.color}
          currentParentId={parentId}
          className="oc-projpage__treemenu"
          onOpen={() =>
            void navigate({
              to: "/project/$projectId",
              params: { projectId: folder._id },
            })
          }
        />
      </div>
      {children}
    </div>
  );
}

function TreeChatRow({
  chat,
  depth,
  busy,
  locate,
  suppressClick,
}: {
  chat: PageChat & { folderId: Id<"projects"> };
  depth: number;
  busy: boolean;
  locate: boolean;
  suppressClick: React.MutableRefObject<boolean>;
}) {
  const navigate = useNavigate();
  const drag = useSortable({ id: `chat:${chat._id}` });
  const locateRef = useLocateRef<HTMLDivElement>(locate);
  const hue = colorHue(chat.color);
  return (
    <div
      ref={(el) => {
        drag.setNodeRef(el);
        locateRef.current = el;
      }}
      className={
        "oc-projpage__treerow oc-projpage__treerow--chat" +
        (drag.isDragging ? " is-dragging" : "") +
        (locate ? " is-locate" : "")
      }
      style={
        {
          "--tree-depth": depth,
          transform: DndCSS.Transform.toString(drag.transform),
          transition: drag.transition,
        } as React.CSSProperties
      }
    >
      <button
        type="button"
        className="oc-projpage__colchatbtn"
        onClick={() => {
          if (suppressClick.current) return;
          void navigate({ to: "/chat/$chatId", params: { chatId: chat._id } });
        }}
        {...drag.listeners}
        {...drag.attributes}
      >
        {hue ? (
          <span className="oc-chatitem__dot" style={{ background: hue }} />
        ) : (
          <span className="oc-chatitem__dot oc-chatitem__dot--empty" />
        )}
        <span className="oc-projpage__colname">
          {chat.title || m.sidebar_untitled()}
        </span>
        {busy ? <span className="oc-chatitem__busy" aria-hidden /> : null}
      </button>
      <ChatEntryMenu
        chat={chat}
        currentFolderId={chat.folderId}
        className="oc-projpage__treemenu"
      />
      <SidebarToggle chat={chat} />
    </div>
  );
}

// ---- Finder-style column view ----------------------------------------------

function ColumnView({
  data,
  currentId,
  busyIds,
  suppressClick,
  locateChatId,
}: {
  data: ColumnsData | undefined;
  currentId: Id<"projects">;
  busyIds: Set<Id<"chats">>;
  suppressClick: React.MutableRefObject<boolean>;
  locateChatId: string | null;
}) {
  // Finder behavior: when the path is deeper than the viewport, land scrolled
  // to the RIGHT (the current level + its content are what the user opened —
  // without this, the last column's controls sit outside the visible area).
  const scrollRef = useRef<HTMLDivElement>(null);
  const depth = data?.columns.length ?? 0;
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [depth, currentId]);
  if (data === undefined) {
    return <p className="oc-projpage__hint">{m.common_loading()}</p>;
  }
  return (
    <div className="oc-projpage__cols" ref={scrollRef}>
      {data.columns.map((col, i) => (
        <Column
          key={col.folderId ?? "root"}
          col={col}
          isLast={i === data.columns.length - 1}
          currentId={currentId}
          busyIds={busyIds}
          suppressClick={suppressClick}
          locateChatId={locateChatId}
        />
      ))}
    </div>
  );
}

function Column({
  col,
  isLast,
  currentId,
  busyIds,
  suppressClick,
  locateChatId,
}: {
  col: ColumnsData["columns"][number];
  isLast: boolean;
  currentId: Id<"projects">;
  busyIds: Set<Id<"chats">>;
  suppressClick: React.MutableRefObject<boolean>;
  locateChatId: string | null;
}) {
  const navigate = useNavigate();
  // The column's BACKGROUND is a drop target for its own folder level (drop
  // "into this level" — the root column re-parents to top level / unfiles).
  const drop = useDroppable({ id: colDropId(col.folderId) });
  return (
    <div
      ref={drop.setNodeRef}
      className={
        "oc-projpage__col" +
        (drop.isOver ? " is-over" : "") +
        (isLast ? " is-last" : "")
      }
    >
      <SortableContext
        items={col.folders.map((f) => `folder:${f._id}`)}
        strategy={verticalListSortingStrategy}
      >
        {col.folders.map((f) => (
          <ColumnFolderEntry
            key={f._id}
            folder={f}
            parentId={col.folderId}
            isCurrent={f._id === currentId}
            suppressClick={suppressClick}
            onOpen={() =>
              void navigate({
                to: "/project/$projectId",
                params: { projectId: f._id },
              })
            }
          />
        ))}
      </SortableContext>
      <SortableContext
        items={col.chats.map((c) => `chat:${c._id}`)}
        strategy={verticalListSortingStrategy}
      >
        {col.chats.map((c) => (
          <ColumnChatEntry
            key={c._id}
            chat={c}
            folderId={col.folderId}
            busy={busyIds.has(c._id)}
            locate={c._id === locateChatId}
            suppressClick={suppressClick}
            onOpen={() =>
              void navigate({ to: "/chat/$chatId", params: { chatId: c._id } })
            }
          />
        ))}
      </SortableContext>
      {col.folders.length === 0 && col.chats.length === 0 ? (
        <p className="oc-projpage__colempty">{m.project_page_empty_chats()}</p>
      ) : null}
    </div>
  );
}

function ColumnFolderEntry({
  folder,
  parentId,
  isCurrent,
  suppressClick,
  onOpen,
}: {
  folder: ColumnsData["columns"][number]["folders"][number];
  /** The column's level (this folder's current parent — for the move picker). */
  parentId: Id<"projects"> | null;
  isCurrent: boolean;
  suppressClick: React.MutableRefObject<boolean>;
  onOpen: () => void;
}) {
  const drag = useSortable({ id: `folder:${folder._id}` });
  const drop = useDroppable({ id: intoId(folder._id) });
  // A div, not a button: the row hosts the kebab-menu BUTTON (nested buttons
  // are invalid HTML), and dnd's attributes already provide the a11y role.
  return (
    <div
      ref={(el) => {
        drag.setNodeRef(el);
        drop.setNodeRef(el);
      }}
      className={
        "oc-projpage__colentry oc-projpage__colentry--folder" +
        (folder.selected || isCurrent ? " is-selected" : "") +
        (drop.isOver ? " is-over" : "") +
        (drag.isDragging ? " is-dragging" : "")
      }
      style={
        {
          "--proj-hue": projectHue(folder),
          transform: DndCSS.Transform.toString(drag.transform),
          transition: drag.transition,
        } as React.CSSProperties
      }
      onClick={() => {
        if (suppressClick.current) return;
        onOpen();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.target === e.currentTarget) onOpen();
      }}
      {...drag.listeners}
      {...drag.attributes}
      role="button"
      tabIndex={0}
    >
      <Folder size={13} aria-hidden className="oc-projpage__colico" />
      <span className="oc-projpage__colname">{folder.name}</span>
      <span className="oc-projpage__colchev" aria-hidden>
        ›
      </span>
      <FolderEntryMenu
        folderId={folder._id}
        name={folder.name}
        color={folder.color}
        currentParentId={parentId}
        className="oc-projpage__colmenu"
        onOpen={onOpen}
      />
    </div>
  );
}

function ColumnChatEntry({
  chat,
  folderId,
  busy,
  locate,
  suppressClick,
  onOpen,
}: {
  chat: PageChat;
  /** The column's level (this chat's current folder; null = unfiled). */
  folderId: Id<"projects"> | null;
  busy: boolean;
  locate: boolean;
  suppressClick: React.MutableRefObject<boolean>;
  onOpen: () => void;
}) {
  const drag = useSortable({ id: `chat:${chat._id}` });
  const locateRef = useLocateRef<HTMLDivElement>(locate);
  const hue = colorHue(chat.color);
  return (
    <div
      ref={(el) => {
        drag.setNodeRef(el);
        locateRef.current = el;
      }}
      className={
        "oc-projpage__colentry oc-projpage__colentry--chat" +
        (drag.isDragging ? " is-dragging" : "") +
        (locate ? " is-locate" : "")
      }
      style={{
        transform: DndCSS.Transform.toString(drag.transform),
        transition: drag.transition,
      }}
    >
      <button
        type="button"
        className="oc-projpage__colchatbtn"
        onClick={() => {
          if (suppressClick.current) return;
          onOpen();
        }}
        {...drag.listeners}
        {...drag.attributes}
      >
        {hue ? (
          <span className="oc-chatitem__dot" style={{ background: hue }} />
        ) : (
          <span className="oc-chatitem__dot oc-chatitem__dot--empty" />
        )}
        <span className="oc-projpage__colname">
          {chat.title || m.sidebar_untitled()}
        </span>
        {busy ? (
          <span className="oc-chatitem__busy" aria-hidden />
        ) : null}
      </button>
      <ChatEntryMenu
        chat={chat}
        currentFolderId={folderId}
        className="oc-projpage__colmenu oc-projpage__colmenu--chat"
      />
      <SidebarToggle chat={chat} />
    </div>
  );
}
