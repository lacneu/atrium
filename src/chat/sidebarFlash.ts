// One-shot sidebar highlight: branching a conversation (chatFork) keeps the
// user IN the current chat, so the only feedback is a brief flash on the new
// row in the left panel — the eye finds where the branch landed and can click
// it later. A tiny module store (useSyncExternalStore) rather than a context:
// the trigger lives deep in the message tree while the sidebar sits in the
// persistent chrome, and no ancestor of both owns this state.

import { useSyncExternalStore } from "react";

let current: string | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** Ask the sidebar to flash this chat's row (replaces any previous flash). */
export function flashSidebarChat(chatId: string): void {
  current = chatId;
  emit();
}

/** Clear the flash — called by the row when its animation ends (or by the
 *  fallback timer where animations are disabled). Guarded: a newer flash for
 *  another chat is never cleared by a stale row's animation end. */
export function clearSidebarFlash(chatId: string): void {
  if (current !== chatId) return;
  current = null;
  emit();
}

/** The chat id currently flashing, or null. */
export function useSidebarFlashChatId(): string | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    () => current,
  );
}
