/// <reference types="vite/client" />
//
// Two LAYOUT regressions a screenshot caught and no test could have (2026-09-17),
// plus the wiring of the metadata action added beside them.
//
// 1. Expanded tool activity was squeezed to the width of its collapsed summary.
//    `.oc-flowact` — the group that holds BOTH the summary row and, once open, the
//    ToolCards — carried `width: fit-content`. Collapsed that is the intended quiet
//    chip; expanded it measured the same short label ("2 outils") and every card's
//    arguments and results wrapped into a column a few words wide.
//
// 2. A delivered document's first rendered page sat BESIDE the file chip, the rest
//    underneath. The chip was inline-level (`inline-flex`) and so are the page
//    thumbnails, so they shared a line until it filled.
//
// WHAT THIS GUARD IS, precisely: a cheap syntactic tripwire, NOT a layout test. It
// reads the FIRST matching declaration block and therefore misses a later override,
// a more specific selector, a media query, the flex context the rule lands in,
// narrow columns and RTL. Nothing here renders CSS, so the alternative is no guard
// at all — but the limits belong in writing rather than in the reader's assumptions.
//
// KNOWN CONSEQUENCE of the second fix, accepted: several ordinary file chips can no
// longer share a line. A document is normally followed by its pages, which is the
// case that was broken; a row of unrelated files is the rarer one.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// COMMENT-STRIPPED: commenting a rule out is exactly how it would disappear, and a
// guard satisfied by the prose that explains the rule guards nothing.
const CSS = readFileSync(
  join(process.cwd(), "src/chat/convexChat.css"),
  "utf-8",
).replace(/\/\*[\s\S]*?\*\//g, " ");

/** The declarations of the FIRST rule whose selector list is exactly `selector`. */
function block(selector: string): string {
  const re = new RegExp(
    `(^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\>]/g, "\\$&")}\\s*\\{([^}]*)\\}`,
  );
  const m = re.exec(CSS);
  expect(m, `no rule for ${selector}`).not.toBeNull();
  return m![2];
}

describe("inline turn activity", () => {
  test("the GROUP does not size itself to its content", () => {
    // Its content is the collapsed row; the expanded cards live in the same box.
    expect(block(".oc-flowact")).not.toMatch(/width:\s*(fit|min|max)-content/);
  });

  test("the collapsed ROW still hugs its label", () => {
    // The quiet-chip look is the point — it just belongs to the row.
    expect(block(".oc-flowact > .oc-actrow")).toMatch(/width:\s*fit-content/);
  });
});

describe("delivered file chip", () => {
  test("it is block-level, so the pages that follow start their own line", () => {
    const rules = block(".oc-media--file");
    expect(rules).toMatch(/display:\s*flex/);
    expect(rules).not.toMatch(/display:\s*inline-/);
  });

  test("and still hugs its label rather than spanning the thread", () => {
    expect(block(".oc-media--file")).toMatch(/width:\s*fit-content/);
  });
});

describe("the metadata action is really wired to the chip", () => {
  // The query and the formatters are unit-tested, and the CSS has its tripwire —
  // but deleting the button from the chip would leave every one of those green.
  // Comment-stripped, so the prose beside the code cannot satisfy the patterns.
  const MEDIA_PART = readFileSync(
    join(process.cwd(), "src/chat/MediaPart.tsx"),
    "utf-8",
  )
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");

  test("the chip renders the metadata button, fed by the chip's OWN ids", () => {
    // The SOURCE, not just the prop name: `storageId="incorrect"` satisfied a guard
    // that only looked for `storageId=`, compiles, and breaks every query.
    expect(MEDIA_PART).toMatch(
      /<FileMetaButton[\s\S]{0,120}storageId=\{storageId\}/,
    );
    // …and the QUERY argument, not just the prop: swapping the inner one for a
    // constant left the outer match green while every lookup hit the wrong blob.
    expect(MEDIA_PART).toMatch(/storageId:\s*storageId as Id<"_storage">/);
    // …and the popover really asks when it opens. `false && messageId` also
    // satisfies a guard that only looks for the argument names.
    expect(MEDIA_PART).toMatch(/open && messageId/);
  });

  test("the button asks about THIS bubble, not just the blob", () => {
    // A storageId alone does not name a file occurrence: a fork re-uses the blob,
    // so the same id belongs to several conversations. And the id must come from the
    // MESSAGE context — `const messageId = "incorrect"` satisfied a guard that only
    // matched the argument's name.
    expect(MEDIA_PART).toMatch(/useMessage\(\(msg\)\s*=>\s*msg\.id\)/);
    expect(MEDIA_PART).toMatch(/messageId:\s*messageId/);
  });

  test("the name shown is the DISPLAY name, not the stored one", () => {
    // The stored row keeps the gateway's `---<uuid>` media id, which the chip and
    // the download both strip.
    expect(MEDIA_PART).toMatch(/value=\{displayFilename\(meta\.filename\)/);
  });
});

describe("the popover renders what the query answers", () => {
  // Deleting a branch or inverting two of them leaves every backend test green: the
  // query would keep answering correctly while the user reads something else.
  const MEDIA = readFileSync(
    join(process.cwd(), "src/chat/MediaPart.tsx"),
    "utf-8",
  )
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");

  test("`null` still renders the unavailable note", () => {
    // The backend test proves the query answers `null`; only this proves the user is
    // told something rather than shown an empty popover.
    // Tight, and anchored on the branch's FIRST element: a window wide enough to
    // reach the note further down stayed green when the branch was replaced by an
    // empty element.
    expect(MEDIA).toMatch(
      /meta === null \? \(\s*<div[^>]*>\{m\.file_meta_unavailable\(\)\}/,
    );
  });

  test("every field the query answers reaches the popover", () => {
    // Deleting the Type, Size, Added-on or SHA-256 rows left every guard green: the
    // backend tests prove the query returns them, and nothing proved they are shown.
    for (const [label, value] of [
      ["file_meta_type", "meta.contentType"],
      ["file_meta_size", "formatFileSize"],
      ["file_meta_added", "meta.createdAt"],
    ] as const) {
      expect(MEDIA, label).toMatch(
        new RegExp(`${label}\\(\\)[\\s\\S]{0,400}${value.replace(".", "\\.")}`),
      );
    }
    // The digest gets its own row, with the copy control beside it. RENDERED and
    // COPYABLE, both anchored: three independent matches stayed green when the
    // `<code>` was deleted (the calls survive in the condition and the handler) and
    // when `onClick` was deleted (the button's labels survive).
    expect(MEDIA).toMatch(/file_meta_digest\(\)/);
    expect(MEDIA).toMatch(/<code[^>]*>\s*\{digestLabel\(meta\.sha256\)\}/);
    expect(MEDIA).toMatch(
      /onClick=\{[\s\S]{0,200}clipboard[\s\S]{0,120}digestLabel\(meta\.sha256\)/,
    );
    // …and the exact byte count beside the human size, which is the whole reason
    // both are shown.
    expect(MEDIA).toMatch(/exactBytes\(meta\.bytes/);
  });

  test("a Row actually renders its value", () => {
    // Every label/value guard above reads the CALL SITES. If `Row` stopped putting
    // `{value}` in its `<dd>`, all of them would stay green while the popover showed
    // a column of empty cells.
    expect(MEDIA).toMatch(/<dt>\{label\}<\/dt>\s*<dd>\{value\}<\/dd>/);
  });

  test("the origin row exists, and its two branches are not swapped", () => {
    // The OPERATOR too: `meta.direction !== "inbound"` swaps the two labels while
    // satisfying a pattern that only checks their order.
    expect(MEDIA).toMatch(
      /label=\{m\.file_meta_origin\(\)\}[\s\S]{0,300}meta\.direction === "inbound"[\s\S]{0,120}file_meta_origin_inbound\(\)[\s\S]{0,120}file_meta_origin_outbound\(\)/,
    );
  });
});

describe("the origin label does not claim authorship", () => {
  // `direction: "inbound"` means the file came from a USER turn — in a group chat,
  // possibly someone else's. The label said "Sent by you" / "Envoyé par vous", which
  // the widened read boundary turned from harmless into a visible lie.
  const messages = (loc: string) =>
    JSON.parse(readFileSync(join(process.cwd(), `messages/${loc}.json`), "utf-8")) as
      Record<string, string>;

  test("neither locale says the reader sent it", () => {
    expect(messages("fr").file_meta_origin_inbound).not.toMatch(/vous/i);
    expect(messages("en").file_meta_origin_inbound).not.toMatch(/\byou\b/i);
  });

  test("and both still distinguish the two directions", () => {
    for (const loc of ["fr", "en"]) {
      const m = messages(loc);
      expect(m.file_meta_origin_inbound, loc).toBeTruthy();
      expect(m.file_meta_origin_outbound, loc).toBeTruthy();
      expect(m.file_meta_origin_inbound, loc).not.toBe(
        m.file_meta_origin_outbound,
      );
    }
  });
});
