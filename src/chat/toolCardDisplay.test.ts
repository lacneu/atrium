// What a tool card shows of its input (codex review 15): an input rebuilt from a transcript
// row is masked at display exactly as the Control UI masks a history card
// (ui/src/lib/browser-redact.ts over the collapsed preview, tool-cards.ts:328, and the full
// input, chat-transcript-feed.ts:176); a live input is shown as the gateway sent it.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToolCard } from "./ToolCard";
import { toolCardDisplay, toolPreview } from "./toolActivityView";

const args = { command: "curl -H 'Bearer abcdefghijkl' https://example.com" };

describe("toolCardDisplay", () => {
  it("a live input is shown as sent: the same preview as before, the same text", () => {
    expect(toolCardDisplay({ args })).toEqual({
      inputText: JSON.stringify(args, null, 2),
      preview: toolPreview(args, undefined),
    });
  });

  it("an input from a row is masked in the preview and in the full text", () => {
    const { inputText, preview } = toolCardDisplay({ args, inputFromTranscript: true });
    expect(preview).toBe("curl -H 'Bearer [redacted]' https://example.com");
    expect(inputText).toContain("Bearer [redacted]");
    expect(inputText).not.toContain("abcdefghijkl");
  });

  it("masks the text the card prints when it is given one (argsText)", () => {
    const { inputText } = toolCardDisplay({ argsText: "Cookie: auth=fixturecookievalue", inputFromTranscript: true });
    expect(inputText).toBe("Cookie: [redacted]");
  });
});

describe("ToolCard renders what toolCardDisplay says", () => {
  it("a rebuilt input shows masked in the header and the input block; a live one as sent", () => {
    const rebuilt = renderToStaticMarkup(
      createElement(ToolCard, { toolName: "exec", args, inputFromTranscript: true, status: { type: "completed" } }),
    );
    expect(rebuilt).toContain("Bearer [redacted]");
    expect(rebuilt).not.toContain("abcdefghijkl");
    const live = renderToStaticMarkup(createElement(ToolCard, { toolName: "exec", args, status: { type: "completed" } }));
    expect(live).toContain("abcdefghijkl");
  });
});
