// The PERSISTENT HOME of a pinned side panel: the same right-hand column, kept
// in the chrome instead of inside the conversation.
//
// The column is mounted per chat, so leaving the conversation used to take the
// reading with it. Pinning hands ownership of WHAT is open to `pinnedPanel`'s
// module store; this column is what keeps it on screen while the user is
// anywhere else — another conversation, Settings, no conversation at all.
//
// It is a COLUMN, not a floating window: same place, same width (the very same
// persisted width as the in-chat one), same content, and the conversation to its
// left simply gets narrower. A reading you pinned should look exactly like the
// reading you were having.
//
// It renders ONLY when the store says so (`whoOwns` === "dock"). Back in the
// origin conversation the in-chat column takes the panel over — it is the same
// column, one level down in the tree — because drawing both would show the same
// content twice.
//
// Mounted next to `HeldDictationDock`, and for the same reason: inside the
// identity-keyed tree, so an impersonation or identity swap drops what was
// pinned instead of carrying one person's reading into another's session.

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useNavigate } from "@tanstack/react-router";
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
  fittedPanelWidth,
  getPinnedPanel,
  panelFitsBeside,
  releasePinnedPanel,
  setPinnedParams,
  subscribePinnedPanel,
  whoOwns,
} from "./pinnedPanel";
import { useWorkspaceRoom } from "./useWorkspaceRoom";
import { useIsMobile, useResizableWidth } from "@/lib/useSidebarLayout";
import { m } from "@/paraglide/messages.js";

/** The persisted widths, read from the SAME keys the in-chat column uses — that
 *  is what makes a pinned reading keep its size when it moves out here. All the
 *  hooks run every render (hooks cannot be conditional); only the pinned kind's
 *  width is used. The scheduled-task detail shares the sources width, exactly as
 *  it does in the conversation. */
function usePanelWidths(fitFor: (min: number) => (w: number) => number) {
  const sourcesW = useResizableWidth({
    storageKey: "oc.sources.width",
    fit: fitFor(300),
    defaultWidth: 380,
    min: 300,
    max: 680,
    edge: "right",
  });
  const subagentW = useResizableWidth({
    storageKey: "oc.subagent.width",
    fit: fitFor(320),
    defaultWidth: 460,
    min: 320,
    max: 720,
    edge: "right",
  });
  const documentW = useResizableWidth({
    storageKey: "oc.docviewer.width",
    fit: fitFor(380),
    defaultWidth: 560,
    min: 380,
    max: 1800,
    maxViewportFraction: 0.72,
    edge: "right",
  });
  // The floor each column keeps for itself, carried alongside so the fit below
  // never squeezes a panel down to something unreadable.
  const sources = { ...sourcesW, min: 300 };
  const document = { ...documentW, min: 380 };
  return { sources, subagent: { ...subagentW, min: 320 }, cron: sources, document };
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
  const isMobile = useIsMobile();
  const available = useWorkspaceRoom();
  // Every column resizes against the SAME room, so a drag can never paint a
  // width the conversation cannot afford.
  const widths = usePanelWidths(
    useCallback(
      (min: number) => (w: number) => fittedPanelWidth(w, available, min),
      [available],
    ),
  );
  const viewer = { userId: viewerUserId, chatId: currentChatId };

  // THE PIN DIES WITH THE IDENTITY. The store is module-level, so it outlives
  // React on its own: without this, an impersonation swap — which remounts this
  // whole subtree by key — would carry one person's reading, and their
  // conversation's TITLE in the header chip, straight into another's session.
  // Mount-scoped by design: this column lives in the persistent chrome, so the
  // only things that unmount it are exactly the identity swap and the teardown.
  // (`HeldDictationDock` purges its held text the same way, for the same reason.)
  useEffect(() => () => releasePinnedPanel(), []);

  if (pin === null) return null;
  if (whoOwns(pin, viewer) !== "dock") return null;

  const p = pin.params;
  const close = () => releasePinnedPanel(pin.pinId);
  const { width, startResize, columnRef, min } = widths[pin.kind];
  // NO ROOM: HIDDEN, NEVER UNMOUNTED. A phone has no room for a second column,
  // and neither does a window too narrow for a readable thread beside one — so
  // the reading is not DRAWN there. But returning null would tear its subtree
  // down, and that is the whole defect this panel exists to avoid: widening the
  // window again, or turning the phone, would rebuild a PDF from scratch and
  // land the reader back on page one. Hidden keeps every bit of it — page,
  // zoom, scroll, search — for the moment there is room again.
  const roomless = isMobile || !panelFitsBeside(available, min);
  // DRAWN width, not remembered width: the remembered one survives a narrow
  // moment, so widening the window gives the reader back the column they set.
  const drawn = fittedPanelWidth(width, available, min);

  return (
    <LightboxProvider>
      <aside
        className="oc-pinpanel"
        ref={columnRef}
        hidden={roomless}
        style={
          roomless ? { display: "none" } : { width: drawn, flex: `0 0 ${drawn}px` }
        }
        aria-label={m.pinned_panel_aria({ origin: pin.originLabel })}
      >
        {/* Same affordance as the in-chat column's: the reading keeps its width
            AND stays resizable where it now lives. */}
        <div
          className="oc-pinpanel__resizer"
          onPointerDown={startResize}
          role="separator"
          aria-orientation="vertical"
          aria-label={m.pinned_panel_resize()}
        />
        <div className="oc-pinpanel__head">
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
              // moved on. In the conversation that goes through ConvexChat's
              // provider; here there was none, so the control was visible and did
              // nothing. It now rewrites THIS pin's params.
              <DocumentViewerContext.Provider
                value={{
                  activeDoc: p.doc as ViewerDoc,
                  // In this column the panel IS the only viewer, so both openings
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
