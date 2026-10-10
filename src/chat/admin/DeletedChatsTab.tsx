// Settings › Deleted conversations (Personal group): the caller's OWN trash.
// Deleted conversations wait here, restorable, until their purge date; then they
// are gone for good with their files (convex/trash.ts — every function there is
// owner-scoped, which is the boundary; this tab is a convenience). The former
// /trash page redirects here (router.tsx).

import { useMutation, usePaginatedQuery } from "convex/react";
import { api } from "../convexApi";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ConfirmDialog";
import { m } from "@/paraglide/messages.js";
import { TRASH_PAGE, TrashList, TrashLoadMore } from "../TrashList";
import { useTrashRetentionDays } from "../trashView";
import "../trashPage.css";

export function DeletedChatsTab() {
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
    <div className="oc-trash__body">
      <div className="oc-trash__head">
        <p className="oc-trash__hint">{m.trash_intro({ days })}</p>
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
      </div>
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
  );
}
