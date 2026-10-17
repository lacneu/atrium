// A TOOL CARD REBUILT FROM THE TRANSCRIPT CARRIES ITS ARGUMENTS AND ITS RESULT (codex review
// 11). The Control UI reads them from the persisted rows (ui/src/lib/chat/tool-cards.ts:353
// `extractToolCards`); these are its tests of
// ui/src/pages/chat/components/chat-tool-cards.node.test.ts at v2026.9.33 that bear on the
// payloads, inputs kept, mapped onto Atrium's tool blocks (`input` = the card's `args`,
// `output` = the result in the live `data.result` shape, `status` = its outcome), paired by
// call id as the view pairs them (convex/lib/viewReconcile.ts `toolPayloadsOf`).

import { describe, expect, it } from "vitest";

import { rowBlocks, withoutToolPayloads } from "../src/providers/openclaw/row-blocks.js";
import { clip } from "../src/providers/openclaw/openclaw-client.js";
import { resolveToolCallId } from "../src/providers/openclaw/tool-call-id.js";
import {
  boundRowContent,
  ROW_TEXT_MAX_BYTES,
  rowToolCallIds,
  toTranscriptRow,
} from "../src/providers/openclaw/transcript-rows.js";

const SK = "agent:main:main";
const tools = (message: unknown) => rowBlocks(message, SK).blocks.filter((b) => b.type === "tool");

describe("chat-tool-cards.node.test.ts (v2026.9.33) — the payloads of a card", () => {
  // :334
  it("pretty-prints structured args and pairs tool output onto the same card", () => {
    expect(
      tools({
        role: "assistant",
        toolCallId: "call-1",
        content: [
          { type: "toolcall", id: "call-1", name: "browser.open", arguments: { url: "https://example.com", retry: 0 } },
          { type: "toolresult", id: "call-1", name: "browser.open", text: "Opened page" },
        ],
      }),
    ).toEqual([
      { type: "tool", toolCallId: "call-1", name: "browser.open", status: "call", input: { url: "https://example.com", retry: 0 } },
      // Its `text` is the result's one text block (extractToolText reads `text` first).
      { type: "tool", toolCallId: "call-1", name: "browser.open", status: "result", output: { content: [{ type: "text", text: "Opened page" }] } },
    ]);
  });

  // :365
  it("preserves string args verbatim and keeps empty-output cards", () => {
    expect(tools({ role: "assistant", content: [{ type: "toolcall", id: "call-2", name: "deck_manage", arguments: "with Example Deck" }] })).toEqual([
      { type: "tool", toolCallId: "call-2", name: "deck_manage", status: "call", input: "with Example Deck" },
    ]);
  });

  // :401
  it("preserves tool-call input payloads from tool_use blocks", () => {
    expect(
      tools({ role: "assistant", content: [{ type: "tool_use", id: "call-2b", name: "deck_manage", input: { deck: "Example Deck", mode: "preview" } }] }),
    ).toEqual([{ type: "tool", toolCallId: "call-2b", name: "deck_manage", status: "call", input: { deck: "Example Deck", mode: "preview" } }]);
  });

  // :421
  it("preserves legacy callId tool block identities", () => {
    expect(tools({ role: "assistant", content: [{ type: "tool_use", callId: "legacy-call-id", name: "bash", input: { command: "pwd" } }] })).toEqual([
      { type: "tool", toolCallId: "legacy-call-id", name: "bash", status: "call", input: { command: "pwd" } },
    ]);
  });

  // :615
  it("extracts tool result output from text block content arrays", () => {
    const out = tools({
      role: "assistant",
      content: [
        { type: "toolcall", id: "call-read", name: "read", input: { path: "README.md" } },
        { type: "tool_result", id: "call-read", name: "read", content: [{ type: "text", text: "# Heading" }, { type: "text", text: "file body" }] },
      ],
    });
    expect(out[1]).toMatchObject({ status: "result", output: { content: [{ type: "text", text: "# Heading" }, { type: "text", text: "file body" }] } });
  });

  // :641
  it("preserves explicit tool error flags from tool result items and messages", () => {
    expect(
      tools({ role: "assistant", content: [{ type: "toolcall", id: "call-error", name: "lookup" }, { type: "tool_result", id: "call-error", name: "lookup", text: "lookup failed", isError: true }] })[1],
    ).toMatchObject({ status: "error" });
    expect(tools({ role: "toolResult", toolCallId: "call-message-error", toolName: "lookup", isError: true, content: [{ type: "text", text: "lookup failed" }] })[0]).toMatchObject({
      status: "error",
      output: { content: [{ type: "text", text: "lookup failed" }] },
    });
  });
});

describe("the live part's rules, applied to the rows", () => {
  it("private arguments are redacted as the live writer redacts them (sessions_yield.message)", () => {
    const [call] = tools({ role: "assistant", content: [{ type: "toolCall", id: "y1", name: "sessions_yield", arguments: { message: "note privée" } }] });
    expect(JSON.stringify(call)).not.toContain("note privée");
  });

  it("over the row's budget the payloads go first, the cards stay marked cut with their size", () => {
    const big = "x".repeat(ROW_TEXT_MAX_BYTES);
    const blocks = rowBlocks({ role: "toolResult", toolCallId: "t1", toolName: "exec", content: [{ type: "text", text: big }] }, SK).blocks;
    const bounded = boundRowContent({ text: "court", blocks });
    expect(bounded.text).toBe("court");
    expect(bounded.blocks![0]).toMatchObject({ type: "tool", toolCallId: "t1", status: "result", outputOmitted: true });
    expect((bounded.blocks![0] as { outputBytes?: number }).outputBytes).toBeGreaterThan(ROW_TEXT_MAX_BYTES);
    expect(withoutToolPayloads(blocks)[0]).not.toHaveProperty("output");
  });

  it("the payloads go BEFORE the text segments: a row's text block survives a heavy result", () => {
    const big = "x".repeat(ROW_TEXT_MAX_BYTES - 1024);
    const blocks = rowBlocks(
      { role: "assistant", content: [{ type: "text", text: "y".repeat(2048) }, { type: "toolCall", id: "t2", name: "exec", arguments: { blob: big } }] },
      SK,
    ).blocks;
    const bounded = boundRowContent({ blocks });
    expect(bounded.blocks![0]).toMatchObject({ type: "text", text: expect.any(String) });
    expect(bounded.blocks![1]).toMatchObject({ type: "tool", inputOmitted: true });
  });
});

describe("one call identity for the blocks and the row's index (codex review 12)", () => {
  // tool-cards.ts:224-237 `resolveToolCallId`; chat-tool-cards.node.test.ts:421 the legacy shape.
  const LEGACY = {
    role: "assistant",
    content: [{ type: "tool_use", callId: "legacy-call-id", name: "bash", input: { command: "pwd" } }],
    __openclaw: { id: "m-legacy", seq: 3 },
  };

  it("the index names the legacy `callId` the block is keyed by", () => {
    expect(rowToolCallIds(LEGACY)).toEqual(["legacy-call-id"]);
    const row = toTranscriptRow(LEGACY, undefined, { sessionKey: SK });
    expect(row?.toolCallIds).toEqual(["legacy-call-id"]);
    expect(row?.blocks).toEqual([
      { type: "tool", toolCallId: "legacy-call-id", name: "bash", status: "call", input: { command: "pwd" } },
    ]);
  });

  it("follows upstream's order: the item's ids, its `callId`, then the message's", () => {
    expect(resolveToolCallId({ id: " a ", callId: "b" }, { toolCallId: "c" })).toBe("a");
    expect(resolveToolCallId({ tool_call_id: "a2", toolCallId: "b2" }, {})).toBe("a2");
    expect(resolveToolCallId({ callId: "b" }, { toolCallId: "c" })).toBe("b");
    expect(resolveToolCallId({}, { tool_call_id: "c2" })).toBe("c2");
    expect(resolveToolCallId({}, { toolUseId: "d" })).toBe("d");
    expect(resolveToolCallId({}, { tool_use_id: "e" })).toBe("e");
    expect(resolveToolCallId({ id: "  " }, {})).toBeUndefined();
  });

  it("a nested code-mode call named only by `callId` is keyed by it too", () => {
    const nested = {
      role: "custom",
      customType: "openclaw.nested-tool.v1",
      content: [{ type: "toolCall", callId: "nested-legacy", name: "bash", arguments: { command: "ls" } }],
    };
    expect(tools(nested)).toMatchObject([{ toolCallId: "nested-legacy", status: "call", input: { command: "ls" } }]);
    expect(rowToolCallIds(nested)).toEqual(["nested-legacy"]);
  });

  it("a tool result named only by `tool_use_id` is indexed and keyed alike", () => {
    const msg = { role: "toolResult", tool_use_id: "r-1", toolName: "bash", content: [{ type: "text", text: "/tmp" }] };
    expect(rowToolCallIds(msg)).toEqual(["r-1"]);
    expect(tools(msg)).toMatchObject([{ toolCallId: "r-1", status: "result" }]);
  });
});

describe("a row's payloads are written as chat.history serves them (codex reviews 12-15)", () => {
  // The gateway stores its transcript masked, its own `logging.redactPatterns` included
  // (src/agents/transcript-redact.ts:721); the card masks the input again at display, as
  // the Control UI does (src/chat/toolActivityView.ts `toolCardDisplay`). The bridge adds
  // nothing in between: what it writes is what the gateway served.
  const SECRET = "sk-or-v1-abcdef0123456789";
  const CALL = {
    role: "assistant",
    content: [{ type: "toolCall", id: "s1", name: "exec", arguments: { command: "printf ***" } }],
  };
  const RESULT = {
    role: "toolResult",
    toolCallId: "s1",
    toolName: "exec",
    content: [{ type: "text", text: "OPENROUTER_API_KEY=sk-or-…6789" }],
  };

  it("the call's arguments and the result are kept exactly as served", () => {
    expect(tools(CALL)).toEqual([{ type: "tool", toolCallId: "s1", name: "exec", status: "call", input: { command: "printf ***" } }]);
    expect(tools(RESULT)).toEqual([
      { type: "tool", toolCallId: "s1", name: "exec", status: "result", output: { content: [{ type: "text", text: "OPENROUTER_API_KEY=sk-or-…6789" }] } },
    ]);
  });

  it("a debug log of a raw frame is masked as the Control UI masks a tool detail", () => {
    // `clip` is what every BRIDGE_DEBUG line of a frame goes through (openclaw-client.ts).
    const frame = {
      type: "res",
      id: "1",
      ok: true,
      payload: { messages: [{ role: "assistant", content: [{ type: "toolCall", id: "x", name: "exec", arguments: { command: `OPENROUTER_API_KEY=${SECRET} curl -H 'Bearer abcdefghijkl' -H 'Cookie: auth=fixturecookievalue'` } }] }] },
    };
    for (const text of [clip(frame, 100_000), clip(JSON.stringify(frame), 100_000)]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain("abcdefghijkl");
      expect(text).not.toContain("fixturecookievalue");
    }
  });
});


describe("calls without an identity keep their cards (codex review 13)", () => {
  // chat-tool-cards.node.test.ts (v2026.9.33) :438-569, mapped onto Atrium's tool blocks:
  // the card id of an id-less call is upstream's `${name}:${index}` (tool-cards.ts:388),
  // scoped by the row's transcript id; an id-less result pairs with the earliest open
  // same-name call (:413-421).
  const ROW = "entry-1";
  const blocksOf = (content: unknown[]) =>
    rowBlocks({ role: "assistant", content, __openclaw: { id: ROW, seq: 2 } }, SK).blocks.filter((b) => b.type === "tool");
  const cards = (content: unknown[]) => {
    const byId = new Map<string, { input?: unknown; output?: unknown; status: string[] }>();
    for (const b of blocksOf(content) as Array<{ toolCallId: string; input?: unknown; output?: unknown; status: string }>) {
      const c = byId.get(b.toolCallId) ?? { status: [] };
      if (b.input !== undefined) c.input = b.input;
      if (b.output !== undefined) c.output = b.output;
      c.status.push(b.status);
      byId.set(b.toolCallId, c);
    }
    return [...byId.entries()];
  };
  const text = (o: unknown) => (o as { content: Array<{ text: string }> }).content[0]!.text;

  // :438
  it("pairs interleaved nameless tool results in content order", () => {
    const out = cards([
      { type: "tool_use", name: "browser.open", input: { url: "https://example.com/a" } },
      { type: "tool_result", name: "browser.open", text: "Opened A" },
      { type: "tool_use", name: "browser.open", input: { url: "https://example.com/b" } },
      { type: "tool_result", name: "browser.open", text: "Opened B" },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]![1].input).toEqual({ url: "https://example.com/a" });
    expect(text(out[0]![1].output)).toBe("Opened A");
    expect(out[1]![1].input).toEqual({ url: "https://example.com/b" });
    expect(text(out[1]![1].output)).toBe("Opened B");
    expect(out.map(([id]) => id)).toEqual([`${ROW}#browser.open:0`, `${ROW}#browser.open:2`]);
  });

  // :472
  it("pairs sequential nameless same-name tool results with the earliest unmatched call", () => {
    const out = cards([
      { type: "tool_use", name: "read", input: { path: "a.txt" } },
      { type: "tool_use", name: "read", input: { path: "b.txt" } },
      { type: "tool_result", name: "read", text: "A contents" },
      { type: "tool_result", name: "read", text: "B contents" },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]![1]).toMatchObject({ input: { path: "a.txt" } });
    expect(text(out[0]![1].output)).toBe("A contents");
    expect(out[1]![1]).toMatchObject({ input: { path: "b.txt" } });
    expect(text(out[1]![1].output)).toBe("B contents");
  });

  // :504
  it.each([
    ["canonical IDs", { id: "call-b" }],
    ["snake-case tool-call IDs", { tool_call_id: "call-b" }],
    ["camel-case tool-call IDs", { toolCallId: "call-b" }],
    ["provider tool-use IDs", { tool_use_id: "call-b" }],
    ["camel-case tool-use IDs", { toolUseId: "call-b" }],
    ["legacy call IDs", { callId: "call-b" }],
  ])("keeps a same-name result with different %s separate from an open call", (_label, resultId) => {
    const out = cards([
      { type: "tool_use", id: "call-a", name: "read", input: { path: "a.txt" } },
      { type: "tool_result", ...resultId, name: "read", text: "B failed", isError: true },
    ]);
    expect(out.map(([id]) => id)).toEqual(["call-a", "call-b"]);
    expect(out[0]![1].output).toBeUndefined();
    expect(out[1]![1]).toMatchObject({ status: ["error"] });
  });

  // :549
  it.each([
    ["only the call owns an ID", { id: "call-a" }, {}, "call-a"],
    ["only the result owns an ID", {}, { tool_use_id: "call-b" }, "call-b"],
  ])("preserves legacy same-name fallback when %s", (_label, callId, resultId, expected) => {
    const out = cards([
      { type: "tool_use", ...callId, name: "read", input: { path: "legacy.txt" } },
      { type: "tool_result", ...resultId, name: "read", text: "Legacy contents" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]![0]).toBe(expected);
    expect(out[0]![1]).toMatchObject({ input: { path: "legacy.txt" }, status: ["call", "result"] });
    expect(text(out[0]![1].output)).toBe("Legacy contents");
  });

  // :577
  it("does not reuse nameless same-name calls after an empty result", () => {
    const out = cards([
      { type: "tool_use", name: "read", input: { path: "empty.txt" } },
      { type: "tool_use", name: "read", input: { path: "next.txt" } },
      { type: "tool_result", name: "read", text: "" },
      { type: "tool_result", name: "read", text: "Next contents" },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]![1]).toMatchObject({ input: { path: "empty.txt" }, status: ["call", "result"] });
    expect(out[1]![1]).toMatchObject({ input: { path: "next.txt" } });
    expect(text(out[1]![1].output)).toBe("Next contents");
  });

  it("a nested code-mode row pairs its id-less items the same way", () => {
    const nested = rowBlocks(
      {
        role: "custom",
        customType: "openclaw.nested-tool.v1",
        content: [
          { type: "toolCall", name: "read", arguments: { path: "a.txt" } },
          { type: "toolResult", name: "read", text: "A" },
        ],
        __openclaw: { id: ROW, seq: 3 },
      },
      SK,
    ).blocks.filter((b) => b.type === "tool");
    expect(nested.map((b) => (b as { toolCallId: string }).toolCallId)).toEqual([`${ROW}#read:0`, `${ROW}#read:0`]);
  });

  it("a result with an output is never the target of a later id-less result (tool-cards.ts:420)", () => {
    const out = cards([
      { type: "tool_result", name: "read", text: "A" },
      { type: "tool_result", name: "read", text: "B" },
    ]);
    expect(out.map(([id]) => id)).toEqual([`${ROW}#read:0`, `${ROW}#read:1`]);
  });

  it("the local identity is stable from one read to the next, and indexed like the blocks", () => {
    const msg = {
      role: "assistant",
      content: [
        { type: "tool_use", name: "read", input: { path: "a.txt" } },
        { type: "tool_result", name: "read", text: "A" },
      ],
      __openclaw: { id: "entry-9", seq: 4 },
    };
    const first = toTranscriptRow(msg, undefined, { sessionKey: SK });
    const again = toTranscriptRow(JSON.parse(JSON.stringify(msg)), undefined, { sessionKey: SK });
    expect(first?.toolCallIds).toEqual(["entry-9#read:0"]);
    expect(again?.toolCallIds).toEqual(first?.toolCallIds);
    expect(again?.blocks).toEqual(first?.blocks);
    expect(first?.blocks?.filter((b) => b.type === "tool").map((b) => (b as { toolCallId: string }).toolCallId)).toEqual([
      "entry-9#read:0",
      "entry-9#read:0",
    ]);
  });

  it("a tool message naming no call keeps its card (tool-cards.ts:494-500)", () => {
    const msg = { role: "toolResult", toolName: "read", content: [{ type: "text", text: "A" }], __openclaw: { id: "entry-r", seq: 5 } };
    const row = toTranscriptRow(msg, undefined, { sessionKey: SK });
    expect(row?.toolCallIds).toEqual(["entry-r#read:0"]);
    expect(row?.blocks).toMatchObject([{ type: "tool", toolCallId: "entry-r#read:0", status: "result" }]);
  });
});
