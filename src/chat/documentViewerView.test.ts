import { describe, expect, test } from "vitest";
import {
  clampPage,
  fileExtension,
  isConvertibleDocument,
  viewerKindFor,
} from "./documentViewerView";

// The kind decision is the viewer's routing table: a wrong kind either hides a
// viewable document behind a download link (regression of the feature) or
// feeds a binary to the text renderer (garbage on screen).

describe("viewerKindFor", () => {
  test("markdown renders INTERPRETED: text/markdown OR the .md extension — even over a generic text/plain mime", () => {
    expect(viewerKindFor("text/markdown", "notes.md")).toBe("markdown");
    expect(viewerKindFor("text/plain", "notes.md")).toBe("markdown");
    expect(viewerKindFor("application/octet-stream", "README.markdown")).toBe("markdown");
    // Plain text stays the raw text preview.
    expect(viewerKindFor("text/plain", "notes.txt")).toBe("text");
  });
  test("a SPECIFIC mime wins regardless of extension", () => {
    expect(viewerKindFor("application/pdf", "weird.bin")).toBe("pdf");
    expect(viewerKindFor("image/png", "photo")).toBe("image");
    expect(viewerKindFor("video/mp4", "clip.dat")).toBe("video");
    expect(viewerKindFor("audio/mpeg", "x")).toBe("audio");
    expect(viewerKindFor("text/plain", "notes")).toBe("text");
    expect(viewerKindFor("application/json", "data")).toBe("text");
  });

  test("a GENERIC mime falls back to the extension (agent deliveries often ship octet-stream)", () => {
    expect(viewerKindFor("application/octet-stream", "rapport.pdf")).toBe("pdf");
    expect(viewerKindFor("application/octet-stream", "screen.png")).toBe("image");
    expect(viewerKindFor("application/octet-stream", "notes.md")).toBe("markdown"); // md renders interpreted since 0.47
    expect(viewerKindFor(undefined, "script.py")).toBe("text");
    expect(viewerKindFor(null, "doc.pdf")).toBe("pdf");
  });

  test("office formats are NONE in Release A (Release B renders them via the converter agent)", () => {
    expect(viewerKindFor(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "IFOA Présentation.pptx",
    )).toBe("none");
    expect(viewerKindFor(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "contrat.docx",
    )).toBe("none");
    expect(viewerKindFor("application/octet-stream", "classeur.xlsx")).toBe("none");
    expect(viewerKindFor("application/zip", "archive.zip")).toBe("none");
  });

  test("degenerate names never crash the sniff", () => {
    expect(fileExtension(null)).toBeNull();
    expect(fileExtension("")).toBeNull();
    expect(fileExtension("noext")).toBeNull();
    expect(fileExtension(".hidden")).toBeNull(); // leading dot ≠ extension
    expect(fileExtension("trailing.")).toBeNull();
    expect(viewerKindFor(undefined, undefined)).toBe("none");
  });
});

describe("clampPage", () => {
  test("clamps into [1, pageCount] and survives garbage", () => {
    expect(clampPage(3, 15)).toBe(3);
    expect(clampPage(0, 15)).toBe(1);
    expect(clampPage(99, 15)).toBe(15);
    expect(clampPage(NaN, 15)).toBe(1);
    expect(clampPage(2, 0)).toBe(1); // empty document → page 1
  });
});

describe("isConvertibleDocument (client — decides whether to offer 'render as PDF')", () => {
  test("Office formats are convertible; native/other are not", () => {
    expect(isConvertibleDocument(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "IFOA.pptx",
    )).toBe(true);
    expect(isConvertibleDocument("application/octet-stream", "contrat.docx")).toBe(true);
    expect(isConvertibleDocument("application/octet-stream", "classeur.xlsx")).toBe(true);
    // These are viewed natively (viewerKindFor !== none) — never converted.
    expect(isConvertibleDocument("application/pdf", "x.pdf")).toBe(false);
    expect(isConvertibleDocument("image/png", "x.png")).toBe(false);
    expect(isConvertibleDocument("application/zip", "x.zip")).toBe(false);
  });
});

