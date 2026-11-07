/// <reference types="vite/client" />
//
// Lot 9 (2026-11, C3): on a phone the side panels — Sources, Sub-agent, Cron,
// Document — open in a sheet. Each panel has its own close in its header; the
// sheet's default close sat on top of it, two × in one corner. Derived from the
// sources: every sheet that hosts a side panel turns its own close off.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const SRC = readFileSync(join(process.cwd(), "src/chat/ConvexChat.tsx"), "utf-8");

/** Each `<SheetContent …>` opening tag that hosts a side panel. */
function panelSheets(): string[] {
  return [...SRC.matchAll(/<SheetContent\b[^>]*>/gs)]
    .map((m) => m[0])
    .filter((tag) => tag.includes("oc-sources-panel-sheet"));
}

describe("a side panel in a sheet shows one close, its own (C3)", () => {
  test("the derivation sees the four panels: sources, sub-agent, cron, document", () => {
    expect(panelSheets()).toHaveLength(4);
  });

  test("each of those sheets turns its default close off", () => {
    const doubled = panelSheets().filter((tag) => !/showCloseButton=\{false\}/.test(tag));
    expect(doubled).toEqual([]);
  });
});
