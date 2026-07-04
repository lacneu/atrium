import { describe, expect, it } from "vitest";
import { LARGE_PASTE_CHARS, LARGE_PASTE_LINES, routePaste } from "./pasteRouting";

// Large-paste routing: the guard that keeps a pasted log from blowing the
// agent's context. Inline for ordinary snippets, file for anything big —
// each test FAILS if the routing regresses in either direction.
describe("routePaste", () => {
  it("a normal snippet stays inline (zero friction)", () => {
    const r = routePaste("une stack trace de 30 lignes\n".repeat(30), 1);
    expect(r.kind).toBe("inline");
  });

  it("a paste over the char threshold becomes a file", () => {
    const r = routePaste("x".repeat(LARGE_PASTE_CHARS + 1), 2);
    expect(r.kind).toBe("file");
    expect(r.filename).toBe("texte-colle-2.txt");
  });

  it("a paste over the line threshold becomes a file even when small in chars", () => {
    const r = routePaste("\n".repeat(LARGE_PASTE_LINES + 1), 1);
    expect(r.kind).toBe("file");
  });

  it("boundary values stay inline (the threshold is inclusive)", () => {
    expect(routePaste("x".repeat(LARGE_PASTE_CHARS), 1).kind).toBe("inline");
  });

  it("reports lines + chars for the toast", () => {
    const r = routePaste("a\nb\nc", 1);
    expect(r.lines).toBe(3);
    expect(r.chars).toBe(5);
  });
});
