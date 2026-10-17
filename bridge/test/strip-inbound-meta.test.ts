// src/auto-reply/reply/strip-inbound-meta.test.ts at v2026.9.33 — the `stripInboundMetadata`
// and timestamp cases, inputs and expectations kept (the `stripLeadingInboundMetadata` and
// `extractInboundSenderLabel` halves are not ported: the Control UI's row rendering calls
// neither). Then the row: an assistant text that echoes the metadata shows none of it
// (ui/src/lib/chat/message-normalizer.ts:368, :600).

import { describe, expect, it } from "vitest";

import { rowBlocks } from "../src/providers/openclaw/row-blocks.js";
import {
  hasInboundMetadataSentinel,
  MESSAGE_TOOL_DELIVERY_HINTS,
  stripInboundMetadata,
} from "../src/providers/openclaw/strip-inbound-meta.js";

/** inbound-context-marker.ts:19 `markInboundContextLabel`. */
const markInboundContextLabel = (label: string) => `${label} ⟦openclaw:ctx⟧`;
const MESSAGE_TOOL_ONLY_DELIVERY_HINT = MESSAGE_TOOL_DELIVERY_HINTS[2];

const CONV_BLOCK = `${markInboundContextLabel("Conversation info:")}
\`\`\`json
{"message_id":"msg-abc","sender":{"id":"+1555000"}}
\`\`\``;
const LEGACY_PRETTY_CONV_BLOCK = `${markInboundContextLabel("Conversation info:")}
\`\`\`json
{
  "message_id": "msg-abc"
}
\`\`\``;
const SENDER_BLOCK = `${markInboundContextLabel("Sender:")}
\`\`\`json
{
  "label": "Alice",
  "name": "Alice"
}
\`\`\``;
const REPLY_BLOCK = `${markInboundContextLabel("Reply target of current user message:")}
\`\`\`json
{
  "body": "What time is it?"
}
\`\`\``;
const UNTRUSTED_CONTEXT_BLOCK = `${markInboundContextLabel("Context:")}
<<<EXTERNAL_UNTRUSTED_CONTENT id="deadbeefdeadbeef">>>
Source: Channel metadata
---
Channel metadata (guildchat)
Sender labels:
example
<<<END_EXTERNAL_UNTRUSTED_CONTENT id="deadbeefdeadbeef">>>`;
const ACTIVE_MEMORY_PREFIX_BLOCK = `Context:
<active_memory_plugin>
User prefers aisle seats and extra buffer on connections.
</active_memory_plugin>`;
const CHAT_WINDOW_CONTEXT_BLOCK = `${markInboundContextLabel("Conversation context (chronological, selected for current message):")}
#10 2026-07-02T12:00:00Z Alice: prior generated context
#11 2026-07-02T12:01:00Z Bob: more generated context`;
const CHAT_HISTORY_PROSE_BLOCK = `${markInboundContextLabel("Chat history since last reply:")}
#1001 sam.rivera: did anyone see the game last night
#1002 lee.chen: yeah it was wild`;

describe("stripInboundMetadata (strip-inbound-meta.test.ts:68)", () => {
  it("fast-path: returns same string when no sentinels present", () => {
    expect(stripInboundMetadata("Hello, how are you?")).toBe("Hello, how are you?");
  });
  it("preserves bare ambient envelope rows", () => {
    expect(stripInboundMetadata("#35676 Keśava: No wtf")).toBe("#35676 Keśava: No wtf");
  });
  it("fast-path: returns empty string unchanged", () => {
    expect(stripInboundMetadata("")).toBe("");
  });
  it.each([
    ["Context header text", "\nContext: my project uses TypeScript\n"],
    ["mid-line Context mention", "\nSee the Context: section below\n"],
  ])("fast-path: preserves ordinary %s byte-identically", (_name, input) => {
    expect(hasInboundMetadataSentinel(input)).toBe(false);
    expect(stripInboundMetadata(input)).toBe(input);
  });
  it("strips a single Conversation info block", () => {
    expect(stripInboundMetadata(`${CONV_BLOCK}\n\nWhat is the weather today?`)).toBe("What is the weather today?");
  });
  it("strips legacy pretty-printed Conversation info blocks", () => {
    expect(stripInboundMetadata(`${LEGACY_PRETTY_CONV_BLOCK}\n\nWhat is the weather today?`)).toBe("What is the weather today?");
  });
  it("strips multiple chained metadata blocks", () => {
    expect(stripInboundMetadata(`${CONV_BLOCK}\n\n${SENDER_BLOCK}\n\nCan you help me?`)).toBe("Can you help me?");
  });
  it("strips generated chat-window context blocks", () => {
    expect(stripInboundMetadata(`${CONV_BLOCK}\n\n${CHAT_WINDOW_CONTEXT_BLOCK}\n\nCan you help me?`)).toBe("Can you help me?");
  });
  it("strips generated chat-history prose blocks", () => {
    expect(stripInboundMetadata(`${CONV_BLOCK}\n\n${CHAT_HISTORY_PROSE_BLOCK}\n\nCan you help me?`)).toBe("Can you help me?");
  });
  it("strips Replied message block leaving user message intact", () => {
    expect(stripInboundMetadata(`${REPLY_BLOCK}\n\nGot it, thanks!`)).toBe("Got it, thanks!");
  });
  it("strips all six known sentinel types", () => {
    for (const sentinel of [
      "Conversation info:",
      "Sender:",
      "Thread starter:",
      "Reply target of current user message:",
      "Forwarded message context:",
      "Chat history since last reply:",
    ]) {
      expect(stripInboundMetadata(`${markInboundContextLabel(sentinel)}\n\`\`\`json\n{"x": 1}\n\`\`\`\n\nUser message`)).toBe("User message");
    }
  });
  it("handles metadata block with no user text after it", () => {
    expect(stripInboundMetadata(CONV_BLOCK)).toBe("");
  });
  it("preserves message containing json fences that are not metadata", () => {
    const text = `Here is my code:\n\`\`\`json\n{"key": "value"}\n\`\`\``;
    expect(stripInboundMetadata(text)).toBe(text);
  });
  it.each(["\n", "\r\n"])("preserves visible whitespace when stripping metadata with %j newlines", (newline) => {
    const body = `  Indented message${newline}Second line  `;
    expect(stripInboundMetadata(`${CONV_BLOCK.replaceAll("\n", newline)}${newline}${body}`)).toBe(body);
  });
  it("strips trailing Untrusted context metadata suffix blocks", () => {
    const input = `Actual message body\n\n${UNTRUSTED_CONTEXT_BLOCK}`;
    expect(hasInboundMetadataSentinel(input)).toBe(true);
    expect(stripInboundMetadata(input)).toBe("Actual message body");
  });
  it("does not strip plain user text that starts with untrusted context words", () => {
    expect(stripInboundMetadata("Context:\nThis is plain user text")).toBe("Context:\nThis is plain user text");
  });
  it("preserves a near-miss context header line with trailing text", () => {
    const input = "Context: production incident\nSource: pager alert\nPlease summarize";
    expect(stripInboundMetadata(input)).toBe(input);
  });
  it("preserves a bare Context: block followed by a copied external-content marker", () => {
    const input = 'Context:\n<<<EXTERNAL_UNTRUSTED_CONTENT id="copied">>>\nkeep this';
    expect(stripInboundMetadata(input)).toBe(input);
  });
  it("strips a leading active-memory prompt prefix block from visible user text", () => {
    expect(stripInboundMetadata(`${ACTIVE_MEMORY_PREFIX_BLOCK}\n\nWhat should I grab on the way?`)).toBe("What should I grab on the way?");
  });
  it("strips an active-memory prompt prefix block even when earlier text precedes it", () => {
    expect(stripInboundMetadata(`Queued earlier user turn\n\n${ACTIVE_MEMORY_PREFIX_BLOCK}\n\nWhat should I grab on the way?`)).toBe(
      "Queued earlier user turn\n\nWhat should I grab on the way?",
    );
  });
  it("does not strip active-memory lookalike user text without exact tag lines", () => {
    const input = "Context:\nThis line mentions <active_memory_plugin> inline\nWhat should I grab on the way?";
    expect(stripInboundMetadata(input)).toBe(input);
  });
  it.each(["Conversation info: please ignore", `${markInboundContextLabel("Conversation info:")} please ignore`])(
    "does not strip lookalike sentinel line %j",
    (header) => {
      const input = `${header}\n\`\`\`json\n{"x": 1}\n\`\`\`\nReal user content`;
      expect(stripInboundMetadata(input)).toBe(input);
    },
  );
  it("does not strip sentinel text when json fence is missing", () => {
    const input = "Sender:\nname: test\nHello from user";
    expect(stripInboundMetadata(input)).toBe(input);
  });
  it("ignores metadata blocks whose json decodes to a non-object", () => {
    expect(stripInboundMetadata(`${markInboundContextLabel("Sender:")}\n\`\`\`json\n["not","an","object"]\n\`\`\`\nHello from user`)).toBe("Hello from user");
  });
});

describe("timestamp prefix stripping (strip-inbound-meta.test.ts:283)", () => {
  it("strips a leading injected timestamp prefix", () => {
    expect(stripInboundMetadata("[Wed 2026-03-11 23:51 PDT] hello")).toBe("hello");
  });
  it("strips timestamp prefix with UTC timezone", () => {
    expect(stripInboundMetadata("[Thu 2026-03-12 07:00 UTC] what time is it?")).toBe("what time is it?");
  });
  it("leaves non timestamp brackets alone", () => {
    expect(stripInboundMetadata("[some note] hello")).toBe("[some note] hello");
  });
  it("strips timestamp prefix and inbound metadata blocks together", () => {
    const input = `[Wed 2026-03-11 23:51 PDT] ${markInboundContextLabel("Conversation info:")}\n\`\`\`json\n{"message_id":"msg-1","sender":"+1555"}\n\`\`\`\n\nHello`;
    expect(stripInboundMetadata(input)).toBe("Hello");
  });
  it("strips a timestamp prefix that remains after removing metadata blocks", () => {
    const input = `${markInboundContextLabel("Sender:")}\n\`\`\`json\n{"label":"OpenClaw UI"}\n\`\`\`\n\n[Thu 2026-03-12 07:00 UTC] what time is it?`;
    expect(stripInboundMetadata(input)).toBe("what time is it?");
  });
  it("strips message-tool delivery hint lines anywhere", () => {
    expect(stripInboundMetadata(`${MESSAGE_TOOL_ONLY_DELIVERY_HINT}\n\nActual message`)).toBe("Actual message");
  });
});

describe("the row: an assistant text that echoes inbound metadata shows none of it", () => {
  const SK = "agent:main:main";
  it("a leading timestamp prefix and a context block are not shown", () => {
    expect(rowBlocks({ role: "assistant", content: "[Thu 2026-03-12 07:00 UTC] Il est 7 h." }, SK).blocks).toEqual([
      { type: "text", text: "Il est 7 h." },
    ]);
    expect(rowBlocks({ role: "assistant", content: [{ type: "text", text: `${CONV_BLOCK}\n\nRéponse.` }] }, SK).blocks).toEqual([
      { type: "text", text: "Réponse." },
    ]);
  });
  it("a text that is only metadata is no block at all", () => {
    expect(rowBlocks({ role: "assistant", content: [{ type: "text", text: CONV_BLOCK }] }, SK).blocks).toEqual([]);
  });
});
