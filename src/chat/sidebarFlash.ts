// One-shot sidebar highlight: branching a conversation (chatFork) keeps the
// user IN the current chat, so the only feedback is a brief flash on the new
// row in the left panel — the eye finds where the branch landed and can click
// it later. A tiny module store (useSyncExternalStore) rather than a context:
// the trigger lives deep in the message tree while the sidebar sits in the
// persistent chrome, and no ancestor of both owns this state.

import { useSyncExternalStore } from "react";

export type SidebarFlash = {
  chatId: string;
  /** Whether the sidebar may UNFOLD the section holding the chat so the flash
   *  is visible. True for "locate me" flashes (a branch just landed there);
   *  false for arrival heads-ups — a reply landing in a chat the user chose to
   *  fold must NOT reopen the folder (the folded aggregate dot/pulse carries
   *  the signal instead). */
  expand: boolean;
};

let current: SidebarFlash | null = null;
const listeners = new Set<() => void>();
let expiry: ReturnType<typeof setTimeout> | null = null;

// Self-expiry: when the flashed row never mounts (folded project, collapsed
// sidebar, Settings route), no animation-end ever clears the store — without
// a TTL the stale flash would fire whenever the row finally mounts, long
// after the arrival. Slightly above the row animation + scroll budget.
const FLASH_TTL_MS = 4_000;

function emit(): void {
  for (const l of listeners) l();
}

/** Ask the sidebar to flash this chat's row (replaces any previous flash). */
export function flashSidebarChat(
  chatId: string,
  opts?: { expand?: boolean },
): void {
  current = { chatId, expand: opts?.expand === true };
  if (expiry !== null) clearTimeout(expiry);
  expiry = setTimeout(() => {
    expiry = null;
    current = null;
    emit();
  }, FLASH_TTL_MS);
  emit();
}

/** Clear the flash — called by the row when its animation ends (or by the
 *  fallback timer where animations are disabled). Guarded: a newer flash for
 *  another chat is never cleared by a stale row's animation end. */
export function clearSidebarFlash(chatId: string): void {
  if (current?.chatId !== chatId) return;
  if (expiry !== null) {
    clearTimeout(expiry);
    expiry = null;
  }
  current = null;
  emit();
}

/** Current flash value (the hook's snapshot) — exported for pure unit tests. */
export function getSidebarFlash(): SidebarFlash | null {
  return current;
}

/** The flash currently active, or null. */
export function useSidebarFlash(): SidebarFlash | null {
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
