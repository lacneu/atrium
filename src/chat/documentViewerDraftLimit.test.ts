// The draft cap's refusal reaches the editor as its OWN toast (convex/documentDrafts.ts
// `draft_limit_reached`), not the generic "could not save". Pinned on the
// comment-stripped source: React wiring with no pure function to call.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const SRC = readFileSync(join(process.cwd(), "src/chat/DocumentViewer.tsx"), "utf-8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");

test("a refused new draft is told as the limit", () => {
  expect(SRC).toMatch(/includes\("draft_limit_reached"\)\s*\?\s*m\.docviewer_draft_limit\(\)\s*:\s*m\.docviewer_save_failed\(\)/);
});

test("the rendition is scoped to the conversation the viewer shows it in", () => {
  expect(SRC).toMatch(/<RenditionView\s+sourceStorageId=\{doc\.sourceStorageId as string\}\s+chatId=\{chatId\}/);
  expect(SRC).toMatch(/useQuery\(api\.fileRenditions\.getRendition, \{\s*sourceStorageId: sourceStorageId as Id<"_storage">,\s*\.\.\.scope,/);
  expect(SRC).toMatch(/request\(\{ sourceStorageId: sourceStorageId as Id<"_storage">, \.\.\.scope \}\)/);
});
