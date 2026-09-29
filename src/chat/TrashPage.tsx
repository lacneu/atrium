// THE TRASH (route /trash): the caller's deleted conversations, each restorable
// until its purge date, then gone for good with their files (convex/trash.ts).
// The admin's view of every trash (Settings › Trash) reuses TrashList.

import { useMutation, usePaginatedQuery } from "convex/react";
import { RotateCcw, Trash2 } from "lucide-react";
import { api } from "./convexApi";
import type { Id } from "./convexApi";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ConfirmDialog";
import { formatDate } from "@/lib/format";
import { m } from "@/paraglide/messages.js";
import { formatTrashDay, useTrashRetentionDays } from "./trashView";
import "./trashPage.css";

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

export function TrashPage() {
  const { results: items, status, loadMore } = usePaginatedQuery(
    api.trash.listMyTrash,
    {},
    { initialNumItems: TRASH_PAGE },
  );
  const days = useTrashRetentionDays();
  const restore = useMutation(api.trash.restoreChat);
  const purge = useMutation(api.trash.purgeChat);
  const empty = useMutation(api.trash.emptyTrash);
  const confirm = useConfirm();
  return (
    <div className="oc-trash">
      <div className="oc-trash__body">
        <header className="oc-trash__head">
          <h1 className="oc-trash__heading">
            <Trash2 className="size-5" aria-hidden /> {m.trash_title()}
          </h1>
          {items.length > 0 ? (
            <Button
              variant="destructive"
              size="sm"
              onClick={async () => {
                const ok = await confirm({
                  title: m.trash_empty_confirm_title(),
                  description: m.trash_empty_confirm_desc(),
                  confirmLabel: m.trash_empty(),
                  destructive: true,
                });
                if (ok) await empty({});
              }}
            >
              {m.trash_empty()}
            </Button>
          ) : null}
        </header>
        <p className="oc-trash__hint">{m.trash_intro({ days })}</p>
        {status === "LoadingFirstPage" ? (
          <p className="oc-trash__hint">{m.app_loading()}</p>
        ) : items.length === 0 ? (
          <p className="oc-trash__empty">{m.trash_is_empty()}</p>
        ) : (
          <TrashList
            items={items}
            onRestore={(chatId) => restore({ chatId })}
            onPurge={(chatId) => purge({ chatId })}
          />
        )}
        <TrashLoadMore status={status} loadMore={loadMore} />
      </div>
    </div>
  );
}
