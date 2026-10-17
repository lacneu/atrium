// THE CODE REGIONS OF A MARKDOWN TEXT, as OpenClaw finds them — the SPA copy of the
// bridge port (bridge/src/providers/openclaw/code-regions.ts), kept identical by a parity
// test (widgets/shortcodes.test.ts): the bridge decides which `[embed]` shortcodes name a
// widget, the SPA which ones it hides, and both must agree (codex review 4, finding 3).
//
// Port AS IS of `findCodeRegions` (src/shared/text/code-regions.ts:15 at v2026.9.33) →
// `findMarkdownCodeRegions` (packages/markdown-core/src/reasoning-tag-parser.ts:478) →
// `parseMarkdownOwnership` (same file, :349), restricted to what `findCodeRegions` is called
// with by its two readers here (no option: neither the inline/indented sources nor the text
// spans, GFM tables on). The same parser, at the versions the upstream package pins
// (packages/markdown-core/package.json: mdast-util-from-markdown 2.0.3, mdast-util-gfm-table
// 2.0.0, micromark-extension-gfm-table 2.1.2),
// so every CommonMark block rule holds: fenced blocks, indented blocks (four spaces, a tab,
// inside a list item), container-nested fences, inline code spans. A `MEDIA:` line or an
// `[embed]` shortcode inside one of them is a literal example.

import { fromMarkdown, type Extension } from "mdast-util-from-markdown";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTable } from "micromark-extension-gfm-table";

/** reasoning-tag-parser.ts:28. */
const DISABLE_HTML_MARKDOWN: Extension = {
  disable: { null: ["htmlFlow", "htmlText"] },
} as unknown as Extension;

/** reasoning-tag-parser.ts:189. */
type PositionedNode = {
  type?: string;
  value?: string;
  position?: {
    start?: { offset?: number; line?: number };
    end?: { offset?: number; line?: number };
  };
  children?: PositionedNode[];
};

/** A code region: `block` for a fenced or indented block, false for an inline code span. */
export type CodeRegion = { start: number; end: number; block: boolean };

/** reasoning-tag-parser.ts:349-475, the `regions` it returns (no option set). */
function parseCodeRegions(text: string): CodeRegion[] {
  if (!text) return [];
  const tree = fromMarkdown(text, {
    extensions: [DISABLE_HTML_MARKDOWN as never, gfmTable()],
    mdastExtensions: [gfmTableFromMarkdown()],
  }) as PositionedNode;
  const regions: CodeRegion[] = [];
  for (const block of tree.children ?? []) {
    const pending: PositionedNode[] = [block];
    while (pending.length > 0) {
      const node = pending.pop()!;
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if ((node.type === "code" || node.type === "inlineCode") && start !== undefined && end !== undefined) {
        regions.push({ start, end, block: node.type === "code" });
      }
      for (const child of [...(node.children ?? [])].reverse()) pending.push(child);
    }
  }
  regions.sort((left, right) => left.start - right.start);
  return regions;
}

/** `findMarkdownCodeRegions` (reasoning-tag-parser.ts:478): CommonMark code needs a
 *  literal delimiter or indentation. */
export function findCodeRegions(text: string): CodeRegion[] {
  return /[`~\t]| {4}/u.test(text) ? parseCodeRegions(text) : [];
}

/** `isInsideCode` (code-regions.ts:103). */
export function isInsideCode(pos: number, regions: ReadonlyArray<{ start: number; end: number }>): boolean {
  return regions.some((region) => pos >= region.start && pos < region.end);
}
