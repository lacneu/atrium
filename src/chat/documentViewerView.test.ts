import { describe, expect, test } from "vitest";
import {
  clampPage,
  classifyLogLine,
  compareCsvCells,
  detectCsvDelimiter,
  fileExtension,
  forcedCsvDelimiter,
  isConvertibleDocument,
  parseCsvPreview,
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
    expect(viewerKindFor("application/json", "data")).toBe("json"); // json renders as a tree since 0.51
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

describe("rich text-preview kinds", () => {
  test("csv/tsv, json and log route to their dedicated renderers (extension wins over generic mimes)", () => {
    expect(viewerKindFor("text/csv", "data")).toBe("csv");
    expect(viewerKindFor("text/plain", "export.csv")).toBe("csv");
    expect(viewerKindFor("application/octet-stream", "sheet.tsv")).toBe("csv");
    expect(viewerKindFor("application/json", "payload")).toBe("json");
    expect(viewerKindFor("text/plain", "trace.json")).toBe("json");
    expect(viewerKindFor("text/plain", "app.log")).toBe("log");
    // Plain text is untouched.
    expect(viewerKindFor("text/plain", "notes.txt")).toBe("text");
  });
  test("mime PARAMETERS are stripped before matching (charset et al.)", () => {
    expect(viewerKindFor("text/csv; charset=utf-8", "data")).toBe("csv");
    expect(viewerKindFor("application/json; charset=utf-8", "payload")).toBe("json");
    expect(viewerKindFor("text/markdown; charset=utf-8", "readme")).toBe("markdown");
    expect(viewerKindFor("application/pdf; name=x", "doc")).toBe("pdf");
  });
  test("standard mime VARIANTS select the rich renders without an extension", () => {
    expect(viewerKindFor("text/tab-separated-values", "export")).toBe("csv");
    expect(viewerKindFor("application/problem+json", "err")).toBe("json");
    expect(viewerKindFor("application/ld+json", "graph")).toBe("json");
    expect(viewerKindFor("text/x-log", "output")).toBe("log");
  });
  test("a CONTRADICTING specific mime beats the extension", () => {
    expect(viewerKindFor("application/json", "data.csv")).toBe("json");
    expect(viewerKindFor("text/csv", "payload.json")).toBe("csv");
    expect(viewerKindFor("text/markdown", "notes.log")).toBe("markdown");
  });
});

describe("parseCsvPreview (RFC 4180)", () => {
  test("quoted fields keep delimiters, doubled quotes and NEWLINES", () => {
    const csv = 'name,comment\n"Doe, Jane","She said ""hi""\non two lines"\nBob,plain';
    const p = parseCsvPreview(csv);
    expect(p.header).toEqual(["name", "comment"]);
    expect(p.rows[0]).toEqual(["Doe, Jane", 'She said "hi"\non two lines']);
    expect(p.rows[1]).toEqual(["Bob", "plain"]);
    expect(p.totalRows).toBe(2);
    expect(p.truncatedRows).toBe(false);
  });
  test("auto-detects the FRENCH semicolon and the TSV tab", () => {
    expect(detectCsvDelimiter("a;b;c")).toBe(";");
    expect(detectCsvDelimiter("a\tb\tc")).toBe("\t");
    expect(parseCsvPreview("x;y\n1;2").rows[0]).toEqual(["1", "2"]);
  });
  test("a TSV's type IMPOSES the tab: a comma in the header must not win the tie", () => {
    expect(forcedCsvDelimiter(null, "export.tsv")).toBe("\t");
    expect(forcedCsvDelimiter("text/tab-separated-values", "x")).toBe("\t");
    expect(forcedCsvDelimiter("text/csv", "export.csv")).toBeUndefined();
    const p = parseCsvPreview("name\tcity, province\nJane\tQC, Canada", undefined, "\t");
    expect(p.header).toEqual(["name", "city, province"]);
    expect(p.rows[0]).toEqual(["Jane", "QC, Canada"]);
  });
  test("the row cap keeps the table bounded and says so", () => {
    const big = "h\n" + Array.from({ length: 12 }, (_, i) => String(i)).join("\n");
    const p = parseCsvPreview(big, 10);
    expect(p.rows.length).toBe(10);
    expect(p.totalRows).toBe(12);
    expect(p.truncatedRows).toBe(true);
  });
  test("blank records between data rows are REAL records (one-column CSVs); only leading blanks skip to the header", () => {
    const p = parseCsvPreview("\nvalue\na\n\n \nb");
    expect(p.header).toEqual(["value"]);
    expect(p.rows).toEqual([["a"], [""], [" "], ["b"]]);
    expect(p.totalRows).toBe(4);
  });
});

describe("compareCsvCells (column sort)", () => {
  test("numeric when both are numbers ('9' before '10'), text otherwise", () => {
    expect(compareCsvCells("9", "10")).toBeLessThan(0);
    expect(compareCsvCells("beta", "alpha")).toBeGreaterThan(0);
    expect(compareCsvCells("2", "abc")).not.toBe(0);
  });
  test("64-bit integer ids keep their precision (no float collapse)", () => {
    expect(compareCsvCells("9007199254740993", "9007199254740992")).toBeGreaterThan(0);
    expect(compareCsvCells("-9007199254740993", "-9007199254740992")).toBeLessThan(0);
    // Decimals still compare as floats.
    expect(compareCsvCells("1.5", "1.25")).toBeGreaterThan(0);
  });
});

describe("classifyLogLine", () => {
  test("maps the usual level tokens, case-insensitive", () => {
    expect(classifyLogLine("2026-07-10 ERROR boom")).toBe("error");
    expect(classifyLogLine("[warn] disk almost full")).toBe("warn");
    expect(classifyLogLine("INFO: started")).toBe("info");
    expect(classifyLogLine("debug: tick")).toBe("debug");
    expect(classifyLogLine("just a line")).toBe("plain");
  });
  test("a token inside an identifier does not light up", () => {
    expect(classifyLogLine("metric errors_total=3")).toBe("plain");
  });
});
