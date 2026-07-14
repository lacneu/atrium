import { describe, expect, it } from "vitest";
import { buildInlineDocBlock, fenceFor } from "./promptBridge";

describe("fenceFor", () => {
  it("uses a fence longer than any backtick run in the content (min 3)", () => {
    expect(fenceFor("plain text")).toBe("```");
    expect(fenceFor("has `code` spans")).toBe("```");
    expect(fenceFor("nested\n```js\ncode\n```")).toBe("````");
    expect(fenceFor("````four````")).toBe("`````");
  });
});

describe("buildInlineDocBlock", () => {
  it("wraps the document in a labeled fence that survives nested code blocks", () => {
    const block = buildInlineDocBlock(
      "doc.md",
      "# T\n```\nx\n```",
      "(version modifiee) :",
    );
    expect(block).toContain("doc.md (version modifiee) :");
    expect(block.startsWith("\ndoc.md")).toBe(true);
    // The outer fence must be LONGER than the inner one.
    expect(block).toContain("````\n# T");
    expect(block.trimEnd().endsWith("````")).toBe(true);
  });
});
