// Conversation bookmarks (IntelliJ-style) — the interactive half. The pure
// rules (ordering, ring navigation, anchor resolution) live in bookmarkView.ts.
//
// Three surfaces, all fed by ONE per-chat query (chatBookmarks.getBookmarks):
//   - BookmarkGutter: hover a message block -> a gutter toggle appears (the
//     IntelliJ gesture); placed bookmarks render as persistent amber markers
//     with a rename/delete popover.
//   - BookmarkNavRail: a floating x/y + up/down rail (visible only when the
//     chat has bookmarks) + mod+shift+ArrowUp/Down shortcuts, wrap-around.
//   - Auto-resume: reopening the chat scrolls to the ACTIVE bookmark (last
//     placed or jumped-to) — the user's working position — unless a `?m=`
//     deep-link owns the landing.
//
// Anchors survive streaming/merges because a finished message only APPENDS
// blocks; a vanished block index falls back to the top of its message.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery } from "convex/react";
import { useMessage, useThread } from "@assistant-ui/react";
import { Bookmark, ChevronDown, ChevronUp, Trash2 } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { m } from "@/paraglide/messages.js";
import { api } from "./convexApi";
import type { Id } from "./convexApi";
import {
  anchorElement,
  collectAnchorBlocks,
  nearestBookmarkId,
  nextBookmarkId,
  orderBookmarks,
  previewFromText,
  type BookmarkView,
} from "./bookmarkView";
import {
  SHORTCUT_BOOKMARK_NEXT,
  SHORTCUT_BOOKMARK_PREV,
  isMac,
  matchesShortcut,
  shortcutLabel,
} from "@/lib/shortcuts";

interface BookmarksApi {
  rows: BookmarkView[];
  activeId: string | null;
  byMessage: ReadonlyMap<string, BookmarkView[]>;
  toggle: (messageId: string, blockIndex: number | null) => void;
  remove: (id: string) => void;
  rename: (id: string, label: string) => void;
  jumpTo: (bm: BookmarkView) => void;
  /** Record the working position WITHOUT scrolling (the scroll-follow rule:
   *  the bookmark nearest the viewport center becomes the active one). */
  setActiveQuiet: (id: string) => void;
}

const BookmarksContext = createContext<BookmarksApi | null>(null);

export function useBookmarks(): BookmarksApi | null {
  return useContext(BookmarksContext);
}

/** Scroll the thread viewport to a bookmark anchor and flash it. Retries
 *  while the thread mounts (same budget as the `?m=` deep-link focus). Only
 *  the thread's own viewport scrolls (scrollIntoView would drag every
 *  scrollable ancestor — the sub-agent panel lesson). */
function focusAnchor(
  messageId: string,
  blockIndex: number | null,
  behavior: ScrollBehavior,
  opts?: {
    /** Reveal mode (placing a bookmark): scroll ONLY when the anchor sits
     *  outside the viewport — placing from the gutter must not yank a page
     *  the user is already looking at; placing a MESSAGE bookmark from the
     *  bottom of a long reply must bring its top anchor back into view. */
    skipScrollIfVisible?: boolean;
  },
): () => void {
  let cancelled = false;
  let tries = 0;
  let timer = 0;
  const attempt = () => {
    if (cancelled) return;
    const bubble = document.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(messageId)}"]`,
    );
    if (bubble) {
      const target = anchorElement(bubble, blockIndex) as HTMLElement;
      const viewport = bubble.closest<HTMLElement>(".oc-thread__viewport");
      const alreadyVisible = (() => {
        if (!opts?.skipScrollIfVisible || !viewport) return false;
        const r = target.getBoundingClientRect();
        const v = viewport.getBoundingClientRect();
        return r.top >= v.top && r.top <= v.bottom - 48;
      })();
      if (alreadyVisible) {
        // fall through to the flash below without moving the page
      } else if (viewport) {
        const delta =
          target.getBoundingClientRect().top -
          viewport.getBoundingClientRect().top;
        viewport.scrollTo({
          top:
            viewport.scrollTop +
            delta -
            Math.max(24, viewport.clientHeight * 0.3),
          behavior,
        });
      } else {
        target.scrollIntoView({ block: "center", behavior });
      }
      const flashEl = blockIndex === null ? bubble : target;
      const cls = blockIndex === null ? "oc-msg--highlight" : "oc-anchor--flash";
      flashEl.classList.remove(cls);
      void (flashEl as HTMLElement).offsetWidth; // restart the keyframes
      flashEl.classList.add(cls);
      window.setTimeout(() => flashEl.classList.remove(cls), 2400);
      return;
    }
    if (tries++ < 40) timer = window.setTimeout(attempt, 150); // ~6s window
  };
  timer = window.setTimeout(attempt, 0);
  return () => {
    cancelled = true;
    window.clearTimeout(timer);
  };
}

export function BookmarksProvider({
  chatId,
  focusMessageId,
  children,
}: {
  chatId: string;
  focusMessageId: string | null;
  children: ReactNode;
}) {
  const view = useQuery(api.chatBookmarks.getBookmarks, {
    chatId: chatId as Id<"chats">,
  }) as
    | {
        bookmarks: {
          _id: string;
          messageId: string;
          blockIndex: number | null;
          label: string | null;
          createdAt: number;
        }[];
        activeBookmarkId: string | null;
      }
    | undefined;
  const toggleMut = useMutation(api.chatBookmarks.toggleBookmark);
  const removeMut = useMutation(api.chatBookmarks.removeBookmark);
  const renameMut = useMutation(api.chatBookmarks.renameBookmark);
  const setActiveMut = useMutation(api.chatBookmarks.setActiveBookmark);

  // OPTIMISTIC active id: a jump advances the ring LOCALLY before the
  // setActiveBookmark round-trip lands, so rapid clicks / a held shortcut
  // walk the ring instead of recomputing "next" from a stale server value.
  // Server truth reconciles (and clears the override) when it catches up or
  // the chat changes.
  const [localActiveId, setLocalActiveId] = useState<string | null>(null);
  useEffect(() => {
    setLocalActiveId(null);
  }, [chatId]);
  const serverActiveId = view?.activeBookmarkId ?? null;
  useEffect(() => {
    if (localActiveId !== null && serverActiveId === localActiveId) {
      setLocalActiveId(null);
    }
  }, [serverActiveId, localActiveId]);

  const rows = useMemo<BookmarkView[]>(
    () =>
      (view?.bookmarks ?? []).map((b) => ({
        id: b._id,
        messageId: b.messageId,
        blockIndex: b.blockIndex,
        label: b.label,
        createdAt: b.createdAt,
      })),
    [view?.bookmarks],
  );
  const activeId = localActiveId ?? serverActiveId;
  const byMessage = useMemo(() => {
    const map = new Map<string, BookmarkView[]>();
    for (const r of rows) {
      const list = map.get(r.messageId);
      if (list) list.push(r);
      else map.set(r.messageId, [r]);
    }
    return map;
  }, [rows]);

  const jumpTo = useCallback(
    (bm: BookmarkView) => {
      setLocalActiveId(bm.id);
      focusAnchor(bm.messageId, bm.blockIndex, "smooth");
      void setActiveMut({
        chatId: chatId as Id<"chats">,
        bookmarkId: bm.id as Id<"chatBookmarks">,
      });
    },
    [chatId, setActiveMut],
  );
  const setActiveQuiet = useCallback(
    (id: string) => {
      setLocalActiveId(id);
      void setActiveMut({
        chatId: chatId as Id<"chats">,
        bookmarkId: id as Id<"chatBookmarks">,
      });
    },
    [chatId, setActiveMut],
  );

  const apiValue = useMemo<BookmarksApi>(
    () => ({
      rows,
      activeId,
      byMessage,
      toggle: (messageId, blockIndex) =>
        void toggleMut({
          chatId: chatId as Id<"chats">,
          messageId: messageId as Id<"messages">,
          ...(blockIndex !== null ? { blockIndex } : {}),
        }).then((res) => {
          // PLACING focuses the anchor (flash; scroll only if offscreen):
          // a message-level bookmark set from the bottom of a long reply
          // anchors at its TOP, which may be far out of view (user report).
          if (res?.placed === true) {
            focusAnchor(messageId, blockIndex, "smooth", {
              skipScrollIfVisible: true,
            });
          }
        }),
      remove: (id) =>
        void removeMut({ bookmarkId: id as Id<"chatBookmarks"> }),
      rename: (id, label) =>
        void renameMut({ bookmarkId: id as Id<"chatBookmarks">, label }),
      jumpTo,
      setActiveQuiet,
    }),
    [
      rows,
      activeId,
      byMessage,
      chatId,
      toggleMut,
      removeMut,
      renameMut,
      jumpTo,
      setActiveQuiet,
    ],
  );

  // AUTO-RESUME: opening the chat lands on the active bookmark — the user's
  // working position — ONCE per chat, instantly (no smooth crawl through a
  // long thread). A `?m=` deep-link (feedback report / search hit) owns the
  // landing instead. Waits for the query (undefined = still loading).
  const resumedFor = useRef<string | null>(null);
  useEffect(() => {
    if (resumedFor.current === chatId) return;
    if (view === undefined) return;
    resumedFor.current = chatId;
    if (focusMessageId !== null) return;
    if (activeId === null) return;
    const bm = rows.find((r) => r.id === activeId);
    if (bm === undefined) return;
    return focusAnchor(bm.messageId, bm.blockIndex, "auto");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot per chat, keyed by the loaded query
  }, [chatId, view === undefined]);

  return (
    <BookmarksContext.Provider value={apiValue}>
      {children}
    </BookmarksContext.Provider>
  );
}

/** True for keyboard events the shortcuts must ignore: typing surfaces own
 *  their arrow keys (the composer textarea, rename inputs, dialogs). */
function isEditableTarget(e: KeyboardEvent): boolean {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return false;
  return (
    t.tagName === "INPUT" ||
    t.tagName === "TEXTAREA" ||
    t.isContentEditable
  );
}

/** A bookmark's list entry: its NAME when the user gave one, else the first
 *  words of the anchored block itself (read from the mounted DOM — list
 *  entries only render for reachable bookmarks). */
function bookmarkPreview(bm: BookmarkView): string {
  if (bm.label !== null && bm.label.length > 0) return bm.label;
  const bubble = document.querySelector<HTMLElement>(
    `[data-message-id="${CSS.escape(bm.messageId)}"]`,
  );
  if (bubble) {
    const text = previewFromText(
      anchorElement(bubble, bm.blockIndex).textContent ?? "",
    );
    if (text.length > 0) return text;
  }
  return m.bookmark_marker();
}

/** Floating navigation rail: x/y counter + previous/next (wrap-around), plus
 *  the keyboard ring. Renders nothing on a chat without bookmarks. */
export function BookmarkNavRail() {
  const bmApi = useBookmarks();
  // The nav order = the VISIBLE thread order. Message positions are read
  // from the DOM after commit (the bubbles carry data-message-id), re-read
  // when the message count or the bookmark set changes.
  const msgCount = useThread((t) => t.messages.length);
  const [ordered, setOrdered] = useState<BookmarkView[]>([]);
  const [unreachable, setUnreachable] = useState(0);
  const rows = bmApi?.rows;
  useEffect(() => {
    if (!rows || rows.length === 0) {
      setOrdered([]);
      setUnreachable(0);
      return;
    }
    let cancelled = false;
    let tries = 0;
    let timer = 0;
    const measure = () => {
      if (cancelled) return;
      const order = new Map<string, number>();
      document
        .querySelectorAll<HTMLElement>(
          ".oc-thread__viewport [data-message-id]",
        )
        .forEach((el, i) => order.set(el.dataset.messageId ?? "", i));
      const res = orderBookmarks(rows, order);
      setOrdered(res.ordered);
      setUnreachable(res.unreachableCount);
      // PAGE REFRESH lands bookmarks + messages in ONE burst, and this
      // effect can run before the thread painted its bubbles — the single
      // measurement then resolved nothing and no later dep change re-ran it
      // (live report: rail dead after refresh). Retry on the ?m= budget
      // while NOTHING resolves; one resolved bookmark = a usable ring.
      if (res.ordered.length === 0 && tries++ < 40) {
        timer = window.setTimeout(measure, 150);
      }
    };
    measure();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [rows, msgCount]);

  // SCROLL-FOLLOW: while the user scrolls, the "current" bookmark is the one
  // whose anchor sits closest to the viewport center — the counter tracks it
  // live, and after the scroll settles it is PERSISTED as the chat's active
  // bookmark (so switching conversations resumes at the nearest-read
  // position, the user's original ask). A grace window after a manual jump
  // keeps the smooth-scroll from re-targeting mid-flight.
  const [scrollNearestId, setScrollNearestId] = useState<string | null>(null);
  const jumpGraceRef = useRef(0);
  const pendingPersistRef = useRef<string | null>(null);
  const displayId =
    scrollNearestId !== null && ordered.some((b) => b.id === scrollNearestId)
      ? scrollNearestId
      : (bmApi?.activeId ?? null);
  useEffect(() => {
    if (!bmApi || ordered.length === 0) return;
    const vp = document.querySelector<HTMLElement>(".oc-thread__viewport");
    if (!vp) return;
    let raf = 0;
    let persistTimer = 0;
    const onScroll = () => {
      if (raf !== 0) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        if (Date.now() - jumpGraceRef.current < 1200) return;
        const vpRect = vp.getBoundingClientRect();
        const center = vpRect.top + vpRect.height / 2;
        const items: { id: string; center: number }[] = [];
        for (const bm of ordered) {
          const bubble = vp.querySelector<HTMLElement>(
            `[data-message-id="${CSS.escape(bm.messageId)}"]`,
          );
          if (!bubble) continue;
          const r = (
            anchorElement(bubble, bm.blockIndex) as HTMLElement
          ).getBoundingClientRect();
          items.push({ id: bm.id, center: (r.top + r.bottom) / 2 });
        }
        const nearest = nearestBookmarkId(items, center);
        if (nearest === null) return;
        setScrollNearestId(nearest);
        pendingPersistRef.current = nearest !== bmApi.activeId ? nearest : null;
        window.clearTimeout(persistTimer);
        persistTimer = window.setTimeout(() => {
          const id = pendingPersistRef.current;
          pendingPersistRef.current = null;
          if (id !== null) bmApi.setActiveQuiet(id);
        }, 800);
      });
    };
    vp.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      vp.removeEventListener("scroll", onScroll);
      if (raf !== 0) window.cancelAnimationFrame(raf);
      window.clearTimeout(persistTimer);
      // FLUSH on unmount/switch: a scroll settled <800ms before leaving must
      // still persist — it IS the position the user expects to come back to.
      const id = pendingPersistRef.current;
      pendingPersistRef.current = null;
      if (id !== null) bmApi.setActiveQuiet(id);
    };
  }, [bmApi, ordered]);

  const jumpToBookmark = useCallback(
    (bm: BookmarkView) => {
      if (!bmApi) return;
      jumpGraceRef.current = Date.now();
      setScrollNearestId(bm.id);
      bmApi.jumpTo(bm);
    },
    [bmApi],
  );
  const jump = useCallback(
    (dir: 1 | -1) => {
      const nextId = nextBookmarkId(
        ordered.map((b) => b.id),
        displayId,
        dir,
      );
      const bm = ordered.find((b) => b.id === nextId);
      if (bm) jumpToBookmark(bm);
    },
    [ordered, displayId, jumpToBookmark],
  );

  useEffect(() => {
    if (ordered.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e)) return;
      if (matchesShortcut(e, SHORTCUT_BOOKMARK_PREV)) {
        e.preventDefault();
        jump(-1);
      } else if (matchesShortcut(e, SHORTCUT_BOOKMARK_NEXT)) {
        e.preventDefault();
        jump(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ordered.length, jump]);

  if (!bmApi || bmApi.rows.length === 0) return null;
  const at = ordered.findIndex((b) => b.id === displayId);
  const counter = `${at === -1 ? "–" : at + 1}/${ordered.length}`;
  return (
    <div
      className="oc-bmk-rail"
      role="navigation"
      aria-label={m.bookmark_rail_label()}
      title={
        unreachable > 0
          ? m.bookmark_unreachable({ count: String(unreachable) })
          : undefined
      }
    >
      <Button
        variant="ghost"
        size="icon"
        className="oc-bmk-rail__btn"
        onClick={() => jump(-1)}
        disabled={ordered.length === 0}
        title={`${m.bookmark_nav_prev()} (${shortcutLabel(SHORTCUT_BOOKMARK_PREV, isMac())})`}
        aria-label={m.bookmark_nav_prev()}
      >
        <ChevronUp size={14} />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="oc-bmk-rail__count"
            title={m.bookmark_open_list()}
            aria-label={m.bookmark_open_list()}
          >
            <Bookmark size={11} aria-hidden />
            <span aria-live="polite">{counter}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="left"
          align="center"
          className="oc-bmk-menu"
        >
          {ordered.map((bm) => (
            <DropdownMenuItem
              key={bm.id}
              className={
                bm.id === displayId ? "oc-bmk-menu__item--current" : undefined
              }
              onSelect={() => jumpToBookmark(bm)}
            >
              <Bookmark size={12} aria-hidden className="oc-bmk-menu__flag" />
              <span className="oc-bmk-menu__text">{bookmarkPreview(bm)}</span>
            </DropdownMenuItem>
          ))}
          {unreachable > 0 ? (
            <div className="oc-bmk-menu__foot">
              {m.bookmark_unreachable({ count: String(unreachable) })}
            </div>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        variant="ghost"
        size="icon"
        className="oc-bmk-rail__btn"
        onClick={() => jump(1)}
        disabled={ordered.length === 0}
        title={`${m.bookmark_nav_next()} (${shortcutLabel(SHORTCUT_BOOKMARK_NEXT, isMac())})`}
        aria-label={m.bookmark_nav_next()}
      >
        <ChevronDown size={14} />
      </Button>
    </div>
  );
}

interface HoverState {
  top: number;
  blockIndex: number;
}

/** Per-bubble gutter: hover a markdown block -> a toggle appears at its left
 *  (IntelliJ gesture); every placed bookmark renders a persistent marker with
 *  a rename/delete popover. Rendered as a PORTAL into the bubble's body (the
 *  component itself mounts in the message chrome, after the body). Assistant
 *  bubbles only — user messages bookmark at message level via the action bar. */
export function BookmarkGutter({
  messageLevelMarkers = true,
}: {
  /** FALSE on assistant bubbles: their whole-message bookmark is represented
   *  by the header flag next to the agent name — a second margin marker at
   *  the top of the body was redundant (user report). */
  messageLevelMarkers?: boolean;
} = {}) {
  const bmApi = useBookmarks();
  const messageId = useMessage((msg) => msg.id);
  const streaming = useMessage((msg) => msg.status?.type === "running");
  const sentinelRef = useRef<HTMLSpanElement | null>(null);
  const [body, setBody] = useState<HTMLElement | null>(null);
  const [hover, setHover] = useState<HoverState | null>(null);
  const [markerTops, setMarkerTops] = useState<ReadonlyMap<string, number>>(
    new Map(),
  );
  const allMine = bmApi?.byMessage.get(messageId);
  const mine = useMemo(
    () =>
      messageLevelMarkers
        ? allMine
        : allMine?.filter((b) => b.blockIndex !== null),
    [allMine, messageLevelMarkers],
  );

  // Locate the bubble body once mounted (the portal target + hover surface).
  // USER bubbles have no .oc-msg__body — their .oc-msg__bubble hosts the
  // markers instead (message-level only: no .oc-md inside, so the per-block
  // hover never triggers there).
  useEffect(() => {
    const root = sentinelRef.current?.closest<HTMLElement>(".oc-msg");
    setBody(
      root?.querySelector<HTMLElement>(".oc-msg__body") ??
        root?.querySelector<HTMLElement>(".oc-msg__bubble") ??
        null,
    );
  }, [messageId]);

  // Hover tracking: which top-level block is under the pointer. Disabled
  // while the message streams (block indexes are still moving).
  // Listeners sit on the whole BUBBLE (.oc-msg), not the text body: the
  // gutter button floats in the margin OUTSIDE the body, so a body-scoped
  // mouseleave fired the instant the pointer travelled TOWARD the button and
  // it vanished under the cursor (live report). A small vertical tolerance
  // keeps the button up while the pointer rides its own edge.
  useEffect(() => {
    if (!body || streaming || !bmApi) return;
    const surface = body.closest<HTMLElement>(".oc-msg") ?? body;
    let raf = 0;
    const onMove = (e: MouseEvent) => {
      if (raf !== 0) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        const blocks = collectAnchorBlocks(body);
        const bodyTop = body.getBoundingClientRect().top;
        let nearest: { top: number; blockIndex: number } | null = null;
        let nearestDist = Infinity;
        for (let i = 0; i < blocks.length; i++) {
          const r = blocks[i]!.getBoundingClientRect();
          if (e.clientY >= r.top && e.clientY <= r.bottom) {
            setHover({ top: r.top - bodyTop, blockIndex: i });
            return;
          }
          const d =
            e.clientY < r.top ? r.top - e.clientY : e.clientY - r.bottom;
          if (d < nearestDist) {
            nearestDist = d;
            nearest = { top: r.top - bodyTop, blockIndex: i };
          }
        }
        // Between blocks / on the button's own overhang: snap to the nearest
        // block within a small radius instead of dropping the button.
        setHover(nearestDist <= 16 ? nearest : null);
      });
    };
    const onLeave = () => {
      if (raf !== 0) {
        window.cancelAnimationFrame(raf);
        raf = 0;
      }
      setHover(null);
    };
    surface.addEventListener("mousemove", onMove);
    surface.addEventListener("mouseleave", onLeave);
    return () => {
      surface.removeEventListener("mousemove", onMove);
      surface.removeEventListener("mouseleave", onLeave);
      if (raf !== 0) window.cancelAnimationFrame(raf);
    };
  }, [body, streaming, bmApi]);

  // Persistent marker positions, re-measured when the bookmark set or the
  // body geometry changes (streaming growth, images loading, resizes).
  useEffect(() => {
    if (!body || !mine || mine.length === 0) {
      setMarkerTops(new Map());
      return;
    }
    const measure = () => {
      const bodyTop = body.getBoundingClientRect().top;
      const next = new Map<string, number>();
      for (const bm of mine) {
        const target = anchorElement(body, bm.blockIndex) as HTMLElement;
        next.set(bm.id, target.getBoundingClientRect().top - bodyTop);
      }
      setMarkerTops(next);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(body);
    return () => ro.disconnect();
  }, [body, mine]);

  if (!bmApi || !body) {
    return <span ref={sentinelRef} hidden />;
  }
  const hoverHasBookmark =
    hover !== null &&
    (mine ?? []).some((b) => b.blockIndex === hover.blockIndex);
  return (
    <>
      <span ref={sentinelRef} hidden />
      {createPortal(
        <>
          {hover !== null && !streaming ? (
            <button
              type="button"
              className={`oc-bmk-gutter${hoverHasBookmark ? " is-set" : ""}`}
              style={{ top: hover.top }}
              title={
                hoverHasBookmark ? m.bookmark_remove() : m.bookmark_add()
              }
              aria-label={
                hoverHasBookmark ? m.bookmark_remove() : m.bookmark_add()
              }
              onClick={() => bmApi.toggle(messageId, hover.blockIndex)}
            >
              <Bookmark size={14} />
            </button>
          ) : null}
          {(mine ?? []).map((bm) => {
            const top = markerTops.get(bm.id);
            if (top === undefined) return null;
            return (
              <BookmarkMarker key={bm.id} bookmark={bm} top={top} />
            );
          })}
        </>,
        body,
      )}
    </>
  );
}

/** The rename/delete editor shared by every placed-bookmark surface (margin
 *  markers, the assistant header flag): the trigger opens a small popover
 *  with the name field + delete. */
function BookmarkEditPopover({
  bookmark,
  trigger,
}: {
  bookmark: BookmarkView;
  trigger: ReactNode;
}) {
  const bmApi = useBookmarks();
  const [label, setLabel] = useState(bookmark.label ?? "");
  const [open, setOpen] = useState(false);
  if (!bmApi) return null;
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setLabel(bookmark.label ?? "");
      }}
    >
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent side="left" align="start" className="oc-bmk-pop">
        <form
          className="oc-bmk-pop__form"
          onSubmit={(e) => {
            e.preventDefault();
            bmApi.rename(bookmark.id, label);
            setOpen(false);
          }}
        >
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={m.bookmark_label_placeholder()}
            maxLength={60}
            autoFocus
          />
          <div className="oc-bmk-pop__actions">
            <Button type="submit" size="sm" variant="secondary">
              {m.bookmark_rename()}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                bmApi.remove(bookmark.id);
                setOpen(false);
              }}
            >
              <Trash2 size={14} aria-hidden />
              {m.bookmark_delete()}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

/** A placed bookmark's persistent amber margin marker (block-level anchors,
 *  and the whole-message anchor on USER bubbles, which have no header flag). */
function BookmarkMarker({
  bookmark,
  top,
}: {
  bookmark: BookmarkView;
  top: number;
}) {
  return (
    <BookmarkEditPopover
      bookmark={bookmark}
      trigger={
        <button
          type="button"
          className="oc-bmk-marker"
          style={{ top }}
          title={bookmark.label ?? m.bookmark_marker()}
          aria-label={bookmark.label ?? m.bookmark_marker()}
        >
          <Bookmark size={14} />
        </button>
      }
    />
  );
}

/** Message-level bookmark toggle for the USER message action bar (user
 *  bubbles are short: no per-block gutter, one anchor for the whole turn). */
export function BookmarkToggleButton({ header = false }: { header?: boolean }) {
  const bmApi = useBookmarks();
  const messageId = useMessage((msg) => msg.id);
  const existing =
    bmApi?.byMessage.get(messageId)?.find((b) => b.blockIndex === null) ??
    null;
  if (!bmApi) return null;
  const has = existing !== null;
  const cls = header
    ? `oc-bmk-headbtn${has ? " is-set" : ""}`
    : `oc-iconbtn${has ? " oc-iconbtn--bmk-set" : ""}`;
  // PLACED header flag = the bookmark's ONLY surface on an assistant bubble:
  // clicking it edits (rename/delete popover) rather than blind-removing.
  if (header && existing !== null) {
    return (
      <BookmarkEditPopover
        bookmark={existing}
        trigger={
          <button
            type="button"
            className={cls}
            title={existing.label ?? m.bookmark_marker()}
            aria-label={existing.label ?? m.bookmark_marker()}
          >
            <Bookmark size={13} />
          </button>
        }
      />
    );
  }
  return (
    <button
      type="button"
      className={cls}
      title={has ? m.bookmark_remove() : m.bookmark_add()}
      aria-label={has ? m.bookmark_remove() : m.bookmark_add()}
      onClick={() => bmApi.toggle(messageId, null)}
    >
      <Bookmark size={header ? 13 : 15} />
    </button>
  );
}
