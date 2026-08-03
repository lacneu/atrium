// THE RIGHT-HAND PANEL — what is open in it, where it came from, and whether it
// is pinned.
//
// It holds EVERY open panel, not only pinned ones. That is the whole point: the
// panel is mounted once, when you open it, in the one surface that survives
// navigation. Pinning is then a FLAG on that record — "keep it when I leave" —
// and flips no subtree from one component to another.
//
// It was built the other way round, and both defects the users reported were the
// same consequence. Pinning used to hand the content from the conversation's own
// column to a persistent one, and a handover between two components is an
// unmount: a PDF open at page 15 came back at page 1, having refetched and
// reparsed the file. Unpinning handed it back the other way, except the
// conversation's column had let go of its state — so the panel simply vanished.
// One record, one mount, and neither can happen.
//
// Same shape and the same reasons as `dictationHold` next door: a pure module
// with a tiny subscribe surface (no React), so it is unit-testable and immune
// to the mount/unmount churn it exists to survive.
//
// THREE RULES CARRY THIS FILE, and they live here rather than in JSX so a test
// can hold them:
//
//  1. ORIGIN TRAVELS WITH THE RECORD. A panel keeps the conversation it was
//     opened from — never the one you navigated to. `SourcesPanelContent` takes
//     only a messageId, so the origin is NOT recoverable from the content's
//     props: it is captured at open time, and displayed, or a reader sitting in
//     chat B has no way to tell whose sub-agent they are reading.
//  2. EXACTLY ONE SURFACE DRAWS, always — the persistent one. There is no
//     handover left to make, and `whoOwns()` decides only WHETHER it draws.
//  3. PINNED IS WHAT SURVIVES LEAVING. In the origin conversation the panel is
//     shown pinned or not; elsewhere, only a pinned one is. So unpinning at home
//     changes nothing on screen, and unpinning away from home closes the panel —
//     which is exactly what unpinning from another conversation means: you have
//     decided to carry on where you are.

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
  /** The content's own parameters, exactly as the opening call site passes them.
   *  Kept opaque on purpose — this store owns WHICH panel is open and WHERE it
   *  came from, never how a panel renders. */
  params: Record<string, unknown>;
  /** Does this reading survive leaving its conversation? FALSE for a panel you
   *  simply opened: it closes when you navigate away, exactly as the
   *  conversation-scoped column used to. Pinning sets it; unpinning clears it.
   *  Neither remounts anything — that is the point of it being a flag. */
  pinned: boolean;
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

/** OPEN a panel — the only way content gets into the column.
 *
 *  Replaces whatever was there: one column, one reading, and opening a second
 *  thing is the reader asking for the new thing, not for both. It opens
 *  UNPINNED; pinning is a separate, deliberate act.
 *
 *  Opening while something is pinned therefore replaces the pinned reading too.
 *  That is the same "one column" rule, now that there is one column rather than
 *  a conversation's and a persistent one able to sit side by side. */
export function openPanel(args: {
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
    pinned: false,
  };
  emit();
  return current;
}

/** Set (or clear) the pin on what is ALREADY open. It changes one boolean and
 *  nothing else — no record is replaced, so nothing the panel holds is rebuilt.
 *  `pinId` guards a stale control against a replacement reading. */
export function setPanelPinned(pinId: number, pinned: boolean): void {
  if (current === null || current.pinId !== pinId) return;
  if (current.pinned === pinned) return;
  current = { ...current, pinned };
  emit();
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
 * WHETHER the panel is drawn at all, given where the reader currently is.
 *
 * There is only ever one surface — the persistent column — so this is no longer
 * a choice between two of them. It answers a single question: does this reading
 * belong on screen right now?
 *
 * TWO WAYS TO EARN THE SCREEN, and the asymmetry the users asked for falls out
 * of them rather than being written as a special case:
 *   - PINNED: everywhere. That is what pinning means.
 *   - AT HOME: in the conversation it was opened from, pinned or not — an open
 *     panel belongs beside the thread it came from.
 *
 * So unpinning IN the origin conversation keeps the panel on screen (the second
 * rule still holds), and unpinning FROM ANOTHER conversation closes it (neither
 * holds). Both are what the reader meant: unpinning where you are is "I have
 * decided to carry on here".
 *
 * A panel with NO origin chat (a scheduled task opened from Settings) can never
 * be at home, so only the pin keeps it.
 */
export function whoOwns(
  pin: PinnedPanel | null,
  viewer: PanelViewer,
): PanelOwner {
  if (pin === null) return "none";
  // NOT MINE: nobody draws it. Fails closed before anything else, so a panel
  // opened under another identity is never rendered — not its content, and not
  // the conversation TITLE its header carries.
  if (pin.ownerUserId !== viewer.userId) return "none";
  // "At home" is asked of `pinBelongsHere`, never re-derived here: two copies of
  // one rule is how the panel and its controls came to disagree before.
  return pin.pinned || pinBelongsHere(pin, viewer) ? "dock" : "none";
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

/** Whether the reader is IN the conversation this panel was opened from. One of
 *  the two ways a panel earns the screen (`whoOwns`), and what decides whether
 *  unpinning leaves it standing or closes it. */
export function pinBelongsHere(
  pin: PinnedPanel | null,
  viewer: PanelViewer,
): boolean {
  if (pin === null) return false;
  if (pin.ownerUserId !== viewer.userId) return false;
  return pin.originChatId !== null && pin.originChatId === viewer.chatId;
}

/** Should this record be DISCARDED now that the reader is here?
 *
 *  An unpinned panel belongs to its conversation: leaving closes it, exactly as
 *  the conversation-scoped column always did. Without this the record would
 *  merely go unrendered and come back the next time the reader walked into the
 *  conversation it came from — a reading they had closed by walking out.
 *
 *  A record belonging to ANOTHER identity is never touched here: that purge is
 *  the identity swap's, and doing it from a viewer check would let one session's
 *  navigation delete another's state. */
export function shouldDropOnLeave(
  pin: PinnedPanel | null,
  viewer: PanelViewer,
): boolean {
  if (pin === null) return false;
  if (pin.ownerUserId !== viewer.userId) return false;
  return !pin.pinned && !pinBelongsHere(pin, viewer);
}

/** What UNPINNING does from where the reader currently stands.
 *
 *  At home it only clears the flag: the panel was open beside this conversation
 *  before it was ever pinned, and it stays. Anywhere else it CLOSES the panel —
 *  unpinning from another conversation is the reader saying they have decided to
 *  carry on here, and merely clearing the flag would leave the reading lying in
 *  the store, invisible, to reappear the next time they walked back into the
 *  conversation it came from. */
export function unpinOutcome(
  pin: PinnedPanel | null,
  viewer: PanelViewer,
): "keep" | "close" {
  return pinBelongsHere(pin, viewer) ? "keep" : "close";
}

/** What the OPEN panel is, as far as this conversation is concerned — the value
 *  the chat's own controls read to know which chip is active.
 *
 *  Null unless the record belongs to this reader AND was opened here: a panel
 *  pinned from another conversation is on screen, but it is not THIS
 *  conversation's open panel, and marking its chip active here would point at a
 *  message that is not the one being read.
 *
 *  A fork shares its documents, so comparing content alone would make a document
 *  opened elsewhere pass for this one. Origin is the discriminator, not
 *  identity. */
export function panelOpenHere(
  pin: PinnedPanel | null,
  viewer: PanelViewer,
): PinnedPanel | null {
  return pinBelongsHere(pin, viewer) ? pin : null;
}

/** TEST-ONLY reset of the module state (record, id counter). */
export function __resetPinnedPanelForTests(): void {
  current = null;
  nextPinId = 1;
  listeners.clear();
}
