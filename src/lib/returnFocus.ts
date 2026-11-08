// Where the focus goes when a layer closes (lots 15-16).
//
// Every layer of the app — dialog, alert dialog, sheet, popover, menu — is built
// from the shared contents (components/ui), and each one gives the focus back by
// this one rule as it closes:
//   0. THE GUARD, FIRST: a focus already on a control outside the closing layer
//      stays there — the user or the view put it there (the composer focused while
//      the drawer slid out). Nobody moves it: not the rule, not a view, not Radix.
//   1. the control that opened the layer, while it can still take the focus;
//   2. its twin in the layout now shown — an opener rendered in two layouts (the
//      drawer's and the column's "New chat", a calendar occurrence in month and
//      in agenda) carries the same `data-focus-key` in both, and a layout switched
//      while the layer was open leaves the live one to find (lot 17). A twin not
//      rendered yet (a panel reloading its content) is not waited for: the focus
//      is never moved later, when the user may have put it elsewhere;
//   3. the fallbacks its view names (a control that stays: the ⋯ an action went
//      into, the calendar's toolbar, the drawer's toggle) — a view only ever adds
//      fallbacks, it never replaces the rule;
//   4. the first control of the nearest part of the page around the opener that
//      is still there — within its view: never past the routed `main` or a
//      sidebar, whose content may be another view by then.
// `focusFirst` checks that each one really takes it. When none does, Radix's own
// default stays (its trigger, for a popover or a menu).
//
// THE OPENER IS TRACKED, NOT ASKED (lot 16). A popover's or a menu's opener is its
// trigger, which Radix links to it. A dialog has none: it was opened by whatever
// held the focus. Radix only reports that as the dialog's first focus event,
// `onOpenAutoFocus` — which it skips when a descendant already took the focus: an
// `autoFocus` field does, during React's commit, before Radix looks (the agent
// picker's search lost its opener that way). So the page's focus moves are
// recorded once for its life (`installFocusHistory`, main.tsx), and a dialog's
// opener is read from them when its content mounts: the newest focus move outside
// it — whatever its own fields did first —, past those inside a dialog closing as
// it opens; an item of a menu or a popover stands for that layer's trigger.
//
// LAYERS CLOSING TOGETHER (lot 17): a layout switch unmounts the drawer with the
// layers opened from inside it — its folder's menu, a dialog of one of its rows.
// The outermost closes first; the rule then runs for the innermost before its own
// (`openWithin`, read as the drawer leaves): the user was in the menu, the focus
// goes to its trigger's twin in the column, not to the drawer's toggle.
//
// THE REGISTRY HOLDS ONLY WHAT IS ON THE PAGE (lot 18). Each shared content has
// its tracker (`createLayerTracker`): its node is registered as React attaches it,
// if it is in the document, and taken out as soon as its ref goes to null or it
// leaves the document (`watchRegistry`) — a Select's content leaves without its
// ref ever going to null. A close is matched to the content that left, not to
// whatever the hook holds by then: a Select reopened before its old content's
// FocusScope timer ran saw that late close wipe the new entry and keep the old,
// detached node for good.
//
// A LAYER FROM ANOTHER LIBRARY IS NO EXCEPTION (lot 17): assistant-ui's reply menu
// is a Radix menu too; it goes through the same rule by its own shared content
// (components/ui/action-bar-more), and a guard keeps every package that wraps
// Radix to the layers it is allowed to render.
import { useState } from "react";
import { canTakeFocus, focusFirst } from "./focusFallback";

/** A view's own fallbacks for the focus, read when its layer closes. */
export type ReturnFocus = () => ReadonlyArray<HTMLElement | null>;

/** What can take the focus inside a part of the page. */
const FOCUSABLE =
  "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])";

/** The floating layers an item can open a dialog from: a menu, a popover, a select. */
const FLOATING = '[role="menu"], [data-popover-of], [data-select-of]';

/** The pairs a shared content and its trigger carry (Radix links them only while
 *  open, if at all): a popover's, a select's. */
const PAIRS = [
  ["data-popover-of", "data-popover-trigger"],
  ["data-select-of", "data-select-trigger"],
] as const;

/** The attribute an opener rendered in several layouts carries in each, with the
 *  same value: how the rule finds the live twin of an opener the layout replaced. */
export const FOCUS_KEY = "data-focus-key";

/** The layers that hold the focus while open: dialogs, alert dialogs, sheets (a
 *  popover is a `dialog` too for Radix: the shared Popover marks it apart). */
const MODAL = '[role="dialog"]:not([data-popover-of]), [role="alertdialog"]';

/** How many layers deep a chain (a submenu, a menu in a popover) is followed — a
 *  guard, not a real depth. */
const LAYER_DEPTH = 8;

/** The page's top-level areas — the routed view's `main`, a sidebar's `aside`: the
 *  walk for a surviving control stops inside them. Past them, a control would
 *  belong to another view (the one the user navigated to meanwhile). */
const AREA = "main, aside";

/** How many focus moves the history keeps: far more than an opening reads. */
const HISTORY_SIZE = 32;

/* ------------------------------------------------------------------ the openers */

/** The trigger of a floating layer: a menu's, by the label Radix gives the menu
 *  (`aria-labelledby`); a popover's, by the pair the shared Popover stamps on both
 *  (`data-popover-of` ↔ `data-popover-trigger`). Readable after the layer left the
 *  page: its own attributes stay on it. */
export function triggerOf(layer: Element, doc: Document): Element | null {
  for (const [of, trigger] of PAIRS) {
    const pair = layer.getAttribute(of);
    if (pair === null) continue;
    return (
      Array.from(doc.querySelectorAll(`[${trigger}]`)).find(
        (el) => el.getAttribute(trigger) === pair,
      ) ?? null
    );
  }
  const id = layer.getAttribute("aria-labelledby");
  return id === null ? null : doc.getElementById(id);
}

/**
 * The control an element stands for when it opens a dialog: for an item of a menu
 * or a popover, the trigger of that layer — up through submenus —; any other
 * element stands for itself.
 */
export function openerOf(el: Element | null, doc: Document = document): Element | null {
  let current = el;
  for (let depth = 0; current !== null && depth < LAYER_DEPTH; depth++) {
    const layer = current.closest(FLOATING);
    if (layer === null) return current;
    const trigger = triggerOf(layer, doc);
    if (trigger === null || layer.contains(trigger)) return current;
    current = trigger;
  }
  return current;
}

/* ------------------------------------------------------------------ the history */

/** The recent focus moves, newest last: the element that took the focus, or null
 *  when the focus went nowhere. */
export interface FocusHistory {
  record(entry: Element | null): void;
  entries(): ReadonlyArray<Element | null>;
}

export function createFocusHistory(size: number = HISTORY_SIZE): FocusHistory {
  const list: Array<Element | null> = [];
  return {
    record(entry) {
      list.push(entry);
      if (list.length > size) list.splice(0, list.length - size);
    },
    entries: () => list,
  };
}

/** The page's one history, fed by `installFocusHistory`. */
export const FOCUS_HISTORY: FocusHistory = createFocusHistory();

/** What the history listens on: the document. */
export interface FocusSource {
  readonly activeElement: Element | null;
  readonly body: Element | null;
  addEventListener(type: "focusin" | "focusout", listener: (event: FocusEvent) => void, capture: boolean): void;
  removeEventListener(type: "focusin" | "focusout", listener: (event: FocusEvent) => void, capture: boolean): void;
}

/**
 * Records every focus move of the page — installed ONCE, for the page's life, by
 * main.tsx; in the capture phase, before any handler can move the focus again.
 * A focus that leaves for nowhere (a click on the page's background) is recorded
 * as such, once the task is over — an element that leaves the page while focused
 * reports the same event, and is not a choice of the user: it is not recorded,
 * nor is the window losing the focus (the page keeps its active element).
 */
export function installFocusHistory(
  doc: FocusSource = document,
  history: FocusHistory = FOCUS_HISTORY,
  later: (task: () => void) => void = queueMicrotask,
): () => void {
  const onIn = (event: FocusEvent) => history.record(event.target as Element);
  const onOut = (event: FocusEvent) => {
    if (event.relatedTarget !== null) return;
    const left = event.target as Element;
    later(() => {
      if (left.isConnected && doc.activeElement === doc.body) history.record(null);
    });
  };
  doc.addEventListener("focusin", onIn, true);
  doc.addEventListener("focusout", onOut, true);
  return () => {
    doc.removeEventListener("focusin", onIn, true);
    doc.removeEventListener("focusout", onOut, true);
  };
}

/**
 * The opener of a dialog, read from the history as its content mounts: the newest
 * focus move outside the dialog — its own fields took the focus first (`autoFocus`
 * during React's commit, then Radix) and are passed over —, past those inside
 * another dialog closing as this one opens (its opener comes earlier); an item of
 * a menu or a popover stands for the layer's trigger. Null when the focus was
 * nowhere. A control gone since stays the opener — never an older, stale one —:
 * it takes no focus, its twin may.
 */
export function openerFor(
  layer: Element,
  entries: ReadonlyArray<Element | null>,
  doc: Document = document,
): HTMLElement | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const el = entries[i];
    if (el === null) return null;
    if (layer.contains(el)) continue;
    const host = el.closest(MODAL);
    if (host !== null && (host.getAttribute("data-state") === "closed" || !host.isConnected)) {
      continue;
    }
    return openerOf(el, doc) as HTMLElement | null;
  }
  return null;
}

/* ------------------------------------------------------------------ the rule */

/** The opener's ancestors, nearest first, up to — not including — its top-level
 *  area or the body: the parts of its view a control is looked for in, once the
 *  opener is gone. */
export function regionsOf(origin: Element | null): Element[] {
  const out: Element[] = [];
  for (let el = origin?.parentElement ?? null; el !== null; el = el.parentElement) {
    const doc = el.ownerDocument;
    if (el === doc.body || el === doc.documentElement || el.matches(AREA)) break;
    out.push(el);
  }
  return out;
}

/** The first control that can take the focus in the nearest of `regions` still on
 *  the page — the part the opener was in, or the one around it. */
export function nearestSurvivingControl(
  regions: ReadonlyArray<Element>,
): HTMLElement | null {
  for (const region of regions) {
    if (!region.isConnected) continue;
    for (const el of Array.from(region.querySelectorAll<HTMLElement>(FOCUSABLE))) {
      if (canTakeFocus(el)) return el;
    }
  }
  return null;
}

/** What a layer remembers of its opening: the control, its key, and the page
 *  around it. */
export interface Opening {
  origin: HTMLElement | null;
  regions: Element[];
  key: string | null;
}

/** The opening of `origin`: the parts of the page around it, its focus key. */
export function openingOf(origin: HTMLElement | null): Opening {
  return { origin, regions: regionsOf(origin), key: origin?.getAttribute(FOCUS_KEY) ?? null };
}

/** The live control carrying `key` — the opener's twin in the layout now shown. */
export function keyedTwin(key: string | null, doc: Document = document): HTMLElement | null {
  if (key === null) return null;
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>(`[${FOCUS_KEY}]`))) {
    if (el.getAttribute(FOCUS_KEY) === key && canTakeFocus(el)) return el;
  }
  return null;
}

/** A dialog's opening, as its content mounts (`openerFor` the page's history). */
export function captureOpening(
  layer: Element,
  history: FocusHistory = FOCUS_HISTORY,
  doc: Document = document,
): Opening {
  return openingOf(openerFor(layer, history.entries(), doc));
}

/** A popover's, a menu's or a select's opening: its trigger. */
export function triggerOpening(layer: Element | null, doc: Document = document): Opening {
  return openingOf((layer === null ? null : triggerOf(layer, doc)) as HTMLElement | null);
}

/** The order the focus is offered in when a layer closes. */
export function returnFocusOrder(
  opening: Opening | null,
  fallbacks: ReadonlyArray<HTMLElement | null>,
  doc: Document = document,
): Array<HTMLElement | null> {
  if (opening === null) return [...fallbacks];
  return [
    opening.origin,
    keyedTwin(opening.key, doc),
    ...fallbacks,
    nearestSurvivingControl(opening.regions),
  ];
}

/* ------------------------------------------------------------- the open layers */

/** The layers open on the page, each with the opening it read as it mounted —
 *  contents ON the page only: an entry leaves with its node (lot 18). */
export type OpenLayers = Map<Element, Opening>;

/** The page's open layers, kept by the shared contents' trackers. */
export const OPEN_LAYERS: OpenLayers = new Map();

/** Drops every entry whose node has left the document. */
export function pruneDetached(open: OpenLayers = OPEN_LAYERS): void {
  for (const node of Array.from(open.keys())) {
    if (!node.isConnected) open.delete(node);
  }
}

let registryWatched = false;

/**
 * Watches the page's top level, where Radix portals every layer, and drops an entry
 * as soon as its node leaves the document — whatever React tells its ref: a Radix
 * Select's content never gets it with null (its Presence swaps it for the closed
 * fragment in the same render, and the ref it composes reads the fragment's refs
 * by then). Installed with the first open layer, for the page's life.
 */
function watchRegistry(open: OpenLayers, doc: Document): void {
  if (registryWatched || open !== OPEN_LAYERS || typeof MutationObserver !== "function" || !doc.body) return;
  registryWatched = true;
  new MutationObserver(() => pruneDetached(open)).observe(doc.body, { childList: true });
}

/** A layer: its content, and what it read as it mounted. */
export interface LayerEntry {
  node: Element;
  opening: Opening;
}

/**
 * The open layers opened from inside `layer`, innermost first — a menu opened in
 * the drawer, a dialog opened from that menu —, read as `layer` leaves the page:
 * React detaches a removed tree's refs from its root down, so they are still
 * registered then. A node outside the document is never one of them.
 */
export function openWithin(layer: Element, open: OpenLayers = OPEN_LAYERS): LayerEntry[] {
  const chain: LayerEntry[] = [];
  let outer = layer;
  for (let depth = 0; depth < LAYER_DEPTH; depth++) {
    let inner: LayerEntry | null = null;
    for (const [node, opening] of open) {
      if (node === layer || node === outer || !node.isConnected) continue;
      if (opening.origin !== null && outer.contains(opening.origin)) {
        inner = { node, opening };
        break;
      }
    }
    if (inner === null) break;
    chain.unshift(inner);
    outer = inner.node;
  }
  return chain;
}

/** Is the focus already on a control outside the closing layer? */
export function focusPlaced(layer: Element | null, doc: Document = document): boolean {
  const active = doc.activeElement;
  if (active === null || active === doc.body || !active.isConnected) return false;
  return layer === null || !layer.contains(active);
}

/** The part of a Radix auto-focus event the handlers use. */
export interface AutoFocusEvent {
  readonly defaultPrevented: boolean;
  preventDefault(): void;
}

/**
 * A layer closes: the guard, then the rule — for the layers that closed with it
 * first, innermost first (`nested`), then for its own. Radix is kept from moving
 * the focus again (`preventDefault`) whenever the focus is somewhere real; when
 * nothing took it, its own default stays.
 */
export function closeLayerFocus(
  event: AutoFocusEvent,
  layer: Element | null,
  opening: Opening | null,
  returnFocus: ReturnFocus | undefined,
  doc: Document = document,
  nested: ReadonlyArray<Opening> = [],
): void {
  if (focusPlaced(layer, doc)) {
    event.preventDefault();
    return;
  }
  const order = [
    ...nested.flatMap((inner) => returnFocusOrder(inner, [], doc)),
    ...returnFocusOrder(opening, returnFocus?.() ?? [], doc),
  ];
  if (focusFirst(order) !== null) event.preventDefault();
}

/** The kinds of layers: a dialog (alert dialog, sheet) has no trigger, a popover
 *  and a menu (a select too) have one. */
export type LayerKind = "dialog" | "popover" | "menu";

/**
 * A layer of `kind` closes, from the opening read as it mounted: a dialog's opener,
 * a popover's or a menu's trigger (read again from the layer when it was not). A
 * popover dismissed by an interaction outside it leaves the focus where that
 * interaction put it — Radix's own choice for popovers, kept: only the guard runs.
 */
export function closeLayerOfKind(
  kind: LayerKind,
  event: AutoFocusEvent,
  layer: Element | null,
  captured: Opening | null,
  interactedOutside: boolean,
  returnFocus: ReturnFocus | undefined,
  doc: Document = document,
  nested: ReadonlyArray<Opening> = [],
): void {
  if (kind === "popover" && interactedOutside) {
    if (focusPlaced(layer, doc)) event.preventDefault();
    return;
  }
  const opening = captured ?? (kind === "dialog" ? null : triggerOpening(layer, doc));
  closeLayerFocus(event, layer, opening, returnFocus, doc, nested);
}

/** How many contents gone from the page a tracker keeps waiting for their close —
 *  each detach is followed by its FocusScope's close; a bound, not a count. */
const CLOSING_KEPT = 4;

/** A content gone from the page whose close has not run yet. */
interface Closing extends LayerEntry {
  /** The layers opened from inside it that were open as it left. */
  within: LayerEntry[];
  /** Dismissed by an interaction outside it (a popover). */
  outside: boolean;
}

/** One shared content's focus handling (`useLayerFocus` keeps one per content). */
export interface LayerTracker {
  /** The content's ref: its node as React attaches it, null as React detaches it. */
  attach: (node: Element | null) => void;
  /** The content's onCloseAutoFocus: the guard and the rule. */
  close: (event: AutoFocusEvent, returnFocus: ReturnFocus | undefined) => void;
  /** An interaction outside the content dismissed it (once the view let it through). */
  interactedOutside: () => void;
}

/**
 * The focus handling of ONE shared layer content, across React's ref calls and
 * Radix's close (lot 18). `attach` registers a node that is in the document, with
 * the opening it reads then — a dialog's opener from the history, a trigger with
 * its focus key —; a node outside the document is no open layer (Radix renders a
 * closed Select's items into a DocumentFragment). The ref going to null takes the
 * node out of the registry until React attaches it again, which it does at each
 * render where Radix composes a new ref; another node in its place, or the node
 * gone from the document when its close comes, means the content left: it waits
 * for its close with the layers opened from inside it (`openWithin`). A node that
 * leaves the document without its ref going to null (a Select's content: its
 * Presence swaps it for the closed fragment in the same render) leaves the
 * registry then (`watchRegistry`). `close` runs the guard and the rule for the
 * oldest content that left; with none — Radix reporting a close of a content still
 * on the page —, or once the layer is open again, it keeps the focus where it is
 * and moves none.
 */
export function createLayerTracker(
  kind: LayerKind,
  open: OpenLayers = OPEN_LAYERS,
  history: FocusHistory = FOCUS_HISTORY,
  doc: Document = document,
): LayerTracker {
  /** The content as React last attached it, what it read as it mounted, and — read
   *  as its ref last went to null — the layers opened from inside it. */
  let live: (LayerEntry & { outside: boolean; within: LayerEntry[] | null }) | null = null;
  const closing: Closing[] = [];
  const leave = () => {
    if (live === null) return;
    open.delete(live.node);
    closing.push({ node: live.node, opening: live.opening, outside: live.outside, within: live.within ?? openWithin(live.node, open) });
    if (closing.length > CLOSING_KEPT) closing.shift();
    live = null;
  };
  return {
    attach(node) {
      if (node === null) {
        // React calls a ref with null each time its function changes — Radix
        // composes a new one at each render of a Select's content —, not only as
        // the content leaves: out of the registry until it is attached again, and
        // what was opened from inside it read now, while still registered (React
        // detaches a removed tree's refs from its root down).
        if (live === null) return;
        open.delete(live.node);
        live.within = openWithin(live.node, open);
        return;
      }
      if (node === live?.node) {
        if (node.isConnected) open.set(node, live.opening);
        live.within = null;
        return;
      }
      leave();
      if (!node.isConnected) return;
      pruneDetached(open);
      const opening = kind === "dialog" ? captureOpening(node, history, doc) : triggerOpening(node, doc);
      live = { node, opening, outside: false, within: null };
      open.set(node, opening);
      watchRegistry(open, doc);
    },
    close(event, returnFocus) {
      if (live !== null && !live.node.isConnected) leave();
      pruneDetached(open);
      const left = closing.shift();
      if (left === undefined) {
        const active = doc.activeElement;
        if (active !== null && active !== doc.body) event.preventDefault();
        return;
      }
      if (live !== null) {
        // Opened again before this close came (a Select reopened at once): the
        // focus is the new content's to take — neither the rule nor Radix moves it
        // to the old one's trigger.
        event.preventDefault();
        return;
      }
      const nested = left.within.filter((inner) => !inner.node.isConnected).map((inner) => inner.opening);
      closeLayerOfKind(kind, event, left.node, left.opening, left.outside, returnFocus, doc, nested);
    },
    interactedOutside() {
      if (live !== null) live.outside = true;
    },
  };
}

/**
 * The focus handling of a shared layer content: one tracker for the content's
 * life — its `ref` (the tracker's, the same function at every render), its
 * `onCloseAutoFocus`, its `onInteractOutside`, which notes a popover dismissed from
 * outside once the view's own handler let it through.
 */
export function useLayerFocus<O extends { readonly defaultPrevented: boolean }>(
  kind: LayerKind,
  returnFocus: ReturnFocus | undefined,
  onInteractOutside?: (event: O) => void,
): {
  ref: (node: HTMLElement | null) => void;
  onCloseAutoFocus: (event: AutoFocusEvent) => void;
  onInteractOutside: (event: O) => void;
} {
  const [tracker] = useState(() => createLayerTracker(kind));
  return {
    ref: tracker.attach,
    onCloseAutoFocus: (event) => tracker.close(event, returnFocus),
    onInteractOutside: (event) => {
      onInteractOutside?.(event);
      if (!event.defaultPrevented) tracker.interactedOutside();
    },
  };
}
