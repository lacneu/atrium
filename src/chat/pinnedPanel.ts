// PINNED SIDE PANEL — the pin that lets what you are READING survive navigation.
//
// The right-hand column (sources, sub-agent, scheduled-task detail, document)
// is mounted PER CHAT inside ConvexChat: switching conversation re-scopes it,
// and going to Settings unmounts it outright — so a reader who wanted to check
// something elsewhere lost their reading. Pinning moves ownership of WHAT is
// open to this module-level store; a panel rendered in the persistent chrome
// keeps it readable while the user navigates anywhere.
//
// Same shape and the same reasons as `dictationHold` next door: a pure module
// with a tiny subscribe surface (no React), so it is unit-testable and immune
// to the mount/unmount churn it exists to survive.
//
// TWO RULES CARRY THIS FILE, and both live here rather than in JSX so a test
// can hold them:
//
//  1. ORIGIN TRAVELS WITH THE PIN. A pinned panel keeps the conversation it was
//     opened from — never the one you navigated to. `SourcesPanelContent` takes
//     only a messageId, so the origin is NOT recoverable from the content's
//     props: it is captured at pin time, and displayed, or a reader sitting in
//     chat B has no way to tell whose sub-agent they are reading.
//  2. EXACTLY ONE OWNER. Back in the origin chat, the in-chat column owns the
//     panel again and the floating one steps aside — otherwise the same content
//     renders twice. `whoOwns()` is that decision, and nothing else may make it.

/** Every field a `CronPartView` carries. The degraded-part identity below is
 *  derived from ALL of them — a partial list makes two different jobs look like
 *  the same reading. Kept in sync with `CronPartView` in convexTypes.ts. */
const CRON_PART_FIELDS = [
  "op",
  "jobId",
  "name",
  "enabled",
  "schedule",
  "message",
  "deliveryMode",
  "agentId",
  "nextRunAtMs",
] as const;

/** What the column can hold. Mirrors the four mutually-exclusive contents of
 *  `oc-sources-col`; the pin belongs to the COLUMN, so it must name all four. */
export type PinnedPanelKind = "sources" | "subagent" | "cron" | "document";

/** Who is looking, and at what. Every arbitration takes this rather than loose
 *  arguments, so no call site can quietly omit the identity check. */
export type PanelViewer = {
  /** The EFFECTIVE user id (impersonation included). */
  userId: string;
  /** The conversation on screen, or null (Settings, no conversation). */
  chatId: string | null;
};

export type PinnedPanel = {
  /** Monotonic id, unique per pin (never reused). An async action captures it so
   *  a late resolve only ever touches the SAME pin, never a replacement. */
  pinId: number;
  kind: PinnedPanelKind;
  /** WHOSE reading this is. The store is module-level and outlives React, so an
   *  impersonation swap can render the new identity's tree before the old one's
   *  cleanup has run. Every read is compared against the viewer and FAILS
   *  CLOSED — an identity boundary must not depend on effect ordering. */
  ownerUserId: string;
  /** The conversation this panel was opened from. The content keeps reading THIS
   *  chat while the user navigates elsewhere. `null` for content that belongs to
   *  no conversation (a scheduled task opened from Settings). */
  originChatId: string | null;
  /** Human label for the header chip: the origin conversation's title at pin
   *  time. A pinned panel must SAY where it comes from. */
  originLabel: string;
  /** The content's own parameters, exactly as the in-chat column passes them.
   *  Kept opaque on purpose — this store owns WHICH panel is pinned and WHERE it
   *  came from, never how a panel renders. */
  params: Record<string, unknown>;
};

/** Who should render the pinned content right now. */
export type PanelOwner = "dock" | "none";

let current: PinnedPanel | null = null;
let nextPinId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of [...listeners]) l();
}

/** Subscribe to pin changes. Returns the unsubscribe. */
export function subscribePinnedPanel(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The pinned panel, or null. Identity is stable between changes so
 *  `useSyncExternalStore` does not loop. */
export function getPinnedPanel(): PinnedPanel | null {
  return current;
}

/** Pin a panel. Replaces any existing pin — one column, one pin, and a second
 *  pin is the user asking for the new thing, not for both. */
export function pinPanel(args: {
  kind: PinnedPanelKind;
  ownerUserId: string;
  originChatId: string | null;
  originLabel: string;
  params: Record<string, unknown>;
}): PinnedPanel {
  current = {
    pinId: nextPinId++,
    kind: args.kind,
    ownerUserId: args.ownerUserId,
    originChatId: args.originChatId,
    originLabel: args.originLabel,
    params: args.params,
  };
  emit();
  return current;
}

/** Release the pin. `pinId` guards against a stale close: a control captured
 *  before a replacement pin must not dismiss the new one. */
export function releasePinnedPanel(pinId?: number): void {
  if (current === null) return;
  if (pinId !== undefined && pinId !== current.pinId) return;
  current = null;
  emit();
}

/** Replace the pinned content's parameters IN PLACE — same pin, same position,
 *  new state of the same thing. The document viewer's "open the newer version"
 *  needs it: from the dock that control had no context to write to, so it was
 *  visible and did nothing. `pinId` guards a late call against a replacement. */
export function setPinnedParams(
  pinId: number,
  params: Record<string, unknown>,
): void {
  if (current === null || current.pinId !== pinId) return;
  current = { ...current, params };
  emit();
}

/**
 * WHO RENDERS the pinned content, given where the user currently is.
 *
 * The whole point of a pin is that one surface hands over to the other, never
 * that both draw. Back in the origin conversation the in-chat column is the
 * better home — it is wider, resizable, and beside the thread it belongs to —
 * so the floating dock yields. Anywhere else (another conversation, Settings,
 * no conversation at all) the dock is the only surface left, so it takes over.
 *
 * A panel with NO origin chat (a scheduled task opened from Settings) has no
 * in-chat home to return to: the dock owns it everywhere.
 */
export function whoOwns(
  pin: PinnedPanel | null,
  viewer: PanelViewer,
): PanelOwner {
  if (pin === null) return "none";
  // NOT MINE: nobody draws it. Fails closed before anything else, so a pin made
  // under another identity is never rendered — not its content, and not the
  // conversation TITLE its header carries.
  if (pin.ownerUserId !== viewer.userId) return "none";
  // MINE: the persistent column, ALWAYS — including in the conversation the
  // reading came from.
  //
  // It used to hand back to the in-chat column at home, which reads well on
  // paper and is wrong in practice: two components cannot pass a subtree between
  // them, so every handover was an unmount. Everything the panel held died with
  // it — a PDF reopened at page one after fetching and parsing the whole file
  // again, a scroll position, a search box. A pinned reading that reloads on
  // every conversation change is not a reading that survived navigation.
  //
  // So there is ONE surface for a pinned reading, and it is this one.
  return "dock";
}

/**
 * WHAT the column is showing, as a comparable string.
 *
 * The pin belongs to one CONTENT, not to a kind and not to a conversation: a
 * reader who pins the sources of one message and then opens the sources of
 * another is looking at something else entirely. Comparing chats alone made the
 * pin button claim the second one was pinned, and made closing it destroy the
 * first — the reading the reader never touched.
 */
export function panelIdentity(
  kind: PinnedPanelKind,
  params: Record<string, unknown>,
): string {
  switch (kind) {
    case "sources":
      return `sources:${String(params.messageId ?? "")}`;
    case "subagent":
      return `subagent:${String(params.childKey ?? "")}`;
    case "cron": {
      // ONE FORMULA, a fixed-arity JSON tuple — no prefix, no separator, no
      // variant tag a value could forge.
      //
      // The job id alone is not the reading: the SAME job appears as a created,
      // an updated and a removed card across a conversation, and the detail
      // panel renders each differently. Pinning one and opening another made
      // them one identity — the dock stood down, the wrong card claimed to be
      // pinned, and closing it released the pin. Two cards identical in every
      // field ARE the same reading, by construction.
      const part = (params.part ?? {}) as Record<string, unknown>;
      return `cron:${JSON.stringify([
        String(params.instanceName ?? ""),
        String(params.jobId ?? ""),
        // WHICH CARD, when the list could say: `<messageId>#<index>`. Two
        // updates of one job can produce the same snapshot, and by value those
        // cards are indistinguishable — closing one released the other's pin.
        String(params.occurrenceId ?? ""),
        CRON_PART_FIELDS.map((f) => part[f] ?? null),
      ])}`;
    }
    case "document": {
      const doc = (params.doc ?? {}) as {
        filename?: string;
        storageId?: string;
        url?: string;
      };
      // The LOGICAL document, not just the blob. Signed URLs rotate, so the
      // storage id is the stable identity of the bytes — but the same blob can
      // legitimately be sent under two names, and the viewer and its drafts
      // already key on (chat, filename). On the blob alone, pinning
      // `rapport.md` and then opening `copie.md` made the copy pass for the
      // pinned reading: closing it unpinned the report. The filename survives a
      // version change by construction, so this stays stable across one.
      return `document:${JSON.stringify([
        doc.filename ?? null,
        doc.storageId ?? doc.url ?? null,
      ])}`;
    }
  }
}

/** The conversation's floor: the persistent column never takes so much room that
 *  the thread beside it disappears. Its remembered width is left untouched — it
 *  is only what gets DRAWN that yields, so widening the window gives the reader
 *  back exactly the column they had set. */
export const MIN_CONVERSATION_WIDTH = 420;

/** Whether a persistent column can stand beside the conversation at all.
 *
 *  When both cannot be honoured, the CONVERSATION wins and the column does not
 *  appear: you are reading a thread, and a panel that leaves it a sliver helps
 *  nobody. The reading is not lost — it waits, exactly as it does on a phone,
 *  and comes back as soon as there is room (widening the window, or collapsing
 *  the sidebar, which hands back its whole width). */
export function panelFitsBeside(availableWidth: number, minPanel: number): boolean {
  return availableWidth - MIN_CONVERSATION_WIDTH >= minPanel;
}

/** How wide the persistent column may actually draw, given the room it has.
 *  Only meaningful where `panelFitsBeside` holds. */
export function fittedPanelWidth(
  wanted: number,
  availableWidth: number,
  minPanel: number,
): number {
  return Math.max(
    minPanel,
    Math.min(wanted, availableWidth - MIN_CONVERSATION_WIDTH),
  );
}

/** Whether the pin was taken HERE, by this reader — the precondition for the
 *  column and the pin to act on each other at all. Not enough on its own to say
 *  the column is showing it (that is `isPinnedContent`). */
export function pinBelongsHere(
  pin: PinnedPanel | null,
  viewer: PanelViewer,
): boolean {
  if (pin === null) return false;
  if (pin.ownerUserId !== viewer.userId) return false;
  return pin.originChatId !== null && pin.originChatId === viewer.chatId;
}

/** Whether the pin holds exactly this content — what the pin button reports, and
 *  what tells the in-chat column to stand down because the persistent one is
 *  already showing the very same reading. */
export function isPinnedContent(
  pin: PinnedPanel | null,
  viewer: PanelViewer,
  kind: PinnedPanelKind | null,
  params: Record<string, unknown> | null,
): boolean {
  if (pin === null || kind === null || params === null) return false;
  // TAKEN HERE, and the same content. A fork shares its documents, so identity
  // alone made a document opened in ANOTHER conversation pass for the pinned
  // one: that conversation's column then refused to draw it — the reader's click
  // did nothing — while the panel on the right went on showing it in the context
  // of the conversation it was pinned from, drafts and version history included.
  return (
    pin.kind === kind &&
    whoOwns(pin, viewer) === "dock" &&
    pinBelongsHere(pin, viewer) &&
    panelIdentity(pin.kind, pin.params) === panelIdentity(kind, params)
  );
}

/** TEST-ONLY reset of the module state (pin, published column, id counter). */
export function __resetPinnedPanelForTests(): void {
  current = null;
  nextPinId = 1;
  listeners.clear();
}
