// Context menus of the folder page — ONE implementation reused by every view
// (cards / columns / list), so folders and chats are configurable wherever
// they appear, not only on the current folder's header.
//   FolderEntryMenu: open, rename, new sub-folder, move, color, delete.
//   ChatEntryMenu:   rename, pin, move, show/remove from sidebar, delete.
// Every trigger stops propagation (the rows they sit on navigate/drag).

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  FolderInput,
  FolderOpen,
  FolderPlus,
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
import { useConfirm, usePrompt } from "@/components/ConfirmDialog";
import { api } from "./convexApi";
import type { Id } from "./convexApi";
import { EntitySheet } from "./admin/EntitySheet";
import { FolderTreePicker } from "./FolderTreePicker";
import { CHAT_COLORS } from "./sidebarPalette";

/** Kebab trigger shared by both menus (hover-revealed via the caller's CSS
 *  class; propagation stopped so the host row never navigates/drags). */
function KebabTrigger({ className }: { className?: string }) {
  return (
    <DropdownMenuTrigger asChild>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={m.sidebar_actions()}
        className={className}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <MoreVertical />
      </Button>
    </DropdownMenuTrigger>
  );
}

export function FolderEntryMenu({
  folderId,
  name,
  color,
  currentParentId,
  className,
  onOpen,
}: {
  folderId: Id<"projects">;
  name: string;
  color: string | null;
  /** The folder's CURRENT parent (checked entry in the move picker). */
  currentParentId: Id<"projects"> | null;
  className?: string;
  onOpen: () => void;
}) {
  const renameProject = useMutation(api.projects.renameProject);
  const setProjectColor = useMutation(api.projects.setProjectColor);
  const moveProject = useMutation(api.projects.moveProject);
  const deleteProject = useMutation(api.projects.deleteProject);
  const createProject = useMutation(api.projects.createProject);
  const confirm = useConfirm();
  const prompt = usePrompt();
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState(name);
  const [moveOpen, setMoveOpen] = useState(false);
  // Recursive counts only load once the menu has been opened — a page full of
  // folder entries must not fan out one count query per row up front.
  const [everOpened, setEverOpened] = useState(false);
  const treeCount = useQuery(
    api.projects.projectTreeCount,
    everOpened ? { projectId: folderId } : "skip",
  ) as { folders: number; chats: number } | undefined;

  return (
    <>
      <DropdownMenu onOpenChange={(o) => o && setEverOpened(true)}>
        <KebabTrigger className={className} />
        <DropdownMenuContent
          align="end"
          className="w-48"
          onClick={(e) => e.stopPropagation()}
        >
          <DropdownMenuItem onSelect={() => onOpen()}>
            <FolderOpen /> {m.sidebar_open_folder()}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              setRenameValue(name);
              setRenameOpen(true);
            }}
          >
            <Pencil /> {m.sidebar_rename()}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              requestAnimationFrame(async () => {
                const sub = await prompt({
                  title: m.sidebar_new_subfolder(),
                  label: m.sidebar_project_name_label(),
                  placeholder: m.sidebar_project_name_placeholder(),
                  confirmLabel: m.sidebar_create(),
                });
                if (sub) await createProject({ name: sub, parentId: folderId });
              });
            }}
          >
            <FolderPlus /> {m.sidebar_new_subfolder()}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setMoveOpen(true)}>
            <FolderInput /> {m.sidebar_move_folder_to()}
          </DropdownMenuItem>
          <DropdownMenuLabel>{m.sidebar_color()}</DropdownMenuLabel>
          <div className="oc-colorgrid" onClick={(e) => e.stopPropagation()}>
            <button
              className="oc-colorgrid__none"
              onClick={() =>
                void setProjectColor({ projectId: folderId, color: null })
              }
              aria-label={m.sidebar_no_color()}
            >
              ✕
            </button>
            {CHAT_COLORS.map((c) => (
              <button
                key={c.value}
                className={
                  "oc-colorgrid__dot" + (color === c.value ? " is-selected" : "")
                }
                style={{ background: c.hue }}
                aria-label={c.value}
                onClick={() =>
                  void setProjectColor({
                    projectId: folderId,
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
                const folders = treeCount?.folders ?? 0;
                const chats = treeCount?.chats ?? 0;
                const ok = await confirm({
                  title: m.sidebar_delete_project_confirm_title({ name }),
                  description:
                    folders > 0
                      ? m.sidebar_delete_project_confirm_desc_tree({
                          folders,
                          chats,
                        })
                      : chats > 0
                        ? m.sidebar_delete_project_confirm_desc({ count: chats })
                        : m.sidebar_action_irreversible(),
                  confirmWord: m.sidebar_delete(),
                  confirmLabel: m.sidebar_delete_project(),
                  destructive: true,
                });
                if (ok) await deleteProject({ projectId: folderId });
              });
            }}
          >
            <Trash2 /> {m.sidebar_delete()}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <EntitySheet
        open={renameOpen}
        onOpenChange={setRenameOpen}
        title={m.sidebar_rename_project_title()}
        canSubmit={renameValue.trim().length > 0}
        onSubmit={async () => {
          await renameProject({ projectId: folderId, name: renameValue.trim() });
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
          movingFolderId={folderId}
          currentId={currentParentId}
          onPick={(parentId) => void moveProject({ projectId: folderId, parentId })}
        />
      ) : null}
    </>
  );
}

export function ChatEntryMenu({
  chat,
  currentFolderId,
  className,
}: {
  chat: {
    _id: Id<"chats">;
    title: string | null;
    pinned: boolean;
    inSidebar: boolean;
  };
  /** The chat's current folder (checked entry in the move picker); null =
   *  unfiled (the column view's root level). */
  currentFolderId: Id<"projects"> | null;
  className?: string;
}) {
  const pinChat = useMutation(api.chats.pinChat);
  const deleteChat = useMutation(api.chats.deleteChat);
  const renameChat = useMutation(api.chats.renameChat);
  const setChatSidebar = useMutation(api.chats.setChatSidebar);
  const moveChatToProject = useMutation(api.chats.moveChatToProject);
  const confirm = useConfirm();
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState(chat.title ?? "");
  const [moveOpen, setMoveOpen] = useState(false);

  return (
    <>
      <DropdownMenu>
        <KebabTrigger className={className} />
        <DropdownMenuContent
          align="end"
          className="w-52"
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
            onSelect={() =>
              void pinChat({ chatId: chat._id, pinned: !chat.pinned })
            }
          >
            {chat.pinned ? <PinOff /> : <Pin />}
            {chat.pinned ? m.sidebar_unpin() : m.sidebar_pin()}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setMoveOpen(true)}>
            <FolderInput /> {m.sidebar_move_to_folder()}
          </DropdownMenuItem>
          {!(chat.pinned && chat.inSidebar) ? (
            <DropdownMenuItem
              onSelect={() =>
                void setChatSidebar({ chatId: chat._id, hidden: chat.inSidebar })
              }
            >
              {chat.inSidebar ? <PanelLeftClose /> : <PanelLeft />}
              {chat.inSidebar
                ? m.project_page_hide_from_bar()
                : m.project_page_show_in_bar()}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => {
              requestAnimationFrame(async () => {
                const ok = await confirm({
                  title: m.sidebar_delete_chat_confirm_title(),
                  description: m.sidebar_action_irreversible(),
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
      <EntitySheet
        open={renameOpen}
        onOpenChange={setRenameOpen}
        title={m.sidebar_rename_chat_title()}
        canSubmit={renameValue.trim().length > 0}
        onSubmit={async () => {
          await renameChat({ chatId: chat._id, title: renameValue.trim() });
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
          title={m.folder_picker_title_chat()}
          currentId={currentFolderId}
          onPick={(folderId) =>
            void moveChatToProject({ chatId: chat._id, projectId: folderId })
          }
        />
      ) : null}
    </>
  );
}
