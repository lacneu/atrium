// Where a dialog gives the focus back when it closes (lot 15).
//
// No dialog of the app has a Radix trigger: each one is opened by its view's state
// — a button, a menu item, a calendar occurrence, the shared confirm and prompt —
// and Radix, as a dialog closes, only tries that absent trigger. The focus fell on
// the page: even while the opener was still there, and so once a measured view had
// hidden it meanwhile (the project page's "New subfolder" goes into its ⋯ when the
// window narrows) or rendered another in its place (a calendar occurrence, from
// month to agenda). One rule for every dialog, applied by the shared contents
// (`DialogContent`, `AlertDialogContent`, `SheetContent`):
//   1. the control that opened it — for an item of a menu or a popover, the
//      trigger of that menu or popover: the item leaves the page with it — while
//      it can still take the focus;
//   2. the fallbacks its view names, read as it closes: a control that stays (the
//      ⋯ the action went into, the same occurrence in the calendar's new view);
//   3. the first control of the nearest part of the page around the opener that
//      is still there — within its view: never past the routed `main` or a
//      sidebar, whose content may be another view by then.
// `focusFirst` checks that each one really takes it. A focus placed elsewhere by
// the time the dialog closes (the view moved it on purpose) is left where it is.
import { useRef } from "react";
import { canTakeFocus, focusFirst } from "./focusFallback";

/** A view's own fallbacks for the focus, read when its dialog closes. */
export type ReturnFocus = () => ReadonlyArray<HTMLElement | null>;

/** What can take the focus inside a part of the page. */
const FOCUSABLE =
  "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])";

/** The floating layers a dialog can be opened from: a menu, a popover. */
const LAYER = '[role="menu"], [data-popover-of]';

/** How many layers deep a chain (a submenu, a menu in a popover) is followed — a
 *  guard, not a real depth. */
const LAYER_DEPTH = 8;

/** The page's top-level areas — the routed view's `main`, a sidebar's `aside`: the
 *  walk for a surviving control stops inside them. Past them, a control would
 *  belong to another view (the one the user navigated to meanwhile). */
const AREA = "main, aside";

/** The trigger of a floating layer: a menu's, by the label Radix gives the menu
 *  (`aria-labelledby`); a popover's, by the pair the shared Popover stamps on both
 *  (`data-popover-of` ↔ `data-popover-trigger`). */
function triggerOf(layer: Element, doc: Document): Element | null {
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
    const layer = current.closest(LAYER);
    if (layer === null) return current;
    const trigger = triggerOf(layer, doc);
    if (trigger === null || layer.contains(trigger)) return current;
    current = trigger;
  }
  return current;
}

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

/** What a dialog remembers of its opening: the control, and the page around it. */
export interface Opening {
  origin: HTMLElement | null;
  regions: Element[];
}

/** The opening as it is now — the element holding the focus, before the dialog
 *  takes it — unless the focus is nowhere. */
export function captureOpening(doc: Document = document): Opening {
  const active = doc.activeElement;
  const opener = active === null || active === doc.body ? null : openerOf(active, doc);
  const origin = opener as HTMLElement | null;
  return { origin, regions: regionsOf(origin) };
}

/** The order the focus is offered in when a dialog closes. */
export function returnFocusOrder(
  opening: Opening | null,
  fallbacks: ReadonlyArray<HTMLElement | null>,
): Array<HTMLElement | null> {
  if (opening === null) return [...fallbacks];
  return [opening.origin, ...fallbacks, nearestSurvivingControl(opening.regions)];
}

/**
 * Gives the focus back as a dialog closes. True when the focus is somewhere real
 * afterwards — already placed by the view, or handed to the first of
 * `returnFocusOrder` that took it —: the caller then keeps Radix from moving it
 * (`event.preventDefault()`). False leaves Radix's own default.
 */
export function giveFocusBack(
  opening: Opening | null,
  fallbacks: ReadonlyArray<HTMLElement | null>,
  doc: Document = document,
): boolean {
  const active = doc.activeElement;
  if (active !== null && active !== doc.body && active.isConnected) return true;
  return focusFirst(returnFocusOrder(opening, fallbacks)) !== null;
}

/** The part of a Radix auto-focus event the handlers use. */
export interface AutoFocusEvent {
  readonly defaultPrevented: boolean;
  preventDefault(): void;
}

type AutoFocusHandler<E> = ((event: E) => void) | undefined;

/** Opening: the opening is read first — the view's own handler may move the
 *  focus at once (the shared prompt focuses its field). */
export function openAutoFocus<E extends AutoFocusEvent>(
  event: E,
  own: AutoFocusHandler<E>,
  doc: Document = document,
): Opening {
  const opening = captureOpening(doc);
  own?.(event);
  return opening;
}

/** Closing: the view's own handler first — one that prevented the default has
 *  placed the focus itself (the drawer's toggle, the reply's ⋯) —, then the rule. */
export function closeAutoFocus<E extends AutoFocusEvent>(
  event: E,
  opening: Opening | null,
  own: AutoFocusHandler<E>,
  returnFocus: ReturnFocus | undefined,
  doc: Document = document,
): void {
  own?.(event);
  if (event.defaultPrevented) return;
  if (giveFocusBack(opening, returnFocus?.() ?? [], doc)) event.preventDefault();
}

/**
 * The two auto-focus handlers of a shared dialog content, in place of the view's
 * (which they call): the opening is remembered as the dialog takes the focus, and
 * given back by the rule above as it closes.
 */
export function useFocusReturn<E extends AutoFocusEvent>(
  returnFocus: ReturnFocus | undefined,
  onOpenAutoFocus: AutoFocusHandler<E>,
  onCloseAutoFocus: AutoFocusHandler<E>,
): { onOpenAutoFocus: (event: E) => void; onCloseAutoFocus: (event: E) => void } {
  const opening = useRef<Opening | null>(null);
  return {
    onOpenAutoFocus: (event) => {
      opening.current = openAutoFocus(event, onOpenAutoFocus);
    },
    onCloseAutoFocus: (event) => {
      closeAutoFocus(event, opening.current, onCloseAutoFocus, returnFocus);
      opening.current = null;
    },
  };
}
