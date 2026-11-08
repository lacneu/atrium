// Where the keyboard focus goes when an overlay of the composer's action bar
// closes, or loses the item that held the focus, while its own trigger may be gone
// (lot 14). The measured bar moves its controls into the "More" menu and back: a
// trigger can be `display: none` by the time its overlay closes — the More button
// once every control came back, a control's chevron once it went into the menu —
// and Radix then tried that hidden trigger and dropped the focus on the page.
import { focusFirst } from "@/lib/focusFallback";

/** The live composer pieces around an element of its bar. */
export interface ComposerPieces {
  bar: Element | null;
  more: HTMLElement | null;
  field: HTMLElement | null;
}

/** The bar, the More button and the field around `inside` (an element of the bar,
 *  even hidden), or those of the page's composer when it has left the page. */
export function composerAround(inside: Element | null, doc: Document = document): ComposerPieces {
  const bar =
    (inside?.isConnected === true ? inside.closest(".oc-composer__bar") : null) ??
    doc.querySelector(".oc-composer__bar:not(.oc-composer__bar--measure)");
  const composer = bar?.closest(".oc-composer") ?? null;
  return {
    bar,
    more: bar?.querySelector<HTMLElement>(".oc-composer__more") ?? null,
    field: composer?.querySelector<HTMLElement>(".oc-composer__input") ?? null,
  };
}

/** What can take the focus inside a control: itself when focusable, else its
 *  first focusable part (the Talk pill is a span around two buttons). */
const FOCUSABLE = "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])";

/** The bar control a More item stands for, by its `data-overflow` key. */
export function barControl(bar: Element | null, key: string | null): HTMLElement | null {
  if (bar === null || key === null) return null;
  const control = bar.querySelector<HTMLElement>(`[data-overflow="${key}"]`);
  if (control === null) return null;
  return control.tabIndex >= 0 ? control : control.querySelector<HTMLElement>(FOCUSABLE);
}

/**
 * The focus was LOST as the More menu shed the item that held it (its control went
 * back to the bar): hands it to the first candidate that really takes it
 * (`focusFirst`), and says whether one did. A focus the user already placed
 * somewhere (a click in the field) is left alone. An overlay that CLOSES goes
 * through the shared rule instead (lib/returnFocus): these candidates are its
 * fallbacks (`returnFocus`).
 */
export function restoreComposerFocus(
  candidates: ReadonlyArray<HTMLElement | null>,
  doc: Document = document,
): boolean {
  const active = doc.activeElement;
  if (active !== null && active !== doc.body && active.isConnected) return false;
  return focusFirst(candidates) !== null;
}
