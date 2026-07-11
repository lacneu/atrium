import { useEffect, useRef } from "react";
import { useMutation, useQuery } from "convex/react";
import { APP_HOST } from "@/lib/appHost";
import { api } from "./convexApi";
import type { Id } from "./convexApi";
import { flashSidebarChat } from "./sidebarFlash";
import { playReplySound } from "./sounds";
import type { ChatRow } from "./ChatSidebar";

// Headless reply-arrival watcher — MOUNTED IN THE PERSISTENT CHROME, not in
// ChatSidebar: the sidebar unmounts when collapsed or in Settings, and a
// listener that dies with it would miss arrivals there AND re-baseline on
// remount (codex P2; same rule as the global shortcuts: "a global listener
// must live in persistent chrome"). Convex dedupes the listChats subscription
// with the sidebar's, so this adds no reads while both are mounted.
//
// On a chat's lastAssistantAt moving forward (a reply FINISHED):
//   - foreign chat  → one-shot row flash (visible whenever the sidebar is);
//   - active chat   → marked seen immediately (the user is looking at it);
//   - any chat      → optional reply sound (`replySound` pref, opt-in).
// First snapshot is a baseline: a page load must never flash/ding for history.
export function ChatArrivalWatcher({
  activeChatId,
}: {
  activeChatId: Id<"chats"> | null;
}) {
  const chats = useQuery(api.messages.listChats, {}) as ChatRow[] | undefined;
  const markSeen = useMutation(api.chatReads.markChatSeen);
  const me = useQuery(api.me.getMe, { host: APP_HOST });
  const replySoundOn = me?.ui?.effective?.replySound === true;
  // getMe.userId IS the effective identity: requireUserId returns
  // getActor().effectiveUserId (impersonation-aware) — it flips to the target
  // during impersonation, which is exactly what the rebaseline below needs.
  const effectiveUserId = me?.userId ?? null;

  const prevArrivals = useRef<Map<string, number> | null>(null);
  // Impersonation flips listChats to the TARGET user's chats without a
  // remount — the previous map would misread every recent target reply as a
  // fresh arrival (flash + sound). Re-baseline on effective-identity change.
  const baselineUserId = useRef<string | null>(null);
  useEffect(() => {
    if (!chats) return;
    if (baselineUserId.current !== String(effectiveUserId)) {
      baselineUserId.current = String(effectiveUserId);
      prevArrivals.current = null;
    }
    const next = new Map<string, number>();
    for (const c of chats) {
      if (c.lastAssistantAt !== null) next.set(c._id, c.lastAssistantAt);
    }
    const prev = prevArrivals.current;
    prevArrivals.current = next;
    if (prev === null) return; // baseline
    let arrived = false;
    for (const [id, at] of next) {
      const before = prev.get(id);
      if (before !== undefined && at <= before) continue;
      if (before === undefined) {
        // A chat newly entering the window with a reply older than 30s is
        // pagination noise, not an arrival.
        if (Date.now() - at > 30_000) continue;
      }
      arrived = true;
      // Mark the ACTIVE chat seen only when the tab is actually VISIBLE — a
      // reply landing in a hidden tab must keep its unread state until the
      // user really comes back (the visibilitychange handler below catches
      // up). A hidden-tab arrival on the active chat still flashes nothing
      // (the row is the active one) but keeps the sound cue meaningful.
      if (id === activeChatId && document.visibilityState === "visible") {
        void markSeen({ chatId: id as Id<"chats"> });
      } else if (id !== activeChatId) {
        flashSidebarChat(id);
      }
    }
    if (arrived && replySoundOn) playReplySound();
  }, [chats, activeChatId, replySoundOn, markSeen, effectiveUserId]);

  // Opening/switching to a chat marks it seen (clears its unread dot) — only
  // when the tab is visible (route changes are user gestures in practice; the
  // guard keeps programmatic background navigation honest).
  useEffect(() => {
    if (activeChatId && document.visibilityState === "visible") {
      void markSeen({ chatId: activeChatId });
    }
  }, [activeChatId, markSeen]);

  // Coming back to the foreground: the user is now LOOKING at the active chat
  // — consume its unread state (covers replies that landed while hidden).
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && activeChatId) {
        void markSeen({ chatId: activeChatId });
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [activeChatId, markSeen]);

  return null;
}
