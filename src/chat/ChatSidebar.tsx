import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { APP_HOST } from "@/lib/appHost";
import { useMutation, useQuery } from "convex/react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
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
  { value: "red", hue: "oklch(0.63 0.21 25)" },
  { value: "orange", hue: "oklch(0.7 0.17 50)" },
  { value: "amber", hue: "oklch(0.8 0.15 85)" },
  { value: "green", hue: "oklch(0.7 0.16 150)" },
  { value: "teal", hue: "oklch(0.7 0.12 190)" },
  { value: "blue", hue: "oklch(0.62 0.19 250)" },
  { value: "violet", hue: "oklch(0.6 0.2 300)" },
  { value: "pink", hue: "oklch(0.7 0.2 350)" },
];
const colorHue = (c: string | null | undefined) =>
  CHAT_COLORS.find((x) => x.value === c)?.hue ?? null;

// Droppable id scheme: a chat may be dropped onto a project section
// ("project:<id>") or the no-project section ("project:none"). Reorder within a
// section is detected when `over` is another chat id.
const NO_PROJECT = "project:none";
const projDropId = (pid: string) => `project:${pid}`;
const COLLAPSE_KEY = "oc.noproject.collapsed";

export type ChatRow = {
  _id: Id<"chats">;
  title?: string;
  projectId: Id<"projects"> | null;
  sortKey: number;
  pinned: boolean;
  color: string | null;
  updatedAt: number; // for the compact relative-age label (gated by showChatAge)
  // The bridge this chat routes to (bound instance, else the user's default).
  // Drives the self-hiding provider badge (shown only when chats span >1 kind).
  providerKind: "openclaw" | "hermes" | null;
};
type Project = { _id: Id<"projects">; name: string; collapsed: boolean };

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
  // Self-hiding bridge badge: only meaningful when the user's conversations span
  // MORE THAN ONE provider (today everything is OpenClaw → distinct kinds = 1 →
  // hidden; lights up automatically once Hermes chats exist). Gated ALSO by the
  // `showChatProvider` pref. Computed once here and threaded to each row.
  const effectivePrefs = useQuery(api.me.getMe, { host: APP_HOST })?.ui?.effective as
    | Record<string, boolean>
    | undefined;
  const showProviderPref = effectivePrefs?.showChatProvider ?? true;
  const showAgePref = effectivePrefs?.showChatAge ?? true;
  const providerKinds = new Set(
    (chats ?? []).map((c) => c.providerKind).filter((k): k is "openclaw" | "hermes" => k != null),
  );
  const showProviderBadge = showProviderPref && providerKinds.size > 1;

  // The relative-age labels read `Date.now()` at render — without a tick an idle
  // session would freeze a chat at "maintenant". Re-render on a minute cadence so
  // the ages advance. Only armed when the age labels are actually shown.
  const [, setMinuteTick] = useState(0);
  useEffect(() => {
    if (!showAgePref) return;
    const id = window.setInterval(() => setMinuteTick((t) => t + 1), 60_000);
    return () => window.clearInterval(id);
  }, [showAgePref]);
  const createProject = useMutation(api.projects.createProject);
  const setProjectCollapsed = useMutation(api.projects.setProjectCollapsed);
  const reorderChat = useMutation(api.chats.reorderChat);
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

  const [activeDragId, setActiveDragId] = useState<Id<"chats"> | null>(null);
  const [noProjectCollapsed, setNoProjectCollapsed] = useState(
    () => localStorage.getItem(COLLAPSE_KEY) === "1",
  );
  function toggleNoProject() {
    setNoProjectCollapsed((c) => {
      localStorage.setItem(COLLAPSE_KEY, c ? "0" : "1");
      return !c;
    });
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const pinned = rows.filter((c) => c.pinned);
  const unpinned = rows.filter((c) => !c.pinned);
  const byProject = (pid: string | null) =>
    unpinned.filter((c) => (c.projectId ?? null) === pid);

  function findChat(id: string) {
    return rows.find((c) => c._id === id);
  }

  async function handleDragEnd(e: DragEndEvent) {
    setActiveDragId(null);
    const { active, over } = e;
    if (!over) return;
    const moved = findChat(String(active.id));
    if (!moved) return;
    const overId = String(over.id);

    // Case 1: dropped onto a section container (assign to project).
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
        collisionDetection={closestCorners}
        modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
        onDragStart={(e: DragStartEvent) =>
          setActiveDragId(e.active.id as Id<"chats">)
        }
        onDragCancel={() => setActiveDragId(null)}
        onDragEnd={handleDragEnd}
      >
        <div className="oc-sidebar__scroll">
          {pinned.length > 0 ? (
            <Section label={m.sidebar_pinned()} chats={pinned}>
              {pinned.map((c) => (
                <ChatItem
                  key={c._id}
                  chat={c}
                  active={c._id === activeChatId}
                  projects={projects ?? []}
                  onSelect={onSelect}
                  showProviderBadge={showProviderBadge}
                />
              ))}
            </Section>
          ) : null}

          {(projects ?? []).map((p) => {
            const ch = byProject(p._id);
            return (
              <Section
                key={p._id}
                label={p.name}
                dropId={projDropId(p._id)}
                projectId={p._id}
                chats={ch}
                collapsible
                collapsed={p.collapsed}
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
                      projects={projects ?? []}
                      onSelect={onSelect}
                      showProviderBadge={showProviderBadge}
                    />
                  ))
                )}
              </Section>
            );
          })}

          <Section
            label={m.sidebar_chats()}
            dropId={NO_PROJECT}
            chats={byProject(null)}
            collapsible
            collapsed={noProjectCollapsed}
            onToggle={toggleNoProject}
          >
            {!noProjectCollapsed
              ? byProject(null).map((c) => (
                  <ChatItem
                    key={c._id}
                    chat={c}
                    active={c._id === activeChatId}
                    projects={projects ?? []}
                    onSelect={onSelect}
                    showProviderBadge={showProviderBadge}
                  />
                ))
              : null}
          </Section>
        </div>

        <DragOverlay>
          {activeChat ? (
            <div className="oc-chatitem oc-chatitem--overlay">
              <GripVertical className="size-3.5 opacity-60" />
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
  projectId,
  chats,
  collapsible,
  collapsed,
  onToggle,
  children,
}: {
  label: string;
  dropId?: string;
  projectId?: Id<"projects">;
  chats: ChatRow[];
  collapsible?: boolean;
  collapsed?: boolean;
  onToggle?: () => void;
  children: React.ReactNode;
}) {
  const deleteProject = useMutation(api.projects.deleteProject);
  const confirm = useConfirm();
  const count = useQuery(
    api.projects.projectChatCount,
    projectId ? { projectId } : "skip",
  ) as number | undefined;
  const { setNodeRef, isOver } = useDroppable({ id: dropId ?? `static:${label}` });

  // The toggle area is a clickable div (role=button) — NOT a <button> — so the
  // "delete project" <button> can live inside it without nesting buttons
  // (invalid HTML / hydration error).
  const onKeyToggle = (e: React.KeyboardEvent) => {
    if (collapsible && onToggle && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      onToggle();
    }
  };

  return (
    <div
      ref={dropId ? setNodeRef : undefined}
      className={"oc-sidebar__group" + (isOver ? " oc-sidebar__group--over" : "")}
    >
      <div
        className={
          "oc-sidebar__group-head" +
          (collapsible ? " oc-sidebar__group-head--btn" : "")
        }
        {...(collapsible
          ? { role: "button", tabIndex: 0, onClick: onToggle, onKeyDown: onKeyToggle }
          : {})}
      >
        {collapsible ? (
          collapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />
        ) : null}
        <span className="oc-sidebar__group-label">{label}</span>
        {projectId ? (
          <button
            className="oc-sidebar__group-del"
            aria-label={m.sidebar_delete_project()}
            onClick={async (e) => {
              e.stopPropagation();
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
            }}
          >
            <Trash2 className="size-3.5" />
          </button>
        ) : null}
      </div>
      <SortableContext
        items={chats.map((c) => c._id)}
        strategy={verticalListSortingStrategy}
      >
        {children}
      </SortableContext>
    </div>
  );
}

const PROVIDER_LABEL: Record<"openclaw" | "hermes", string> = {
  openclaw: "OpenClaw",
  hermes: "Hermes",
};

function ChatItem({
  chat,
  active,
  projects: _projects,
  onSelect,
  showProviderBadge,
}: {
  chat: ChatRow;
  active: boolean;
  projects: Project[];
  onSelect: (id: Id<"chats">) => void;
  showProviderBadge: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: chat._id });
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
        ref={setNodeRef}
        style={style}
        className={
          "oc-chatitem group/row" + (active ? " oc-chatitem--active" : "")
        }
      >
        <button
          className="oc-chatitem__grip"
          aria-label={m.sidebar_reorder()}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-3.5" />
        </button>
        {hue ? (
          <span className="oc-chatitem__dot" style={{ background: hue }} />
        ) : (
          <span className="oc-chatitem__dot oc-chatitem__dot--empty" />
        )}
        <button className="oc-chatitem__label" onClick={() => onSelect(chat._id)}>
          {chat.title || m.sidebar_untitled()}
        </button>
        {showProviderBadge && chat.providerKind ? (
          // Self-hiding: the parent only sets showProviderBadge when chats span
          // >1 bridge. Fades on hover (like the age) to make room for the kebab.
          <span
            className={`oc-chatitem__bridge oc-chatitem__bridge--${chat.providerKind} group-hover/row:opacity-0 group-focus-within/row:opacity-0`}
            title={m.sidebar_bridge_title({ provider: PROVIDER_LABEL[chat.providerKind] })}
          >
            {PROVIDER_LABEL[chat.providerKind]}
          </span>
        ) : null}
        {showAge ? (
          // Visible at rest; fades out on row hover/focus so it never collides
          // with the kebab menu that fades in (same swap as OpenWebUI).
          <span
            className="oc-chatitem__age group-hover/row:opacity-0 group-focus-within/row:opacity-0"
            title={new Date(chat.updatedAt).toLocaleString("fr-FR")}
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
            >
              <MoreVertical />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
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
}
