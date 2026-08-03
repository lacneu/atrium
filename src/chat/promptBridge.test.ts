import { describe, expect, it } from "vitest";
import {
  PromptBridgeContext,
  buildInlineDocBlock,
  fenceFor,
  sharedPromptBridge,
} from "./promptBridge";

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

// WHERE the bridge can be reached from.
//
// The document viewer moved out of the conversation and into the persistent
// column — its SIBLING. A context alone stops at the provider's subtree, so the
// viewer would read null and "use in prompt" would report itself unavailable on
// every document, on the desktop path that is now the only one.
describe("the composer's contract reaches a viewer outside its subtree", () => {
  it("the context DEFAULTS to the shared ref rather than to null", () => {
    // Read the default straight off the context object: a component rendered
    // with no provider above it gets exactly this.
    const fallback = (
      PromptBridgeContext as unknown as {
        _currentValue: typeof sharedPromptBridge | null;
      }
    )._currentValue;
    expect(fallback, "a null default is a dead 'use in prompt'").not.toBeNull();
    expect(fallback).toBe(sharedPromptBridge);
  });

  it("what the composer publishes is what an unnested viewer reads", () => {
    const bridge = {
      canAttach: true,
      attachFile: async () => {},
      insertText: () => {},
    };
    sharedPromptBridge.current = bridge;
    const asSeenByTheColumn = (
      PromptBridgeContext as unknown as {
        _currentValue: typeof sharedPromptBridge;
      }
    )._currentValue;
    expect(asSeenByTheColumn.current).toBe(bridge);
    sharedPromptBridge.current = null;
  });
});
