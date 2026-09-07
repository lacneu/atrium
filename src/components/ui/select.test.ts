// A select's value stays inside its trigger.
//
// THE DEFECT THIS GUARDS. Most call sites pin the trigger's width (`w-40`,
// `w-56`) because the English label fit when the screen was written.
// tailwind-merge resolves that against the component's own `w-fit` in the
// CALLER's favour, so the box stops growing with its content — while the
// trigger's `whitespace-nowrap` still forbids wrapping. The value span is then a
// flex item with the default `min-width: auto`, which refuses to shrink below
// its text: a label longer than the pinned width spills past the border and
// pushes the chevron out of the box. Seen in production on the instance sheet,
// where a French label is 51 characters in a 224px box.
//
// The invariant is not "the widths are right" — a translation can always be
// longer than the box it was sized for, in a locale nobody reviewed. It is that
// the value CANNOT overflow, whatever the caller pins and whatever the label
// says. That belongs to the component, so it holds for all of its call sites.
//
// The containment is expressed on the TRIGGER, by slot, because Radix's
// `Select.Value` destructures `className` away and renders the span without it —
// so styling the value component directly emits nothing at all.
//
// Rendered rather than grepped: these classes reach the DOM through `cn()`,
// which merges Tailwind utilities and silently drops the loser of a conflict —
// the very mechanism that removed `w-fit` above. Only the emitted markup proves
// what survived.

import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select";

/** The trigger as call sites actually build it: with a pinned width. */
function renderTrigger(triggerClassName: string, label: string): string {
  return renderToStaticMarkup(
    h(
      Select,
      { defaultValue: "a" },
      h(
        SelectTrigger,
        { size: "sm", className: triggerClassName },
        h(SelectValue),
      ),
      h(SelectContent, null, h(SelectItem, { value: "a" }, label)),
    ),
  );
}

/**
 * The `class` attribute of the element carrying `data-slot="<slot>"`, unescaped.
 *
 * Attribute values arrive HTML-escaped, and every arbitrary-variant utility here
 * contains an `&` — so a raw comparison silently misses `[&_svg]:shrink-0` and
 * the assertion passes on absence.
 */
function classesOf(html: string, slot: string): string {
  const el = new RegExp(`<[^>]*data-slot="${slot}"[^>]*>`).exec(html);
  if (!el) throw new Error(`no element carries data-slot="${slot}"`);
  const raw = / class="([^"]*)"/.exec(el[0])?.[1] ?? "";
  return raw
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

describe("select trigger containment", () => {
  test("the value can shrink and ellipsize under a caller-pinned width", () => {
    const trigger = classesOf(
      renderTrigger("w-56", "Mandataire de confiance"),
      "select-trigger",
    );

    // `min-w-0` lets the flex item shrink below its text; `truncate` turns the
    // overflow into an ellipsis. Either one alone still spills.
    expect(trigger).toContain("[&>[data-slot=select-value]]:min-w-0");
    expect(trigger).toContain("[&>[data-slot=select-value]]:truncate");
  });

  test("the containment targets the slot Radix actually renders", () => {
    // The selector above only bites if the value really is a DIRECT child of the
    // trigger carrying that slot. Asserting the class string alone would pass
    // just as happily against a slot name nothing in the DOM uses.
    const html = renderTrigger("w-40", "REST (API server)");

    expect(html).toMatch(
      /data-slot="select-trigger"[^>]*>\s*<span[^>]*data-slot="select-value"/,
    );
  });

  test("a caller's own class is added to the containment, never instead of it", () => {
    const trigger = classesOf(
      renderTrigger("w-40", "REST (API server)"),
      "select-trigger",
    );

    expect(trigger).toContain("[&>[data-slot=select-value]]:truncate");
    expect(trigger).toContain("w-40");
  });

  test("the chevron keeps its own width while the value gives way", () => {
    const trigger = classesOf(renderTrigger("w-56", "x"), "select-trigger");

    // Without this the icon is the flex item that shrinks, and the box shows a
    // squashed chevron next to text that fits.
    expect(trigger).toContain("[&_svg]:shrink-0");
  });

  test("the pinned width really does win over the component's `w-fit`", () => {
    // Not decoration: this is WHY the containment is needed. If a future
    // Tailwind or tailwind-merge kept `w-fit` instead, the box would grow with
    // its content and the overflow would be impossible — and the assertions
    // above would be guarding a defect that can no longer happen.
    const trigger = classesOf(renderTrigger("w-56", "x"), "select-trigger");

    expect(trigger).toContain("w-56");
    expect(trigger.split(/\s+/)).not.toContain("w-fit");
  });
});
