// The floating home of a PINNED side panel, rendered in the persistent chrome.
//
// The right-hand column is mounted per chat, so leaving the conversation used to
// take the reading with it. Pinning hands the panel to `pinnedPanel`'s module
// store; this dock is what keeps it readable while the user is anywhere else —
// another conversation, Settings, or no conversation at all.
//
// It renders ONLY when the store says so (`whoOwns` === "dock"). Back in the
// origin conversation the in-chat column takes the panel over, because it is
// wider, resizable and sits beside the thread it belongs to; drawing both would
// show the same content twice.
//
// Mounted next to `HeldDictationDock`, and for the same reason: inside the
// identity-keyed tree, so an impersonation or identity swap drops what was
// pinned instead of carrying one person's reading into another's session.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useNavigate } from "@tanstack/react-router";

import { useIsMobile } from "@/lib/useSidebarLayout";
import { ExternalLink, PinOff } from "lucide-react";

import { CronDetailContent } from "./CronDetailPanel";
import { PanelBodyBoundary } from "./PanelBodyBoundary";
import type { CronPartView } from "./convexTypes";
import {
  DocumentViewerContent,
  DocumentViewerContext,
  type ViewerDoc,
} from "./DocumentViewer";
import { LightboxProvider } from "./ImageLightbox";
import { SourcesPanelContent } from "./SourcesActivity";
import { SubAgentPanelContent } from "./SubAgentPanel";
import {
  getPinnedPanel,
  getShownColumn,
  releasePinnedPanel,
  setPinnedParams,
  setPinnedGeometry,
  subscribePinnedPanel,
  whoOwns,
  type PinnedGeometry,
} from "./pinnedPanel";
import { m } from "@/paraglide/messages.js";

/** Keep the panel on screen: a geometry restored from a previous, larger window
 *  must not park it out of reach (the composer dock's clamp, same intent). */
function clamp(g: PinnedGeometry): PinnedGeometry {
  const w = Math.min(g.w, window.innerWidth);
  const h = Math.min(g.h, window.innerHeight);
  return {
    w,
    h,
    x: Math.max(0, Math.min(g.x, window.innerWidth - w)),
    y: Math.max(0, Math.min(g.y, window.innerHeight - h)),
  };
}

export function PinnedPanelDock({
  viewerUserId,
  currentChatId,
}: {
  /** The EFFECTIVE user id. A pin made under another identity is never drawn —
   *  the store outlives React, so the check cannot wait for a cleanup effect. */
  viewerUserId: string;
  /** The conversation currently on screen, or null (Settings, no chat). */
  currentChatId: string | null;
}) {
  const pin = useSyncExternalStore(subscribePinnedPanel, getPinnedPanel, getPinnedPanel);
  const navigate = useNavigate();
  // On mobile there is no in-chat column to hand the panel back to (the four
  // contents are modal sheets there), so this dock keeps it everywhere.
  const inChatColumn = !useIsMobile();
  // The same fact the column publishes: WHAT it is showing. Both surfaces
  // arbitrate on it, so a reading is drawn exactly once — never twice, and never
  // on neither (a second panel opened in the origin chat used to hide this dock
  // while the column showed something else).
  const shown = useSyncExternalStore(
    subscribePinnedPanel,
    getShownColumn,
    getShownColumn,
  );
  const viewer = {
    userId: viewerUserId,
    chatId: currentChatId,
    inChatColumn,
    shownIdentity: shown.chatId === currentChatId ? shown.identity : null,
  };
  const [geom, setGeom] = useState<PinnedGeometry | null>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  // THE PIN DIES WITH THE IDENTITY. The store is module-level, so it outlives
  // React on its own: without this, an impersonation swap — which remounts this
  // whole subtree by key — would carry one person's reading, and their
  // conversation's TITLE in the header chip, straight into another's session.
  // Mount-scoped by design: this dock lives in the persistent chrome, so the
  // only things that unmount it are exactly the identity swap and the teardown.
  // (`HeldDictationDock` purges its held text the same way, for the same reason.)
  useEffect(() => () => releasePinnedPanel(), []);

  // Place on first render of a pin, and re-clamp on resize: a window that shrank
  // while the panel was pinned must not leave it off screen.
  useEffect(() => {
    if (pin === null) return;
    const place = () =>
      setGeom(
        clamp(
          // Never moved: open where the column was — on the right, under the
          // header — rather than over the chrome the reader still needs.
          pin.geom ?? { x: window.innerWidth - 480, y: 96, w: 460, h: 620 },
        ),
      );
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [pin]);

  const onPointerMove = useCallback((e: PointerEvent) => {
    const d = dragRef.current;
    if (d === null) return;
    setGeom((g) =>
      g === null ? g : clamp({ ...g, x: e.clientX - d.dx, y: e.clientY - d.dy }),
    );
  }, []);

  // ONE way to stop a drag, used by every ending. `pointerup` is not the only
  // one: `pointercancel` (a gesture stolen by the OS), a window blur, an
  // identity swap mid-drag — each of those used to leave the move handler on
  // `window`, so the NEXT panel followed the pointer with no button pressed.
  const onPointerUp = useCallback(() => {
    dragRef.current = null;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
    window.removeEventListener("blur", onPointerUp);
    // Persist where the user left it: geometry survives the pin, so re-pinning
    // does not send the panel back to a corner they already moved it out of.
    setGeom((g) => {
      if (g !== null) setPinnedGeometry(g);
      return g;
    });
  }, [onPointerMove]);
  // …and no drag outlives this component either: an identity swap mid-drag
  // unmounts us, and the move handler must not stay behind on `window`.
  useEffect(() => () => onPointerUp(), [onPointerUp]);

  if (pin === null || geom === null) return null;
  if (whoOwns(pin, viewer) !== "dock") return null;

  const p = pin.params;
  const close = () => releasePinnedPanel(pin.pinId);

  return (
    <LightboxProvider>
      <aside
        className="oc-pinpanel"
        style={{ left: geom.x, top: geom.y, width: geom.w, height: geom.h }}
        aria-label={m.pinned_panel_aria({ origin: pin.originLabel })}
      >
        <div
          className="oc-pinpanel__head"
          onPointerDown={(e) => {
            dragRef.current = { dx: e.clientX - geom.x, dy: e.clientY - geom.y };
            window.addEventListener("pointermove", onPointerMove);
            window.addEventListener("pointerup", onPointerUp);
            window.addEventListener("pointercancel", onPointerUp);
            window.addEventListener("blur", onPointerUp);
          }}
        >
          {/* WHOSE reading this is. A pinned panel read from another conversation
              is unreadable as context without it — `SourcesPanelContent` carries
              only a messageId, so nothing in the content itself can say. */}
          <span className="oc-pinpanel__origin" title={pin.originLabel}>
            {pin.originLabel}
          </span>
          <span className="oc-pinpanel__ctrls">
            {pin.originChatId !== null ? (
              <button
                type="button"
                className="oc-pinpanel__btn"
                title={m.pinned_panel_goto()}
                aria-label={m.pinned_panel_goto()}
                onClick={() =>
                  void navigate({
                    to: "/chat/$chatId",
                    params: { chatId: pin.originChatId as string },
                  })
                }
              >
                <ExternalLink size={14} aria-hidden />
              </button>
            ) : null}
            <button
              type="button"
              className="oc-pinpanel__btn"
              title={m.pinned_panel_unpin()}
              aria-label={m.pinned_panel_unpin()}
              onClick={close}
            >
              <PinOff size={14} aria-hidden />
            </button>
          </span>
        </div>
        {/* Keyed by the pin: a new pin gets a FRESH boundary, so one broken
            panel does not leave the next one showing a failure it never had. */}
        <PanelBodyBoundary key={pin.pinId} onClose={close}>
          <div className="oc-pinpanel__body">
            {pin.kind === "cron" ? (
            <CronDetailContent
              instanceName={p.instanceName as string}
              part={p.part as CronPartView}
              onClose={close}
            />
          ) : pin.kind === "document" ? (
            // The viewer offers "open the newer version" when the document has
            // moved on. In the column that goes through ConvexChat's provider;
            // here there was none, so the control was visible and did nothing.
            // It now rewrites THIS pin's params — guarded by pinId, so a late
            // click cannot retarget a replacement pin.
            <DocumentViewerContext.Provider
              value={{
                activeDoc: p.doc as ViewerDoc,
                // In the dock this panel IS the only viewer, so both openings
                // land here; the pinId guard keeps a late one from retargeting
                // a replacement pin.
                openFor: (doc: ViewerDoc) =>
                  setPinnedParams(pin.pinId, { ...p, doc }),
                openNewerVersion: (doc: ViewerDoc) =>
                  setPinnedParams(pin.pinId, { ...p, doc }),
                close,
              }}
            >
              <DocumentViewerContent
                doc={p.doc as ViewerDoc}
                chatId={pin.originChatId as string}
                onClose={close}
              />
            </DocumentViewerContext.Provider>
          ) : pin.kind === "subagent" ? (
            <SubAgentPanelContent
              chatId={pin.originChatId as string}
              childKey={p.childKey as string}
              onClose={close}
              parentAgentLabel={(p.parentAgentLabel as string) ?? ""}
            />
          ) : (
              <SourcesPanelContent messageId={p.messageId as string} onClose={close} />
            )}
          </div>
        </PanelBodyBoundary>
      </aside>
    </LightboxProvider>
  );
}
