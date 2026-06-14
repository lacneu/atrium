import type { OptimisticLocalStore } from "convex/browser";
import type { Id } from "./convexApi";
import { api } from "./convexApi";

// OPTIMISTIC truncation for messages.deleteMessage — the delete-side twin of
// the send path's optimistic echo (useConvexChatRuntime). Without it the
// deleted turn only disappears AFTER the mutation round-trip (delete cascade +
// network), a multi-second void on a constrained backend where the user cannot
// tell the click registered.
//
// Mirrors the server's TRUNCATE-FORWARD semantics exactly (convex/messages.ts
// deleteMessage): the target message AND every later one in the same chat drop
// from the local listByChat cache on the next frame. Convex atomically swaps
// in the real server result when the mutation commits, and AUTO-ROLLS-BACK the
// truncation if it throws (e.g. the "wait for the reply to settle" streaming
// guard) — the messages visibly snap back, and the caller surfaces the error.
//
// The mutation args carry only messageId, so the chat is FOUND, not passed:
// scan the cached listByChat entries for the one containing the target. Pure —
// unit-tested against a fake store (deleteMessageOptimistic.test.ts).
export function deleteMessageOptimisticUpdate(
  store: OptimisticLocalStore,
  { messageId }: { messageId: Id<"messages"> },
): void {
  for (const { args, value } of store.getAllQueries(api.messages.listByChat)) {
    if (value === undefined) continue;
    const target = value.find((msg) => msg._id === messageId);
    if (target === undefined) continue;
    const cutoff = target._creationTime;
    store.setQuery(
      api.messages.listByChat,
      args,
      value.filter((msg) => msg._creationTime < cutoff),
    );
  }
}
