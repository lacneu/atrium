// THE right-hand column. Not "the pinned one" — the only one.
//
// Every panel the conversation opens (sources, sub-agent, scheduled-task detail,
// document) is mounted HERE, in the chrome, pinned or not. The conversation used
// to have a column of its own and hand the reading over to this one on pinning;
// a handover between two components is an unmount, so pinning rebuilt a PDF from
// scratch and unpinning made the panel disappear. There is nothing left to hand
// over: `pinnedPanel` holds the record, this draws it, and the pin is a flag on
// it that moves nothing.
//
// It is a COLUMN, not a floating window: same place, its own persisted width,
// and the conversation to its left simply gets narrower.
//
// `whoOwns` decides only WHETHER it is on screen — pinned (anywhere) or at home
// (the conversation it was opened from).
//
// Mounted next to `HeldDictationDock`, and for the same reason: inside the
// identity-keyed tree, so an impersonation or identity swap drops the reading
// instead of carrying one person's into another's session.

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ExternalLink, Pin, PinOff, X } from "lucide-react";

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
  pinBelongsHere,
  releasePinnedPanel,
  shouldDropOnLeave,
  setPanelPinned,
  setPinnedParams,
  subscribePinnedPanel,
  unpinOutcome,
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

  // LEAVING A CONVERSATION CLOSES WHAT WAS ONLY OPEN THERE. `whoOwns` already
  // stops drawing it; this discards the record, so walking back in later does
  // not resurrect a reading the user closed by walking out. Pinned readings are
  // untouched — surviving that is what the pin is.
  const dropOnLeave = shouldDropOnLeave(pin, viewer);
  const leavingPinId = pin?.pinId;
  useEffect(() => {
    if (dropOnLeave && leavingPinId !== undefined) {
      releasePinnedPanel(leavingPinId);
    }
  }, [dropOnLeave, leavingPinId]);

  if (pin === null) return null;
  if (whoOwns(pin, viewer) !== "dock") return null;

  const p = pin.params;
  const close = () => releasePinnedPanel(pin.pinId);
  const { width, startResize, columnRef, min } = widths[pin.kind];
  // NO ROOM for a column: a phone, or a window too narrow for a readable thread
  // beside one.
  const roomless = isMobile || !panelFitsBeside(available, min);
  // An UNPINNED panel there is shown as a sheet over the conversation, and the
  // conversation renders that — so this must stand fully down, or the reading
  // would be live twice and a PDF would be parsed twice.
  if (roomless && !pin.pinned) return null;
  // PINNED and roomless: HIDDEN, NEVER UNMOUNTED. Returning null would tear the
  // subtree down, and that is the whole defect this panel exists to avoid —
  // widening the window again would rebuild a PDF from scratch and land the
  // reader back on page one. Hidden keeps every bit of it (page, zoom, scroll,
  // search) for the moment there is room again.
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
          {/* WHOSE reading this is. A panel read from another conversation is
              unreadable as context without it — `SourcesPanelContent` carries
              only a messageId, so nothing in the content itself can say. */}
          <span className="oc-pinpanel__origin" title={pin.originLabel}>
            {pin.originLabel}
          </span>
          <span className="oc-pinpanel__ctrls">
            {/* THE PIN LIVES WHERE THE PANEL LIVES. It used to sit in the
                conversation's own column, which meant pressing it moved the
                reading from that column to this one — and a move between two
                components is an unmount, so a PDF came back at page one. Here it
                flips one flag on the record already mounted here: nothing is
                rebuilt, and the reader keeps their page. */}
            <button
              type="button"
              className={`oc-pinpanel__btn${pin.pinned ? " is-on" : ""}`}
              aria-pressed={pin.pinned}
              title={pin.pinned ? m.pinned_panel_unpin() : m.panel_pin()}
              aria-label={pin.pinned ? m.pinned_panel_unpin() : m.panel_pin()}
              onClick={() => {
                if (!pin.pinned) {
                  setPanelPinned(pin.pinId, true);
                  return;
                }
                // Unpinning AWAY from the origin conversation closes the
                // reading; at home it only clears the flag. The rule is the
                // store's, not this button's.
                if (unpinOutcome(pin, viewer) === "close") close();
                else setPanelPinned(pin.pinId, false);
              }}
            >
              {pin.pinned ? <PinOff size={14} aria-hidden /> : <Pin size={14} aria-hidden />}
            </button>
            {pin.originChatId !== null && !pinBelongsHere(pin, viewer) ? (
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
            {/* CLOSE, distinct from unpin now that the two differ: unpinning at
                home leaves the reading open, so there has to be a way to say
                "done with it" that does not depend on where you stand. */}
            <button
              type="button"
              className="oc-pinpanel__btn"
              title={m.panel_close()}
              aria-label={m.panel_close()}
              onClick={close}
            >
              <X size={14} aria-hidden />
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
