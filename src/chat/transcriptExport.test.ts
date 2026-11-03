// UI-5: unit tests for the pure transcript serializers. The export is trust-
// sensitive (must not silently drop content), so truncation + part handling are
// pinned here. `exportedAt`/`createdAt` are fixed epochs -> deterministic UTC.

import { describe, expect, it } from "vitest";
import {
  transcriptToMarkdown,
  transcriptToJson,
  exportFilename,
  windowIsTruncated,
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
    const note = "Export limité aux";
    expect(transcriptToMarkdown(SAMPLE, { truncated: true })).toContain(note);
    expect(transcriptToMarkdown(SAMPLE, { truncated: false })).not.toContain(note);
    expect(transcriptToMarkdown(SAMPLE, {})).not.toContain(note);
  });

  it("states the window it holds: 200 for a full window, fewer for one the budget stopped", () => {
    const full = Array.from({ length: 200 }, (_, i) => ({ role: "user" as const, text: `m${i}`, createdAt: T0 + i }));
    // A full window reads exactly as before 0.103.4.
    expect(transcriptToMarkdown(full, { truncated: true })).toContain(
      "[Export limité aux 200 messages les plus récents de cette conversation]",
    );
    // A window the read budget stopped never claims 200.
    const md = transcriptToMarkdown(SAMPLE, { truncated: true });
    expect(md).toContain("[Export limité aux 2 messages les plus récents de cette conversation]");
    expect(md).not.toContain("200");
  });

  it("falls back to a default title", () => {
    expect(transcriptToMarkdown([], {})).toContain("# Conversation");
    expect(transcriptToMarkdown([], { title: "   " })).toContain("# Conversation");
  });

  it("renders ONE line per quoted passage, in the order picked", () => {
    const md = transcriptToMarkdown(
      [
        {
          role: "user",
          text: "Corrige ces deux points",
          createdAt: T0,
          quotedExcerpts: ["le premier passage", "le second passage"],
        },
      ],
      {},
    );
    // A transcript that kept only the first passage would misrepresent what the
    // user actually pointed at.
    const iFirst = md.indexOf("> En réponse à : le premier passage");
    const iSecond = md.indexOf("> En réponse à : le second passage");
    expect(iFirst).toBeGreaterThan(-1);
    expect(iSecond).toBeGreaterThan(iFirst);
    expect(md.indexOf("Corrige ces deux points")).toBeGreaterThan(iSecond);
  });

  it("renders the quote-reply line above a quoted user turn", () => {
    const md = transcriptToMarkdown(
      [
        {
          role: "user",
          text: "Corrige ce point",
          createdAt: T0,
          quotedExcerpts: ["le passage cité"],
        },
      ],
      {},
    );
    // Without it, "Corrige ce point" is ambiguous in the transcript.
    expect(md).toContain("> En réponse à : le passage cité");
    const iQuote = md.indexOf("> En réponse à");
    const iText = md.indexOf("Corrige ce point");
    expect(iQuote).toBeGreaterThan(-1);
    expect(iText).toBeGreaterThan(iQuote);
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

  it("carries quotedExcerpt on quoted turns only", () => {
    const json = JSON.parse(
      transcriptToJson(
        [
          {
            role: "user",
            text: "Corrige ce point",
            createdAt: T0,
            quotedExcerpts: ["le passage cité"],
          },
          { role: "assistant", text: "Fait.", createdAt: T0 + 1 },
        ],
        {},
      ),
    );
    expect(json.messages[0].quotedExcerpts).toEqual(["le passage cité"]);
    expect("quotedExcerpts" in json.messages[1]).toBe(false);
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

describe("windowIsTruncated (the listByChat window flag)", () => {
  it("reads the server's flag on a short window the read budget stopped", () => {
    const rows = [{ windowTruncated: true }, {}, {}];
    expect(windowIsTruncated(rows)).toBe(true);
  });

  it("a short window without the flag is whole", () => {
    expect(windowIsTruncated([{}, {}, {}])).toBe(false);
    expect(windowIsTruncated([])).toBe(false);
  });

  it("a full window is truncated, flag or not (a backend that predates the flag)", () => {
    const full = Array.from({ length: 200 }, () => ({}));
    expect(windowIsTruncated(full)).toBe(true);
    expect(windowIsTruncated([{ windowTruncated: true }, ...full.slice(1)])).toBe(true);
    expect(windowIsTruncated(full.slice(1))).toBe(false);
  });
});
