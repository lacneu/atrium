// Where the focus goes when a layer closes (lots 15-16).
//
// Every layer of the app — dialog, alert dialog, sheet, popover, menu — is built
// from the shared contents (components/ui), and each one gives the focus back by
// this one rule as it closes:
//   0. THE GUARD, FIRST: a focus already on a control outside the closing layer
//      stays there — the user or the view put it there (the composer focused while
//      the drawer slid out). Nobody moves it: not the rule, not a view, not Radix.
//   1. the control that opened the layer, while it can still take the focus;
//   2. the fallbacks its view names (a control that stays: the ⋯ an action went
//      into, the same calendar occurrence in the view now shown, the drawer's
//      toggle) — a view only ever adds fallbacks, it never replaces the rule;
//   3. the first control of the nearest part of the page around the opener that
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
import { useCallback, useRef } from "react";
import { canTakeFocus, focusFirst } from "./focusFallback";

/** A view's own fallbacks for the focus, read when its layer closes. */
export type ReturnFocus = () => ReadonlyArray<HTMLElement | null>;

/** What can take the focus inside a part of the page. */
const FOCUSABLE =
  "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])";

/** The floating layers an item can open a dialog from: a menu, a popover. */
const FLOATING = '[role="menu"], [data-popover-of]';

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
  const pair = layer.getAttribute("data-popover-of");
  if (pair !== null) {
    return (
      Array.from(doc.querySelectorAll("[data-popover-trigger]")).find(
        (el) => el.getAttribute("data-popover-trigger") === pair,
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
 * nowhere, or on a control gone since.
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
    const opener = openerOf(el, doc);
    return opener !== null && opener.isConnected ? (opener as HTMLElement) : null;
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

/** What a layer remembers of its opening: the control, and the page around it. */
export interface Opening {
  origin: HTMLElement | null;
  regions: Element[];
}

/** A dialog's opening, as its content mounts (`openerFor` the page's history). */
export function captureOpening(
  layer: Element,
  history: FocusHistory = FOCUS_HISTORY,
  doc: Document = document,
): Opening {
  const origin = openerFor(layer, history.entries(), doc);
  return { origin, regions: regionsOf(origin) };
}

/** A popover's or a menu's opening: its trigger. */
export function triggerOpening(layer: Element | null, doc: Document = document): Opening {
  const origin = (layer === null ? null : triggerOf(layer, doc)) as HTMLElement | null;
  return { origin, regions: regionsOf(origin) };
}

/** The order the focus is offered in when a layer closes. */
export function returnFocusOrder(
  opening: Opening | null,
  fallbacks: ReadonlyArray<HTMLElement | null>,
): Array<HTMLElement | null> {
  if (opening === null) return [...fallbacks];
  return [opening.origin, ...fallbacks, nearestSurvivingControl(opening.regions)];
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
 * A layer closes: the guard, then the rule. Radix is kept from moving the focus
 * again (`preventDefault`) whenever the focus is somewhere real; when nothing took
 * it, its own default stays.
 */
export function closeLayerFocus(
  event: AutoFocusEvent,
  layer: Element | null,
  opening: Opening | null,
  returnFocus: ReturnFocus | undefined,
  doc: Document = document,
): void {
  if (focusPlaced(layer, doc)) {
    event.preventDefault();
    return;
  }
  if (focusFirst(returnFocusOrder(opening, returnFocus?.() ?? [])) !== null) {
    event.preventDefault();
  }
}

/** The kinds of layers: a dialog (alert dialog, sheet) has no trigger, a popover
 *  and a menu have one. */
export type LayerKind = "dialog" | "popover" | "menu";

/**
 * A layer of `kind` closes: a dialog gives the focus back from the opening read
 * as it mounted, a popover or a menu from its trigger. A popover dismissed by an
 * interaction outside it leaves the focus where that interaction put it — Radix's
 * own choice for popovers, kept: only the guard runs.
 */
export function closeLayerOfKind(
  kind: LayerKind,
  event: AutoFocusEvent,
  layer: Element | null,
  captured: Opening | null,
  interactedOutside: boolean,
  returnFocus: ReturnFocus | undefined,
  doc: Document = document,
): void {
  if (kind === "popover" && interactedOutside) {
    if (focusPlaced(layer, doc)) event.preventDefault();
    return;
  }
  const opening = kind === "dialog" ? captured : triggerOpening(layer, doc);
  closeLayerFocus(event, layer, opening, returnFocus, doc);
}

/**
 * The focus handling of a shared layer content: its `ref` reads the opening as the
 * content mounts (a dialog's), its `onCloseAutoFocus` runs the guard and the rule
 * (`closeLayerOfKind`), its `onInteractOutside` notes a popover dismissed from
 * outside.
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
  const node = useRef<HTMLElement | null>(null);
  const opening = useRef<Opening | null>(null);
  const outside = useRef(false);
  const ref = useCallback(
    (el: HTMLElement | null) => {
      if (el === null || el === node.current) return;
      node.current = el;
      outside.current = false;
      opening.current = kind === "dialog" ? captureOpening(el) : null;
    },
    [kind],
  );
  return {
    ref,
    onCloseAutoFocus: (event) => {
      closeLayerOfKind(kind, event, node.current, opening.current, outside.current, returnFocus);
      node.current = null;
      opening.current = null;
      outside.current = false;
    },
    onInteractOutside: (event) => {
      onInteractOutside?.(event);
      if (!event.defaultPrevented) outside.current = true;
    },
  };
}
