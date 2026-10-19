// THE ROW AS BLOCKS (final design step 1) — the Control UI's reading of one projected row,
// reproduced test by test. Each case cites the upstream test it ports (v2026.9.33) and
// keeps its input; the expected output is the upstream one, mapped onto Atrium's blocks:
//   upstream `{type:"text", text}`                       → `{type:"text", text}`
//   upstream `{type:"attachment", attachment:{url,…}}`   → `{type:"file", kind, label, mimeType?, …}`
//     with the url read as its SOURCE: an `artifactId` (managed copy), a `mediaSource`
//     (a reference the gateway's media route serves), or `remote` (https, never fetched).

import { describe, expect, it } from "vitest";

import { rowBlocks, splitMediaFromOutput } from "../src/providers/openclaw/row-blocks.js";
import {
  boundRowContent,
  ROW_TEXT_MAX_BYTES,
  rowContentBytes,
  rowDisplayFacts,
  toTranscriptRow,
} from "../src/providers/openclaw/transcript-rows.js";

const SK = "agent:main:main";
const blocks = (message: unknown) => rowBlocks(message, SK).blocks;
const remoteImage = { type: "file", kind: "image", remote: true, url: "https://example.com/image.png", mimeType: "image/png", label: "image.png" };

describe("ui/src/lib/chat/message-normalizer.test.ts (v2026.9.33)", () => {
  // :283 "preserves managed media playback and artifact metadata"
  it(":283 a managed audio block is a file by its artifact id, with its facts", () => {
    expect(
      blocks({
        role: "assistant",
        content: [
          {
            type: "audio",
            artifactId: "artifact_managed_media_audio",
            url: "/api/chat/media/outgoing/agent%3Amain%3Amain/audio/full",
            fileName: "voice.caf",
            mimeType: "audio/x-caf",
            playback: "transcode",
            sizeBytes: 4096,
            durationMs: 2_345,
            isVoiceNote: true,
          },
        ],
      }),
    ).toEqual([
      {
        type: "file",
        kind: "audio",
        artifactId: "artifact_managed_media_audio",
        mimeType: "audio/x-caf",
        sizeBytes: 4096,
        label: "voice.caf",
      },
    ]);
  });

  // :319 "does not normalize non-assistant structured audio blocks as attachments"
  it(":319 a user row's structured audio is not a file", () => {
    expect(
      blocks({
        role: "user",
        content: [{ type: "audio", label: "upload.mp3", source: { type: "base64", media_type: "audio/mpeg", data: "//uQAA==" } }],
      }),
    ).toEqual([]);
  });

  // :501 "extracts MEDIA attachments and reads persisted delivery facts"
  it(":501 text and MEDIA lines alternate: text, file, text, file — in order", () => {
    expect(
      blocks({
        role: "assistant",
        content: "Intro\nMEDIA:https://example.com/image.png\nOutro\nMEDIA:https://example.com/voice.ogg",
        openclawDelivery: { audioAsVoice: true, replyToId: "thread-123" },
      }),
    ).toEqual([
      { type: "text", text: "Intro" },
      remoteImage,
      { type: "text", text: "Outro" },
      { type: "file", kind: "audio", remote: true, url: "https://example.com/voice.ogg", mimeType: "audio/ogg", label: "voice.ogg" },
    ]);
  });

  // :528 "preserves paragraph breaks and code indentation before an assistant attachment"
  it(":528 a fenced block and its indentation stay one text before the attachment", () => {
    const text = [
      "Here is the code.",
      "",
      "```python",
      "def run():",
      "    if ready:",
      "        return True",
      "```",
      "",
      "The attachment is ready.",
    ].join("\n");
    expect(blocks({ role: "assistant", content: `${text}\nMEDIA:https://example.com/image.png` })).toEqual([
      { type: "text", text },
      remoteImage,
    ]);
  });

  // :549 "preserves a %j paragraph separator around an assistant attachment"
  it.each(["", "\t"])(":549 a %j paragraph separator is kept before the attachment", (whitespace) => {
    expect(
      blocks({
        role: "assistant",
        content: `First paragraph\n${whitespace}\nMEDIA:https://example.com/image.png\n${whitespace}\nSecond paragraph`,
      }),
    ).toEqual([{ type: "text", text: "First paragraph\n" }, remoteImage, { type: "text", text: "Second paragraph" }]);
  });

  // :565 "preserves canonical code fences with structured delivery facts"
  it(":565 a MEDIA-like line inside a fence is code, not a file", () => {
    const code = ["```python", "value = 'a  b'", "``` not a close", "other = 'c  d'", "```"].join("\n");
    expect(
      blocks({
        role: "assistant",
        content: `${code}\nMEDIA:https://example.com/image.png`,
        openclawDelivery: { audioAsVoice: true, replyToCurrent: true },
      }),
    ).toEqual([{ type: "text", text: code }, remoteImage]);
  });

  // :756 "classifies absolute WebM MEDIA paths as video attachments"
  it(":756 an absolute MEDIA path is a video by its extension", () => {
    expect(blocks({ role: "assistant", content: "MEDIA:/tmp/openclaw/clip.webm" })).toEqual([
      { type: "file", kind: "video", mediaSource: "/tmp/openclaw/clip.webm", mimeType: "video/webm", label: "clip.webm" },
    ]);
  });

  // :775 "keeps spaced local filenames together instead of leaking suffix text"
  it(":775 a spaced local filename stays one source", () => {
    expect(blocks({ role: "assistant", content: "MEDIA:/tmp/openclaw/shinkansen kato - Google Shopping.pdf" })).toEqual([
      {
        type: "file",
        kind: "document",
        mediaSource: "/tmp/openclaw/shinkansen kato - Google Shopping.pdf",
        mimeType: "application/pdf",
        label: "shinkansen kato - Google Shopping.pdf",
      },
    ]);
  });

  // :794 "keeps home-relative MEDIA paths as assistant attachments"
  it(":794 a home-relative MEDIA path is a source", () => {
    expect(blocks({ role: "assistant", content: "MEDIA:~/Pictures/My File.png" })).toEqual([
      { type: "file", kind: "image", mediaSource: "~/Pictures/My File.png", mimeType: "image/png", label: "My File.png" },
    ]);
  });

  // :813 "keeps relative MEDIA references as assistant attachments: %s"
  it.each([
    ["image.png", "image", "image/png"],
    ["./image.png", "image", "image/png"],
    ["openclaw/tmp/github-panel/v2-proof/github-pr-diff-light.png", "image", "image/png"],
    ["voice.ogg", "audio", "audio/ogg"],
    ["report.pdf", "document", "application/pdf"],
    ["render final.png", "image", "image/png"],
  ])(":813 a relative MEDIA reference %s is a source, bare or quoted", (url, kind, mimeType) => {
    const file = { type: "file", kind, mediaSource: url, mimeType, label: url.split("/").at(-1) };
    expect(blocks({ role: "assistant", content: `MEDIA:${url}` })).toEqual([file]);
    expect(blocks({ role: "assistant", content: `Before\nMEDIA:"${url}"\nAfter` })).toEqual([
      { type: "text", text: "Before" },
      file,
      { type: "text", text: "After" },
    ]);
  });

  // :836 "preserves the order of relative and remote assistant attachments"
  it(":836 relative and remote references keep their order", () => {
    expect(
      blocks({
        role: "assistant",
        content: "Generated artifacts\nMEDIA:image.png\nMEDIA:https://example.com/remote.png\nMEDIA:voice.ogg",
      }),
    ).toEqual([
      { type: "text", text: "Generated artifacts" },
      { type: "file", kind: "image", mediaSource: "image.png", mimeType: "image/png", label: "image.png" },
      { type: "file", kind: "image", remote: true, url: "https://example.com/remote.png", mimeType: "image/png", label: "remote.png" },
      { type: "file", kind: "audio", mediaSource: "voice.ogg", mimeType: "audio/ogg", label: "voice.ogg" },
    ]);
  });

  // :875 "preserves structured attachment content items"
  it(":875 a structured attachment keeps its source and facts", () => {
    expect(
      blocks({
        role: "assistant",
        content: [
          {
            type: "attachment",
            attachment: {
              url: "~/Pictures/test image.png",
              kind: "image",
              label: "test image.png",
              mimeType: "image/png",
              width: 1280,
              height: 720,
            },
          },
        ],
      }),
    ).toEqual([
      { type: "file", kind: "image", mediaSource: "~/Pictures/test image.png", mimeType: "image/png", label: "test image.png" },
    ]);
  });
});

describe("src/gateway/chat-display-projection.media.test.ts (v2026.9.33) — what the projection leaves, read by Atrium", () => {
  // :202 "withholds relative MEDIA directives until managed attachment blocks replace them":
  // the projection outputs the text alone; Atrium invents no file from what was withheld.
  it(":202 the projected text with its relative MEDIA lines withheld: one text, no file", () => {
    expect(blocks({ role: "assistant", content: [{ type: "text", text: "Prepared the batch." }] })).toEqual([
      { type: "text", text: "Prepared the batch." },
    ]);
  });

  // :229 "keeps a media-only assistant row pending for its structured rewrite": its text is
  // "" until the rewrite brings the managed blocks.
  it(":229 a media-only row pending its rewrite shows nothing yet", () => {
    expect(blocks({ role: "assistant", content: [{ type: "text", text: "" }] })).toEqual([]);
  });

  // :245 "preserves fenced MEDIA examples as ordinary assistant text": the projection keeps
  // the fence, and the client's split leaves a MEDIA line inside it as code.
  it(":245 a MEDIA line inside a fence is an example, not a file", () => {
    const text = ["```text", "MEDIA:./example.jpg", "```", ""].join("\n");
    expect(blocks({ role: "assistant", content: [{ type: "text", text }] })).toEqual([
      { type: "text", text: text.trimEnd() },
    ]);
  });

  // :257 "preserves legacy remote MEDIA references for client-side attachment projection"
  it(":257 a legacy remote MEDIA reference is a remote file (the client splits it)", () => {
    expect(
      blocks({ role: "assistant", content: [{ type: "text", text: "MEDIA:https://cdn.example.test/legacy.jpg" }] }),
    ).toEqual([{ type: "file", kind: "image", remote: true, url: "https://cdn.example.test/legacy.jpg", mimeType: "image/jpeg", label: "legacy.jpg" }]);
  });

  // :269 "preserves an ordinary relative reference through persistence and projection: %s"
  it.each(["MEDIA:chart.png", "MEDIA:./image.png"])(":269 %s stays a relative source", (text) => {
    expect(blocks({ role: "assistant", content: [{ type: "text", text }] })).toEqual([
      expect.objectContaining({ type: "file", kind: "image", mediaSource: text.slice("MEDIA:".length) }),
    ]);
  });

  // :285 "withholds only relative directives from a mixed legacy batch": the projected text
  // keeps the remote and the absolute route reference.
  it(":285 a mixed batch: the text, the remote file, and a gateway route reference with no fetchable source", () => {
    expect(
      blocks({
        role: "assistant",
        content: [
          {
            type: "text",
            text: ["Prepared the mixed batch.", "MEDIA:https://cdn.example.test/legacy.jpg", "MEDIA:/media/legacy-audio.mp3"].join("\n"),
          },
        ],
      }),
    ).toEqual([
      { type: "text", text: "Prepared the mixed batch." },
      { type: "file", kind: "image", remote: true, url: "https://cdn.example.test/legacy.jpg", mimeType: "image/jpeg", label: "legacy.jpg" },
      // A gateway ROUTE url (`/media/…`) is not a source the media route serves
      // (`isLocalAssistantAttachmentSource`, chat-message-local-media.ts:7): a file with no
      // source — recorded `refused` (unsupported_source), never fetched by name.
      { type: "file", kind: "audio", mimeType: "audio/mpeg", label: "legacy-audio.mp3" },
    ]);
  });

  // :506 "keeps a mirror that carries its own attachment": the projection keeps the mirror;
  // Atrium reads it as a visible, never hidden, row. Its attachment has no url, which the
  // Control UI's `normalizeAttachmentContentBlock` drops (message-normalizer-attachments.ts:37):
  // so does Atrium — no file block is invented for it.
  it(":506 a mirror carrying its own attachment is visible and kept; an attachment without url is not a file", () => {
    const mirror = {
      role: "assistant",
      provider: "openclaw",
      model: "delivery-mirror",
      content: [
        { type: "text", text: "The train leaves at noon." },
        { type: "attachment", attachment: { kind: "document", label: "platform.pdf" } },
      ],
      idempotencyKey: "channel-delivery-one",
      __openclaw: { id: "m1", seq: 4 },
    };
    expect(rowDisplayFacts(mirror)).toEqual({ hidden: false, visible: true });
    const row = toTranscriptRow(mirror, undefined, { sessionKey: SK });
    expect(row).toMatchObject({ deliveryMirror: true, idempotencyKind: "other" });
    expect(row?.blocks).toEqual([{ type: "text", text: "The train leaves at noon." }]);
  });
});

describe("Atrium's own rules beside the port", () => {
  it("a row carrying tool content reads as a tool message: its text is not split for MEDIA (resolveMessageRole)", () => {
    const out = blocks({
      role: "assistant",
      content: [
        { type: "text", text: "Avant\nMEDIA:./a.png" },
        { type: "toolCall", id: "c1", name: "exec", arguments: {} },
      ],
    });
    expect(out).toEqual([
      { type: "text", text: "Avant\nMEDIA:./a.png" },
      // The call's arguments ride its block (codex review 11).
      { type: "tool", toolCallId: "c1", name: "exec", status: "call", input: {} },
    ]);
  });

  it("a tool-result row: its tool block, then the managed image it carries", () => {
    expect(
      blocks({
        role: "toolResult",
        toolCallId: "c9",
        toolName: "image_generate",
        content: [{ type: "image", artifactId: "artifact_managed_image_9", url: "/api/chat/media/outgoing/x/9/full", mimeType: "image/png" }],
      }),
    ).toEqual([
      // The result rides its block, in the live `data.result` shape (codex review 11).
      {
        type: "tool",
        toolCallId: "c9",
        name: "image_generate",
        status: "result",
        output: { content: [{ type: "image", artifactId: "artifact_managed_image_9", url: "/api/chat/media/outgoing/x/9/full", mimeType: "image/png" }] },
      },
      { type: "file", kind: "image", artifactId: "artifact_managed_image_9", mimeType: "image/png", label: "full" },
    ]);
  });

  it("text segments are sanitized like the live text: a server path in prose shows its basename only", () => {
    const out = blocks({
      role: "assistant",
      content: "Le fichier /home/node/.openclaw/media/outbound/rapport.pdf est prêt.",
    });
    expect(out).toEqual([{ type: "text", text: expect.not.stringContaining("/home/node") }]);
  });

  it("a row over MAX_ROW_BLOCKS keeps its first blocks and says so", () => {
    const content = Array.from({ length: 70 }, (_, i) => ({ type: "toolCall", id: `c${i}`, name: "exec", arguments: {} }));
    const r = rowBlocks({ role: "assistant", content }, SK);
    expect(r.blocks).toHaveLength(64);
    expect(r.truncated).toBe(true);
  });

  it("a hidden row (NO_REPLY) carries no blocks", () => {
    const row = toTranscriptRow(
      { role: "assistant", content: [{ type: "text", text: "NO_REPLY" }], __openclaw: { id: "h", seq: 2, runId: "r" } },
      undefined,
      { sessionKey: SK },
    );
    expect(row?.hidden).toBe(true);
    expect(row?.blocks).toBeUndefined();
  });

  it("splitMediaFromOutput leaves a text with no MEDIA token untouched", () => {
    expect(splitMediaFromOutput("Bonjour  le   monde")).toEqual({ text: "Bonjour  le   monde" });
  });
});

describe("one row's content budget (ROW_TEXT_MAX_BYTES), never by cutting a text", () => {
  const file = { type: "file" as const, kind: "document" as const, artifactId: "artifact_managed_media_1", label: "a.txt" };
  it("over the budget, the text segments are dropped from the blocks first — the files stay", () => {
    const big = "x".repeat(ROW_TEXT_MAX_BYTES / 2 + 10);
    const out = boundRowContent({ text: big, blocks: [{ type: "text", text: big }, file] });
    expect(out.text).toBe(big);
    expect(out.blocks).toEqual([{ type: "text", omitted: true }, file]);
    expect(rowContentBytes(out)).toBeLessThanOrEqual(ROW_TEXT_MAX_BYTES);
  });

  it("within the budget nothing changes", () => {
    const r = { text: "ok", blocks: [{ type: "text" as const, text: "ok" }, file] };
    expect(boundRowContent(r)).toBe(r);
  });

  it("a row read end to end keeps its files whatever its text weighs", () => {
    const big = "y".repeat(ROW_TEXT_MAX_BYTES - 100);
    const row = toTranscriptRow(
      {
        role: "assistant",
        content: [{ type: "text", text: big }, { type: "attachment", attachment: { artifactId: "artifact_managed_media_1", url: "/api/chat/media/outgoing/k/1/full", kind: "document", label: "a.txt" } }],
        __openclaw: { id: "big", seq: 3, runId: "r" },
      },
      undefined,
      { sessionKey: SK },
    );
    expect(row?.blocks?.filter((b) => b.type === "file")).toHaveLength(1);
    expect(row?.blocks?.[0]).toEqual({ type: "text", omitted: true });
  });
});

// THE NESTING (0.101.1): a tool called from the code of a code-mode `exec` is a nested-activity
// row whose call and result carry `parentToolCallId` (src/sessions/nested-tool-activity.ts:73-87
// at v2026.9.33). The Control UI reads it per item (ui/src/lib/chat/tool-cards.ts:383) to rank
// the card under its parent; the block carries it.
describe("rowBlocks — a nested call keeps its parent", () => {
  const nested = {
    role: "custom",
    customType: "openclaw.nested-tool.v1",
    content: [
      { type: "toolCall", id: "tool_call:call_a_fc_b:sessions_spawn:1", name: "sessions_spawn", arguments: { agentId: "files" }, parentToolCallId: "call_a|fc_b" },
      { type: "toolResult", toolCallId: "tool_call:call_a_fc_b:sessions_spawn:1", toolName: "sessions_spawn", parentToolCallId: "call_a|fc_b", content: [{ type: "text", text: "{}" }], isError: false },
    ],
    __openclaw: { id: "n1", seq: 4, runId: "run-1" },
  };
  it("on the call and on the result", () => {
    const tools = rowBlocks(nested, "agent:main:atrium:chat:u:c1").blocks.filter((b) => b.type === "tool");
    expect(tools.map((b) => [b.status, (b as { parentToolCallId?: string }).parentToolCallId])).toEqual([
      ["call", "call_a|fc_b"],
      ["result", "call_a|fc_b"],
    ]);
  });
  it("a call never names itself as parent, and a blank parent is none", () => {
    const self = { ...nested, content: [{ type: "toolCall", id: "x", name: "exec", arguments: {}, parentToolCallId: "x" }, { type: "toolCall", id: "y", name: "exec", arguments: {}, parentToolCallId: "  " }] };
    const tools = rowBlocks(self, "agent:main:atrium:chat:u:c1").blocks.filter((b) => b.type === "tool");
    expect(tools.map((b) => (b as { parentToolCallId?: string }).parentToolCallId)).toEqual([undefined, undefined]);
  });
});
