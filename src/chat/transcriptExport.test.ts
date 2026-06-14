// UI-5: unit tests for the pure transcript serializers. The export is trust-
// sensitive (must not silently drop content), so truncation + part handling are
// pinned here. `exportedAt`/`createdAt` are fixed epochs -> deterministic UTC.

import { describe, expect, it } from "vitest";
import {
  transcriptToMarkdown,
  transcriptToJson,
  exportFilename,
  type ExportMessage,
} from "./transcriptExport";

const T0 = Date.UTC(2026, 5, 6, 1, 30); // 2026-06-06 01:30 UTC
const SAMPLE: ExportMessage[] = [
  { role: "user", text: "Bonjour", createdAt: T0 },
  {
    role: "assistant",
    text: "Voici le fichier.",
    createdAt: T0 + 60_000,
    parts: [
      { kind: "tool", name: "search" }, // omitted
      { kind: "file", filename: "rapport.md" }, // -> [fichier : rapport.md]
      { kind: "reasoning" }, // omitted
    ],
  },
];

describe("transcriptToMarkdown", () => {
  it("renders role headers, text, and file parts; omits tool/reasoning", () => {
    const md = transcriptToMarkdown(SAMPLE, { title: "Démo" });
    expect(md).toContain("# Démo");
    expect(md).toContain("## Utilisateur · 2026-06-06 01:30 UTC");
    expect(md).toContain("Bonjour");
    expect(md).toContain("## OpenClaw · 2026-06-06 01:31 UTC");
    expect(md).toContain("[fichier : rapport.md]");
    expect(md).not.toContain("search"); // tool omitted
  });

  it("emits the truncation marker ONLY when truncated", () => {
    const note = "Export limité aux 200 messages";
    expect(transcriptToMarkdown(SAMPLE, { truncated: true })).toContain(note);
    expect(transcriptToMarkdown(SAMPLE, { truncated: false })).not.toContain(note);
    expect(transcriptToMarkdown(SAMPLE, {})).not.toContain(note);
  });

  it("falls back to a default title", () => {
    expect(transcriptToMarkdown([], {})).toContain("# Conversation");
    expect(transcriptToMarkdown([], { title: "   " })).toContain("# Conversation");
  });
});

describe("transcriptToJson", () => {
  it("serializes a clean shape (role/text/createdAt/attachments) — no _id/status/runId", () => {
    const json = JSON.parse(transcriptToJson(SAMPLE, { title: "Démo", truncated: true }));
    expect(json.title).toBe("Démo");
    expect(json.truncated).toBe(true);
    expect(json.messageCount).toBe(2);
    expect(json.messages[1]).toEqual({
      role: "assistant",
      createdAt: T0 + 60_000,
      text: "Voici le fichier.",
      attachments: ["rapport.md"],
    });
    // No leaked internals.
    expect(JSON.stringify(json)).not.toMatch(/_id|runId|status/);
  });

  it("defaults truncated to false and exportedAt to null", () => {
    const json = JSON.parse(transcriptToJson([], {}));
    expect(json.truncated).toBe(false);
    expect(json.exportedAt).toBeNull();
  });
});

describe("exportFilename", () => {
  it("slugs the title, stripping accents and punctuation", () => {
    expect(exportFilename("Réunion: Été 2026!")).toBe("reunion-ete-2026");
  });
  it("falls back to 'conversation' for empty/blank/null", () => {
    expect(exportFilename(null)).toBe("conversation");
    expect(exportFilename("   ")).toBe("conversation");
    expect(exportFilename("!!!")).toBe("conversation");
  });
});
