/// <reference types="vite/client" />
//
// A BUBBLE COMPOSED BY ITS ROWS shows (0.103.0) the model's reasoning above the row that
// carries it, the agent's work notes as notes, and its live work notes until the row that
// persists each one exists — the Control UI's reading (chat-message-bubble.ts:579-588,
// tool-stream-preamble.ts at v2026.9.33). A work note never joins a tool group (the Tools
// toggle hides those), and a reasoning block's title states the turn's duration only where
// it is the reasoning's.

import { describe, expect, it } from "vitest";
import { convertConvexMessage } from "./convertMessage";
import type { ConvexMessageView } from "./convexTypes";
import { rowSegments } from "./rowLayoutView";
import { buildTurnFlow } from "./turnFlowView";
import { thinkingTitle } from "./reasoningView";
import type { ToolActivityPart } from "./toolActivityView";

type Content = Array<{
  type: string;
  text?: string;
  data?: { text?: string; open?: boolean; key?: string; capped?: boolean; row?: { messageId: string; entryId: string } };
}>;

function rowsBubble(extra: Partial<ConvexMessageView> = {}): ConvexMessageView {
  const note = "Je lance la commande.";
  const answer = "Nous sommes lundi.";
  const text = `${note}\n\n${answer}`;
  return {
    _id: "m1",
    _creationTime: 0,
    chatId: "c1",
    role: "assistant",
    status: "complete",
    text,
    updatedAt: 1,
    rowLayout: [
      { entryId: "r2", start: 0, end: 0, thinking: true, blocks: true },
      { entryId: "r4:segment:k1", start: 0, end: note.length, commentary: true, blocks: true },
      { entryId: "r5", start: note.length + 2, end: text.length, blocks: true },
    ],
    parts: [],
    ...extra,
  } as unknown as ConvexMessageView;
}

describe("rowSegments: reasoning above its row, work notes marked", () => {
  it("a marked row's reasoning is shown in that row's place — by reference, never its text", () => {
    expect(rowSegments(rowsBubble())).toEqual([
      { kind: "thinking", entryId: "r2" },
      { kind: "text", entryId: "r4:segment:k1", text: "Je lance la commande.", commentary: true },
      { kind: "text", entryId: "r5", text: "Nous sommes lundi." },
    ]);
  });

  it("a row the view does not mark (a conversation that hides reasoning) shows nothing for it", () => {
    const unmarked = rowsBubble();
    unmarked.rowLayout = unmarked.rowLayout!.map(({ thinking: _t, ...r }) => r);
    expect(rowSegments(unmarked)?.some((s) => s.kind === "thinking")).toBe(false);
  });
});

describe("convertMessage: three natures, three renderings", () => {
  it("reasoning block (folded: the answer follows), work note, answer", () => {
    const content = convertConvexMessage(rowsBubble()).content as Content;
    expect(content.map((c) => [c.type, c.text ?? c.data?.text])).toEqual([
      ["data-thinking", undefined],
      ["data-commentary", "Je lance la commande."],
      ["text", "Nous sommes lundi."],
    ]);
    // The block names the row it reads its text from when opened (codex pass 1).
    expect(content[0]!.data).toMatchObject({ open: false, row: { messageId: "m1", entryId: "r2" } });
  });

  it("a message's reasoning cut to nothing by its budget still shows its block, marked cut", () => {
    const message = {
      _id: "m3",
      _creationTime: 0,
      chatId: "c1",
      role: "assistant",
      status: "complete",
      text: "Réponse.",
      updatedAt: 1,
      parts: [{ kind: "reasoning", nature: "thinking", text: "", textCapped: true }],
    } as unknown as ConvexMessageView;
    const content = convertConvexMessage(message).content as Content;
    expect(content[0]).toMatchObject({ type: "data-thinking", data: { text: "", capped: true } });
  });

  it("a live work note shows until the row that persists it exists, then only the row does", () => {
    const live = { kind: "reasoning", nature: "commentary", itemKey: "k9", text: "Je vérifie encore.", textOffset: 0 };
    const running = convertConvexMessage(rowsBubble({ status: "streaming", parts: [live] as never })).content as Content;
    expect(running.filter((c) => c.type === "data-commentary").map((c) => c.data?.text)).toEqual(["Je lance la commande.", "Je vérifie encore."]);
    const persisted = { ...live, itemKey: "k1", text: "Je lance la commande." };
    const retired = convertConvexMessage(rowsBubble({ status: "streaming", parts: [persisted] as never })).content as Content;
    expect(retired.filter((c) => c.type === "data-commentary")).toHaveLength(1);
    // Settled: the rows are the whole truth.
    const settled = convertConvexMessage(rowsBubble({ parts: [live] as never })).content as Content;
    expect(settled.filter((c) => c.type === "data-commentary").map((c) => c.data?.text)).toEqual(["Je lance la commande."]);
  });
});

describe("buildTurnFlow: a work note is content — never merged into, nor across, a tool group", () => {
  const tool = (id: string): ToolActivityPart => ({ toolCallId: id, toolName: "exec", args: {}, phase: "completed" }) as ToolActivityPart;
  it("tool, note, tool at the same place: three segments, in arrival order", () => {
    const flow = buildTurnFlow("Avant.\n", [
      { offset: 7, activity: tool("a") },
      { offset: 7, note: { key: "n1", text: "Je continue." } },
      { offset: 7, activity: tool("b") },
    ]);
    expect(flow.map((s) => s.kind)).toEqual(["text", "activity", "note", "activity"]);
  });

  it("without a note, the groups merge exactly as before", () => {
    const flow = buildTurnFlow("Avant.\n", [
      { offset: 7, activity: tool("a") },
      { offset: 7, activity: tool("b") },
    ]);
    expect(flow.map((s) => s.kind)).toEqual(["text", "activity"]);
  });
});

describe("two tool groups split by a work note at the same place keep distinct identities", () => {
  it("no duplicate flow id (assistant-ui refuses two parts with one id)", () => {
    const tool = (id: string, offset: number) => ({ kind: "tool", name: "exec", phase: "completed", toolCallId: id, textOffset: offset });
    const message = {
      _id: "m2",
      _creationTime: 0,
      chatId: "c1",
      role: "assistant",
      status: "streaming",
      text: "",
      updatedAt: 1,
      parts: [tool("a", 0), { kind: "reasoning", nature: "commentary", itemKey: "k", text: "Ensuite.", textOffset: 0 }, tool("b", 0)],
    } as unknown as ConvexMessageView;
    const ids = (convertConvexMessage(message).content as unknown as Array<{ type: string; toolCallId?: string }>)
      .filter((c) => c.type === "tool-call")
      .map((c) => c.toolCallId);
    expect(ids).toEqual(["flow:m2:0", "flow:m2:0:1"]);
  });
});

describe("thinkingTitle: the turn's duration only where it is the reasoning's", () => {
  it("writing; a settled turn that only thought; a turn that also ran tools", () => {
    expect(thinkingTitle({ writing: true, generationMs: null, hasToolActivity: false })).toBe("Réflexion…");
    expect(thinkingTitle({ writing: false, generationMs: 12_000, hasToolActivity: false })).toBe("Réfléchi pendant 12 s");
    expect(thinkingTitle({ writing: false, generationMs: 12_000, hasToolActivity: true })).toBe("Réflexion");
    expect(thinkingTitle({ writing: false, generationMs: null, hasToolActivity: false })).toBe("Réflexion");
  });
});
