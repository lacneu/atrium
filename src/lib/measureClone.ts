// Natural widths of a LIVE bar under presentations it is not currently showing.
//
// A bar that sheds controls cannot read the width of what it has hidden, and a
// React "ghost" copy of its controls would run their effects twice: a second
// dictation shortcut listener, a second Talk call controller. A DOM clone has none
// of that — no React, no listeners — and carries every control the bar renders,
// hidden ones included, with their current labels. It is laid out off-screen at
// its natural width, once per presentation, then removed in the same task.

/**
 * The width `el` needs under each variant: `apply` reconfigures the clone (its
 * attributes or classes) before the width is read. `measureClass` must make the
 * clone absolutely positioned, invisible and `width: max-content`.
 */
export function measureCloneWidths(
  el: HTMLElement,
  variants: ReadonlyArray<(clone: HTMLElement) => void>,
  measureClass: string,
): number[] {
  const host = el.parentElement;
  if (host === null) return variants.map(() => 0);
  const clone = el.cloneNode(true) as HTMLElement;
  clone.classList.add(measureClass);
  clone.setAttribute("aria-hidden", "true");
  clone.setAttribute("inert", "");
  // Ids must stay unique while the clone exists (labels, aria-controls).
  clone.removeAttribute("id");
  for (const node of Array.from(clone.querySelectorAll("[id]"))) {
    node.removeAttribute("id");
  }
  host.appendChild(clone);
  try {
    return variants.map((apply) => {
      apply(clone);
      return clone.getBoundingClientRect().width;
    });
  } finally {
    clone.remove();
  }
}
