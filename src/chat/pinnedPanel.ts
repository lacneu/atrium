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
  /** WHAT that column is showing right now (`panelIdentity`), or null when it is
   *  empty. Without it the column claimed the pin merely because the origin
   *  conversation was on screen: opening a SECOND panel there hid the dock while
   *  the column showed something else, and the pinned reading was drawn on
   *  neither surface. */
  shownIdentity: string | null;
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
export type PanelOwner = "inchat" | "dock" | "none";

let current: PinnedPanel | null = null;
/** WHAT the in-chat column is showing, published by `ConvexChat` so the dock can
 *  arbitrate against the same fact. The dock is mounted in the chrome and has no
 *  other way to know; without it, both surfaces guessed and the pinned reading
 *  could end up drawn twice, or not at all. */
let shownColumn: { chatId: string | null; identity: string | null } = {
  chatId: null,
  identity: null,
};
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

/** Publish what the in-chat column is showing. Cleared when it unmounts (no
 *  conversation on screen means no column, hence nothing shown). */
export function setShownColumn(
  chatId: string | null,
  identity: string | null,
): void {
  if (shownColumn.chatId === chatId && shownColumn.identity === identity) return;
  shownColumn = { chatId, identity };
  emit();
}

/** Stop publishing for THIS conversation — and only if it is still the one on
 *  record. A column clears on unmount, and during a route change the leaving
 *  column's cleanup can land after the arriving one has already published: an
 *  unconditional clear would then erase a fact that is true, leaving the dock
 *  and the new column drawing the same reading at once. */
export function clearShownColumn(chatId: string | null): void {
  if (shownColumn.chatId !== chatId) return;
  setShownColumn(null, null);
}

/** What the in-chat column is showing. Stable between changes. */
export function getShownColumn(): { chatId: string | null; identity: string | null } {
  return shownColumn;
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
  if (pin.originChatId === null) return "dock";
  if (pin.originChatId !== viewer.chatId) return "dock";
  // HOME, BUT THE HANDOVER IS ACKNOWLEDGED. The column owns the pin only once it
  // has PUBLISHED that it is showing it — never merely because it is empty and
  // about to. A column restores in a later effect, so handing over on "empty"
  // left a frame with the dock already gone and no column body yet: the reading
  // blinked out. It stays with the dock until the column says it has it.
  // The surface SHOWING the reading owns it, whatever shape that surface takes:
  // a column beside the thread when there is room, a sheet over it when there is
  // not. Ownership follows what is on screen, never the presentation.
  return viewer.shownIdentity === panelIdentity(pin.kind, pin.params)
    ? "inchat"
    : "dock";
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

/** Whether the pin is THIS content, here — what the pin button reports and what
 *  a close is allowed to release. */
export function isPinnedContent(
  pin: PinnedPanel | null,
  viewer: PanelViewer,
  kind: PinnedPanelKind | null,
  params: Record<string, unknown> | null,
): boolean {
  if (pin === null || kind === null || params === null) return false;
  // Asked ABOUT this content, so it is what the column shows — whatever the
  // viewer's published identity happens to be at this instant. Taking it from
  // the arguments keeps the question honest for a caller mid-handover.
  const showing = { ...viewer, shownIdentity: panelIdentity(kind, params) };
  return pin.kind === kind && whoOwns(pin, showing) === "inchat";
}

/**
 * Whether the in-chat column must REHYDRATE itself from the pin.
 *
 * Coming home, `ConvexChat` has remounted with empty local state while the pin
 * says the reading is still open and belongs here — so the column fills itself
 * from the pin rather than making the reader click again.
 *
 * The subtlety is that the very same condition is true one render after the
 * reader CLOSES the panel: rehydrating on it alone would undo the close and make
 * the X look broken. So CLOSING THE READING ENDS THE PIN — the close releases it
 * first, and there is nothing left here to restore from. This predicate is what
 * both sides agree on, which is why it lives here and not in JSX.
 */
export function shouldRestoreInChat(
  pin: PinnedPanel | null,
  viewer: PanelViewer,
  columnOpen: boolean,
): boolean {
  if (pin === null || columnOpen) return false;
  // NOT expressed through `whoOwns`: ownership is the ACKNOWLEDGEMENT of this
  // restore, so asking it here would be circular — an empty surface would have
  // to own the pin before filling itself, which is exactly the blink this
  // separation removes. The conditions are the plain ones instead.
  //
  // And no condition on the PRESENTATION. Refusing to restore where no column
  // fits — a phone, a narrow window — left the reading drawn nowhere at all
  // once its conversation had been left and returned to: the pin was still in
  // the store, invisible. Coming home restores it; whether that is a column or
  // a sheet is decided downstream, and both are surfaces.
  if (pin.ownerUserId !== viewer.userId) return false;
  return pin.originChatId !== null && pin.originChatId === viewer.chatId;
}

/** TEST-ONLY reset of the module state (pin, published column, id counter). */
export function __resetPinnedPanelForTests(): void {
  current = null;
  shownColumn = { chatId: null, identity: null };
  nextPinId = 1;
  listeners.clear();
}
