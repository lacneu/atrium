import { describe, expect, it } from "vitest";
import { convertConvexMessage, displayFilename } from "./convertMessage";
import type {
  ConvexMessagePartView,
  ConvexMessageView,
} from "./convexTypes";
import type { ToolActivityPart } from "./toolActivityView";

// Pins the converter's CONTENT ORDER and the tool-part diversion to
// metadata.custom.toolParts.
//
// Why the order matters (the prod bug this guards against): the old converter
// pushed the text FIRST, then the parts. During a tool-heavy turn the ToolCards
// stacked and auto-scroll followed the bottom; when the final text arrived it
// inserted ABOVE the cards — out of view. Chronological order = reasoning
// first, then the text, then media/file attachments; tool parts never enter
// content at all (rendered by the grouped ToolActivity block instead).

function makeMessage(
  overrides: Partial<ConvexMessageView> = {},
): ConvexMessageView {
  return {
    _id: "msg1" as ConvexMessageView["_id"],
    chatId: "chat1" as ConvexMessageView["chatId"],
    _creationTime: 1000,
    role: "assistant",
    status: "complete",
    text: "",
    updatedAt: 2000,
    parts: [],
    ...overrides,
  };
}

const toolPart = (
  name: string,
  extra: Partial<Extract<ConvexMessagePartView, { kind: "tool" }>> = {},
): ConvexMessagePartView => ({ kind: "tool", name, phase: "running", ...extra });

type ContentArray = ReadonlyArray<{ type: string }>;

function contentTypes(message: ConvexMessageView): string[] {
  const converted = convertConvexMessage(message);
  return (converted.content as ContentArray).map((p) => p.type);
}

function customMeta(message: ConvexMessageView): Record<string, unknown> {
  return convertConvexMessage(message).metadata?.custom as Record<
    string,
    unknown
  >;
}

describe("convertConvexMessage content order (chronological)", () => {
  it("places reasoning BEFORE the text and media/file AFTER it", () => {
    const message = makeMessage({
      text: "final answer",
      parts: [
        { kind: "reasoning", text: "thinking…" },
        toolPart("web_search"),
        {
          kind: "media",
          storageId: "s1",
          filename: "a.png",
          mimeType: "image/png",
          url: "https://example/a.png",
        },
        {
          kind: "file",
          storageId: "s2",
          filename: "b.pdf",
          mimeType: "application/pdf",
          url: "https://example/b.pdf",
        },
      ],
    });
    expect(contentTypes(message)).toEqual([
      "reasoning",
      "text",
      "file",
      "file",
    ]);
  });

  it("never emits tool-call content parts", () => {
    const message = makeMessage({
      text: "answer",
      parts: [toolPart("web_search"), toolPart("read_file")],
    });
    expect(contentTypes(message)).toEqual(["text"]);
  });

  it("skips media/file parts without a resolved url", () => {
    const message = makeMessage({
      text: "answer",
      parts: [
        {
          kind: "media",
          storageId: "s1",
          filename: "a.png",
          mimeType: "image/png",
          url: null,
        },
      ],
    });
    expect(contentTypes(message)).toEqual(["text"]);
  });

  it("falls back to a single empty text part when nothing is renderable", () => {
    // Includes the tool-only turn: tools moved to metadata, so content would
    // otherwise be empty and assistant-ui would render no bubble.
    expect(contentTypes(makeMessage())).toEqual(["text"]);
    const toolOnly = makeMessage({
      status: "streaming",
      parts: [toolPart("web_search")],
    });
    const converted = convertConvexMessage(toolOnly);
    expect(converted.content).toEqual([{ type: "text", text: "" }]);
  });
});

describe("convertConvexMessage metadata.custom.toolParts", () => {
  it("extracts tool parts in order with stable synthetic ids", () => {
    const message = makeMessage({
      runId: "run42",
      text: "done",
      parts: [
        toolPart("web_search", {
          input: { q: "openclaw" },
          output: { hits: 3 },
          phase: "completed",
        }),
        { kind: "reasoning", text: "…" },
        toolPart("read_file"),
      ],
    });
    const toolParts = customMeta(message).toolParts as ToolActivityPart[];
    expect(toolParts).toHaveLength(2);
    // Synthetic id = `${messageId}:${runId}:${part order index}`.
    expect(toolParts[0]).toEqual({
      toolCallId: "msg1:run42:0",
      toolName: "web_search",
      args: { q: "openclaw" },
      argsText: JSON.stringify({ q: "openclaw" }, null, 2),
      result: { hits: 3 },
      phase: "completed",
    });
    expect(toolParts[1]).toEqual({
      toolCallId: "msg1:run42:2",
      toolName: "read_file",
      args: {},
      argsText: undefined,
      result: undefined,
      phase: "running",
    });
  });

  it("emits an empty toolParts array when the turn ran no tools", () => {
    expect(customMeta(makeMessage({ text: "hi" })).toolParts).toEqual([]);
  });

  it("keeps the existing custom metadata fields intact", () => {
    const message = makeMessage({ text: "raw", status: "error", error: "boom" });
    const custom = customMeta(message);
    expect(custom.messageId).toBe("msg1");
    expect(custom.chatId).toBe("chat1");
    expect(custom.status).toBe("error");
    expect(custom.runId).toBeNull();
    expect(custom.error).toBe("boom");
    expect(custom.rawText).toBe("raw");
  });
});

describe("displayFilename (strip the gateway media-id suffix)", () => {
  it("strips `---<uuid>` before the extension on agent-generated media", () => {
    expect(
      displayFilename("openclaw-lightrag-report---4c23520c-b8a8-4533-b48b-b735dd8e1297.pdf"),
    ).toBe("openclaw-lightrag-report.pdf");
  });

  it("leaves a normal user upload untouched", () => {
    expect(displayFilename("IFOA Présentation.pptx")).toBe("IFOA Présentation.pptx");
    expect(displayFilename("report-2026.csv")).toBe("report-2026.csv");
  });

  it("does NOT strip a non-UUID `---` segment (only the gateway id pattern)", () => {
    expect(displayFilename("a---b---notauuid.txt")).toBe("a---b---notauuid.txt");
  });

  it("passes through undefined/empty", () => {
    expect(displayFilename(undefined)).toBeUndefined();
    expect(displayFilename("")).toBe("");
  });
});
