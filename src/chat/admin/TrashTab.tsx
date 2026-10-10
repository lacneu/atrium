// Settings › Trash (admin): every user's trash, soonest purge first. An admin may
// restore or purge any conversation in it; both are audit-logged server-side
// (trash.adminRestoreChat / adminPurgeChat), and requireAdmin is the boundary —
// this tab is a convenience.

import { useMutation, usePaginatedQuery } from "convex/react";
import { api } from "../convexApi";
import { TRASH_PAGE, TrashList, TrashLoadMore } from "../TrashList";
import { useTrashRetentionDays } from "../trashView";
import { m } from "@/paraglide/messages.js";
import "../trashPage.css";
import { BlobSweepCard } from "./BlobSweepCard";

export function TrashTab() {
  const { results: rows, status, loadMore } = usePaginatedQuery(
    api.trash.adminListTrash,
    {},
    { initialNumItems: TRASH_PAGE },
  );
  const days = useTrashRetentionDays();
  const restore = useMutation(api.trash.adminRestoreChat);
  const purge = useMutation(api.trash.adminPurgeChat);
  return (
    <div className="oc-trash__body">
      <p className="oc-trash__hint">{m.trash_admin_intro({ days })}</p>
      {status === "LoadingFirstPage" ? (
        <p className="oc-trash__hint">{m.app_loading()}</p>
      ) : rows.length === 0 ? (
        <p className="oc-trash__empty">{m.trash_admin_is_empty()}</p>
      ) : (
        <TrashList
          items={rows}
          onRestore={(chatId) => restore({ chatId })}
          onPurge={(chatId) => purge({ chatId })}
        />
      )}
      <TrashLoadMore status={status} loadMore={loadMore} />
      <BlobSweepCard />
    </div>
  );
}
