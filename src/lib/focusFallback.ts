// Giving the focus back to the first element that REALLY takes it (lot 12).
//
// `focus()` fails silently: on an element gone from the page, a disabled control,
// anything inert or hidden, it does nothing and says nothing. A fallback that
// trusts its own choice then drops the focus on the page — the block picker did,
// on a composer disabled by a read-only chat or an unavailable bridge. So every
// candidate is checked before it is offered the focus, and checked again after,
// where it counts: the document's active element.

/** What the walk reads of an element; a DOM `HTMLElement` has all of it. */
export interface FocusCandidate {
  readonly isConnected: boolean;
  readonly ownerDocument: { readonly activeElement: unknown };
  readonly tabIndex: number;
  matches(selectors: string): boolean;
  closest(selectors: string): unknown;
  getClientRects(): { readonly length: number };
  checkVisibility?(options?: CheckVisibilityOptions): boolean;
  hasAttribute(name: string): boolean;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  addEventListener(type: "blur", listener: () => void, options: AddEventListenerOptions): void;
  focus(options?: FocusOptions): void;
}

/** A control disabled by itself or by its fieldset, or announced as such. */
const DISABLED = ':disabled, [aria-disabled="true"]';

/**
 * May this element take the focus at all? Not once it has left the page, nor
 * when it is disabled, inside something inert, or not rendered visibly: no box
 * (display none, on it or an ancestor), visibility hidden, content-visibility
 * hidden. An engine without `checkVisibility` is left to the active-element
 * check that follows every focus.
 */
export function canTakeFocus(el: FocusCandidate): boolean {
  if (!el.isConnected) return false;
  if (el.matches(DISABLED)) return false;
  if (el.closest("[inert]") !== null) return false;
  if (el.getClientRects().length === 0) return false;
  return el.checkVisibility?.({ checkVisibilityCSS: true, visibilityProperty: true }) ?? true;
}

/**
 * Moves the focus onto `el`. An element not focusable by itself — the reply, a
 * plain block — BORROWS a tabindex of -1 for this one focus: it gives it back
 * when the focus leaves, or at once when the focus did not take.
 */
export function focusElement(el: FocusCandidate): void {
  const borrow = !el.hasAttribute("tabindex") && el.tabIndex < 0;
  if (borrow) el.setAttribute("tabindex", "-1");
  el.focus({ preventScroll: true });
  if (!borrow) return;
  if (el.ownerDocument.activeElement === el) {
    el.addEventListener("blur", () => el.removeAttribute("tabindex"), { once: true });
  } else {
    el.removeAttribute("tabindex");
  }
}

/**
 * Offers the focus to each candidate in turn and stops at the first one that
 * REALLY holds it — its document's active element is that very element —,
 * passing over those that cannot take it (`canTakeFocus`) and those that should
 * have but did not. Null when none did: the caller leaves the focus to the
 * browser's own default.
 */
export function focusFirst<E extends FocusCandidate>(
  candidates: readonly (E | null | undefined)[],
): E | null {
  const tried = new Set<E>();
  for (const el of candidates) {
    if (el === null || el === undefined || tried.has(el)) continue;
    tried.add(el);
    if (!canTakeFocus(el)) continue;
    focusElement(el);
    if (el.ownerDocument.activeElement === el) return el;
  }
  return null;
}
