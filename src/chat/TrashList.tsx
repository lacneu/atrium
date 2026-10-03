// The conversation trash listing, shared by the user's own trash (Settings ›
// Deleted conversations, DeletedChatsTab.tsx) and the admin's view of every
// trash (Settings › Trash, TrashTab.tsx). Each row is restorable until its purge
// date, then gone for good with its files (convex/trash.ts).

import { RotateCcw, Trash2 } from "lucide-react";
import type { Id } from "./convexApi";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ConfirmDialog";
import { formatDate } from "@/lib/format";
import { m } from "@/paraglide/messages.js";
import { formatTrashDay } from "./trashView";

export type TrashItem = {
  _id: Id<"chats">;
  title: string | null;
  trashedAt: number;
  purgeAfter: number | null;
  /** Whose conversation it is — the admin view only. */
  owner?: string;
};

/** Rows loaded per page of a trash listing (the server bounds it too). */
export const TRASH_PAGE = 50;

/** "Load more" under a paginated trash listing, while more remains. */
export function TrashLoadMore({
  status,
  loadMore,
}: {
  status: string;
  loadMore: (n: number) => void;
}) {
  if (status !== "CanLoadMore" && status !== "LoadingMore") return null;
  return (
    <Button
      variant="outline"
      size="sm"
      className="self-start"
      disabled={status === "LoadingMore"}
      onClick={() => loadMore(TRASH_PAGE)}
    >
      {m.trash_load_more()}
    </Button>
  );
}

/** One row per trashed conversation, with its two actions. */
export function TrashList({
  items,
  onRestore,
  onPurge,
}: {
  items: TrashItem[];
  onRestore: (chatId: Id<"chats">) => Promise<unknown>;
  onPurge: (chatId: Id<"chats">) => Promise<unknown>;
}) {
  const confirm = useConfirm();
  return (
    <ul className="oc-trash__list">
      {items.map((item) => (
        <li key={item._id} className="oc-trash__item">
          <div className="oc-trash__meta">
            <span className="oc-trash__title">{item.title || m.sidebar_untitled()}</span>
            <span className="oc-trash__dates">
              {item.owner !== undefined ? (
                <span className="oc-trash__owner">{item.owner} · </span>
              ) : null}
              {m.trash_deleted_on({ date: formatDate(item.trashedAt) })}
              {item.purgeAfter !== null
                ? ` · ${m.trash_purge_on({ date: formatTrashDay(item.purgeAfter) })}`
                : null}
            </span>
          </div>
          <div className="oc-trash__actions">
            <Button variant="outline" size="sm" onClick={() => void onRestore(item._id)}>
              <RotateCcw /> {m.trash_restore()}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive"
              onClick={async () => {
                const ok = await confirm({
                  title: m.trash_purge_confirm_title(),
                  description: m.trash_purge_confirm_desc(),
                  confirmLabel: m.trash_purge(),
                  destructive: true,
                });
                if (ok) await onPurge(item._id);
              }}
            >
              <Trash2 /> {m.trash_purge()}
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}
